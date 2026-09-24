import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  type LocationContext,
  type MeasurementPlanV2,
  type SnapshotUsage,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  providerBatches,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes, evaluateRunFill } from '../src/index.js'
import { queueRunIfProjectIdle, type QueueRunParams } from '../src/run-queue.js'

// Batch dispatch is decided once, at queue time, and frozen onto the run
// (runs.provider_dispatch_modes). These tests drive both portfolio kinds
// through the one queue path: a simple (v1) plan and an Advanced (v2) plan.

const NOW = '2026-09-24T00:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const INSTANCE_MODELS = { claude: 'claude-sonnet-4-6', openai: 'gpt-5.4', gemini: 'gemini-2.5-flash' }

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let batchEligible: string[]
const created: string[] = []

async function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
}

async function seedProject(name: string, providers: string[] = ['claude', 'openai']): Promise<string> {
  const response = await inject('PUT', `/api/v1/projects/${name}`, {
    displayName: name,
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers,
  })
  expect(response.statusCode).toBe(201)
  await inject('POST', `/api/v1/projects/${name}/queries`, { queries: ['widget pricing', 'widget repair'] })
  return (response.json() as { id: string }).id
}

/** A simple portfolio: a published v1 plan with one Target, measured by the project's engines. */
async function publishV1(name: string) {
  const projectId = db.select({ id: projects.id }).from(projects).where(eq(projects.name, name)).get()!.id
  const tracked = db.select({ id: queries.id }).from(queries).where(eq(queries.projectId, projectId)).all()
  const response = await inject('PUT', `/api/v1/projects/${name}/measurement-plan`, {
    expectedActiveRevision: null,
    plan: {
      schemaVersion: 1,
      targets: [{
        stableKey: 'north-branch',
        label: 'North branch',
        urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/north', pathCase: 'insensitive' }],
        aliases: ['North branch'],
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'north-branch', queryIds: tracked.map(row => row.id) }],
    },
  })
  expect(response.statusCode).toBe(201)
}

/** An Advanced portfolio: a published v2 revision whose nodes froze their own engines and models. */
function publishV2(projectId: string, models: Record<string, string> = { claude: 'claude-opus-5', openai: 'gpt-5.4' }) {
  const tracked = db.select({ id: queries.id, query: queries.query }).from(queries).where(eq(queries.projectId, projectId)).all()
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Planned Co'] } },
    targets: [{
      stableKey: 'north-branch',
      label: 'north-branch',
      aliases: ['north-branch'],
      urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/north', pathCase: 'insensitive' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    }],
    groups: [],
    querySnapshots: tracked.map(row => ({ queryId: row.id, queryText: row.query, provenance: { source: 'manual', sourceId: null, capturedAt: NOW } })),
    assignments: tracked.map((row, index) => ({ targetKey: 'north-branch', queryId: row.id, queryClass: 'non-brand', executionNodeKey: `exec-${index}` })),
    executionNodes: tracked.map((row, index) => ({
      stableKey: `exec-${index}`,
      queryId: row.id,
      queryText: row.query,
      context: { providers: ['claude', 'openai'], models, location: NORTH },
      expectedSnapshots: 2,
    })),
    usageEdges: tracked.map((row, index) => ({ executionNodeKey: `exec-${index}`, targetKey: 'north-branch', queryId: row.id })),
    compiledChecksum: '0'.repeat(64),
  }
  const plan = { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId, projectId, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
}

async function seedPortfolio(kind: 'simple' | 'advanced', name = 'planned'): Promise<string> {
  const projectId = await seedProject(name)
  if (kind === 'simple') await publishV1(name)
  else publishV2(projectId)
  return projectId
}

function setPreference(projectId: string, modes: Record<string, 'sync' | 'batch'>) {
  db.update(projects).set({ providerDispatchModes: modes }).where(eq(projects.id, projectId)).run()
}

function queue(projectId: string, params: Partial<QueueRunParams>) {
  const result = queueRunIfProjectIdle(db, {
    projectId,
    runnableProviders: ['claude', 'openai', 'gemini'],
    providerModels: INSTANCE_MODELS,
    batchEligibleProviders: batchEligible,
    ...params,
  })
  if (result.conflict) throw new Error('unexpected conflict')
  return result
}

function runRow(runId: string) {
  return db.select().from(runs).where(eq(runs.id, runId)).get()!
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-dispatch-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  batchEligible = ['claude', 'openai']
  created.length = 0
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    getRunnableProviderNames: () => ['claude', 'openai', 'gemini'],
    getEffectiveProviderModels: () => INSTANCE_MODELS,
    getBatchEligibleProviderNames: () => batchEligible,
    onRunCreated: (runId) => { created.push(runId) },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe.each(['simple', 'advanced'] as const)('queue-time dispatch freezing (%s portfolio)', (portfolio) => {
  it('a scheduled sweep batches the providers its project marks batch that the instance can batch', async () => {
    const projectId = await seedPortfolio(portfolio)
    setPreference(projectId, { claude: 'batch', openai: 'sync' })

    const result = queue(projectId, { trigger: 'scheduled' })

    expect(result.dispatch).toEqual({ modes: { claude: 'batch' }, ineligible: {}, requested: ['claude'] })
    expect(runRow(result.runId).providerDispatchModes).toEqual({ claude: 'batch' })
  })

  it('a scheduled sweep runs an ineligible preference sync and says why', async () => {
    const projectId = await seedPortfolio(portfolio)
    setPreference(projectId, { claude: 'batch', openai: 'batch' })
    batchEligible = ['openai']

    const result = queue(projectId, { trigger: 'scheduled' })

    expect(result.dispatch).toEqual({ modes: { openai: 'batch' }, ineligible: { claude: 'batch_unavailable' }, requested: ['claude', 'openai'] })
    expect(runRow(result.runId).providerDispatchModes).toEqual({ openai: 'batch' })
  })

  it('stores null when every provider runs sync', async () => {
    const projectId = await seedPortfolio(portfolio)
    setPreference(projectId, { claude: 'batch' })

    // An explicit sync request wins over the preference, even on a scheduled run.
    const scheduledSync = queue(projectId, { trigger: 'scheduled', dispatchMode: 'sync' })
    expect(runRow(scheduledSync.runId).providerDispatchModes).toBeNull()
  })

  it('a manual run ignores the preference unless it asks for batch', async () => {
    const projectId = await seedPortfolio(portfolio)
    setPreference(projectId, { claude: 'batch', openai: 'batch' })

    const response = await inject('POST', '/api/v1/projects/planned/runs')

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ dispatchModes: {} })
    expect(runRow(response.json().id).providerDispatchModes).toBeNull()
  })

  it('a manual batch request batches every eligible provider in the run', async () => {
    await seedPortfolio(portfolio)
    batchEligible = ['claude']

    const response = await inject('POST', '/api/v1/projects/planned/runs', { dispatchMode: 'batch' })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ dispatchModes: { claude: 'batch' } })
    expect(runRow(response.json().id).providerDispatchModes).toEqual({ claude: 'batch' })
    expect(created).toEqual([response.json().id])
  })

  it('refuses a manual batch request no provider can honour, naming each reason, and queues nothing', async () => {
    await seedPortfolio(portfolio)
    batchEligible = []

    const response = await inject('POST', '/api/v1/projects/planned/runs', { dispatchMode: 'batch' })

    expect(response.statusCode).toBe(400)
    const error = response.json().error as { code: string; message: string; details: { ineligible: Record<string, string> } }
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toContain('claude: this instance cannot batch claude')
    expect(error.message).toContain('openai: this instance cannot batch openai')
    expect(error.details.ineligible).toEqual({ claude: 'batch_unavailable', openai: 'batch_unavailable' })
    expect(db.select().from(runs).all()).toEqual([])
    expect(created).toEqual([])
  })

  it('refuses a batch request on a slice', async () => {
    await seedPortfolio(portfolio)

    const response = await inject('POST', '/api/v1/projects/planned/runs', {
      dispatchMode: 'batch',
      measurementScope: { targets: ['north-branch'] },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.details.ineligible).toEqual({ claude: 'scoped_run', openai: 'scoped_run' })
    expect(db.select().from(runs).all()).toEqual([])
  })

  it('refuses a batch request on a probe', async () => {
    await seedPortfolio(portfolio)

    const response = await inject('POST', '/api/v1/projects/planned/runs', { dispatchMode: 'batch', trigger: 'probe' })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.details.ineligible).toEqual({ claude: 'probe_run', openai: 'probe_run' })
  })
})

describe('dispatch rules that depend on the portfolio kind', () => {
  it('a simple plan with no model for a provider cannot batch that provider', async () => {
    const projectId = await seedPortfolio('simple')

    // The instance points only openai at a model, so claude's slots freeze none.
    const result = queue(projectId, { trigger: 'manual', dispatchMode: 'batch', providerModels: { openai: 'gpt-5.4' } })

    expect(result.dispatch).toEqual({ modes: { openai: 'batch' }, ineligible: { claude: 'model_not_frozen' }, requested: ['claude', 'openai'] })
  })

  it('an advanced plan batches with the models its revision froze', async () => {
    const projectId = await seedProject('planned')
    publishV2(projectId, { claude: 'claude-opus-5' })

    // openai's nodes froze no model and the instance supplies none.
    const result = queue(projectId, { trigger: 'manual', dispatchMode: 'batch', providerModels: {} })

    expect(result.dispatch.modes).toEqual({ claude: 'batch' })
    expect(result.dispatch.ineligible).toEqual({ openai: 'model_not_frozen' })
  })
})

describe('planless runs never batch', () => {
  it('refuses a batch request on a project with no published plan', async () => {
    await seedProject('plainco')

    const response = await inject('POST', '/api/v1/projects/plainco/runs', { dispatchMode: 'batch' })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.details.ineligible).toEqual({ claude: 'not_plan_run', openai: 'not_plan_run' })
    expect(db.select().from(runs).all()).toEqual([])
  })

  it('refuses a batch request that fans out across locations, which is always planless', async () => {
    await seedProject('plainco')
    await inject('POST', '/api/v1/projects/plainco/locations', NORTH)

    const response = await inject('POST', '/api/v1/projects/plainco/runs', { dispatchMode: 'batch', allLocations: true })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.details.ineligible).toEqual({ claude: 'not_plan_run', openai: 'not_plan_run' })
    expect(db.select().from(runs).all()).toEqual([])
  })

  it('a scheduled planless sweep runs its batch preference sync and keeps the run DTO unchanged', async () => {
    const projectId = await seedProject('plainco')
    setPreference(projectId, { claude: 'batch' })

    const result = queue(projectId, { trigger: 'scheduled' })

    expect(result.dispatch).toEqual({ modes: {}, ineligible: { claude: 'not_plan_run' }, requested: ['claude'] })
    expect(runRow(result.runId).providerDispatchModes).toBeNull()
    const run = (await inject('GET', `/api/v1/runs/${result.runId}`)).json() as Record<string, unknown>
    expect(run).not.toHaveProperty('dispatchModes')
  })
})

describe('POST /runs (every project)', () => {
  it('queues the projects that can batch and reports the others as their own error rows', async () => {
    await seedPortfolio('simple', 'planned')
    await seedProject('plainco')

    const response = await inject('POST', '/api/v1/runs', { dispatchMode: 'batch' })

    expect(response.statusCode).toBe(207)
    const rows = response.json() as Array<Record<string, unknown>>
    const planned = rows.find(row => row.projectName === 'planned')!
    const plain = rows.find(row => row.projectName === 'plainco')!
    expect(planned).toMatchObject({ status: 'queued', dispatchModes: { claude: 'batch', openai: 'batch' } })
    expect(plain).toMatchObject({ status: 'error', errorCode: 'VALIDATION_ERROR' })
    expect(plain.error).toContain('claude: the project has no published measurement plan')
    expect(db.select().from(runs).all()).toHaveLength(1)
  })

  it('rejects an unknown dispatch mode before touching any project', async () => {
    await seedPortfolio('simple', 'planned')

    const response = await inject('POST', '/api/v1/runs', { dispatchMode: 'flex' })

    expect(response.statusCode).toBe(400)
    expect(db.select().from(runs).all()).toEqual([])
  })
})

describe('run DTO', () => {
  it('reports frozen modes on a plan run, {} when every provider ran sync', async () => {
    await seedPortfolio('simple')

    const sync = await inject('POST', '/api/v1/projects/planned/runs')
    expect(sync.json().dispatchModes).toEqual({})
    db.update(runs).set({ status: 'completed' }).where(eq(runs.id, sync.json().id)).run()

    const batch = await inject('POST', '/api/v1/projects/planned/runs', { dispatchMode: 'batch' })
    const detail = (await inject('GET', `/api/v1/runs/${batch.json().id}`)).json()
    expect(detail).toMatchObject({ dispatchModes: { claude: 'batch', openai: 'batch' }, providerBatches: [], usage: [] })
  })
})

function insertBatch(runId: string, projectId: string, overrides: Partial<typeof providerBatches.$inferInsert> = {}): string {
  const id = overrides.id ?? crypto.randomUUID()
  db.insert(providerBatches).values({
    id,
    projectId,
    runId,
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    status: 'submitted',
    requestCount: 2,
    quotaScope: `${projectId}:claude`,
    quotaPeriod: '2026-09-24',
    quotaReserved: 2,
    deadlineAt: '2026-09-25T00:00:05.000Z',
    submittedAt: '2026-09-24T00:00:05.000Z',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }).run()
  return id
}

function snapshotUsage(overrides: Partial<SnapshotUsage>): SnapshotUsage {
  return {
    inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searchCount: 0,
    pricingTier: 'standard', estimatedCostMicros: 0, priceSource: 'default', ...overrides,
  }
}

describe('run detail: provider batches and usage', () => {
  it('lists the run\'s batches oldest first with their state', async () => {
    const projectId = await seedPortfolio('advanced')
    const { runId } = queue(projectId, { trigger: 'manual', dispatchMode: 'batch' })
    insertBatch(runId, projectId, { id: 'later', provider: 'openai', model: 'gpt-5.4', createdAt: '2026-09-24T00:00:02.000Z' })
    insertBatch(runId, projectId, {
      id: 'first', createdAt: '2026-09-24T00:00:01.000Z', status: 'ingested', ingestedCount: 2, recordedCount: 1,
      endedAt: '2026-09-24T01:00:00.000Z', error: '1 line errored',
    })

    const detail = (await inject('GET', `/api/v1/runs/${runId}`)).json()

    expect(detail.providerBatches).toEqual([
      {
        id: 'first', provider: 'claude', model: 'claude-sonnet-4-6', status: 'ingested', requestCount: 2,
        ingestedCount: 2, recordedCount: 1, submittedAt: '2026-09-24T00:00:05.000Z', endedAt: '2026-09-24T01:00:00.000Z',
        deadlineAt: '2026-09-25T00:00:05.000Z', error: '1 line errored',
      },
      {
        id: 'later', provider: 'openai', model: 'gpt-5.4', status: 'submitted', requestCount: 2,
        ingestedCount: 0, recordedCount: 0, submittedAt: '2026-09-24T00:00:05.000Z', endedAt: null,
        deadlineAt: '2026-09-25T00:00:05.000Z', error: null,
      },
    ])
  })

  it('sums usage exactly per provider and tier, skipping rows without usage and pricing only priced rows', async () => {
    const projectId = await seedPortfolio('simple')
    const { runId } = queue(projectId, { trigger: 'manual' })
    const batchId = insertBatch(runId, projectId, { status: 'ingested' })
    const rows: Array<{ provider: string; usage: SnapshotUsage | null; dispatchMode?: 'sync' | 'batch' }> = [
      { provider: 'claude', dispatchMode: 'batch', usage: snapshotUsage({ inputTokens: 1000, cachedInputTokens: 200, cacheWriteTokens: 50, outputTokens: 300, searchCount: 2, pricingTier: 'batch', estimatedCostMicros: 21_000 }) },
      { provider: 'claude', dispatchMode: 'batch', usage: snapshotUsage({ inputTokens: 1500, outputTokens: 450, searchCount: 3, pricingTier: 'batch', estimatedCostMicros: 32_125 }) },
      { provider: 'claude', dispatchMode: 'sync', usage: snapshotUsage({ inputTokens: 900, outputTokens: 100, searchCount: 1, estimatedCostMicros: 14_200 }) },
      { provider: 'claude', usage: null },
      { provider: 'openai', dispatchMode: 'sync', usage: snapshotUsage({ inputTokens: 800, outputTokens: 120, searchCount: 1, estimatedCostMicros: 12_000 }) },
      { provider: 'openai', dispatchMode: 'sync', usage: snapshotUsage({ inputTokens: 700, outputTokens: 80, estimatedCostMicros: null, priceSource: null }) },
    ]
    for (const [index, row] of rows.entries()) {
      db.insert(querySnapshots).values({
        id: `snap-${index}`, runId, queryText: 'widget pricing', provider: row.provider, citationState: 'not-cited',
        usage: row.usage, dispatchMode: row.dispatchMode ?? null,
        providerBatchId: row.dispatchMode === 'batch' ? batchId : null,
        stopReason: row.usage ? 'end_turn' : null, createdAt: NOW,
      }).run()
    }

    const detail = (await inject('GET', `/api/v1/runs/${runId}`)).json()

    expect(detail.usage).toEqual([
      { provider: 'claude', pricingTier: 'standard', answers: 1, inputTokens: 900, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, searchCount: 1, estimatedCostMicros: 14_200, unpricedAnswers: 0 },
      { provider: 'claude', pricingTier: 'batch', answers: 2, inputTokens: 2500, cachedInputTokens: 200, cacheWriteTokens: 50, outputTokens: 750, searchCount: 5, estimatedCostMicros: 53_125, unpricedAnswers: 0 },
      { provider: 'openai', pricingTier: 'standard', answers: 2, inputTokens: 1500, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200, searchCount: 1, estimatedCostMicros: 12_000, unpricedAnswers: 1 },
    ])
    const snapshots = detail.snapshots as Array<Record<string, unknown>>
    expect(snapshots.find(snapshot => snapshot.id === 'snap-0')).toMatchObject({ dispatchMode: 'batch', stopReason: 'end_turn', usage: rows[0]!.usage })
    expect(snapshots.find(snapshot => snapshot.id === 'snap-3')).toMatchObject({ dispatchMode: null, stopReason: null, usage: null })
  })

  it('reports empty batches and usage for a run that recorded neither', async () => {
    await seedProject('plainco')
    const triggered = (await inject('POST', '/api/v1/projects/plainco/runs')).json()
    const detail = (await inject('GET', `/api/v1/runs/${triggered.id}`)).json()
    expect(detail).toMatchObject({ providerBatches: [], usage: [] })
  })
})

describe.each(['simple', 'advanced'] as const)('fill age window (%s portfolio)', (portfolio) => {
  const STARTED = '2026-09-24T00:00:02.000Z'
  const FINISHED = '2026-09-24T20:00:00.000Z'
  const DAY = 24 * 60 * 60 * 1000
  const at = (iso: string, offsetMs: number) => new Date(Date.parse(iso) + offsetMs)

  async function partialRun(finishedAt: string | null = FINISHED) {
    const projectId = await seedPortfolio(portfolio)
    const { runId } = queue(projectId, { trigger: 'scheduled' })
    db.update(runs).set({ status: 'partial', startedAt: STARTED, finishedAt }).where(eq(runs.id, runId)).run()
    return { projectId, runId }
  }

  it('measures an ordinary run from its start, to the millisecond', async () => {
    const { runId } = await partialRun()
    expect(evaluateRunFill(db, runRow(runId), { now: at(STARTED, DAY) }).kind).toBe('fillable')
    const refused = evaluateRunFill(db, runRow(runId), { now: at(STARTED, DAY + 1) })
    expect(refused).toMatchObject({ kind: 'refused', code: 'too_old' })
    expect(refused.kind === 'refused' && refused.message).toContain('started more than 24 hours ago')
  })

  it('measures a run that dispatched a provider batch from its finish, to the millisecond', async () => {
    const { projectId, runId } = await partialRun()
    insertBatch(runId, projectId, { status: 'ingested' })

    expect(evaluateRunFill(db, runRow(runId), { now: at(STARTED, DAY + 1) }).kind).toBe('fillable')
    expect(evaluateRunFill(db, runRow(runId), { now: at(FINISHED, DAY) }).kind).toBe('fillable')
    const refused = evaluateRunFill(db, runRow(runId), { now: at(FINISHED, DAY + 1) })
    expect(refused).toMatchObject({ kind: 'refused', code: 'too_old' })
    expect(refused.kind === 'refused' && refused.message).toContain('finished more than 24 hours ago')
  })

  it('falls back to the start for a batch run with no finish time', async () => {
    const { projectId, runId } = await partialRun(null)
    insertBatch(runId, projectId, { status: 'ingested' })
    expect(evaluateRunFill(db, runRow(runId), { now: at(STARTED, DAY) }).kind).toBe('fillable')
    expect(evaluateRunFill(db, runRow(runId), { now: at(STARTED, DAY + 1) })).toMatchObject({ kind: 'refused', code: 'too_old' })
  })
})
