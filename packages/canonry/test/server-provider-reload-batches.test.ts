import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { auditLog, createClient, migrate, projects, providerBatches, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { ProviderBatchStatuses, ProviderDispatchModes, RunKinds, RunStatuses, type ProviderBatchStatus, type SettingsDto } from '@ainyc/canonry-contracts'
import { claudeAdapter } from '@ainyc/canonry-provider-claude'
import { createServer } from '../src/server.js'
import type { CanonryConfig, ProviderConfigEntry } from '../src/config.js'
import { batchRows, deferred, FakeBatchTransport, seedPlannedProject } from './provider-batch-harness.js'

let directory: string
let config: CanonryConfig
let db: DatabaseClient
let app: Awaited<ReturnType<typeof createServer>> | undefined

function save(providers: CanonryConfig['providers']) {
  fs.writeFileSync(path.join(directory, 'config.yaml'), stringify({ ...config, providers }))
}

function request(method: 'GET' | 'POST', url: string, payload: Record<string, unknown> = {}) {
  return app!.inject({ method, url, headers: { authorization: `Bearer ${config.apiKey}` }, ...(method === 'POST' ? { payload } : {}) })
}

async function startPendingBatch(status: ProviderBatchStatus) {
  app = await createServer({ config, db, logger: false })
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'acme', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme.example',
    country: 'US', language: 'en', providers: ['claude'], createdAt: now, updatedAt: now,
  }).run()
  db.insert(runs).values({ id: 'batch-run', projectId: 'acme', kind: RunKinds['answer-visibility'], status: RunStatuses.running, createdAt: now }).run()
  db.insert(providerBatches).values({
    id: 'pending-batch', projectId: 'acme', runId: 'batch-run', provider: 'claude',
    model: 'claude-sonnet-4-20250514', providerBatchId: status === ProviderBatchStatuses.submitting ? null : 'upstream-batch',
    status, requestCount: 1, quotaScope: 'claude', quotaPeriod: now.slice(0, 10), quotaReserved: 1,
    deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: now, updatedAt: now,
  }).run()
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-reload-batches-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  config = {
    apiUrl: 'http://localhost:4100', database: path.join(directory, 'data.db'), apiKey: 'cnry_pending_batch_fixture',
    agent: { mode: 'disabled' }, providers: { claude: { apiKey: 'original-batch-key', model: 'claude-sonnet-4-20250514', batch: { enabled: true } } },
  }
  db = createClient(config.database)
  migrate(db)
  save(config.providers)
  vi.spyOn(claudeAdapter, 'listModels').mockResolvedValue([])
})

afterEach(async () => {
  await app?.close()
  app = undefined
  db.$client.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('provider reload preserves outstanding batches', () => {
  it.each([ProviderBatchStatuses.submitting, ProviderBatchStatuses.submitted, ProviderBatchStatuses.ended])(
    'refuses provider removal while a batch is %s without changing runtime state or audit history', async status => {
      await startPendingBatch(status)
      const before = db.select().from(auditLog).all()
      save({})
      const response = await request('POST', '/api/v1/settings/providers/reload')
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: { code: 'OPERATION_IN_PROGRESS', details: { providers: ['claude'] } } })
      expect(config.providers?.claude?.apiKey).toBe('original-batch-key')
      const settings = (await request('GET', '/api/v1/settings')).json<SettingsDto>()
      expect(settings.providers.find(provider => provider.name === 'claude')?.configured).toBe(true)
      expect(db.select().from(auditLog).all()).toEqual(before)
    },
  )

  it.each([
    { apiKey: 'different-batch-account-key' },
    { baseUrl: 'https://different-provider.example/v1' },
    { model: 'claude-sonnet-4-6' },
    { batch: { enabled: false } },
  ] satisfies Partial<ProviderConfigEntry>[])('refuses non-quota registration changes while a batch is pending: %j', async patch => {
    await startPendingBatch(ProviderBatchStatuses.submitted)
    save({ claude: { ...config.providers?.claude, ...patch } })
    const response = await request('POST', '/api/v1/settings/providers/reload')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'OPERATION_IN_PROGRESS' } })
    expect(response.body).not.toContain('original-batch-key')
    expect(response.body).not.toContain('different-batch-account-key')
  })

  it('allows quota-only updates during a pending batch and removal after it settles', async () => {
    await startPendingBatch(ProviderBatchStatuses.submitted)
    const quota = { maxConcurrency: 1, maxRequestsPerMinute: 3, maxRequestsPerDay: 300 }
    save({ claude: { ...config.providers?.claude, quota } })
    const changed = await request('POST', '/api/v1/settings/providers/reload')
    expect(changed.statusCode).toBe(200)
    expect(changed.json().providers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'claude', configured: true, quota })]))
    db.update(providerBatches).set({ status: ProviderBatchStatuses.ingested }).where(eq(providerBatches.id, 'pending-batch')).run()
    save({})
    const removed = await request('POST', '/api/v1/settings/providers/reload')
    expect(removed.statusCode).toBe(200)
    expect(removed.json().providers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'claude', configured: false })]))
  })

  it('refuses provider removal after cancellation until the upstream submit returns and is cancelled', async () => {
    const submitGate = deferred()
    const transport = new FakeBatchTransport()
    transport.submitOutcomes = [async () => { await submitGate.promise }]
    const capability = transport.capability
    vi.spyOn(claudeAdapter.batch!, 'submit').mockImplementation(capability.submit)
    vi.spyOn(claudeAdapter.batch!, 'cancel').mockImplementation(capability.cancel)
    app = await createServer({ config, db, logger: false })
    const { projectId } = seedPlannedProject({ db, count: 1, providers: ['claude'] })
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()!
    const queued = await request('POST', `/api/v1/projects/${project.name}/runs`, { dispatchMode: ProviderDispatchModes.batch })
    expect(queued.statusCode).toBe(201)
    const runId = queued.json<{ id: string }>().id
    try {
      await vi.waitFor(() => expect(batchRows(db, runId)[0]?.status).toBe(ProviderBatchStatuses.submitting))
      const cancelled = await request('POST', `/api/v1/runs/${runId}/cancel`)
      expect(cancelled.statusCode).toBe(200)
      expect(batchRows(db, runId)[0]).toMatchObject({ status: ProviderBatchStatuses.cancelled, providerBatchId: null })
      save({})
      const refused = await request('POST', '/api/v1/settings/providers/reload')
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toMatchObject({ error: { code: 'OPERATION_IN_PROGRESS', details: { providers: ['claude'] } } })
    } finally {
      submitGate.resolve()
      await vi.waitFor(() => expect(batchRows(db, runId)[0]?.providerBatchId).not.toBeNull())
    }
    expect(transport.cancelCalls).toEqual([transport.only().id])
    const reloaded = await request('POST', '/api/v1/settings/providers/reload')
    expect(reloaded.statusCode).toBe(200)
  })
})
