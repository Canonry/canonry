import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSimpleMeasurementDefinition, createSentimentEvaluationDefinition, type SentimentClassifierInput, type SentimentClassifierOutput } from '@ainyc/canonry-contracts'
import { createClient, llmUsageEvents, migrate, projects, queries, querySnapshots, recordSentimentCompletion, runs, SentimentRepository, sentimentAttempts, sentimentJobs, sentimentSettings, sentimentWorkItems, simpleMeasurementDefinitions, type DatabaseClient } from '@ainyc/canonry-db'
import { SentimentService, selectSentimentSources, sentimentHash } from '@ainyc/canonry-api-routes'
import { resolveSentimentInstallConfig, type SentimentInstallConfig } from '@ainyc/canonry-config'
import { SentimentWorker, createSentimentPoller, sentimentRateLimitDelayMs } from '../src/sentiment-worker.js'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', () => ({ trackEvent }))

// Pass-through spy: counts the worker's source selections without changing them.
vi.mock('@ainyc/canonry-api-routes', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-api-routes')>()
  return { ...actual, selectSentimentSources: vi.fn(actual.selectSentimentSources) }
})

let db: DatabaseClient
let service: SentimentService
let enabled = true
let apiKey = 'private-test-key'
let maxAttempts = 3
let time: string
const now = () => new Date(time)
const configuration = () => resolveSentimentInstallConfig({}, { enabled, apiKey, maxConcurrency: 2, maxAttempts })
const classified = (input: SentimentClassifierInput): SentimentClassifierOutput => ({ kind: 'classified', outcome: 'favorable', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 1000, outputTokens: 10 }, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: 0.9 })
const refused = (code: 'provider-rate-limit' | 'provider-authorization', retryAfterMs: number | null = null): SentimentClassifierOutput => ({ kind: 'failed', outcome: 'failed', returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null }, error: { code, message: 'Safe refusal', retryable: code === 'provider-rate-limit', retryAfterMs } })
const later = (ms: number) => new Date(Date.parse(time) + ms).toISOString()
beforeEach(() => {
  trackEvent.mockReset()
  enabled = true; apiKey = 'private-test-key'; maxAttempts = 3; time = '2026-09-28T00:00:00.000Z'
  vi.mocked(selectSentimentSources).mockClear()
  db = createClient(':memory:'); migrate(db)
  db.insert(projects).values({ id: 'p', name: 'test', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', createdAt: time, updatedAt: time }).run()
  db.insert(queries).values({ id: 'q', projectId: 'p', query: 'Acme reviews', createdAt: time }).run()
  service = new SentimentService(db, { install: () => ({ enabled, ready: enabled, reason: enabled ? null : 'install-disabled', model: 'jev-1.13.0' }), now, previewSecret: 'secret' })
})
afterEach(() => { db.$client.close() })
function source(id: string, receipt = true, queryText = 'Acme reviews', projectId = 'p', brand = 'Acme', identity: { aliases?: string[]; qualifiedAliases?: string[] } = {}) {
  const queryId = projectId === 'p' ? 'q' : `${projectId}-q`
  db.insert(runs).values({ id, projectId, kind: 'answer-visibility', trigger: 'manual', status: 'completed', createdAt: time }).run()
  db.insert(querySnapshots).values({ id: `s-${id}`, runId: id, queryId, provider: 'openai', model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: `${brand} is excellent.`, citationState: 'cited', createdAt: time }).run()
  db.insert(simpleMeasurementDefinitions).values({ runId: id, projectId, checksum: 'x', capturedAt: time, definition: buildSimpleMeasurementDefinition({ capturedAt: time, identity: { displayName: brand, aliases: identity.aliases ?? [], canonicalDomain: `https://${brand}.Example/`, ownedDomains: [], qualifiedAliases: identity.qualifiedAliases }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'gpt-test' }], queries: [{ queryId, queryText, provenance: null }] }) }).run()
  if (receipt) recordSentimentCompletion(db, { projectId, runId: id, completionKey: 'initial', completedAt: time })
}
function secondProject() {
  db.insert(projects).values({ id: 'p2', name: 'second', displayName: 'Beta', canonicalDomain: 'beta.example', country: 'US', language: 'en', createdAt: time, updatedAt: time }).run()
  db.insert(queries).values({ id: 'p2-q', projectId: 'p2', query: 'Beta reviews', createdAt: time }).run()
  service.configure('p2', { enabled: true })
}
function worker(classify = vi.fn(async (input: SentimentClassifierInput) => classified(input))) { return { classify, runtime: new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now }) } }

describe('durable sentiment worker', () => {

  it('claims only what the minute\'s request budget allows, leaving the rest queued instead of deferred', async () => {
    service.configure('p', { enabled: true }); for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) source(id)
    const classify = vi.fn(async (input: SentimentClassifierInput) => classified(input))
    const budgeted = () => resolveSentimentInstallConfig({}, { enabled, apiKey, maxConcurrency: 8, maxRequestsPerMinute: 2 })
    const runtime = new SentimentWorker(db, { configuration: budgeted, classifier: () => ({ classify }), now })
    expect(await runtime.tick()).toBe(2)
    expect(await runtime.tick()).toBe(0)
    expect(classify).toHaveBeenCalledTimes(2)
    const waiting = db.select().from(sentimentWorkItems).where(eq(sentimentWorkItems.status, 'pending')).all()
    expect(waiting).toHaveLength(3)
    expect(waiting.map(item => [item.errorCode, item.nextAttemptAt])).toEqual([[null, null], [null, null], [null, null]])
    time = later(61_000)
    expect(await runtime.tick()).toBe(2)
    expect(classify).toHaveBeenCalledTimes(4)
  })
  it('leaves work queued when the minute\'s token budget cannot fit it, and dispatches it once tokens free up', async () => {
    service.configure('p', { enabled: true }); for (const id of ['t1', 't2', 't3', 't4', 't5']) source(id)
    const classify = vi.fn(async (input: SentimentClassifierInput) => classified(input))
    const budgeted = () => resolveSentimentInstallConfig({}, { enabled, apiKey, maxConcurrency: 8, maxInputTokensPerMinute: 2500 })
    const prepare = () => ({ ok: true as const, estimatedInputTokens: 1000 })
    const runtime = new SentimentWorker(db, { configuration: budgeted, classifier: () => ({ classify }), prepare, now })
    expect(await runtime.tick()).toBe(2)
    expect(await runtime.tick()).toBe(0)
    expect(classify).toHaveBeenCalledTimes(2)
    const waiting = db.select().from(sentimentWorkItems).where(eq(sentimentWorkItems.status, 'pending')).all()
    expect(waiting.map(item => [item.errorCode, item.nextAttemptAt, item.attemptCount])).toEqual([[null, null, 0], [null, null, 0], [null, null, 0]])
    time = later(61_000)
    expect(await runtime.tick()).toBe(2)
    expect(classify).toHaveBeenCalledTimes(4)
  })

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
    expect(service.jobList('p').jobs).toHaveLength(2)
    expect(service.summary('p', { runId: 'non-brand', mode: 'simple', scope: 'project', queryClass: 'non-brand' })).toMatchObject({ state: 'complete', coverage: { selected: 1, judged: 0, counts: { 'subject-not-mentioned': 1, unfavorable: 0 } }, score: { favorableRate: null, favorableDisplay: 'Unavailable' } })
  })
  it('sends an opted-in run\'s frozen qualified aliases on automatic admission, and an empty list for a run that never opted in', async () => {
    service.configure('p', { enabled: true })
    const aliases = ['AcmeNYC', 'Acme NYC']
    source('plain', true, 'Acme reviews', 'p', 'Acme', { aliases })
    source('qualified', true, 'Acme reviews', 'p', 'Acme', { aliases, qualifiedAliases: ['AcmeNYC', 'Acme NYC'] })
    const { runtime, classify } = worker()
    await runtime.tick(); await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(2)
    const sent = new Map(classify.mock.calls.map(([input]) => [input.sourceSnapshotId, input]))
    expect(sent.get('s-qualified')!.subject.qualifiedAliases).toEqual(['Acme NYC', 'AcmeNYC'])
    expect(sent.get('s-plain')!.subject.qualifiedAliases).toEqual([])
    expect(sent.get('s-qualified')!.subjectHash).not.toBe(sent.get('s-plain')!.subjectHash)
    const stored = db.select({ snapshotId: sentimentWorkItems.snapshotId, input: sentimentWorkItems.input }).from(sentimentWorkItems).all()
    expect(Object.fromEntries(stored.map(item => [item.snapshotId, (item.input as SentimentClassifierInput).subject.qualifiedAliases]))).toEqual({
      's-plain': [], 's-qualified': ['Acme NYC', 'AcmeNYC'],
    })
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

  it.each([
    ['an archived schema 1', (definition: SentimentClassifierInput['definition']) => ({ ...definition, schemaVersion: 1, verdictVersion: 'stance-v1', themes: [], questions: { ...definition.questions, theme: 'Archived question' } })],
    ['an earlier schema 2 template', (definition: SentimentClassifierInput['definition']) => ({ ...definition, identityVersion: 'qualified-subject-v2', segmentationVersion: 'sentence-spans-v1' })],
  ])('refuses %s evaluator input before preparation, attempt reservation, or transmission', async (_label, frozen) => {
    service.configure('p', { enabled: true }); source('r')
    const { runtime, classify } = worker(); runtime.reconcile()
    const work = db.select().from(sentimentWorkItems).get()!
    const input = work.input as SentimentClassifierInput
    db.update(sentimentWorkItems).set({ input: { ...input, definition: frozen(input.definition) } }).where(eq(sentimentWorkItems.id, work.id)).run()
    await runtime.tick()
    expect(classify).not.toHaveBeenCalled()
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(0)
    expect(db.select().from(llmUsageEvents).all()).toHaveLength(0)
    expect(db.select().from(sentimentWorkItems).get()).toMatchObject({ status: 'failed', errorCode: 'UNSUPPORTED_EVALUATOR_DEFINITION' })
  })

  it('admits nothing under an earlier schema 2 template until sentiment is configured again', async () => {
    const earlier = { ...createSentimentEvaluationDefinition(), identityVersion: 'qualified-subject-v2', segmentationVersion: 'sentence-spans-v1' }
    const repository = new SentimentRepository(db), id = sentimentHash(earlier)
    repository.putDefinition({ id, contentHash: id, requestedModel: earlier.requestedModel, definition: earlier, createdAt: time })
    repository.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: id, configuration: { enabled: true }, now: time })
    source('r')
    const { runtime, classify } = worker()
    await runtime.tick(); await runtime.tick()
    expect(classify).not.toHaveBeenCalled()
    expect(db.select().from(sentimentWorkItems).all()).toHaveLength(0)
    expect(service.settings('p', true)).toMatchObject({ ready: false, actions: { backfill: false } })
    expect(service.settings('p').readinessReasons.some(reason => reason.startsWith('unsupported-evaluator-definition'))).toBe(true)
    const before = service.settings('p')
    const settings = service.configure('p', { enabled: true })
    expect(settings).toMatchObject({ ready: true, enablementEpoch: before.enablementEpoch + 1 })
    source('next'); await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify.mock.calls[0]![0].definition).toEqual(createSentimentEvaluationDefinition())
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
    expect(service.jobList('p').jobs[0]).toMatchObject({ selected: 1, state: 'complete', counts: { favorable: 1 } })
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
    expect(service.jobList('p').jobs[0]).toMatchObject({ state: 'failed', counts: { failed: 1 } })
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
    expect(service.jobList('p').jobs[0]!.counts.canceled).toBe(1)
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(1)
    expect(db.select().from(llmUsageEvents).all()).toHaveLength(0)
  })
  it.each([
    ['an invalid config.yaml', (): SentimentInstallConfig => ({ ...resolveSentimentInstallConfig({}, { enabled: false }), invalid: true })],
    ['a missing key', (): SentimentInstallConfig => resolveSentimentInstallConfig({}, { enabled: true, maxConcurrency: 2 })],
  ])('holds queued work and gap completions through %s, and resumes both once it is fixed', async (_label, unready) => {
    service.configure('p', { enabled: true }); source('before')
    let current: () => SentimentInstallConfig = configuration
    const classify = vi.fn(async (input: SentimentClassifierInput) => classified(input))
    const runtime = new SentimentWorker(db, { configuration: () => current(), classifier: () => ({ classify }), now })
    runtime.reconcile()
    current = unready; source('gap')
    await runtime.tick(); await runtime.tick()
    expect(classify).not.toHaveBeenCalled()
    expect(db.select().from(sentimentWorkItems).where(eq(sentimentWorkItems.status, 'canceled')).all()).toHaveLength(0)
    expect(db.select().from(sentimentSettings).get()).toMatchObject({ installSuspended: false })
    current = configuration
    await runtime.tick(); await runtime.tick()
    expect(classify.mock.calls.map(([input]) => input.sourceSnapshotId).sort()).toEqual(['s-before', 's-gap'])
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(2)
  })
  it('holds a claimed assessment without an attempt when the install stops being ready before dispatch', async () => {
    service.configure('p', { enabled: true }); source('r')
    let held = false
    const classify = vi.fn(async (input: SentimentClassifierInput) => classified(input))
    // Ready for the tick's own checks, invalid once for the reload immediately before the first attempt.
    const claimed = () => Boolean(db.select().from(sentimentWorkItems).where(eq(sentimentWorkItems.status, 'running')).get())
    const runtime = new SentimentWorker(db, { configuration: () => !held && claimed() ? (held = true, { ...configuration(), invalid: true as const }) : configuration(), classifier: () => ({ classify }), now })
    await runtime.tick()
    expect(classify).not.toHaveBeenCalled()
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(0)
    expect(db.select().from(sentimentWorkItems).get()).toMatchObject({ status: 'waiting-to-retry', errorCode: 'INSTALL_NOT_READY', attemptCount: 0 })
    time = later(60_000)
    await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(1)
    expect(service.jobList('p').jobs[0]).toMatchObject({ state: 'complete', counts: { favorable: 1 } })
  })
  it('recovers an expired claim on restart without duplicate successful results', async () => {
    service.configure('p', { enabled: true }); source('r')
    const first = worker(); first.runtime.reconcile()
    new SentimentRepository(db).claim({ owner: 'lost-worker', now: time, leaseMs: 1_000 })
    time = '2026-09-28T00:00:02.000Z'
    const restarted = worker(); await restarted.runtime.tick(); await restarted.runtime.tick()
    expect(restarted.classify).toHaveBeenCalledTimes(1)
    expect(service.jobList('p').jobs[0]!.state).toBe('complete')
  })
  it('selects each completion once, including a query class with nothing to assess', async () => {
    service.configure('p', { enabled: true }); source('r')
    const lookups = vi.spyOn(SentimentRepository.prototype, 'lookupJob')
    const selections = () => vi.mocked(selectSentimentSources).mock.calls.map(([, , filter]) => `${filter.runId}:${filter.queryClass}`)
    const { runtime, classify } = worker()
    await runtime.tick()
    // The branded-only answer leaves the non-brand selection empty.
    expect(selections()).toEqual(['r:branded', 'r:non-brand'])
    lookups.mockClear()
    await runtime.tick(); await runtime.tick()
    expect(selections()).toEqual(['r:branded', 'r:non-brand'])
    expect(lookups).not.toHaveBeenCalled()
    source('next'); await runtime.tick()
    expect(selections()).toEqual(['r:branded', 'r:non-brand', 'next:branded', 'next:non-brand'])
    expect(classify).toHaveBeenCalledTimes(2)
    expect(db.select().from(sentimentJobs).all()).toHaveLength(2)
    lookups.mockRestore()
  })

  it('retries a receipt whose admission lookup failed instead of skipping it past the cursor', async () => {
    service.configure('p', { enabled: true }); source('r')
    const lookups = vi.spyOn(SentimentRepository.prototype, 'lookupJob').mockImplementationOnce(() => { throw new Error('database is locked') })
    const { runtime, classify } = worker()
    await expect(runtime.tick()).rejects.toThrow('database is locked')
    expect(db.select().from(sentimentJobs).all()).toHaveLength(0)
    await runtime.tick(); await runtime.tick()
    expect(classify).toHaveBeenCalledTimes(1)
    expect(db.select().from(sentimentJobs).all()).toHaveLength(1)
    lookups.mockRestore()
  })
  it('pauses the install 30-60s after a 429 without Retry-After, doubles each time, and keeps the retry budget', async () => {
    service.configure('p', { enabled: true }); source('r')
    const classify = vi.fn(async (input: SentimentClassifierInput) => classify.mock.calls.length <= 4 ? refused('provider-rate-limit') : classified(input))
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now })
    const repository = new SentimentRepository(db)
    await runtime.tick()
    for (let refusal = 1; refusal <= 4; refusal++) {
      const state = repository.dispatchState()!
      expect(state).toMatchObject({ blockedReason: 'provider-rate-limit', rateLimitStreak: refusal })
      const pause = Date.parse(state.nextDispatchAt!) - Date.parse(time)
      expect(pause).toBeGreaterThanOrEqual(30_000 * 2 ** (refusal - 1))
      expect(pause).toBeLessThan(60_000 * 2 ** (refusal - 1))
      expect(db.select().from(sentimentWorkItems).get()).toMatchObject({ status: 'waiting-to-retry', nextAttemptAt: state.nextDispatchAt, errorCode: 'provider-rate-limit' })
      time = later(pause - 1)
      await runtime.tick(); expect(classify).toHaveBeenCalledTimes(refusal)
      time = state.nextDispatchAt!
      await runtime.tick(); expect(classify).toHaveBeenCalledTimes(refusal + 1)
    }
    expect(service.jobList('p').jobs[0]).toMatchObject({ state: 'complete', counts: { favorable: 1 } })
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(5)
    expect(repository.dispatchState()).toMatchObject({ blockedReason: null, nextDispatchAt: null, rateLimitStreak: 0 })
  })

  it('pauses every project on a 429, ignores a success sent before the pause, and resumes with one probe', async () => {
    secondProject(); service.configure('p', { enabled: true })
    source('r1'); source('r2', true, 'Beta reviews', 'p2', 'Beta'); source('r3'); source('r4', true, 'Beta reviews', 'p2', 'Beta')
    const classify = vi.fn(async (input: SentimentClassifierInput) => classify.mock.calls.length === 1 ? refused('provider-rate-limit') : classified(input))
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now })
    const repository = new SentimentRepository(db)
    expect(await runtime.tick()).toBe(2)
    const paused = repository.dispatchState()!
    expect(paused).toMatchObject({ blockedReason: 'provider-rate-limit', blockedAt: time, rateLimitStreak: 1 })
    time = later(20_000)
    expect(await runtime.tick()).toBe(0)
    time = paused.nextDispatchAt!
    expect(await runtime.tick()).toBe(1)
    expect(repository.dispatchState()).toMatchObject({ blockedReason: null })
    expect(await runtime.tick()).toBe(2)
    expect(classify).toHaveBeenCalledTimes(5)
    expect(db.select().from(sentimentWorkItems).all().map(item => item.status)).toEqual(['completed', 'completed', 'completed', 'completed'])
  })

  it('counts concurrent 429s from one burst as one backoff step', async () => {
    service.configure('p', { enabled: true }); source('r1'); source('r2')
    const classify = vi.fn(async () => refused('provider-rate-limit'))
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now })
    expect(await runtime.tick()).toBe(2)
    const state = new SentimentRepository(db).dispatchState()!
    expect(state.rateLimitStreak).toBe(1)
    expect(Date.parse(state.nextDispatchAt!) - Date.parse(time)).toBeLessThan(60_000)
  })

  it('suspends every dispatch after a 401/403 until the key changes, probing hourly, without spending the budget', async () => {
    maxAttempts = 1
    service.configure('p', { enabled: true }); source('r1'); source('r2')
    const classify = vi.fn(async (input: SentimentClassifierInput) => apiKey === 'rotated-key' ? classified(input) : refused('provider-authorization'))
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now })
    const repository = new SentimentRepository(db)
    expect(await runtime.tick()).toBe(2)
    const suspended = repository.dispatchState()!
    expect(suspended).toMatchObject({ blockedReason: 'provider-authorization', blockedAt: time, nextDispatchAt: later(60 * 60_000) })
    expect(JSON.stringify(suspended)).not.toContain('private-test-key')
    expect(db.select().from(sentimentWorkItems).all().map(item => [item.status, item.errorCode])).toEqual([['waiting-to-retry', 'provider-authorization'], ['waiting-to-retry', 'provider-authorization']])
    time = later(30 * 60_000)
    expect(await runtime.tick()).toBe(0)
    time = suspended.nextDispatchAt!
    expect(await runtime.tick()).toBe(1)
    expect(repository.dispatchState()).toMatchObject({ blockedReason: 'provider-authorization', nextDispatchAt: later(60 * 60_000) })
    expect(await runtime.tick()).toBe(0)
    apiKey = 'rotated-key'
    expect(await runtime.tick()).toBe(2)
    expect(classify).toHaveBeenCalledTimes(5)
    expect(service.jobList('p').jobs.map(job => job.state)).toEqual(['complete', 'complete'])
    expect(repository.dispatchState()).toMatchObject({ blockedReason: null, credentialFingerprint: null })
  })

  it('computes the rate-limit pause from the streak, capped, and honours a longer Retry-After', () => {
    expect(sentimentRateLimitDelayMs(1, null, () => 0)).toBe(30_000)
    expect(sentimentRateLimitDelayMs(1, null, () => 0.999_999)).toBe(59_999)
    expect(sentimentRateLimitDelayMs(3, null, () => 0)).toBe(120_000)
    expect(sentimentRateLimitDelayMs(20, null, () => 0)).toBe(15 * 60_000)
    expect(sentimentRateLimitDelayMs(20, null, () => 0.999_999)).toBe(30 * 60_000 - 1)
    expect(sentimentRateLimitDelayMs(1, 90_000, () => 0)).toBe(90_000)
    expect(sentimentRateLimitDelayMs(1, 1_000, () => 0)).toBe(30_000)
  })

  it('lets already transmitted responses finish while canceled selections remain canceled', async () => {
    service.configure('p', { enabled: true }); source('r')
    const classify = vi.fn(async (input: SentimentClassifierInput) => { service.configure('p', { enabled: false }); return classified(input) })
    const runtime = new SentimentWorker(db, { configuration, classifier: () => ({ classify }), now })
    await runtime.tick()
    expect(service.jobList('p').jobs[0]).toMatchObject({ state: 'canceled', counts: { canceled: 1 } })
    expect(db.select().from(llmUsageEvents).all()).toHaveLength(1)
  })
})

describe('sentiment run outcome telemetry', () => {
  const run = { feature: 'sentiment', operation: 'run', durationBucket: expect.any(String) }
  const automatic = { ...run, trigger: 'scheduled', surface: 'system' }
  const failedOnce = (input: SentimentClassifierInput, attempt: number): SentimentClassifierOutput => attempt === 1
    ? { kind: 'failed', outcome: 'failed', returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null }, error: { code: 'provider-unavailable', message: 'TypeSafe returned HTTP 503.', retryable: true, retryAfterMs: null } }
    : classified(input)

  it('reports each answer once it is saved: automatic work as scheduled, its retry as a retry, with attempts and reported tokens', async () => {
    service.configure('p', { enabled: true }); source('r')
    let attempt = 0
    const { runtime } = worker(vi.fn(async (input: SentimentClassifierInput) => failedOnce(input, ++attempt)))
    await runtime.tick()
    time = later(10 * 60_000)
    await runtime.tick()
    expect(trackEvent.mock.calls).toEqual([
      ['feature.completed', { ...automatic, status: 'failed', reasonCode: 'HTTP_5XX', counts: { attempts: 1 } }, { errorCode: 'HTTP_5XX' }],
      ['feature.completed', { ...run, trigger: 'retry', surface: 'system', status: 'succeeded', counts: { attempts: 2, inputTokens: 1000, outputTokens: 10 } }, undefined],
    ])
  })

  it('reports answers it never sends: a preflight abstention as skipped, and a project disabled after the claim as cancelled', async () => {
    service.configure('p', { enabled: true }); source('abstains')
    const abstaining = new SentimentWorker(db, {
      configuration, classifier: () => ({ classify: vi.fn() }), now,
      prepare: () => ({ ok: false, outcome: 'subject-not-mentioned', reason: 'Frozen subject absent from this answer.' }),
    })
    await abstaining.tick()
    source('canceled')
    const disabling = new SentimentWorker(db, {
      configuration, classifier: () => ({ classify: vi.fn() }), now,
      prepare: () => { service.configure('p', { enabled: false }); return { ok: true, estimatedInputTokens: 1000 } },
    })
    await disabling.tick()
    expect(trackEvent.mock.calls).toEqual([
      ['feature.completed', { ...automatic, status: 'skipped', reasonCode: 'NO_DATA' }, { errorCode: 'NO_DATA' }],
      ['feature.completed', { ...automatic, status: 'cancelled', reasonCode: 'CANCELLED_BY_USER' }, { errorCode: 'CANCELLED_BY_USER' }],
    ])
  })

  it('reports a refused credential and a transport failure by reason and class, never the provider text', async () => {
    maxAttempts = 1
    service.configure('p', { enabled: true }); source('r')
    const { runtime } = worker(vi.fn(async (): Promise<SentimentClassifierOutput> => refused('provider-authorization')))
    await runtime.tick()
    // A rotated key lifts the authorization pause: the refused answer is retried beside a new one.
    apiKey = 'rotated-key'; source('next')
    const unreachable = worker(vi.fn(async () => { throw Object.assign(new TypeError('fetch failed for https://typesafe.example/v1 with key private-test-key'), { code: 'ECONNRESET' }) }))
    await unreachable.runtime.tick()
    const network = { status: 'failed', reasonCode: 'NETWORK', errorName: 'TypeError' }
    expect(trackEvent.mock.calls[0]).toEqual(
      ['feature.completed', { ...automatic, status: 'failed', reasonCode: 'INVALID_CREDENTIALS', counts: { attempts: 1 } }, { errorCode: 'INVALID_CREDENTIALS' }],
    )
    expect(trackEvent.mock.calls.slice(1)).toHaveLength(2)
    expect(trackEvent.mock.calls.slice(1)).toEqual(expect.arrayContaining([
      ['feature.completed', { ...automatic, ...network, counts: { attempts: 1 } }, { errorCode: 'NETWORK' }],
      ['feature.completed', { ...run, trigger: 'retry', surface: 'system', ...network, counts: { attempts: 2 } }, { errorCode: 'NETWORK' }],
    ]))
    expect(JSON.stringify(trackEvent.mock.calls)).not.toMatch(/typesafe\.example|private-test-key/)
  })

  it('samples a long stream of answers per status and reason, carrying the count it dropped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      service.configure('p', { enabled: true })
      for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) source(id)
      const { runtime } = worker()
      while (await runtime.tick() > 0) { /* drain */ }
      expect(trackEvent).toHaveBeenCalledTimes(5)
      vi.setSystemTime(Date.now() + 120_000)
      source('h')
      await runtime.tick()
      expect(trackEvent).toHaveBeenCalledTimes(6)
      expect(trackEvent.mock.calls[5]![1]).toEqual({ ...automatic, status: 'succeeded', counts: { attempts: 1, inputTokens: 1000, outputTokens: 10 }, droppedBefore: 2 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sentiment poller', () => {
  it('ticks again straight away while work is claimed, and drops a poll that arrives mid-tick', async () => {
    const claimed = [3, 2, 0]
    const tick = vi.fn(async () => claimed.shift() ?? 0)
    const scheduled: Array<() => void> = []
    const poller = createSentimentPoller(tick, () => {}, fn => scheduled.push(fn))
    poller.poll(); poller.poll()
    for (let index = 0; index < 5; index++) { await poller.settled(); scheduled.shift()?.() }
    expect(tick).toHaveBeenCalledTimes(3)
    expect(scheduled).toHaveLength(0)
  })
  it('stops after a failed tick and after stop()', async () => {
    const onError = vi.fn()
    const failing = createSentimentPoller(vi.fn(async () => { throw new Error('boom') }), onError, fn => fn())
    failing.poll(); await failing.settled()
    expect(onError).toHaveBeenCalledTimes(1)
    const tick = vi.fn(async () => 1)
    const scheduled: Array<() => void> = []
    const poller = createSentimentPoller(tick, () => {}, fn => scheduled.push(fn))
    poller.poll(); await poller.settled(); poller.stop(); scheduled.shift()?.(); poller.poll()
    expect(tick).toHaveBeenCalledTimes(1)
  })
})

