import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSimpleMeasurementDefinition, canonicalMeasurementPlanV2Json, createSentimentEvaluationDefinition,
  sentimentSelectionSchema, sentimentSummarySchema, storedSentimentClassifierInputSchema,
  type SentimentClassifierOutput, type SentimentOutcome,
} from '@ainyc/canonry-contracts'
import {
  apiKeys, createClient, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs,
  sentimentAttempts, sentimentDefinitions, sentimentJobs, sentimentWorkItems, simpleMeasurementDefinitions, SentimentRepository, type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { SentimentService } from '../src/sentiment-service.js'
import { sentimentClassifierInput, sentimentHash } from '../src/sentiment-input.js'
import { selectSentimentSources } from '../src/sentiment-source.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-09-28T00:00:00.000Z'
let db: DatabaseClient
let service: SentimentService
let repository: SentimentRepository
const options = { install: () => ({ enabled: true, ready: true, reason: null, model: 'jev-1.13.0' }), now: () => new Date(NOW), previewSecret: 'headlines-test-secret' }
beforeEach(() => {
  db = createClient(':memory:'); migrate(db)
  db.insert(projects).values({ id: 'p', name: 'p', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
  service = new SentimentService(db, options); repository = new SentimentRepository(db)
  service.configure('p', { enabled: true })
})
afterEach(() => db.$client.close())

function simple(runId: string, labels = ['Acme reviews', 'best service options'], location: string | null = null, domain = 'acme.example', providers = ['openai'], identity: { aliases?: string[]; qualifiedAliases?: string[] } = {}) {
  db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', location, createdAt: NOW }).run()
  const frozen = labels.map((queryText, index) => ({ queryId: `q-${index}`, queryText, provenance: null }))
  for (const query of frozen) db.insert(queries).values({ id: query.queryId, projectId: 'p', query: query.queryText, createdAt: NOW }).onConflictDoNothing().run()
  const definition = buildSimpleMeasurementDefinition({ capturedAt: NOW, identity: { displayName: 'Acme', aliases: identity.aliases ?? ['Acme Co'], canonicalDomain: domain, ownedDomains: [], qualifiedAliases: identity.qualifiedAliases }, country: 'US', language: 'en', location: location ? { label: location, city: location, region: 'EX', country: 'US' } : null, engines: providers.map(provider => ({ provider, requestedModel: provider === 'openai' ? 'source-model' : `${provider}-requested` })), queries: frozen })
  db.insert(simpleMeasurementDefinitions).values({ runId, projectId: 'p', definition, checksum: runId, capturedAt: NOW }).run()
  for (const query of frozen) for (const provider of providers) db.insert(querySnapshots).values({ id: `${runId}-${query.queryId}${provider === 'openai' ? '' : `-${provider}`}`, runId, queryId: query.queryId, queryText: query.queryText, location, provider, model: provider === 'openai' ? 'source-model' : `${provider}-requested`, servedModel: provider === 'openai' ? 'served-model' : `${provider}-served`, answerText: 'Acme Co offers excellent service.', citationState: 'cited', createdAt: NOW }).run()
}
function finish(outcomes: Record<string, SentimentOutcome> = {}) {
  for (;;) {
    const work = repository.claim({ owner: 'headlines', now: NOW, leaseMs: 30_000 })
    if (!work) break
    const input = storedSentimentClassifierInputSchema.parse(work.input)
    const outcome = outcomes[`${work.snapshotId}:${input.subject.id}`] ?? outcomes[work.snapshotId] ?? 'favorable'
    const common = { returnedModel: 'jev-1.13.0', usage: { kind: 'reported' as const, inputTokens: 10, outputTokens: 1 } }
    const result: SentimentClassifierOutput = ['favorable', 'mixed', 'unfavorable'].includes(outcome)
      ? { ...common, kind: 'classified', outcome, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null }
      : { ...common, kind: 'abstained', outcome, reason: 'Offline fixture exclusion.' }
    expect(repository.completeWork({ workItemId: work.id, owner: 'headlines', now: NOW, outcome, result, returnedModel: result.returnedModel })).toBe(true)
  }
}
function admit(runId: string, queryClass: 'branded' | 'non-brand', extra = {}) {
  const preview = service.preview('p', { runId, queryClass, ...extra })
  return service.submit('p', preview.previewToken!, `${runId}:${queryClass}:${JSON.stringify(extra)}`, 'fixture')
}
function summary(runId: string, queryClass: 'branded' | 'non-brand', extra = {}) {
  return sentimentSummarySchema.parse(service.summary('p', sentimentSelectionSchema.parse({ runId, queryClass, ...extra })))
}

describe('class-separated sentiment headlines', () => {
  it('returns opposite engine outcomes and explicit unadmitted metadata without changing the query denominator', () => {
    simple('engines', ['best service options'], 'Harbor', 'acme.example', ['openai', 'gemini', 'claude'])
    admit('engines', 'non-brand', { provider: 'openai' }); admit('engines', 'non-brand', { provider: 'gemini' })
    finish({ 'engines-q-0-gemini': 'unfavorable' })
    const jobs = db.select().from(sentimentJobs).all(), attempts = db.select().from(sentimentAttempts).all()
    const result = summary('engines', 'non-brand')
    expect(result).toMatchObject({ coverage: { selected: 2, eligibleAssessments: 3, judged: 2 }, score: { favorableRate: 0.5 } })
    const rows = result.queries[0]!.assessments
    expect(rows).toHaveLength(3)
    expect(rows.find(row => row.provider === 'openai')).toMatchObject({ sourceSnapshotId: 'engines-q-0', runId: 'engines', subjectId: 'p', subjectLabel: 'Acme', provider: 'openai', requestedModel: 'source-model', servedModel: 'served-model', location: 'Harbor', state: 'complete', outcome: 'favorable' })
    expect(rows.find(row => row.provider === 'gemini')).toMatchObject({ state: 'complete', outcome: 'unfavorable', requestedModel: 'gemini-requested', servedModel: 'gemini-served' })
    expect(rows.find(row => row.provider === 'claude')).toMatchObject({ assessmentId: null, evaluationDefinitionId: null, state: 'not-measured', outcome: null })
    expect(JSON.stringify(rows)).not.toContain('offers excellent service')
    expect(rows.every(row => !('sourceText' in row) && !('conclusion' in row))).toBe(true)
    expect(summary('engines', 'non-brand', { provider: 'gemini', model: 'gemini-served', location: 'Harbor' }).queries[0]!.assessments).toEqual(rows.filter(row => row.provider === 'gemini'))
    expect(summary('engines', 'branded').queries).toEqual([])
    expect(db.select().from(sentimentJobs).all()).toEqual(jobs)
    expect(db.select().from(sentimentAttempts).all()).toEqual(attempts)
    service.configure('p', { enabled: false })
    expect(summary('engines', 'non-brand').queries[0]!.assessments.every(row => row.state === 'disabled' && row.outcome === null)).toBe(true)
  })

  it('reports durable pending, running, retry, failed and canceled states without inventing a verdict', () => {
    simple('states', ['Acme reviews']); admit('states', 'branded')
    const row = () => summary('states', 'branded').queries[0]!.assessments[0]!
    expect(row()).toMatchObject({ state: 'processing', outcome: 'pending' })
    const work = repository.claim({ owner: 'state-test', now: NOW, leaseMs: 30_000 })!
    expect(row()).toMatchObject({ state: 'processing', outcome: 'running' })
    repository.failWork({ workItemId: work.id, owner: 'state-test', now: NOW, errorCode: 'RETRYABLE', retryAt: '2026-09-28T00:01:00.000Z' })
    expect(row()).toMatchObject({ state: 'processing', outcome: 'waiting-to-retry', reason: 'RETRYABLE' })
    repository.claim({ owner: 'state-test-2', now: '2026-09-28T00:02:00.000Z', leaseMs: 30_000 })
    repository.failWork({ workItemId: work.id, owner: 'state-test-2', now: '2026-09-28T00:02:00.000Z', errorCode: 'EXHAUSTED' })
    expect(row()).toMatchObject({ state: 'failed', outcome: 'failed', reason: 'EXHAUSTED' })
    const preview = service.preview('p', { runId: 'states' })
    service.submit('p', preview.previewToken!, 'explicit-retry', 'fixture')
    repository.cancelProject('p', NOW, 'test-cancel')
    expect(row()).toMatchObject({ state: 'canceled', outcome: 'canceled', reason: 'test-cancel' })
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(0)
  })

  it.each(['factual', 'subject-not-mentioned', 'wrong-subject', 'unsupported-language'] as const)('retains the exact nonjudged %s outcome on engine rows', outcome => {
    simple('abstained', ['best service options']); admit('abstained', 'non-brand'); finish({ 'abstained-q-0': outcome })
    const result = summary('abstained', 'non-brand')
    expect(result.queries[0]!.assessments[0]).toMatchObject({ state: 'complete', outcome, reason: 'Offline fixture exclusion.' })
    expect(result).toMatchObject({ coverage: { judged: 0 }, score: { favorableRate: null } })
  })

  it('keeps shared Advanced answers separate by subject across engines and overlapping markets', () => {
    const plan = measurementPlanV2Fixture()
    plan.reportingScopes = ['alpha', 'beta'].map(stableKey => ({ stableKey, label: stableKey, kind: 'market', usageEdges: plan.usageEdges }))
    db.insert(measurementPlanVersions).values({ id: 'v', projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'v', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
    db.insert(runs).values({ id: 'shared', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: { language: 'en' }, createdAt: NOW }).run()
    for (const node of plan.executionNodes) for (const provider of ['openai', 'gemini']) db.insert(querySnapshots).values({ id: `${node.stableKey}-${provider}`, runId: 'shared', measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: `${provider}-requested`, servedModel: `${provider}-served`, answerText: 'Harbor Homes and Bayside Homes receive different reviews.', citationState: 'cited', createdAt: NOW }).run()
    admit('shared', 'non-brand'); finish({ 'exec-nearby-openai:bayside': 'unfavorable', 'exec-nearby-gemini:harbor': 'unfavorable' })
    const result = summary('shared', 'non-brand')
    const assessments = result.queries[0]!.assessments
    expect(result).toMatchObject({ coverage: { selected: 4, distinctSourceAnswers: 2, judged: 4 }, score: { favorableRate: 0.5 } })
    expect(assessments).toHaveLength(4)
    expect(assessments.filter(row => row.sourceSnapshotId === 'exec-nearby-openai').map(row => [row.subjectId, row.outcome]).sort()).toEqual([['bayside', 'unfavorable'], ['harbor', 'favorable']])
    expect(assessments.filter(row => row.sourceSnapshotId === 'exec-nearby-gemini').map(row => [row.subjectId, row.outcome]).sort()).toEqual([['bayside', 'favorable'], ['harbor', 'unfavorable']])
    const selected = sentimentSelectionSchema.parse({ runId: 'shared', queryClass: 'non-brand', scope: 'property', scopeKey: 'harbor', marketKey: 'alpha', provider: 'openai', model: 'openai-served', location: 'Harbor' })
    const one = service.summary('p', selected).queries[0]!.assessments
    expect(one).toHaveLength(1); expect(one[0]).toMatchObject({ subjectId: 'harbor', outcome: 'favorable', executionNodeKey: 'exec-nearby' })
    expect(service.evidence('p', { ...selected, assessmentId: one[0]!.assessmentId! }, 50).items).toHaveLength(1)
    expect(service.evidence('p', { ...selected, scopeKey: 'bayside', assessmentId: one[0]!.assessmentId! }, 50).items).toEqual([])
    expect(summary('shared', 'non-brand', { marketKey: 'beta' }).queries[0]!.assessments).toEqual(assessments)
  })

  it('returns a strict unavailable DTO before any source exists', () => {
    const result = sentimentSummarySchema.parse(service.summary('p', sentimentSelectionSchema.parse({})))
    expect(result).toMatchObject({ state: 'not-measured', selection: { runId: null }, score: { favorableRate: null } })
    expect(result.selection.runIds).toBeUndefined()
    expect(service.overview('p', []).branded.runIds).toEqual([])
    expect(() => service.summary('p', sentimentSelectionSchema.parse({ runIds: ['missing'] }))).toThrow()
  })

  it('keeps branded and non-brand denominators separate, excludes absent subjects, and joins query evidence by frozen ID', () => {
    simple('mixed', ['Acme reviews', 'Acme complaints', 'best service options', 'popular services', 'service directory'])
    admit('mixed', 'branded'); admit('mixed', 'non-brand')
    finish({ 'mixed-q-1': 'unfavorable', 'mixed-q-3': 'subject-not-mentioned', 'mixed-q-4': 'factual' })
    const branded = summary('mixed', 'branded'), nonBrand = summary('mixed', 'non-brand')
    expect(branded).toMatchObject({ configured: true, coverage: { selected: 2, judged: 2 }, score: { favorableRate: 0.5, favorableDisplay: '50.0%' } })
    expect(nonBrand).toMatchObject({ coverage: { selected: 3, judged: 1, expectedProviderSlots: 3, completedProviderSlots: 3, counts: { 'subject-not-mentioned': 1, factual: 1, unfavorable: 0 } }, score: { favorableRate: 1, favorableDisplay: '100%' } })
    expect(nonBrand.queries.map(query => [query.queryId, query.queryClass, query.coverage.judged, query.score.favorableDisplay])).toEqual([['q-2', 'non-brand', 1, '100%'], ['q-3', 'non-brand', 0, 'Unavailable'], ['q-4', 'non-brand', 0, 'Unavailable']])
    expect(nonBrand.queries[0]).toMatchObject({ sourceSnapshotIds: ['mixed-q-2'], locations: [{ location: null, sourceSnapshotIds: ['mixed-q-2'], score: { favorableRate: 1 } }] })
    const selected = sentimentSelectionSchema.parse({ runId: 'mixed', queryClass: 'non-brand', queryId: 'q-3', provider: 'openai', model: 'served-model', location: 'none' })
    expect(service.summary('p', selected)).toMatchObject({ coverage: { selected: 1, judged: 0 }, score: { favorableRate: null } })
    const evidence = service.evidence('p', selected, 10)
    expect(evidence.items.map(item => [item.context.queryId, item.context.queryClass, item.outcome])).toEqual([['q-3', 'non-brand', 'subject-not-mentioned']])
    const first = service.evidence('p', sentimentSelectionSchema.parse({ runId: 'mixed', queryClass: 'non-brand' }), 1)
    expect(() => service.evidence('p', selected, 1, first.nextCursor!)).toThrow('Evidence cursor')
    expect(() => service.evidence('p', sentimentSelectionSchema.parse({ runId: 'mixed', queryClass: 'branded' }), 1, first.nextCursor!)).toThrow('Evidence cursor')
    db.delete(queries).where(eq(queries.id, 'q-3')).run()
    expect(service.evidence('p', selected, 10)).toEqual(evidence)
    expect(summary('mixed', 'non-brand')).toEqual(nonBrand)
  })

  it.each(['favorable', 'subject-not-mentioned'] as const)('reuses one immutable %s result across query classes while projecting only selected frozen usage edges', outcome => {
    const plan = measurementPlanV2Fixture()
    plan.querySnapshots.push({ queryId: 'q-shared', queryText: 'housing opinions', provenance: { source: 'manual', sourceId: null, capturedAt: NOW } })
    plan.assignments.push({ targetKey: 'harbor', queryId: 'q-shared', queryClass: 'non-brand', executionNodeKey: 'exec-brand' })
    plan.usageEdges.push({ executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-shared' })
    db.insert(measurementPlanVersions).values({ id: 'v', projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'v', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
    db.insert(runs).values({ id: 'advanced', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: { language: 'en' }, createdAt: NOW }).run()
    for (const node of plan.executionNodes) for (const provider of ['openai', 'gemini']) db.insert(querySnapshots).values({ id: `${node.stableKey}-${provider}`, runId: 'advanced', measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: 'source-model', servedModel: 'served-model', answerText: 'Harbor Homes offers excellent homes.', citationState: 'cited', createdAt: NOW }).run()
    admit('advanced', 'branded', { queryId: 'q-brand' }); finish({ 'exec-brand-openai': outcome, 'exec-brand-gemini': outcome })
    const judged = outcome === 'favorable' ? 2 : 0, favorableRate = judged ? 1 : null
    const replay = admit('advanced', 'non-brand', { queryId: 'q-shared' })
    expect(replay.counts[outcome]).toBe(2)
    expect(db.select().from(sentimentWorkItems).all()).toHaveLength(2)
    expect(summary('advanced', 'branded', { queryId: 'q-brand' })).toMatchObject({ coverage: { selected: 2, judged }, score: { favorableRate } })
    expect(summary('advanced', 'non-brand', { queryId: 'q-shared' }).queries).toMatchObject([{ queryId: 'q-shared', queryText: 'housing opinions', queryClass: 'non-brand', coverage: { selected: 2, judged }, score: { favorableRate } }])
    const evidence = service.evidence('p', sentimentSelectionSchema.parse({ runId: 'advanced', queryClass: 'non-brand', queryId: 'q-shared' }), 10)
    expect(evidence.items.every(item => item.context.queryClass === 'non-brand' && item.context.usageEdges.every(edge => edge.queryId === 'q-shared' && edge.queryClass === 'non-brand'))).toBe(true)
    expect(storedSentimentClassifierInputSchema.parse(db.select().from(sentimentWorkItems).get()!.input).context.usageEdges.map(edge => edge.queryClass)).toEqual(['branded', 'non-brand'])
    db.update(runs).set({ measurementScope: { groups: [], targets: ['harbor'], queries: ['q-shared'], resolvedTargets: ['harbor'] } }).where(eq(runs.id, 'advanced')).run()
    expect(selectSentimentSources(db, 'p', { runId: 'advanced', queryClass: 'non-brand' }).assessments).toHaveLength(2)
    expect(selectSentimentSources(db, 'p', { runId: 'advanced', queryClass: 'branded' }).assessments).toHaveLength(0)
    db.insert(measurementPlanVersions).values({ id: 'v2', projectId: 'p', revision: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'v2', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
    db.insert(runs).values({ id: 'advanced-v2', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v2', measurementManifest: buildMeasurementPlanV2Manifest(plan), createdAt: NOW }).run()
    expect(service.summary('p', sentimentSelectionSchema.parse({ runIds: ['advanced', 'advanced-v2'], queryClass: 'branded' }))).toMatchObject({ state: 'unsupported', reason: 'measurement-revision-changed', score: { favorableRate: null } })

  })

  it('adds exact location-group class headlines to existing overview without creating jobs or requests', async () => {
    simple('harbor', undefined, 'Harbor'); simple('bayside', undefined, 'Bayside')
    for (const runId of ['harbor', 'bayside']) for (const queryClass of ['branded', 'non-brand'] as const) admit(runId, queryClass)
    finish({ 'bayside-q-0': 'unfavorable', 'harbor-q-1': 'subject-not-mentioned', 'bayside-q-1': 'factual' })
    db.insert(apiKeys).values({ id: 'root', name: 'root', keyHash: hashApiKey('cnry_headlines'), keyPrefix: 'cnry_test', scopes: ['*'], createdAt: NOW }).run()
    const app = Fastify(); app.register(apiRoutes, { db, sentiment: options }); await app.ready()
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/projects/p/overview', headers: { authorization: 'Bearer cnry_headlines' } })
      expect(response.statusCode, response.body).toBe(200)
      const result = response.json().sentiment
      expect(result).toMatchObject({ configured: true, branded: { coverage: { selected: 2, judged: 2 }, score: { favorableRate: 0.5, favorableDisplay: '50.0%' }, selection: { runId: null } }, nonBrand: { coverage: { selected: 2, judged: 0 }, score: { favorableRate: null, favorableDisplay: 'Unavailable' } } })
      expect(result.overall).toMatchObject({ queryClass: 'all', runIds: ['bayside', 'harbor'], coverage: { selected: 4, judged: 2, distinctSourceAnswers: 4 }, score: { favorableRate: 0.5, favorableDisplay: '50.0%' } })
      expect(result.branded.runIds.sort()).toEqual(['bayside', 'harbor'])
      const located = await app.inject({ method: 'GET', url: '/api/v1/projects/p/overview?location=Harbor', headers: { authorization: 'Bearer cnry_headlines' } })
      expect(located.json().sentiment.branded).toMatchObject({ coverage: { selected: 1, judged: 1 }, score: { favorableRate: 1 }, runIds: ['harbor'] })
      expect(located.json().sentiment.overall).toMatchObject({ queryClass: 'all', coverage: { selected: 2, judged: 1 }, score: { favorableRate: 1, favorableDisplay: '100%' }, runIds: ['harbor'] })
      const grouped = await app.inject({ method: 'GET', url: '/api/v1/projects/p/sentiment?runIds=harbor&runIds=bayside&queryClass=branded&include=locations', headers: { authorization: 'Bearer cnry_headlines' } })
      expect(grouped.statusCode, grouped.body).toBe(200)
      const groupSummary = sentimentSummarySchema.parse(grouped.json())
      expect(groupSummary).toMatchObject({ selection: { runId: null, runIds: ['bayside', 'harbor'] }, coverage: { selected: 2, judged: 2 }, score: { favorableRate: 0.5 } })
      expect(groupSummary.queries[0]).toMatchObject({ queryId: 'q-0', sourceSnapshotIds: ['bayside-q-0', 'harbor-q-0'], score: { favorableRate: 0.5 } })
      expect(groupSummary.queries[0]!.locations.map(row => [row.location, row.score.favorableDisplay]).sort()).toEqual([['Bayside', '0%'], ['Harbor', '100%']])
      const singleton = await app.inject({ method: 'GET', url: '/api/v1/projects/p/sentiment?runIds=harbor&queryClass=branded', headers: { authorization: 'Bearer cnry_headlines' } })
      expect(singleton.statusCode, singleton.body).toBe(200)
      expect(singleton.json().coverage.selected).toBe(1)
      const selection = sentimentSelectionSchema.parse({ runIds: ['harbor', 'bayside'], queryClass: 'branded' })
      const first = service.evidence('p', selection, 1)
      expect(first.nextCursor).not.toBeNull()
      expect(service.evidence('p', { ...selection, runIds: ['bayside', 'harbor'] }, 1, first.nextCursor!).items).toHaveLength(1)
      expect(() => service.evidence('p', { ...selection, runIds: ['harbor'] }, 1, first.nextCursor!)).toThrow('Evidence cursor')
      for (const path of ['?runId=harbor&runIds=bayside', '/compare?fromRunId=harbor&toRunId=bayside&runIds=harbor']) {
        const rejected = await app.inject({ method: 'GET', url: `/api/v1/projects/p/sentiment${path}`, headers: { authorization: 'Bearer cnry_headlines' } })
        expect(rejected.statusCode, rejected.body).toBe(400)
      }
      expect(service.jobList('p').jobs).toHaveLength(4)
    } finally { await app.close() }
  })

  it('marks a group containing an incomplete location run provisional', () => {
    simple('complete', undefined, 'Harbor'); simple('partial', undefined, 'Bayside')
    admit('complete', 'branded'); finish()
    db.update(runs).set({ status: 'partial' }).where(eq(runs.id, 'partial')).run()
    const result = service.summary('p', sentimentSelectionSchema.parse({ runIds: ['complete', 'partial'], queryClass: 'branded' }))
    expect(result).toMatchObject({ state: 'partial', provisional: true, reason: 'Source sweep is incomplete.', coverage: { judged: 1, expectedProviderSlots: 2, completedProviderSlots: 2 } })
    expect(service.overview('p', ['complete', 'partial']).branded.state).toBe('partial')
  })

  it('refuses pooling incompatible frozen identities and evaluators across an explicit run group', () => {
    simple('original', undefined, 'Harbor'); simple('changed', undefined, 'Bayside', 'different.example')
    admit('original', 'branded'); admit('changed', 'branded'); finish()
    const selected = sentimentSelectionSchema.parse({ runIds: ['original', 'changed'], queryClass: 'branded' })
    const incompatible = service.summary('p', selected)
    expect(incompatible).toMatchObject({ state: 'unsupported', reason: 'subject-identity-changed', score: { favorableRate: null, favorableDisplay: 'Unavailable' } })
    expect(service.overview('p', ['original', 'changed']).overall).toMatchObject({ state: 'unsupported', reason: 'subject-identity-changed', score: { favorableRate: null } })
    expect(incompatible.queries.every(query => query.score.favorableRate === null && query.assessments.every(row => row.outcome === null && row.state === 'unsupported'))).toBe(true)
    const definition = { ...createSentimentEvaluationDefinition(), confidenceThreshold: 0.8 }
    const id = sentimentHash(definition)
    repository.putDefinition({ id, contentHash: id, requestedModel: definition.requestedModel, definition, createdAt: NOW })
    repository.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: id, configuration: { enabled: true }, now: NOW })
    const preview = service.preview('p', { runId: 'changed' })
    service.submit('p', preview.previewToken!, 'new-evaluator', 'fixture'); finish()
    expect(service.summary('p', selected)).toMatchObject({ state: 'unsupported', reason: 'evaluation-definition-changed', selection: { evaluationDefinitionId: null }, score: { favorableRate: null } })
    expect(service.overview('p', ['original', 'changed']).overall).toMatchObject({ state: 'unsupported', reason: 'evaluation-definition-changed', score: { favorableRate: null } })
  })

  it('withholds only the overall score when the two classes use incompatible evaluators', () => {
    simple('different-evaluators'); admit('different-evaluators', 'branded'); finish()
    const definition = { ...createSentimentEvaluationDefinition(), confidenceThreshold: 0.8 }
    const id = sentimentHash(definition)
    repository.putDefinition({ id, contentHash: id, requestedModel: definition.requestedModel, definition, createdAt: NOW })
    repository.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: id, configuration: { enabled: true }, now: NOW })
    admit('different-evaluators', 'non-brand'); finish()
    const overview = service.overview('p', ['different-evaluators'])
    expect(overview.branded.score.favorableRate).toBe(1)
    expect(overview.nonBrand.score.favorableRate).toBe(1)
    expect(overview.overall).toMatchObject({ state: 'unsupported', reason: 'evaluation-definition-changed', provisional: true, coverage: { judged: 2 }, score: { favorableRate: null, favorableDisplay: 'Unavailable' } })
  })

  it('treats the first qualified run as a subject boundary for pooled reads and comparisons', () => {
    // Same aliases, answers and engines on both sides; only the frozen qualified list differs.
    const aliases = ['Acme Co', 'ACMENYC']
    simple('unqualified', undefined, 'Harbor', 'acme.example', ['openai'], { aliases })
    simple('qualified', undefined, 'Bayside', 'acme.example', ['openai'], { aliases, qualifiedAliases: ['ACMENYC'] })
    admit('unqualified', 'branded'); admit('qualified', 'branded'); finish()
    const pooled = service.summary('p', sentimentSelectionSchema.parse({ runIds: ['unqualified', 'qualified'], queryClass: 'branded' }))
    expect(pooled).toMatchObject({ state: 'unsupported', reason: 'subject-identity-changed', score: { favorableRate: null } })
    // Each side alone stays readable.
    expect(summary('qualified', 'branded')).toMatchObject({ state: 'complete', score: { favorableRate: 1 } })

    simple('before', undefined, null, 'acme.example', ['openai'], { aliases })
    simple('after', undefined, null, 'acme.example', ['openai'], { aliases, qualifiedAliases: ['ACMENYC'] })
    admit('before', 'branded'); admit('after', 'branded'); finish()
    const comparison = service.compare('p', sentimentSelectionSchema.parse({ queryClass: 'branded' }), 'before', 'after')
    expect(comparison).toMatchObject({ changedScope: true, commonUnits: 0, verdict: null, favorableRateDelta: null })
    expect(comparison.refusalReasons).toContain('source-scope-changed')
  })

  it('reads legacy theme-bearing stored definitions without mutating them and explicitly upgrades only current configuration', () => {
    simple('legacy')
    const old = { ...createSentimentEvaluationDefinition(), schemaVersion: 1 as const, verdictVersion: 'stance-v1', identityVersion: 'qualified-subject-v1', themes: [{ id: 'retired', name: 'Retired theme' }], questions: { ...createSentimentEvaluationDefinition().questions, theme: 'Frozen old theme question' } }
    const id = sentimentHash(old), before = JSON.stringify(old)
    repository.putDefinition({ id, contentHash: id, requestedModel: old.requestedModel, definition: old, createdAt: NOW })
    repository.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: id, configuration: { enabled: true, preset: 'default', customThemes: [] }, now: NOW })
    const source = selectSentimentSources(db, 'p', { runId: 'legacy' }).assessments[0]!
    const input = { ...sentimentClassifierInput(source, service.definition(id)), definition: old }
    repository.admitJob({ projectId: 'p', action: 'backfill', origin: 'backfill', enablementEpoch: service.settings('p').enablementEpoch, evaluationDefinitionId: id, idempotencyKey: 'legacy', payloadHash: sentimentHash({ previewToken: 'old-preview-token' }), selection: { ...sentimentSelectionSchema.parse({ runId: 'legacy' }), runIds: ['legacy'] }, actor: 'fixture', now: NOW, work: [{ runId: 'legacy', snapshotId: source.snapshotId, sourceTextHash: input.sourceTextHash, subjectHash: input.subjectHash, input, edges: source.edges }] })
    const storedSelection = db.select().from(sentimentJobs).get()!.selection
    expect(service.jobList('p').jobs[0]!.selection).toMatchObject({ runId: 'legacy' })
    expect(service.jobList('p').jobs[0]!.selection.runIds).toBeUndefined()
    expect(service.submit('p', 'old-preview-token', 'legacy', 'fixture').selected).toBe(1)
    expect(db.select().from(sentimentJobs).all()).toHaveLength(1)
    expect(db.select().from(sentimentJobs).get()!.selection).toEqual(storedSelection)
    finish()
    const historical = summary('legacy', 'branded')
    expect(historical).toMatchObject({ score: { favorableRate: 1 }, evaluationDefinition: { schemaVersion: 1, verdictVersion: 'stance-v1' } })
    expect(historical.evaluationDefinition).not.toHaveProperty('themes')
    expect(service.settings('p')).toMatchObject({ ready: false, actions: { backfill: false } })
    expect(service.preview('p', { runId: 'legacy' }).previewToken).toBeNull()
    service.configure('p', { enabled: true })
    expect(service.definition(service.settings('p').evaluationDefinitionId!).schemaVersion).toBe(2)
    expect(summary('legacy', 'branded')).toEqual(historical)
    expect(JSON.stringify(db.select().from(sentimentDefinitions).where(eq(sentimentDefinitions.id, id)).get()!.definition)).toBe(before)
  })
})
