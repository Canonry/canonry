import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  forbidden,
  OPENROUTER_ROUTE_FAMILY,
  operationInProgress,
  providerConnectionSettingsDtoSchema,
  ProviderConnectionsUnavailableReasons,
  ProviderConnectionUsageSources,
  ProviderKinds,
  RunKinds,
  settingsDtoSchema,
  type ProviderConnectionConfigDto,
  type ProviderSettingsUpdateRequest,
} from '@canonry/canonry-contracts'
import { apiKeys, createClient, measurementPlanDrafts, measurementPlans, measurementPlanVersions, migrate, projects, schedules, users } from '@canonry/canonry-db'
import { apiRoutes, hashApiKey, type ApiRoutesOptions } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })
const route = 'openrouter:google/gemini-2.5-flash'
const now = '2026-11-06T00:00:00.000Z'

function config(name: string, configured = true): ProviderConnectionConfigDto {
  return {
    name, displayName: name, configured, revision: `${name}-revision`, mode: 'api',
    kind: name === 'openrouter' ? ProviderKinds['model-gateway'] : ProviderKinds['answer-engine'],
    apiKeyConfigured: configured, baseUrl: null, model: null, defaultModel: 'gemini-2.5-flash', effectiveModel: 'gemini-2.5-flash',
    quota: { defaults: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }, overrides: {}, effective: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 } },
    capabilities: { apiKey: true, clearApiKey: name === 'local', baseUrl: true, resetBaseUrl: name !== 'local', model: true, quota: true, disconnect: true, reload: true },
    hostManaged: { vertex: null, batch: null, pricing: null }, hostUses: [], blockers: [],
  }
}

async function harness(supported = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-settings-'))
  const db = createClient(path.join(directory, 'test.db')); migrate(db)
  db.insert(projects).values({ id: 'alpha', name: 'alpha', displayName: 'Alpha', canonicalDomain: 'alpha.example', country: 'US', language: 'en', providers: ['gemini', route], createdAt: now, updatedAt: now }).run()
  db.insert(users).values({ id: 'viewer', name: 'viewer', nameKey: 'viewer', passwordHash: 'unused', role: 'viewer', createdAt: now }).run()
  for (const key of [
    { id: 'admin', scopes: ['*'] }, { id: 'reader', scopes: ['read'] }, { id: 'settings', scopes: ['settings.write'] },
    { id: 'project', scopes: ['*'], projectId: 'alpha' }, { id: 'viewer', scopes: ['*'], delegatedUserId: 'viewer' },
  ]) {
    const token = `cnry_lifecycle_${key.id}`
    db.insert(apiKeys).values({ ...key, name: key.id, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), createdAt: now }).run()
  }
  const connections = [config('gemini'), config('openrouter'), config('local', false)]
  const read = vi.fn(() => connections)
  const update = vi.fn((name: string, _input: ProviderSettingsUpdateRequest) => ({ name, configured: true }))
  const disconnect = vi.fn((_name: string, _revision: string | undefined) => undefined)
  const models = vi.fn(async () => [])
  const app = Fastify()
  app.register(apiRoutes, {
    db, providerSummary: connections.map(({ name, configured }) => ({ name, configured })), getProviderModels: models,
    providerAdapters: connections.map(connection => ({
      name: connection.name, displayName: connection.name, mode: 'api', modelConfigurable: true,
      defaultModel: 'gemini-2.5-flash', knownModels: [], modelValidationPattern: /./, modelValidationHint: 'a model',
      ...(connection.name === 'openrouter' ? { routes: OPENROUTER_ROUTE_FAMILY, kind: ProviderKinds['model-gateway'] } : {}),
    })),
    ...(supported ? { getProviderConnections: read, onProviderSettingsUpdate: update, onProviderDisconnect: disconnect } : {}),
  } satisfies ApiRoutesOptions)
  await app.ready()
  cleanups.push(async () => { await app.close(); db.$client.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { app, db, connections, read, update, disconnect, models }
}

function headers(key = 'admin') { return { authorization: `Bearer cnry_lifecycle_${key}` } }

describe('provider settings lifecycle HTTP boundary', () => {
  it('reads saved settings without provider calls and strips accidental credential fields from host output', async () => {
    const { app, read, connections, models } = await harness()
    read.mockReturnValue([{ ...connections[0]!, apiKey: 'must-not-leak' } as ProviderConnectionConfigDto])
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings/providers/gemini', headers: headers() })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('must-not-leak')
    expect(providerConnectionSettingsDtoSchema.parse(response.json())).toMatchObject({
      name: 'gemini', model: null, quota: { overrides: {}, effective: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 } },
      usage: { projectCount: 1, projects: [{ name: 'alpha', displayName: 'Alpha', providers: ['gemini'], sources: ['project'] }] },
    })
    expect(models).not.toHaveBeenCalled()
  })

  it.each(['reader', 'settings', 'project', 'viewer'])('refuses %s authority before reading or mutating global lifecycle state', async key => {
    const { app, read, update, disconnect } = await harness()
    for (const request of [
      { method: 'GET' as const },
      { method: 'PUT' as const, payload: { reset: { model: true } } },
      { method: 'DELETE' as const, payload: {} },
    ]) {
      const response = await app.inject({ ...request, url: '/api/v1/settings/providers/gemini', headers: headers(key) })
      expect(response.statusCode).toBe(403)
    }
    expect(read).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('forwards reset intent and optimistic revision without synthesizing replacement values or secret defaults', async () => {
    const { app, update } = await harness()
    const input = { reset: { model: true, baseUrl: true, quota: ['maxConcurrency'] }, quota: { maxRequestsPerDay: 100 }, expectedRevision: 'gemini-revision' }
    const response = await app.inject({ method: 'PUT', url: '/api/v1/settings/providers/gemini', headers: headers(), payload: input })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ name: 'gemini', configured: true })
    expect(update).toHaveBeenCalledWith('gemini', input, expect.objectContaining({ credentialId: 'admin' }))
    update.mockImplementationOnce(() => { throw operationInProgress('A provider batch still needs this connection.') })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/providers/gemini', headers: headers(), payload: { model: 'gemini-2.5-pro' } })).statusCode).toBe(409)
  })

  it.each([
    { reset: {} }, { reset: { apiKey: true } }, { model: 'gemini-2.5-pro', reset: { model: true } },
    { quota: { maxConcurrency: 3 }, reset: { quota: ['maxConcurrency'] } }, { quota: { maxConcurrency: 0 } },
    { baseUrl: 'https://example.com', reset: { baseUrl: true } }, { expectedRevision: 'revision-with-no-edit' },
  ])('rejects invalid or conflicting provider edits before host mutation: %j', async payload => {
    const { app, update } = await harness()
    const response = await app.inject({ method: 'PUT', url: '/api/v1/settings/providers/gemini', headers: headers(), payload })
    expect(response.statusCode).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('counts distinct projects across direct, inherited, scheduled, published and draft selections', async () => {
    const { app, db } = await harness()
    for (const [id, providers] of [['beta', ['openai']], ['gamma', []]] as const) {
      db.insert(projects).values({ id, name: id, displayName: id, canonicalDomain: `${id}.example`, country: 'US', language: 'en', providers: [...providers], createdAt: now, updatedAt: now }).run()
    }
    db.insert(schedules).values({ id: 'alpha-schedule', projectId: 'alpha', kind: RunKinds['answer-visibility'], cronExpr: '0 0 * * *', providers: [route, route], createdAt: now, updatedAt: now }).run()
    const plan = measurementPlanV2Fixture()
    db.insert(measurementPlanVersions).values({ id: 'beta-plan', projectId: 'beta', revision: 1, schemaVersion: 2, canonicalJson: JSON.stringify(plan), checksum: 'b'.repeat(64), createdAt: now }).run()
    db.insert(measurementPlans).values({ projectId: 'beta', activeVersionId: 'beta-plan', createdAt: now, updatedAt: now }).run()
    db.insert(measurementPlanDrafts).values({
      id: 'beta-draft', projectId: 'beta', createdBy: 'test', updatedBy: 'test', createdAt: now, updatedAt: now,
      authoringJson: JSON.stringify({ defaultContext: { providers: [route], models: {}, locations: [] }, targets: [], assignments: [], groups: [] }),
    }).run()
    const gateway = (await app.inject({ method: 'GET', url: '/api/v1/settings/providers/openrouter', headers: headers() })).json()
    expect(gateway.usage).toEqual({ projectCount: 2, projects: [
      { name: 'alpha', displayName: 'Alpha', providers: [route], sources: ['project', 'schedule'] },
      { name: 'beta', displayName: 'beta', providers: [route], sources: ['measurement-draft'] },
    ] })
    const direct = (await app.inject({ method: 'GET', url: '/api/v1/settings/providers/gemini', headers: headers() })).json()
    expect(direct.usage).toEqual({ projectCount: 3, projects: [
      { name: 'alpha', displayName: 'Alpha', providers: ['gemini'], sources: ['project'] },
      { name: 'beta', displayName: 'beta', providers: ['gemini'], sources: ['measurement-plan'] },
      { name: 'gamma', displayName: 'gamma', providers: ['gemini'], sources: ['project'] },
    ] })
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/providers/local', headers: headers() })).json().usage).toEqual({ projectCount: 0, projects: [] })
  })

  it('marks a project with an unreadable plan or draft as unknown usage while every other reference still counts', async () => {
    const { app, db } = await harness()
    // beta inherits the configured engines; gamma names an engine no connection serves.
    for (const [id, providers] of [['beta', []], ['gamma', ['openai']]] as const) {
      db.insert(projects).values({ id, name: id, displayName: id, canonicalDomain: `${id}.example`, country: 'US', language: 'en', providers: [...providers], createdAt: now, updatedAt: now }).run()
    }
    db.insert(measurementPlanDrafts).values({ id: 'beta-draft', projectId: 'beta', createdBy: 'test', updatedBy: 'test', createdAt: now, updatedAt: now, authoringJson: '{"defaultContext":' }).run()
    db.insert(measurementPlanVersions).values({ id: 'gamma-plan', projectId: 'gamma', revision: 1, schemaVersion: 2, canonicalJson: JSON.stringify({ schemaVersion: 2 }), checksum: 'c'.repeat(64), createdAt: now }).run()
    db.insert(measurementPlans).values({ projectId: 'gamma', activeVersionId: 'gamma-plan', createdAt: now, updatedAt: now }).run()
    // A published plan's engines replace this selection, so with the plan unreadable it proves nothing.
    db.insert(schedules).values({ id: 'gamma-schedule', projectId: 'gamma', kind: RunKinds['answer-visibility'], cronExpr: '0 0 * * *', providers: ['gemini'], createdAt: now, updatedAt: now }).run()
    const unknown = { projectCount: 2, projects: [
      { name: 'beta', displayName: 'beta', sources: [ProviderConnectionUsageSources['measurement-draft']] },
      { name: 'gamma', displayName: 'gamma', sources: [ProviderConnectionUsageSources['measurement-plan'], ProviderConnectionUsageSources.schedule] },
    ] }
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: headers() })
    expect(response.statusCode).toBe(200)
    const listed = settingsDtoSchema.parse(response.json())
    expect(listed.providerConnectionsUnavailable).toBeUndefined()
    expect(listed.providerConnections?.find(connection => connection.name === 'gemini')?.usage).toEqual({
      projectCount: 2,
      projects: [
        { name: 'alpha', displayName: 'Alpha', providers: ['gemini'], sources: ['project'] },
        { name: 'beta', displayName: 'beta', providers: ['gemini'], sources: ['project'] },
      ],
      unknown,
    })
    // The editor and disconnect preview read the same usage.
    const local = await app.inject({ method: 'GET', url: '/api/v1/settings/providers/local', headers: headers() })
    expect(local.statusCode).toBe(200)
    expect(local.json().usage).toEqual({ projectCount: 0, projects: [], unknown })
  })

  it('answers /settings without the connection list, and without the failure text, when the host cannot build it', async () => {
    const { app, read } = await harness()
    const secret = 'cnry_must-not-leak'
    // A raw failure and a refusal without a typed reason both quote values only the server log may see.
    for (const failure of [new Error(`ENOENT /private/canonry/config.yaml ${secret}`), forbidden(`Host refusal ${secret}`)]) {
      read.mockImplementation(() => { throw failure })
      const response = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: headers() })
      expect(response.statusCode).toBe(200)
      expect(response.body).not.toContain(secret)
      const settings = settingsDtoSchema.parse(response.json())
      expect(settings.providerConnections).toBeUndefined()
      expect(settings.providerConnectionsUnavailable).toEqual({
        reason: ProviderConnectionsUnavailableReasons['internal-error'],
        message: 'Provider connections could not be loaded. Check the server log, then retry.',
      })
      expect(settings.providers).toEqual([{ name: 'gemini', configured: true }, { name: 'openrouter', configured: true }, { name: 'local', configured: false }])
      expect(settings.providerCatalog.map(entry => entry.name)).toEqual(['gemini', 'openrouter', 'local'])
      expect(settings.google).toEqual({ configured: false })
      expect(settings.bing).toEqual({ configured: false })
    }
    // A caller who never receives the list learns nothing about its state either.
    read.mockClear()
    const narrow = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: headers('reader') })
    expect(narrow.statusCode).toBe(200)
    expect(Object.keys(narrow.json()).sort()).toEqual(['bing', 'google', 'providerCatalog', 'providers'])
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects stale disconnect impact and forwards the current host revision', async () => {
    const { app, db, disconnect } = await harness()
    const url = '/api/v1/settings/providers/gemini'
    const original = (await app.inject({ method: 'GET', url, headers: headers() })).json()
    db.update(projects).set({ providers: [] }).where(eq(projects.id, 'alpha')).run()
    // A different saved provider reference must change impact, even when the same connection remains in the inherited roster.
    db.insert(schedules).values({ id: 'new-schedule', projectId: 'alpha', kind: RunKinds['answer-visibility'], cronExpr: '0 0 * * *', providers: ['gemini'], createdAt: now, updatedAt: now }).run()
    const stale = await app.inject({ method: 'DELETE', url, headers: headers(), payload: { expectedImpactRevision: original.impactRevision } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.details.reason).toBe('provider-impact-changed')
    expect(disconnect).not.toHaveBeenCalled()
    const current = (await app.inject({ method: 'GET', url, headers: headers() })).json()
    const response = await app.inject({ method: 'DELETE', url, headers: headers(), payload: { expectedImpactRevision: current.impactRevision } })
    expect(response.statusCode).toBe(200)
    expect(disconnect).toHaveBeenCalledWith('gemini', 'gemini-revision', expect.objectContaining({ credentialId: 'admin' }))
  })

  it('reports unsupported host lifecycle operations instead of claiming a successful change', async () => {
    const { app } = await harness(false)
    for (const request of [{ method: 'GET' as const }, { method: 'PUT' as const, payload: { reset: { model: true } } }, { method: 'DELETE' as const, payload: {} }]) {
      expect((await app.inject({ ...request, url: '/api/v1/settings/providers/gemini', headers: headers() })).statusCode).toBe(501)
    }
  })
})
