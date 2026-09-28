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
  sentimentDefinitions, sentimentJobs, sentimentWorkItems, simpleMeasurementDefinitions, SentimentRepository, type DatabaseClient,
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

function simple(runId: string, labels = ['Acme reviews', 'best service options'], location: string | null = null, domain = 'acme.example') {
  db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', location, createdAt: NOW }).run()
  const frozen = labels.map((queryText, index) => ({ queryId: `q-${index}`, queryText, provenance: null }))
  for (const query of frozen) db.insert(queries).values({ id: query.queryId, projectId: 'p', query: query.queryText, createdAt: NOW }).onConflictDoNothing().run()
  const definition = buildSimpleMeasurementDefinition({ capturedAt: NOW, identity: { displayName: 'Acme', aliases: ['Acme Co'], canonicalDomain: domain, ownedDomains: [] }, country: 'US', language: 'en', location: location ? { label: location, city: location, region: 'EX', country: 'US' } : null, engines: [{ provider: 'openai', requestedModel: 'source-model' }], queries: frozen })
  db.insert(simpleMeasurementDefinitions).values({ runId, projectId: 'p', definition, checksum: runId, capturedAt: NOW }).run()
  for (const query of frozen) db.insert(querySnapshots).values({ id: `${runId}-${query.queryId}`, runId, queryId: query.queryId, queryText: query.queryText, location, provider: 'openai', model: 'source-model', servedModel: 'served-model', answerText: 'Acme Co offers excellent service.', citationState: 'cited', createdAt: NOW }).run()
}
function finish(outcomes: Record<string, SentimentOutcome> = {}) {
  for (;;) {
    const work = repository.claim({ owner: 'headlines', now: NOW, leaseMs: 30_000 })
    if (!work) break
    const input = storedSentimentClassifierInputSchema.parse(work.input)
    const outcome = outcomes[work.snapshotId] ?? 'favorable'
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
    expect(branded).toMatchObject({ configured: true, coverage: { selected: 2, judged: 2 }, score: { favorableRate: 0.5, favorableDisplay: '50%' } })
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
      expect(result).toMatchObject({ configured: true, branded: { coverage: { selected: 2, judged: 2 }, score: { favorableRate: 0.5, favorableDisplay: '50%' }, selection: { runId: null } }, nonBrand: { coverage: { selected: 2, judged: 0 }, score: { favorableRate: null, favorableDisplay: 'Unavailable' } } })
      expect(result.branded.runIds.sort()).toEqual(['bayside', 'harbor'])
      const located = await app.inject({ method: 'GET', url: '/api/v1/projects/p/overview?location=Harbor', headers: { authorization: 'Bearer cnry_headlines' } })
      expect(located.json().sentiment.branded).toMatchObject({ coverage: { selected: 1, judged: 1 }, score: { favorableRate: 1 }, runIds: ['harbor'] })
      const grouped = await app.inject({ method: 'GET', url: '/api/v1/projects/p/sentiment?runIds=harbor&runIds=bayside&queryClass=branded', headers: { authorization: 'Bearer cnry_headlines' } })
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
      expect(service.jobs('p').jobs).toHaveLength(4)
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
    expect(incompatible.queries.every(query => query.score.favorableRate === null)).toBe(true)
    const definition = { ...createSentimentEvaluationDefinition(), confidenceThreshold: 0.8 }
    const id = sentimentHash(definition)
    repository.putDefinition({ id, contentHash: id, requestedModel: definition.requestedModel, definition, createdAt: NOW })
    repository.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: id, configuration: { enabled: true }, now: NOW })
    const preview = service.preview('p', { runId: 'changed' })
    service.submit('p', preview.previewToken!, 'new-evaluator', 'fixture'); finish()
    expect(service.summary('p', selected)).toMatchObject({ state: 'unsupported', reason: 'evaluation-definition-changed', selection: { evaluationDefinitionId: null }, score: { favorableRate: null } })
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
    expect(service.jobs('p').jobs[0]!.selection).toMatchObject({ runId: 'legacy' })
    expect(service.jobs('p').jobs[0]!.selection.runIds).toBeUndefined()
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
