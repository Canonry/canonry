import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSimpleMeasurementDefinition,
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  canonicalSimpleMeasurementDefinitionJson,
  compileMeasurementPlan,
  RunKinds,
  RunStatuses,
  RunTriggers,
  visibilityReportResponseSchema,
  type MeasurementPlanV2,
  type VisibilityReportResponse,
} from '@ainyc/canonry-contracts'
import {
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
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { readVisibilityReport } from '../src/visibility-report.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const FIRST = '2026-09-01T12:00:00.000Z'
const SECOND = '2026-09-02T12:00:00.000Z'
const THIRD = '2026-09-03T12:00:00.000Z'
const SCOPED = { state: 'unavailable', reason: 'scoped-run', previousRun: null }

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-visibility-comparison-'))
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
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

/** Reads the route and holds the body to the contract, including its delta refine. */
async function report(query: string): Promise<VisibilityReportResponse> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/projects/northstar/visibility-report?${query}` })
  expect(response.statusCode, response.body).toBe(200)
  return visibilityReportResponseSchema.parse(response.json())
}

// Advanced fixture: two Properties share the non-brand `exec-nearby` query,
// asked of openai and gemini, so non-brand coverage has two answers and reach
// has two Properties.

interface NearbyAnswer {
  answerText: string
  cited: boolean
}

type NearbyAnswers = Record<'openai' | 'gemini', NearbyAnswer>

const HARBOR_URL = 'https://northstar.example/locations/harbor/details'

/** Mentioned 1/2, cited 1/2, Properties named 1/2. */
const FIRST_ANSWERS: NearbyAnswers = {
  openai: { answerText: 'Harbor Homes is recommended.', cited: true },
  gemini: { answerText: 'No property names are supplied.', cited: false },
}
/** Mentioned 2/2, cited 0/2, Properties named 2/2. */
const SECOND_ANSWERS: NearbyAnswers = {
  openai: { answerText: 'Harbor Homes and Bayside Homes are recommended.', cited: false },
  gemini: { answerText: 'Bayside Homes is recommended.', cited: false },
}
/** Mentioned 2/2, cited 2/2, Properties named 1/2. */
const THIRD_ANSWERS: NearbyAnswers = {
  openai: { answerText: 'Harbor Homes is recommended.', cited: true },
  gemini: { answerText: 'Harbor Homes is recommended.', cited: true },
}

/** SECOND_ANSWERS measured against FIRST_ANSWERS. */
function secondVersusFirst(previousRunId: string) {
  return {
    state: 'available',
    previousRun: { id: previousRunId, createdAt: FIRST, completedAt: FIRST },
    mentionCoverage: { state: 'available', previous: { numerator: 1, denominator: 2, rate: 0.5 }, delta: 0.5 },
    citationCoverage: { state: 'available', previous: { numerator: 1, denominator: 2, rate: 0.5 }, delta: -0.5 },
    propertyReach: { state: 'available', previous: { numerator: 1, denominator: 2, rate: 0.5 }, delta: 0.5 },
  }
}

/** THIRD_ANSWERS measured against SECOND_ANSWERS. */
function thirdVersusSecond(previousRunId: string) {
  return {
    state: 'available',
    previousRun: { id: previousRunId, createdAt: SECOND, completedAt: SECOND },
    mentionCoverage: { state: 'available', previous: { numerator: 2, denominator: 2, rate: 1 }, delta: 0 },
    citationCoverage: { state: 'available', previous: { numerator: 0, denominator: 2, rate: 0 }, delta: 1 },
    propertyReach: { state: 'available', previous: { numerator: 2, denominator: 2, rate: 1 }, delta: -0.5 },
  }
}

function seedVersion(revision: number, frozenPlan: MeasurementPlanV2): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(frozenPlan),
    checksum: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
    schemaVersion: 2,
    compiledChecksum: frozenPlan.compiledChecksum,
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

/** A schema-v1 plan version, which the v2 reader cannot reconstruct. */
function seedV1Version(): string {
  const queryId = crypto.randomUUID()
  db.insert(queries).values({ id: queryId, projectId, query: 'homes near harbor', createdAt: FIRST }).run()
  const v1Plan = compileMeasurementPlan({
    schemaVersion: 1,
    targets: [{
      stableKey: 'harbor',
      label: 'Harbor Homes',
      urls: [{ kind: 'host', host: 'northstar.example' }],
      aliases: ['Harbor Homes'],
    }],
    groups: [{ stableKey: 'regional', label: 'Regional comparison', targetKeys: ['harbor'], competitors: [] }],
    targetQuerySelections: [{ targetKey: 'harbor', queryIds: [queryId] }],
  }, {
    canonicalDomain: 'northstar.example',
    ownedDomains: [],
    brandNames: ['Northstar'],
    trackedQueries: [{ id: queryId, query: 'homes near harbor' }],
    locations: [],
    defaultContext: null,
    expectedSnapshots: 1,
  })
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    canonicalJson: canonicalMeasurementPlanJson(v1Plan),
    checksum: 'b'.repeat(64),
    schemaVersion: 1,
    createdAt: FIRST,
  }).run()
  return versionId
}

function seedAdvancedRun(input: {
  versionId: string
  frozenPlan: MeasurementPlanV2
  createdAt: string
  nearby: NearbyAnswers
  measurementScope?: { groups: string[]; targets: string[]; queries: string[]; resolvedTargets: string[] }
}): string {
  const id = crypto.randomUUID()
  const manifest = buildMeasurementPlanV2Manifest(input.frozenPlan)
  db.insert(runs).values({
    id,
    projectId,
    kind: RunKinds['answer-visibility'],
    status: RunStatuses.completed,
    trigger: RunTriggers.manual,
    measurementPlanVersionId: input.versionId,
    measurementManifest: { schemaVersion: 1, expectedSlots: manifest.expectedSlots },
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
  for (const slot of manifest.expectedSlots) {
    const answer = slot.executionId === 'exec-nearby'
      ? input.nearby[slot.provider as keyof NearbyAnswers]
      : { answerText: 'Northstar is reliable.', cited: false }
    if (!answer) throw new Error(`No fixture answer for provider ${slot.provider}`)
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: id,
      queryId: null,
      queryText: slot.queryText,
      provider: slot.provider,
      model: null,
      servedModel: `${slot.provider}-served`,
      citationState: answer.cited ? 'cited' : 'not-cited',
      answerMentioned: true,
      answerText: answer.answerText,
      citedDomains: [],
      citedUrls: answer.cited ? [HARBOR_URL] : [],
      captureStatus: 'complete',
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

// Simple fixture: one frozen query asked of openai and gemini, with one
// project Property.

interface SimpleAnswer {
  provider: 'openai' | 'gemini'
  answerText: string
  cited: boolean
}

/** Mentioned 1/2, cited 1/2, the project named 1/1. */
const FIRST_SIMPLE: readonly SimpleAnswer[] = [
  { provider: 'openai', answerText: 'Frozen Northstar is recommended.', cited: true },
  { provider: 'gemini', answerText: 'No brand is named.', cited: false },
]
/** Mentioned 2/2, cited 0/2, the project named 1/1. */
const SECOND_SIMPLE: readonly SimpleAnswer[] = [
  { provider: 'openai', answerText: 'Northstar is recommended.', cited: false },
  { provider: 'gemini', answerText: 'Northstar is recommended.', cited: false },
]

/** SECOND_SIMPLE measured against FIRST_SIMPLE. */
function simpleChange(previousRunId: string) {
  return {
    state: 'available',
    previousRun: { id: previousRunId, createdAt: FIRST, completedAt: FIRST },
    mentionCoverage: { state: 'available', previous: { numerator: 1, denominator: 2, rate: 0.5 }, delta: 0.5 },
    citationCoverage: { state: 'available', previous: { numerator: 1, denominator: 2, rate: 0.5 }, delta: -0.5 },
    propertyReach: { state: 'available', previous: { numerator: 1, denominator: 1, rate: 1 }, delta: 0 },
  }
}

function seedSimpleRun(input: {
  id: string
  capturedAt: string
  frozen: boolean
  answers: readonly SimpleAnswer[]
  openaiModel?: string
  measurementScope?: { groups: string[]; targets: string[]; queries: string[]; resolvedTargets: string[] }
}): void {
  const openaiModel = input.openaiModel ?? 'simple-pin'
  const requestedModels = { openai: openaiModel, gemini: 'gemini-pin' }
  db.insert(runs).values({
    id: input.id,
    projectId,
    kind: RunKinds['answer-visibility'],
    status: RunStatuses.completed,
    trigger: RunTriggers.manual,
    ...(input.measurementScope === undefined ? {} : { measurementScope: input.measurementScope }),
    finishedAt: input.capturedAt,
    createdAt: input.capturedAt,
  }).run()
  if (input.frozen) {
    db.insert(queries).values({
      id: 'simple-query',
      projectId,
      query: 'frozen simple query',
      createdAt: input.capturedAt,
    }).onConflictDoNothing().run()
    const definition = buildSimpleMeasurementDefinition({
      capturedAt: input.capturedAt,
      identity: { displayName: 'Frozen Northstar', aliases: ['Northstar'], canonicalDomain: 'northstar.example', ownedDomains: [] },
      country: 'US', language: 'en', location: null,
      engines: [
        { provider: 'openai', requestedModel: requestedModels.openai },
        { provider: 'gemini', requestedModel: requestedModels.gemini },
      ],
      competitors: [{ domain: 'challenger.example', label: 'Challenger', aliases: ['Challenger'] }],
      queries: [{ queryId: 'simple-query', queryText: 'frozen simple query', provenance: 'manual' }],
    })
    db.insert(simpleMeasurementDefinitions).values({
      runId: input.id,
      projectId,
      definition,
      checksum: crypto.createHash('sha256').update(canonicalSimpleMeasurementDefinitionJson(definition)).digest('hex'),
      capturedAt: input.capturedAt,
    }).run()
  }
  for (const answer of input.answers) {
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: input.id,
      queryId: input.frozen ? 'simple-query' : null,
      queryText: input.frozen ? 'frozen simple query' : 'legacy query',
      provider: answer.provider,
      model: input.frozen ? requestedModels[answer.provider] : null,
      servedModel: `${answer.provider}-served`,
      citationState: answer.cited ? 'cited' : 'not-cited',
      answerMentioned: answer.answerText.includes('Northstar'),
      answerText: answer.answerText,
      citedDomains: [],
      citedUrls: answer.cited ? ['https://northstar.example/'] : [],
      captureStatus: 'complete',
      recommendedCompetitors: [],
      location: null,
      createdAt: input.capturedAt,
    }).run()
  }
}

describe('visibility report comparison: Advanced', () => {
  it('compares an explicit middle run with its own predecessor, which the pinned read did not load', async () => {
    const frozenPlan = measurementPlanV2Fixture()
    const versionId = seedVersion(1, frozenPlan)
    activate(versionId)
    const first = seedAdvancedRun({ versionId, frozenPlan, createdAt: FIRST, nearby: FIRST_ANSWERS })
    const second = seedAdvancedRun({ versionId, frozenPlan, createdAt: SECOND, nearby: SECOND_ANSWERS })
    const third = seedAdvancedRun({ versionId, frozenPlan, createdAt: THIRD, nearby: THIRD_ANSWERS })

    const middle = await report(`queryClass=non-brand&runId=${second}`)
    const population = middle.populations[0]!
    expect(middle.selection.run).toEqual({ id: second, explicit: true })
    expect(population.trend.map(point => point.runId)).toEqual([second])
    expect(population.summary.mentionCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(population.summary.citationCoverage).toEqual({ numerator: 0, denominator: 2, rate: 0 })
    expect(population.summary.propertyReach).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(population.comparison).toEqual(secondVersusFirst(first))

    const latest = await report('queryClass=non-brand')
    expect(latest.selection.run).toEqual({ id: third, explicit: false })
    expect(latest.populations[0]!.trend.map(point => point.runId)).toEqual([first, second, third])
    expect(latest.populations[0]!.comparison).toEqual(thirdVersusSecond(second))
  })

  it('compares against a previous sweep that the date window excludes', async () => {
    const frozenPlan = measurementPlanV2Fixture()
    const versionId = seedVersion(1, frozenPlan)
    activate(versionId)
    const first = seedAdvancedRun({ versionId, frozenPlan, createdAt: FIRST, nearby: FIRST_ANSWERS })
    const second = seedAdvancedRun({ versionId, frozenPlan, createdAt: SECOND, nearby: SECOND_ANSWERS })

    const from = '2026-09-02T00:00:00.000Z'
    const windowed = await report(`queryClass=non-brand&from=${encodeURIComponent(from)}`)
    expect(windowed.selection.time).toEqual({ from, to: null })
    expect(windowed.populations[0]!.trend.map(point => point.runId)).toEqual([second])
    expect(windowed.populations[0]!.comparison).toEqual(secondVersusFirst(first))
  })

  it('never uses a spot check as the previous sweep and reports scoped-run when one is selected', async () => {
    const frozenPlan = measurementPlanV2Fixture()
    const versionId = seedVersion(1, frozenPlan)
    activate(versionId)
    const first = seedAdvancedRun({ versionId, frozenPlan, createdAt: FIRST, nearby: FIRST_ANSWERS })
    const spotCheck = seedAdvancedRun({
      versionId,
      frozenPlan,
      createdAt: SECOND,
      nearby: THIRD_ANSWERS,
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
    })
    const latest = seedAdvancedRun({ versionId, frozenPlan, createdAt: THIRD, nearby: SECOND_ANSWERS })

    const whole = await report('queryClass=non-brand')
    expect(whole.selection.run).toEqual({ id: latest, explicit: false })
    expect(whole.populations[0]!.trend.map(point => point.runId)).toEqual([first, latest])
    // The latest sweep repeats SECOND_ANSWERS, compared with the first sweep.
    const skipped = secondVersusFirst(first)
    expect(whole.populations[0]!.comparison).toEqual(skipped)
    expect((await report(`queryClass=non-brand&runId=${latest}`)).populations[0]!.comparison).toEqual(skipped)

    const spot = await report(`queryClass=all&runId=${spotCheck}`)
    expect(spot.selection.run).toEqual({ id: spotCheck, explicit: true })
    expect(spot.populations.map(population => population.comparison)).toEqual([SCOPED, SCOPED, SCOPED])
  })

  it('reports definition-changed against a schema-v1 predecessor it cannot reconstruct', async () => {
    const v1VersionId = seedV1Version()
    const v1RunId = crypto.randomUUID()
    db.insert(runs).values({
      id: v1RunId,
      projectId,
      kind: RunKinds['answer-visibility'],
      status: RunStatuses.completed,
      trigger: RunTriggers.manual,
      measurementPlanVersionId: v1VersionId,
      finishedAt: FIRST,
      createdAt: FIRST,
    }).run()
    const frozenPlan = measurementPlanV2Fixture()
    const versionId = seedVersion(2, frozenPlan)
    activate(versionId)
    const second = seedAdvancedRun({ versionId, frozenPlan, createdAt: SECOND, nearby: SECOND_ANSWERS })

    const body = await report('queryClass=all')
    expect(body.selection.run).toEqual({ id: second, explicit: false })
    // The v1 run never enters the trend; it is still the sweep that came before.
    expect(body.populations[0]!.trend.map(point => point.runId)).toEqual([second])
    const changed = { state: 'unavailable', reason: 'definition-changed', previousRun: { id: v1RunId, createdAt: FIRST, completedAt: FIRST } }
    expect(body.populations.map(population => population.comparison)).toEqual([changed, changed, changed])
  })

  it('omits comparison from an unsupported schema-v1 response', async () => {
    activate(seedV1Version())

    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/visibility-report?queryClass=all' })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json() as VisibilityReportResponse
    expect(body.selection.availability).toEqual({ state: 'unsupported', reason: 'advanced-v1' })
    expect(body.populations.map(population => Object.hasOwn(population, 'comparison'))).toEqual([false, false, false])
  })
})

describe('visibility report comparison: Simple', () => {
  it('compares two frozen Simple sweeps with exact math, whether or not the predecessor was loaded', async () => {
    seedSimpleRun({ id: 'simple-first', capturedAt: FIRST, frozen: true, answers: FIRST_SIMPLE })
    seedSimpleRun({ id: 'simple-second', capturedAt: SECOND, frozen: true, answers: SECOND_SIMPLE })

    for (const query of ['mode=simple&queryClass=non-brand', 'mode=simple&queryClass=non-brand&runId=simple-second']) {
      const body = await report(query)
      const population = body.populations[0]!
      expect(body.selection.run.id).toBe('simple-second')
      expect(population.summary.mentionCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
      expect(population.summary.citationCoverage).toEqual({ numerator: 0, denominator: 2, rate: 0 })
      expect(population.summary.propertyReach).toEqual({ numerator: 1, denominator: 1, rate: 1 })
      expect(population.comparison).toEqual(simpleChange('simple-first'))
    }
  })

  it('reports legacy-unknown against a legacy Simple predecessor', async () => {
    seedSimpleRun({ id: 'simple-legacy', capturedAt: FIRST, frozen: false, answers: FIRST_SIMPLE })
    seedSimpleRun({ id: 'simple-second', capturedAt: SECOND, frozen: true, answers: SECOND_SIMPLE })

    for (const query of ['mode=simple&queryClass=non-brand', 'mode=simple&queryClass=non-brand&runId=simple-second']) {
      expect((await report(query)).populations[0]!.comparison).toEqual({
        state: 'unavailable',
        reason: 'legacy-unknown',
        previousRun: { id: 'simple-legacy', createdAt: FIRST, completedAt: FIRST },
      })
    }
  })

  it('reports model-changed when the requested model changes', async () => {
    seedSimpleRun({ id: 'simple-first', capturedAt: FIRST, frozen: true, answers: FIRST_SIMPLE })
    seedSimpleRun({ id: 'simple-repinned', capturedAt: SECOND, frozen: true, answers: SECOND_SIMPLE, openaiModel: 'simple-pin-v2' })

    const body = await report('mode=simple&queryClass=non-brand')
    expect(body.populations[0]!.trend.map(point => point.continuity.state)).toEqual(['first', 'model-changed'])
    expect(body.populations[0]!.comparison).toEqual({
      state: 'unavailable',
      reason: 'model-changed',
      previousRun: { id: 'simple-first', createdAt: FIRST, completedAt: FIRST },
    })
  })

  it('orders sweeps created at the same instant by id when finding the previous sweep', async () => {
    seedSimpleRun({ id: 'simple-a', capturedAt: SECOND, frozen: true, answers: FIRST_SIMPLE })
    seedSimpleRun({ id: 'simple-b', capturedAt: SECOND, frozen: true, answers: SECOND_SIMPLE })
    const tied = { ...simpleChange('simple-a'), previousRun: { id: 'simple-a', createdAt: SECOND, completedAt: SECOND } }

    for (const query of ['mode=simple&queryClass=non-brand', 'mode=simple&queryClass=non-brand&runId=simple-b']) {
      const body = await report(query)
      expect(body.selection.run.id).toBe('simple-b')
      expect(body.populations[0]!.comparison).toEqual(tied)
    }
    // The lower id is the earlier sweep, so it has nothing before it.
    expect((await report('mode=simple&queryClass=non-brand&runId=simple-a')).populations[0]!.comparison)
      .toEqual({ state: 'unavailable', reason: 'no-previous-run', previousRun: null })
  })

  it('skips a planless spot check as the previous sweep and reports scoped-run when one is selected', async () => {
    const spotScope = { groups: [], targets: ['project'], queries: [], resolvedTargets: ['project'] }
    seedSimpleRun({ id: 'simple-first', capturedAt: FIRST, frozen: true, answers: FIRST_SIMPLE })
    seedSimpleRun({ id: 'simple-spot', capturedAt: SECOND, frozen: true, answers: FIRST_SIMPLE, measurementScope: spotScope })
    seedSimpleRun({ id: 'simple-third', capturedAt: THIRD, frozen: true, answers: SECOND_SIMPLE })

    const latest = await report('mode=simple&queryClass=non-brand')
    expect(latest.selection.run.id).toBe('simple-third')
    expect(latest.populations[0]!.comparison).toEqual(simpleChange('simple-first'))

    const spot = await report('mode=simple&queryClass=non-brand&runId=simple-spot')
    expect(spot.selection.run.id).toBe('simple-spot')
    expect(spot.populations[0]!.comparison).toEqual(SCOPED)
  })
})

describe('visibility report comparison opt-out', () => {
  it('omits the field and never reads the predecessor when a report build opts out', () => {
    seedSimpleRun({ id: 'simple-first', capturedAt: FIRST, frozen: true, answers: FIRST_SIMPLE })
    seedSimpleRun({ id: 'simple-second', capturedAt: SECOND, frozen: true, answers: SECOND_SIMPLE })
    // Corrupt only the predecessor: reconstructing it fails closed, so any read
    // of it is observable.
    db.update(querySnapshots).set({ model: 'corrupt-pin' }).where(eq(querySnapshots.runId, 'simple-first')).run()
    const project = { id: projectId, displayName: 'Northstar', canonicalDomain: 'northstar.example' }
    const query = { mode: 'simple', queryClass: 'all', runId: 'simple-second' }

    const optedOut = readVisibilityReport(db, project, query, { includeComparison: false })
    expect(optedOut.selection.run.id).toBe('simple-second')
    expect(optedOut.populations.map(population => Object.hasOwn(population, 'comparison'))).toEqual([false, false, false])
    expect(() => readVisibilityReport(db, project, query)).toThrow('Frozen simple requested model is corrupt')
  })
})
