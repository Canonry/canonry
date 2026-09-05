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
  type MeasurementPlanV2,
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

function seedSimpleRun(id: string, capturedAt: string, withDefinition: boolean, requestedModel = 'simple-pin'): void {
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
      identity: { displayName: 'Frozen Northstar', aliases: ['Northstar'], canonicalDomain: 'northstar.example', ownedDomains: [] },
      country: 'US', language: 'en', location: null,
      engines: [{ provider: 'openai', requestedModel }],
      competitors: [{ domain: 'challenger.example', label: 'Challenger', aliases: ['Challenger'] }],
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
