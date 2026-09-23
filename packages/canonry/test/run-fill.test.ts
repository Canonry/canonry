import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  AppError,
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  parseRunError,
  type LocationContext,
  type MeasurementPlanV2,
  type NormalizedQueryResult,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderHealthcheckResult,
  type RawQueryResult,
  type TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { apiRoutes, evaluateRunFill, queueRunFill, queueRunIfProjectIdle, readRunCompleteness } from '@ainyc/canonry-api-routes'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  notifications,
  projects,
  queries,
  querySnapshots,
  runFills,
  runs,
  usageCounters,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { Notifier } from '../src/notifier.js'
import { ProviderRegistry } from '../src/provider-registry.js'

const NOW = '2026-08-01T00:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const MODELS = { openai: 'gpt-planned', gemini: 'gemini-planned' }

/** A published v2 revision: `count` questions for one Property, each answered by every provider. */
function plan(count: number, models: Record<string, string> = MODELS): MeasurementPlanV2 {
  const questions = Array.from({ length: count }, (_, index) => ({ id: `q-${index + 1}`, text: `widget question ${index + 1}` }))
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Planned Co'] } },
    targets: [{
      stableKey: 'property-001',
      label: 'property-001',
      aliases: ['property-001'],
      urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/property-001', pathCase: 'insensitive' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    }],
    groups: [],
    querySnapshots: questions.map(q => ({ queryId: q.id, queryText: q.text, provenance: { source: 'manual', sourceId: null, capturedAt: NOW } })),
    assignments: questions.map((q, index) => ({ targetKey: 'property-001', queryId: q.id, queryClass: 'non-brand', executionNodeKey: `exec-${index + 1}` })),
    executionNodes: questions.map((q, index) => ({
      stableKey: `exec-${index + 1}`,
      queryId: q.id,
      queryText: q.text,
      context: { providers: ['openai', 'gemini'], models, location: NORTH },
      expectedSnapshots: 2,
    })),
    usageEdges: questions.map((q, index) => ({ executionNodeKey: `exec-${index + 1}`, targetKey: 'property-001', queryId: q.id })),
    compiledChecksum: '0'.repeat(64),
  }
  return { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
}

function seed(count: number, models?: Record<string, string>): { db: DatabaseClient; projectId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-fill-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'planned', displayName: 'Planned Co', canonicalDomain: 'example.com', aliases: ['Planned Co'],
    country: 'US', language: 'en', providers: [], locations: [NORTH], createdAt: NOW, updatedAt: NOW,
  }).run()
  const revision = plan(count, models)
  for (const q of revision.querySnapshots) db.insert(queries).values({ id: q.queryId, projectId, query: q.queryText, createdAt: NOW }).run()
  publish(db, projectId, revision, 1)
  return { db, projectId }
}

function publish(db: DatabaseClient, projectId: string, revision: MeasurementPlanV2, number: number): string {
  const canonicalJson = canonicalMeasurementPlanV2Json(revision)
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId, projectId, revision: number, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    schemaVersion: 2, compiledChecksum: revision.compiledChecksum, createdAt: NOW,
  }).run()
  const existing = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()
  if (existing) db.update(measurementPlans).set({ activeVersionId: versionId, updatedAt: NOW }).where(eq(measurementPlans.projectId, projectId)).run()
  else db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  return versionId
}

type Call = { provider: string; query: string; model: string | undefined }

function adapter(name: string, calls: Call[], fails: () => boolean = () => false): ProviderAdapter {
  return {
    name,
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult { return { ok: true, provider: name, message: 'ok' } },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> { return { ok: true, provider: name, message: 'ok' } },
    async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
      calls.push({ provider: name, query: input.query, model: config.model })
      if (fails()) throw new Error(`400 ${name} monthly spend limit reached`)
      return { provider: name, rawResponse: {}, model: config.model ?? 'fake', groundingSources: [], searchQueries: [], retrievalStatus: 'used', retrievalContract: 'search-required-v1' }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return { provider: name, answerText: 'Planned Co is a good pick.', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'used' }
    },
    async generateText(): Promise<string> { return 'fake' },
  }
}

function registry(adapters: readonly ProviderAdapter[], maxRequestsPerDay = 1000): ProviderRegistry {
  const r = new ProviderRegistry()
  for (const a of adapters) {
    r.register(a, { provider: a.name, apiKey: 'test-key', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 6000, maxRequestsPerDay } })
  }
  return r
}

const runRow = (db: DatabaseClient, id: string) => db.select().from(runs).where(eq(runs.id, id)).get()!
const answered = (db: DatabaseClient, id: string, provider: string) =>
  db.select().from(querySnapshots).where(eq(querySnapshots.runId, id)).all().filter(row => row.provider === provider).length

/** A finished sweep in which openai failed every call and gemini answered everything. */
async function partialSweep(count: number, models?: Record<string, string>) {
  const { db, projectId } = seed(count, models)
  const queued = queueRunIfProjectIdle(db, { projectId })
  if (queued.conflict) throw new Error('unexpected conflict')
  await new JobRunner(db, registry([adapter('openai', [], () => true), adapter('gemini', [])])).executeRun(queued.runId, projectId)
  expect(runRow(db, queued.runId).status).toBe('partial')
  return { db, projectId, runId: queued.runId }
}

describe('filling a partial run in place', () => {
  it('records only the missing answers under the same run id, then completes the run once', async () => {
    const { db, projectId, runId } = await partialSweep(4)
    const before = runRow(db, runId)
    expect(answered(db, runId, 'gemini')).toBe(4)
    expect(answered(db, runId, 'openai')).toBe(0)

    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(`expected queued, got ${admitted.kind}`)
    expect(admitted.fill).toMatchObject({ runId, providers: ['openai'], expected: 4, status: 'queued' })

    const calls: Call[] = []
    const runner = new JobRunner(db, registry([adapter('openai', calls), adapter('gemini', calls)]))
    const completed = vi.fn(async () => {})
    runner.onRunCompleted = completed
    await runner.executeRunFill(admitted.fill.id)

    // Only the four missing openai answers were paid for; gemini was not asked again.
    expect(calls.map(call => call.provider)).toEqual(['openai', 'openai', 'openai', 'openai'])
    // The frozen model answered, not whatever the provider defaults to today.
    expect(new Set(calls.map(call => call.model))).toEqual(new Set(['gpt-planned']))
    const after = runRow(db, runId)
    expect(after.status).toBe('completed')
    expect(after.error).toBeNull()
    // Still the same sweep: identity and timestamps untouched, no second run.
    expect({ createdAt: after.createdAt, startedAt: after.startedAt, finishedAt: after.finishedAt })
      .toEqual({ createdAt: before.createdAt, startedAt: before.startedAt, finishedAt: before.finishedAt })
    expect(db.select().from(runs).all()).toHaveLength(1)
    expect(answered(db, runId, 'openai')).toBe(4)
    expect(db.select().from(runFills).where(eq(runFills.id, admitted.fill.id)).get()).toMatchObject({ status: 'completed', filled: 4, error: null })
    // The held-back post-run pipeline runs exactly once, now that the run is whole.
    expect(completed).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledWith(runId, projectId, { origin: 'fill' })
    expect(readRunCompleteness(db, after)).toMatchObject({ status: 'completed', expected: 8, executed: 8, missing: 0 })
  })

  it('stops a provider after three consecutive failures and leaves the run partial and honest', async () => {
    const { db, runId } = await partialSweep(6)
    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(admitted.kind)

    const calls: Call[] = []
    const runner = new JobRunner(db, registry([adapter('openai', calls, () => true), adapter('gemini', calls)]))
    const completed = vi.fn(async () => {})
    runner.onRunCompleted = completed
    await runner.executeRunFill(admitted.fill.id)

    expect(calls).toHaveLength(3)
    expect(runRow(db, runId).status).toBe('partial')
    expect(parseRunError(runRow(db, runId).error)?.providers?.openai?.message).toMatch(/monthly spend limit/)
    expect(db.select().from(runFills).where(eq(runFills.id, admitted.fill.id)).get()).toMatchObject({ status: 'failed', filled: 0 })
    expect(completed).not.toHaveBeenCalled()
  })

  it('a later fill picks up exactly what an earlier one left missing', async () => {
    const { db, runId } = await partialSweep(4)
    let calls = 0
    const first = queueRunFill(db, runId)
    if (first.kind !== 'queued') throw new Error(first.kind)
    // Two answers succeed, then the provider fails three times in a row.
    await new JobRunner(db, registry([adapter('openai', [], () => ++calls > 2), adapter('gemini', [])])).executeRunFill(first.fill.id)
    expect(answered(db, runId, 'openai')).toBe(2)
    expect(runRow(db, runId).status).toBe('partial')
    expect(db.select().from(runFills).where(eq(runFills.id, first.fill.id)).get()).toMatchObject({ status: 'partial', filled: 2 })

    const second = queueRunFill(db, runId)
    if (second.kind !== 'queued') throw new Error(second.kind)
    expect(second.fill.expected).toBe(2)
    const secondCalls: Call[] = []
    await new JobRunner(db, registry([adapter('openai', secondCalls), adapter('gemini', [])])).executeRunFill(second.fill.id)
    expect(secondCalls).toHaveLength(2)
    expect(runRow(db, runId).status).toBe('completed')
  })

  it('yields to a newer sweep instead of writing behind it', async () => {
    const { db, projectId, runId } = await partialSweep(3)
    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(admitted.kind)
    db.insert(runs).values({
      id: crypto.randomUUID(), projectId, kind: 'answer-visibility', status: 'completed', trigger: 'scheduled',
      createdAt: new Date(Date.parse(runRow(db, runId).createdAt) + 1000).toISOString(),
    }).run()

    const calls: Call[] = []
    await new JobRunner(db, registry([adapter('openai', calls), adapter('gemini', calls)])).executeRunFill(admitted.fill.id)
    expect(calls).toHaveLength(0)
    expect(runRow(db, runId).status).toBe('partial')
    expect(db.select().from(runFills).where(eq(runFills.id, admitted.fill.id)).get()?.error).toMatch(/newer sweep/)
  })

  it('a restart fails an in-flight fill and never touches its parent run', async () => {
    const { db, runId } = await partialSweep(2)
    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(admitted.kind)
    db.update(runFills).set({ status: 'running' }).where(eq(runFills.id, admitted.fill.id)).run()

    new JobRunner(db, registry([])).recoverStaleRuns()
    expect(db.select().from(runFills).where(eq(runFills.id, admitted.fill.id)).get()).toMatchObject({ status: 'failed', error: 'Server restarted while the fill was in progress' })
    expect(runRow(db, runId).status).toBe('partial')
    // The attempt is closed, so a new fill is admitted.
    expect(queueRunFill(db, runId).kind).toBe('queued')
  })

  it('an error path never flips a finished run to failed', async () => {
    const { db, projectId, runId } = await partialSweep(2)
    await new JobRunner(db, registry([])).executeRun(runId, projectId)
    expect(runRow(db, runId).status).toBe('partial')
  })
})

describe('fill admission', () => {
  it('refuses the rules an operator cannot retry past, by code', async () => {
    const { db, projectId, runId } = await partialSweep(2)
    const run = () => runRow(db, runId)

    expect(evaluateRunFill(db, run(), { providers: ['gemini'] })).toMatchObject({ kind: 'refused', code: 'provider_nothing_missing' })
    expect(evaluateRunFill(db, run(), { providers: ['claude'] })).toMatchObject({ kind: 'refused', code: 'provider_not_in_plan' })
    expect(evaluateRunFill(db, run(), { runnableProviders: ['gemini'] })).toMatchObject({ kind: 'refused', code: 'provider_not_configured' })
    const tooLate = new Date(Date.parse(run().startedAt ?? run().createdAt) + 25 * 60 * 60 * 1000)
    expect(evaluateRunFill(db, run(), { now: tooLate })).toMatchObject({ kind: 'refused', code: 'too_old' })

    publish(db, projectId, plan(3), 2)
    expect(evaluateRunFill(db, run())).toMatchObject({ kind: 'refused', code: 'plan_revision_changed' })
  })

  it('refuses a missing answer with no frozen model instead of silently using today\'s', async () => {
    const { db, runId } = await partialSweep(2, {})
    expect(evaluateRunFill(db, runRow(db, runId))).toMatchObject({ kind: 'refused', code: 'model_not_frozen' })
  })

  it('admits one fill per project at a time, and reports a complete run as complete', async () => {
    const { db, runId } = await partialSweep(2)
    const first = queueRunFill(db, runId)
    expect(first.kind).toBe('queued')
    expect(queueRunFill(db, runId)).toMatchObject({ kind: 'fill-in-progress' })

    db.update(runs).set({ status: 'completed' }).where(eq(runs.id, runId)).run()
    expect(evaluateRunFill(db, runRow(db, runId)).kind).toBe('already-complete')
  })
})

describe('POST /runs/:id/fill', () => {
  it('queues, dry-runs and refuses over HTTP with the documented codes', async () => {
    const { db, runId } = await partialSweep(2)
    const onRunFillCreated = vi.fn()
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
      return reply.status(500).send(error)
    })
    await app.register(apiRoutes, { db, skipAuth: true, onRunFillCreated, getRunnableProviderNames: () => ['openai', 'gemini'] })
    await app.ready()
    onTestFinished(() => app.close())

    const dry = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/fill`, payload: { dryRun: true } })
    expect(dry.statusCode).toBe(200)
    expect(dry.json()).toMatchObject({ outcome: 'dry-run', fill: null, completeness: { missing: 2, missingByProvider: { openai: 2 }, fillable: true, refusal: null } })
    expect(onRunFillCreated).not.toHaveBeenCalled()

    const refused = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/fill`, payload: { providers: ['gemini'] } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatchObject({ code: 'RUN_FILL_REFUSED', details: { refusal: 'provider_nothing_missing' } })

    const queued = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/fill`, payload: {} })
    expect(queued.statusCode).toBe(202)
    const body = queued.json()
    expect(body).toMatchObject({ outcome: 'queued', fill: { runId, expected: 2, status: 'queued' } })
    expect(onRunFillCreated).toHaveBeenCalledWith(body.fill.id, runId, expect.any(String))

    const busy = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/fill`, payload: {} })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().error.code).toBe('RUN_FILL_IN_PROGRESS')

    const completeness = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/completeness` })
    expect(completeness.statusCode).toBe(200)
    expect(completeness.json()).toMatchObject({ runId, missing: 2, fillable: false, latestFill: { id: body.fill.id } })

    const unknownField = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/fill`, payload: { force: true } })
    expect(unknownField.statusCode).toBe(400)
  })
})

describe('review follow-ups', () => {
  it('a completion that a sweep overtakes during the last call stays quiet, though the run is whole', async () => {
    const { db, projectId, runId } = await partialSweep(2)
    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(admitted.kind)
    let calls = 0
    const racing: ProviderAdapter = {
      ...adapter('openai', []),
      async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
        // A scheduled sweep is queued while the fill's last answer is in flight.
        if (++calls === 2) {
          db.insert(runs).values({
            id: crypto.randomUUID(), projectId, kind: 'answer-visibility', status: 'queued', trigger: 'scheduled',
            createdAt: new Date(Date.parse(runRow(db, runId).createdAt) + 1000).toISOString(),
          }).run()
        }
        return adapter('openai', []).executeTrackedQuery(input, config)
      },
    }
    const runner = new JobRunner(db, registry([racing, adapter('gemini', [])]))
    const completed = vi.fn(async () => {})
    runner.onRunCompleted = completed
    await runner.executeRunFill(admitted.fill.id)
    expect(runRow(db, runId).status).toBe('completed')
    expect(completed).not.toHaveBeenCalled()
  })

  it('refuses a fill the provider\'s daily quota could not start, naming the fix', async () => {
    const { db, projectId, runId } = await partialSweep(2)
    const period = new Date().toISOString().slice(0, 10)
    db.insert(usageCounters).values({
      id: crypto.randomUUID(), scope: `${projectId}:openai`, period, metric: 'queries', count: 999, updatedAt: NOW,
    }).onConflictDoNothing().run()
    db.update(usageCounters).set({ count: 999 }).where(eq(usageCounters.scope, `${projectId}:openai`)).run()
    const refused = evaluateRunFill(db, runRow(db, runId), { dailyLimits: { openai: 1000, gemini: 1000 } })
    expect(refused).toMatchObject({ kind: 'refused', code: 'quota_insufficient' })
    if (refused.kind === 'refused') expect(refused.message).toMatch(/999 of its 1000.*needs 2.*max-per-day/)
    expect(evaluateRunFill(db, runRow(db, runId), { dailyLimits: { openai: 1001 } }).kind).toBe('fillable')
  })

  it('sends run.completed once: when the sweep ends partial, not again when a fill completes the run', async () => {
    const { db, projectId, runId } = await partialSweep(2)
    db.insert(notifications).values({
      id: crypto.randomUUID(), projectId, channel: 'webhook', enabled: true, createdAt: NOW, updatedAt: NOW,
      config: { url: 'https://hooks.example.test/canonry', events: ['run.completed', 'citation.gained', 'citation.lost'] },
    }).run()
    const notifier = new Notifier(db, 'http://localhost:4100')
    const sent: string[] = []
    vi.spyOn(notifier as unknown as { sendWebhook: (url: string, payload: { event: string }) => Promise<boolean> }, 'sendWebhook')
      .mockImplementation(async (_url, payload) => { sent.push(payload.event); return true })

    await notifier.onRunCompleted(runId, projectId)
    db.update(runs).set({ status: 'completed', error: null }).where(eq(runs.id, runId)).run()
    await notifier.onRunCompleted(runId, projectId, { origin: 'fill' })

    expect(sent.filter(event => event === 'run.completed')).toHaveLength(1)
  })

  it('reports an unreadable manifest as unknown, not as nothing missing', async () => {
    const { db, runId } = await partialSweep(2)
    db.update(runs).set({ measurementManifest: { schemaVersion: 99 } as unknown as Record<string, unknown> }).where(eq(runs.id, runId)).run()
    expect(readRunCompleteness(db, runRow(db, runId))).toMatchObject({ readable: false, fillable: false, refusal: { code: 'manifest_unreadable' } })
  })
})
