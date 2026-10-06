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
  parseMeasurementRunManifestV1,
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
  projects,
  queries,
  querySnapshots,
  runFills,
  sentimentCompletionReceipts,
  runs,
  usageCounters,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { ProviderRegistry } from '../src/provider-registry.js'

const NOW = '2026-08-01T00:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const MODELS = { openai: 'gpt-planned', gemini: 'gemini-planned' }

/** A published v2 revision: `count` questions for one Property, each answered by every provider. */
function plan(count: number, models: Record<string, string> = MODELS, providers: readonly string[] = ['openai', 'gemini'], queryPrefix = ''): MeasurementPlanV2 {
  const questions = Array.from({ length: count }, (_, index) => ({ id: `${queryPrefix}q-${index + 1}`, text: `widget question ${index + 1}` }))
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
      context: { providers: [...providers], models, location: NORTH },
      expectedSnapshots: providers.length,
    })),
    usageEdges: questions.map((q, index) => ({ executionNodeKey: `exec-${index + 1}`, targetKey: 'property-001', queryId: q.id })),
    compiledChecksum: '0'.repeat(64),
  }
  return { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
}

function testDb(): DatabaseClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-fill-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  return db
}

function seed(
  count: number, models?: Record<string, string>, providers?: readonly string[],
  peer?: { db: DatabaseClient; name: string },
): { db: DatabaseClient; projectId: string } {
  const db = peer?.db ?? testDb()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: peer?.name ?? 'planned', displayName: 'Planned Co', canonicalDomain: 'example.com', aliases: ['Planned Co'],
    country: 'US', language: 'en', providers: [], locations: [NORTH], createdAt: NOW, updatedAt: NOW,
  }).run()
  const revision = plan(count, models, providers, peer ? `${peer.name}-` : '')
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

function registry(adapters: readonly ProviderAdapter[], maxRequestsPerDay = 1000, maxRequestsPerMinute = 6000): ProviderRegistry {
  const r = new ProviderRegistry()
  for (const a of adapters) {
    r.register(a, { provider: a.name, apiKey: 'test-key', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute, maxRequestsPerDay } })
  }
  return r
}

const runRow = (db: DatabaseClient, id: string) => db.select().from(runs).where(eq(runs.id, id)).get()!
const answered = (db: DatabaseClient, id: string, provider: string) =>
  db.select().from(querySnapshots).where(eq(querySnapshots.runId, id)).all().filter(row => row.provider === provider).length

/** A finished sweep in which the first provider (openai) failed every call and the other answered everything. */
async function partialSweep(count: number, models?: Record<string, string>, providers: readonly [string, string] = ['openai', 'gemini']) {
  const { db, projectId } = seed(count, models, providers)
  const queued = queueRunIfProjectIdle(db, { projectId })
  if (queued.conflict) throw new Error('unexpected conflict')
  await new JobRunner(db, registry([adapter(providers[0], [], () => true), adapter(providers[1], [])])).executeRun(queued.runId, projectId)
  expect(runRow(db, queued.runId).status).toBe('partial')
  return { db, projectId, runId: queued.runId }
}

/** Native frozen queue inputs plus already stored Gemini answers; no upstream budget is spent by setup. */
function storedPartial(db: DatabaseClient, projectId: string, createdAt = new Date().toISOString()): string {
  const queued = queueRunIfProjectIdle(db, { projectId, createdAt })
  if (queued.conflict) throw new Error(`unexpected active sweep ${queued.activeRunId}`)
  const manifest = parseMeasurementRunManifestV1(runRow(db, queued.runId).measurementManifest)
  const projectQueries = db.select().from(queries).where(eq(queries.projectId, projectId)).all()
  for (const slot of manifest.expectedSlots.filter(slot => slot.provider === 'gemini')) {
    const query = projectQueries.find(query => query.query === slot.queryText)
    if (!query) throw new Error(`untracked query ${slot.queryText}`)
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId: queued.runId, queryId: query.id, queryText: slot.queryText,
      provider: 'gemini', measurementExecutionId: slot.executionId, requestedContext: slot.context,
      location: slot.context?.label ?? null, citationState: 'not-cited', answerMentioned: false,
      citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], rawResponse: '{}', createdAt,
    }).run()
  }
  db.update(runs).set({ status: 'partial', startedAt: createdAt, finishedAt: createdAt }).where(eq(runs.id, queued.runId)).run()
  return queued.runId
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
    expect(db.select().from(sentimentCompletionReceipts).where(eq(sentimentCompletionReceipts.runId, runId)).all()).toMatchObject([{ completionKey: admitted.fill.id, fillOrigin: admitted.fill.id }])
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

    publish(db, projectId, plan(3), 2)
    expect(evaluateRunFill(db, run())).toMatchObject({ kind: 'refused', code: 'plan_revision_changed' })
  })

  it('refuses a missing answer with no frozen model instead of silently using today\'s', async () => {
    const { db, runId } = await partialSweep(2, {})
    expect(evaluateRunFill(db, runRow(db, runId))).toMatchObject({ kind: 'refused', code: 'model_not_frozen' })
  })

  describe('a run measured on a model the provider has since retired', () => {
    const SONAR_ERA = { perplexity: 'sonar', gemini: 'gemini-planned' }
    const sonarEraSweep = () => partialSweep(2, SONAR_ERA, ['perplexity', 'gemini'])
    const stampIdentity = (db: DatabaseClient, runId: string, models: Record<string, string>) => {
      const identity = runRow(db, runId).measurementExecutionIdentity!
      db.update(runs).set({ measurementExecutionIdentity: { ...identity, models } }).where(eq(runs.id, runId)).run()
    }

    it('refuses to fill it, before anything is dispatched', async () => {
      const { db, runId } = await sonarEraSweep()
      // Queued before the switch, the identity recorded the retired id itself.
      stampIdentity(db, runId, SONAR_ERA)

      const refused = { kind: 'refused', code: 'model_retired' }
      expect(evaluateRunFill(db, runRow(db, runId))).toMatchObject(refused)
      expect(queueRunFill(db, runId)).toMatchObject(refused)
      expect(readRunCompleteness(db, runRow(db, runId))).toMatchObject({ fillable: false, refusal: { code: 'model_retired' } })
      expect(db.select().from(runFills).all()).toHaveLength(0)
    })

    it('refuses a mixed-model run, whose earlier identity left the engine out, by its frozen slots', async () => {
      const { db, runId } = await sonarEraSweep()
      stampIdentity(db, runId, { gemini: 'gemini-planned' })
      expect(evaluateRunFill(db, runRow(db, runId))).toMatchObject({ kind: 'refused', code: 'model_retired' })
    })

    it('still fills a run of the same revision queued since the switch', async () => {
      const { db, runId } = await sonarEraSweep()
      // The run queue now records the engine that answers.
      expect(runRow(db, runId).measurementExecutionIdentity!.models).toEqual({ gemini: 'gemini-planned', perplexity: 'fast' })
      expect(evaluateRunFill(db, runRow(db, runId))).toMatchObject({ kind: 'fillable', providers: ['perplexity'] })
    })

    it('does not refuse a provider that has nothing to fill', async () => {
      const { db, runId } = await partialSweep(2, { openai: 'gpt-planned', perplexity: 'sonar' }, ['openai', 'perplexity'])
      stampIdentity(db, runId, { openai: 'gpt-planned', perplexity: 'sonar' })
      expect(evaluateRunFill(db, runRow(db, runId))).toMatchObject({ kind: 'fillable', providers: ['openai'] })
    })
  })

  it('admits one fill per project across eligible runs, while other projects remain independent', () => {
    const { db, projectId } = seed(2)
    const runId = storedPartial(db, projectId)
    expect(readRunCompleteness(db, runRow(db, runId))).toMatchObject({ expected: 4, executed: 2, missing: 2, fillable: true })
    const first = queueRunFill(db, runId)
    if (first.kind !== 'queued') throw new Error(first.kind)
    expect(queueRunFill(db, runId)).toEqual({ kind: 'fill-in-progress', fillId: first.fill.id })

    // Sweeps stay admissible during a fill; the newer partial is not superseded.
    const newer = storedPartial(db, projectId, new Date(Date.parse(runRow(db, runId).createdAt) + 1000).toISOString())
    expect(evaluateRunFill(db, runRow(db, newer))).toMatchObject({ kind: 'fillable', providers: ['openai'] })
    expect(queueRunFill(db, newer)).toEqual({ kind: 'fill-in-progress', fillId: first.fill.id })

    const peer = seed(1, undefined, undefined, { db, name: 'lock-peer' })
    const peerRun = storedPartial(db, peer.projectId)
    expect(evaluateRunFill(db, runRow(db, peerRun))).toMatchObject({ kind: 'fillable', providers: ['openai'] })
    expect(queueRunFill(db, peerRun)).toMatchObject({ kind: 'queued', fill: { projectId: peer.projectId, runId: peerRun, expected: 1 } })
    expect(db.select().from(runFills).all()).toHaveLength(2)

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
    expect(db.select().from(sentimentCompletionReceipts).where(eq(sentimentCompletionReceipts.runId, runId)).all()).toHaveLength(1)
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

  it('reports an unreadable manifest as unknown, not as nothing missing', async () => {
    const { db, runId } = await partialSweep(2)
    db.update(runs).set({ measurementManifest: { schemaVersion: 99 } as unknown as Record<string, unknown> }).where(eq(runs.id, runId)).run()
    expect(readRunCompleteness(db, runRow(db, runId))).toMatchObject({ readable: false, fillable: false, refusal: { code: 'manifest_unreadable' } })
  })
})

describe('second review follow-ups', () => {
  it('a stopped fill preserves timely dispatch capacity for another project', async () => {
    resetSharedProviderExecutionGates()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'))
    const started = Date.now()
    let fillTask: Promise<void> | undefined
    let peerTask: Promise<void> | undefined
    try {
      const { db, projectId } = seed(8)
      const runId = storedPartial(db, projectId)
      expect(readRunCompleteness(db, runRow(db, runId))).toMatchObject({
        planned: true, readable: true, expected: 16, executed: 8, missing: 8, missingByProvider: { openai: 8 }, fillable: true,
      })
      const admitted = queueRunFill(db, runId)
      if (admitted.kind !== 'queued') throw new Error(admitted.kind)
      const calls: Call[] = []
      const fillTimes: number[] = []
      const failedProvider = adapter('openai', calls, () => { fillTimes.push(Date.now() - started); return true })
      let fillSettled = false
      fillTask = new JobRunner(db, registry([failedProvider], 1000, 4)).executeRunFill(admitted.fill.id)
        .then(() => { fillSettled = true })
      await vi.advanceTimersByTimeAsync(0)

      const peer = seed(1, { openai: 'gpt-planned' }, ['openai'], { db, name: 'budget-peer' })
      const queued = queueRunIfProjectIdle(db, { projectId: peer.projectId })
      if (queued.conflict) throw new Error('unexpected peer sweep conflict')
      const peerCalls: Call[] = []
      const peerTimes: number[] = []
      const peerProvider = adapter('openai', peerCalls)
      const timedPeer: ProviderAdapter = {
        ...peerProvider,
        async executeTrackedQuery(input, config) {
          peerTimes.push(Date.now() - started)
          return peerProvider.executeTrackedQuery(input, config)
        },
      }
      peerTask = new JobRunner(db, registry([timedPeer], 1000, 4)).executeRun(queued.runId, peer.projectId)
      await vi.advanceTimersByTimeAsync(59_999)

      // Three failed calls used three tokens; the peer still gets the fourth in this minute.
      expect(peerTimes).toEqual([0])
      expect(fillTimes).toEqual([0, 0, 0])
      expect(fillSettled).toBe(true)
      expect(calls.map(call => ({ provider: call.provider, model: call.model }))).toEqual([
        { provider: 'openai', model: 'gpt-planned' }, { provider: 'openai', model: 'gpt-planned' }, { provider: 'openai', model: 'gpt-planned' },
      ])
      expect(peerCalls).toEqual([{ provider: 'openai', query: 'widget question 1', model: 'gpt-planned' }])
      expect(runRow(db, runId).status).toBe('partial')
      expect(parseRunError(runRow(db, runId).error)?.providers?.openai?.message).toMatch(/monthly spend limit/)
      expect(db.select().from(runFills).where(eq(runFills.id, admitted.fill.id)).get()).toMatchObject({ status: 'failed', filled: 0 })
      expect(runRow(db, queued.runId).status).toBe('completed')
      expect(answered(db, queued.runId, 'openai')).toBe(1)
      expect(db.select({ period: usageCounters.period, metric: usageCounters.metric, count: usageCounters.count }).from(usageCounters)
        .where(eq(usageCounters.scope, `${projectId}:openai`)).all()).toEqual([{ period: '2026-10-05', metric: 'queries', count: 3 }])
      expect(db.select({ period: usageCounters.period, metric: usageCounters.metric, count: usageCounters.count }).from(usageCounters)
        .where(eq(usageCounters.scope, `${peer.projectId}:openai`)).all()).toEqual([{ period: '2026-10-05', metric: 'queries', count: 1 }])
    } finally {
      // Release pending fault-probe work only after the bounded dispatch assertions.
      await vi.runAllTimersAsync()
      await Promise.all([fillTask, peerTask])
      vi.useRealTimers()
      resetSharedProviderExecutionGates()
    }
  })

  it('stops paying for calls once its run is cleared underneath it', async () => {
    const { db, runId } = await partialSweep(4)
    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(admitted.kind)
    const calls: Call[] = []
    const clearing: ProviderAdapter = {
      ...adapter('openai', calls),
      async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
        const result = await adapter('openai', calls).executeTrackedQuery(input, config)
        // The run (and, by cascade, the fill attempt) is deleted while this call is in flight.
        if (calls.length === 2) db.delete(runs).where(eq(runs.id, runId)).run()
        return result
      },
    }
    await new JobRunner(db, registry([clearing, adapter('gemini', [])])).executeRunFill(admitted.fill.id)
    expect(calls).toHaveLength(2)
  })

  it('refuses to clear a run a fill is still working on', async () => {
    const { db, runId } = await partialSweep(2)
    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(admitted.kind)
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
      return reply.status(500).send(error)
    })
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
    onTestFinished(() => app.close())
    const cleared = await app.inject({ method: 'POST', url: '/api/v1/projects/planned/results/clear', payload: { runIds: [runId], researchRunIds: [], confirm: true } })
    expect(cleared.statusCode).toBe(409)
    expect(cleared.json().error).toMatchObject({ code: 'RUN_FILL_IN_PROGRESS', details: { fillId: admitted.fill.id } })
    expect(runRow(db, runId)).toBeTruthy()
  })
})
