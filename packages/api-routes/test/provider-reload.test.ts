import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeys, createClient, migrate, projects, users } from '@ainyc/canonry-db'
import { operationInProgress, validationError } from '@ainyc/canonry-contracts'
import { apiRoutes, hashApiKey, type ApiRoutesOptions, type OutcomeTelemetryEvent } from '../src/index.js'
import { featureOutcomes } from './feature-outcome-capture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(supported = true, liveRegistry = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-reload-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'example', name: 'example', displayName: 'Example', canonicalDomain: 'example.com',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(users).values({
    id: 'viewer', name: 'viewer', nameKey: 'viewer', passwordHash: 'not-used-for-bearer-auth',
    role: 'viewer', createdAt: now,
  }).run()
  for (const key of [
    { id: 'root', scopes: ['*'] },
    { id: 'read', scopes: ['read'] },
    { id: 'write', scopes: ['write'] },
    { id: 'settings', scopes: ['settings.write'] },
    { id: 'project', scopes: ['*'], projectId: 'example' },
    { id: 'viewer', scopes: ['*'], delegatedUserId: 'viewer' },
  ]) {
    const token = `cnry_reload_${key.id}`
    db.insert(apiKeys).values({
      ...key, name: key.id, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), createdAt: now,
    }).run()
  }
  const providers = [{ name: 'gemini', configured: true, vertexConfigured: true, model: 'gemini-2.5-flash' }]
  const providerSummary: NonNullable<ApiRoutesOptions['providerSummary']> = []
  const reload = vi.fn(async () => providers)
  const outcomes: OutcomeTelemetryEvent[] = []
  const app = Fastify()
  const options: ApiRoutesOptions = {
    db, providerSummary,
    onOutcome: event => { outcomes.push(event) },
    providerAdapters: [{
      name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true,
      defaultModel: 'gemini-2.5-flash', knownModels: [], modelValidationPattern: /^gemini-/, modelValidationHint: 'Gemini model',
    }],
    ...(liveRegistry ? { getRunnableProviderNames: () => providerSummary.filter(provider => provider.configured).map(provider => provider.name) } : {}),
    onResearchRunRequested: vi.fn(),
    ...(supported ? { onProviderReload: reload } : {}),
  }
  app.register(apiRoutes, options)
  await app.ready()
  cleanups.push(async () => {
    await app.close()
    db.$client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { app, reload, providers, providerSummary, outcomes }
}

function headers(key = 'root') {
  return { authorization: `Bearer cnry_reload_${key}`, 'x-canonry-mcp-tool': 'canonry_providers_reload' }
}

describe('provider reload HTTP contract', () => {
  it.each([false, true])('research reflects provider additions/removals after reload (live registry: %s)', async (liveRegistry) => {
    const { app, reload, providers, providerSummary } = await harness(true, liveRegistry)
    const url = '/api/v1/projects/example/research/runs'
    const getProviders = async () => (await app.inject({ method: 'GET', url, headers: headers() })).json().providers
    expect(await getProviders()).toEqual([])
    reload.mockImplementationOnce(async () => {
      providerSummary.splice(0, providerSummary.length, ...providers)
      return providers
    })
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(), payload: {} })).statusCode).toBe(200)
    expect(await getProviders()).toEqual([expect.objectContaining({ name: 'gemini', defaultModel: 'gemini-2.5-flash' })])
    const directPayload = { queries: ['Which platform fits an agency?'], provider: 'gemini', model: 'gemini-2.5-flash' }
    const accepted = await app.inject({ method: 'POST', url, headers: headers(), payload: directPayload })
    expect(accepted.statusCode).toBe(202)
    const batchPayload = {
      idempotencyKey: 'before-removal',
      runs: [{ ...directPayload, location: null }],
    }
    const batchUrl = '/api/v1/projects/example/research/batches'
    expect((await app.inject({ method: 'POST', url: batchUrl, headers: headers(), payload: batchPayload })).statusCode).toBe(202)

    reload.mockImplementationOnce(async () => {
      providerSummary.splice(0)
      return []
    })
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(), payload: {} })).statusCode).toBe(200)
    expect(await getProviders()).toEqual([])
    for (const request of [
      { url, payload: directPayload },
      { url: batchUrl, payload: { ...batchPayload, idempotencyKey: 'after-removal' } },
    ]) {
      const denied = await app.inject({ method: 'POST', headers: headers(), ...request })
      expect(denied.statusCode).toBe(400)
      expect(denied.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { validProviders: [] } } })
    }
    // Replays keep their saved execution identity even after the provider is removed.
    expect((await app.inject({ method: 'POST', url: batchUrl, headers: headers(), payload: batchPayload })).statusCode).toBe(200)
  })

  it('awaits the host reload and returns credential-free provider status with request audit identity', async () => {
    const { app, reload, providers } = await harness()
    const hostProviders = [{ ...providers[0]!, apiKey: 'never-return-host-credentials' }]
    reload.mockResolvedValue(hostProviders)
    const input = { configPath: '/srv/canonry/config.yaml', databasePath: '/srv/canonry/data.db' }
    const response = await app.inject({
      method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(), payload: input,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ reloaded: true, providers })
    expect(reload).toHaveBeenCalledWith(input, expect.objectContaining({ credentialId: 'root', actor: 'api-key:root' }))

    const noIdentity = await app.inject({
      method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(), payload: {},
    })
    expect(noIdentity.statusCode).toBe(200)
    expect(reload).toHaveBeenLastCalledWith({}, expect.objectContaining({ credentialId: 'root' }))
  })

  it.each(['read', 'write', 'settings', 'project', 'viewer'])(
    'refuses %s credentials before reading or changing the host config', async (key) => {
      const { app, reload } = await harness()
      const response = await app.inject({
        method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(key), payload: {},
      })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
      expect(reload).not.toHaveBeenCalled()
    },
  )

  it.each([
    { configPath: '/srv/config.yaml' },
    { databasePath: '/srv/data.db' },
    { configPath: '', databasePath: '/srv/data.db' },
    { apiKey: 'must-not-be-transmitted' },
  ])('rejects malformed or credential-bearing reload input %j', async (payload) => {
    const { app, reload } = await harness()
    const response = await app.inject({
      method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(), payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(reload).not.toHaveBeenCalled()
  })

  it('reports an unsupported host instead of claiming its saved config became active', async () => {
    const { app } = await harness(false)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(), payload: {},
    })
    expect(response.statusCode).toBe(501)
    expect(response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } })
  })

  it('reports each reload with the providers left configured, or the reason it was refused', async () => {
    const { app, reload, outcomes } = await harness()
    const post = () => app.inject({ method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(), payload: {} })
    reload.mockResolvedValueOnce([
      { name: 'gemini', configured: true, vertexConfigured: true, model: 'gemini-2.5-flash' },
      { name: 'openai', configured: false, vertexConfigured: false, model: 'gpt-5' },
      { name: 'claude', configured: true, vertexConfigured: false, model: 'claude-sonnet-4-6' },
    ])
    expect((await post()).statusCode).toBe(200)
    // The host refuses a reload while batch work is outstanding, or one meant for another install.
    reload.mockRejectedValueOnce(operationInProgress('Wait for outstanding batch work to settle.'))
    expect((await post()).statusCode).toBe(409)
    reload.mockRejectedValueOnce(validationError('Provider reload identity does not match this running server.', { reason: 'install-identity-mismatch' }))
    expect((await post()).statusCode).toBe(400)

    const unsupported = await harness(false)
    await unsupported.app.inject({ method: 'POST', url: '/api/v1/settings/providers/reload', headers: headers(), payload: {} })

    const base = { feature: 'providers', operation: 'reload', trigger: 'manual', durationBucket: expect.any(String) }
    expect(featureOutcomes([...outcomes, ...unsupported.outcomes])).toEqual([
      { ...base, status: 'succeeded', counts: { providers: 2 } },
      { ...base, status: 'failed', reasonCode: 'OPERATION_IN_PROGRESS', errorName: 'AppError' },
      { ...base, status: 'failed', reasonCode: 'VALIDATION', errorName: 'AppError' },
      { ...base, status: 'failed', reasonCode: 'UNSUPPORTED', errorName: 'AppError' },
    ])
  })
})
