import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSimpleMeasurementDefinition, canonicalMeasurementPlanV2Json, formatPercent, RatioUnits, sentimentBackfillPreviewSchema, sentimentSelectionSchema,
  sentimentSummarySchema, sentimentOverviewSchema, storedSentimentClassifierInputSchema, type SentimentClassifierOutput, type SentimentOutcome,
} from '@ainyc/canonry-contracts'
import { eq } from 'drizzle-orm'
import {
  apiKeys, createClient, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs,
  sentimentWorkItems, simpleMeasurementDefinitions, SentimentRepository, type DatabaseClient,
} from '@ainyc/canonry-db'

/** Counts frozen source selections; the real selector still answers every call. */
const selections = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/sentiment-source.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sentiment-source.js')>()
  return { ...actual, selectSentimentSources: (...args: Parameters<typeof actual.selectSentimentSources>) => { selections.count++; return actual.selectSentimentSources(...args) } }
})

import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { SentimentService } from '../src/sentiment-service.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-09-28T00:00:00.000Z'
const ANSWER = 'Acme Co offers excellent service.'
let db: DatabaseClient
let service: SentimentService
let repository: SentimentRepository
const install = { enabled: true, ready: true, reason: null as string | null, model: 'jev-1.13.0' }
const options = { install: () => ({ ...install }), now: () => new Date(NOW), previewSecret: 'service-test-secret' }
beforeEach(() => {
  Object.assign(install, { enabled: true, ready: true, reason: null })
  db = createClient(':memory:'); migrate(db)
  db.insert(projects).values({ id: 'p', name: 'p', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(apiKeys).values({ id: 'root', name: 'root', keyHash: hashApiKey('cnry_service-root'), keyPrefix: 'cnry_test', scopes: ['*'], createdAt: NOW }).run()
  service = new SentimentService(db, options); repository = new SentimentRepository(db)
  selections.count = 0
})
afterEach(() => db.$client.close())

function simple(runId: string, labels: string[], location: string | null = null, providers = ['openai'], identity: { aliases?: string[]; qualifiedAliases?: string[] } = {}) {
  db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', location, createdAt: NOW }).run()
  const frozen = labels.map((queryText, index) => ({ queryId: `q-${index}`, queryText, provenance: null }))
  for (const query of frozen) db.insert(queries).values({ id: query.queryId, projectId: 'p', query: query.queryText, createdAt: NOW }).onConflictDoNothing().run()
  const definition = buildSimpleMeasurementDefinition({ capturedAt: NOW, identity: { displayName: 'Acme', aliases: identity.aliases ?? ['Acme Co'], canonicalDomain: 'acme.example', ownedDomains: [], qualifiedAliases: identity.qualifiedAliases }, country: 'US', language: 'en', location: location ? { label: location, city: location, region: 'EX', country: 'US' } : null, engines: providers.map(provider => ({ provider, requestedModel: `${provider}-requested` })), queries: frozen })
  db.insert(simpleMeasurementDefinitions).values({ runId, projectId: 'p', definition, checksum: runId, capturedAt: NOW }).run()
  for (const query of frozen) for (const provider of providers) db.insert(querySnapshots).values({ id: `${runId}-${query.queryId}${provider === 'openai' ? '' : `-${provider}`}`, runId, queryId: query.queryId, queryText: query.queryText, location, provider, model: `${provider}-requested`, servedModel: `${provider}-served`, answerText: ANSWER, citationState: 'cited', createdAt: NOW }).run()
}
function admit(runId: string, queryClass: 'branded' | 'non-brand' = 'branded') {
  const preview = service.preview('p', { runId, queryClass })
  return service.submit('p', preview.previewToken!, `${runId}:${queryClass}`, 'fixture')
}
/** Completes claimable work. A null model is a local abstention that never reached the classifier. */
function finish(decide: (snapshotId: string, subjectId: string) => { outcome: SentimentOutcome; model?: string | null } = () => ({ outcome: 'favorable' })) {
  for (;;) {
    const work = repository.claim({ owner: 'service-test', now: NOW, leaseMs: 30_000 })
    if (!work) break
    const input = storedSentimentClassifierInputSchema.parse(work.input)
    const { outcome, model = 'jev-1.13.0' } = decide(work.snapshotId, input.subject.id)
    const usage = model ? { kind: 'reported' as const, inputTokens: 10, outputTokens: 1 } : { kind: 'unknown' as const, inputTokens: null, outputTokens: null }
    const result: SentimentClassifierOutput = ['favorable', 'mixed', 'unfavorable'].includes(outcome)
      ? { kind: 'classified', outcome, returnedModel: model ?? 'jev-1.13.0', usage, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null }
      : { kind: 'abstained', outcome, reason: 'Fixture exclusion.', returnedModel: model, usage }
    expect(repository.completeWork({ workItemId: work.id, owner: 'service-test', now: NOW, outcome, result, returnedModel: result.returnedModel })).toBe(true)
  }
}
async function overviewSentiment() {
  const app = Fastify(); app.register(apiRoutes, { db, sentiment: options }); await app.ready()
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/p/overview', headers: { authorization: 'Bearer cnry_service-root' } })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().sentiment
  } finally { await app.close() }
}

describe('sentiment service reads', () => {
  it('answers the overview of an unconfigured or switched-off project without selecting any source', async () => {
    simple('harbor', ['Acme reviews'], 'Harbor'); simple('bayside', ['Acme reviews'], 'Bayside')
    const off = { configured: false, branded: { state: 'disabled', runIds: [], coverage: { selected: 0, eligibleAssessments: 0, eligibleAnswers: 0, ratedAnswers: 0, ratedAnswerRate: null }, score: { favorableRate: null } }, nonBrand: { state: 'disabled', runIds: [] }, overall: { queryClass: 'all', state: 'disabled', runIds: [], coverage: { selected: 0, judged: 0, eligibleAnswers: 0, ratedAnswers: 0, ratedAnswerRate: null }, score: { favorableRate: null } } }
    expect(await overviewSentiment()).toMatchObject(off)
    expect(selections.count).toBe(0)
    service.configure('p', { enabled: true }); admit('harbor'); finish()
    service.configure('p', { enabled: false }); selections.count = 0
    expect(await overviewSentiment()).toMatchObject(off)
    expect(selections.count).toBe(0)
    service.configure('p', { enabled: true }); install.enabled = false; install.ready = false; selections.count = 0
    expect(service.overview('p', ['harbor', 'bayside'])).toMatchObject(off)
    expect(selections.count).toBe(0)
  })

  it('selects each run source once per class for configured overview, summary and comparison reads', () => {
    service.configure('p', { enabled: true })
    simple('harbor', ['Acme reviews', 'best service options'], 'Harbor'); simple('bayside', ['Acme reviews', 'best service options'], 'Bayside')
    for (const runId of ['harbor', 'bayside']) for (const queryClass of ['branded', 'non-brand'] as const) admit(runId, queryClass)
    finish(snapshotId => ({ outcome: snapshotId === 'bayside-q-0' ? 'unfavorable' : 'favorable' }))
    selections.count = 0
    const overview = service.overview('p', ['harbor', 'bayside'])
    expect(overview).toMatchObject({ configured: true, branded: { coverage: { selected: 2, judged: 2, eligibleAnswers: 2, ratedAnswers: 2, ratedAnswerRate: 1 }, score: { favorableRate: 0.5 } }, nonBrand: { coverage: { selected: 2, judged: 2, eligibleAnswers: 2, ratedAnswers: 2, ratedAnswerRate: 1 }, score: { favorableRate: 1 } } })
    expect(overview.branded.runIds).toEqual(['bayside', 'harbor'])
    expect(overview.overall).toMatchObject({ queryClass: 'all', coverage: { selected: 4, judged: 4, distinctSourceAnswers: 4, eligibleAnswers: 4, ratedAnswers: 4, ratedAnswerRate: 1, expectedProviderSlots: 4, completedProviderSlots: 4 }, score: { favorableRate: 0.75, favorableDisplay: '75.0%' }, runIds: ['bayside', 'harbor'] })
    expect(selections.count).toBe(4)
    selections.count = 0
    expect(service.summary('p', sentimentSelectionSchema.parse({ runId: 'harbor' }))).toMatchObject({ coverage: { selected: 1, judged: 1 } })
    expect(selections.count).toBe(1)
    selections.count = 0
    service.compare('p', sentimentSelectionSchema.parse({}), 'harbor', 'bayside')
    expect(selections.count).toBe(2)
  })

  it('computes overall from Simple judgments rather than averaging class percentages', async () => {
    service.configure('p', { enabled: true })
    simple('mixed', ['Acme reviews', 'best services', 'service options', 'local services', 'service facts', 'nearby providers', 'foreign services'])
    admit('mixed'); admit('mixed', 'non-brand')
    const outcomes: SentimentOutcome[] = ['favorable', 'favorable', 'mixed', 'unfavorable', 'factual', 'subject-not-mentioned', 'unsupported-language']
    finish(snapshotId => ({ outcome: outcomes[Number(snapshotId.split('-').at(-1))]! }))
    const overview = sentimentOverviewSchema.parse(await overviewSentiment())
    expect(overview.overall).toMatchObject({ queryClass: 'all', state: 'complete', provisional: false, reason: null, runIds: ['mixed'], coverage: { selected: 7, eligibleAssessments: 7, unadmittedAssessments: 0, judged: 4, distinctSourceAnswers: 7, expectedProviderSlots: 7, completedProviderSlots: 7, counts: { favorable: 2, mixed: 1, unfavorable: 1, factual: 1, 'subject-not-mentioned': 1, 'unsupported-language': 1 } }, score: { favorableRate: 0.5, mixedRate: 0.25, unfavorableRate: 0.25, favorableDisplay: '50.0%', mixedDisplay: '25.0%', unfavorableDisplay: '25.0%', interval: { low: 0.15, high: 0.85 } } })
    expect(Object.values(overview.overall!.coverage.counts).reduce((sum, count) => sum + count, 0)).toBe(7)
    expect(overview.overall).not.toHaveProperty('selection')
    expect(overview.branded.score.favorableRate).toBe(1)
    expect(overview.nonBrand.score.favorableRate).toBe(1 / 3)
    expect(service.overview('p', ['mixed', 'mixed']).overall).toEqual(overview.overall)
  })

  it('excludes a newer probe and its saved judgments from the serialized overview', async () => {
    service.configure('p', { enabled: true })
    simple('measured', ['Acme reviews', 'best services']); admit('measured'); admit('measured', 'non-brand')
    finish(snapshotId => ({ outcome: snapshotId.endsWith('0') ? 'favorable' : 'unfavorable' }))
    const expected = service.overview('p', ['measured']).overall
    simple('probe', ['Acme reviews', 'best services']); admit('probe'); admit('probe', 'non-brand'); finish()
    // Retain classified rows to prove that neither the source nor saved judgments leak.
    db.$client.prepare("UPDATE runs SET trigger = 'probe', created_at = '2026-09-29T00:00:00.000Z' WHERE id = 'probe'").run()
    const overview = sentimentOverviewSchema.parse(await overviewSentiment())
    expect(overview.overall).toEqual(expected)
    expect(overview.overall).toMatchObject({ runIds: ['measured'], coverage: { selected: 2, judged: 2, expectedProviderSlots: 2, completedProviderSlots: 2, counts: { favorable: 1, unfavorable: 1 } }, score: { favorableRate: 0.5, favorableDisplay: '50.0%' } })
    expect(service.overview('p', ['measured', 'probe']).overall).toMatchObject({ coverage: expected!.coverage, score: expected!.score })
  })

  it('preserves unavailable overall scores, unadmitted coverage and partial classifications', () => {
    service.configure('p', { enabled: true })
    expect(service.overview('p', []).overall).toMatchObject({ queryClass: 'all', state: 'not-measured', runIds: [], score: { favorableRate: null, favorableDisplay: 'Unavailable' } })
    simple('partial', ['Acme reviews', 'best services'])
    // Before admission both answers are eligible and none is rated: 0 of 2, not "no answers".
    expect(service.overview('p', ['partial'])).toMatchObject({
      overall: { state: 'not-measured', coverage: { selected: 0, eligibleAssessments: 2, unadmittedAssessments: 2, judged: 0, distinctSourceAnswers: 0, eligibleAnswers: 2, ratedAnswers: 0, ratedAnswerRate: 0 }, score: { favorableRate: null } },
      branded: { coverage: { selected: 0, eligibleAnswers: 1, ratedAnswers: 0, ratedAnswerRate: 0 } }, nonBrand: { coverage: { selected: 0, eligibleAnswers: 1, ratedAnswers: 0, ratedAnswerRate: 0 } },
    })
    admit('partial'); finish()
    expect(service.overview('p', ['partial']).overall).toMatchObject({ state: 'partial', provisional: true, coverage: { selected: 1, eligibleAssessments: 2, unadmittedAssessments: 1, judged: 1, eligibleAnswers: 2, ratedAnswers: 1, ratedAnswerRate: 0.5 }, score: { favorableRate: 1, favorableDisplay: '100%' } })
    // The never-admitted non-brand class still has its one answer: 0 of 1.
    expect(service.overview('p', ['partial'])).toMatchObject({ branded: { coverage: { eligibleAnswers: 1, ratedAnswers: 1, ratedAnswerRate: 1 } }, nonBrand: { state: 'not-measured', coverage: { selected: 0, eligibleAnswers: 1, ratedAnswers: 0, ratedAnswerRate: 0 } } })
    simple('unjudged', ['Acme facts', 'service facts']); admit('unjudged'); admit('unjudged', 'non-brand')
    finish(snapshotId => ({ outcome: snapshotId.endsWith('0') ? 'factual' : 'subject-not-mentioned' }))
    expect(service.overview('p', ['unjudged']).overall).toMatchObject({ state: 'complete', coverage: { selected: 2, judged: 0, counts: { factual: 1, 'subject-not-mentioned': 1 } }, score: { favorableRate: null, favorableDisplay: 'Unavailable', interval: null } })
  })

  it('unions Advanced answer-subject assessments and provider slots across both classes', () => {
    const plan = measurementPlanV2Fixture()
    const reused = { executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-cross-class' }
    plan.usageEdges.push(reused)
    plan.assignments.push({ ...reused, queryClass: 'non-brand' })
    db.insert(measurementPlanVersions).values({ id: 'v', projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'v', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
    db.insert(runs).values({ id: 'advanced', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: { language: 'en' }, createdAt: NOW }).run()
    for (const node of plan.executionNodes) for (const provider of ['openai', 'gemini']) db.insert(querySnapshots).values({ id: `${node.stableKey}-${provider}`, runId: 'advanced', measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: `${provider}-requested`, servedModel: `${provider}-served`, answerText: 'Harbor Homes and Bayside Homes offer homes.', citationState: 'cited', createdAt: NOW }).run()
    service.configure('p', { enabled: true }); admit('advanced'); admit('advanced', 'non-brand')
    finish((snapshotId, subjectId) => ({ outcome: snapshotId.startsWith('exec-brand') ? snapshotId.endsWith('openai') ? 'favorable' : 'mixed' : subjectId === 'harbor' ? 'unfavorable' : 'factual' }))
    const overview = sentimentOverviewSchema.parse(service.overview('p', ['advanced']))
    expect(overview.branded.coverage.judged).toBe(2)
    expect(overview.nonBrand.coverage.judged).toBe(4)
    expect(overview.overall).toMatchObject({ queryClass: 'all', coverage: { selected: 6, eligibleAssessments: 6, judged: 4, distinctSourceAnswers: 4, eligibleAnswers: 4, ratedAnswers: 4, ratedAnswerRate: 1, expectedProviderSlots: 4, completedProviderSlots: 4, counts: { favorable: 1, mixed: 1, unfavorable: 2, factual: 2 } }, score: { favorableRate: 0.25, favorableDisplay: '25.0%' } })
    // The answer shared by both classes is one answer in each class and once overall.
    expect(overview.branded.coverage).toMatchObject({ eligibleAnswers: 2, ratedAnswers: 2 })
    expect(overview.nonBrand.coverage).toMatchObject({ selected: 6, eligibleAnswers: 4, ratedAnswers: 4 })
    db.$client.prepare("DELETE FROM query_snapshots WHERE id = 'exec-brand-gemini'").run()
    // An incomplete sweep contributes no eligible answers, so it has no Rated share.
    expect(service.overview('p', ['advanced']).overall).toMatchObject({ state: 'not-measured', provisional: true, reason: 'Source sweep is incomplete.', coverage: { selected: 0, judged: 0, eligibleAnswers: 0, ratedAnswers: 0, ratedAnswerRate: null, expectedProviderSlots: 4, completedProviderSlots: 3 }, score: { favorableRate: null } })
  })

  it('rates answers over every eligible answer, admitted or not, and withholds the share while disabled', () => {
    service.configure('p', { enabled: true })
    simple('wide', ['Acme reviews'], null, ['openai', 'gemini'])
    const read = () => sentimentSummarySchema.parse(service.summary('p', sentimentSelectionSchema.parse({ runId: 'wide', queryClass: 'branded' })))
    // Before admission: two eligible answers, none rated. 0 of 2, never "no answers".
    expect(read()).toMatchObject({ state: 'not-measured', coverage: { selected: 0, eligibleAssessments: 2, distinctSourceAnswers: 0, eligibleAnswers: 2, ratedAnswers: 0, ratedAnswerRate: 0 } })
    const preview = service.preview('p', { runId: 'wide', queryClass: 'branded', provider: 'openai' })
    service.submit('p', preview.previewToken!, 'wide-openai', 'fixture')
    // Admitted and pending is still not rated.
    expect(read().coverage).toMatchObject({ selected: 1, judged: 0, eligibleAnswers: 2, ratedAnswers: 0, ratedAnswerRate: 0 })
    finish()
    // One of the two answers rated favorable: 50.0%, never 1 of 1.
    const half = read()
    expect(half.coverage).toMatchObject({ selected: 1, judged: 1, unadmittedAssessments: 1, distinctSourceAnswers: 1, eligibleAnswers: 2, ratedAnswers: 1, ratedAnswerRate: 0.5 })
    expect(formatPercent(half.coverage.ratedAnswerRate!, RatioUnits.fraction)).toBe('50.0%')
    expect(half.queries[0]!.coverage).toMatchObject({ eligibleAnswers: 2, ratedAnswers: 1, ratedAnswerRate: 0.5 })
    expect(half.breakdowns.filter(row => row.dimension === 'provider').map(row => [row.key, row.coverage.ratedAnswers, row.coverage.eligibleAnswers, row.coverage.ratedAnswerRate])).toEqual([['openai', 1, 1, 1], ['gemini', 0, 1, 0]])
    admit('wide'); finish()
    expect(read().coverage).toMatchObject({ selected: 2, judged: 2, eligibleAnswers: 2, ratedAnswers: 2, ratedAnswerRate: 1 })
    // Disabled keeps the denominator and withholds what was rated, as it withholds judged.
    service.configure('p', { enabled: false })
    expect(read()).toMatchObject({ state: 'disabled', coverage: { judged: 0, eligibleAnswers: 2, ratedAnswers: 0, ratedAnswerRate: null } })
  })

  it('has no Rated share when the selection has no eligible answers', () => {
    service.configure('p', { enabled: true })
    expect(service.summary('p', sentimentSelectionSchema.parse({})).coverage).toMatchObject({ selected: 0, eligibleAnswers: 0, ratedAnswers: 0, ratedAnswerRate: null })
    simple('brand-only', ['Acme reviews']); admit('brand-only'); finish()
    expect(service.summary('p', sentimentSelectionSchema.parse({ runId: 'brand-only', queryClass: 'non-brand' })).coverage).toMatchObject({ selected: 0, eligibleAnswers: 0, ratedAnswers: 0, ratedAnswerRate: null })
    expect(service.overview('p', []).overall!.coverage).toMatchObject({ eligibleAnswers: 0, ratedAnswers: 0, ratedAnswerRate: null })
  })

  it('lets an administrator switch a project off while the install switch is off, and it stays off on resume', () => {
    service.configure('p', { enabled: true })
    Object.assign(install, { enabled: false, ready: false, reason: 'install-disabled' })
    repository.suspendInstall(NOW)
    expect(service.settings('p', true).actions).toEqual({ configure: true, backfill: false })
    expect(() => service.configure('p', { enabled: true })).toThrow('Sentiment is disabled in install configuration.')
    expect(() => service.configure('p', {})).toThrow('Sentiment is disabled in install configuration.')
    const epoch = service.settings('p').enablementEpoch
    expect(service.configure('p', { enabled: false })).toMatchObject({ enabled: false, installEnabled: false, actions: { configure: false, backfill: false } })
    Object.assign(install, { enabled: true, ready: true, reason: null })
    repository.resumeInstall(NOW)
    expect(repository.getSettings('p')).toMatchObject({ enabled: false, installSuspended: false, enablementEpoch: epoch })
    expect(service.settings('p', true).actions.configure).toBe(true)
  })

  it('counts job outcomes without frozen inputs, lists summaries without attempts, and pages attempt receipts', () => {
    service.configure('p', { enabled: true }); simple('r', ['Acme reviews', 'Acme complaints', 'Acme pricing'])
    const job = admit('r')
    let clock = Date.parse(NOW)
    const tick = () => new Date(clock += 1_000).toISOString()
    for (let index = 0; ; index++) {
      const now = tick()
      const work = repository.claim({ owner: `attempt-${index}`, now, leaseMs: 30_000 })
      if (!work) break
      const attempt = repository.startAttempt({ workItemId: work.id, owner: `attempt-${index}`, requestedModel: 'jev-1.13.0', now })!
      if (index === 0) {
        repository.finishAttempt({ attemptId: attempt.id, now, returnedModel: null, usageStatus: 'unknown', safeFailure: 'TIMEOUT' })
        repository.failWork({ workItemId: work.id, owner: `attempt-${index}`, now, errorCode: 'TIMEOUT', retryAt: now })
        continue
      }
      repository.finishAttempt({ attemptId: attempt.id, now, returnedModel: 'jev-1.13.0', usageStatus: 'reported', usage: { inputTokens: 10, outputTokens: 1 } })
      const input = storedSentimentClassifierInputSchema.parse(work.input)
      const outcome = work.snapshotId === 'r-q-1' ? 'unfavorable' : 'favorable'
      repository.completeWork({ workItemId: work.id, owner: `attempt-${index}`, now, outcome, returnedModel: 'jev-1.13.0', result: { kind: 'classified', outcome, returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 1 }, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null } })
    }
    const other = service.submit('p', service.preview('p', { runId: 'r' }).previewToken!, 'replay', 'fixture')
    // Job receipts and previews never parse the frozen request input.
    db.$client.prepare('UPDATE sentiment_work_items SET input = ?').run('{not json')
    const list = service.jobList('p')
    expect(list.jobs).toHaveLength(2)
    const listed = list.jobs.find(item => item.id === job.id)!
    expect(listed).toMatchObject({ id: job.id, state: 'complete', selected: 3, attemptCount: 4, counts: { favorable: 2, unfavorable: 1, failed: 0 } })
    expect(listed).not.toHaveProperty('attempts')
    expect(list.jobs.find(item => item.id === other.id)).toMatchObject({ selected: 3, attemptCount: 4, counts: listed.counts })
    const full = service.job('p', job.id)
    expect(full).toMatchObject({ selected: 3, counts: listed.counts })
    expect(full.attempts.map(attempt => attempt.errorCode)).toEqual(['TIMEOUT', null, null, null])
    const first = service.job('p', job.id, { limit: 3 })
    expect(first).toMatchObject({ attemptCount: 4, selected: 3, counts: listed.counts })
    expect(first.attempts.map(attempt => attempt.dispatchedAt)).toEqual([...full.attempts].reverse().slice(0, 3).map(attempt => attempt.dispatchedAt))
    expect(first.nextAttemptCursor).not.toBeNull()
    const second = service.job('p', job.id, { limit: 3, cursor: first.nextAttemptCursor! })
    expect(second.attempts.map(attempt => attempt.id)).toEqual([full.attempts[0]!.id])
    expect(second.nextAttemptCursor).toBeNull()
    expect(() => service.job('p', other.id, { cursor: first.nextAttemptCursor! })).toThrow('Attempt cursor')
    expect(service.job('p', other.id)).toMatchObject({ selected: 3, counts: listed.counts })
    expect(service.preview('p', { runId: 'r' })).toMatchObject({ eligibleAssessments: 3, alreadyClassified: 3 })
  })

  it('returns compact paged query rows unless detail is included or one query is named', () => {
    service.configure('p', { enabled: true })
    simple('r', ['Acme e', 'Acme a', 'Acme d', 'Acme b', 'Acme c'], 'Harbor', ['openai', 'gemini']); admit('r'); finish()
    const selection = sentimentSelectionSchema.parse({ runId: 'r' })
    const full = sentimentSummarySchema.parse(service.summary('p', selection))
    expect(full.queries.map(row => row.queryText)).toEqual(['Acme a', 'Acme b', 'Acme c', 'Acme d', 'Acme e'])
    expect(full.breakdowns.map(row => row.dimension)).toEqual(['provider', 'provider', 'property'])
    expect(full.queries.every(row => row.assessments.length === 2 && row.locations.length === 1)).toBe(true)
    const pages = [service.summary('p', selection, { queryLimit: 2 })]
    while (pages.at(-1)!.queryPage.nextCursor) pages.push(service.summary('p', selection, { queryLimit: 2, queryCursor: pages.at(-1)!.queryPage.nextCursor! }))
    expect(pages.map(page => page.queries.length)).toEqual([2, 2, 1])
    expect(pages.every(page => page.queryPage.total === 5 && page.queryPage.limit === 2)).toBe(true)
    const rows = pages.flatMap(page => page.queries)
    expect(rows.every(row => row.assessments.length === 0 && row.locations.length === 0 && row.executionNodeKey === null)).toBe(true)
    expect(rows.map(({ assessments: _a, locations: _l, executionNodeKey: _n, ...row }) => row)).toEqual(full.queries.map(({ assessments: _a, locations: _l, ...row }) => row))
    expect(pages[0]).toMatchObject({ coverage: full.coverage, score: full.score, breakdowns: full.breakdowns })
    const detailed = service.summary('p', selection, { include: ['assessments'], queryLimit: 5 })
    expect(detailed.queries.map(row => [row.assessments.length, row.locations.length])).toEqual(Array(5).fill([2, 0]))
    const named = service.summary('p', { ...selection, queryId: 'q-1' }, {})
    expect(named.queries).toHaveLength(1)
    expect(named.queries[0]).toMatchObject({ queryId: 'q-1', assessments: full.queries[0]!.assessments, locations: full.queries[0]!.locations })
    expect(JSON.stringify(pages[0]).length).toBeLessThan(JSON.stringify(full).length / 2)
    const cursor = pages[0]!.queryPage.nextCursor!
    expect(() => service.summary('p', { ...selection, queryClass: 'non-brand' }, { queryCursor: cursor })).toThrow('Query cursor')
    expect(() => service.evidence('p', selection, 1, cursor)).toThrow('Evidence cursor')
  })

  it('treats local abstentions as model-free and returns a directional verdict, refusing only a classifier change', () => {
    service.configure('p', { enabled: true })
    const labels = Array.from({ length: 24 }, (_, index) => `service option ${index}`)
    for (const runId of ['before', 'after', 'drift']) { simple(runId, labels); admit(runId, 'non-brand') }
    // 0-19 judged in both periods, 20-21 abstain locally in both, 22 and 23 abstain locally in one period only.
    finish(snapshotId => {
      const [runId, , index] = snapshotId.split('-') as [string, string, string]
      const unit = Number(index)
      const local = unit === 20 || unit === 21 || (unit === 22 && runId === 'before') || (unit === 23 && runId !== 'before')
      if (local) return { outcome: 'subject-not-mentioned', model: null }
      const favorable = runId === 'before' || unit >= 22
      return { outcome: favorable ? 'favorable' : 'unfavorable', model: runId === 'drift' && unit === 0 ? 'jev-1.14.0' : 'jev-1.13.0' }
    })
    const query = sentimentSelectionSchema.parse({ queryClass: 'non-brand' })
    const declined = service.compare('p', query, 'before', 'after')
    expect(declined).toMatchObject({ verdict: 'declined', refusalReasons: [], commonUnits: 24, from: { coverage: { judged: 21, counts: { favorable: 21, 'subject-not-mentioned': 3 } } }, to: { coverage: { judged: 21, counts: { favorable: 1, unfavorable: 20, 'subject-not-mentioned': 3 } } } })
    expect(declined.favorableRateDelta).toBeCloseTo(1 / 21 - 1)
    // Both periods carry every query row, compact: per-engine and location detail stays on the paged summary.
    expect([declined.from.queries.length, declined.to.queries.length]).toEqual([24, 24])
    expect([...declined.from.queries, ...declined.to.queries].every(row => row.assessments.length === 0 && row.locations.length === 0)).toBe(true)
    expect(service.compare('p', query, 'after', 'before')).toMatchObject({ verdict: 'improved', refusalReasons: [] })
    expect(service.compare('p', query, 'before', 'drift')).toMatchObject({ verdict: null, refusalReasons: ['classifier-model-changed'] })
  })

  it('attributes every skip in a date-range preview to its run from one source selection', () => {
    service.configure('p', { enabled: true })
    simple('kept', ['Acme reviews']); simple('probed', ['Acme reviews']); simple('partial', ['Acme reviews'])
    db.$client.prepare("UPDATE runs SET trigger = 'probe' WHERE id = 'probed'").run()
    db.$client.prepare("UPDATE runs SET status = 'partial' WHERE id = 'partial'").run()
    selections.count = 0
    const preview = service.preview('p', { from: '2026-09-27T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z' })
    expect(selections.count).toBe(1)
    expect(preview.eligibleAssessments).toBe(1)
    expect([...preview.skipped].sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([{ runId: 'partial', reason: 'incomplete-run', count: 1 }, { runId: 'probed', reason: 'probe', count: 1 }])
  })
  it('estimates a never-configured project against the current evaluator and never signs an empty backfill', () => {
    simple('r', ['Acme reviews'])
    const estimating = new SentimentService(db, { ...options, estimate: input => input.sourceText.length })
    const unconfigured = estimating.preview('p', { runId: 'r' })
    expect(unconfigured).toMatchObject({ evaluationDefinitionId: null, eligibleAssessments: 1, alreadyClassified: 0, previewToken: null, estimatedInputTokens: ANSWER.length })
    expect(unconfigured.estimatedCostUsd).toBeCloseTo(ANSWER.length * 0.042 / 1_000_000)
    expect(unconfigured.estimateMethod).toContain('uses the current evaluator definition')
    estimating.configure('p', { enabled: true })
    const empty = estimating.preview('p', { from: '2020-01-01T00:00:00.000Z', to: '2020-01-02T00:00:00.000Z' })
    expect(empty).toMatchObject({ eligibleAssessments: 0, previewToken: null, expiresAt: null, skipped: [], estimatedInputTokens: 0 })
    expect(empty.selection).not.toHaveProperty('runIds')
    expect(sentimentBackfillPreviewSchema.parse(empty).selection).toMatchObject({ from: '2020-01-01T00:00:00.000Z', to: '2020-01-02T00:00:00.000Z' })
    expect(estimating.preview('p', { runId: 'r', queryClass: 'non-brand' })).toMatchObject({ eligibleAssessments: 0, previewToken: null })
    expect(estimating.preview('p', { runId: 'r' }).previewToken).not.toBeNull()
  })

  it('withholds verdicts, quotations and completed-outcome counts once sentiment is disabled', () => {
    service.configure('p', { enabled: true }); simple('r', ['Acme reviews', 'Acme complaints']); simple('queued', ['Acme reviews'])
    const job = admit('r'); finish(snapshotId => ({ outcome: snapshotId === 'r-q-1' ? 'unfavorable' : 'favorable' }))
    const pending = admit('queued')
    const selection = sentimentSelectionSchema.parse({ runId: 'r' })
    expect(service.evidence('p', selection, 10).items.map(item => item.outcome).sort()).toEqual(['favorable', 'unfavorable'])
    expect(service.job('p', job.id).counts).toMatchObject({ favorable: 1, unfavorable: 1 })
    for (const disable of [() => service.configure('p', { enabled: false }), () => { service.configure('p', { enabled: true }); install.enabled = false }]) {
      disable()
      expect(service.evidence('p', selection, 1)).toMatchObject({ state: 'disabled', items: [], nextCursor: null })
      for (const receipt of [service.job('p', job.id), service.job('p', job.id, {}), service.jobList('p').jobs.find(item => item.id === job.id)!]) {
        expect(receipt).toMatchObject({ selected: 2, counts: { favorable: 0, unfavorable: 0 } })
      }
      expect(service.job('p', pending.id)).toMatchObject({ selected: 1, counts: { canceled: 1 } })
      expect(service.summary('p', selection)).toMatchObject({ state: 'disabled', coverage: { selected: 2, judged: 0, counts: { favorable: 0, unfavorable: 0 } }, score: { favorableRate: null, interval: null } })
      expect(service.compare('p', selection, 'r', 'r')).toMatchObject({ verdict: null, refusalReasons: ['sentiment-disabled'], from: { coverage: { judged: 0, counts: { favorable: 0 } } } })
    }
  })

  it('scores an Advanced query per execution node instead of pooling its nodes', () => {
    const plan = measurementPlanV2Fixture()
    plan.executionNodes.push({ stableKey: 'exec-pinned', queryId: 'q-nearby', queryText: 'homes near harbor', context: { providers: ['openai', 'gemini'], models: { openai: 'gpt-pinned' }, location: HARBOR_CONTEXT }, expectedSnapshots: 2 })
    plan.assignments = plan.assignments.map(item => item.targetKey === 'bayside' ? { ...item, executionNodeKey: 'exec-pinned' } : item)
    plan.usageEdges = plan.usageEdges.map(item => item.targetKey === 'bayside' ? { ...item, executionNodeKey: 'exec-pinned' } : item)
    db.insert(measurementPlanVersions).values({ id: 'v', projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'v', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
    db.insert(runs).values({ id: 'nodes', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: { language: 'en' }, createdAt: NOW }).run()
    for (const node of plan.executionNodes) for (const provider of ['openai', 'gemini']) db.insert(querySnapshots).values({ id: `${node.stableKey}-${provider}`, runId: 'nodes', measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: `${provider}-requested`, servedModel: `${provider}-served`, answerText: 'Harbor Homes and Bayside Homes offer homes.', citationState: 'cited', createdAt: NOW }).run()
    service.configure('p', { enabled: true }); admit('nodes', 'non-brand')
    finish(snapshotId => ({ outcome: snapshotId.startsWith('exec-pinned') ? 'unfavorable' : 'favorable' }))
    const selection = sentimentSelectionSchema.parse({ runId: 'nodes', queryClass: 'non-brand' })
    const summary = service.summary('p', selection)
    expect(summary).toMatchObject({ coverage: { selected: 4, judged: 4 }, score: { favorableRate: 0.5 } })
    expect(summary.queries.map(row => [row.queryId, row.sourceSnapshotIds, row.score.favorableRate, [...new Set(row.assessments.map(item => item.executionNodeKey))]])).toEqual([
      ['q-nearby', ['exec-nearby-gemini', 'exec-nearby-openai'], 1, ['exec-nearby']],
      ['q-nearby', ['exec-pinned-gemini', 'exec-pinned-openai'], 0, ['exec-pinned']],
    ])
    expect(service.summary('p', selection, {}).queries.map(row => [row.executionNodeKey, row.coverage.judged])).toEqual([['exec-nearby', 2], ['exec-pinned', 2]])
    // executionNodeKey is identity: it narrows evidence and a backfill preview to one node.
    const nodeEvidence = service.evidence('p', { ...selection, queryId: 'q-nearby', executionNodeKey: 'exec-pinned' }, 10)
    expect(nodeEvidence.items.map(item => [item.sourceSnapshotId, item.outcome]).sort()).toEqual([['exec-pinned-gemini', 'unfavorable'], ['exec-pinned-openai', 'unfavorable']])
    expect(service.evidence('p', { ...selection, queryId: 'q-nearby' }, 10).items).toHaveLength(4)
    const pinned = service.preview('p', { runId: 'nodes', queryClass: 'non-brand', executionNodeKey: 'exec-pinned' })
    const nearby = service.preview('p', { runId: 'nodes', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' })
    expect([pinned.eligibleAssessments, nearby.eligibleAssessments]).toEqual([2, 2])
    expect(pinned.selection.executionNodeKey).toBe('exec-pinned')
    expect(pinned.previewToken).not.toBe(nearby.previewToken)
    expect(service.summary('p', { ...selection, executionNodeKey: 'exec-nearby' })).toMatchObject({ coverage: { selected: 2 }, score: { favorableRate: 1 } })
  })

  it('serves compact paged summaries, job summaries and paged attempts over HTTP', async () => {
    service.configure('p', { enabled: true }); simple('r', ['Acme reviews', 'Acme complaints', 'Acme pricing'])
    const job = admit('r')
    for (let index = 0; index < 3; index++) {
      const work = repository.claim({ owner: `o-${index}`, now: NOW, leaseMs: 30_000 })!
      const attempt = repository.startAttempt({ workItemId: work.id, owner: `o-${index}`, requestedModel: 'jev-1.13.0', now: NOW })!
      repository.finishAttempt({ attemptId: attempt.id, now: NOW, returnedModel: 'jev-1.13.0', usageStatus: 'reported', usage: { inputTokens: 10, outputTokens: 1 } })
      const input = storedSentimentClassifierInputSchema.parse(work.input)
      repository.completeWork({ workItemId: work.id, owner: `o-${index}`, now: NOW, outcome: 'favorable', returnedModel: 'jev-1.13.0', result: { kind: 'classified', outcome: 'favorable', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 1 }, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null } })
    }
    const app = Fastify(); app.register(apiRoutes, { db, sentiment: options }); await app.ready()
    const get = async (path: string) => {
      const response = await app.inject({ method: 'GET', url: `/api/v1/projects/p/sentiment${path}`, headers: { authorization: 'Bearer cnry_service-root' } })
      expect(response.statusCode, response.body).toBe(200)
      return response.json()
    }
    try {
      const compact = sentimentSummarySchema.parse(await get('?runId=r&queryLimit=2'))
      expect(compact.queries.map(row => [row.queryText, row.assessments.length, row.locations.length])).toEqual([['Acme complaints', 0, 0], ['Acme pricing', 0, 0]])
      expect(compact.queryPage).toMatchObject({ total: 3, limit: 2, nextCursor: expect.any(String) })
      expect(compact.breakdowns.map(row => row.dimension)).not.toContain('query')
      const rest = sentimentSummarySchema.parse(await get(`?runId=r&queryLimit=2&include=assessments,locations&queryCursor=${encodeURIComponent(compact.queryPage!.nextCursor!)}`))
      expect(rest.queries.map(row => [row.queryText, row.assessments.length, row.locations.length])).toEqual([['Acme reviews', 1, 1]])
      expect(rest.queryPage).toMatchObject({ total: 3, nextCursor: null })
      // The generated SDK repeats array parameters; a comma list is accepted too.
      const repeated = sentimentSummarySchema.parse(await get('?runId=r&include=assessments&include=locations'))
      expect(repeated.queries.map(row => [row.assessments.length, row.locations.length])).toEqual([[1, 1], [1, 1], [1, 1]])
      const named = sentimentSummarySchema.parse(await get('?runId=r&queryId=q-1'))
      expect(named.queries.map(row => [row.queryId, row.assessments.length])).toEqual([['q-1', 1]])
      const jobs = await get('/jobs')
      expect(jobs.jobs).toEqual([expect.objectContaining({ id: job.id, state: 'complete', attemptCount: 3, counts: expect.objectContaining({ favorable: 3 }) })])
      expect(jobs.jobs[0]).not.toHaveProperty('attempts')
      const page = await get(`/jobs/${job.id}?attemptLimit=2`)
      expect(page).toMatchObject({ attemptCount: 3, nextAttemptCursor: expect.any(String) })
      expect(page.attempts).toHaveLength(2)
      const last = await get(`/jobs/${job.id}?attemptLimit=2&attemptCursor=${encodeURIComponent(page.nextAttemptCursor)}`)
      expect(last).toMatchObject({ attemptCount: 3, nextAttemptCursor: null })
      expect([...page.attempts, ...last.attempts].map((attempt: { id: string }) => attempt.id).sort()).toEqual(service.job('p', job.id).attempts.map(attempt => attempt.id).sort())
    } finally { await app.close() }
  })

  it('never rescores a run captured before the project qualified an alias, and gives a later run its own subject', () => {
    service.configure('p', { enabled: true })
    const aliases = ['Acme Co', 'ACMENYC']
    simple('before', ['Acme reviews', 'Acme pricing'], null, ['openai'], { aliases }); admit('before'); finish()
    const classified = db.select({ snapshotId: sentimentWorkItems.snapshotId, subjectHash: sentimentWorkItems.subjectHash }).from(sentimentWorkItems).all()
    expect(classified).toHaveLength(2)

    // The live setting changes; the run's frozen sidecar does not.
    db.update(projects).set({ aliases, qualifiedAliases: ['ACMENYC'] }).where(eq(projects.id, 'p')).run()
    const preview = service.preview('p', { runId: 'before', queryClass: 'branded' })
    expect(preview).toMatchObject({ eligibleAssessments: 2, alreadyClassified: 2 })
    const job = service.submit('p', preview.previewToken!, 'before:after-opt-in', 'fixture')
    expect(job).toMatchObject({ state: 'complete', selected: 2 })
    expect(repository.claim({ owner: 'service-test', now: NOW, leaseMs: 30_000 })).toBeUndefined()
    expect(db.select({ snapshotId: sentimentWorkItems.snapshotId, subjectHash: sentimentWorkItems.subjectHash }).from(sentimentWorkItems).all()).toEqual(classified)

    // Same aliases, same answers: only the frozen qualified list differs.
    simple('after', ['Acme reviews', 'Acme pricing'], null, ['openai'], { aliases, qualifiedAliases: ['ACMENYC'] })
    expect(service.preview('p', { runId: 'after', queryClass: 'branded' })).toMatchObject({ eligibleAssessments: 2, alreadyClassified: 0 })
    admit('after')
    const fresh = db.select({ runId: sentimentWorkItems.runId, subjectHash: sentimentWorkItems.subjectHash, input: sentimentWorkItems.input }).from(sentimentWorkItems).all().filter(item => item.runId === 'after')
    expect(fresh).toHaveLength(2)
    for (const item of fresh) {
      expect(storedSentimentClassifierInputSchema.parse(item.input).subject.qualifiedAliases).toEqual(['ACMENYC'])
      expect(classified.map(prior => prior.subjectHash)).not.toContain(item.subjectHash)
    }
  })

  it('discloses every category of data a request sends to TypeSafe', () => {
    const { disclosure } = service.settings('p')
    for (const sent of ['answer\'s text', 'subject identity', 'qualified aliases', 'tracked query text', 'query class', 'answer engine', 'requested and served models', 'location', 'identifiers']) expect(disclosure).toContain(sent)
    expect(disclosure).not.toContain('\u2014')
  })
})
