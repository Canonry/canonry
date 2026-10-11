/**
 * Last-sweep fallback on the location reads.
 *
 * A tracking publish starts a new plan revision, and every location read
 * answers "not measured" until a sweep of it completes. `fallback=last-sweep`
 * reads the last completed sweep instead, under the plan that sweep ran with.
 * These tests hold the two halves of that: without the param nothing moves,
 * and with it the numbers are exactly the ones the sweep earned before the
 * publish, labelled with the plan they came from.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
  measurementPlanV2Schema,
  parseStoredMeasurementPlanAnyVersion,
  type MeasurementOverviewResponse,
  type MeasurementPlanV2,
  type MeasurementPropertyCompetitorsResponse,
  type MeasurementPropertyEvidenceResponse,
  type MeasurementPropertyQuestionsResponse,
  type MeasurementQuestionResultResponse,
  type VisibilityReportResponse,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

// Counts every stored-plan parse a read makes. The function itself is unchanged.
vi.mock('@ainyc/canonry-contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-contracts')>()
  return { ...actual, parseStoredMeasurementPlanAnyVersion: vi.fn(actual.parseStoredMeasurementPlanAnyVersion) }
})

const PROJECT = 'northstar'
const FIRST_PLAN_AT = '2026-10-01T09:00:00.000Z'
const OLDER_SWEEP_AT = '2026-10-05T12:00:00.000Z'
const SWEEP_AT = '2026-10-07T12:00:00.000Z'
const PUBLISH_AT = '2026-10-09T15:00:00.000Z'
const SECOND_PUBLISH_AT = '2026-10-10T08:00:00.000Z'
const NEW_SWEEP_AT = '2026-10-11T12:00:00.000Z'
const FALLBACK = 'fallback=last-sweep'
const ROOT_KEY = 'cnry_last_sweep_root'
const READ_KEY = 'cnry_last_sweep_read'

const HARBOR_PAGE = 'https://northstar.example/locations/harbor/reviews'
const BAYSIDE_PAGE = 'https://northstar.example/locations/bayside/tour'

/**
 * What the one sweep answered. Harbor Homes, asked two queries on two engines:
 * non-brand it is named once and cited by neither; branded it is named once
 * and cited once. The Gemini non-brand answer says "Harborview", which is not
 * one of Harbor's names until a later publish adds it.
 */
const ANSWERS: Record<string, { text: string; citedUrls: string[]; recommended: string[] }> = {
  'exec-nearby:openai': { text: 'Harbor Homes is a strong option near the water.', citedUrls: ['https://listings.example/harbor-area'], recommended: [] },
  'exec-nearby:gemini': { text: 'Harborview and Challenger are worth a look.', citedUrls: [], recommended: ['Challenger'] },
  'exec-brand:openai': { text: 'Harbor Homes by Northstar has strong reviews.', citedUrls: [HARBOR_PAGE, BAYSIDE_PAGE], recommended: [] },
  'exec-brand:gemini': { text: 'Challenger has more reviews online.', citedUrls: [], recommended: ['Challenger'] },
  // Asked only by a sweep of a plan that holds the added query.
  'exec-parking:openai': { text: 'Harbor Homes has covered parking.', citedUrls: [], recommended: [] },
  'exec-parking:gemini': { text: 'Harbor Homes offers garages.', citedUrls: [], recommended: [] },
}

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string

/** Revision 1: two locations in one group and one market, a shared non-brand query and Harbor's branded one. */
function firstPlan(): MeasurementPlanV2 {
  return measurementPlanV2Fixture({
    reportingScopes: [{
      stableKey: 'uptown', label: 'Uptown', kind: 'market', groupKey: 'regional',
      usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' }],
    }],
  })
}

/** A later revision: the first plan with one tracking change, which is never label-only here. */
function changedPlan(change: (plan: MeasurementPlanV2) => void, checksumDigit = 'c'): MeasurementPlanV2 {
  const plan = structuredClone(firstPlan())
  change(plan)
  plan.compiledChecksum = checksumDigit.repeat(64)
  return measurementPlanV2Schema.parse(plan)
}

/** One query added for one location. */
function addParkingQuery(plan: MeasurementPlanV2): void {
  plan.querySnapshots.push({
    queryId: 'q-parking', queryText: 'homes with covered parking',
    provenance: { source: 'manual', sourceId: null, capturedAt: PUBLISH_AT },
  })
  plan.assignments.push({ targetKey: 'harbor', queryId: 'q-parking', queryClass: 'non-brand', executionNodeKey: 'exec-parking' })
  plan.executionNodes.push({
    stableKey: 'exec-parking', queryId: 'q-parking', queryText: 'homes with covered parking',
    context: structuredClone(plan.executionNodes[0]!.context), expectedSnapshots: 2,
  })
  plan.usageEdges.push({ executionNodeKey: 'exec-parking', targetKey: 'harbor', queryId: 'q-parking' })
}

/** A location added, asked the shared non-brand query the last sweep already answered. */
function addLakeside(plan: MeasurementPlanV2): void {
  plan.targets.push({
    stableKey: 'lakeside', label: 'Lakeside Homes', aliases: ['Lakeside Homes'],
    urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/lakeside', pathCase: 'insensitive' }],
    mentionNotApplicable: false, discoveryIdentity: null,
  })
  plan.assignments.push({ targetKey: 'lakeside', queryId: 'q-nearby', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' })
  plan.usageEdges.push({ executionNodeKey: 'exec-nearby', targetKey: 'lakeside', queryId: 'q-nearby' })
}

function seedVersion(
  revision: number,
  plan: MeasurementPlanV2,
  createdAt: string,
  comparableToVersionId: string | null = null,
): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    comparableToVersionId,
    createdAt,
  }).run()
  return id
}

/** A revision in the older plan format, which records no query type and which these reads cannot rebuild. */
function seedSchemaV1Version(revision: number): void {
  const plan = compileMeasurementPlan({
    schemaVersion: 1,
    targets: [{ stableKey: 'harbor', label: 'Harbor Homes', urls: [{ kind: 'host', host: 'northstar.example' }], aliases: ['Harbor Homes'] }],
    groups: [{ stableKey: 'regional', label: 'Regional comparison', targetKeys: ['harbor'], competitors: [] }],
    targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-nearby'] }],
  }, {
    canonicalDomain: 'northstar.example', ownedDomains: [], brandNames: ['Northstar'],
    trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }], locations: [], defaultContext: null, expectedSnapshots: 1,
  })
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1-schema', projectId, revision, canonicalJson: canonicalMeasurementPlanJson(plan),
    checksum: 'e'.repeat(64), schemaVersion: 1, createdAt: FIRST_PLAN_AT,
  }).run()
}

function activate(versionId: string): void {
  db.insert(measurementPlans).values({
    projectId, activeVersionId: versionId, createdAt: FIRST_PLAN_AT, updatedAt: FIRST_PLAN_AT,
  }).onConflictDoUpdate({
    target: measurementPlans.projectId,
    set: { activeVersionId: versionId },
  }).run()
}

/** One run of `plan`, answered as `ANSWERS` says for every slot it holds an answer for. */
function seedRun(versionId: string, plan: MeasurementPlanV2, values: Partial<typeof runs.$inferInsert> = {}): string {
  const id = values.id ?? crypto.randomUUID()
  const createdAt = values.createdAt ?? SWEEP_AT
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: buildMeasurementPlanV2Manifest(plan),
    finishedAt: createdAt,
    createdAt,
    ...values,
  }).run()
  for (const node of plan.executionNodes) {
    for (const provider of node.context.providers) {
      const answer = ANSWERS[`${node.stableKey}:${provider}`]
      if (!answer) continue
      db.insert(querySnapshots).values({
        id: `${id}:${node.stableKey}:${provider}`,
        runId: id,
        queryId: null,
        queryText: node.queryText,
        provider,
        citationState: 'not-cited',
        answerMentioned: null,
        answerText: answer.text,
        citedDomains: [],
        citedUrls: answer.citedUrls,
        captureStatus: 'complete',
        competitorOverlap: [],
        recommendedCompetitors: answer.recommended,
        measurementExecutionId: node.stableKey,
        requestedContext: node.context.location,
        supportedContext: { status: 'applied', resolved: node.context.location },
        location: node.context.location?.label ?? null,
        retrievalStatus: 'used',
        retrievalContract: 'native-auto-v1',
        createdAt,
      }).run()
    }
  }
  return id
}

/** Revision 1 with its one completed sweep, then `next` published on top with no sweep of its own. */
function sweptThenPublished(next: MeasurementPlanV2 | null): { firstVersion: string; sweep: string; activeVersion: string } {
  const plan = firstPlan()
  const firstVersion = seedVersion(1, plan, FIRST_PLAN_AT)
  activate(firstVersion)
  const sweep = seedRun(firstVersion, plan, { id: 'sweep-oct-7' })
  if (next === null) return { firstVersion, sweep, activeVersion: firstVersion }
  const activeVersion = seedVersion(2, next, PUBLISH_AT)
  activate(activeVersion)
  return { firstVersion, sweep, activeVersion }
}

async function get<Body>(route: string, query: string, key = ROOT_KEY): Promise<{ status: number; body: Body; text: string }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/${PROJECT}/${route}?${query}`,
    headers: { authorization: `Bearer ${key}` },
  })
  return { status: response.statusCode, body: response.json() as Body, text: response.body }
}

const overview = (query: string) => get<MeasurementOverviewResponse>('measurement-overview', query)
const evidence = (query: string) => get<MeasurementPropertyEvidenceResponse>('measurement-property-evidence', query)
const competitors = (query: string) => get<MeasurementPropertyCompetitorsResponse>('measurement-property-competitors', query)
const questions = (query: string) => get<MeasurementPropertyQuestionsResponse>('measurement-property-questions', query)
const result = (query: string) => get<MeasurementQuestionResultResponse>('measurement-question-result', query)
const refused = (route: string, query: string) => get<{ error: { code: string; message: string; details?: Record<string, unknown> } }>(route, query)

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-last-sweep-fallback-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: PROJECT,
    displayName: 'Northstar',
    canonicalDomain: 'northstar.example',
    ownedDomains: ['northstar.example'],
    country: 'US',
    language: 'en',
    locations: [],
    providers: [],
    createdAt: FIRST_PLAN_AT,
    updatedAt: FIRST_PLAN_AT,
  }).run()
  db.insert(apiKeys).values([
    { id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9), scopes: ['*'], projectId: null, createdAt: FIRST_PLAN_AT },
    { id: crypto.randomUUID(), name: 'reader', keyHash: hashApiKey(READ_KEY), keyPrefix: READ_KEY.slice(0, 9), scopes: ['read'], projectId, createdAt: FIRST_PLAN_AT },
  ]).run()

  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

/** The four fields a fallback read adds to `measurement`. */
const SWEEP_FIELDS = ['activeRevision', 'measuredRevision', 'awaitingSweep', 'trackingChangedAt'] as const

/**
 * A body with everything a fallback read is allowed to change taken out: the
 * four fields, the next step, the active chain's current run, and
 * `planRevision`, which always names the active revision.
 */
function sweepBody(body: unknown): unknown {
  const { nextAction: _nextAction, measurement, ...rest } = body as { nextAction?: unknown; measurement: Record<string, unknown> }
  const kept = Object.fromEntries(Object.entries(measurement)
    .filter(([key]) => ![...SWEEP_FIELDS, 'currentRunId', 'planRevision'].includes(key)))
  return { ...rest, measurement: kept }
}

const AWAITING = { activeRevision: 2, measuredRevision: 1, awaitingSweep: true, trackingChangedAt: PUBLISH_AT }

/** Every read the location page makes, for Harbor Homes, plus the list reads of the overview. */
const READS: ReadonlyArray<readonly [name: string, route: string, query: string]> = [
  ['location, non-brand', 'measurement-overview', 'scope=property&targetKey=harbor'],
  ['location, branded', 'measurement-overview', 'scope=property&targetKey=harbor&queryClass=branded'],
  ['all locations', 'measurement-overview', 'scope=all'],
  ['one group', 'measurement-overview', 'scope=group&groupKey=regional'],
  ['one market', 'measurement-overview', 'scope=market&marketKey=uptown'],
  ['sources', 'measurement-property-evidence', 'targetKey=harbor'],
  ['answers', 'measurement-property-evidence', 'targetKey=harbor&shape=answers&queryClass=non-brand'],
  ['cited on other queries', 'measurement-property-evidence', 'targetKey=bayside&shape=other-queries'],
  ['named instead', 'measurement-property-competitors', 'targetKey=harbor&queryClass=non-brand'],
  ['location queries', 'measurement-property-questions', 'targetKey=harbor'],
  ['one answer', 'measurement-question-result', 'targetKey=harbor&resultId=sweep-oct-7:exec-nearby:openai'],
]

/** One request per location read, in the order the location page makes them. */
const LOCATION_READS = (targetKey: string): ReadonlyArray<readonly [route: string, query: string]> => [
  ['measurement-overview', `scope=property&targetKey=${targetKey}`],
  ['measurement-property-evidence', `targetKey=${targetKey}&shape=answers`],
  ['measurement-property-competitors', `targetKey=${targetKey}`],
  ['measurement-property-questions', `targetKey=${targetKey}`],
]

const available = (numerator: number, denominator: number) => ({ state: 'available', value: numerator / denominator, numerator, denominator })
/** A count metric reads out as its numerator: one of the two locations was named. */
const ONE_OF_TWO_LOCATIONS = { state: 'available', value: 1, numerator: 1, denominator: 2 }
const NO_POPULATION = { state: 'unavailable', reason: 'no_population' }
const NO_COMPLETED_RUN = { state: 'unavailable', reason: 'no_completed_run' }

describe('last-sweep fallback on the location reads', () => {
  it('changes nothing without the param: a tracking publish still blanks every read', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))

    const location = await overview('scope=property&targetKey=harbor')
    expect(location.status).toBe(200)
    expect(location.body).toStrictEqual({
      mode: 'active-v2',
      scope: { kind: 'property', key: 'harbor', label: 'Harbor Homes' },
      queryClass: 'non-brand',
      // Six answers per sweep now: the added query asks two more.
      measurement: { state: 'not_measured', completed: 0, expected: 6, includesHistoricalData: false },
      nextAction: { kind: 'run_measurement' },
      metrics: {
        propertiesMentioned: NO_COMPLETED_RUN, mentionCoverage: NO_COMPLETED_RUN, citationCoverage: NO_COMPLETED_RUN,
        brandPresence: NO_COMPLETED_RUN, sov: NO_COMPLETED_RUN,
      },
      properties: {
        items: [{
          targetKey: 'harbor', label: 'Harbor Homes', metro: { groupKey: 'regional', label: 'Regional comparison' },
          mentionCoverage: NO_COMPLETED_RUN, citationCoverage: NO_COMPLETED_RUN, providers: [], flags: 0,
        }],
        nextCursor: null,
        totalEstimate: 1,
      },
      outcomes: { bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 1, total: 1 },
      flags: { total: 0 },
    })

    const empty = { items: [], nextCursor: null, totalEstimate: 0 }
    const property = { targetKey: 'harbor', label: 'Harbor Homes' }
    expect((await evidence('targetKey=harbor')).body)
      .toStrictEqual({ property, queryClass: 'all', measurement: { state: 'not_measured' }, evidence: empty })
    expect((await evidence('targetKey=harbor&shape=answers')).body)
      .toStrictEqual({ property, queryClass: 'all', measurement: { state: 'not_measured' }, answers: empty })
    expect((await evidence('targetKey=harbor&shape=other-queries')).body)
      .toStrictEqual({ property, queryClass: 'all', measurement: { state: 'not_measured' }, otherQueries: empty })

    const unmeasured = { state: 'not_measured', displayedRunId: null, planRevision: 2, completedAt: null }
    expect((await competitors('targetKey=harbor')).body).toStrictEqual({
      property, measurement: unmeasured, queryClass: 'all',
      basis: { state: 'unavailable', reason: 'no_completed_run' }, competitors: [], total: 0, truncated: false,
    })
    expect((await questions('targetKey=harbor')).body).toStrictEqual({
      property, measurement: unmeasured, queryClass: 'all', questions: [], total: 0, truncated: false,
    })

    // A result of the old sweep cannot be opened, and naming the old sweep is refused.
    const opened = await refused('measurement-question-result', 'targetKey=harbor&resultId=sweep-oct-7:exec-nearby:openai')
    expect(opened.status).toBe(422)
    expect(opened.body.error.code).toBe('MEASUREMENT_RUN_REVISION_MISMATCH')
    const named = await refused('measurement-overview', 'scope=all&runId=sweep-oct-7')
    expect(named.status).toBe(422)
    expect(named.body.error.details).toStrictEqual({ runId: 'sweep-oct-7', runRevision: 1, activeRevision: 2 })
  })

  it('never sends the four fields unless the request carries the param', async () => {
    sweptThenPublished(null)
    for (const [name, route, query] of READS) {
      const response = await get<unknown>(route, query)
      expect(response.status, name).toBe(200)
      for (const field of SWEEP_FIELDS) expect(response.text, `${name}: ${field}`).not.toContain(field)
    }
  })

  it('reads a sweep of the active plan exactly as today, and says it is current', async () => {
    sweptThenPublished(null)
    for (const [name, route, query] of READS) {
      const plain = await get<{ measurement: Record<string, unknown> }>(route, query)
      const asked = await get<{ measurement: Record<string, unknown> }>(route, `${query}&${FALLBACK}`)
      expect(asked.status, name).toBe(200)
      // The body is today's with the four fields added, and nothing else moved.
      expect(asked.body, name).toStrictEqual({
        ...plain.body,
        measurement: {
          ...plain.body.measurement,
          activeRevision: 1, measuredRevision: 1, awaitingSweep: false, trackingChangedAt: FIRST_PLAN_AT,
        },
      })
    }
  })

  it('after a query is added, every read returns the last sweep as it read before the publish', async () => {
    const plan = firstPlan()
    const firstVersion = seedVersion(1, plan, FIRST_PLAN_AT)
    activate(firstVersion)
    seedRun(firstVersion, plan, { id: 'sweep-oct-7' })
    const before = new Map<string, unknown>()
    for (const [name, route, query] of READS) before.set(name, (await get<unknown>(route, query)).body)

    activate(seedVersion(2, changedPlan(addParkingQuery), PUBLISH_AT))

    for (const [name, route, query] of READS) {
      const after = await get<{ measurement: Record<string, unknown>; nextAction?: { kind: string } }>(route, `${query}&${FALLBACK}`)
      expect(after.status, name).toBe(200)
      expect(sweepBody(after.body), name).toStrictEqual(sweepBody(before.get(name)))
      expect(after.body.measurement, name).toMatchObject({
        ...AWAITING, state: 'complete', displayedRunId: 'sweep-oct-7', completedAt: SWEEP_AT,
      })
      // No sweep of the active plan exists, so none is current.
      expect(after.body.measurement, name).not.toHaveProperty('currentRunId')
      if (route === 'measurement-overview') expect(after.body.nextAction, name).toStrictEqual({ kind: 'run_measurement' })
      // `planRevision` keeps naming the active revision on the reads that carry it.
      if ('planRevision' in after.body.measurement) expect(after.body.measurement.planRevision, name).toBe(2)
    }

    // The numbers themselves: Harbor Homes non-brand was named in 1 of 2 answers and cited in 0 of 2.
    const nonBrand = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(nonBrand.metrics.mentionCoverage).toStrictEqual(available(1, 2))
    expect(nonBrand.metrics.citationCoverage).toStrictEqual(available(0, 2))
    expect(nonBrand.properties.items[0]!.providers).toStrictEqual([
      { provider: 'gemini', mentionCoverage: available(0, 1), citationCoverage: available(0, 1) },
      { provider: 'openai', mentionCoverage: available(1, 1), citationCoverage: available(0, 1) },
    ])
    // The sweep promised four answers. The active plan asks six.
    expect(nonBrand.measurement).toMatchObject({ completed: 4, expected: 4 })
    // Branded stays its own read: named in 1 of 2 and cited in 1 of 2.
    const branded = (await overview(`scope=property&targetKey=harbor&queryClass=branded&${FALLBACK}`)).body
    expect(branded.metrics.mentionCoverage).toStrictEqual(available(1, 2))
    expect(branded.metrics.citationCoverage).toStrictEqual(available(1, 2))

    const answers = (await evidence(`targetKey=harbor&shape=answers&queryClass=non-brand&${FALLBACK}`)).body.answers!
    expect(answers.items.map(answer => [answer.provider, answer.queryText, answer.mentioned, answer.cited])).toStrictEqual([
      ['gemini', 'homes near harbor', false, false],
      ['openai', 'homes near harbor', true, false],
    ])
    const namedInstead = (await competitors(`targetKey=harbor&queryClass=non-brand&${FALLBACK}`)).body
    expect(namedInstead.basis).toStrictEqual({ state: 'available', answeredResults: 2, targetMissResults: 1, recommendationOccurrences: 1 })
    expect(namedInstead.competitors.map(row => [row.name, row.occurrences])).toStrictEqual([['Challenger', 1]])
    const listed = (await questions(`targetKey=harbor&${FALLBACK}`)).body
    // The added query was never asked, so it is not listed as a missing answer.
    expect(listed.questions.map(row => row.queryId)).toStrictEqual(['q-brand', 'q-brand', 'q-nearby', 'q-nearby'])
    // Every listed row opens.
    for (const row of listed.questions) {
      const opened = await result(`targetKey=harbor&resultId=${row.resultId}&${FALLBACK}`)
      expect(opened.status, row.resultId ?? '').toBe(200)
      expect(opened.body.measurement).toMatchObject({ ...AWAITING, planRevision: 2, displayedRunId: 'sweep-oct-7' })
    }
  })

  it('says complete_setup while a setup draft is open', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    expect((await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body.nextAction).toStrictEqual({ kind: 'run_measurement' })

    db.insert(measurementPlanDrafts).values({
      id: crypto.randomUUID(), projectId, authoringJson: '{}', createdBy: 'test', updatedBy: 'test',
      createdAt: PUBLISH_AT, updatedAt: PUBLISH_AT,
    }).run()
    const drafting = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(drafting.nextAction).toStrictEqual({ kind: 'complete_setup' })
    expect(drafting.metrics.mentionCoverage).toStrictEqual(available(1, 2))
  })

  it('keeps counting and listing the answers of a query removed since', async () => {
    sweptThenPublished(changedPlan(plan => {
      plan.querySnapshots = plan.querySnapshots.filter(query => query.queryId !== 'q-brand')
      plan.assignments = plan.assignments.filter(assignment => assignment.queryId !== 'q-brand')
      plan.executionNodes = plan.executionNodes.filter(node => node.queryId !== 'q-brand')
      plan.usageEdges = plan.usageEdges.filter(edge => edge.queryId !== 'q-brand')
    }))

    // The active plan asks Harbor Homes no branded query any more.
    const branded = (await overview(`scope=property&targetKey=harbor&queryClass=branded&${FALLBACK}`)).body
    expect(branded.measurement).toMatchObject(AWAITING)
    expect(branded.metrics.mentionCoverage).toStrictEqual(available(1, 2))
    expect(branded.metrics.citationCoverage).toStrictEqual(available(1, 2))

    const answers = (await evidence(`targetKey=harbor&shape=answers&queryClass=branded&${FALLBACK}`)).body.answers!
    expect(answers.totalEstimate).toBe(2)
    expect(answers.items.map(answer => [answer.provider, answer.queryText, answer.mentioned, answer.cited])).toStrictEqual([
      ['gemini', 'northstar reviews', false, false],
      ['openai', 'northstar reviews', true, true],
    ])
    expect((await questions(`targetKey=harbor&queryClass=branded&${FALLBACK}`)).body.total).toBe(2)
  })

  it('matches old answers with the names the sweep ran with, not a name added since', async () => {
    // "Harborview" is in one old answer. Read under the new plan it would count as a mention.
    sweptThenPublished(changedPlan(plan => { plan.targets[0]!.aliases.push('Harborview') }))

    const nonBrand = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(nonBrand.measurement).toMatchObject(AWAITING)
    expect(nonBrand.metrics.mentionCoverage).toStrictEqual(available(1, 2))
    const answers = (await evidence(`targetKey=harbor&shape=answers&queryClass=non-brand&${FALLBACK}`)).body.answers!
    expect(answers.items.map(answer => [answer.provider, answer.mentioned])).toStrictEqual([['gemini', false], ['openai', true]])
    // The answer that says Harborview still counts as naming someone else.
    expect((await competitors(`targetKey=harbor&queryClass=non-brand&${FALLBACK}`)).body.basis)
      .toStrictEqual({ state: 'available', answeredResults: 2, targetMissResults: 1, recommendationOccurrences: 1 })
  })

  it('keeps each type\'s numbers when a query changes type', async () => {
    // Harbor's shared query becomes Branded. Under the new plan its non-brand side is empty.
    sweptThenPublished(changedPlan(plan => {
      plan.assignments.find(assignment => assignment.targetKey === 'harbor' && assignment.queryId === 'q-nearby')!.queryClass = 'branded'
    }))

    const nonBrand = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(nonBrand.queryClass).toBe('non-brand')
    expect(nonBrand.metrics.mentionCoverage).toStrictEqual(available(1, 2))
    expect(nonBrand.metrics.citationCoverage).toStrictEqual(available(0, 2))
    const branded = (await overview(`scope=property&targetKey=harbor&queryClass=branded&${FALLBACK}`)).body
    expect(branded.queryClass).toBe('branded')
    // Two branded answers, as asked then. Pooling the re-typed query in would make four.
    expect(branded.metrics.mentionCoverage).toStrictEqual(available(1, 2))
    expect(branded.metrics.citationCoverage).toStrictEqual(available(1, 2))
    expect((await questions(`targetKey=harbor&${FALLBACK}`)).body.questions.map(row => [row.queryId, row.class])).toStrictEqual([
      ['q-brand', 'branded'], ['q-brand', 'branded'], ['q-nearby', 'non-brand'], ['q-nearby', 'non-brand'],
    ])
  })

  it('answers no_population for a type added to a location since, and keeps the other type', async () => {
    // Bayside Homes gains a branded query. It was asked only the non-brand one.
    sweptThenPublished(changedPlan(plan => {
      plan.assignments.push({ targetKey: 'bayside', queryId: 'q-brand', queryClass: 'branded', executionNodeKey: 'exec-brand' })
      plan.usageEdges.push({ executionNodeKey: 'exec-brand', targetKey: 'bayside', queryId: 'q-brand' })
    }))

    const branded = (await overview(`scope=property&targetKey=bayside&queryClass=branded&${FALLBACK}`)).body
    expect(branded.measurement).toMatchObject({ ...AWAITING, state: 'complete', displayedRunId: 'sweep-oct-7' })
    expect(branded.metrics.mentionCoverage).toStrictEqual(NO_POPULATION)
    expect(branded.metrics.citationCoverage).toStrictEqual(NO_POPULATION)
    const nonBrand = (await overview(`scope=property&targetKey=bayside&${FALLBACK}`)).body
    expect(nonBrand.metrics.mentionCoverage).toStrictEqual(available(0, 2))
    expect(nonBrand.metrics.citationCoverage).toStrictEqual(available(0, 2))
  })

  it('answers 200 with no numbers for a location added since, on the last sweep\'s run and date', async () => {
    sweptThenPublished(changedPlan(addLakeside))
    const sweep = { ...AWAITING, state: 'complete', displayedRunId: 'sweep-oct-7', completedAt: SWEEP_AT }
    const property = { targetKey: 'lakeside', label: 'Lakeside Homes' }

    const location = await overview(`scope=property&targetKey=lakeside&${FALLBACK}`)
    expect(location.status).toBe(200)
    expect(location.body).toStrictEqual({
      mode: 'active-v2',
      scope: { kind: 'property', key: 'lakeside', label: 'Lakeside Homes' },
      queryClass: 'non-brand',
      measurement: { ...sweep, completed: 4, expected: 4, includesHistoricalData: false },
      nextAction: { kind: 'run_measurement' },
      metrics: {
        propertiesMentioned: NO_POPULATION, mentionCoverage: NO_POPULATION, citationCoverage: NO_POPULATION,
        brandPresence: NO_POPULATION, sov: NO_POPULATION,
      },
      properties: {
        items: [{ targetKey: 'lakeside', label: 'Lakeside Homes', metro: null, mentionCoverage: NO_POPULATION, citationCoverage: NO_POPULATION, providers: [], flags: 0 }],
        nextCursor: null,
        totalEstimate: 1,
      },
      outcomes: { bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 1, total: 1 },
      flags: { total: 0 },
    })

    const empty = { items: [], nextCursor: null, totalEstimate: 0 }
    expect((await evidence(`targetKey=lakeside&${FALLBACK}`)).body).toStrictEqual({ property, queryClass: 'all', measurement: sweep, evidence: empty })
    expect((await evidence(`targetKey=lakeside&shape=answers&${FALLBACK}`)).body).toStrictEqual({ property, queryClass: 'all', measurement: sweep, answers: empty })
    expect((await evidence(`targetKey=lakeside&shape=other-queries&${FALLBACK}`)).body).toStrictEqual({ property, queryClass: 'all', measurement: sweep, otherQueries: empty })
    expect((await competitors(`targetKey=lakeside&${FALLBACK}`)).body).toStrictEqual({
      property, measurement: { ...sweep, planRevision: 2 }, queryClass: 'all',
      // Never "nobody was named": the last sweep did not ask this location anything.
      basis: { state: 'unavailable', reason: 'no_population' }, competitors: [], total: 0, truncated: false,
    })
    expect((await questions(`targetKey=lakeside&${FALLBACK}`)).body).toStrictEqual({
      property, measurement: { ...sweep, planRevision: 2 }, queryClass: 'all', questions: [], total: 0, truncated: false,
    })

    // The shared query was answered in that sweep, but not for this location.
    expect((await refused('measurement-question-result', `targetKey=lakeside&resultId=sweep-oct-7:exec-nearby:openai&${FALLBACK}`)).status).toBe(404)
    expect((await refused('measurement-question-result', `targetKey=lakeside&resultId=no-such-result&${FALLBACK}`)).status).toBe(404)
    expect((await refused('measurement-question-result', `targetKey=harbor&resultId=no-such-result&${FALLBACK}`)).status).toBe(404)

    // A list of the last sweep holds the locations it measured, so the new one is not in it.
    const all = (await overview(`scope=all&${FALLBACK}`)).body
    expect(all.properties.items.map(row => row.targetKey)).toStrictEqual(['bayside', 'harbor'])
    expect(all.metrics.propertiesMentioned).toStrictEqual(ONE_OF_TWO_LOCATIONS)
  })

  it('still lists a location removed since in the last sweep\'s lists, and refuses its own page as today', async () => {
    sweptThenPublished(changedPlan(plan => {
      plan.targets = plan.targets.filter(target => target.stableKey !== 'bayside')
      plan.groups[0]!.targetKeys = ['harbor']
      plan.assignments = plan.assignments.filter(assignment => assignment.targetKey !== 'bayside')
      plan.usageEdges = plan.usageEdges.filter(edge => edge.targetKey !== 'bayside')
    }))

    for (const query of ['scope=all', 'scope=group&groupKey=regional']) {
      const list = (await overview(`${query}&${FALLBACK}`)).body
      expect(list.properties.items.map(row => row.targetKey), query).toStrictEqual(['bayside', 'harbor'])
      expect(list.metrics.propertiesMentioned, query).toStrictEqual(ONE_OF_TWO_LOCATIONS)
    }
    // Its answer still opens: the row above is one a fallback read listed.
    const opened = await result(`targetKey=bayside&resultId=sweep-oct-7:exec-nearby:openai&${FALLBACK}`)
    expect(opened.status).toBe(200)
    expect(opened.body.property).toStrictEqual({ targetKey: 'bayside', label: 'Bayside Homes' })
    expect(opened.body.mentioned).toBe(false)

    const message = 'Measurement Property "bayside" is not in the active revision.'
    for (const [route, query] of LOCATION_READS('bayside')) {
      for (const suffix of ['', `&${FALLBACK}`]) {
        const response = await refused(route, `${query}${suffix}`)
        expect(response.status, `${route}${suffix}`).toBe(400)
        expect(response.body.error.message, `${route}${suffix}`).toBe(message)
      }
    }
  })

  it('lists a group added since with no numbers, and pages through it', async () => {
    sweptThenPublished(changedPlan(plan => {
      plan.groups.push({ stableKey: 'coastal', label: 'Coastal', targetKeys: ['harbor', 'bayside'], competitors: [] })
    }))

    const first = (await overview(`scope=group&groupKey=coastal&limit=1&${FALLBACK}`)).body
    expect(first.scope).toStrictEqual({ kind: 'group', key: 'coastal', label: 'Coastal' })
    expect(first.measurement).toMatchObject({ ...AWAITING, state: 'complete', displayedRunId: 'sweep-oct-7' })
    expect(first.metrics.mentionCoverage).toStrictEqual(NO_POPULATION)
    expect(first.outcomes).toStrictEqual({ bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 2, total: 2 })
    expect(first.properties.items.map(row => [row.targetKey, row.mentionCoverage])).toStrictEqual([['bayside', NO_POPULATION]])
    const second = await overview(`scope=group&groupKey=coastal&limit=1&${FALLBACK}&cursor=${first.properties.nextCursor}`)
    expect(second.status).toBe(200)
    expect(second.body.properties.items.map(row => [row.targetKey, row.mentionCoverage])).toStrictEqual([['harbor', NO_POPULATION]])
    expect(second.body.properties.nextCursor).toBeNull()
  })

  it('refuses a location in neither plan, with and without the param', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    const message = 'Measurement Property "nowhere" is not in the active revision.'
    for (const [route, query] of [...LOCATION_READS('nowhere'), ['measurement-question-result', 'targetKey=nowhere&resultId=sweep-oct-7:exec-nearby:openai'] as const]) {
      for (const suffix of ['', `&${FALLBACK}`]) {
        const response = await refused(route, `${query}${suffix}`)
        expect(response.status, `${route}${suffix}`).toBe(400)
        expect(response.body.error.message, `${route}${suffix}`).toBe(message)
      }
    }
  })

  it('says not measured, with no run and no revision, before any sweep', async () => {
    activate(seedVersion(1, firstPlan(), FIRST_PLAN_AT))
    const never = { activeRevision: 1, measuredRevision: null, awaitingSweep: true, trackingChangedAt: FIRST_PLAN_AT }

    const location = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(location.measurement).toStrictEqual({ state: 'not_measured', completed: 0, expected: 4, includesHistoricalData: false, ...never })
    expect(location.metrics.mentionCoverage).toStrictEqual(NO_COMPLETED_RUN)
    expect(location.nextAction).toStrictEqual({ kind: 'run_measurement' })
    expect((await evidence(`targetKey=harbor&shape=answers&${FALLBACK}`)).body.measurement).toStrictEqual({ state: 'not_measured', ...never })
    const named = (await competitors(`targetKey=harbor&${FALLBACK}`)).body
    expect(named.measurement).toStrictEqual({ state: 'not_measured', displayedRunId: null, planRevision: 1, completedAt: null, ...never })
    expect(named.basis).toStrictEqual({ state: 'unavailable', reason: 'no_completed_run' })
    expect((await questions(`targetKey=harbor&${FALLBACK}`)).body).toMatchObject({ questions: [], total: 0, measurement: { displayedRunId: null, ...never } })
  })

  it.each(['queued', 'running', 'partial', 'failed'] as const)('keeps the last sweep while a %s sweep of the new plan exists', async status => {
    const next = changedPlan(addParkingQuery)
    const { activeVersion } = sweptThenPublished(next)
    seedRun(activeVersion, next, { id: 'sweep-oct-11', status, createdAt: NEW_SWEEP_AT, finishedAt: status === 'queued' || status === 'running' ? null : NEW_SWEEP_AT })

    const location = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(location.measurement).toMatchObject({ ...AWAITING, state: 'complete', currentRunId: 'sweep-oct-11', displayedRunId: 'sweep-oct-7', completedAt: SWEEP_AT })
    expect(location.metrics.mentionCoverage).toStrictEqual(available(1, 2))
    for (const [route, query] of LOCATION_READS('harbor').slice(1)) {
      expect((await get<{ measurement: Record<string, unknown> }>(route, `${query}&${FALLBACK}`)).body.measurement, route)
        .toMatchObject({ ...AWAITING, displayedRunId: 'sweep-oct-7' })
    }
  })

  it('reads the new sweep once it completes, and stops saying awaiting', async () => {
    const next = changedPlan(addParkingQuery)
    const { activeVersion } = sweptThenPublished(next)
    seedRun(activeVersion, next, { id: 'sweep-oct-11', createdAt: NEW_SWEEP_AT })
    const current = { activeRevision: 2, measuredRevision: 2, awaitingSweep: false, trackingChangedAt: PUBLISH_AT }

    const location = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(location.measurement).toMatchObject({ ...current, state: 'complete', currentRunId: 'sweep-oct-11', displayedRunId: 'sweep-oct-11', completedAt: NEW_SWEEP_AT })
    // Four non-brand answers now: the old query's two and the added query's two, three naming Harbor Homes.
    expect(location.metrics.mentionCoverage).toStrictEqual(available(3, 4))
    for (const [route, query] of LOCATION_READS('harbor').slice(1)) {
      expect((await get<{ measurement: Record<string, unknown> }>(route, `${query}&${FALLBACK}`)).body.measurement, route)
        .toMatchObject({ ...current, displayedRunId: 'sweep-oct-11' })
    }
    // The old sweep is another plan's again: naming it is refused, param or not.
    for (const suffix of ['', `&${FALLBACK}`]) {
      const named = await refused('measurement-overview', `scope=all&runId=sweep-oct-7${suffix}`)
      expect(named.status, suffix).toBe(422)
      expect(named.body.error.details, suffix).toStrictEqual({ runId: 'sweep-oct-7', runRevision: 1, activeRevision: 2 })
    }
  })

  it('reads a label-only republish as today, never as awaiting', async () => {
    const { firstVersion } = sweptThenPublished(null)
    const renamed = firstPlan()
    renamed.groups[0]!.label = 'Regional comparison (renamed)'
    activate(seedVersion(2, renamed, PUBLISH_AT, firstVersion))

    for (const [name, route, query] of READS) {
      const plain = await get<{ measurement: Record<string, unknown> }>(route, query)
      const asked = await get<{ measurement: Record<string, unknown> }>(route, `${query}&${FALLBACK}`)
      expect(plain.body.measurement.displayedRunId, name).toBe('sweep-oct-7')
      expect(asked.body, name).toStrictEqual({
        ...plain.body,
        measurement: { ...plain.body.measurement, activeRevision: 2, measuredRevision: 2, awaitingSweep: false, trackingChangedAt: PUBLISH_AT },
      })
    }
    // The active plan's label, as today: a comparable sweep is read under the active plan.
    expect((await overview(`scope=group&groupKey=regional&${FALLBACK}`)).body.scope.label).toBe('Regional comparison (renamed)')
  })

  it('names the newer publish after two publishes, and still the one sweep', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    activate(seedVersion(3, changedPlan(plan => { addParkingQuery(plan); addLakeside(plan) }, 'd'), SECOND_PUBLISH_AT))

    const location = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(location.measurement).toMatchObject({
      activeRevision: 3, measuredRevision: 1, awaitingSweep: true, trackingChangedAt: SECOND_PUBLISH_AT,
      displayedRunId: 'sweep-oct-7', completedAt: SWEEP_AT,
    })
    expect(location.metrics.mentionCoverage).toStrictEqual(available(1, 2))
  })

  it('accepts the last sweep by id and refuses any other old run', async () => {
    const plan = firstPlan()
    const firstVersion = seedVersion(1, plan, FIRST_PLAN_AT)
    activate(firstVersion)
    seedRun(firstVersion, plan, { id: 'sweep-oct-5', createdAt: OLDER_SWEEP_AT })
    seedRun(firstVersion, plan, { id: 'sweep-oct-7' })
    activate(seedVersion(2, changedPlan(addParkingQuery), PUBLISH_AT))

    for (const [route, query] of LOCATION_READS('harbor')) {
      const last = await get<{ measurement: Record<string, unknown> }>(route, `${query}&runId=sweep-oct-7&${FALLBACK}`)
      expect(last.status, route).toBe(200)
      expect(last.body.measurement, route).toMatchObject({ ...AWAITING, displayedRunId: 'sweep-oct-7' })

      const older = await refused(route, `${query}&runId=sweep-oct-5&${FALLBACK}`)
      expect(older.status, route).toBe(422)
      expect(older.body.error.code, route).toBe('MEASUREMENT_RUN_REVISION_MISMATCH')
      // The true active revision, not the one the last sweep ran with.
      expect(older.body.error.details, route).toStrictEqual({ runId: 'sweep-oct-5', runRevision: 1, activeRevision: 2 })
      expect((await refused(route, `${query}&runId=no-such-run&${FALLBACK}`)).status, route).toBe(404)
    }
    const olderResult = await refused('measurement-question-result', `targetKey=harbor&resultId=sweep-oct-5:exec-nearby:openai&${FALLBACK}`)
    expect(olderResult.status).toBe(422)
    expect(olderResult.body.error.details).toStrictEqual({ runId: 'sweep-oct-5', runRevision: 1, activeRevision: 2 })
  })

  it('refuses the param with a date window', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    for (const window of ['from=2026-10-01', 'to=2026-10-08', 'from=2026-10-01&to=2026-10-08']) {
      const response = await refused('measurement-overview', `scope=all&${window}&${FALLBACK}`)
      expect(response.status, window).toBe(400)
      expect(response.body.error.message, window).toBe('"fallback" cannot be combined with "from" or "to".')
    }
    const unknown = await refused('measurement-overview', 'scope=all&fallback=newest')
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.message).toBe('Invalid measurement overview query')
  })

  it('pages the overview under the fallback, and binds a cursor to the param', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))

    const first = (await overview(`scope=all&limit=1&${FALLBACK}`)).body
    expect(first.properties.items.map(row => row.targetKey)).toStrictEqual(['bayside'])
    expect(first.properties.totalEstimate).toBe(2)
    const fallbackCursor = first.properties.nextCursor!
    const second = await overview(`scope=all&limit=1&${FALLBACK}&cursor=${fallbackCursor}`)
    expect(second.status).toBe(200)
    expect(second.body.properties.items.map(row => [row.targetKey, row.mentionCoverage])).toStrictEqual([['harbor', available(1, 2)]])
    expect(second.body.properties.nextCursor).toBeNull()
    expect(second.body.measurement).toMatchObject({ ...AWAITING, displayedRunId: 'sweep-oct-7' })

    const plainCursor = (await overview('scope=all&limit=1')).body.properties.nextCursor!
    const mismatch = 'The measurement overview cursor filters do not match the request.'
    const crossed = await refused('measurement-overview', `scope=all&limit=1&${FALLBACK}&cursor=${plainCursor}`)
    expect([crossed.status, crossed.body.error.message]).toStrictEqual([400, mismatch])
    const reversed = await refused('measurement-overview', `scope=all&limit=1&cursor=${fallbackCursor}`)
    expect([reversed.status, reversed.body.error.message]).toStrictEqual([400, mismatch])

    // A cursor issued without the param is bound to the filter list this route
    // has always hashed, so one issued before the param existed still reads.
    const filters = {
      scope: 'all', groupKey: null, marketKey: null, targetKey: null, queryClass: 'non-brand',
      provider: null, location: null, from: null, to: null, search: null, compact: false,
    }
    const decoded = JSON.parse(Buffer.from(plainCursor, 'base64url').toString('utf8')) as { filterFingerprint: string }
    expect(decoded.filterFingerprint).toBe(createHash('sha256').update(JSON.stringify(filters)).digest('base64url'))
    const plainSecond = await overview(`scope=all&limit=1&cursor=${plainCursor}`)
    expect(plainSecond.status).toBe(200)
    expect(plainSecond.body.properties.items.map(row => [row.targetKey, row.mentionCoverage])).toStrictEqual([['harbor', NO_COMPLETED_RUN]])
  })

  it('pages evidence under the fallback, and binds a cursor to the param', async () => {
    const plan = firstPlan()
    const firstVersion = seedVersion(1, plan, FIRST_PLAN_AT)
    activate(firstVersion)
    seedRun(firstVersion, plan, { id: 'sweep-oct-7' })
    const plainCursor = (await evidence('targetKey=harbor&shape=answers&limit=3')).body.answers!.nextCursor!
    const filters = { targetKey: 'harbor', queryClass: 'all', provider: null, location: null }
    const decoded = JSON.parse(Buffer.from(plainCursor, 'base64url').toString('utf8')) as { filterFingerprint: string }
    expect(decoded.filterFingerprint).toBe(createHash('sha256').update(JSON.stringify(filters)).digest('base64url'))

    activate(seedVersion(2, changedPlan(addParkingQuery), PUBLISH_AT))

    const first = (await evidence(`targetKey=harbor&shape=answers&limit=3&${FALLBACK}`)).body
    expect(first.answers!.items).toHaveLength(3)
    expect(first.answers!.totalEstimate).toBe(4)
    const fallbackCursor = first.answers!.nextCursor!
    const second = await evidence(`targetKey=harbor&shape=answers&limit=3&${FALLBACK}&cursor=${fallbackCursor}`)
    expect(second.status).toBe(200)
    expect(second.body.answers!.items.map(answer => [answer.provider, answer.queryText])).toStrictEqual([['openai', 'homes near harbor']])
    expect(second.body.answers!.nextCursor).toBeNull()
    expect(second.body.measurement).toMatchObject({ ...AWAITING, displayedRunId: 'sweep-oct-7' })

    const crossed = await refused('measurement-property-evidence', `targetKey=harbor&shape=answers&limit=3&${FALLBACK}&cursor=${plainCursor}`)
    expect([crossed.status, crossed.body.error.message])
      .toStrictEqual([400, 'The measurement property evidence cursor filters do not match the request.'])
    // Without the param the cursor's run belongs to another plan, as any old run does.
    const reversed = await refused('measurement-property-evidence', `targetKey=harbor&shape=answers&limit=3&cursor=${fallbackCursor}`)
    expect([reversed.status, reversed.body.error.code]).toStrictEqual([422, 'MEASUREMENT_RUN_REVISION_MISMATCH'])
  })

  it('never falls back to a probe, a spot check, a partial sweep or a sweep of a schema v1 plan', async () => {
    const { firstVersion } = sweptThenPublished(changedPlan(addParkingQuery))
    const plan = firstPlan()
    // Each is newer than the real sweep, so a missing filter would pick it.
    seedRun(firstVersion, plan, { id: 'probe', trigger: 'probe', createdAt: '2026-10-08T01:00:00.000Z' })
    seedRun(firstVersion, plan, {
      id: 'spot-check', createdAt: '2026-10-08T02:00:00.000Z',
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
    })
    seedRun(firstVersion, plan, { id: 'partial', status: 'partial', createdAt: '2026-10-08T03:00:00.000Z' })
    seedSchemaV1Version(7)
    db.insert(runs).values({
      id: 'schema-v1-sweep', projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      measurementPlanVersionId: 'plan-v1-schema', finishedAt: '2026-10-08T04:00:00.000Z', createdAt: '2026-10-08T04:00:00.000Z',
    }).run()

    for (const [route, query] of LOCATION_READS('harbor')) {
      const response = await get<{ measurement: Record<string, unknown> }>(route, `${query}&${FALLBACK}`)
      expect(response.status, route).toBe(200)
      expect(response.body.measurement, route).toMatchObject({ ...AWAITING, displayedRunId: 'sweep-oct-7', completedAt: SWEEP_AT })
    }

    // With the real sweep gone, none of the four is a sweep to fall back to.
    db.delete(querySnapshots).where(eq(querySnapshots.runId, 'sweep-oct-7')).run()
    db.delete(runs).where(eq(runs.id, 'sweep-oct-7')).run()
    const location = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(location.measurement).toMatchObject({ state: 'not_measured', activeRevision: 2, measuredRevision: null, awaitingSweep: true })
    expect(location.measurement).not.toHaveProperty('displayedRunId')
    expect(location.metrics.mentionCoverage).toStrictEqual(NO_COMPLETED_RUN)
  })

  it('shows the sweep AI Visibility shows after a publish', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    const report = (await get<VisibilityReportResponse>('visibility-report', 'queryClass=non-brand')).body
    const location = (await overview(`scope=property&targetKey=harbor&${FALLBACK}`)).body
    expect(location.measurement.displayedRunId).toBe(report.selection.run?.id)
    expect(report.selection.run?.id).toBe('sweep-oct-7')
    expect(report.selection.measurement).toMatchObject({ activeRevision: 2, measuredRevision: 1, awaitingSweep: true })
    expect(location.measurement).toMatchObject({ activeRevision: 2, measuredRevision: 1, awaitingSweep: true })
  })

  it('never shares a result between a request with the param and one without', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    const query = 'scope=property&targetKey=harbor'
    const asked = (await overview(`${query}&${FALLBACK}`)).body
    const plain = (await overview(query)).body
    const askedAgain = (await overview(`${query}&${FALLBACK}`)).body
    expect(plain.measurement.state).toBe('not_measured')
    expect(plain.metrics.mentionCoverage).toStrictEqual(NO_COMPLETED_RUN)
    expect(asked.metrics.mentionCoverage).toStrictEqual(available(1, 2))
    expect(askedAgain).toStrictEqual(asked)
  })

  it('leaves a schema v1 plan and a simple project answering as today', async () => {
    const simple: Array<[string, number, string]> = []
    for (const [route, query] of LOCATION_READS('harbor')) {
      const plain = await refused(route, query)
      const asked = await refused(route, `${query}&${FALLBACK}`)
      expect(plain.status, route).toBe(404)
      expect(asked.text, route).toBe(plain.text)
      simple.push([route, plain.status, plain.body.error.code])
    }
    expect(new Set(simple.map(([, , code]) => code))).toStrictEqual(new Set(['NOT_FOUND']))

    seedSchemaV1Version(1)
    activate('plan-v1-schema')
    const plainOverview = await overview('scope=all')
    const askedOverview = await overview(`scope=all&${FALLBACK}`)
    expect(plainOverview.body.mode).toBe('active-v1')
    // The param is accepted and adds nothing.
    expect(askedOverview.status).toBe(200)
    expect(askedOverview.text).toBe(plainOverview.text)
    for (const [route, query] of LOCATION_READS('harbor').slice(1)) {
      const plain = await refused(route, query)
      const asked = await refused(route, `${query}&${FALLBACK}`)
      expect(plain.status, route).toBe(400)
      expect(asked.text, route).toBe(plain.text)
    }
  })

  it('leaves the portfolio reads and runId=latest not measured after a publish', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))

    const summary = await get<{ measurement: Record<string, unknown> }>('measurement-portfolio-summary', '')
    expect(summary.body.measurement).toStrictEqual({ state: 'not_measured', displayedRunId: null, planRevision: 2, completedAt: null })
    const changes = await get<{ current: Record<string, unknown> }>('measurement-changes', '')
    expect(changes.body.current).toMatchObject({ state: 'not_measured', displayedRunId: null, planRevision: 2 })
    const quality = await get<{ run: Record<string, unknown> }>('measurement-data-quality', '')
    expect(quality.body.run).toMatchObject({ state: 'not_measured', displayedRunId: null, planRevision: 2 })
    // `latest` is the default read's sweep, and there is none.
    const latest = await get<{ runCount: number; runIds: string[] }>('analytics/competitors', 'runId=latest&queryClass=non-brand')
    expect(latest.status).toBe(200)
    expect(latest.body).toMatchObject({ runCount: 0, runIds: [] })

    // The param belongs to the five location reads. These refuse it, so widening it is a visible change.
    for (const route of ['measurement-portfolio-summary', 'measurement-changes', 'measurement-data-quality']) {
      expect((await refused(route, FALLBACK)).status, route).toBe(400)
    }
  })

  it('parses one more stored plan with the param, and none more without it', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    const parses = vi.mocked(parseStoredMeasurementPlanAnyVersion)
    const parsesOf = async (route: string, query: string) => {
      parses.mockClear()
      await get<unknown>(route, query)
      return parses.mock.calls.length
    }

    for (const [name, route, query] of READS) {
      // The active plan alone, as today.
      expect(await parsesOf(route, query), name).toBe(1)
      // The active plan and the plan the last sweep ran with.
      expect(await parsesOf(route, `${query}&${FALLBACK}`), `${name} with the param`).toBe(2)
    }
  })

  it('parses only the active plan when its own sweep is the one shown', async () => {
    sweptThenPublished(null)
    const parses = vi.mocked(parseStoredMeasurementPlanAnyVersion)
    for (const [name, route, query] of READS) {
      parses.mockClear()
      await get<unknown>(route, `${query}&${FALLBACK}`)
      expect(parses.mock.calls.length, name).toBe(1)
    }
  })

  it('lets a read-only key read with the param', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    for (const [name, route, query] of READS) {
      const response = await get<{ measurement: Record<string, unknown> }>(route, `${query}&${FALLBACK}`, READ_KEY)
      expect(response.status, name).toBe(200)
      expect(response.body.measurement, name).toMatchObject(AWAITING)
    }
  })

  it('keeps the five reads closed to an embed, param or not', async () => {
    sweptThenPublished(changedPlan(addParkingQuery))
    // The embed gate goes by route. A query param cannot open one.
    const embed = Fastify()
    embed.register(apiRoutes, { db, embedProjectTabs: ['overview'] })
    await embed.ready()
    try {
      for (const [name, route, query] of READS) {
        for (const suffix of ['', `&${FALLBACK}`]) {
          const response = await embed.inject({
            method: 'GET', url: `/api/v1/projects/${PROJECT}/${route}?${query}${suffix}`, headers: { authorization: `Bearer ${READ_KEY}` },
          })
          expect(response.statusCode, `${name}${suffix}`).toBe(403)
          expect(response.json().error.message, `${name}${suffix}`).toBe('This endpoint is not available for the configured embed tabs.')
        }
      }
    } finally {
      await embed.close()
    }
  })
})
