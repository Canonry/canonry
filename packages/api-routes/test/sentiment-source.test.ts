import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, queries, runs, querySnapshots, simpleMeasurementDefinitions, measurementPlanVersions, type DatabaseClient } from '@ainyc/canonry-db'
import { buildSimpleMeasurementDefinition, canonicalMeasurementPlanV2Json, createSentimentEvaluationDefinition } from '@ainyc/canonry-contracts'
import { selectSentimentSources } from '../src/sentiment-source.js'
import { sentimentClassifierInput, sentimentHash } from '../src/sentiment-input.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'

let db: DatabaseClient
const now = '2026-09-28T00:00:00.000Z'
beforeEach(() => {
  db = createClient(':memory:'); migrate(db)
  db.insert(projects).values({ id: 'p', name: 'test', displayName: 'Changed live name', canonicalDomain: 'changed.example', country: 'US', language: 'fr', createdAt: now, updatedAt: now }).run()
  db.insert(queries).values({ id: 'q', projectId: 'p', query: 'Original reviews', createdAt: now }).run()
})
afterEach(() => { db.$client.close() })
function simple(status = 'completed', trigger = 'manual', kind = 'answer-visibility') {
  db.insert(runs).values({ id: 'r', projectId: 'p', kind, status, trigger, createdAt: now }).run()
  const definition = buildSimpleMeasurementDefinition({ capturedAt: now, identity: { displayName: 'Original', aliases: ['Original Co'], canonicalDomain: 'https://Original.Example/about', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'gpt-test' }], queries: [{ queryId: 'q', queryText: 'Original reviews', provenance: null }] })
  db.insert(simpleMeasurementDefinitions).values({ runId: 'r', projectId: 'p', definition, checksum: 'test', capturedAt: now }).run()
}
function snapshot(id = 's', execution?: string, provider = 'openai') {
  db.insert(querySnapshots).values({ id, runId: 'r', queryId: 'q', queryText: 'Original reviews', provider, model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Original Co provides excellent service. Details at https://Original.Example/about.', citationState: 'cited', createdAt: now, ...(execution ? { measurementExecutionId: execution } : {}) }).run()
}
describe('sentiment frozen source selection', () => {
  it('uses frozen identity and language, preserving original URLs and source spans', () => {
    simple(); snapshot()
    const selected = selectSentimentSources(db, 'p', { runId: 'r' })
    expect(selected.assessments).toHaveLength(1)
    const input = sentimentClassifierInput(selected.assessments[0]!, createSentimentEvaluationDefinition())
    expect(input.subject.displayName).toBe('Original')
    expect(input.subject.urls).toEqual(['https://Original.Example/about'])
    expect(input.language).toBe('en')
    expect(input.sourceTextHash).toBe(sentimentHash(input.sourceText))
    for (const span of input.sentences) expect(input.sourceText.slice(span.start, span.end)).toBe(span.text)
    expect(selected.sourceCoverage).toEqual({ expected: 1, completed: 1 })
  })
  it.each([['completed', 'probe', 'answer-visibility'], ['failed', 'manual', 'answer-visibility'], ['partial', 'manual', 'answer-visibility'], ['completed', 'manual', 'site-audit']])('excludes ineligible source %s %s %s', (status, trigger, kind) => {
    simple(status, trigger, kind); snapshot()
    expect(selectSentimentSources(db, 'p', { runId: 'r' }).assessments).toEqual([])
  })
  it('rejects missing Simple provider slots despite completed status', () => {
    simple()
    expect(selectSentimentSources(db, 'p', { runId: 'r' }).skipped['incomplete-run']).toBe(1)
  })
  it('selects Advanced markets by exact frozen usage edges and deduplicates shared subjects', () => {
    const plan = measurementPlanV2Fixture()
    plan.assignments.forEach(assignment => { assignment.queryClass = 'branded' })
    plan.reportingScopes = [
      { stableKey: 'nearby-market', label: 'Nearby', kind: 'market', usageEdges: plan.usageEdges.filter(edge => edge.executionNodeKey === 'exec-nearby') },
      { stableKey: 'brand-market', label: 'Brand', kind: 'market', usageEdges: plan.usageEdges.filter(edge => edge.executionNodeKey === 'exec-brand') },
    ]
    db.insert(measurementPlanVersions).values({ id: 'v', projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'x', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
    db.insert(runs).values({ id: 'r', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: buildMeasurementPlanV2Manifest(plan), createdAt: now }).run()
    snapshot('s1', 'exec-nearby'); snapshot('s2', 'exec-nearby', 'gemini'); snapshot('s3', 'exec-brand'); snapshot('s4', 'exec-brand', 'gemini')
    const all = selectSentimentSources(db, 'p', { runId: 'r' })
    expect(all.assessments).toHaveLength(6)
    const market = selectSentimentSources(db, 'p', { runId: 'r', marketKey: 'brand-market' })
    expect(market.assessments).toHaveLength(2)
    expect(market.assessments.every(item => item.edges.every(edge => edge.queryKey === 'q-brand'))).toBe(true)
    expect(all.assessments[0]!.language).toBe('unknown')
  })
})
