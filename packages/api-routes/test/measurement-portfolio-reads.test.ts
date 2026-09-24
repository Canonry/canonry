import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildMeasurementExecutionIdentity,
  canonicalMeasurementPlanV2Json,
  type MeasurementChangesResponse,
  type MeasurementDataQualityResponse,
  type MeasurementPlanV2,
  type MeasurementPortfolioSummaryResponse,
  type MeasurementPropertyCompetitorsResponse,
  type ProjectReportDto,
  type VisibilityReportResponse,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  querySnapshots,
  runFills,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
const portfolioReadWork = vi.hoisted(() => ({
  evaluatorBuilds: 0,
  targetMentionChecks: 0,
}))

vi.mock('../src/measurement-report.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/measurement-report.js')>()
  return {
    ...actual,
    createMeasurementOverviewEvaluator: (...args: Parameters<typeof actual.createMeasurementOverviewEvaluator>) => {
      portfolioReadWork.evaluatorBuilds++
      return actual.createMeasurementOverviewEvaluator(...args)
    },
    targetMentionedInAnswer: (...args: Parameters<typeof actual.targetMentionedInAnswer>) => {
      portfolioReadWork.targetMentionChecks++
      return actual.targetMentionedInAnswer(...args)
    },
  }
})

import { apiRoutes } from '../src/index.js'
import { classifyPropertyMove, compareChangeMagnitude, compareWeakestMarket } from '../src/measurement-portfolio-reads.js'
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
  portfolioReadWork.evaluatorBuilds = 0
  portfolioReadWork.targetMentionChecks = 0

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement portfolio reads', () => {
  it('ranks usable mentions over attributable answers, independently of citation capture and the list limit', async () => {
    const uncertain = { ...structuredClone(plan.targets[0]!), stableKey: 'cedar', label: 'Cedar Court', aliases: ['Cedar Court'], urlMatchers: [] }
    plan.targets.push(uncertain)
    for (const assignment of plan.assignments.filter(row => row.targetKey === 'harbor')) {
      plan.assignments.push({ ...assignment, targetKey: uncertain.stableKey })
      plan.usageEdges.push({ targetKey: uncertain.stableKey, queryId: assignment.queryId, executionNodeKey: assignment.executionNodeKey })
    }
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    db.update(querySnapshots).set({ captureStatus: 'partial' }).where(eq(querySnapshots.runId, runId)).run()
    db.update(querySnapshots).set({ answerText: `${plan.targets[0]!.label} is listed.` })
      .where(and(eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'))).run()
    db.update(querySnapshots).set({ answerText: `Which ${uncertain.label} do you mean?` })
      .where(and(eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-brand'))).run()

    const mixed = await portfolio('queryClass=all&limit=1')
    expect(mixed.status).toBe(200)
    // The two branded answers ask which Cedar Court was meant. They leave both
    // sides of the aggregate rather than blanking it: the two non-brand answers
    // name Harbor Homes, so 2 of the 2 attributable answers mention a Property.
    expect(mixed.body.metrics.mentionCoverage).toEqual({ state: 'available', value: 1, numerator: 2, denominator: 2, unattributed: 2 })
    expect(mixed.body.mentionRanking).toMatchObject({
      eligiblePropertyCount: 3, truncated: true, excluded: [],
      strongest: [{ targetKey: 'harbor', mentionCoverage: { state: 'available', numerator: 2, denominator: 4, value: 0.5 }, citationCoverage: { state: 'unavailable', reason: 'evidence_incomplete' } }],
      weakest: [{ targetKey: 'bayside', mentionCoverage: { state: 'available', value: 0 } }],
    })
    expect(mixed.body.mentionRanking.strongest).toHaveLength(1)
    expect(mixed.body.mentionRanking.weakest).toHaveLength(1)
    // Harbor's branded answers name neither Property it could be confused with:
    // they are measured negatives, not unattributable, so nothing is left out.
    expect(mixed.body.mentionRanking.strongest[0]!.mentionCoverage).not.toHaveProperty('unattributed')

    // Cedar Court is ranked over the answers that could be attributed to it:
    // 0 of its 2 non-brand answers, with its 2 uncertain branded answers left out.
    const ranked = (await portfolio('queryClass=all')).body.mentionRanking
    expect([...ranked.strongest, ...ranked.weakest].find(row => row.targetKey === uncertain.stableKey)?.mentionCoverage)
      .toEqual({ state: 'available', value: 0, numerator: 0, denominator: 2, unattributed: 2 })

    // Branded alone, every answer is uncertain: nothing is left to measure, so
    // the aggregate and Cedar Court stay unavailable instead of reading zero.
    const branded = await portfolio('queryClass=branded')
    expect(branded.body.metrics.mentionCoverage).toEqual({ state: 'unavailable', reason: 'identity_ambiguous' })
    expect(branded.body.mentionRanking.excluded).toContainEqual({ targetKey: uncertain.stableKey, label: uncertain.label, reason: 'identity_ambiguous' })
    expect(branded.body.mentionRanking.strongest.find(row => row.targetKey === 'harbor')?.mentionCoverage)
      .toEqual({ state: 'available', value: 0, numerator: 0, denominator: 2 })

    // The ambiguous answer was branded. Default non-brand reporting must not
    // inherit its warning or count it in any Property's denominator.
    const nonBrand = await portfolio('limit=1')
    expect(nonBrand.body.queryClass).toBe('non-brand')
    expect(nonBrand.body.mentionRanking).toMatchObject({
      eligiblePropertyCount: 3, excluded: [],
      strongest: [{ targetKey: 'harbor', mentionCoverage: { numerator: 2, denominator: 2, value: 1 } }],
    })
    const scoped = await portfolio('groupKey=regional&queryClass=all&provider=openai')
    expect(scoped.body.mentionRanking).toMatchObject({
      eligiblePropertyCount: 2, excluded: [], truncated: false,
      strongest: [{ targetKey: 'harbor', mentionCoverage: { numerator: 1, denominator: 2 } }, { targetKey: 'bayside' }],
    })
  })

  it('keeps tied mention rankings stable without promoting citation coverage as a tie-break', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    db.update(querySnapshots).set({ citedUrls: ['https://northstar.example/locations/bayside'] }).where(eq(querySnapshots.runId, runId)).run()
    const { body } = await portfolio('limit=1')
    expect(body.mentionRanking.strongest.map(row => row.targetKey)).toEqual(['bayside'])
    expect(body.mentionRanking.weakest.map(row => row.targetKey)).toEqual(['bayside'])
    expect(body.mentionRanking.weakest[0]?.citationCoverage).toMatchObject({ state: 'available', value: 1 })
    expect(body.mentionRanking.weakest[0]?.mentionCoverage).toMatchObject({ state: 'available', value: 0 })
    expect(body.mentionRanking.eligiblePropertyCount).toBe(2)
  })

  it('returns no mention winners before measurement and keeps exclusions outside the list limit', async () => {
    activate(seedVersion(1))
    const { status, body } = await portfolio('limit=1')
    expect(status).toBe(200)
    expect(body.mentionRanking).toEqual({
      eligiblePropertyCount: 0, strongest: [], weakest: [], truncated: false,
      excluded: [...plan.targets].sort((a, b) => a.label.localeCompare(b.label)).map(target => ({ targetKey: target.stableKey, label: target.label, reason: 'no_completed_run' })),
    })
  })

  it.each(['complete', 'missing-answer', 'partial-citation'] as const)('keeps summary, dashboard and client coverage consistent for %s evidence', async scenario => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId, { status: scenario === 'missing-answer' ? 'partial' : 'completed' })
    const slot = (provider: string) => and(eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, provider))
    db.update(querySnapshots).set({ answerText: 'Harbor Homes is listed.', citedUrls: ['https://northstar.example/locations/harbor'], captureStatus: 'complete' }).where(slot('openai')).run()
    if (scenario === 'missing-answer') db.delete(querySnapshots).where(slot('gemini')).run()
    if (scenario === 'partial-citation') db.update(querySnapshots).set({ captureStatus: 'partial' }).where(slot('gemini')).run()

    const summary = await portfolio(`queryClass=non-brand&runId=${runId}`)
    expect(summary.status).toBe(200)
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/northstar/visibility-report?queryClass=non-brand&runId=${runId}` })
    expect(response.statusCode, response.body).toBe(200)
    const measured = response.json<VisibilityReportResponse>().populations[0]!.summary
    const reportResponse = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/report' })
    expect(reportResponse.statusCode, reportResponse.body).toBe(200)
    const report = reportResponse.json<ProjectReportDto>().visibility!.populations.find(row => row.queryClass === 'non-brand')!.summary
    expect(report).toEqual(measured)
    for (const key of ['mentionCoverage', 'citationCoverage'] as const) {
      const metric = summary.body.metrics[key]
      expect(metric.state === 'available' ? metric.value : null).toBe(measured[key].rate)
    }
    const reach = summary.body.metrics.propertiesMentioned
    expect(reach.state === 'available' ? reach.value : null).toBe(measured.propertyReach.numerator)
    expect(measured.mentionCoverage.rate).toBe(scenario === 'missing-answer' ? null : 0.5)
    expect(measured.citationCoverage.rate).toBe(scenario === 'complete' ? 0.5 : null)

    // Missing evidence outside the chosen provider must not poison its rate.
    const filtered = await portfolio(`queryClass=non-brand&runId=${runId}&provider=openai`)
    expect(filtered.body.metrics.mentionCoverage).toMatchObject({ state: 'available', value: 1, numerator: 1, denominator: 1 })
    expect(filtered.body.metrics.citationCoverage).toMatchObject({ state: 'available', value: 1, numerator: 1, denominator: 1 })
    const filteredResponse = await app.inject({ method: 'GET', url: `/api/v1/projects/northstar/visibility-report?queryClass=non-brand&runId=${runId}&provider=openai` })
    expect(filteredResponse.statusCode, filteredResponse.body).toBe(200)
    expect(filteredResponse.json<VisibilityReportResponse>().populations[0]!.summary.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
  })

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
    expect(body.weakestProperties[0]?.namedInsteadInAnswerText).toEqual([
      { name: 'Harbor Homes', answers: 2 },
      { name: 'Ignored For Harbor', answers: 1 },
      { name: 'Rival One', answers: 1 },
    ])
    // Existing consumers still read the deprecated names: the same names, with
    // `occurrences` counting answers exactly as `answers` does.
    expect(body.weakestProperties[0]).toMatchObject({
      recommendedInstead: [
        { name: 'Harbor Homes', occurrences: 2 },
        { name: 'Ignored For Harbor', occurrences: 1 },
        { name: 'Rival One', occurrences: 1 },
      ],
      recommendedInsteadTotal: 3,
      recommendedInsteadTruncated: false,
    })

    const harbor = await portfolio(`groupKey=regional&runId=${measured}&limit=2`)
    expect(harbor.body.weakestProperties.find(row => row.targetKey === 'harbor')?.namedInsteadInAnswerText)
      .toEqual([{ name: 'Rival One', answers: 1 }])
  })

  it('prepares the filtered run once and reads recommendations only for displayed Properties', async () => {
    plan = {
      ...plan,
      groups: [
        ...plan.groups,
        { stableKey: 'harbor-only', label: 'Harbor only', targetKeys: ['harbor'], competitors: [] },
      ],
    }
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId)

    const { status, body } = await portfolio('limit=1')

    expect(status).toBe(200)
    expect(body.weakestProperties).toHaveLength(1)
    expect(portfolioReadWork.evaluatorBuilds).toBe(1)
    // Recommendation rows reuse the already prepared per-target tri-state,
    // including identity uncertainty, without repeating lexical attribution.
    expect(portfolioReadWork.targetMentionChecks).toBe(0)
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

  function nestPlan(): void {
    // One metro holding both Properties, with submarkets two levels deep. The
    // labels deliberately sort differently from the keys.
    plan = {
      ...plan,
      groups: [
        { stableKey: 'coastal-metro', label: 'Coastal Metro', targetKeys: ['harbor', 'bayside'], competitors: [] },
        { stableKey: 'a-waterfront', label: 'Waterfront', parentGroupKey: 'coastal-metro', targetKeys: ['harbor', 'bayside'], competitors: [] },
        { stableKey: 'z-harbor-district', label: 'Harbor District', parentGroupKey: 'coastal-metro', targetKeys: ['harbor'], competitors: [] },
        { stableKey: 'harbor-pier', label: 'Harbor Pier', parentGroupKey: 'z-harbor-district', targetKeys: ['harbor'], competitors: [] },
      ],
    }
  }

  it('places every Property row in its metro and submarkets and states the queries behind its answers', async () => {
    nestPlan()
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    db.update(querySnapshots).set({ answerText: 'Harbor Homes is listed.' })
      .where(and(eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'))).run()

    const { status, body } = await portfolio()
    expect(status).toBe(200)
    expect(body.engines).toEqual(['gemini', 'openai'])
    const harbor = body.weakestProperties.find(row => row.targetKey === 'harbor')!
    // Shallowest submarket first, then by label; the metro is the group itself, never a label guess.
    expect(harbor).toMatchObject({
      metro: { groupKey: 'coastal-metro', label: 'Coastal Metro' },
      submarkets: ['Harbor District', 'Waterfront', 'Harbor Pier'],
      queries: 1,
      mentionCoverage: { state: 'available', numerator: 2, denominator: 2 },
    })
    expect(harbor).not.toHaveProperty('otherMetros')
    // The denominator counts answers: 1 query on 2 engines.
    const mention = harbor.mentionCoverage
    expect(mention.state === 'available' ? mention.denominator : null).toBe(harbor.queries * body.engines.length)
    expect(body.weakestProperties.find(row => row.targetKey === 'bayside')).toMatchObject({
      metro: { groupKey: 'coastal-metro', label: 'Coastal Metro' }, submarkets: ['Waterfront'], queries: 1,
    })
    // Ranked rows carry the same placement, so best and worst lists can be grouped too.
    expect(body.mentionRanking.strongest[0]).toMatchObject({
      targetKey: 'harbor', metro: { groupKey: 'coastal-metro' }, submarkets: ['Harbor District', 'Waterfront', 'Harbor Pier'], queries: 1,
    })
    expect(body.mentionRanking.weakest[0]).toMatchObject({ targetKey: 'bayside', metro: { groupKey: 'coastal-metro' }, queries: 1 })

    // Both classes: Harbor also carries the branded query.
    const all = await portfolio('queryClass=all')
    expect(all.body.weakestProperties.find(row => row.targetKey === 'harbor')?.queries).toBe(2)
  })

  it('names every metro a Property belongs to rather than picking one silently', async () => {
    plan = {
      ...plan,
      groups: [
        ...plan.groups,
        { stableKey: 'coastal-metro', label: 'Coastal Metro', targetKeys: ['harbor'], competitors: [] },
      ],
    }
    activate(seedVersion(1))

    const { body } = await portfolio()
    const harbor = body.weakestProperties.find(row => row.targetKey === 'harbor')!
    expect(harbor.metro).toEqual({ groupKey: 'coastal-metro', label: 'Coastal Metro' })
    expect(harbor.otherMetros).toEqual([{ groupKey: 'regional', label: 'Regional comparison' }])
    // Before any run: placement and the planned query basis, never a rate.
    expect(harbor).toMatchObject({ submarkets: [], queries: 1, mentionCoverage: { state: 'unavailable', reason: 'no_completed_run' } })
    expect(harbor).toMatchObject({ recommendedInstead: [], recommendedInsteadTotal: 0, recommendedInsteadTruncated: false })
    expect(body).toMatchObject({ engines: [], tiedAtWeakest: null, weakestAnswerSources: null })
  })

  it('lists one market level by default and every level only when asked', async () => {
    nestPlan()
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId)

    const top = (await portfolio()).body
    expect(top.markets.map(market => [market.groupKey, market.parentGroupKey, market.childMarketCount]))
      .toEqual([['coastal-metro', null, 2]])
    expect(top).toMatchObject({ totalMarkets: 1, marketsTruncated: false })

    // A scope asks for the next level down: the metro's direct children.
    const children = (await portfolio('groupKey=coastal-metro')).body
    expect(children.markets.map(market => [market.label, market.parentGroupKey, market.childMarketCount]).sort())
      .toEqual([['Harbor District', 'coastal-metro', 1], ['Waterfront', 'coastal-metro', 0]])
    // A child market row is the same computation as that market read on its own.
    for (const market of children.markets) {
      const scoped = await portfolio(`groupKey=${market.groupKey}`)
      expect(market.mentionCoverage).toEqual(scoped.body.metrics.mentionCoverage)
      expect(market.propertiesMentioned).toEqual(scoped.body.metrics.propertiesMentioned)
      expect(market.propertyCount).toBe(scoped.body.totalProperties)
    }

    const nestedInScope = (await portfolio('groupKey=coastal-metro&includeNestedMarkets=true')).body
    expect(nestedInScope.markets.map(market => market.groupKey).sort()).toEqual(['a-waterfront', 'harbor-pier', 'z-harbor-district'])
    const everything = (await portfolio('includeNestedMarkets=true&limit=1')).body
    // The previous full roll-up, uncapped by the row limit.
    expect(everything.markets).toHaveLength(4)
    expect(everything).toMatchObject({ totalMarkets: 4, marketsTruncated: false })
    expect(everything.markets.find(market => market.groupKey === 'harbor-pier')?.parentGroupKey).toBe('z-harbor-district')

    expect((await portfolio('includeNestedMarkets=yes')).status).toBe(400)
  })

  it('lists every market at the returned level whatever the row limit', async () => {
    plan = {
      ...plan,
      groups: [
        ...['north', 'south', 'east'].map(name => ({
          stableKey: `${name}-metro`, label: `${name} metro`, targetKeys: ['harbor', 'bayside'], competitors: [],
        })),
        ...['pier', 'dock', 'wharf'].map(name => ({
          stableKey: `${name}-district`, label: `${name} district`, parentGroupKey: 'north-metro', targetKeys: ['harbor'], competitors: [],
        })),
      ],
    }
    activate(seedVersion(1))
    // A comparison that stops at the row limit sends the reader after the
    // missing metros one at a time.
    const { body } = await portfolio('limit=1')
    expect(body.weakestProperties).toHaveLength(1)
    expect(body.markets.map(market => market.groupKey).sort()).toEqual(['east-metro', 'north-metro', 'south-metro'])
    expect(body).toMatchObject({ totalMarkets: 3, marketsTruncated: false })
    // A metro's own submarkets are one level too, and just as complete.
    const children = (await portfolio('groupKey=north-metro&limit=1')).body
    expect(children.markets).toHaveLength(3)
    expect(children).toMatchObject({ totalMarkets: 3, marketsTruncated: false })
    expect((await portfolio('limit=1&includeNestedMarkets=true')).body.markets).toHaveLength(6)
  })

  it('reports a tie at the weakest rate and where engines got the tied answers, each answer counted once', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    const nearby = (provider: string) => and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, provider),
    )
    db.update(querySnapshots).set({
      citedDomains: ['www.Listings.example', 'rentals.example', 'vertexaisearch.cloud.google.com'],
    }).where(nearby('openai')).run()
    // Gemini's stored domains are resolved; they count like any engine's.
    db.update(querySnapshots).set({ citedDomains: ['listings.example', 'reviews.example'] }).where(nearby('gemini')).run()

    const { body } = await portfolio('limit=1')
    // Both Properties missed both answers. Their order is the label tie-break.
    expect(body.tiedAtWeakest).toEqual({
      count: 2, mentionRate: 0, citationRate: 0, note: 'tied Properties are ordered by name, not ranked',
      byMetro: [{ metro: 'Regional comparison', count: 2 }],
      namedInstead: [],
      namedInsteadTotal: 0,
    })
    expect(body.weakestProperties.map(row => row.targetKey)).toEqual(['bayside'])
    expect(body.weakestProperties[0]).toMatchObject({
      citedDomains: [{ domain: 'listings.example', answers: 2 }, { domain: 'rentals.example', answers: 1 }, { domain: 'reviews.example', answers: 1 }],
      citedDomainsTotal: 3,
    })
    // The shared execution serves both Properties: 2 stored answers, not 4,
    // and the tied Property beyond the limit is still in the basis.
    expect(body.weakestAnswerSources).toEqual({
      properties: 2,
      answers: 2,
      domains: [{ domain: 'listings.example', answers: 2 }, { domain: 'rentals.example', answers: 1 }, { domain: 'reviews.example', answers: 1 }],
      domainTotal: 3,
    })

    // Once Harbor is named, nothing ties: the sources cover the displayed rows only.
    db.update(querySnapshots).set({ answerText: 'Harbor Homes is listed.' }).where(nearby('openai')).run()
    const untied = (await portfolio('limit=1')).body
    expect(untied.tiedAtWeakest).toBeNull()
    expect(untied.weakestProperties.map(row => row.targetKey)).toEqual(['bayside'])
    expect(untied.weakestAnswerSources).toMatchObject({ properties: 1, answers: 2 })
  })

  it('places and characterizes the whole tie, not only the rows the limit returns', async () => {
    // Three Properties tie at zero. One sits in two metros and one in none.
    const cedar = { ...structuredClone(plan.targets[1]!), stableKey: 'cedar', label: 'Cedar Court', aliases: ['Cedar Court'], urlMatchers: [] }
    plan.targets.push(cedar)
    plan.assignments.push({ targetKey: 'cedar', queryId: 'q-nearby', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' })
    plan.usageEdges.push({ executionNodeKey: 'exec-nearby', targetKey: 'cedar', queryId: 'q-nearby' })
    plan = {
      ...plan,
      groups: [
        { stableKey: 'coastal-metro', label: 'Coastal Metro', targetKeys: ['harbor', 'bayside'], competitors: [] },
        { stableKey: 'inland-metro', label: 'Inland Metro', targetKeys: ['harbor'], competitors: [] },
      ],
    }
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    const nearby = (provider: string) => and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, provider),
    )
    db.update(querySnapshots).set({ recommendedCompetitors: ['Rival One', 'Harbor Homes', 'Rival Two'] }).where(nearby('openai')).run()
    db.update(querySnapshots).set({ recommendedCompetitors: ['Rival One', 'RIVAL ONE'] }).where(nearby('gemini')).run()
    // Branded, and naming Harbor: outside the default non-brand read.
    db.update(querySnapshots).set({ answerText: 'Harbor Homes is well reviewed.', recommendedCompetitors: ['Rival Three'] }).where(and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-brand'),
    )).run()

    const { body } = await portfolio('limit=1')
    expect(body.weakestProperties.map(row => row.targetKey)).toEqual(['bayside'])
    expect(body.tiedAtWeakest).toMatchObject({
      count: 3,
      // Harbor counts in both of its metros; Cedar Court is in none.
      byMetro: [{ metro: 'Coastal Metro', count: 2 }, { metro: 'Inland Metro', count: 1 }, { metro: null, count: 1 }],
      // Two stored answers serve all three tied Properties: each counts once
      // per name, however many tied Properties it missed or spellings it used.
      // Harbor Homes is written instead of the other two, never of itself.
      namedInstead: [{ name: 'RIVAL ONE', answers: 2 }, { name: 'Harbor Homes', answers: 1 }, { name: 'Rival Two', answers: 1 }],
      namedInsteadTotal: 3,
    })

    const everyClass = (await portfolio('limit=1&queryClass=all')).body
    // Harbor's branded mentions lift it out of the tie: only Bayside and Cedar Court share the weakest rates.
    expect(everyClass.tiedAtWeakest).toMatchObject({ count: 2, byMetro: [{ metro: 'Coastal Metro', count: 1 }, { metro: null, count: 1 }] })
    expect(everyClass.tiedAtWeakest?.namedInstead?.map(row => row.name)).not.toContain('Rival Three')
  })

  it('counts the hosts of captured citation URLs when the stored domain list is empty', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    const nearby = (provider: string) => and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, provider),
    )
    // Gemini hides each source behind a grounding redirect. When a redirect
    // does not decode and its title is not a domain, normalization stores no
    // domain, while URL capture resolved every source. Citation coverage reads
    // those URLs, so the source lists must read them too.
    db.update(querySnapshots).set({
      citedDomains: [],
      citedUrls: ['https://northstar.example/locations/harbor', 'https://www.Listings.example/harbor-homes'],
    }).where(nearby('gemini')).run()
    // A host in both stored lists is one source for that answer, not two.
    db.update(querySnapshots).set({
      citedDomains: ['listings.example'],
      citedUrls: ['https://www.listings.example/harbor-homes'],
    }).where(nearby('openai')).run()

    const gemini = await portfolio('provider=gemini&limit=2')
    expect(gemini.status).toBe(200)
    const harbor = gemini.body.weakestProperties.find(row => row.targetKey === 'harbor')!
    expect(harbor.citationCoverage).toMatchObject({ state: 'available', numerator: 1, denominator: 1 })
    expect(harbor).toMatchObject({
      citedDomains: [{ domain: 'listings.example', answers: 1 }, { domain: 'northstar.example', answers: 1 }],
      citedDomainsTotal: 2,
    })
    expect(gemini.body.weakestAnswerSources).toEqual({
      properties: 2,
      answers: 1,
      domains: [{ domain: 'listings.example', answers: 1 }, { domain: 'northstar.example', answers: 1 }],
      domainTotal: 2,
    })

    const everyEngine = await portfolio('limit=2')
    expect(everyEngine.body.weakestProperties.find(row => row.targetKey === 'harbor')).toMatchObject({
      citedDomains: [{ domain: 'listings.example', answers: 2 }, { domain: 'northstar.example', answers: 1 }],
      citedDomainsTotal: 2,
    })
  })

  it('counts the sources of answers whose text was not captured', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    // Source capture is independent of answer-text capture: both answers lost
    // their text, but their sources landed and citation coverage counts them.
    db.update(querySnapshots).set({
      answerText: null,
      citedDomains: ['northstar.example', 'listings.example'],
      citedUrls: ['https://northstar.example/locations/harbor/details', 'https://listings.example/harbor-homes'],
      recommendedCompetitors: ['Rival One'],
    }).where(and(eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'))).run()

    const { status, body } = await portfolio('limit=2')
    expect(status).toBe(200)
    const harbor = body.weakestProperties.find(row => row.targetKey === 'harbor')!
    expect(harbor.citationCoverage).toMatchObject({ state: 'available', numerator: 2, denominator: 2 })
    expect(harbor).toMatchObject({
      citedDomains: [{ domain: 'listings.example', answers: 2 }, { domain: 'northstar.example', answers: 2 }],
      citedDomainsTotal: 2,
      // Names written instead still come only from answers that have text.
      namedInsteadInAnswerText: [],
      namedInsteadInAnswerTextTotal: 0,
    })
    expect(body.weakestAnswerSources).toEqual({
      properties: 2,
      answers: 2,
      domains: [{ domain: 'listings.example', answers: 2 }, { domain: 'northstar.example', answers: 2 }],
      domainTotal: 2,
    })
  })

  it('counts a name written instead once per answer, however the answer spells it', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    db.update(querySnapshots).set({ recommendedCompetitors: ['Rival One', 'RIVAL ONE', 'Rival-One'] }).where(and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, 'openai'),
    )).run()

    const { body } = await portfolio(`runId=${runId}`)
    expect(body.weakestProperties.find(row => row.targetKey === 'harbor')).toMatchObject({
      namedInsteadInAnswerText: [{ name: 'RIVAL ONE', answers: 1 }], namedInsteadInAnswerTextTotal: 1,
      // The deprecated field counts the same way: one answer, not three spellings.
      recommendedInstead: [{ name: 'RIVAL ONE', occurrences: 1 }], recommendedInsteadTotal: 1, recommendedInsteadTruncated: false,
    })
    const replacements = await competitors(`targetKey=harbor&runId=${runId}&queryClass=non-brand`)
    expect(replacements.body.competitors).toEqual([expect.objectContaining({ occurrences: 1 })])
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

  it('returns the domains a Property\'s own answers cited, over every measured answer in the requested class', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    const slot = (execution: string, provider: string) => and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, execution), eq(querySnapshots.provider, provider),
    )
    db.update(querySnapshots).set({
      citedDomains: ['listings.example', 'rentals.example'],
      citedUrls: ['https://www.listings.example/harbor'],
    }).where(slot('exec-nearby', 'openai')).run()
    // Its text did not land, but its sources did: it still counts, as it does for citation coverage.
    db.update(querySnapshots).set({ answerText: null, citedDomains: ['listings.example'] }).where(slot('exec-nearby', 'gemini')).run()
    db.update(querySnapshots).set({ citedDomains: ['reviews.example'] }).where(slot('exec-brand', 'openai')).run()

    const nonBrand = await competitors('targetKey=harbor&queryClass=non-brand')
    expect(nonBrand.status).toBe(200)
    expect(nonBrand.body).toMatchObject({
      citedDomains: [{ domain: 'listings.example', answers: 2 }, { domain: 'rentals.example', answers: 1 }],
      citedDomainsTotal: 2,
      citedDomainsAnswers: 2,
    })
    // Names written instead still read only answers with text.
    expect(nonBrand.body.basis).toMatchObject({ state: 'available', answeredResults: 1 })

    const everyClass = await competitors('targetKey=harbor&queryClass=all&limit=1')
    expect(everyClass.body).toMatchObject({
      citedDomains: [{ domain: 'listings.example', answers: 2 }, { domain: 'rentals.example', answers: 1 }, { domain: 'reviews.example', answers: 1 }],
      citedDomainsTotal: 3,
      citedDomainsAnswers: 4,
    })

    // No answer text anywhere: no names to read, but the sources are still there.
    db.update(querySnapshots).set({ answerText: null }).where(eq(querySnapshots.runId, runId)).run()
    const textless = await competitors('targetKey=bayside&queryClass=non-brand')
    expect(textless.body.basis).toEqual({ state: 'unavailable', reason: 'evidence_incomplete' })
    expect(textless.body).toMatchObject({ citedDomainsTotal: 2, citedDomainsAnswers: 2 })

    // Nothing measured for the class: no list, rather than an empty one that reads as no sources.
    const unmeasured = await competitors('targetKey=bayside&queryClass=branded')
    expect(unmeasured.body.basis).toEqual({ state: 'unavailable', reason: 'no_population' })
    expect(unmeasured.body).not.toHaveProperty('citedDomains')
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
    expect(summary.body.weakestProperties.find(row => row.targetKey === 'harbor')?.namedInsteadInAnswerText)
      .toEqual([{ name: 'Rival One', answers: 1 }])
    expect(replacements.status).toBe(200)
    expect(replacements.body.competitors).toEqual([expect.objectContaining({
      name: 'Rival One', occurrences: 1,
    })])
  })

  it('caps names written instead per compact portfolio row and reports the omitted count', async () => {
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
    expect(bayside.namedInsteadInAnswerText).toHaveLength(5)
    expect(bayside.namedInsteadInAnswerTextTotal).toBe(7)
    expect(bayside.recommendedInstead).toEqual(bayside.namedInsteadInAnswerText.map(({ name, answers }) => ({ name, occurrences: answers })))
    expect(bayside).toMatchObject({ recommendedInsteadTotal: 7, recommendedInsteadTruncated: true })
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

  it('orders changes by the size of the move, flags moves within noise and splits every Property by how it moved', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId, { createdAt: '2026-08-02T08:00:00.000Z' })
    const current = seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })
    // Harbor goes from 0 to 4 named answers (2 non-brand, 2 branded); Bayside
    // from 0 to 2, its every answer: two answers is still within noise.
    db.update(querySnapshots).set({ answerText: 'Harbor Homes and Bayside Homes are both listed.' }).where(and(
      eq(querySnapshots.runId, current), eq(querySnapshots.measurementExecutionId, 'exec-nearby'),
    )).run()
    db.update(querySnapshots).set({ answerText: 'Harbor Homes is well reviewed.' }).where(and(
      eq(querySnapshots.runId, current), eq(querySnapshots.measurementExecutionId, 'exec-brand'),
    )).run()

    const { status, body } = await changes('limit=1')
    expect(status).toBe(200)
    expect(body.queryClass).toBe('all')
    if (body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    // Largest move first, not the alphabetical first.
    expect(body.comparison.sort).toBe('magnitude')
    expect(body.comparison.changedProperties).toEqual([expect.objectContaining({
      targetKey: 'harbor', mentionAnswersDelta: 4, citationAnswersDelta: 0, withinNoise: false,
    })])
    expect(body.comparison).toMatchObject({ totalProperties: 2, truncated: true })
    // Over every Property in scope, not the one row returned.
    expect(body.comparison.distribution).toEqual({
      improved: 1, declined: 0, mixed: 0, withinNoise: 1, unchanged: 0, notComparable: 0, total: 2, noiseAnswers: 2,
    })
    // The pooled block mixes both classes, so each class rides beside it.
    expect(body.comparison.metricsByClass?.branded.mentionCoverage).toMatchObject({
      state: 'available', previous: { numerator: 0, denominator: 2 }, current: { numerator: 2, denominator: 2 }, delta: 1,
    })
    expect(body.comparison.metricsByClass?.nonBrand.mentionCoverage).toMatchObject({
      state: 'available', previous: { numerator: 0, denominator: 2 }, current: { numerator: 2, denominator: 2 }, delta: 1,
    })

    const byLabel = await changes('sort=label')
    if (byLabel.body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    expect(byLabel.body.comparison.sort).toBe('label')
    expect(byLabel.body.comparison.changedProperties.map(row => [row.targetKey, row.mentionAnswersDelta, row.withinNoise]))
      .toEqual([['bayside', 2, true], ['harbor', 4, false]])
    expect((await changes('sort=size')).status).toBe(400)

    // One class: no per-class block, and Harbor's 2 non-brand answers are within noise too.
    const nonBrand = await changes('queryClass=non-brand')
    expect(nonBrand.body.queryClass).toBe('non-brand')
    if (nonBrand.body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    expect(nonBrand.body.comparison).not.toHaveProperty('metricsByClass')
    expect(nonBrand.body.comparison.distribution).toMatchObject({ improved: 0, withinNoise: 2, total: 2 })
  })

  it('puts a large citation-only move ahead of every mention move within noise', async () => {
    // Two more Properties share the non-brand question, so three can wobble.
    for (const [stableKey, label] of [['cedar', 'Cedar Court'], ['dune', 'Dune Lofts']] as const) {
      plan.targets.push({
        ...structuredClone(plan.targets[1]!),
        stableKey,
        label,
        aliases: [label],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: `/locations/${stableKey}`, pathCase: 'insensitive' }],
      })
      plan.assignments.push({ targetKey: stableKey, queryId: 'q-nearby', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' })
      plan.usageEdges.push({ executionNodeKey: 'exec-nearby', targetKey: stableKey, queryId: 'q-nearby' })
    }
    const versionId = seedVersion(1)
    activate(versionId)
    const previous = seedFullRun(versionId, { createdAt: '2026-08-02T08:00:00.000Z' })
    const current = seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })
    const nearby = (runId: string, provider: string) => and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, 'exec-nearby'), eq(querySnapshots.provider, provider),
    )
    // Harbor is never named, but every previous answer cited it and no current one does.
    db.update(querySnapshots).set({
      citationState: 'cited',
      citedUrls: ['https://northstar.example/locations/harbor/details'],
    }).where(eq(querySnapshots.runId, previous)).run()
    // Mention wobbles of one or two answers: Dune -2, Bayside +2, Cedar +1.
    db.update(querySnapshots).set({ answerText: 'Dune Lofts is listed.' }).where(eq(querySnapshots.measurementExecutionId, 'exec-nearby')).run()
    db.update(querySnapshots).set({ answerText: 'Bayside Homes and Cedar Court are listed.' }).where(nearby(current, 'openai')).run()
    db.update(querySnapshots).set({ answerText: 'Bayside Homes is listed.' }).where(nearby(current, 'gemini')).run()

    const { status, body } = await changes()
    expect(status).toBe(200)
    if (body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    expect(body.comparison.sort).toBe('magnitude')
    // Harbor's label sorts last and its mention count never moved, yet it leads.
    expect(body.comparison.changedProperties.map(row => [row.targetKey, row.mentionAnswersDelta, row.citationAnswersDelta, row.withinNoise]))
      .toEqual([
        ['harbor', 0, -4, false],
        ['bayside', 2, 0, true],
        ['dune', -2, 0, true],
        ['cedar', 1, 0, true],
      ])
    expect(body.comparison.distribution).toMatchObject({ declined: 1, withinNoise: 3, total: 4 })

    // The one row an agent reads first is the real loss, not a wobble.
    const first = await changes('limit=1')
    if (first.body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    expect(first.body.comparison.changedProperties.map(row => row.targetKey)).toEqual(['harbor'])
    expect(first.body.comparison).toMatchObject({ totalProperties: 4, truncated: true })
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

  it('counts an unmoved Property as unchanged in the distribution without listing it', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedFullRun(versionId, { createdAt: '2026-08-02T08:00:00.000Z' })
    const current = seedFullRun(versionId, { createdAt: '2026-08-02T09:00:00.000Z' })
    // Only the branded answers change, and only Harbor carries the branded query.
    db.update(querySnapshots).set({ answerText: 'Harbor Homes is well reviewed.' }).where(and(
      eq(querySnapshots.runId, current), eq(querySnapshots.measurementExecutionId, 'exec-brand'),
    )).run()

    const { body } = await changes()
    if (body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    expect(body.comparison.changedProperties.map(row => row.targetKey)).toEqual(['harbor'])
    expect(body.comparison.distribution).toMatchObject({ withinNoise: 1, unchanged: 1, total: 2 })
    // Non-brand did not move at all; the pooled block alone would not say which class did.
    expect(body.comparison.metricsByClass?.nonBrand.mentionCoverage).toMatchObject({ state: 'available', delta: 0 })
    expect(body.comparison.metricsByClass?.branded.mentionCoverage).toMatchObject({ state: 'available', delta: 1 })
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

  it('reports unattributed answers per question class and the newest fill of the run', async () => {
    // Cedar Court shares Harbor's questions, so an answer asking which Cedar
    // Court was meant cannot be attributed in either class it lands in.
    const cedar = { ...structuredClone(plan.targets[0]!), stableKey: 'cedar', label: 'Cedar Court', aliases: ['Cedar Court'], urlMatchers: [] }
    plan.targets.push(cedar)
    for (const assignment of plan.assignments.filter(row => row.targetKey === 'harbor')) {
      plan.assignments.push({ ...assignment, targetKey: cedar.stableKey })
      plan.usageEdges.push({ targetKey: cedar.stableKey, queryId: assignment.queryId, executionNodeKey: assignment.executionNodeKey })
    }
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedFullRun(versionId)
    const slot = (execution: string, provider: string) => and(
      eq(querySnapshots.runId, runId), eq(querySnapshots.measurementExecutionId, execution), eq(querySnapshots.provider, provider),
    )
    db.update(querySnapshots).set({ answerText: `Which ${cedar.label} do you mean?` }).where(slot('exec-brand', 'openai')).run()
    db.update(querySnapshots).set({ answerText: 'Harbor Homes is well reviewed.' }).where(slot('exec-brand', 'gemini')).run()

    const before = await quality()
    expect(before.status).toBe(200)
    expect(before.body.unattributedByClass).toEqual({
      branded: { state: 'available', answered: 2, unattributed: 1 },
      nonBrand: { state: 'available', answered: 2, unattributed: 0 },
    })
    expect(before.body.latestFill).toBeNull()

    // Every branded answer unattributed: the class's rate is withheld, but the count is not.
    db.update(querySnapshots).set({ answerText: `Which ${cedar.label} do you mean?` }).where(slot('exec-brand', 'gemini')).run()
    for (const [id, createdAt, status, filled] of [['fill-old', '2026-08-02T12:10:00.000Z', 'failed', 0], ['fill-new', '2026-08-02T12:30:00.000Z', 'completed', 1]] as const) {
      db.insert(runFills).values({
        id, projectId, runId, status, providers: '["gemini"]', expected: 1, filled,
        createdAt, startedAt: createdAt, finishedAt: createdAt,
      }).run()
    }
    const after = await quality()
    expect(after.body.unattributedByClass?.branded).toEqual({ state: 'available', answered: 2, unattributed: 2 })
    expect(after.body.latestFill).toEqual({
      status: 'completed', providers: ['gemini'], expected: 1, filled: 1,
      createdAt: '2026-08-02T12:30:00.000Z', finishedAt: '2026-08-02T12:30:00.000Z',
    })
  })

  it('withholds a class it cannot count and keeps the fill readable when the answers are not', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    // A spot check of the non-brand question only: nothing branded was asked.
    const runId = seedRun(versionId, {
      measurementScope: { groups: [], targets: [], queries: ['q-nearby'], resolvedTargets: [] },
      measurementManifest: manifestFor(['exec-nearby']),
    })
    for (const provider of ['openai', 'gemini']) seedSnapshot(runId, 'exec-nearby', provider)
    const scoped = await quality(`runId=${runId}`)
    expect(scoped.body.unattributedByClass).toEqual({
      branded: { state: 'unavailable', reason: 'no_population' },
      nonBrand: { state: 'available', answered: 2, unattributed: 0 },
    })

    // Two stored results for one slot: nothing about the answers can be trusted.
    const broken = seedRun(versionId, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      measurementManifest: manifestFor(['exec-nearby']),
    })
    seedSnapshot(broken, 'exec-nearby', 'openai')
    seedSnapshot(broken, 'exec-nearby', 'OpenAI')
    db.insert(runFills).values({
      id: 'fill-1', projectId, runId: broken, status: 'partial', providers: '["gemini"]', expected: 1, filled: 0,
      createdAt: NOW, startedAt: NOW, finishedAt: null,
    }).run()
    const inspected = await quality(`runId=${broken}`)
    expect(inspected.body.unattributedByClass).toEqual({
      branded: { state: 'unavailable', reason: 'evidence_incomplete' },
      nonBrand: { state: 'unavailable', reason: 'evidence_incomplete' },
    })
    expect(inspected.body.latestFill).toMatchObject({ status: 'partial', expected: 1, filled: 0, finishedAt: null })

    activate(seedVersion(2))
    const unmeasured = await quality()
    expect(unmeasured.body).toMatchObject({
      unattributedByClass: {
        branded: { state: 'unavailable', reason: 'no_completed_run' },
        nonBrand: { state: 'unavailable', reason: 'no_completed_run' },
      },
      latestFill: null,
    })
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
  ) => ({ groupKey, label, parentGroupKey: null, childMarketCount: 0, propertyCount: 1, propertiesMentioned: rate(1, 1, 1), mentionCoverage, citationCoverage })
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

describe('classifyPropertyMove', () => {
  const answers = (numerator: number, denominator = 10) =>
    ({ state: 'available' as const, value: numerator / denominator, numerator, denominator })
  const gone = { state: 'unavailable' as const, reason: 'evidence_incomplete' as const }
  const move = (mention: [typeof gone | ReturnType<typeof answers>, typeof gone | ReturnType<typeof answers>], citation: [typeof gone | ReturnType<typeof answers>, typeof gone | ReturnType<typeof answers>]) =>
    classifyPropertyMove({ previous: mention[0], current: mention[1] }, { previous: citation[0], current: citation[1] })

  it('sizes moves in answers and holds two answers each way within noise', () => {
    expect(move([answers(4), answers(6)], [answers(3), answers(1)])).toMatchObject({
      mentionAnswersDelta: 2, citationAnswersDelta: -2, withinNoise: true, bucket: 'withinNoise', mentionSize: 2, citationSize: 2,
    })
    expect(move([answers(4), answers(7)], [answers(3), answers(3)])).toMatchObject({ withinNoise: false, bucket: 'improved', mentionSize: 3 })
  })

  it('calls a move beyond noise improved, declined or mixed by the signals that moved beyond noise', () => {
    expect(move([answers(7), answers(4)], [answers(3), answers(2)]).bucket).toBe('declined')
    // Three more named, one fewer cited: the citation wobble is noise, so a gain.
    expect(move([answers(1), answers(4)], [answers(3), answers(2)])).toMatchObject({ withinNoise: false, bucket: 'improved' })
    // Three fewer named, two more cited: two answers is still noise, so a loss.
    expect(move([answers(7), answers(4)], [answers(1), answers(3)]).bucket).toBe('declined')
    // Three more named, three fewer cited: both beyond noise, neither a gain nor a loss.
    expect(move([answers(1), answers(4)], [answers(5), answers(2)]).bucket).toBe('mixed')
    expect(move([answers(5), answers(5)], [answers(0), answers(5)]).bucket).toBe('improved')
  })

  it('never sizes a signal measured in one run only', () => {
    expect(move([answers(2), gone], [answers(3), answers(3)])).toMatchObject({
      mentionAnswersDelta: null, citationAnswersDelta: 0, withinNoise: false, bucket: 'notComparable', mentionSize: -1,
    })
  })

  it('treats a signal unmeasured in both runs as unmoved rather than unknown', () => {
    expect(move([answers(2), answers(3)], [gone, gone])).toMatchObject({
      mentionAnswersDelta: 1, citationAnswersDelta: null, withinNoise: true, bucket: 'withinNoise', citationSize: 0,
    })
    expect(move([answers(2), answers(2)], [gone, gone])).toMatchObject({ withinNoise: false, bucket: 'unchanged' })
  })
})

describe('compareChangeMagnitude', () => {
  const row = (targetKey: string, mentionSize: number, citationSize: number, withinNoise: boolean) =>
    ({ row: { targetKey, label: targetKey }, move: { withinNoise, mentionSize, citationSize } })
  const order = (...rows: ReturnType<typeof row>[]) =>
    [...rows].sort(compareChangeMagnitude).map(entry => entry.row.targetKey)

  it('leads with every move beyond noise, sized by its larger signal whichever it is', () => {
    expect(order(
      row('a-wobble', 2, 2, true),
      row('b-wobble', 0, 2, true),
      row('c-wobble', 1, 0, true),
      row('m-named', 3, 0, false),
      row('n-both', 3, 3, false),
      row('p-cited', 0, 3, false),
      row('z-cited', 0, 25, false),
    )).toEqual(['z-cited', 'n-both', 'm-named', 'p-cited', 'a-wobble', 'b-wobble', 'c-wobble'])
  })

  it('ranks a signal measured in one run only by the other signal, ahead of every row within noise', () => {
    expect(order(
      row('a-wobble', 2, 1, true),
      row('b-unsized', -1, 0, false),
      row('c-unsized', 4, -1, false),
      row('d-named', 3, 0, false),
    )).toEqual(['c-unsized', 'd-named', 'b-unsized', 'a-wobble'])
  })
})
