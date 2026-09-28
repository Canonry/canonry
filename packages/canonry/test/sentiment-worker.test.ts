import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSimpleMeasurementDefinition, createSentimentEvaluationDefinition, type SentimentClassifierInput, type SentimentClassifierOutput } from '@ainyc/canonry-contracts'
import { createClient, llmUsageEvents, migrate, projects, queries, querySnapshots, recordSentimentCompletion, runs, SentimentRepository, sentimentAttempts, sentimentJobs, sentimentWorkItems, simpleMeasurementDefinitions, type DatabaseClient } from '@ainyc/canonry-db'
import { SentimentService, sentimentHash } from '@ainyc/canonry-api-routes'
import { resolveSentimentInstallConfig } from '@ainyc/canonry-config'
import { SentimentWorker } from '../src/sentiment-worker.js'

let db: DatabaseClient
let service: SentimentService
let enabled = true
let time: string
const now = () => new Date(time)
const configuration = () => resolveSentimentInstallConfig({}, { enabled, apiKey: 'private-test-key', maxConcurrency: 2 })
const classified = (input: SentimentClassifierInput): SentimentClassifierOutput => ({ kind: 'classified', outcome: 'favorable', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 1000, outputTokens: 10 }, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: 0.9 })
beforeEach(() => {
  enabled = true; time = '2026-09-28T00:00:00.000Z'
  db = createClient(':memory:'); migrate(db)
  db.insert(projects).values({ id: 'p', name: 'test', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', createdAt: time, updatedAt: time }).run()
  db.insert(queries).values({ id: 'q', projectId: 'p', query: 'Acme reviews', createdAt: time }).run()
  service = new SentimentService(db, { install: () => ({ enabled, ready: enabled, reason: enabled ? null : 'install-disabled', model: 'jev-1.13.0' }), now, previewSecret: 'secret' })
})
afterEach(() => { db.$client.close() })
function source(id: string, receipt = true, queryText = 'Acme reviews') {
  db.insert(runs).values({ id, projectId: 'p', kind: 'answer-visibility', trigger: 'manual', status: 'completed', createdAt: time }).run()
  db.insert(querySnapshots).values({ id: `s-${id}`, runId: id, queryId: 'q', provider: 'openai', model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Acme is excellent.', citationState: 'cited', createdAt: time }).run()
  db.insert(simpleMeasurementDefinitions).values({ runId: id, projectId: 'p', checksum: 'x', capturedAt: time, definition: buildSimpleMeasurementDefinition({ capturedAt: time, identity: { displayName: 'Acme', aliases: [], canonicalDomain: 'https://Acme.Example/', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'gpt-test' }], queries: [{ queryId: 'q', queryText, provenance: null }] }) }).run()
  if (receipt) recordSentimentCompletion(db, { projectId: 'p', runId: id, completionKey: 'initial', completedAt: time })
}
function worker(classify = vi.fn(async (input: SentimentClassifierInput) => classified(input))) { return { classify, runtime: new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now }) } }

describe('durable sentiment worker', () => {

  it('admits both future query classes and persists absent non-brand preflight without a paid attempt', async () => {
    service.configure('p', { enabled: true }); source('branded'); source('non-brand', true, 'best service options')
    const classify = vi.fn(async (input: SentimentClassifierInput) => classified(input))
    const prepare = vi.fn((input: SentimentClassifierInput) => input.context.queryClass === 'non-brand'
      ? { ok: false as const, outcome: 'subject-not-mentioned' as const, reason: 'Frozen subject absent from this answer.' }
      : { ok: true as const, estimatedInputTokens: 1000 })
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), prepare, now })
    await runtime.tick(); await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify.mock.calls[0]![0].context.queryClass).toBe('branded')
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(1)
    expect(db.select().from(llmUsageEvents).all()).toHaveLength(1)
    expect(service.jobs('p').jobs).toHaveLength(2)
    expect(service.summary('p', { runId: 'non-brand', mode: 'simple', scope: 'project', queryClass: 'non-brand' })).toMatchObject({ state: 'complete', coverage: { selected: 1, judged: 0, counts: { 'subject-not-mentioned': 1, unfavorable: 0 } }, score: { favorableRate: null, favorableDisplay: 'Unavailable' } })
  })
  it('upgrades an enabled legacy evaluator at a new future-completion boundary without automatic historical non-brand work', async () => {
    const old = { ...createSentimentEvaluationDefinition(), schemaVersion: 1, verdictVersion: 'stance-v1', identityVersion: 'qualified-subject-v1', themes: [], questions: { ...createSentimentEvaluationDefinition().questions, theme: 'Archived question' } }
    const repository = new SentimentRepository(db), id = sentimentHash(old)
    repository.putDefinition({ id, contentHash: id, requestedModel: old.requestedModel, definition: old, createdAt: time })
    repository.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: id, configuration: { enabled: true }, now: time })
    source('historic-nonbrand', true, 'best service options')
    const before = service.settings('p')
    const settings = service.configure('p', { enabled: true })
    expect(settings.enablementEpoch).toBe(before.enablementEpoch + 1)
    expect(settings.completionBoundary).toBeGreaterThan(before.completionBoundary)
    const { runtime, classify } = worker()
    await runtime.tick(); expect(classify).not.toHaveBeenCalled()
    source('future-nonbrand', true, 'best service options')
    await runtime.tick(); expect(classify).toHaveBeenCalledTimes(1)
    const preview = service.preview('p', { runId: 'historic-nonbrand', queryClass: 'non-brand' })
    service.submit('p', preview.previewToken!, 'explicit-history', 'operator')
    await runtime.tick(); expect(classify).toHaveBeenCalledTimes(2)
  })

  it('refuses archived evaluator inputs before preparation, attempt reservation, or transmission', async () => {
    service.configure('p', { enabled: true }); source('r')
    const { runtime, classify } = worker(); runtime.reconcile()
    const work = db.select().from(sentimentWorkItems).get()!
    const input = work.input as SentimentClassifierInput
    db.update(sentimentWorkItems).set({ input: { ...input, definition: { ...input.definition, schemaVersion: 1, verdictVersion: 'stance-v1', themes: [], questions: { ...input.definition.questions, theme: 'Archived question' } } } }).where(eq(sentimentWorkItems.id, work.id)).run()
    await runtime.tick()
    expect(classify).not.toHaveBeenCalled()
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(0)
    expect(db.select().from(llmUsageEvents).all()).toHaveLength(0)
    expect(db.select().from(sentimentWorkItems).get()).toMatchObject({ status: 'failed', errorCode: 'UNSUPPORTED_EVALUATOR_DEFINITION' })
  })

  it('records two billed retry attempts while storing one successful assessment', async () => {
    service.configure('p', { enabled: true }); source('r')
    let calls = 0
    const classify = vi.fn(async (input: SentimentClassifierInput): Promise<SentimentClassifierOutput> => ++calls === 1 ? { kind: 'failed', outcome: 'failed', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 1000, outputTokens: 0 }, error: { code: 'RETRYABLE_RESPONSE', message: 'Safe failure', retryable: true, retryAfterMs: 1000 } } : classified(input))
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now })
    await runtime.tick()
    time = '2026-09-28T00:01:00.000Z'
    await runtime.tick(); await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(2)
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(2)
    expect(db.select().from(llmUsageEvents).all()).toHaveLength(2)
    expect(service.jobs('p').jobs[0]).toMatchObject({ selected: 1, state: 'complete', counts: { favorable: 1 } })
  })


  it('does not dispatch beyond the durable attempt budget after repeated crashed attempts', async () => {
    service.configure('p', { enabled: true }); source('r')
    const { runtime, classify } = worker(); runtime.reconcile()
    const repository = new SentimentRepository(db)
    for (let number = 0; number < 3; number++) {
      const work = repository.claim({ owner: `crashed-${number}`, now: time, leaseMs: 1_000 })!
      expect(repository.startAttempt({ workItemId: work.id, owner: `crashed-${number}`, requestedModel: 'jev-1.13.0', now: time })).toBeDefined()
      time = new Date(Date.parse(time) + 2_000).toISOString()
    }
    await runtime.tick()
    expect(classify).not.toHaveBeenCalled()
    expect(service.jobs('p').jobs[0]).toMatchObject({ state: 'failed', counts: { failed: 1 } })
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(3)
    const preview = service.preview('p', { runId: 'r' })
    service.submit('p', preview.previewToken!, 'explicit-retry', 'operator')
    await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(1)
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(4)
  })

  it('makes zero provider calls while either switch is disabled', async () => {
    source('r'); const { runtime, classify } = worker()
    await runtime.tick(); expect(classify).not.toHaveBeenCalled()
    service.configure('p', { enabled: true }); source('future'); enabled = false
    await runtime.tick(); expect(classify).not.toHaveBeenCalled()
  })
  it('admits future completions once, excludes old sources, and records priced generic usage', async () => {
    source('old'); service.configure('p', { enabled: true }); source('future')
    const { runtime, classify } = worker()
    expect(await runtime.tick()).toBe(1)
    await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify.mock.calls[0]![0].definition).toMatchObject({ schemaVersion: 2, verdictVersion: 'stance-v2' })
    expect(Object.keys(classify.mock.calls[0]![0].definition.questions)).toHaveLength(5)
    expect(db.select().from(sentimentJobs).all()).toHaveLength(1)
    expect(db.select().from(llmUsageEvents).get()).toMatchObject({ provider: 'typesafe', feature: 'sentiment', inputTokens: 1000, costMillicents: 4 })
  })
  it('recovers an old source completed by a later fill without callback delivery', async () => {
    source('old-partial', false); service.configure('p', { enabled: true })
    recordSentimentCompletion(db, { projectId: 'p', runId: 'old-partial', completionKey: 'later-fill', completedAt: time, fillOrigin: 'later-fill' })
    const { runtime, classify } = worker(); await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(1)
  })
  it('does not retry after a live install disable or revive old work on reenable', async () => {
    service.configure('p', { enabled: true }); source('r')
    const classify = vi.fn(async (): Promise<SentimentClassifierOutput> => ({ kind: 'failed', outcome: 'failed', returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null }, error: { code: 'TIMEOUT', message: 'Safe error', retryable: true, retryAfterMs: 10_000 } }))
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now })
    await runtime.tick(); expect(classify).toHaveBeenCalledTimes(1)
    enabled = false; time = '2026-09-28T00:01:00.000Z'; await runtime.tick()
    source('while-disabled'); enabled = true; await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(1)
    expect(service.jobs('p').jobs[0]!.counts.canceled).toBe(1)
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(1)
    expect(db.select().from(llmUsageEvents).all()).toHaveLength(0)
  })
  it('recovers an expired claim on restart without duplicate successful results', async () => {
    service.configure('p', { enabled: true }); source('r')
    const first = worker(); first.runtime.reconcile()
    new SentimentRepository(db).claim({ owner: 'lost-worker', now: time, leaseMs: 1_000 })
    time = '2026-09-28T00:00:02.000Z'
    const restarted = worker(); await restarted.runtime.tick(); await restarted.runtime.tick()
    expect(restarted.classify).toHaveBeenCalledTimes(1)
    expect(service.jobs('p').jobs[0]!.state).toBe('complete')
  })
  it('lets already transmitted responses finish while canceled selections remain canceled', async () => {
    service.configure('p', { enabled: true }); source('r')
    const classify = vi.fn(async (input: SentimentClassifierInput) => { service.configure('p', { enabled: false }); return classified(input) })
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now })
    await runtime.tick()
    expect(service.jobs('p').jobs[0]).toMatchObject({ state: 'canceled', counts: { canceled: 1 } })
    expect(db.select().from(llmUsageEvents).all()).toHaveLength(1)
  })
})
