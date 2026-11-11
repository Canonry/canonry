import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  auditLog, createClient, measurementPlans, measurementPlanVersions, migrate,
  projects, providerBatches, querySnapshots, runs, type DatabaseClient,
} from '@canonry/canonry-db'
import {
  CitationStates, ProviderBatchStatuses, ProviderConnectionsUnavailableReasons, RunKinds, RunStatuses,
  type ProviderConnectionSettingsDto, type SettingsDto,
} from '@canonry/canonry-contracts'
import { createServer } from '../src/server.js'
import { loadConfig, type CanonryConfig } from '../src/config.js'
import { seedPlannedProject } from './provider-batch-harness.js'

let directory: string
let configPath: string
let config: CanonryConfig
let db: DatabaseClient
let app: Awaited<ReturnType<typeof createServer>> | undefined

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-settings-'))
  configPath = path.join(directory, 'config.yaml')
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENROUTER_API_KEY', 'CANONRY_BASE_PATH', 'CANONRY_PORT']) vi.stubEnv(name, undefined)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected provider request')))
  config = {
    apiUrl: 'http://localhost:4100', apiKey: 'cnry_provider_settings_fixture',
    database: path.join(directory, 'data.db'), agent: { mode: 'disabled' },
    providers: { local: {
      apiKey: 'private-local-key', baseUrl: 'http://localhost:11434/v1', model: 'local-custom',
      quota: { maxConcurrency: 3, maxRequestsPerDay: 50 },
    } },
  }
  db = createClient(config.database)
  migrate(db)
})

afterEach(async () => {
  await app?.close()
  app = undefined
  db.$client.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fs.rmSync(directory, { recursive: true, force: true })
})

async function start() {
  fs.writeFileSync(configPath, stringify(config))
  config = loadConfig(configPath)
  app = await createServer({ config, configPath, db, logger: false })
}

function request(method: 'GET' | 'PUT' | 'DELETE', name: string, payload?: unknown) {
  return app!.inject({ method, url: `/api/v1/settings/providers/${name}`, headers: { authorization: `Bearer ${config.apiKey}` }, ...(payload === undefined ? {} : { payload }) })
}

async function connection(name: string): Promise<ProviderConnectionSettingsDto> {
  const response = await request('GET', name)
  expect(response.statusCode).toBe(200)
  return response.json<ProviderConnectionSettingsDto>()
}

describe('provider settings lifecycle through the running host', () => {
  it('prefills safe settings and actually removes model, optional key and quota overrides across restart', async () => {
    await start()
    const initial = await connection('local')
    expect(initial).toMatchObject({
      apiKeyConfigured: true, baseUrl: 'http://localhost:11434/v1', model: 'local-custom', effectiveModel: 'local-custom',
      quota: { defaults: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }, overrides: { maxConcurrency: 3, maxRequestsPerDay: 50 }, effective: { maxConcurrency: 3, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 } },
    })
    expect(JSON.stringify(initial)).not.toContain('private-local-key')
    const reset = await request('PUT', 'local', { expectedRevision: initial.revision, reset: { model: true, apiKey: true, quota: ['maxConcurrency'] } })
    expect(reset.statusCode).toBe(200)
    expect(loadConfig(configPath).providers?.local).toEqual({ baseUrl: 'http://localhost:11434/v1', quota: { maxRequestsPerDay: 50 } })
    expect(await connection('local')).toMatchObject({ configured: true, apiKeyConfigured: false, model: null, effectiveModel: 'llama3', quota: { overrides: { maxRequestsPerDay: 50 }, effective: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 } } })
    await app!.close()
    config = loadConfig(configPath)
    app = await createServer({ config, configPath, db, logger: false })
    expect(await connection('local')).toMatchObject({ configured: true, apiKeyConfigured: false, model: null, effectiveModel: 'llama3' })
    expect((await request('PUT', 'local', { reset: { quota: ['maxRequestsPerDay'] } })).statusCode).toBe(200)
    expect(loadConfig(configPath).providers?.local).toEqual({ baseUrl: 'http://localhost:11434/v1' })
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(db.select().from(auditLog).all())).not.toContain('private-local-key')
  })

  it('disconnects without rewriting Simple or Advanced references, contexts, plans or stored observations', async () => {
    for (const schema of [1, 2] as const) {
      const { projectId } = seedPlannedProject({ db, count: 1, providers: ['local'], schema })
      db.insert(runs).values({ id: `run-${schema}`, projectId, kind: RunKinds['answer-visibility'], status: RunStatuses.completed, createdAt: '2026-11-05T00:00:00.000Z' }).run()
      db.insert(querySnapshots).values({ id: `answer-${schema}`, runId: `run-${schema}`, provider: 'local', queryText: 'A stored query', answerText: 'A stored answer', citationState: CitationStates.cited, answerMentioned: true, createdAt: '2026-11-05T00:00:00.000Z' }).run()
    }
    await start()
    const before = { projects: db.select().from(projects).all(), plans: db.select().from(measurementPlans).all(), revisions: db.select().from(measurementPlanVersions).all(), runs: db.select().from(runs).all(), answers: db.select().from(querySnapshots).all() }
    const current = await connection('local')
    expect(current.usage.projectCount).toBe(2)
    const response = await request('DELETE', 'local', { expectedImpactRevision: current.impactRevision })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ configured: false, apiKeyConfigured: false, usage: { projectCount: 2 } })
    expect(loadConfig(configPath).providers?.local).toBeUndefined()
    expect({ projects: db.select().from(projects).all(), plans: db.select().from(measurementPlans).all(), revisions: db.select().from(measurementPlanVersions).all(), runs: db.select().from(runs).all(), answers: db.select().from(querySnapshots).all() }).toEqual(before)
    await app!.close()
    config = loadConfig(configPath)
    app = await createServer({ config, configPath, db, logger: false })
    expect(await connection('local')).toMatchObject({ configured: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('removes legacy Gemini credentials so a restart cannot reconnect the provider', async () => {
    config.providers = {}
    config.geminiApiKey = 'private-legacy-gemini-key'
    config.geminiModel = 'gemini-2.5-flash'
    await start()
    expect((await connection('gemini')).configured).toBe(true)
    expect((await request('DELETE', 'gemini', {})).statusCode).toBe(200)
    const saved = loadConfig(configPath)
    expect(saved.providers?.gemini).toBeUndefined()
    expect(saved.geminiApiKey).toBeUndefined()
    expect(saved.geminiModel).toBeUndefined()
    expect((await connection('gemini')).configured).toBe(false)
  })

  it('restores a direct provider endpoint default without removing its key or accepting a Local endpoint reset', async () => {
    config.providers!.openai = { apiKey: 'private-openai-key', baseUrl: 'https://proxy.example/v1', model: 'gpt-4.1' }
    await start()
    expect((await request('PUT', 'openai', { reset: { baseUrl: true } })).statusCode).toBe(200)
    expect(loadConfig(configPath).providers?.openai).toEqual({ apiKey: 'private-openai-key', model: 'gpt-4.1' })
    expect(await connection('openai')).toMatchObject({ configured: true, apiKeyConfigured: true, baseUrl: null })
    expect((await request('PUT', 'local', { reset: { baseUrl: true } })).statusCode).toBe(400)
    expect(loadConfig(configPath).providers?.local?.baseUrl).toBe('http://localhost:11434/v1')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects stale edits and preserves unrelated external config changes on a fresh edit', async () => {
    await start()
    const initial = await connection('local')
    fs.writeFileSync(configPath, stringify({ ...config, dashboard: { showResourceLinks: false }, providers: { ...config.providers, local: { ...config.providers!.local, apiKey: 'externally-rotated-key' }, openai: { apiKey: 'external-openai-key' } } }))
    const rejected = await request('PUT', 'local', { expectedRevision: initial.revision, model: 'next-model' })
    expect(rejected.statusCode).toBe(409)
    expect(config.providers?.local?.model).toBe('local-custom')
    const fresh = await connection('local')
    expect((await request('PUT', 'local', { expectedRevision: fresh.revision, reset: { model: true } })).statusCode).toBe(200)
    const saved = parse(fs.readFileSync(configPath, 'utf8')) as CanonryConfig
    expect(saved).toMatchObject({ dashboard: { showResourceLinks: false }, providers: { local: { apiKey: 'externally-rotated-key' }, openai: { apiKey: 'external-openai-key' } } })
    expect(saved.providers?.local?.model).toBeUndefined()
  })

  it('keeps runtime, file and audit history unchanged when persistence fails', async () => {
    await start()
    const before = await connection('local')
    const disk = fs.readFileSync(configPath, 'utf8')
    const audit = db.select().from(auditLog).all()
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('fixture write failure') })
    const response = await request('PUT', 'local', { model: 'next-model' })
    expect(response.statusCode).toBe(500)
    expect(await connection('local')).toEqual(before)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(disk)
    expect(db.select().from(auditLog).all()).toEqual(audit)
    expect((await request('PUT', 'openai', { apiKey: 'fixture-openai-key' })).statusCode).toBe(200)
    expect((await connection('local')).effectiveModel).toBe('local-custom')
  })

  it('keeps settings readable with a typed reason while config.yaml cannot be read, then lists connections once repaired', async () => {
    await start()
    const settings = () => app!.inject({ method: 'GET', url: '/api/v1/settings', headers: { authorization: `Bearer ${config.apiKey}` } })
    const unreadable = {
      reason: ProviderConnectionsUnavailableReasons['config-unreadable'],
      message: 'Saved provider settings could not be read from config.yaml. Repair the file on the host, then reload provider connections.',
    }
    for (const contents of [
      // A hand edit that breaks the YAML on a credential-bearing line.
      `${stringify(config)}broken: { apiKey: private-local-key\n`,
      // Valid YAML the loader refuses, with the file's path in its message.
      stringify({ ...config, dashboard: { managedSweeps: 'sometimes' } }),
    ]) {
      fs.writeFileSync(configPath, contents)
      const response = await settings()
      expect(response.statusCode).toBe(200)
      expect(response.body).not.toContain('private-local-key')
      expect(response.body).not.toContain(directory)
      const body = response.json<SettingsDto>()
      expect(body.providerConnections).toBeUndefined()
      expect(body.providerConnectionsUnavailable).toEqual(unreadable)
      expect(body.providers.find(provider => provider.name === 'local')).toMatchObject({ configured: true, model: 'local-custom' })
      expect(body.providerCatalog.some(entry => entry.name === 'local')).toBe(true)
      expect(body.google).toEqual({ configured: false })
      expect(body.bing).toEqual({ configured: false })
      // The editor's own read refuses with the same typed reason.
      const single = await request('GET', 'local')
      expect(single.statusCode).toBe(400)
      expect(single.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: unreadable.message, details: { reason: unreadable.reason } } })
    }
    fs.writeFileSync(configPath, stringify(config))
    const repaired = (await settings()).json<SettingsDto>()
    expect(repaired.providerConnectionsUnavailable).toBeUndefined()
    expect(repaired.providerConnections?.find(connection => connection.name === 'local')).toMatchObject({ configured: true, apiKeyConfigured: true, model: 'local-custom' })
  })

  it('protects host-managed credentials and hides private endpoint and credential-file values', async () => {
    config.providers = {
      gemini: { vertexProject: 'host-project', vertexRegion: 'us-central1', vertexCredentials: '/private/service-account.json' },
      local: { baseUrl: 'https://user:private-password@local.example/v1?token=private-token' },
      openai: { apiKey: 'saved-openai-key' },
    }
    vi.stubEnv('OPENAI_API_KEY', 'environment-openai-key')
    await start()
    const vertex = await connection('gemini')
    expect(vertex).toMatchObject({ configured: true, capabilities: { apiKey: false, model: true, quota: true, disconnect: false }, hostManaged: { vertex: { project: 'host-project', region: 'us-central1', credentialsConfigured: true } } })
    expect(JSON.stringify(vertex)).not.toContain('/private/service-account.json')
    expect((await request('PUT', 'gemini', { apiKey: 'replacement-key' })).statusCode).toBe(403)
    expect((await request('DELETE', 'gemini', {})).statusCode).toBe(501)
    expect(await connection('openai')).toMatchObject({ capabilities: { apiKey: true, disconnect: false }, blockers: expect.arrayContaining([expect.objectContaining({ code: 'environment-credential' })]) })
    const local = await connection('local')
    expect(local.baseUrl).toBeNull()
    expect(JSON.stringify(local)).not.toContain('private-password')
    expect(JSON.stringify(local)).not.toContain('private-token')
    expect((await request('PUT', 'local', { model: 'next-model' })).statusCode).toBe(200)
    const audit = JSON.stringify(db.select().from(auditLog).all())
    expect(audit).not.toContain('private-password')
    expect(audit).not.toContain('private-token')
    expect(audit).toContain('https://local.example/v1')
    fs.chmodSync(configPath, 0o400)
    expect(await connection('local')).toMatchObject({ capabilities: { apiKey: false, model: false, quota: false, disconnect: false } })
    expect((await request('PUT', 'local', { model: 'next-model' })).statusCode).toBe(403)
  })

  it('blocks credential, model and disconnect changes for pending batches while allowing quota reset', async () => {
    config.providers = { claude: { apiKey: 'private-batch-key', model: 'claude-sonnet-4-6', quota: { maxConcurrency: 4 }, batch: { enabled: true } } }
    const { projectId } = seedPlannedProject({ db, count: 1, providers: ['claude'] })
    const now = new Date().toISOString()
    db.insert(runs).values({ id: 'pending-run', projectId, kind: RunKinds['answer-visibility'], status: RunStatuses.running, createdAt: now }).run()
    db.insert(providerBatches).values({ id: 'pending-batch', projectId, runId: 'pending-run', provider: 'claude', model: 'claude-sonnet-4-6', providerBatchId: 'upstream-batch', status: ProviderBatchStatuses.submitted, requestCount: 1, quotaScope: 'claude', quotaPeriod: now.slice(0, 10), quotaReserved: 1, deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: now, updatedAt: now }).run()
    await start()
    const disk = fs.readFileSync(configPath, 'utf8')
    const audit = db.select().from(auditLog).all()
    expect(await connection('claude')).toMatchObject({ blockers: expect.arrayContaining([expect.objectContaining({ code: 'outstanding-batches', batchIds: ['pending-batch'], runIds: ['pending-run'] })]) })
    for (const payload of [{ apiKey: 'replacement-key' }, { model: 'claude-opus-4-6' }, { reset: { model: true } }]) {
      expect((await request('PUT', 'claude', payload)).statusCode).toBe(409)
    }
    expect((await request('DELETE', 'claude', {})).statusCode).toBe(409)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(disk)
    expect(db.select().from(auditLog).all()).toEqual(audit)
    const reset = await request('PUT', 'claude', { reset: { quota: ['maxConcurrency'] } })
    expect(reset.statusCode).toBe(200)
    expect(loadConfig(configPath).providers?.claude?.quota).toBeUndefined()
    expect(await connection('claude')).toMatchObject({ quota: { overrides: {}, effective: { maxConcurrency: 2 } } })
    expect(fetch).not.toHaveBeenCalled()
  })
})
