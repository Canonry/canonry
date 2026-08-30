import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMeasurementExecutionIdentity,
  canonicalMeasurementPlanV2Json,
  type MeasurementChangesResponse,
  type MeasurementDataQualityResponse,
  type MeasurementPlanV2,
  type MeasurementPortfolioSummaryResponse,
  type MeasurementPropertyCompetitorsResponse,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { compareWeakestMarket } from '../src/measurement-portfolio-reads.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-08-02T12:00:00.000Z'
const IDENTITY_A = buildMeasurementExecutionIdentity({
  providers: ['openai', 'gemini'],
  models: { openai: 'gpt-measurement', gemini: 'gemini-measurement' },
}, 'a'.repeat(64))
const IDENTITY_B = buildMeasurementExecutionIdentity({
  providers: ['openai', 'gemini'],
  models: { openai: 'gpt-measurement-next', gemini: 'gemini-measurement' },
}, 'b'.repeat(64))

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string
let plan: MeasurementPlanV2

function seedVersion(revision: number): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  return id
}

function activate(versionId: string): void {
  db.insert(measurementPlans).values({
    projectId,
    activeVersionId: versionId,
    createdAt: NOW,
    updatedAt: NOW,
  }).onConflictDoUpdate({
    target: measurementPlans.projectId,
    set: { activeVersionId: versionId, updatedAt: NOW },
  }).run()
}

function manifestFor(executionKeys?: readonly string[]) {
  const manifest = buildMeasurementPlanV2Manifest(plan)
  if (executionKeys === undefined) return manifest
  const keys = new Set(executionKeys)
  return { ...manifest, expectedSlots: manifest.expectedSlots.filter(slot => keys.has(slot.executionId)) }
}

function seedRun(versionId: string, values: Partial<typeof runs.$inferInsert> = {}): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: manifestFor(),
    measurementExecutionIdentity: IDENTITY_A,
    finishedAt: NOW,
    createdAt: NOW,
    ...values,
  }).run()
  return id
}

function seedSnapshot(
  runId: string,
  executionKey: string,
  provider: string,
  values: Partial<typeof querySnapshots.$inferInsert> = {},
): string {
  const node = plan.executionNodes.find(candidate => candidate.stableKey === executionKey)!
  const id = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id,
    runId,
    queryId: null,
    queryText: node.queryText,
    provider,
    citationState: 'not-cited',
    answerMentioned: false,
    answerText: 'Another local option is worth considering.',
    citedDomains: [],
    citedUrls: [],
    captureStatus: 'complete',
    competitorOverlap: [],
    recommendedCompetitors: [],
    measurementExecutionId: executionKey,
    requestedContext: node.context.location,
    supportedContext: { status: 'applied', resolved: node.context.location },
    location: node.context.location?.label ?? null,
    retrievalStatus: 'used',
    retrievalContract: 'native-auto-v1',
    createdAt: NOW,
    ...values,
  }).run()
  return id
}

function seedFullRun(versionId: string, values: Partial<typeof runs.$inferInsert> = {}): string {
  const runId = seedRun(versionId, values)
  for (const provider of ['openai', 'gemini']) {
    seedSnapshot(runId, 'exec-nearby', provider)
    seedSnapshot(runId, 'exec-brand', provider)
  }
  return runId
}

async function portfolio(query = ''): Promise<{ status: number; body: MeasurementPortfolioSummaryResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-portfolio-summary${query === '' ? '' : `?${query}`}`,
  })
  return { status: response.statusCode, body: response.json() as MeasurementPortfolioSummaryResponse }
}

async function competitors(query: string): Promise<{ status: number; body: MeasurementPropertyCompetitorsResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-property-competitors?${query}`,
  })
  return { status: response.statusCode, body: response.json() as MeasurementPropertyCompetitorsResponse }
}

async function changes(query = ''): Promise<{ status: number; body: MeasurementChangesResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-changes${query === '' ? '' : `?${query}`}`,
  })
  return { status: response.statusCode, body: response.json() as MeasurementChangesResponse }
}

async function quality(query = ''): Promise<{ status: number; body: MeasurementDataQualityResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-data-quality${query === '' ? '' : `?${query}`}`,
  })
  return { status: response.statusCode, body: response.json() as MeasurementDataQualityResponse }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-portfolio-reads-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'northstar.example',
    ownedDomains: ['northstar.example'],
    country: 'US',
    language: 'en',
    locations: [],
    providers: [],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  plan = measurementPlanV2Fixture()

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement portfolio reads', () => {
  it('defaults to the latest completed full non-probe run and ranks measured weaknesses by mention then citation', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const measured = seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })

    // Harbor is present in this answer, so its own recommended names must not
    // leak into Harbor's replacement list. Bayside still missed this shared
    // execution, so it is allowed to see the same stored recommendation.
    db.update(querySnapshots).set({
      answerText: 'Harbor Homes is a strong option.',
      citationState: 'cited',
      citedUrls: ['https://northstar.example/locations/harbor/details'],
      recommendedCompetitors: ['Harbor Homes', 'Ignored For Harbor'],
    }).where(and(
      eq(querySnapshots.runId, measured),
      eq(querySnapshots.measurementExecutionId, 'exec-nearby'),
      eq(querySnapshots.provider, 'openai'),
    )).run()
    db.update(querySnapshots).set({
      answerText: 'Rival One is the better fit.',
      recommendedCompetitors: ['Harbor Homes', 'Rival One'],
    }).where(and(
      eq(querySnapshots.runId, measured),
      eq(querySnapshots.measurementExecutionId, 'exec-nearby'),
      eq(querySnapshots.provider, 'gemini'),
    )).run()

    // None of these later rows may displace the real completed full sweep.
    seedFullRun(versionId, { status: 'partial', createdAt: '2026-08-02T10:00:00.000Z' })
    seedFullRun(versionId, { trigger: 'probe', createdAt: '2026-08-02T10:30:00.000Z' })
    seedRun(versionId, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      measurementManifest: manifestFor(['exec-brand']),
      createdAt: '2026-08-02T11:00:00.000Z',
    })

    const { status, body } = await portfolio('groupKey=regional&limit=1')

    expect(status).toBe(200)
    expect(body.measurement).toMatchObject({ state: 'complete', displayedRunId: measured, planRevision: 1 })
    expect(body.queryClass).toBe('non-brand')
    expect(body.portfolio).toEqual({ groupKey: 'regional', label: 'Regional comparison', measurementScope: 'full' })
    expect(body.totalProperties).toBe(2)
    expect(body.truncated).toBe(true)
    expect(body.weakestProperties[0]).toMatchObject({ targetKey: 'bayside' })
    expect(body.weakestProperties[0]?.recommendedInstead).toEqual([
      { name: 'Harbor Homes', occurrences: 2 },
      { name: 'Ignored For Harbor', occurrences: 1 },
      { name: 'Rival One', occurrences: 1 },
    ])

    const harbor = await portfolio(`groupKey=regional&runId=${measured}&limit=2`)
    expect(harbor.body.weakestProperties.find(row => row.targetKey === 'harbor')?.recommendedInstead)
      .toEqual([{ name: 'Rival One', occurrences: 1 }])
  })

  it('scopes each market to its own members, worst-first, and agrees with a group-scoped read', async () => {
    // A market that is a STRICT SUBSET of the portfolio. With one group holding
    // every target, scoping a market to the whole portfolio produces identical
    // numbers and the bug this guards against is invisible.
    plan = {
      ...plan,
      groups: [
        ...plan.groups,
        { stableKey: 'harbor-only', label: 'Harbor only', targetKeys: ['harbor'], competitors: [] },
      ],
    }
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })

    const { status, body } = await portfolio()
    expect(status).toBe(200)
    expect(body.markets.map(market => market.groupKey).sort()).toEqual(['harbor-only', 'regional'])

    const harborOnly = body.markets.find(market => market.groupKey === 'harbor-only')!
    const regional = body.markets.find(market => market.groupKey === 'regional')!

    // Membership, not a denominator. A question aimed at a market is one answer
    // serving every member, so the two never have to reconcile.
    expect(harborOnly.propertyCount).toBe(1)
    expect(regional.propertyCount).toBe(2)

    // Coverage denominators count ANSWERS, and one shared execution serves both
    // scopes, so those legitimately match. The metric that must differ is
    // propertiesMentioned, which counts Properties: it is the assertion that
    // fails if every market is scoped to all targets rather than its members.
    expect(harborOnly.propertiesMentioned.state).toBe('available')
    expect(regional.propertiesMentioned.state).toBe('available')
    if (harborOnly.propertiesMentioned.state === 'available' && regional.propertiesMentioned.state === 'available') {
      expect(harborOnly.propertiesMentioned.denominator).toBe(1)
      expect(regional.propertiesMentioned.denominator).toBe(2)
      expect(harborOnly.propertiesMentioned.rate).toBe(harborOnly.propertiesMentioned.numerator / harborOnly.propertiesMentioned.denominator)
      expect(regional.propertiesMentioned.rate).toBe(regional.propertiesMentioned.numerator / regional.propertiesMentioned.denominator)
    }

    // Same computation as the group-scoped read, so the dashboard and the CLI
    // can never report different numbers for the same market.
    for (const market of body.markets) {
      const scoped = await portfolio(`groupKey=${market.groupKey}`)
      expect(scoped.status).toBe(200)
      expect(market.mentionCoverage).toEqual(scoped.body.metrics.mentionCoverage)
      expect(market.citationCoverage).toEqual(scoped.body.metrics.citationCoverage)
      expect(market.propertiesMentioned).toEqual(scoped.body.metrics.propertiesMentioned)
    }

    // Worst-first: an available rate never sorts after a weaker one.
    const rates = body.markets.map(m => m.mentionCoverage.state === 'available' ? m.mentionCoverage.value : Number.POSITIVE_INFINITY)
    expect([...rates].sort((a, b) => a - b)).toEqual(rates)
  })

  it('scopes every market to the spot check, so no market credits a Property the run never measured', async () => {
    // Two single-member markets. The spot check covers one of them, which is
    // the only shape in which scoping on plan membership and scoping on the run
    // produce different answers.
    plan = {
      ...plan,
      groups: [
        ...plan.groups,
        { stableKey: 'harbor-only', label: 'Harbor only', targetKeys: ['harbor'], competitors: [] },
        { stableKey: 'bayside-only', label: 'Bayside only', targetKeys: ['bayside'], competitors: [] },
      ],
    }
    const versionId = seedVersion(1)
    activate(versionId)
    const spotCheck = seedRun(versionId, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      createdAt: '2026-08-02T09:00:00.000Z',
    })
    for (const provider of ['openai', 'gemini']) {
      seedSnapshot(spotCheck, 'exec-nearby', provider, { answerMentioned: true, citationState: 'cited' })
    }

    const { status, body } = await portfolio(`runId=${spotCheck}`)
    expect(status).toBe(200)
    expect(body.portfolio.measurementScope).toBe('spot_check')

    // `bayside-only` has no member inside this spot check. A computed rate here
    // reports a market as failing when it was simply not measured, and the
    // roll-up used to report 100% for exactly this case.
    const baysideOnly = body.markets.find(market => market.groupKey === 'bayside-only')!
    expect(baysideOnly.propertyCount).toBe(0)
    expect(baysideOnly.mentionCoverage.state).toBe('unavailable')
    expect(baysideOnly.citationCoverage.state).toBe('unavailable')
    expect(baysideOnly.propertiesMentioned.state).toBe('unavailable')

    // `regional` holds both Properties in the PLAN and one in this RUN. Stating
    // 2 here contradicts the `totalProperties` its own group-scoped read gives.
    const regional = body.markets.find(market => market.groupKey === 'regional')!
    expect(regional.propertyCount).toBe(1)

    // The invariant the whole roll-up rests on: one response, one answer per
    // market, whichever way it is read.
    for (const market of body.markets) {
      const scoped = await portfolio(`groupKey=${market.groupKey}&runId=${spotCheck}`)
      expect(scoped.status).toBe(200)
      expect(market.propertyCount).toBe(scoped.body.totalProperties)
      expect(market.mentionCoverage).toEqual(scoped.body.metrics.mentionCoverage)
      expect(market.citationCoverage).toEqual(scoped.body.metrics.citationCoverage)
      expect(market.propertiesMentioned).toEqual(scoped.body.metrics.propertiesMentioned)
    }
  })

  it('orders markets worst-first on both metrics and sinks the unmeasured one', async () => {
    // Distinct outcomes per market. The previous fixture measured every market
    // at exactly 0, so the ordering assertion was an identity on [0, 0] and the
    // comparator could be reversed or deleted with the suite still green.
    plan = {
      ...plan,
      groups: [
        { stableKey: 'harbor-only', label: 'Harbor only', targetKeys: ['harbor'], competitors: [] },
        { stableKey: 'bayside-only', label: 'Bayside only', targetKeys: ['bayside'], competitors: [] },
        { stableKey: 'unmeasured', label: 'Unmeasured market', targetKeys: [], competitors: [] },
      ],
    }
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })
    // Harbor is mentioned on both engines; bayside on neither. `exec-nearby` is
    // the shared non-brand execution, so the mention lands per Property through
    // the usage edges rather than per market.
    for (const provider of ['openai', 'gemini']) {
      seedSnapshot(runId, 'exec-nearby', provider)
      seedSnapshot(runId, 'exec-brand', provider, { answerMentioned: true, citationState: 'cited' })
    }

    const { body } = await portfolio(`runId=${runId}&queryClass=branded`)
    // Harbor is the only Property carrying a branded question in the fixture, so
    // bayside's branded market is unmeasured and sorts last however it reads.
    const order = body.markets.map(market => market.groupKey)
    expect(order[order.length - 1]).toBe('unmeasured')

    // The measured markets are in non-decreasing order on the rate that is
    // actually available, which is the claim the schema makes.
    const measuredMarkets = body.markets.filter(m => m.mentionCoverage.state === 'available')
    const values = measuredMarkets.map(m => m.mentionCoverage.state === 'available' ? m.mentionCoverage.value : 0)
    expect([...values].sort((a, b) => a - b)).toEqual(values)
    expect(measuredMarkets.length).toBeGreaterThan(0)
  })

  it('reports every market as unmeasured, worst-first, when no run has completed', async () => {
    // The no-run branch had no test at all: it could be deleted outright.
    //
    // The stored plan sorts groups by stableKey, so a fixture whose keys and
    // labels agree cannot see the sort at all. These deliberately disagree:
    // stored order is alpha,zeta = "Zeta market","Alpha market", and only a
    // label sort reverses it.
    plan = {
      ...plan,
      groups: [
        { stableKey: 'alpha', label: 'Zeta market', targetKeys: ['harbor'], competitors: [] },
        { stableKey: 'zeta', label: 'Alpha market', targetKeys: ['bayside'], competitors: [] },
      ],
    }
    activate(seedVersion(1))

    const { status, body } = await portfolio()
    expect(status).toBe(200)
    expect(body.markets).toHaveLength(2)
    for (const market of body.markets) {
      expect(market.mentionCoverage).toEqual({ state: 'unavailable', reason: 'no_completed_run' })
      expect(market.citationCoverage).toEqual({ state: 'unavailable', reason: 'no_completed_run' })
      expect(market.propertiesMentioned).toEqual({ state: 'unavailable', reason: 'no_completed_run' })
    }
    // Sorted by label like every other unavailable row, not left in the stored
    // plan order (stableKey, which would have put "Zeta market" first).
    expect(body.markets.map(market => market.label)).toEqual(['Alpha market', 'Zeta market'])
    // And still omitted when the caller already narrowed to one market.
    expect((await portfolio('groupKey=alpha')).body.markets).toEqual([])
  })

  it('omits the roll-up when the request already narrowed to one market', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })

    // Repeating the selected group's own numbers under a compare-markets
    // heading says nothing, so the array is empty rather than a single row.
    const { body } = await portfolio('groupKey=regional')
    expect(body.markets).toEqual([])
  })

  it('counts Property competitors only from target-miss answers and preserves their provider and question evidence', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    db.update(querySnapshots).set({
      answerText: 'Harbor Homes is a strong option.',
      citationState: 'cited',
      citedUrls: ['https://northstar.example/locations/harbor/details'],
      recommendedCompetitors: ['Harbor Homes', 'Ignored Because Harbor Is Present'],
    }).where(and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, 'openai'),
    )).run()
    db.update(querySnapshots).set({
      answerText: 'Rival One is recommended.',
      recommendedCompetitors: ['Harbor Homes', 'Rival One'],
    }).where(and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, 'gemini'),
    )).run()

    const { status, body } = await competitors('targetKey=harbor&queryClass=non-brand')

    expect(status).toBe(200)
    expect(body.measurement).toMatchObject({ displayedRunId: runId, state: 'complete' })
    expect(body.basis).toEqual(expect.objectContaining({
      state: 'available', answeredResults: 2, targetMissResults: 1, recommendationOccurrences: 1,
    }))
    expect(body.competitors).toEqual([{
      name: 'Rival One', occurrences: 1, providers: ['gemini'], questions: ['homes near harbor'],
      providerTotal: 1, providersTruncated: false, questionTotal: 1, questionsTruncated: false,
    }])
    expect(body.total).toBe(1)
    expect(body.truncated).toBe(false)
  })

  it('uses the same brand identity as question reads for self recommendations', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    db.update(querySnapshots).set({
      recommendedCompetitors: ['Harbor Homes', 'HARBOR-HOMES', 'HarborHomes', '---', 'Rival One'],
    }).where(and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, 'gemini'),
    )).run()

    const summary = await portfolio(`groupKey=regional&runId=${runId}&limit=2`)
    const replacements = await competitors(`targetKey=harbor&runId=${runId}&queryClass=non-brand`)

    expect(summary.status).toBe(200)
    expect(summary.body.weakestProperties.find(row => row.targetKey === 'harbor')?.recommendedInstead)
      .toEqual([{ name: 'Rival One', occurrences: 1 }])
    expect(replacements.status).toBe(200)
    expect(replacements.body.competitors).toEqual([expect.objectContaining({
      name: 'Rival One', occurrences: 1,
    })])
  })

  it('caps replacement names per compact portfolio row and reports the omitted count', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    db.update(querySnapshots).set({
      answerText: 'Other options are stronger.',
      recommendedCompetitors: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'],
    }).where(and(
      eq(querySnapshots.runId, runId),
      eq(querySnapshots.measurementExecutionId, 'exec-nearby'),
      eq(querySnapshots.provider, 'openai'),
    )).run()

    const { status, body } = await portfolio('groupKey=regional&limit=2')
    const bayside = body.weakestProperties.find(row => row.targetKey === 'bayside')!

    expect(status).toBe(200)
    expect(bayside.recommendedInstead).toHaveLength(5)
    expect(bayside.recommendedInsteadTotal).toBe(7)
    expect(bayside.recommendedInsteadTruncated).toBe(true)
  })

  it('puts a Property with an unavailable coverage metric after every measured weak row', async () => {
    plan.targets.find(target => target.stableKey === 'bayside')!.mentionNotApplicable = true
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId)

    const { status, body } = await portfolio('groupKey=regional&limit=2')

    expect(status).toBe(200)
    expect(body.weakestProperties.map(row => row.targetKey)).toEqual(['harbor', 'bayside'])
    expect(body.weakestProperties[0]?.mentionCoverage.state).toBe('available')
    expect(body.weakestProperties[1]?.mentionCoverage).toEqual({ state: 'unavailable', reason: 'not_applicable' })

    const replacements = await competitors('targetKey=bayside&queryClass=non-brand')
    expect(replacements.status).toBe(200)
    expect(replacements.body.basis).toMatchObject({
      state: 'available', targetMissResults: 0, recommendationOccurrences: 0,
    })
    expect(replacements.body.competitors).toEqual([])
  })

  it('compares only the immediately previous same-revision, same-identity full result and emits current-minus-previous deltas', async () => {
    const versionId = seedVersion(2)
    activate(versionId)
    const previous = seedFullRun(versionId, { createdAt: '2026-08-02T08:00:00.000Z' })
    const current = seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })
    db.update(querySnapshots).set({
      answerText: 'Harbor Homes and Bayside Homes are strong options.',
      citationState: 'cited',
      citedUrls: [
        'https://northstar.example/locations/harbor/details',
        'https://northstar.example/locations/bayside/details',
      ],
    }).where(eq(querySnapshots.runId, current)).run()

    const { status, body } = await changes('limit=1')

    expect(status).toBe(200)
    expect(body.current).toMatchObject({ displayedRunId: current, planRevision: 2 })
    expect(body.comparison).toMatchObject({
      state: 'available', previous: { displayedRunId: previous, planRevision: 2 },
    })
    if (body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    expect(body.comparison.metrics.mentionCoverage).toMatchObject({ state: 'available', delta: 1 })
    expect(body.comparison.metrics.citationCoverage).toMatchObject({ state: 'available', delta: 1 })
    expect(body.comparison.totalProperties).toBe(2)
    expect(body.comparison.truncated).toBe(true)
    expect(body.comparison.changedProperties).toHaveLength(1)
  })

  it('does not report a Property changed when its unavailable metrics remain unavailable for the same reason', async () => {
    plan.targets.find(target => target.stableKey === 'bayside')!.mentionNotApplicable = true
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId, { createdAt: '2026-08-02T08:00:00.000Z' })
    seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })

    const { status, body } = await changes()

    expect(status).toBe(200)
    expect(body.comparison).toMatchObject({ state: 'available' })
    if (body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    expect(body.comparison.changedProperties).toEqual([])
    expect(body.comparison.totalProperties).toBe(0)
    expect(body.comparison.truncated).toBe(false)
  })

  it('does not bridge changes across an execution identity boundary', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId, {
      measurementExecutionIdentity: IDENTITY_A,
      createdAt: '2026-08-02T08:00:00.000Z',
    })
    seedFullRun(versionId, {
      measurementExecutionIdentity: IDENTITY_B,
      createdAt: '2026-08-02T09:00:00.000Z',
    })

    const { status, body } = await changes()

    expect(status).toBe(200)
    expect(body.comparison).toEqual({ state: 'unavailable', reason: 'execution_identity_changed' })
  })

  it('skips an intervening execution identity to find the latest prior matching series', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const matchingPrevious = seedFullRun(versionId, {
      measurementExecutionIdentity: IDENTITY_A,
      createdAt: '2026-08-02T07:00:00.000Z',
    })
    seedFullRun(versionId, {
      measurementExecutionIdentity: IDENTITY_B,
      createdAt: '2026-08-02T08:00:00.000Z',
    })
    const current = seedFullRun(versionId, {
      measurementExecutionIdentity: IDENTITY_A,
      createdAt: '2026-08-02T09:00:00.000Z',
    })

    const { status, body } = await changes()

    expect(status).toBe(200)
    expect(body.current.displayedRunId).toBe(current)
    expect(body.comparison).toMatchObject({
      state: 'available', previous: { displayedRunId: matchingPrevious },
    })
  })

  it('skips an intervening partial run to find the latest completed comparable result', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const matchingPrevious = seedFullRun(versionId, { createdAt: '2026-08-02T07:00:00.000Z' })
    seedFullRun(versionId, { status: 'partial', createdAt: '2026-08-02T08:00:00.000Z' })
    const current = seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })

    const { status, body } = await changes()

    expect(status).toBe(200)
    expect(body.current.displayedRunId).toBe(current)
    expect(body.comparison).toMatchObject({
      state: 'available', previous: { displayedRunId: matchingPrevious },
    })
  })

  it('returns exact run-level completeness, capture, and retrieval populations without inventing a quality threshold', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId, {
      status: 'partial',
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      measurementManifest: manifestFor(['exec-nearby']),
      createdAt: '2026-08-02T09:00:00.000Z',
    })
    seedSnapshot(runId, 'exec-nearby', 'openai', { captureStatus: 'complete', retrievalStatus: 'used' })
    seedSnapshot(runId, 'exec-nearby', 'gemini', {
      captureStatus: 'partial',
      retrievalStatus: 'unknown',
      citedUrls: ['https://elsewhere.example/source'],
    })

    const { status, body } = await quality(`runId=${runId}`)

    expect(status).toBe(200)
    expect(body.run).toMatchObject({ displayedRunId: runId, state: 'partial', measurementScope: 'spot_check' })
    expect(body.completeness).toEqual({ state: 'available', expected: 2, executed: 2, answered: 2, missing: 0 })
    expect(body.capture).toEqual({ state: 'available', complete: 1, partial: 1, failed: 0, unsupported: 0, notRecorded: 0 })
    expect(body.retrieval).toEqual({ state: 'available', used: 1, notUsed: 0, unknown: 1, notApplicable: 0, notRecorded: 0 })
    expect(body.population).toEqual({ state: 'available', expectedQuestions: 1, answeredQuestions: 1, missingQuestions: 0 })
    expect(body).not.toHaveProperty('quality')
  })

  it('does not call an unsupported location-context answer usable evidence', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      measurementManifest: manifestFor(['exec-nearby']),
    })
    seedSnapshot(runId, 'exec-nearby', 'openai', {
      location: null,
      supportedContext: null,
    })

    const { status, body } = await quality(`runId=${runId}`)

    expect(status).toBe(200)
    expect(body.completeness).toEqual({ state: 'available', expected: 2, executed: 1, answered: 0, missing: 1 })
    expect(body.population).toEqual({ state: 'available', expectedQuestions: 1, answeredQuestions: 0, missingQuestions: 1 })
  })

  it('does not let provider-casing duplicates hide a missing expected slot', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      measurementManifest: manifestFor(['exec-nearby']),
    })
    seedSnapshot(runId, 'exec-nearby', 'openai')
    seedSnapshot(runId, 'exec-nearby', 'OpenAI')

    const { status, body } = await quality(`runId=${runId}`)

    expect(status).toBe(200)
    expect(body.completeness).toEqual({ state: 'unavailable', reason: 'evidence_incomplete' })
    expect(body.capture).toEqual({ state: 'unavailable', reason: 'evidence_incomplete' })
    expect(body.retrieval).toEqual({ state: 'unavailable', reason: 'evidence_incomplete' })
    expect(body.population).toEqual({ state: 'unavailable', reason: 'evidence_incomplete' })
  })

  it('identifies the immediately previous same-series full run in data quality', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const previous = seedFullRun(versionId, { createdAt: '2026-08-02T08:00:00.000Z' })
    const current = seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })

    const { status, body } = await quality()

    expect(status).toBe(200)
    expect(body.run.displayedRunId).toBe(current)
    expect(body.comparison).toEqual({ state: 'available', previousDisplayedRunId: previous })
  })

  it('compares an explicit spot check with its previous same-scope spot check', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const scope = { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] }
    const previous = seedRun(versionId, {
      trigger: 'probe',
      measurementScope: scope,
      measurementManifest: manifestFor(['exec-nearby']),
      createdAt: '2026-08-02T08:00:00.000Z',
    })
    const current = seedRun(versionId, {
      trigger: 'probe',
      measurementScope: scope,
      measurementManifest: manifestFor(['exec-nearby']),
      createdAt: '2026-08-02T09:00:00.000Z',
    })
    for (const provider of ['openai', 'gemini']) {
      seedSnapshot(previous, 'exec-nearby', provider)
      seedSnapshot(current, 'exec-nearby', provider)
    }

    const change = await changes(`runId=${current}&scope=property&targetKey=harbor`)
    expect(change.status).toBe(200)
    expect(change.body.current.measurementScope).toBe('spot_check')
    expect(change.body.comparison).toMatchObject({
      state: 'available', previous: { displayedRunId: previous, measurementScope: 'spot_check' },
    })

    const scopedPortfolio = await portfolio(`runId=${current}`)
    expect(scopedPortfolio.status).toBe(200)
    expect(scopedPortfolio.body.portfolio.measurementScope).toBe('spot_check')
    expect(scopedPortfolio.body.totalProperties).toBe(1)
    expect(scopedPortfolio.body.weakestProperties.map(row => row.targetKey)).toEqual(['harbor'])

    const outsideScope = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-changes?runId=${current}&scope=property&targetKey=bayside`,
    })
    expect(outsideScope.statusCode).toBe(400)

    const inspected = await quality(`runId=${current}`)
    expect(inspected.status).toBe(200)
    expect(inspected.body.run.measurementScope).toBe('spot_check')
    expect(inspected.body.comparison).toEqual({ state: 'available', previousDisplayedRunId: previous })
  })
})

describe('compareWeakestMarket', () => {
  const rate = (value: number, numerator: number, denominator: number) =>
    ({ state: 'available' as const, value, numerator, denominator })
  const gone = { state: 'unavailable' as const, reason: 'evidence_incomplete' as const }
  const market = (
    groupKey: string,
    label: string,
    mentionCoverage: ReturnType<typeof rate> | typeof gone,
    citationCoverage: ReturnType<typeof rate> | typeof gone,
  ) => ({ groupKey, label, propertyCount: 1, propertiesMentioned: rate(1, 1, 1), mentionCoverage, citationCoverage })
  const order = (...rows: ReturnType<typeof market>[]) =>
    [...rows].sort(compareWeakestMarket).map(row => row.groupKey)

  it('puts the weaker mention rate first', () => {
    expect(order(
      market('strong', 'Strong', rate(0.8, 4, 5), rate(0.8, 4, 5)),
      market('weak', 'Weak', rate(0.2, 1, 5), rate(0.2, 1, 5)),
    )).toEqual(['weak', 'strong'])
  })

  it('breaks a mention tie on citation, not on the label', () => {
    // Two markets are equally mentioned and one is barely cited. Ranking on
    // mention alone falls straight through to the label, which puts the market
    // that needs attention second whenever its name happens to sort later.
    expect(order(
      market('a-market', 'A market', rate(0.5, 1, 2), rate(0.9, 9, 10)),
      market('z-market', 'Z market', rate(0.5, 1, 2), rate(0.1, 1, 10)),
    )).toEqual(['z-market', 'a-market'])
  })

  it('demotes a market whose citation rate is missing, however good its mention rate looks', () => {
    // The failure the mention-only comparator produced in reverse: a partially
    // measured market is not a strong one, and cannot be ranked against markets
    // that were measured on both signals.
    expect(order(
      market('partial', 'Partial', rate(0, 0, 5), gone),
      market('measured', 'Measured', rate(0.9, 9, 10), rate(0.9, 9, 10)),
    )).toEqual(['measured', 'partial'])
  })

  it('demotes a market whose mention rate is missing even when its citation rate is the portfolio worst', () => {
    expect(order(
      market('withheld', 'Withheld', gone, rate(0, 0, 10)),
      market('measured', 'Measured', rate(0.9, 9, 10), rate(0.9, 9, 10)),
    )).toEqual(['measured', 'withheld'])
  })

  it('orders two unmeasured markets by label, then by key', () => {
    expect(order(
      market('zulu', 'Same label', gone, gone),
      market('alpha', 'Same label', gone, gone),
      market('mid', 'Another label', gone, gone),
    )).toEqual(['mid', 'alpha', 'zulu'])
  })
})
