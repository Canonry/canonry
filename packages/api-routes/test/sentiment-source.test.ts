import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, queries, runs, querySnapshots, simpleMeasurementDefinitions, measurementPlanVersions, sentimentWorkItems, type DatabaseClient } from '@ainyc/canonry-db'
import { buildSimpleMeasurementDefinition, canonicalMeasurementPlanV2Json, compileBrandAliases, createSentimentEvaluationDefinition, hostOf, matcherMatchesText, normalizeProjectAliases, sentimentClassifierInputSchema, type MeasurementPlanV2 } from '@ainyc/canonry-contracts'
import { SentimentService } from '../src/sentiment-service.js'
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
// The stored execution identity as job-runner stamps it; `language` is absent on runs from before the stamp.
const stampedIdentity = (language?: string) => ({ schemaVersion: 1 as const, providers: ['gemini', 'openai'], models: {}, checksum: 'a'.repeat(64), ...(language ? { language } : {}) })
function advancedPlan(plan: MeasurementPlanV2 = measurementPlanV2Fixture(), id = 'v') {
  db.insert(measurementPlanVersions).values({ id, projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: id, schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
  return plan
}
function advancedRun(runId: string, plan: MeasurementPlanV2, identity: ReturnType<typeof stampedIdentity> | null, versionId = 'v') {
  db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: versionId, measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: identity, createdAt: now }).run()
  for (const node of plan.executionNodes) for (const provider of node.context.providers) db.insert(querySnapshots).values({ id: `${runId}-${node.stableKey}-${provider}`, runId, measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Harbor Homes and Bayside Homes offer homes.', rawResponse: JSON.stringify({ payload: 'x'.repeat(4096) }), citationState: 'cited', createdAt: now }).run()
}
const service = () => new SentimentService(db, { install: () => ({ enabled: true, ready: true, model: 'jev-1.13.0', reason: null }), previewSecret: 'fixture', now: () => new Date(now) })
function snapshot(id = 's', execution?: string, provider = 'openai') {
  db.insert(querySnapshots).values({ id, runId: 'r', queryId: 'q', queryText: 'Original reviews', provider, model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Original Co provides excellent service. Details at https://Original.Example/about.', citationState: 'cited', createdAt: now, ...(execution ? { measurementExecutionId: execution } : {}) }).run()
}
describe('sentiment frozen source selection', () => {
  it('retains the frozen Simple query after its live query is deleted', () => {
    simple(); snapshot()
    db.delete(queries).where(eq(queries.id, 'q')).run()
    const selected = selectSentimentSources(db, 'p', { runId: 'r' })
    expect(selected.assessments).toHaveLength(1)
    expect(selected.assessments[0]!.edges[0]!.queryKey).toBe('q')
  })
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
    plan.usageEdges.push({ executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-second-brand' })
    plan.assignments.push({ executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-second-brand', queryClass: 'branded' })
    plan.reportingScopes = [
      { stableKey: 'nearby-market', label: 'Nearby', kind: 'market', usageEdges: plan.usageEdges.filter(edge => edge.executionNodeKey === 'exec-nearby') },
      { stableKey: 'brand-market', label: 'Brand', kind: 'market', usageEdges: plan.usageEdges.filter(edge => edge.executionNodeKey === 'exec-brand' && edge.queryId === 'q-brand') },
      { stableKey: 'second-market', label: 'Second', kind: 'market', usageEdges: plan.usageEdges.filter(edge => edge.queryId === 'q-second-brand') },
    ]
    db.insert(measurementPlanVersions).values({ id: 'v', projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'x', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
    db.insert(runs).values({ id: 'r', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: stampedIdentity('en'), createdAt: now }).run()
    snapshot('s1', 'exec-nearby'); snapshot('s2', 'exec-nearby', 'gemini'); snapshot('s3', 'exec-brand'); snapshot('s4', 'exec-brand', 'gemini')
    const all = selectSentimentSources(db, 'p', { runId: 'r' })
    expect(all.assessments).toHaveLength(6)
    const market = selectSentimentSources(db, 'p', { runId: 'r', marketKey: 'brand-market' })
    expect(market.assessments).toHaveLength(2)
    expect(market.assessments.every(item => item.edges.some(edge => edge.queryKey === 'q-brand'))).toBe(true)
    const second = selectSentimentSources(db, 'p', { runId: 'r', marketKey: 'second-market' })
    expect(second.assessments).toEqual(market.assessments)
    expect(market.assessments[0]!.edges.map(edge => edge.queryKey)).toEqual(['q-brand', 'q-second-brand'])
    expect(all.assessments[0]!.language).toBe('en')
    const service = new SentimentService(db, { install: () => ({ enabled: true, ready: true, model: 'jev-1.13.0', reason: null }), previewSecret: 'fixture', now: () => new Date(now) })
    service.configure('p', { enabled: true })
    const firstPreview = service.preview('p', { runId: 'r', marketKey: 'brand-market' })
    service.submit('p', firstPreview.previewToken!, 'first-market', 'fixture')
    const secondPreview = service.preview('p', { runId: 'r', marketKey: 'second-market' })
    service.submit('p', secondPreview.previewToken!, 'second-market', 'fixture')
    const work = db.select().from(sentimentWorkItems).all()
    expect(work).toHaveLength(2)
    expect(sentimentClassifierInputSchema.parse(work[0]!.input).context.usageEdges.map(edge => edge.marketId)).toEqual(['brand-market', 'second-market'])
    expect(sentimentClassifierInputSchema.parse(work[0]!.input).context.usageEdges.map(edge => edge.queryId)).toEqual(['q-brand', 'q-second-brand'])
    db.insert(measurementPlanVersions).values({ id: 'v2', projectId: 'p', revision: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'y', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
    db.insert(runs).values({ id: 'later-advanced', projectId: 'p', kind: 'answer-visibility', status: 'partial', trigger: 'manual', measurementPlanVersionId: 'v2', measurementManifest: buildMeasurementPlanV2Manifest(plan), createdAt: '2026-09-29T00:00:00.000Z' }).run()
    db.insert(runs).values({ id: 'latest-simple', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: '2026-09-30T00:00:00.000Z' }).run()
    expect(service.summary('p', { mode: 'advanced', revision: 1, queryClass: 'branded', scope: 'project' }).selection).toMatchObject({ runId: 'r', revision: 1, mode: 'advanced' })
    expect(service.summary('p', { mode: 'advanced', queryClass: 'branded', scope: 'project' }).selection).toMatchObject({ runId: 'later-advanced', revision: 2, mode: 'advanced' })
  })

  it('matches a Simple subject by its frozen display name when the stored aliases are empty', () => {
    // normalizeProjectAliases strips the display name, so this is the stored shape of a brand with no extra aliases.
    expect(normalizeProjectAliases('Acme Roofing', ['Acme Roofing'])).toEqual([])
    db.insert(runs).values({ id: 'r', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: now }).run()
    const definition = buildSimpleMeasurementDefinition({ capturedAt: now, identity: { displayName: 'Acme Roofing', aliases: [], canonicalDomain: 'acmeroofing.example', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'gpt-test' }], queries: [{ queryId: 'q', queryText: 'best roof repair companies', provenance: null }] })
    expect(definition.queries[0]!.queryClass).toBe('non-brand')
    db.insert(simpleMeasurementDefinitions).values({ runId: 'r', projectId: 'p', definition, checksum: 'test', capturedAt: now }).run()
    const answer = 'Acme Roofing is a top pick for roof repairs. Other firms are slower.'
    db.insert(querySnapshots).values({ id: 's', runId: 'r', queryId: 'q', queryText: 'best roof repair companies', provider: 'openai', model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: answer, citationState: 'not-cited', createdAt: now }).run()
    const [assessment] = selectSentimentSources(db, 'p', { runId: 'r', queryClass: 'non-brand' }).assessments
    expect(assessment!.subject).toMatchObject({ name: 'Acme Roofing', mentionNotApplicable: false })
    expect(assessment!.subject.aliases).toContain('Acme Roofing')
    // The classifier's non-brand pre-gate matches frozen aliases, qualified aliases and URL hosts only.
    const input = sentimentClassifierInput(assessment!, createSentimentEvaluationDefinition())
    const gate = compileBrandAliases([...input.subject.aliases, ...input.subject.qualifiedAliases, ...input.subject.urls.flatMap(url => hostOf(url) ?? [])])
    expect(matcherMatchesText(gate, input.sourceText)).toBe(true)
  })

  it.each([['an identity stamped before language provenance', stampedIdentity()], ['no execution identity', null]])('skips an Advanced run with %s instead of storing an unsupported language', (_label, identity) => {
    const plan = advancedPlan()
    advancedRun('legacy', plan, identity)
    const selected = selectSentimentSources(db, 'p', { runId: 'legacy', queryClass: 'non-brand' })
    expect(selected.assessments).toEqual([])
    expect(selected.skipped).toEqual({ 'legacy-missing-language': 1 })
    const sentiment = service()
    sentiment.configure('p', { enabled: true })
    const preview = sentiment.preview('p', { runId: 'legacy', queryClass: 'non-brand' })
    expect(preview.eligibleAssessments).toBe(0)
    expect(preview.skipped).toEqual([{ runId: 'legacy', reason: 'legacy-missing-language', count: 1 }])
    advancedRun('stamped', plan, stampedIdentity('en-US'))
    const stamped = selectSentimentSources(db, 'p', { runId: 'stamped', queryClass: 'non-brand' })
    expect(stamped.assessments).toHaveLength(4)
    expect(new Set(stamped.assessments.map(item => item.language))).toEqual(new Set(['en-US']))
  })

  it('reports answers excluded only by query class for Simple and Advanced selections', () => {
    db.insert(queries).values({ id: 'q-category', projectId: 'p', query: 'best service providers', createdAt: now }).run()
    db.insert(runs).values({ id: 'r', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: now }).run()
    const definition = buildSimpleMeasurementDefinition({ capturedAt: now, identity: { displayName: 'Original', aliases: [], canonicalDomain: 'original.example', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'gpt-test' }], queries: [{ queryId: 'q', queryText: 'Original reviews', provenance: null }, { queryId: 'q-category', queryText: 'best service providers', provenance: null }] })
    expect(definition.queries.map(query => query.queryClass)).toEqual(['branded', 'non-brand'])
    db.insert(simpleMeasurementDefinitions).values({ runId: 'r', projectId: 'p', definition, checksum: 'test', capturedAt: now }).run()
    snapshot('s-brand')
    db.insert(querySnapshots).values({ id: 's-category', runId: 'r', queryId: 'q-category', queryText: 'best service providers', provider: 'openai', model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Original is a good option.', citationState: 'not-cited', createdAt: now }).run()
    expect(selectSentimentSources(db, 'p', { runId: 'r' })).toMatchObject({ skipped: { 'excluded-non-brand': 1 }, assessments: [{ snapshotId: 's-brand' }] })
    expect(selectSentimentSources(db, 'p', { runId: 'r', queryClass: 'non-brand' })).toMatchObject({ skipped: { 'excluded-branded': 1 }, assessments: [{ snapshotId: 's-category' }] })
    // Answers another filter already excludes are not attributed to the class.
    expect(selectSentimentSources(db, 'p', { runId: 'r', provider: 'gemini' }).skipped).toEqual({})
    const sentiment = service()
    sentiment.configure('p', { enabled: true })
    expect(sentiment.preview('p', { runId: 'r' }).skipped).toEqual([{ runId: 'r', reason: 'excluded-non-brand', count: 1 }])

    const plan = advancedPlan()
    advancedRun('advanced', plan, stampedIdentity('en'))
    // exec-brand is branded for one Property; exec-nearby is non-brand for two, on two engines each.
    expect(selectSentimentSources(db, 'p', { runId: 'advanced' })).toMatchObject({ skipped: { 'excluded-non-brand': 4 } })
    expect(selectSentimentSources(db, 'p', { runId: 'advanced' }).assessments).toHaveLength(2)
    expect(selectSentimentSources(db, 'p', { runId: 'advanced', queryClass: 'non-brand' }).skipped).toEqual({ 'excluded-branded': 2 })
  })

  it('never loads raw provider payloads or run manifests while selecting sources', () => {
    simple(); snapshot()
    db.update(querySnapshots).set({ rawResponse: JSON.stringify({ payload: 'x'.repeat(4096) }) }).run()
    const plan = advancedPlan()
    advancedRun('advanced', plan, stampedIdentity('en'))
    db.insert(runs).values({ id: 'partial', projectId: 'p', kind: 'answer-visibility', status: 'partial', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: stampedIdentity('en'), createdAt: now }).run()
    const prepare = vi.spyOn(db.$client, 'prepare')
    const selected = selectSentimentSources(db, 'p', { runIds: ['r', 'advanced', 'partial'] })
    expect(selected.assessments).toHaveLength(3)
    const statements = prepare.mock.calls.map(([sql]) => String(sql))
    const snapshotReads = statements.filter(sql => /from "query_snapshots"/.test(sql))
    expect(snapshotReads.length).toBeGreaterThan(0)
    for (const sql of snapshotReads) expect(sql).not.toContain('"raw_response"')
    const runListReads = statements.filter(sql => /from "runs"/.test(sql) && /order by/.test(sql))
    expect(runListReads).toHaveLength(1)
    expect(runListReads[0]).not.toContain('"measurement_manifest"')
  })
})
