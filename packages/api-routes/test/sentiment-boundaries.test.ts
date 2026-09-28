import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSimpleMeasurementDefinition, canonicalMeasurementPlanV2Json, createSentimentEvaluationDefinition, sentimentClassifierInputSchema,
  sentimentComparisonSchema, sentimentSummarySchema, type SentimentClassifierOutput,
} from '@ainyc/canonry-contracts'
import {
  apiKeys, createClient, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs,
  sentimentAttempts, sentimentJobs, simpleMeasurementDefinitions, users, SentimentRepository, type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes, createUserSession, USER_SESSION_COOKIE_NAME } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { sentimentHash } from '../src/sentiment-input.js'
import { SentimentService } from '../src/sentiment-service.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-09-28T00:00:00.000Z'
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let service: SentimentService
let repository: SentimentRepository
let clock: string
const headers = { authorization: 'Bearer cnry_boundary-root' }

beforeEach(async () => {
  clock = NOW
  db = createClient(':memory:'); migrate(db)
  db.insert(projects).values({ id: 'p', name: 'p', displayName: 'Original', canonicalDomain: 'original.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
  for (const id of ['q-one', 'q-two']) db.insert(queries).values({ id, projectId: 'p', query: `Original ${id} reviews`, createdAt: NOW }).run()
  db.insert(apiKeys).values({ id: 'root', name: 'root', keyHash: hashApiKey('cnry_boundary-root'), keyPrefix: 'cnry_test', scopes: ['*'], createdAt: NOW }).run()
  const options = { install: () => ({ enabled: true, ready: true, reason: null, model: 'jev-1.13.0' }), now: () => new Date(clock), previewSecret: 'boundary-test-secret' }
  service = new SentimentService(db, options)
  repository = new SentimentRepository(db)
  app = Fastify(); app.register(apiRoutes, { db, sentiment: options }); await app.ready()
})
afterEach(async () => { await app.close(); db.$client.close() })

function simple(runId: string, queryIds = ['q-one']) {
  db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: clock }).run()
  const definition = buildSimpleMeasurementDefinition({ capturedAt: clock, identity: { displayName: 'Original', aliases: ['Original Co'], canonicalDomain: 'original.example', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'source-model' }], queries: queryIds.map(queryId => ({ queryId, queryText: `Original ${queryId} reviews`, provenance: null })) })
  db.insert(simpleMeasurementDefinitions).values({ runId, projectId: 'p', definition, checksum: runId, capturedAt: clock }).run()
  for (const queryId of queryIds) db.insert(querySnapshots).values({ id: `${runId}-${queryId}`, runId, queryId, provider: 'openai', model: 'source-model', servedModel: 'source-model-v1', answerText: 'Original Co offers a service.', citationState: 'cited', createdAt: clock }).run()
}
function advanced(runId: string) {
  const plan = measurementPlanV2Fixture()
  plan.assignments.forEach(assignment => { assignment.queryClass = 'branded' })
  plan.reportingScopes = ['alpha', 'beta'].map(stableKey => ({ stableKey, label: stableKey, kind: 'market', usageEdges: plan.usageEdges }))
  db.insert(measurementPlanVersions).values({ id: `${runId}-version`, projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: runId, schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: clock }).run()
  db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: `${runId}-version`, measurementManifest: buildMeasurementPlanV2Manifest(plan), createdAt: clock }).run()
  for (const node of plan.executionNodes) for (const provider of ['openai', 'gemini']) db.insert(querySnapshots).values({ id: `${runId}-${node.stableKey}-${provider}`, runId, measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: 'source-model', servedModel: 'source-model-v1', answerText: 'Harbor Homes and Bayside Homes offer homes.', citationState: 'cited', createdAt: clock }).run()
}
function complete(runId: string, outcome: 'favorable' | 'unfavorable' | 'factual' = 'favorable') {
  const preview = service.preview('p', { runId })
  const job = service.submit('p', preview.previewToken!, `${runId}-${preview.evaluationDefinitionId}`, 'test')
  for (;;) {
    const work = repository.claim({ owner: 'boundary-test', now: clock, leaseMs: 30_000 })
    if (!work) break
    const input = sentimentClassifierInputSchema.parse(work.input)
    const common = { returnedModel: 'jev-1.13.0', usage: { kind: 'reported' as const, inputTokens: 20, outputTokens: 0 } }
    const result: SentimentClassifierOutput = outcome === 'factual'
      ? { ...common, kind: 'abstained', outcome, reason: 'The answer only states facts.' }
      : { ...common, kind: 'classified', outcome, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null }
    expect(repository.completeWork({ workItemId: work.id, owner: 'boundary-test', now: clock, outcome, result, returnedModel: result.returnedModel })).toBe(true)
  }
  return job
}
// Represents a future evaluator migration: immutable definitions are inserted, never edited.
function changeEvaluator() {
  const definition = { ...createSentimentEvaluationDefinition(), confidenceThreshold: 0.8 }
  const id = sentimentHash(definition)
  repository.putDefinition({ id, contentHash: id, requestedModel: definition.requestedModel, definition, createdAt: clock })
  repository.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: id, configuration: { enabled: true }, now: clock })
  return service.settings('p')
}
async function get(suffix: string, query: Record<string, string> = {}) {
  const response = await app.inject({ method: 'GET', url: `/api/v1/projects/p/sentiment${suffix}?${new URLSearchParams(query)}`, headers })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

describe('sentiment stored-result and authorization boundaries', () => {
  it('returns a typed evaluator-change refusal even when the same source unit has opposite verdicts', async () => {
    service.configure('p', { enabled: true }); simple('before'); complete('before')
    clock = '2026-09-28T00:01:00.000Z'
    changeEvaluator()
    simple('after'); complete('after', 'unfavorable')
    const comparison = sentimentComparisonSchema.parse(await get('/compare', { fromRunId: 'before', toRunId: 'after' }))
    expect(comparison).toMatchObject({ commonUnits: 1, verdict: null, favorableRateDelta: null, refusalReasons: ['evaluation-definition-changed'] })
    expect(comparison.from.selection.evaluationDefinitionId).not.toBe(comparison.to.selection.evaluationDefinitionId)
  })

  it('refuses a changed query population instead of reporting a directional rate change', async () => {
    service.configure('p', { enabled: true }); simple('before', ['q-one']); simple('after', ['q-two'])
    complete('before'); complete('after', 'unfavorable')
    const comparison = sentimentComparisonSchema.parse(await get('/compare', { fromRunId: 'before', toRunId: 'after' }))
    expect(comparison).toMatchObject({ changedScope: true, commonUnits: 0, excludedFrom: 1, excludedTo: 1, verdict: null, favorableRateDelta: null })
    expect(comparison.refusalReasons).toContain('source-scope-changed')
  })

  it('binds a cursor to valid market, subject, run and evaluator selections, including overlapping markets', async () => {
    const original = service.configure('p', { enabled: true })
    advanced('advanced'); simple('other-run'); complete('advanced')
    const selection = { runId: 'advanced', scope: 'market', scopeKey: 'alpha', evaluationDefinitionId: original.evaluationDefinitionId!, limit: '1' }
    const first = await get('/evidence', selection)
    expect(first.items).toHaveLength(1); expect(first.nextCursor).not.toBeNull()
    const next = await get('/evidence', { ...selection, cursor: first.nextCursor })
    expect(next.items[0].assessmentId).not.toBe(first.items[0].assessmentId)
    const overlapping = await get('/evidence', { ...selection, scopeKey: 'beta' })
    expect(overlapping.items[0].assessmentId).toBe(first.items[0].assessmentId)
    clock = '2026-09-28T00:01:00.000Z'
    const changed = changeEvaluator()
    complete('advanced')
    for (const changedSelection of [
      { scopeKey: 'beta' }, { scope: 'property', scopeKey: 'harbor' }, { runId: 'other-run' },
      { evaluationDefinitionId: changed.evaluationDefinitionId! },
    ]) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/projects/p/sentiment/evidence?${new URLSearchParams({ ...selection, ...changedSelection, cursor: first.nextCursor })}`, headers })
      expect(response.statusCode, response.body).toBe(400)
      expect(response.json().error.message).toContain('Evidence cursor')
    }
    expect(await get('/evidence', { ...selection, cursor: first.nextCursor })).toEqual(next)
  })

  it('retains historical subject, query class, and evaluator after live configuration changes', async () => {
    service.configure('p', { enabled: true })
    simple('historic'); complete('historic')
    const before = await get('', { runId: 'historic' })
    const evidence = await get('/evidence', { runId: 'historic' })
    db.update(projects).set({ displayName: 'Replacement', aliases: ['Replacement Co'], canonicalDomain: 'replacement.example', language: 'fr' }).where(eq(projects.id, 'p')).run()
    db.update(queries).set({ query: 'Unbranded replacement query' }).where(eq(queries.id, 'q-one')).run()
    changeEvaluator()
    expect((await get('/settings')).evaluationDefinitionId).not.toBe(before.selection.evaluationDefinitionId)
    expect(await get('', { runId: 'historic' })).toEqual(before)
    expect(await get('/evidence', { runId: 'historic' })).toEqual(evidence)
    expect(evidence.items[0]).toMatchObject({ subject: { displayName: 'Original' }, context: { queryClass: 'branded' } })
    expect(before.evaluationDefinition).toMatchObject({ schemaVersion: 2, confidenceThreshold: null })
  })

  it('exposes a complete factual-only basket with unavailable rates and explicit exclusion counts', async () => {
    service.configure('p', { enabled: true }); simple('factual', ['q-one', 'q-two']); complete('factual', 'factual')
    const summary = sentimentSummarySchema.parse(await get('', { runId: 'factual' }))
    expect(summary).toMatchObject({ state: 'complete', provisional: false, coverage: { selected: 2, eligibleAssessments: 2, unadmittedAssessments: 0, judged: 0, counts: { factual: 2, favorable: 0, unfavorable: 0 } }, score: { favorableRate: null, mixedRate: null, unfavorableRate: null, interval: null, favorableDisplay: 'Unavailable', mixedDisplay: 'Unavailable', unfavorableDisplay: 'Unavailable' } })
    expect(summary.breakdowns.every(row => row.score.favorableRate === null && row.coverage.judged === 0)).toBe(true)
    const evidence = await get('/evidence', { runId: 'factual' })
    expect(evidence.items).toHaveLength(2)
    expect(evidence.items.every((item: { outcome: string; reason: string }) => item.outcome === 'factual' && item.reason === 'The answer only states facts.')).toBe(true)
    const comparison = sentimentComparisonSchema.parse(await get('/compare', { fromRunId: 'factual', toRunId: 'factual' }))
    expect(comparison).toMatchObject({ verdict: null, favorableRateDelta: null, refusalReasons: ['insufficient-judgments'] })
  })

  it.each(['session', 'delegated'] as const)('rechecks a demoted administrator before %s backfill receipt replay', async transport => {
    service.configure('p', { enabled: true }); simple('authorized')
    db.insert(users).values({ id: 'operator', name: 'Operator', nameKey: 'operator', passwordHash: 'unused', role: 'admin', createdAt: NOW }).run()
    db.insert(apiKeys).values({ id: 'delegated', name: 'delegated', keyHash: hashApiKey('cnry_boundary-delegated'), keyPrefix: 'cnry_test', scopes: ['*'], delegatedUserId: 'operator', createdAt: NOW }).run()
    const delegated = { authorization: 'Bearer cnry_boundary-delegated' }
    const session = { cookie: `${USER_SESSION_COOKIE_NAME}=${createUserSession(db, 'operator')}`, host: 'localhost', origin: 'http://localhost' }
    const credential = transport === 'session' ? session : delegated
    const preview = service.preview('p', { runId: 'authorized' })
    const payload = { previewToken: preview.previewToken!, idempotencyKey: 'authorized' }
    const submit = () => app.inject({ method: 'POST', url: '/api/v1/projects/p/sentiment/backfills', headers: credential, payload })
    expect((await submit()).statusCode).toBe(200)
    db.update(users).set({ role: 'viewer' }).where(eq(users.id, 'operator')).run()
    expect((await submit()).statusCode).toBe(403)
    const settings = await app.inject({ method: 'GET', url: '/api/v1/projects/p/sentiment/settings', headers: credential })
    expect(settings.statusCode).toBe(200)
    expect(settings.json().actions).toEqual({ configure: false, backfill: false })
    expect(db.select().from(sentimentJobs).all()).toHaveLength(1)
    expect(db.select().from(sentimentAttempts).all()).toHaveLength(0)
  })
})
