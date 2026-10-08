import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSimpleMeasurementDefinition,
  canonicalMeasurementPlanV2Json,
  canonicalSimpleMeasurementDefinitionJson,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type MeasurementChangesResponse,
  type MeasurementOverviewResponse,
  type MeasurementPlanV2,
  type MeasurementPortfolioSummaryResponse,
  type VisibilityReportRate,
  type VisibilityReportResponse,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  competitors,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { plansAreLabelOnlyVariants } from '../src/measurement-draft-compile.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const FIRST = '2026-09-01T12:00:00.000Z'
const SECOND = '2026-09-02T12:00:00.000Z'
const THIRD = '2026-09-03T12:00:00.000Z'
const READ_KEY = 'cnry_visibility_reader'

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string

function reportUrl(query = ''): string {
  return `/api/v1/projects/northstar/visibility-report${query ? `?${query}` : ''}`
}

async function report(query = ''): Promise<{ status: number; body: VisibilityReportResponse | { error: { code: string; message: string } } }> {
  const response = await app.inject({
    method: 'GET',
    url: reportUrl(query),
    headers: { authorization: `Bearer ${READ_KEY}` },
  })
  return { status: response.statusCode, body: response.json() as VisibilityReportResponse | { error: { code: string; message: string } } }
}

function plan(overrides: { queryText?: string; harborLabel?: string; reportingScopes?: MeasurementPlanV2['reportingScopes'] } = {}): MeasurementPlanV2 {
  const base = measurementPlanV2Fixture()
  const queryText = overrides.queryText ?? base.executionNodes.find(node => node.stableKey === 'exec-nearby')!.queryText
  return measurementPlanV2Fixture({
    targets: base.targets.map(target => target.stableKey === 'harbor'
      ? { ...target, label: overrides.harborLabel ?? target.label }
      : target),
    querySnapshots: base.querySnapshots.map(query => query.queryId === 'q-nearby' ? { ...query, queryText } : query),
    executionNodes: base.executionNodes.map(node => node.stableKey === 'exec-nearby' ? { ...node, queryText } : node),
    ...(overrides.reportingScopes === undefined ? {} : { reportingScopes: overrides.reportingScopes }),
  })
}

function seedVersion(revision: number, frozenPlan: MeasurementPlanV2, comparableToVersionId: string | null = null): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(frozenPlan),
    checksum: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
    schemaVersion: 2,
    compiledChecksum: frozenPlan.compiledChecksum,
    comparableToVersionId,
    createdAt: FIRST,
  }).run()
  return id
}

function activate(versionId: string): void {
  db.insert(measurementPlans).values({
    projectId,
    activeVersionId: versionId,
    createdAt: THIRD,
    updatedAt: THIRD,
  }).onConflictDoUpdate({
    target: measurementPlans.projectId,
    set: { activeVersionId: versionId, updatedAt: THIRD },
  }).run()
}

function seedAdvancedRun(input: {
  versionId: string
  frozenPlan: MeasurementPlanV2
  createdAt: string
  requestedModel?: string
  answerText?: string
  measurementScope?: { groups: string[]; targets: string[]; queries: string[]; resolvedTargets: string[] }
}): string {
  const id = crypto.randomUUID()
  const manifest = buildMeasurementPlanV2Manifest(input.frozenPlan)
  const expectedSlots = manifest.expectedSlots.map(slot => ({
    ...slot,
    ...(input.requestedModel === undefined ? {} : { requestedModel: input.requestedModel }),
  }))
  db.insert(runs).values({
    id,
    projectId,
    kind: RunKinds['answer-visibility'],
    status: RunStatuses.completed,
    trigger: RunTriggers.manual,
    measurementPlanVersionId: input.versionId,
    measurementManifest: { schemaVersion: 1, expectedSlots },
    measurementExecutionIdentity: {
      schemaVersion: 1,
      providers: ['gemini', 'openai'],
      models: { gemini: 'pin-gemini', openai: 'pin-openai' },
      checksum: 'stable-model-series',
    },
    ...(input.measurementScope === undefined ? {} : { measurementScope: input.measurementScope }),
    finishedAt: input.createdAt,
    createdAt: input.createdAt,
  }).run()
  for (const slot of expectedSlots) {
    const nearby = slot.executionId === 'exec-nearby'
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: id,
      queryId: null,
      queryText: slot.queryText,
      provider: slot.provider,
      model: input.requestedModel ?? null,
      servedModel: `${slot.provider}-served`,
      citationState: 'cited',
      answerMentioned: true,
      answerText: input.answerText ?? (nearby ? 'Harbor Homes and Challenger are recommended.' : 'Northstar is reliable.'),
      citedDomains: ['challenger.example'],
      citedUrls: [nearby
        ? 'https://northstar.example/locations/harbor/details'
        : 'https://northstar.example/locations/harbor/reviews'],
      captureStatus: 'complete',
      recommendedCompetitors: nearby ? ['Observed Alternative'] : [],
      location: HARBOR_CONTEXT.label,
      measurementExecutionId: slot.executionId,
      requestedContext: HARBOR_CONTEXT,
      supportedContext: { status: 'applied', resolved: HARBOR_CONTEXT },
      createdAt: input.createdAt,
    }).run()
  }
  return id
}

function seedSimpleRun(id: string, capturedAt: string, withDefinition: boolean, requestedModel = 'simple-pin', qualifiedAliases?: string[], competitorAliases = ['Challenger']): void {
  db.insert(runs).values({
    id,
    projectId,
    kind: RunKinds['answer-visibility'],
    status: RunStatuses.completed,
    trigger: RunTriggers.manual,
    finishedAt: capturedAt,
    createdAt: capturedAt,
  }).run()
  if (withDefinition) {
    db.insert(queries).values({
      id: 'simple-query',
      projectId,
      query: 'frozen simple query',
      createdAt: capturedAt,
    }).onConflictDoNothing().run()
    const definition = buildSimpleMeasurementDefinition({
      capturedAt,
      identity: { displayName: 'Frozen Northstar', aliases: ['Northstar'], canonicalDomain: 'northstar.example', ownedDomains: [], qualifiedAliases },
      country: 'US', language: 'en', location: null,
      engines: [{ provider: 'openai', requestedModel }],
      competitors: [{ domain: 'challenger.example', label: 'Challenger', aliases: competitorAliases }],
      queries: [{ queryId: 'simple-query', queryText: 'frozen simple query', provenance: 'manual' }],
    })
    db.insert(simpleMeasurementDefinitions).values({
      runId: id,
      projectId,
      definition,
      checksum: crypto.createHash('sha256').update(canonicalSimpleMeasurementDefinitionJson(definition)).digest('hex'),
      capturedAt,
    }).run()
  }
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: id,
    queryId: withDefinition ? 'simple-query' : null,
    queryText: withDefinition ? 'frozen simple query' : 'legacy query',
    provider: 'openai',
    model: withDefinition ? requestedModel : null,
    servedModel: 'openai-served',
    citationState: 'cited',
    answerMentioned: withDefinition ? true : null,
    answerText: 'Frozen Northstar and Challenger are mentioned.',
    citedDomains: ['challenger.example'],
    citedUrls: ['https://northstar.example/'],
    captureStatus: 'complete',
    recommendedCompetitors: ['Observed Alternative'],
    location: null,
    createdAt: capturedAt,
  }).run()
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-visibility-report-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'northstar.example',
    country: 'US', language: 'en',
    createdAt: FIRST, updatedAt: FIRST,
  }).run()
  db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain: 'challenger.example', createdAt: FIRST }).run()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'visibility reader',
    keyHash: hashApiKey(READ_KEY),
    keyPrefix: READ_KEY.slice(0, 9),
    scopes: ['read'],
    projectId,
    createdAt: FIRST,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('visibility report route', () => {
  it('rejects a market refinement against a legacy/simple definition without market edges', async () => {
    const result = await report('scope=project&marketKey=harbor-market&queryClass=non-brand')
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ error: { message: 'Market "harbor-market" is not in this frozen definition.' } })
  })

  it('keeps historical evidence selectable and re-reads changed or removed history without stale summaries', async () => {
    const frozenPlan = plan()
    const versionId = seedVersion(1, frozenPlan)
    activate(versionId)
    const historicalAnswer = 'Harbor Homes remains available.'
    const historicalId = seedAdvancedRun({ versionId, frozenPlan, createdAt: FIRST, answerText: historicalAnswer })
    const latestId = seedAdvancedRun({ versionId, frozenPlan, createdAt: SECOND })
    const initial = await report('queryClass=non-brand')
    expect(initial.status).toBe(200)
    const first = initial.body as VisibilityReportResponse
    const population = first.populations[0]!
    expect(first.selection.run.id).toBe(latestId)
    expect(population.trend.map(point => point.runId)).toEqual([historicalId, latestId])
    const queryKey = population.queries.items[0]!.queryKey
    const detail = await report(`runId=${historicalId}&queryClass=non-brand&queryKey=${encodeURIComponent(queryKey)}`)
    expect(detail.status).toBe(200)
    const oldEvidence = (detail.body as VisibilityReportResponse).populations[0]!.evidence.items
    expect(oldEvidence.length).toBeGreaterThan(0)
    expect(oldEvidence.every(answer => answer.answerText === historicalAnswer && answer.sources.length > 0)).toBe(true)

    db.update(querySnapshots).set({ answerText: 'No property names are supplied.', citedUrls: [], captureStatus: 'complete' })
      .where(eq(querySnapshots.runId, historicalId)).run()
    const refreshed = (await report('queryClass=non-brand')).body as VisibilityReportResponse
    expect(refreshed.populations[0]!.trend[0]!.mentionCoverage.rate).toBe(0)
    expect(refreshed.populations[0]!.trend[0]!.citationCoverage.rate).toBe(0)
    expect(refreshed.populations[0]!.summary).toEqual(population.summary)

    db.delete(runs).where(eq(runs.id, historicalId)).run()
    const afterClear = (await report('queryClass=non-brand')).body as VisibilityReportResponse
    expect(afterClear.populations[0]!.trend.map(point => point.runId)).toEqual([latestId])
    expect(afterClear.populations[0]!.summary).toEqual(population.summary)
  })

  it('uses the prior run’s own frozen plan after a material publish and keeps a market to exact usage edges', async () => {
    const market = [{
      stableKey: 'harbor-market', label: 'Harbor market', kind: 'market' as const,
      usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' }],
    }]
    const oldPlan = plan({ queryText: 'frozen old question', reportingScopes: market })
    const oldVersion = seedVersion(1, oldPlan)
    seedAdvancedRun({ versionId: oldVersion, frozenPlan: oldPlan, createdAt: FIRST })
    const activePlan = plan({ queryText: 'new active question', reportingScopes: market })
    const activeVersion = seedVersion(2, activePlan)
    activate(activeVersion)

    const result = await report('scope=market&scopeKey=harbor-market&queryClass=non-brand')
    expect(result.status).toBe(200)
    const body = result.body as VisibilityReportResponse
    const population = body.populations[0]!
    expect(body.selection.measurement).toMatchObject({ activeRevision: 2, measuredRevision: 1, awaitingSweep: true, pendingAssignmentCount: 2 })
    expect(population.queries.items.map(row => row.query)).toEqual(['frozen old question', 'frozen old question'])
    expect(population.breakdown.properties.map(row => row.id)).toEqual(['harbor'])
    expect(population.summary.answerCount).toBe(2)
    expect(population.observedCompetitors).toEqual([{ name: 'Observed Alternative', answerCount: 2 }])
  })

  it('intersects marketKey with a group scope and returns only explicit frozen market navigation', async () => {
    const frozenPlan = plan({ reportingScopes: [
      {
        stableKey: 'harbor-market', label: 'Harbor market', kind: 'market', groupKey: 'regional',
        usageEdges: [
          { executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' },
          { executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-brand' },
        ],
      },
      {
        stableKey: 'bayside-market', label: 'Bayside market', kind: 'market',
        usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'bayside', queryId: 'q-nearby' }],
      },
    ] })
    const versionId = seedVersion(1, frozenPlan)
    activate(versionId)
    seedAdvancedRun({ versionId, frozenPlan, createdAt: FIRST })

    const result = await report('scope=group&scopeKey=regional&marketKey=harbor-market&queryClass=non-brand')
    expect(result.status).toBe(200)
    const body = result.body as VisibilityReportResponse
    expect(body.selection.scope.id).toBe('regional')
    expect(body.selection.market).toMatchObject({ id: 'harbor-market', kind: 'market' })
    expect(body.scopeOptions.find(scope => scope.id === 'harbor-market')?.parentGroupIds).toEqual(['regional'])
    expect(body.populations[0]!.summary).toMatchObject({
      queryCount: 1,
      answerCount: 2,
      outcomes: expect.objectContaining({ total: 1 }),
    })
    expect(body.populations[0]!.breakdown.properties.map(row => row.id)).toEqual(['harbor'])
    expect(body.scopeOptions.find(scope => scope.id === 'regional')?.marketKeys).toEqual(['harbor-market'])
    expect(body.scopeOptions.find(scope => scope.id === 'harbor')?.marketKeys).toEqual(['harbor-market'])
    expect(body.scopeOptions.find(scope => scope.id === 'bayside')?.marketKeys).toEqual(['bayside-market'])
  })

  it('uses the active frozen definition across a label-only comparable chain without awaiting a sweep', async () => {
    const firstPlan = plan({ queryText: 'same frozen question', harborLabel: 'Historic Harbor' })
    const firstVersion = seedVersion(1, firstPlan)
    seedAdvancedRun({ versionId: firstVersion, frozenPlan: firstPlan, createdAt: FIRST })
    const relabelledPlan = plan({ queryText: 'same frozen question', harborLabel: 'Current Harbor' })
    const activeVersion = seedVersion(2, relabelledPlan, firstVersion)
    activate(activeVersion)

    const result = await report('queryClass=non-brand')
    expect(result.status).toBe(200)
    const body = result.body as VisibilityReportResponse
    expect(body.selection.measurement).toMatchObject({ activeRevision: 2, measuredRevision: 2, awaitingSweep: false, pendingAssignmentCount: 0 })
    expect(body.populations[0]!.breakdown.properties.map(row => row.label)).toContain('Current Harbor')
    expect(body.populations[0]!.trend[0]!.continuity).toEqual({ state: 'first', comparedRunId: null })
  })

  it('does not let a newer scoped spot check become the default whole-project report', async () => {
    const frozenPlan = plan()
    const version = seedVersion(1, frozenPlan)
    const fullSweep = seedAdvancedRun({ versionId: version, frozenPlan, createdAt: FIRST })
    const spotCheck = seedAdvancedRun({
      versionId: version,
      frozenPlan,
      createdAt: THIRD,
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
    })
    activate(version)

    const defaultResult = await report('queryClass=non-brand')
    expect(defaultResult.status).toBe(200)
    expect((defaultResult.body as VisibilityReportResponse).selection.run)
      .toEqual({ id: fullSweep, explicit: false })

    const explicitResult = await report(`runId=${spotCheck}&queryClass=non-brand`)
    expect(explicitResult.status).toBe(200)
    expect((explicitResult.body as VisibilityReportResponse).selection.run)
      .toEqual({ id: spotCheck, explicit: true })
  })

  it('still reads pre-plan planless sweeps in mode simple on a v2 project', async () => {
    seedSimpleRun('simple-before-plan', FIRST, true)
    const frozenPlan = plan()
    const version = seedVersion(1, frozenPlan)
    const advancedRun = seedAdvancedRun({ versionId: version, frozenPlan, createdAt: SECOND })
    activate(version)

    // The latest planless sweep, a date window over the pre-plan history, and a
    // pinned pre-plan run all answer 200 in simple mode, as before the plan.
    for (const query of [
      'mode=simple&queryClass=non-brand',
      `mode=simple&queryClass=non-brand&from=${FIRST}&to=${FIRST}`,
      'mode=simple&runId=simple-before-plan&queryClass=non-brand',
    ]) {
      const result = await report(query)
      expect(result.status, query).toBe(200)
      const body = result.body as VisibilityReportResponse
      expect(body.selection.mode, query).toBe('simple')
      expect(body.selection.run.id, query).toBe('simple-before-plan')
      expect(body.selection.measurement.state, query).toBe('measured')
    }

    // The default and the advanced read are unchanged.
    for (const query of ['queryClass=non-brand', 'mode=advanced&queryClass=non-brand']) {
      const result = await report(query)
      expect(result.status).toBe(200)
      expect((result.body as VisibilityReportResponse).selection.run.id).toBe(advancedRun)
    }
  })

  it('refuses mode simple on a v2 project with no planless sweep instead of answering not measured', async () => {
    const frozenPlan = plan()
    const version = seedVersion(1, frozenPlan)
    const advancedRun = seedAdvancedRun({ versionId: version, frozenPlan, createdAt: SECOND })
    activate(version)

    const refused = await report('mode=simple&queryClass=non-brand')
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect((refused.body as { error: { message: string } }).error.message).toContain('mode "advanced"')

    // An explicit date window is a read of pre-plan history, so an empty one
    // stays an honest "not measured" rather than an error.
    const windowed = await report(`mode=simple&queryClass=non-brand&from=${FIRST}&to=${THIRD}`)
    expect(windowed.status).toBe(200)
    expect((windowed.body as VisibilityReportResponse).selection.measurement.state).toBe('not-measured')

    // The default read is unchanged.
    const auto = await report('queryClass=non-brand')
    expect(auto.status).toBe(200)
    expect((auto.body as VisibilityReportResponse).selection.run.id).toBe(advancedRun)
  })

  it('does not turn a project-level legacy mention boolean into Property-level advanced evidence', async () => {
    const frozenPlan = plan()
    const version = seedVersion(1, frozenPlan)
    const runId = seedAdvancedRun({ versionId: version, frozenPlan, createdAt: FIRST })
    activate(version)
    db.update(querySnapshots).set({ answerText: null, answerMentioned: true })
      .where(eq(querySnapshots.runId, runId)).run()

    const result = await report('queryClass=non-brand')
    expect(result.status).toBe(200)
    expect((result.body as VisibilityReportResponse).populations[0]!.summary.mentionCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
  })

  it('keeps frozen simple identities, query text, requested-model pin, and observed competitors while legacy stays unknown', async () => {
    seedSimpleRun('simple-frozen', SECOND, true)
    seedSimpleRun('simple-legacy', THIRD, false)
    db.update(projects).set({ displayName: 'Live Rename', aliases: ['Live'] }).where(eq(projects.id, projectId)).run()

    const frozen = await report('mode=simple&runId=simple-frozen&queryClass=non-brand')
    expect(frozen.status).toBe(200)
    const frozenBody = frozen.body as VisibilityReportResponse
    expect(frozenBody.selection.provenance.kind).toBe('frozen-simple')
    expect(frozenBody.populations[0]!.queries.items[0]!.query).toBe('frozen simple query')
    expect(frozenBody.populations[0]!.breakdown.properties[0]!.label).toBe('Frozen Northstar')
    expect(frozenBody.populations[0]!.competitorAvailability).toEqual({ state: 'available' })
    expect(frozenBody.populations[0]!.competitors.map(row => row.domain)).toEqual(['challenger.example'])
    expect(frozenBody.populations[0]!.observedCompetitors).toEqual([{ name: 'Observed Alternative', answerCount: 1 }])

    const legacy = await report('mode=simple&runId=simple-legacy&queryClass=all')
    expect(legacy.status).toBe(200)
    const legacyBody = legacy.body as VisibilityReportResponse
    expect(legacyBody.selection.provenance.kind).toBe('legacy-simple')
    expect(legacyBody.populations.map(population => population.queryClass)).toEqual(['branded', 'non-brand', 'unknown'])
    const unknown = legacyBody.populations[2]!
    expect(unknown.summary.mentionCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
    expect(unknown.competitorAvailability).toEqual({ state: 'unavailable', reason: 'frozen-competitor-identity-missing' })
    expect(unknown.observedCompetitors).toEqual([{ name: 'Observed Alternative', answerCount: 1 }])
  })

  it('treats an empty frozen Simple answer as a measured non-mention', async () => {
    seedSimpleRun('simple-empty-answer', SECOND, true)
    db.update(querySnapshots).set({ answerText: '', answerMentioned: true })
      .where(eq(querySnapshots.runId, 'simple-empty-answer')).run()

    const result = await report('mode=simple&runId=simple-empty-answer&queryClass=non-brand')
    expect(result.status).toBe(200)
    expect((result.body as VisibilityReportResponse).populations[0]!.summary.mentionCoverage)
      .toEqual({ numerator: 0, denominator: 1, rate: 0 })
  })

  it('reads frozen Simple project and competitor mentions from the answer prose, not its citation chips', async () => {
    // Shape of an OpenAI web-search answer: both brands appear only in the
    // inline source chips, which are citations.
    seedSimpleRun('simple-chips', SECOND, true)
    db.update(querySnapshots).set({
      answerText: 'Rates start at $40 an hour. ([northstar.example](https://northstar.example/pricing?utm_source=chatgpt.com), [Challenger](https://challenger.example/rates?utm_source=chatgpt.com))',
      answerMentioned: true,
    }).where(eq(querySnapshots.runId, 'simple-chips')).run()

    const result = await report('mode=simple&runId=simple-chips&queryClass=non-brand')
    expect(result.status).toBe(200)
    const population = (result.body as VisibilityReportResponse).populations[0]!
    expect(population.summary.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    const challenger = population.competitors.find(row => row.domain === 'challenger.example')!
    expect(challenger.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(challenger.citationCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
  })

  it('compares semantically identical frozen simple captures and breaks only at a requested-model change', async () => {
    seedSimpleRun('simple-first', FIRST, true)
    seedSimpleRun('simple-second', SECOND, true)
    seedSimpleRun('simple-model-change', THIRD, true, 'simple-pin-v2')

    const result = await report('mode=simple&queryClass=non-brand')
    expect(result.status).toBe(200)
    const trend = (result.body as VisibilityReportResponse).populations[0]!.trend
    expect(trend.map(point => point.continuity)).toEqual([
      { state: 'first', comparedRunId: null },
      { state: 'comparable', comparedRunId: 'simple-first' },
      { state: 'model-changed', comparedRunId: 'simple-second' },
    ])
  })

  it('keeps simple captures that differ only in their sentiment-only qualified aliases on one definition', async () => {
    seedSimpleRun('simple-first', FIRST, true)
    seedSimpleRun('simple-qualified', SECOND, true, 'simple-pin', ['Northstar'])
    const stored = db.select().from(simpleMeasurementDefinitions).all()
    expect(stored.map(row => row.definition.identity.qualifiedAliases)).toEqual([undefined, ['Northstar']])

    const result = await report('mode=simple&queryClass=non-brand')
    expect(result.status).toBe(200)
    const population = (result.body as VisibilityReportResponse).populations[0]!
    expect(population.trend.map(point => point.continuity)).toEqual([
      { state: 'first', comparedRunId: null },
      { state: 'comparable', comparedRunId: 'simple-first' },
    ])
    expect(population.trend.map(point => point.runId)).toEqual(['simple-first', 'simple-qualified'])
  })

  it('compares sweeps whose frozen competitors differ only in their names, as auto-detected names do after each sweep', async () => {
    seedSimpleRun('simple-first', FIRST, true)
    seedSimpleRun('simple-auto-name', SECOND, true, 'simple-pin', undefined, ['Challenger', 'Challenger Labs'])
    const stored = db.select().from(simpleMeasurementDefinitions).all()
    expect(stored.map(row => row.definition.competitors?.[0]?.aliases)).toEqual([['Challenger'], ['Challenger', 'Challenger Labs']])

    const result = await report('mode=simple&queryClass=non-brand')
    expect(result.status).toBe(200)
    const population = (result.body as VisibilityReportResponse).populations[0]!
    expect(population.trend.map(point => point.continuity)).toEqual([
      { state: 'first', comparedRunId: null },
      { state: 'comparable', comparedRunId: 'simple-first' },
    ])
    expect(population.comparison).toMatchObject({ state: 'available', previousRun: { id: 'simple-first' } })
  })

  it('rejects malformed selection cursors and missing scope keys, while a scoped read-only key can read only its own project', async () => {
    const frozenPlan = plan()
    const version = seedVersion(1, frozenPlan)
    seedAdvancedRun({ versionId: version, frozenPlan, createdAt: FIRST })
    activate(version)

    const malformed = await report('queryClass=non-brand&cursor=not-a-cursor')
    expect(malformed.status).toBe(400)
    const missingScope = await report('scope=market&queryClass=non-brand')
    expect(missingScope.status).toBe(400)
    expect((await report()).status).toBe(200)
    const sibling = await app.inject({ method: 'GET', url: '/api/v1/projects/not-northstar/visibility-report', headers: { authorization: `Bearer ${READ_KEY}` } })
    expect(sibling.statusCode).toBe(403)
  })

  it('fails closed when a frozen advanced query text or requested model pin is corrupt', async () => {
    const frozenPlan = plan({ queryText: 'pin exact question' })
    const version = seedVersion(1, frozenPlan)
    const runId = seedAdvancedRun({ versionId: version, frozenPlan, createdAt: FIRST, requestedModel: 'requested-pin' })
    activate(version)
    const initial = await report(`runId=${runId}&queryClass=non-brand`)
    expect(initial.status).toBe(200)

    db.update(querySnapshots).set({ model: 'wrong-model' }).where(eq(querySnapshots.runId, runId)).run()
    const mismatchedModel = await report(`runId=${runId}&queryClass=non-brand`)
    expect(mismatchedModel.status).toBe(500)

    db.update(querySnapshots).set({ model: 'requested-pin', queryText: 'wrong question' }).where(eq(querySnapshots.runId, runId)).run()
    const mismatchedQuery = await report(`runId=${runId}&queryClass=non-brand`)
    expect(mismatchedQuery.status).toBe(500)
  })
})

describe('visibility report hierarchy scopes', () => {
  it('uses current navigation parents with comparable saved evidence and preserves historical topology', async () => {
    const firstPlan = measurementPlanV2Fixture({
      groups: [
        { stableKey: 'metro', label: 'Metro', targetKeys: ['harbor', 'bayside'], competitors: [] },
        { stableKey: 'submarket', label: 'Submarket', targetKeys: ['harbor'], competitors: [] },
      ],
    })
    const firstVersion = seedVersion(1, firstPlan)
    const runId = seedAdvancedRun({ versionId: firstVersion, frozenPlan: firstPlan, createdAt: FIRST })
    activate(firstVersion)
    const before = await report('scope=group&scopeKey=submarket&queryClass=non-brand')
    expect(before.status).toBe(200)

    const nestedPlan = measurementPlanV2Fixture({
      ...firstPlan,
      groups: firstPlan.groups.map(group => group.stableKey === 'submarket'
        ? { ...group, parentGroupKey: 'metro' } : group),
    })
    activate(seedVersion(2, nestedPlan, plansAreLabelOnlyVariants(firstPlan, nestedPlan) ? firstVersion : null))
    const result = await report('scope=group&scopeKey=submarket&queryClass=non-brand')
    expect(result.status).toBe(200)
    const body = result.body as VisibilityReportResponse
    expect(body.selection.run).toEqual({ id: runId, explicit: false })
    expect(body.selection.measurement).toMatchObject({ activeRevision: 2, measuredRevision: 2, awaitingSweep: false, pendingAssignmentCount: 0 })
    expect(body.populations[0]!.summary).toEqual((before.body as VisibilityReportResponse).populations[0]!.summary)
    expect(body.scopeOptions.find(scope => scope.id === 'submarket')?.parentGroupIds).toEqual(['metro'])

    const historical = await report('revision=1&scope=group&scopeKey=submarket&queryClass=non-brand')
    expect(historical.status).toBe(200)
    expect((historical.body as VisibilityReportResponse).scopeOptions.find(scope => scope.id === 'submarket')?.parentGroupIds).toBeUndefined()
  })

  it('returns explicit frozen group parents and every property membership without inferred hierarchy', async () => {
    const frozenPlan = measurementPlanV2Fixture({
      groups: [
        { stableKey: 'metro', label: 'Metro', targetKeys: ['harbor', 'bayside'], competitors: [] },
        { stableKey: 'submarket', label: 'Submarket', parentGroupKey: 'metro', targetKeys: ['harbor'], competitors: [] },
      ],
    })
    activate(seedVersion(1, frozenPlan))
    const result = await report('queryClass=non-brand')
    expect(result.status).toBe(200)
    const scopes = (result.body as VisibilityReportResponse).scopeOptions
    expect(scopes.find(scope => scope.id === 'metro')?.parentGroupIds).toBeUndefined()
    expect(scopes.find(scope => scope.id === 'submarket')?.parentGroupIds).toEqual(['metro'])
    expect(scopes.find(scope => scope.id === 'harbor')?.parentGroupIds).toEqual(['metro', 'submarket'])
    expect(scopes.find(scope => scope.id === 'bayside')?.parentGroupIds).toEqual(['metro'])
  })
})

// ── Citation coverage with incomplete source capture ────────────────────────
//
// Three engines answer each query, so one answer can be left out of a rate
// while others are still checked. `CITING` answers capture Harbor's page and
// the tracked competitor; the rest capture nothing. An answer saved with
// `captureStatus: 'partial'` is unchecked: it leaves both sides of every
// citation rate, even when it captured a positive.
const CAPTURE_PROVIDERS = ['claude', 'gemini', 'openai'] as const
const CITING = new Set(['exec-nearby:openai', 'exec-nearby:gemini', 'exec-brand:openai', 'exec-brand:gemini'])
/** One unchecked non-brand answer (a captured positive) and two unchecked branded answers. */
const UNCHECKED = ['exec-nearby:gemini', 'exec-brand:gemini', 'exec-brand:claude'] as const
const EVIDENCE_INCOMPLETE: VisibilityReportRate = { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }

function capturePlan(): MeasurementPlanV2 {
  const base = measurementPlanV2Fixture()
  return measurementPlanV2Fixture({
    executionNodes: base.executionNodes.map(node => ({
      ...node,
      context: { ...node.context, providers: [...CAPTURE_PROVIDERS] },
      expectedSnapshots: CAPTURE_PROVIDERS.length,
    })),
    reportingScopes: [{
      stableKey: 'bayside-market', label: 'Bayside market', kind: 'market',
      usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'bayside', queryId: 'q-nearby' }],
    }],
  })
}

function seedCaptureRun(input: {
  versionId: string
  frozenPlan: MeasurementPlanV2
  createdAt: string
  unchecked?: readonly string[]
  /** Answers whose captured links name Harbor; defaults to `CITING`. */
  citing?: ReadonlySet<string>
  status?: typeof RunStatuses[keyof typeof RunStatuses]
}): string {
  const id = crypto.randomUUID()
  const manifest = buildMeasurementPlanV2Manifest(input.frozenPlan)
  db.insert(runs).values({
    id,
    projectId,
    kind: RunKinds['answer-visibility'],
    status: input.status ?? RunStatuses.completed,
    trigger: RunTriggers.manual,
    measurementPlanVersionId: input.versionId,
    measurementManifest: manifest,
    measurementExecutionIdentity: {
      schemaVersion: 1,
      providers: [...CAPTURE_PROVIDERS],
      models: { claude: 'pin-claude', gemini: 'pin-gemini', openai: 'pin-openai' },
      checksum: 'capture-series',
    },
    finishedAt: input.createdAt,
    createdAt: input.createdAt,
  }).run()
  for (const slot of manifest.expectedSlots) {
    const key = `${slot.executionId}:${slot.provider}`
    const cites = (input.citing ?? CITING).has(key)
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: id,
      queryId: null,
      queryText: slot.queryText,
      provider: slot.provider,
      servedModel: `${slot.provider}-served`,
      citationState: cites ? 'cited' : 'not-cited',
      answerMentioned: true,
      answerText: slot.executionId === 'exec-nearby' ? 'Harbor Homes and Challenger are recommended.' : 'Northstar is reliable.',
      citedDomains: cites ? ['northstar.example', 'challenger.example'] : [],
      citedUrls: cites ? ['https://northstar.example/locations/harbor/details'] : [],
      captureStatus: input.unchecked?.includes(key) ? 'partial' : 'complete',
      recommendedCompetitors: [],
      location: HARBOR_CONTEXT.label,
      measurementExecutionId: slot.executionId,
      requestedContext: HARBOR_CONTEXT,
      supportedContext: { status: 'applied', resolved: HARBOR_CONTEXT },
      createdAt: input.createdAt,
    }).run()
  }
  return id
}

/** A complete previous sweep and a current one with the `UNCHECKED` answers. */
function seedCaptureSeries(): { previousId: string; currentId: string } {
  const frozenPlan = capturePlan()
  const versionId = seedVersion(1, frozenPlan)
  activate(versionId)
  const previousId = seedCaptureRun({ versionId, frozenPlan, createdAt: FIRST })
  const currentId = seedCaptureRun({ versionId, frozenPlan, createdAt: SECOND, unchecked: UNCHECKED })
  return { previousId, currentId }
}

async function read<T>(route: string, query: string): Promise<T> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/${route}?${query}`,
    headers: { authorization: `Bearer ${READ_KEY}` },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as T
}

function population(body: VisibilityReportResponse, queryClass: 'branded' | 'non-brand' | 'unknown') {
  return body.populations.find(row => row.queryClass === queryClass)!
}

describe('visibility report citation coverage with incomplete source capture', () => {
  it('leaves a saved unchecked answer out of both sides of every citation rate and counts it beside the rate', async () => {
    const { previousId, currentId } = seedCaptureSeries()

    const body = await read<VisibilityReportResponse>('visibility-report', 'queryClass=non-brand')
    expect(body.selection.run).toEqual({ id: currentId, explicit: false })
    const nonBrand = population(body, 'non-brand')
    // Openai cites Harbor, claude cites nothing, gemini's capture is incomplete:
    // 1 of the 2 checked answers, though gemini captured a Harbor link too.
    const checked = { numerator: 1, denominator: 2, rate: 0.5, unchecked: 1 }
    expect(nonBrand.summary).toMatchObject({ answerCount: 3, citationCoverage: checked })
    // Mention is a separate signal: the unchecked answer still counts for it.
    expect(nonBrand.summary.mentionCoverage).toEqual({ numerator: 3, denominator: 3, rate: 1 })
    // Bayside is cited in no checked answer, and the unchecked one may hold the
    // citation nobody read: its outcome is unknown, never "neither".
    expect(nonBrand.summary.outcomes).toEqual({ bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 1, total: 2 })
    expect(nonBrand.breakdown.properties.map(row => [row.id, row.citationCoverage])).toEqual([
      ['bayside', { numerator: 0, denominator: 2, rate: 0, unchecked: 1 }],
      ['harbor', checked],
    ])
    expect(nonBrand.breakdown.groups.map(row => [row.id, row.citationCoverage])).toEqual([['regional', checked]])
    expect(nonBrand.trend.map(point => [point.runId, point.citationCoverage])).toEqual([
      [previousId, { numerator: 2, denominator: 3, rate: 2 / 3 }],
      [currentId, checked],
    ])
    expect(nonBrand.comparison).toMatchObject({
      state: 'available',
      citationCoverage: { state: 'available', previous: { numerator: 2, denominator: 3, rate: 2 / 3 }, delta: 1 / 2 - 2 / 3 },
    })
    // Every query row holds one engine's answer, so the unchecked one is a row
    // with nothing checked: unavailable, not a zero. The other rows are exact.
    expect(nonBrand.queries.items.map(row => [row.provider, row.citationCoverage])).toEqual([
      ['claude', { numerator: 0, denominator: 1, rate: 0 }],
      ['gemini', EVIDENCE_INCOMPLETE],
      ['openai', { numerator: 1, denominator: 1, rate: 1 }],
    ])
    expect(nonBrand.competitors).toEqual([{
      domain: 'challenger.example',
      answerCount: 3,
      mentionCoverage: { numerator: 3, denominator: 3, rate: 1 },
      citationCoverage: checked,
    }])

    // A market reads its own edges under the same rule.
    const market = population(await read<VisibilityReportResponse>('visibility-report', 'scope=market&scopeKey=bayside-market&queryClass=non-brand'), 'non-brand')
    const baysideChecked = { numerator: 0, denominator: 2, rate: 0, unchecked: 1 }
    expect(market.summary.citationCoverage).toEqual(baysideChecked)
    expect(market.breakdown.properties.map(row => [row.id, row.citationCoverage])).toEqual([['bayside', baysideChecked]])
  })

  it('reports the same checked rate on the Advanced overview, portfolio and changes reads', async () => {
    seedCaptureSeries()
    const checked = { state: 'available', value: 0.5, numerator: 1, denominator: 2, unchecked: 1 }
    const baysideChecked = { state: 'available', value: 0, numerator: 0, denominator: 2, unchecked: 1 }
    const report = population(await read<VisibilityReportResponse>('visibility-report', 'queryClass=non-brand'), 'non-brand')

    const overview = await read<MeasurementOverviewResponse>('measurement-overview', 'scope=all&queryClass=non-brand')
    expect(overview.metrics.citationCoverage).toEqual(checked)
    expect(overview.outcomes).toEqual(report.summary.outcomes)
    const harbor = overview.properties.items.find(row => row.targetKey === 'harbor')!
    expect(harbor.citationCoverage).toEqual(checked)
    expect(overview.properties.items.find(row => row.targetKey === 'bayside')!.citationCoverage).toEqual(baysideChecked)
    // One engine's split holds one answer each: gemini's has nothing checked.
    expect(harbor.providers.map(row => [row.provider, row.citationCoverage])).toEqual([
      ['claude', { state: 'available', value: 0, numerator: 0, denominator: 1 }],
      ['gemini', { state: 'unavailable', reason: 'evidence_incomplete' }],
      ['openai', { state: 'available', value: 1, numerator: 1, denominator: 1 }],
    ])

    const portfolio = await read<MeasurementPortfolioSummaryResponse>('measurement-portfolio-summary', 'queryClass=non-brand')
    expect(portfolio.metrics.citationCoverage).toEqual(checked)
    expect(portfolio.markets.map(row => [row.groupKey, row.citationCoverage])).toEqual([['regional', checked]])
    expect(portfolio.mentionRanking.strongest.map(row => [row.targetKey, row.citationCoverage])).toEqual([
      ['harbor', checked],
      ['bayside', baysideChecked],
    ])

    const changes = await read<MeasurementChangesResponse>('measurement-changes', 'queryClass=non-brand')
    if (changes.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    expect(changes.comparison.metrics.citationCoverage).toEqual({
      state: 'available',
      previous: { state: 'available', value: 2 / 3, numerator: 2, denominator: 3 },
      current: checked,
      delta: 1 / 2 - 2 / 3,
    })
    expect(changes.comparison.changedProperties.find(row => row.targetKey === 'harbor')).toMatchObject({
      citationAnswersDelta: -1,
      denominatorChanged: true,
      citationCoverage: { state: 'available', current: checked },
    })
  })

  it('never lets a link captured only on an unchecked answer decide a Property outcome, on either surface', async () => {
    const frozenPlan = capturePlan()
    const versionId = seedVersion(1, frozenPlan)
    activate(versionId)
    // Harbor's only captured link is on gemini's answer, whose capture is incomplete.
    seedCaptureRun({ versionId, frozenPlan, createdAt: SECOND, unchecked: ['exec-nearby:gemini'], citing: new Set(['exec-nearby:gemini']) })
    const report = population(await read<VisibilityReportResponse>('visibility-report', 'queryClass=non-brand'), 'non-brand')
    // The rate leaves gemini out, so Harbor is cited in 0 of 2 checked answers...
    expect(report.breakdown.properties.find(row => row.id === 'harbor')!.citationCoverage).toEqual({ numerator: 0, denominator: 2, rate: 0, unchecked: 1 })
    // ...and its outcome is unknown, not cited: the same link the rate refuses never counts here either.
    expect(report.summary.outcomes).toEqual({ bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 2, total: 2 })
    const overview = await read<MeasurementOverviewResponse>('measurement-overview', 'scope=all&queryClass=non-brand')
    expect(overview.outcomes).toEqual(report.summary.outcomes)
  })

  it('keeps each query class to its own unchecked answers', async () => {
    seedCaptureSeries()
    // Branded: openai cites Harbor; gemini (a captured positive) and claude are unchecked.
    const body = await read<VisibilityReportResponse>('visibility-report', 'queryClass=all')
    expect(body.populations.map(row => [row.queryClass, row.summary.citationCoverage])).toEqual([
      ['branded', { numerator: 1, denominator: 1, rate: 1, unchecked: 2 }],
      ['non-brand', { numerator: 1, denominator: 2, rate: 0.5, unchecked: 1 }],
      ['unknown', { numerator: null, denominator: null, rate: null, reason: 'no-population' }],
    ])
    expect(population(body, 'branded').competitors.map(row => row.citationCoverage))
      .toEqual([{ numerator: 1, denominator: 1, rate: 1, unchecked: 2 }])

    const branded = await read<MeasurementOverviewResponse>('measurement-overview', 'scope=all&queryClass=branded')
    expect(branded.metrics.citationCoverage).toEqual({ state: 'available', value: 1, numerator: 1, denominator: 1, unchecked: 2 })

    const changes = await read<MeasurementChangesResponse>('measurement-changes', 'queryClass=all')
    if (changes.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    // The pooled block reads all six answers; each class beside it reads only its own.
    expect(changes.comparison.metrics.citationCoverage).toMatchObject({
      current: { state: 'available', value: 2 / 3, numerator: 2, denominator: 3, unchecked: 3 },
    })
    expect(changes.comparison.metricsByClass?.branded.citationCoverage).toMatchObject({
      current: { state: 'available', value: 1, numerator: 1, denominator: 1, unchecked: 2 },
    })
    expect(changes.comparison.metricsByClass?.nonBrand.citationCoverage).toMatchObject({
      current: { state: 'available', value: 0.5, numerator: 1, denominator: 2, unchecked: 1 },
    })
  })

  it('stays evidence-incomplete when no answer could be checked', async () => {
    const frozenPlan = capturePlan()
    const versionId = seedVersion(1, frozenPlan)
    activate(versionId)
    seedCaptureRun({ versionId, frozenPlan, createdAt: FIRST, unchecked: [...CITING, 'exec-nearby:claude', 'exec-brand:claude'] })

    const nonBrand = population(await read<VisibilityReportResponse>('visibility-report', 'queryClass=non-brand'), 'non-brand')
    expect(nonBrand.summary.citationCoverage).toEqual(EVIDENCE_INCOMPLETE)
    expect(nonBrand.breakdown.properties.map(row => row.citationCoverage)).toEqual([EVIDENCE_INCOMPLETE, EVIDENCE_INCOMPLETE])
    expect(nonBrand.competitors.map(row => row.citationCoverage)).toEqual([EVIDENCE_INCOMPLETE])
    expect(nonBrand.summary.mentionCoverage).toEqual({ numerator: 3, denominator: 3, rate: 1 })
    const overview = await read<MeasurementOverviewResponse>('measurement-overview', 'scope=all&queryClass=non-brand')
    expect(overview.metrics.citationCoverage).toEqual({ state: 'unavailable', reason: 'evidence_incomplete' })
    const portfolio = await read<MeasurementPortfolioSummaryResponse>('measurement-portfolio-summary', 'queryClass=non-brand')
    expect(portfolio.metrics.citationCoverage).toEqual({ state: 'unavailable', reason: 'evidence_incomplete' })
  })

  it('still withholds the rate for a missing answer beside an unchecked one', async () => {
    const frozenPlan = capturePlan()
    const versionId = seedVersion(1, frozenPlan)
    activate(versionId)
    const runId = seedCaptureRun({ versionId, frozenPlan, createdAt: FIRST, unchecked: UNCHECKED, status: RunStatuses.partial })
    // Claude's non-brand answer was never saved.
    const claude = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
      .find(row => row.measurementExecutionId === 'exec-nearby' && row.provider === 'claude')!
    db.delete(querySnapshots).where(eq(querySnapshots.id, claude.id)).run()

    const nonBrand = population(await read<VisibilityReportResponse>('visibility-report', `queryClass=non-brand&runId=${runId}`), 'non-brand')
    expect(nonBrand.summary.answerCount).toBe(2)
    expect(nonBrand.summary.citationCoverage).toEqual(EVIDENCE_INCOMPLETE)
    expect(nonBrand.breakdown.properties.map(row => row.citationCoverage)).toEqual([EVIDENCE_INCOMPLETE, EVIDENCE_INCOMPLETE])
    expect(nonBrand.breakdown.groups.map(row => row.citationCoverage)).toEqual([EVIDENCE_INCOMPLETE])
    expect(nonBrand.competitors.map(row => row.citationCoverage)).toEqual([EVIDENCE_INCOMPLETE])
    const portfolio = await read<MeasurementPortfolioSummaryResponse>('measurement-portfolio-summary', `queryClass=non-brand&runId=${runId}`)
    expect(portfolio.metrics.citationCoverage).toEqual({ state: 'unavailable', reason: 'evidence_incomplete' })
  })

  it('never leaves a Simple answer out: its citation state comes from stored cited domains, not URL capture', async () => {
    seedSimpleRun('simple-frozen', SECOND, true)
    seedSimpleRun('simple-legacy', THIRD, false)
    db.update(querySnapshots).set({ captureStatus: 'partial', citedUrls: null }).run()

    const frozen = population(await read<VisibilityReportResponse>('visibility-report', 'mode=simple&runId=simple-frozen&queryClass=non-brand'), 'non-brand')
    expect(frozen.summary.citationCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(frozen.competitors.map(row => [row.domain, row.citationCoverage]))
      .toEqual([['challenger.example', { numerator: 1, denominator: 1, rate: 1 }]])
    const legacy = population(await read<VisibilityReportResponse>('visibility-report', 'mode=simple&runId=simple-legacy&queryClass=all'), 'unknown')
    expect(legacy.summary.citationCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
  })
})
