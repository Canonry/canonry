import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSimpleMeasurementDefinition, canonicalMeasurementPlanV2Json, formatPercent, RatioUnits, rankCriticizedProperties, SENTIMENT_CRITICIZED_PROPERTY_LIMIT, sentimentBackfillPreviewSchema,
  sentimentEvidencePageSchema, sentimentOutcomeSchema, sentimentSelectionSchema, sentimentSummarySchema, sentimentOverviewSchema, storedSentimentClassifierInputSchema,
  type MeasurementPlanV2, type SentimentClassifierOutput, type SentimentEvidencePage, type SentimentOutcome, type SentimentSelection,
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
  it('refuses sentiment self-comparison before returning a no-change verdict', () => {
    simple('current', ['Acme reviews'])
    expect(() => service.compare('p', sentimentSelectionSchema.parse({}), 'current', 'current')).toThrow('two distinct runs')
  })

  it('resolves the previous rated run within the selected class', () => {
    service.configure('p', { enabled: true })
    for (const runId of ['older', 'unrated', 'probe', 'current']) simple(runId, ['Acme reviews', 'best services'])
    for (const runId of ['older', 'probe', 'current']) admit(runId)
    finish()
    for (const [runId, createdAt] of [['older', '2026-01-01'], ['unrated', '2026-01-02'], ['probe', '2026-01-03'], ['current', '2026-01-04']]) db.$client.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(createdAt, runId)
    db.$client.prepare("UPDATE runs SET trigger = 'probe' WHERE id = 'probe'").run()
    const selection = sentimentSelectionSchema.parse({})
    expect(service.compare('p', selection, 'previous-rated', 'current').from.selection.runId).toBe('older')
    expect(() => service.compare('p', sentimentSelectionSchema.parse({ queryClass: 'non-brand' }), 'previous-rated', 'current')).toThrow('No previous rated run')
  })

  it('skips unrated history before reconstructing previous-rated source populations', () => {
    service.configure('p', { enabled: true })
    simple('rated', ['Acme reviews']); admit('rated'); finish()
    db.update(runs).set({ createdAt: '2025-12-01' }).where(eq(runs.id, 'rated')).run()
    for (let index = 0; index < 40; index++) {
      const id = `unrated-${index}`
      simple(id, ['Acme reviews'])
      db.update(runs).set({ createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }).where(eq(runs.id, id)).run()
    }
    simple('current', ['Acme reviews']); admit('current'); finish()
    selections.count = 0
    expect(service.compare('p', sentimentSelectionSchema.parse({}), 'previous-rated', 'current')).toMatchObject({ from: { selection: { runId: 'rated' } }, verdict: 'no-clear-change' })
    expect(selections.count).toBeLessThanOrEqual(4)
  })

  it('distinguishes incompatible rated history and an incomplete comparison target', () => {
    service.configure('p', { enabled: true })
    simple('older', ['Acme reviews']); admit('older'); finish()
    db.update(runs).set({ createdAt: '2026-01-01' }).where(eq(runs.id, 'older')).run()
    simple('current', ['Acme reviews', 'Acme pricing']); admit('current'); finish()
    const selection = sentimentSelectionSchema.parse({})
    expect(() => service.compare('p', selection, 'previous-rated', 'current')).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'previous-rated-population-changed', newestRatedRunId: 'older' }) }))
    db.update(runs).set({ status: 'running' }).where(eq(runs.id, 'current')).run()
    expect(() => service.compare('p', selection, 'previous-rated', 'current')).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'target-incomplete' }) }))
  })

  it('bounds rated predecessor search without claiming older ratings do not exist', () => {
    service.configure('p', { enabled: true })
    simple('matching', ['Acme reviews']); admit('matching'); finish()
    db.update(runs).set({ createdAt: '2025-01-01' }).where(eq(runs.id, 'matching')).run()
    for (let index = 0; index < 55; index++) {
      const id = `different-${index}`
      simple(id, ['Acme pricing']); admit(id); finish()
      db.update(runs).set({ createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }).where(eq(runs.id, id)).run()
    }
    simple('current', ['Acme reviews']); admit('current'); finish()
    selections.count = 0
    // A candidate whose population differs is judged from its frozen source alone: only the
    // target resolves its evaluator and stored work.
    const resolve = vi.spyOn(SentimentService.prototype as unknown as { resolve: () => unknown }, 'resolve')
    try {
      expect(() => service.compare('p', sentimentSelectionSchema.parse({}), 'previous-rated', 'current')).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'previous-rated-search-limit', candidateLimit: 50 }) }))
      expect(resolve).toHaveBeenCalledTimes(1)
    } finally { resolve.mockRestore() }
    expect(selections.count).toBeLessThanOrEqual(51)
    expect(service.compare('p', sentimentSelectionSchema.parse({}), 'matching', 'current').verdict).toBe('no-clear-change')
  })

  it.each([
    { change: 'location', labels: ['Acme reviews'], location: 'Bayside', providers: ['openai'], identity: {} },
    { change: 'query text', labels: ['Acme support'], location: 'Harbor', providers: ['openai'], identity: {} },
    { change: 'provider', labels: ['Acme reviews'], location: 'Harbor', providers: ['gemini'], identity: {} },
    { change: 'subject identity', labels: ['Acme reviews'], location: 'Harbor', providers: ['openai'], identity: { aliases: ['Acme Services'] } },
    { change: 'query population', labels: ['Acme reviews', 'Acme support'], location: 'Harbor', providers: ['openai'], identity: {} },
  ])('skips a newer rated run with a different $change when resolving previous-rated', ({ labels, location, providers, identity }) => {
    service.configure('p', { enabled: true })
    simple('matching', ['Acme reviews'], 'Harbor')
    simple('different', labels, location, providers, identity)
    simple('current', ['Acme reviews'], 'Harbor')
    for (const runId of ['matching', 'different', 'current']) admit(runId)
    finish()
    for (const [runId, date] of [['matching', '2026-01-01'], ['different', '2026-01-02'], ['current', '2026-01-03']]) db.update(runs).set({ createdAt: date }).where(eq(runs.id, runId!)).run()
    const comparison = service.compare('p', sentimentSelectionSchema.parse({}), 'previous-rated', 'current')
    expect(comparison).toMatchObject({ from: { selection: { runId: 'matching' } }, commonUnits: 1, changedScope: false, refusalReasons: [], verdict: 'no-clear-change' })
  })

  it('matches the target source population before target sentiment admission', () => {
    service.configure('p', { enabled: true })
    simple('matching', ['Acme reviews'], 'Harbor'); admit('matching')
    simple('different', ['Acme reviews'], 'Bayside'); admit('different')
    simple('current', ['Acme reviews'], 'Harbor')
    finish()
    for (const [runId, date] of [['matching', '2026-01-01'], ['different', '2026-01-02'], ['current', '2026-01-03']]) db.update(runs).set({ createdAt: date }).where(eq(runs.id, runId!)).run()
    const comparison = service.compare('p', sentimentSelectionSchema.parse({}), 'previous-rated', 'current')
    expect(comparison.from.selection.runId).toBe('matching')
    expect(comparison.verdict).toBeNull()
    expect(comparison.refusalReasons).toContain('classification-coverage-gap')
  })

  it('labels compatibility sentiment as pooled and leads the overview with the branded population', async () => {
    service.configure('p', { enabled: true })
    simple('rated', ['Acme reviews', 'best services'])
    admit('rated'); admit('rated', 'non-brand'); finish()
    const result = await overviewSentiment()
    expect(result).toMatchObject({ headlineQueryClass: 'branded', branded: { selection: { queryClass: 'branded' } }, nonBrand: { selection: { queryClass: 'non-brand' } }, pooledOverall: { queryClass: 'all', pooled: true }, overall: { queryClass: 'all', pooled: true } })
    expect(result.pooledOverall).toEqual(result.overall)
  })

  it('distinguishes classified absent subjects from unrated source answers', () => {
    service.configure('p', { enabled: true })
    simple('non-brand', ['best services', 'local services', 'nearby services'])
    admit('non-brand', 'non-brand')
    finish(snapshotId => ({ outcome: snapshotId.endsWith('0') ? 'favorable' : 'subject-not-mentioned' }))
    expect(service.summary('p', sentimentSelectionSchema.parse({ runId: 'non-brand', queryClass: 'non-brand' })).coverage).toMatchObject({ eligibleAnswers: 3, ratedAnswers: 1, ratedAnswerRate: 0.33333333, subjectNotMentioned: 2, unadmittedAssessments: 0 })
  })

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
    service.configure('p', { enabled: true }); simple('r', ['Acme reviews', 'Acme complaints']); simple('previous', ['Acme reviews', 'Acme complaints']); admit('previous'); finish(); simple('queued', ['Acme reviews'])
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
      expect(() => service.compare('p', selection, 'r', 'r')).toThrow('two distinct runs')
      const comparison = service.compare('p', selection, 'previous', 'r')
      expect(comparison).toMatchObject({ verdict: null, from: { coverage: { judged: 0, counts: { favorable: 0, unfavorable: 0 } } }, to: { coverage: { judged: 0, counts: { favorable: 0, unfavorable: 0 } } } })
      expect(comparison.refusalReasons).toContain('sentiment-disabled')
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

/** The HTTP routes over the same database and preview secret, so a cursor moves between the service and HTTP. */
async function routes() {
  const app = Fastify(); app.register(apiRoutes, { db, sentiment: options }); await app.ready()
  const get = (path: string) => app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer cnry_service-root' } })
  return { app, get }
}
const EVIDENCE = '/api/v1/projects/p/sentiment/evidence'
/** Each evidence item as `snapshot:outcome`, sorted: assessment IDs, and so page order, are opaque. */
const answersOf = (page: SentimentEvidencePage) => page.items.map(item => `${item.sourceSnapshotId}:${item.outcome}`).sort()

describe('sentiment evidence outcome filter', () => {
  // One branded answer per query, q-0 to q-6, rated in this order.
  const OUTCOMES: SentimentOutcome[] = ['favorable', 'mixed', 'unfavorable', 'factual', 'mixed', 'unfavorable', 'favorable']
  const CRITICIZED = ['r-q-1:mixed', 'r-q-2:unfavorable', 'r-q-4:mixed', 'r-q-5:unfavorable']
  function seed(): SentimentSelection {
    service.configure('p', { enabled: true })
    simple('r', OUTCOMES.map((_, index) => `Acme topic ${index}`)); admit('r')
    finish(snapshotId => ({ outcome: OUTCOMES[Number(snapshotId.split('-').at(-1))]! }))
    return sentimentSelectionSchema.parse({ runId: 'r' })
  }

  it('returns exactly the assessments with the requested outcomes and echoes the set sorted', () => {
    const selection = seed()
    const all = sentimentEvidencePageSchema.parse(service.evidence('p', selection, 100))
    expect(all.selection).not.toHaveProperty('outcome')
    expect(answersOf(all)).toEqual(['r-q-0:favorable', 'r-q-1:mixed', 'r-q-2:unfavorable', 'r-q-3:factual', 'r-q-4:mixed', 'r-q-5:unfavorable', 'r-q-6:favorable'])
    const criticized = sentimentEvidencePageSchema.parse(service.evidence('p', { ...selection, outcome: ['unfavorable', 'mixed', 'unfavorable'] }, 100))
    expect(criticized.selection.outcome).toEqual(['mixed', 'unfavorable'])
    expect(answersOf(criticized)).toEqual(CRITICIZED)
    // The filter only drops other outcomes: the same items, verdicts and order as the unfiltered page.
    expect(criticized.items).toEqual(all.items.filter(item => item.outcome === 'mixed' || item.outcome === 'unfavorable'))
    expect(criticized.state).toBe('complete')
    // The page holds what the summary counts as mixed plus unfavorable.
    const { counts } = service.summary('p', selection).coverage
    expect([counts.mixed, counts.unfavorable, criticized.items.length]).toEqual([2, 2, 4])
    for (const [outcome, expected] of [[['favorable'], ['r-q-0:favorable', 'r-q-6:favorable']], [['factual'], ['r-q-3:factual']], [['pending', 'failed'], []]] as const) {
      const page = service.evidence('p', { ...selection, outcome: [...outcome] }, 100)
      expect(answersOf(page), outcome.join()).toEqual(expected)
      expect(page.selection.outcome).toEqual([...outcome].sort())
    }
    // Every outcome at once is the unfiltered population.
    expect(service.evidence('p', { ...selection, outcome: [...sentimentOutcomeSchema.options] }, 100).items).toEqual(all.items)
    // It narrows an exact assessmentId too, never widens it.
    const mixed = all.items.find(item => item.sourceSnapshotId === 'r-q-1')!
    expect(service.evidence('p', { ...selection, assessmentId: mixed.assessmentId, outcome: ['mixed'] }, 100).items).toEqual([mixed])
    expect(service.evidence('p', { ...selection, assessmentId: mixed.assessmentId, outcome: ['unfavorable'] }, 100).items).toEqual([])
  })

  it('pages every match once and binds the cursor to the outcome set', () => {
    const selection = seed()
    const filter: SentimentSelection & { outcome: SentimentOutcome[] } = { ...selection, outcome: ['mixed', 'unfavorable'] }
    const whole = service.evidence('p', filter, 100)
    const pages = [service.evidence('p', filter, 1)]
    while (pages.at(-1)!.nextCursor) pages.push(service.evidence('p', filter, 1, pages.at(-1)!.nextCursor!))
    expect(pages.map(page => page.items.length)).toEqual([1, 1, 1, 1])
    expect(pages.flatMap(page => page.items)).toEqual(whole.items)
    expect(new Set(pages.flatMap(page => page.items.map(item => item.assessmentId))).size).toBe(4)
    const first = service.evidence('p', filter, 3)
    expect(first.items).toEqual(whole.items.slice(0, 3))
    const rest = service.evidence('p', filter, 3, first.nextCursor!)
    expect([rest.items, rest.nextCursor]).toEqual([whole.items.slice(3), null])
    // The cursor binds the set, not the order or repetition it was written with.
    expect(service.evidence('p', { ...selection, outcome: ['unfavorable', 'mixed', 'mixed'] }, 3, first.nextCursor!).items).toEqual(rest.items)
    for (const outcome of [['mixed'], ['unfavorable'], ['favorable', 'mixed', 'unfavorable'], null] as const) {
      expect(() => service.evidence('p', { ...selection, ...(outcome ? { outcome: [...outcome] } : {}) }, 3, first.nextCursor!), String(outcome)).toThrow('Evidence cursor does not match the resolved selection.')
    }
    // An unfiltered cursor walks the unfiltered population and refuses a filter.
    const unfiltered = service.evidence('p', selection, 3)
    expect(() => service.evidence('p', filter, 3, unfiltered.nextCursor!)).toThrow('Evidence cursor does not match the resolved selection.')
    expect(service.evidence('p', selection, 3, unfiltered.nextCursor!).items).toHaveLength(3)
  })

  it('accepts a comma list or repeated values over HTTP with identical pages and rejects unknown outcomes', async () => {
    const selection = seed()
    const { app, get } = await routes()
    try {
      const ok = async (path: string) => {
        const response = await get(path)
        expect(response.statusCode, response.body).toBe(200)
        return sentimentEvidencePageSchema.parse(response.json())
      }
      const comma = await ok(`${EVIDENCE}?runId=r&outcome=unfavorable,mixed`)
      expect(comma.selection.outcome).toEqual(['mixed', 'unfavorable'])
      expect(answersOf(comma)).toEqual(CRITICIZED)
      expect(await ok(`${EVIDENCE}?runId=r&outcome=mixed&outcome=unfavorable`)).toEqual(comma)
      expect(await ok(`${EVIDENCE}?runId=r&outcome=${encodeURIComponent(' unfavorable , mixed ')}`)).toEqual(comma)
      expect(await ok(`${EVIDENCE}?runId=r&outcome=mixed&outcome=unfavorable&outcome=mixed`)).toEqual(comma)
      expect(comma).toEqual(JSON.parse(JSON.stringify(service.evidence('p', { ...selection, outcome: ['mixed', 'unfavorable'] }, 50))))
      const plain = await ok(`${EVIDENCE}?runId=r`)
      expect(plain.items).toHaveLength(7)
      expect(plain.selection).not.toHaveProperty('outcome')
      // A cursor follows the same set in either wire form and refuses any other.
      const page = await ok(`${EVIDENCE}?runId=r&outcome=mixed,unfavorable&limit=2`)
      const cursor = encodeURIComponent(page.nextCursor!)
      const next = await ok(`${EVIDENCE}?runId=r&outcome=unfavorable&outcome=mixed&limit=2&cursor=${cursor}`)
      expect([...page.items, ...next.items]).toEqual(comma.items)
      expect(next.nextCursor).toBeNull()
      for (const changed of ['&outcome=mixed', '&outcome=mixed,unfavorable,favorable', '']) {
        const response = await get(`${EVIDENCE}?runId=r&limit=2&cursor=${cursor}${changed}`)
        expect(response.statusCode, changed).toBe(400)
        expect(response.json().error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Evidence cursor does not match the resolved selection.' })
      }
      for (const invalid of ['outcome=positive', 'outcome=mixed,positive', 'outcome=mixed&outcome=positive', 'outcome=', 'outcome=,', 'outcome=Mixed']) {
        const response = await get(`${EVIDENCE}?runId=r&${invalid}`)
        expect(response.statusCode, invalid).toBe(400)
        expect(response.json().error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/^Invalid sentiment request: /) })
        expect(response.json().error.details.issues.map((issue: { path: unknown[] }) => issue.path[0]), invalid).toContain('outcome')
      }
      // The filter narrows evidence only; the summary refuses it.
      expect((await get('/api/v1/projects/p/sentiment?runId=r&outcome=mixed')).statusCode).toBe(400)
      // The spec declares the repeated form the generated SDK sends.
      const spec = (await get('/api/v1/openapi.json')).json()
      const parameters: Array<{ name: string }> = spec.paths['/api/v1/projects/{name}/sentiment/evidence'].get.parameters
      expect(parameters.map(parameter => parameter.name).slice(-4)).toEqual(['assessmentId', 'outcome', 'cursor', 'limit'])
      expect(parameters.find(parameter => parameter.name === 'outcome')).toMatchObject({ in: 'query', style: 'form', explode: true, schema: { type: 'array', minItems: 1, items: { type: 'string', enum: [...sentimentOutcomeSchema.options] } } })
      expect(spec.paths['/api/v1/projects/{name}/sentiment'].get.parameters.map((parameter: { name: string }) => parameter.name)).not.toContain('outcome')
    } finally { await app.close() }
  })

  it('still returns no items while sentiment is off, echoing the filter', async () => {
    const selection = seed()
    const filter: SentimentSelection & { outcome: SentimentOutcome[] } = { ...selection, outcome: ['unfavorable', 'mixed'] }
    expect(service.evidence('p', filter, 50).items).toHaveLength(4)
    for (const disable of [() => service.configure('p', { enabled: false }), () => { service.configure('p', { enabled: true }); install.enabled = false }]) {
      disable()
      expect(service.evidence('p', filter, 50)).toMatchObject({ state: 'disabled', items: [], nextCursor: null, selection: { runId: 'r', outcome: ['mixed', 'unfavorable'] } })
      const { app, get } = await routes()
      try {
        const response = await get(`${EVIDENCE}?runId=r&outcome=mixed,unfavorable`)
        expect(response.statusCode, response.body).toBe(200)
        expect(response.json()).toMatchObject({ state: 'disabled', items: [], nextCursor: null, selection: { outcome: ['mixed', 'unfavorable'] } })
      } finally { await app.close() }
    }
  })
})

describe('most criticized Properties on the branded summary', () => {
  /** Branded outcomes of each Property's six answers (three branded queries on two engines), in plan order. */
  const PROPERTIES: Array<{ key: string; label: string; outcomes: SentimentOutcome[] }> = [
    { key: 'praised', label: 'Praised Homes', outcomes: ['favorable', 'favorable', 'favorable', 'favorable', 'favorable', 'favorable'] },
    { key: 'a-willow', label: 'Willow Homes', outcomes: ['mixed', 'mixed', 'favorable', 'factual', 'factual', 'factual'] },
    { key: 'z-aspen', label: 'Aspen Homes', outcomes: ['mixed', 'mixed', 'favorable', 'factual', 'factual', 'factual'] },
    { key: 'unliked', label: 'Unliked Homes', outcomes: ['unfavorable', 'mixed', 'mixed', 'factual', 'factual', 'factual'] },
    { key: 'well-liked', label: 'Well Liked Homes', outcomes: ['unfavorable', 'mixed', 'mixed', 'favorable', 'favorable', 'favorable'] },
    { key: 'mostly-mixed', label: 'Mostly Mixed Homes', outcomes: ['unfavorable', 'mixed', 'mixed', 'mixed', 'favorable', 'favorable'] },
    { key: 'mostly-unfavorable', label: 'Mostly Unfavorable Homes', outcomes: ['unfavorable', 'unfavorable', 'unfavorable', 'mixed', 'favorable', 'favorable'] },
  ]
  /** [key, label, mixed, unfavorable, favorable, selected] of each branded Property row, by key. */
  const BRANDED_ROWS = [
    ['a-willow', 'Willow Homes', 2, 0, 1, 6], ['mostly-mixed', 'Mostly Mixed Homes', 3, 1, 2, 6], ['mostly-unfavorable', 'Mostly Unfavorable Homes', 1, 3, 2, 6], ['praised', 'Praised Homes', 0, 0, 6, 6],
    ['unliked', 'Unliked Homes', 2, 1, 0, 6], ['well-liked', 'Well Liked Homes', 2, 1, 3, 6], ['z-aspen', 'Aspen Homes', 2, 0, 1, 6],
  ]
  // 4 criticisms (3 unfavorable before 1), 3 (none favorable before 3), then the 2/0/1 tie by label: Aspen before Willow, which is sixth.
  const RANKED = ['mostly-unfavorable', 'mostly-mixed', 'unliked', 'well-liked', 'z-aspen']
  /** Non-brand answers criticize two Properties; the branded ranking must never see them. */
  const NON_BRAND = ['praised', 'a-willow']
  const PROVIDERS = ['openai', 'gemini']
  const ANSWER_TEXT = `Northstar compares ${PROPERTIES.map(property => property.label).join(', ')}.`
  const properties = (summary: { breakdowns: Array<{ dimension: string; key: string; label: string; coverage: { selected: number; counts: Record<SentimentOutcome, number> } }> }) =>
    summary.breakdowns.filter(row => row.dimension === 'property').sort((left, right) => left.key.localeCompare(right.key))
      .map(row => [row.key, row.label, row.coverage.counts.mixed, row.coverage.counts.unfavorable, row.coverage.counts.favorable, row.coverage.selected])

  function plan(): MeasurementPlanV2 {
    const context = { providers: PROVIDERS, models: {}, location: HARBOR_CONTEXT }
    const branded = [0, 1, 2].map(index => ({ stableKey: `exec-brand-${index}`, queryId: `q-brand-${index}`, queryText: `northstar review ${index}`, context, expectedSnapshots: PROVIDERS.length }))
    const nearby = { stableKey: 'exec-nearby', queryId: 'q-nearby', queryText: 'homes near harbor', context, expectedSnapshots: PROVIDERS.length }
    const brandedEdges = branded.flatMap(node => PROPERTIES.map(property => ({ executionNodeKey: node.stableKey, targetKey: property.key, queryId: node.queryId })))
    const nearbyEdges = NON_BRAND.map(targetKey => ({ executionNodeKey: nearby.stableKey, targetKey, queryId: nearby.queryId }))
    return measurementPlanV2Fixture({
      targets: PROPERTIES.map(property => ({ stableKey: property.key, label: property.label, aliases: [property.label], urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: `/locations/${property.key}`, pathCase: 'insensitive' }], mentionNotApplicable: false, discoveryIdentity: null })),
      groups: [{ stableKey: 'portfolio', label: 'Portfolio', targetKeys: PROPERTIES.map(property => property.key), competitors: [] }],
      querySnapshots: [...branded, nearby].map(node => ({ queryId: node.queryId, queryText: node.queryText, provenance: { source: 'manual', sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' } })),
      assignments: [...brandedEdges.map(edge => ({ ...edge, queryClass: 'branded' as const })), ...nearbyEdges.map(edge => ({ ...edge, queryClass: 'non-brand' as const }))],
      executionNodes: [...branded, nearby],
      usageEdges: [...brandedEdges, ...nearbyEdges],
    })
  }
  /** One completed Advanced sweep at `revision`, admitted in both classes and rated by the script above. */
  function sweep(runId: string, revision: number) {
    const frozen = plan()
    const versionId = `plan-${revision}`
    if (!db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionId)).get()) {
      db.insert(measurementPlanVersions).values({ id: versionId, projectId: 'p', revision, canonicalJson: canonicalMeasurementPlanV2Json(frozen), checksum: versionId, schemaVersion: 2, compiledChecksum: frozen.compiledChecksum, createdAt: NOW }).run()
    }
    db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: versionId, measurementManifest: buildMeasurementPlanV2Manifest(frozen), measurementExecutionIdentity: { schemaVersion: 1, language: 'en', providers: PROVIDERS, models: {}, checksum: `${runId}-identity` }, createdAt: NOW }).run()
    const scripted = new Map<string, number | null>()
    for (const node of frozen.executionNodes) PROVIDERS.forEach((provider, slot) => {
      const id = `${runId}-${node.stableKey}-${provider}`
      db.insert(querySnapshots).values({ id, runId, measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: `${provider}-requested`, servedModel: `${provider}-served`, answerText: ANSWER_TEXT, citationState: 'cited', createdAt: NOW }).run()
      const brand = /^exec-brand-(\d)$/.exec(node.stableKey)
      scripted.set(id, brand ? Number(brand[1]) * PROVIDERS.length + slot : null)
    })
    admit(runId); admit(runId, 'non-brand')
    finish((snapshotId, subjectId) => {
      const index = scripted.get(snapshotId)
      if (index === undefined) throw new Error(`Unscripted snapshot ${snapshotId}`)
      return { outcome: index === null ? 'unfavorable' : PROPERTIES.find(property => property.key === subjectId)!.outcomes[index]! }
    })
  }

  it('resolves previous-rated within an explicit Advanced revision and Property scope', () => {
    service.configure('p', { enabled: true })
    sweep('matching', 1); sweep('different-revision', 2); sweep('current', 1)
    for (const [runId, date] of [['matching', '2026-01-01'], ['different-revision', '2026-01-02'], ['current', '2026-01-03']]) db.update(runs).set({ createdAt: date }).where(eq(runs.id, runId!)).run()
    const comparison = service.compare('p', sentimentSelectionSchema.parse({ revision: 1, scope: 'property', scopeKey: 'mostly-unfavorable' }), 'previous-rated', 'current')
    expect(comparison).toMatchObject({ from: { selection: { runId: 'matching', revision: 1, scope: 'property', scopeKey: 'mostly-unfavorable' } }, commonUnits: 6, changedScope: false, refusalReasons: [] })
  })

  it('ranks a branded multi-Property read by criticism count and ties every listed Property to its answers', async () => {
    service.configure('p', { enabled: true }); sweep('advanced', 1)
    const selection = sentimentSelectionSchema.parse({ runId: 'advanced' })
    const summary = sentimentSummarySchema.parse(service.summary('p', selection))
    expect(properties(summary)).toEqual(BRANDED_ROWS)
    expect(summary.criticizedProperties).toEqual({ total: 6, keys: RANKED })
    expect(RANKED).toHaveLength(SENTIMENT_CRITICIZED_PROPERTY_LIMIT)
    // Every key is a Property row of the same response.
    expect(RANKED.every(key => summary.breakdowns.some(row => row.dimension === 'property' && row.key === key))).toBe(true)
    // Paging query rows never moves the ranking.
    const paged = service.summary('p', selection, { queryLimit: 1 })
    expect(paged.queryPage).toMatchObject({ total: 3, limit: 1 })
    expect(paged.criticizedProperties).toEqual(summary.criticizedProperties)
    expect(service.summary('p', selection, { queryLimit: 1, queryCursor: paged.queryPage.nextCursor! }).criticizedProperties).toEqual(summary.criticizedProperties)
    // Each Property's View answers page holds exactly its mixed and unfavorable assessments.
    for (const [key, , mixed, unfavorable] of BRANDED_ROWS as Array<[string, string, number, number]>) {
      const page = service.evidence('p', { ...selection, scope: 'property', scopeKey: key, outcome: ['mixed', 'unfavorable'] }, 100)
      expect(page.items.map(item => item.outcome).sort(), key).toEqual([...Array<string>(mixed).fill('mixed'), ...Array<string>(unfavorable).fill('unfavorable')])
    }
    // View all unfavorable and mixed answers: the 12 mixed and 6 unfavorable of the 42 branded assessments.
    expect(summary.coverage).toMatchObject({ selected: 42, judged: 33, counts: { favorable: 15, mixed: 12, unfavorable: 6, factual: 9 } })
    const pages = [service.evidence('p', { ...selection, outcome: ['mixed', 'unfavorable'] }, 5)]
    while (pages.at(-1)!.nextCursor) pages.push(service.evidence('p', { ...selection, outcome: ['mixed', 'unfavorable'] }, 5, pages.at(-1)!.nextCursor!))
    expect(pages.map(page => page.items.length)).toEqual([5, 5, 5, 3])
    expect(new Set(pages.flatMap(page => page.items.map(item => item.assessmentId))).size).toBe(18)
    expect(pages.flatMap(page => page.items.map(item => item.outcome)).filter(outcome => outcome === 'mixed')).toHaveLength(12)
    const { app, get } = await routes()
    try {
      const response = await get('/api/v1/projects/p/sentiment?runId=advanced')
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json().criticizedProperties).toEqual({ total: 6, keys: RANKED })
    } finally { await app.close() }
  })

  it('lists no Property when the read spans one Property, Simple or Advanced', async () => {
    service.configure('p', { enabled: true }); sweep('advanced', 1)
    const scoped = service.summary('p', sentimentSelectionSchema.parse({ runId: 'advanced', scope: 'property', scopeKey: 'mostly-unfavorable' }))
    // The one Property in view is criticized four times, but there is nothing to rank it against.
    expect(properties(scoped)).toEqual([['mostly-unfavorable', 'Mostly Unfavorable Homes', 1, 3, 2, 6]])
    expect(scoped.criticizedProperties).toEqual({ total: 0, keys: [] })
    simple('solo', ['Acme reviews'], null, ['openai', 'gemini']); admit('solo')
    finish(snapshotId => ({ outcome: snapshotId.endsWith('-gemini') ? 'unfavorable' : 'mixed' }))
    const solo = sentimentSummarySchema.parse(service.summary('p', sentimentSelectionSchema.parse({ runId: 'solo' })))
    expect(properties(solo)).toEqual([['p', 'Acme', 1, 1, 0, 2]])
    expect(solo.criticizedProperties).toEqual({ total: 0, keys: [] })
    const { app, get } = await routes()
    try {
      expect((await get('/api/v1/projects/p/sentiment?runId=solo')).json().criticizedProperties).toEqual({ total: 0, keys: [] })
    } finally { await app.close() }
  })

  it('never ranks non-brand Properties, though their answers criticize two', async () => {
    service.configure('p', { enabled: true }); sweep('advanced', 1)
    const nonBrand = sentimentSummarySchema.parse(service.summary('p', sentimentSelectionSchema.parse({ runId: 'advanced', queryClass: 'non-brand' })))
    expect(properties(nonBrand)).toEqual([['a-willow', 'Willow Homes', 0, 2, 0, 2], ['praised', 'Praised Homes', 0, 2, 0, 2]])
    // The rows would rank; the server leaves non-brand unranked by design.
    expect(rankCriticizedProperties(nonBrand.breakdowns)).toEqual({ total: 2, keys: ['praised', 'a-willow'] })
    expect(nonBrand.criticizedProperties).toBeUndefined()
    expect(service.summary('p', sentimentSelectionSchema.parse({ runId: 'advanced', queryClass: 'non-brand' }), { queryLimit: 5 }).criticizedProperties).toBeUndefined()
    const { app, get } = await routes()
    try {
      const response = await get('/api/v1/projects/p/sentiment?runId=advanced&queryClass=non-brand')
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).not.toHaveProperty('criticizedProperties')
    } finally { await app.close() }
  })

  it('withholds the ranking while sentiment is off', async () => {
    service.configure('p', { enabled: true }); sweep('advanced', 1)
    const selection = sentimentSelectionSchema.parse({ runId: 'advanced' })
    for (const disable of [() => service.configure('p', { enabled: false }), () => { service.configure('p', { enabled: true }); install.enabled = false }]) {
      disable()
      const summary = service.summary('p', selection)
      expect(summary).toMatchObject({ state: 'disabled', coverage: { selected: 42, judged: 0, counts: { mixed: 0, unfavorable: 0 } } })
      expect(summary.criticizedProperties).toBeUndefined()
      const { app, get } = await routes()
      try {
        const response = await get('/api/v1/projects/p/sentiment?runId=advanced')
        expect(response.statusCode, response.body).toBe(200)
        expect(response.json()).not.toHaveProperty('criticizedProperties')
      } finally { await app.close() }
    }
    install.enabled = true
    expect(service.summary('p', selection).criticizedProperties).toEqual({ total: 6, keys: RANKED })
  })

  it('omits the ranking from comparison periods, which score matched units only', () => {
    service.configure('p', { enabled: true }); sweep('advanced', 1); sweep('later', 1)
    for (const runId of ['advanced', 'later']) expect(service.summary('p', sentimentSelectionSchema.parse({ runId })).criticizedProperties, runId).toEqual({ total: 6, keys: RANKED })
    const comparison = service.compare('p', sentimentSelectionSchema.parse({}), 'advanced', 'later')
    expect(comparison.from).not.toHaveProperty('criticizedProperties')
    expect(comparison.to).not.toHaveProperty('criticizedProperties')
    // Everything else about a period is unchanged by the omission.
    expect(comparison.from.coverage.judged).toBe(service.summary('p', sentimentSelectionSchema.parse({ runId: 'advanced' })).coverage.judged)
  })

  it('drops the ranking from an unavailable pooled read', async () => {
    service.configure('p', { enabled: true }); sweep('advanced', 1); sweep('later', 2)
    for (const runId of ['advanced', 'later']) expect(service.summary('p', sentimentSelectionSchema.parse({ runId })).criticizedProperties, runId).toEqual({ total: 6, keys: RANKED })
    const pooled = service.summary('p', sentimentSelectionSchema.parse({ runIds: ['advanced', 'later'] }))
    expect(pooled).toMatchObject({ state: 'unsupported', reason: 'measurement-revision-changed', score: { favorableRate: null } })
    expect(pooled.breakdowns.filter(row => row.dimension === 'property').map(row => row.state)).toEqual(Array(7).fill('unsupported'))
    expect(pooled.criticizedProperties).toBeUndefined()
    const { app, get } = await routes()
    try {
      const response = await get('/api/v1/projects/p/sentiment?runIds=advanced&runIds=later')
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ state: 'unsupported', reason: 'measurement-revision-changed' })
      expect(response.json()).not.toHaveProperty('criticizedProperties')
    } finally { await app.close() }
  })
})

describe('previous-rated within a scope rated only elsewhere', () => {
  const PROVIDERS = ['openai', 'gemini']
  const nearby = (targetKey: string) => ({ executionNodeKey: 'exec-nearby', targetKey, queryId: 'q-nearby' })
  /** Harbor and Bayside share the non-brand node; the extra group and one market hold Bayside alone. Revision 2 adds a Bayside non-brand edge. */
  function plan(revision: number): MeasurementPlanV2 {
    const base = measurementPlanV2Fixture()
    const added = { executionNodeKey: 'exec-brand', targetKey: 'bayside', queryId: 'q-brand' }
    return measurementPlanV2Fixture({
      groups: [...base.groups, { stableKey: 'bayside-only', label: 'Bayside only', targetKeys: ['bayside'], competitors: [] }],
      reportingScopes: [
        { stableKey: 'harbor-market', label: 'Harbor market', kind: 'market', usageEdges: [nearby('harbor')] },
        { stableKey: 'bayside-market', label: 'Bayside market', kind: 'market', usageEdges: [nearby('bayside')] },
      ],
      ...(revision === 2 ? { assignments: [...base.assignments, { ...added, queryClass: 'non-brand' as const }], usageEdges: [...base.usageEdges, added] } : {}),
    })
  }
  /** One completed non-brand sweep. Only Harbor's ChatGPT answers are rated; every other assessment abstains. */
  function sweep(runId: string, createdAt: string, revision = 1) {
    const frozen = plan(revision)
    const versionId = `plan-${revision}`
    if (!db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionId)).get()) {
      db.insert(measurementPlanVersions).values({ id: versionId, projectId: 'p', revision, canonicalJson: canonicalMeasurementPlanV2Json(frozen), checksum: versionId, schemaVersion: 2, compiledChecksum: frozen.compiledChecksum, createdAt: NOW }).run()
    }
    db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: versionId, measurementManifest: buildMeasurementPlanV2Manifest(frozen), measurementExecutionIdentity: { schemaVersion: 1, language: 'en', providers: PROVIDERS, models: {}, checksum: `${runId}-identity` }, createdAt }).run()
    for (const node of frozen.executionNodes) for (const provider of PROVIDERS) {
      db.insert(querySnapshots).values({ id: `${runId}-${node.stableKey}-${provider}`, runId, measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: `${provider}-requested`, servedModel: `${provider}-served`, answerText: 'Harbor Homes is great.', citationState: 'cited', createdAt }).run()
    }
    admit(runId, 'non-brand')
    finish((snapshotId, subjectId) => ({ outcome: subjectId === 'harbor' && snapshotId.endsWith('-openai') ? 'favorable' : 'subject-not-mentioned' }))
  }
  const day = (index: number) => new Date(Date.UTC(2026, 0, index + 1)).toISOString()
  const unavailable = expect.objectContaining({ details: { reason: 'previous-rated-run-unavailable' } })

  it.each([
    { name: 'Property', selection: { scope: 'property', scopeKey: 'bayside' } },
    { name: 'group', selection: { scope: 'group', scopeKey: 'bayside-only' } },
    { name: 'market scope', selection: { scope: 'market', scopeKey: 'bayside-market' } },
    { name: 'market filter', selection: { marketKey: 'bayside-market' } },
    { name: 'engine', selection: { provider: 'gemini' } },
    { name: 'engine within a rated Property', selection: { scope: 'property', scopeKey: 'harbor', provider: 'gemini' } },
  ])('reports no previous rated run for a never-rated $name past the candidate limit', ({ selection }) => {
    service.configure('p', { enabled: true })
    for (let index = 0; index < 55; index++) sweep(`history-${index}`, day(index))
    sweep('current', NOW)
    const query = sentimentSelectionSchema.parse({ queryClass: 'non-brand', ...selection })
    selections.count = 0
    expect(() => service.compare('p', query, 'previous-rated', 'current')).toThrowError(unavailable)
    // Runs rated only outside the selection never reach source reconstruction: only the target is selected.
    expect(selections.count).toBe(1)
    expect(service.compare('p', sentimentSelectionSchema.parse({ queryClass: 'non-brand', scope: 'property', scopeKey: 'harbor', provider: 'openai' }), 'previous-rated', 'current').from.selection.runId).toBe('history-54')
  })

  it.each([
    { name: 'Property and engine', selection: { scope: 'property', scopeKey: 'harbor', provider: 'openai' } },
    { name: 'group', selection: { scope: 'group', scopeKey: 'regional' } },
    { name: 'market scope', selection: { scope: 'market', scopeKey: 'harbor-market' } },
    { name: 'market filter', selection: { marketKey: 'harbor-market' } },
    { name: 'query', selection: { queryId: 'q-nearby' } },
    { name: 'execution node', selection: { executionNodeKey: 'exec-nearby' } },
    { name: 'served model', selection: { model: 'openai-served' } },
    { name: 'location', selection: { location: 'Harbor' } },
  ])('still finds the newest run rated within a $name selection', ({ selection }) => {
    service.configure('p', { enabled: true })
    for (let index = 0; index < 3; index++) sweep(`history-${index}`, day(index))
    sweep('current', NOW)
    expect(service.compare('p', sentimentSelectionSchema.parse({ queryClass: 'non-brand', ...selection }), 'previous-rated', 'current').from.selection.runId).toBe('history-2')
  })

  it('does not report a population change from runs rated only for another Property', () => {
    service.configure('p', { enabled: true })
    for (let index = 0; index < 5; index++) sweep(`history-${index}`, day(index))
    sweep('current', NOW, 2)
    expect(() => service.compare('p', sentimentSelectionSchema.parse({ queryClass: 'non-brand', scope: 'property', scopeKey: 'bayside' }), 'previous-rated', 'current')).toThrowError(unavailable)
    expect(service.compare('p', sentimentSelectionSchema.parse({ queryClass: 'non-brand', scope: 'property', scopeKey: 'harbor' }), 'previous-rated', 'current').from.selection.runId).toBe('history-4')
  })
})
