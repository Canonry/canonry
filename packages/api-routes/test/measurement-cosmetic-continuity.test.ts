/**
 * Cosmetic-publish continuity.
 *
 * Every measurement read pins to the active plan version row, and a publish
 * mints a new row for ANY compiled-checksum change — labels included. Before
 * the `comparable_to_version_id` link, renaming a group therefore blanked the
 * whole dashboard until the next full sweep. These tests prove the link keeps
 * the previous run's ACTUAL NUMBERS on the overview, the portfolio summary and
 * period-over-period, while an execution-changing publish still blanks.
 */

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
  type MeasurementOverviewResponse,
  type MeasurementPlanV2,
  type MeasurementPortfolioSummaryResponse,
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
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-08-02T12:00:00.000Z'
const IDENTITY = buildMeasurementExecutionIdentity({
  providers: ['openai', 'gemini'],
  models: { openai: 'gpt-measurement', gemini: 'gemini-measurement' },
}, 'a'.repeat(64))

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string
let plan: MeasurementPlanV2

/** The identical plan content re-published under a renamed group: a cosmetic revision. */
function renamedPlan(): MeasurementPlanV2 {
  const renamed = measurementPlanV2Fixture()
  renamed.groups[0]!.label = 'Regional comparison (renamed)'
  return renamed
}

function seedVersion(
  revision: number,
  doc: MeasurementPlanV2 = plan,
  comparableToVersionId: string | null = null,
): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(doc),
    checksum: crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'),
    schemaVersion: 2,
    compiledChecksum: doc.compiledChecksum,
    comparableToVersionId,
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

function seedRun(versionId: string, values: Partial<typeof runs.$inferInsert> = {}): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: buildMeasurementPlanV2Manifest(plan),
    measurementExecutionIdentity: IDENTITY,
    finishedAt: NOW,
    createdAt: NOW,
    ...values,
  }).run()
  return id
}

function seedSnapshot(runId: string, executionKey: string, provider: string): void {
  const node = plan.executionNodes.find(candidate => candidate.stableKey === executionKey)!
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
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
  }).run()
}

/** A completed full sweep where Harbor is mentioned and cited on its Non-brand question only. */
function seedMeasuredRun(versionId: string, values: Partial<typeof runs.$inferInsert> = {}): string {
  const runId = seedRun(versionId, values)
  for (const provider of ['openai', 'gemini']) {
    seedSnapshot(runId, 'exec-nearby', provider)
    seedSnapshot(runId, 'exec-brand', provider)
  }
  db.update(querySnapshots).set({
    answerText: 'Harbor Homes is a strong option.',
    citationState: 'cited',
    citedUrls: ['https://northstar.example/locations/harbor/details'],
  }).where(and(
    eq(querySnapshots.runId, runId),
    eq(querySnapshots.measurementExecutionId, 'exec-nearby'),
  )).run()
  return runId
}

async function overview(query: string): Promise<{ status: number; body: MeasurementOverviewResponse }> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/projects/northstar/measurement-overview?${query}` })
  return { status: response.statusCode, body: response.json() as MeasurementOverviewResponse }
}

async function portfolio(query = ''): Promise<{ status: number; body: MeasurementPortfolioSummaryResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-portfolio-summary${query === '' ? '' : `?${query}`}`,
  })
  return { status: response.statusCode, body: response.json() as MeasurementPortfolioSummaryResponse }
}

async function changes(query = ''): Promise<{ status: number; body: MeasurementChangesResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-changes${query === '' ? '' : `?${query}`}`,
  })
  return { status: response.statusCode, body: response.json() as MeasurementChangesResponse }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-cosmetic-continuity-'))
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

describe('cosmetic-publish continuity', () => {
  it('keeps serving the prior run and its exact numbers after a label-only republish', async () => {
    const versionOne = seedVersion(1)
    const measured = seedMeasuredRun(versionOne)
    activate(seedVersion(2, renamedPlan(), versionOne))

    const all = await overview('scope=all')
    expect(all.status).toBe(200)
    expect(all.body.measurement).toMatchObject({ state: 'complete', displayedRunId: measured })
    // A scoped Property is named and cited on the 2 exec-nearby slots and on
    // neither exec-brand slot, so coverage is 2 of the 4 distinct expected
    // slots — the numbers the run earned under revision 1.
    expect(all.body.metrics.mentionCoverage).toMatchObject({
      state: 'available', value: 2 / 4, numerator: 2, denominator: 4,
    })
    expect(all.body.metrics.citationCoverage).toMatchObject({
      state: 'available', value: 2 / 4, numerator: 2, denominator: 4,
    })
    expect(all.body.metrics.propertiesMentioned).toMatchObject({
      state: 'available', value: 1, numerator: 1, denominator: 2,
    })

    // The revision that is displayed stays the ACTIVE one, renamed label and
    // all: continuity serves the old evidence, never the old labels.
    const group = await overview('scope=group&groupKey=regional')
    expect(group.status).toBe(200)
    expect(group.body.scope).toMatchObject({ label: 'Regional comparison (renamed)' })
    expect(group.body.measurement).toMatchObject({ state: 'complete', displayedRunId: measured })

    const summary = await portfolio()
    expect(summary.status).toBe(200)
    // planRevision reports the active revision the plan content comes from;
    // displayedRunId names the actual (prior-revision) run — nothing is faked.
    expect(summary.body.measurement).toMatchObject({
      state: 'complete', displayedRunId: measured, planRevision: 2,
    })
    // Default class is non-brand: the 2 shared exec-nearby slots, both of
    // which name and cite Harbor.
    expect(summary.body.metrics.mentionCoverage).toMatchObject({
      state: 'available', value: 1, numerator: 2, denominator: 2,
    })
    expect(summary.body.metrics.citationCoverage).toMatchObject({
      state: 'available', value: 1, numerator: 2, denominator: 2,
    })
    const harbor = summary.body.weakestProperties.find(row => row.targetKey === 'harbor')
    expect(harbor?.mentionCoverage).toMatchObject({ state: 'available', value: 1, numerator: 2, denominator: 2 })

    // The property drill-down uses the same server-authoritative predecessor
    // chain as the overview. It must not ask a browser to compare version IDs.
    const evidence = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-property-evidence?targetKey=harbor&queryClass=non-brand&runId=${measured}`,
    })
    expect(evidence.statusCode).toBe(200)
    expect(evidence.json()).toMatchObject({
      property: { targetKey: 'harbor' },
      measurement: { state: 'complete', displayedRunId: measured },
    })
  })

  it('keeps measurement-setup out of awaiting_first_run after a cosmetic republish', async () => {
    const versionOne = seedVersion(1)
    seedMeasuredRun(versionOne)
    activate(seedVersion(2, renamedPlan(), versionOne))

    const setup = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/measurement-setup' })
    expect(setup.statusCode).toBe(200)
    const body = setup.json()
    // The overview keeps serving the prior run; setup must agree rather than
    // demanding a first run that already happened.
    expect(body.state).not.toBe('awaiting_first_run')
    expect(body.nextAction).not.toBe('run_measurement')
  })

  it('revision-addressed reports never borrow a predecessor run through the chain', async () => {
    const versionOne = seedVersion(1)
    const measured = seedMeasuredRun(versionOne)
    activate(seedVersion(2, renamedPlan(), versionOne))

    // The explicit --revision surface promises the revision AS-WAS. Revision 2
    // has no run of its own, and the comparable chain must not lend it one.
    const rev2 = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/measurement-report?revision=2' })
    expect(rev2.statusCode).toBe(200)
    expect(rev2.json().run).toBeNull()

    // An explicit predecessor run is not a request to widen an exact,
    // revision-addressed historical report. This is deliberately 404 rather
    // than silently presenting revision 1 evidence as revision 2.
    const incompatibleRun = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-report?revision=2&runId=${measured}`,
    })
    expect(incompatibleRun.statusCode).toBe(404)

    // Revision 1 still reports its own run, exactly as measured.
    const rev1 = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/measurement-report?revision=1' })
    expect(rev1.statusCode).toBe(200)
    expect(rev1.json().run).not.toBeNull()
  })

  it('still blanks after an execution-changing publish', async () => {
    const versionOne = seedVersion(1)
    seedMeasuredRun(versionOne)
    // No comparability link: publish decided the execution surface changed.
    activate(seedVersion(2, renamedPlan(), null))

    const { status, body } = await overview('scope=all')
    expect(status).toBe(200)
    expect(body.measurement.state).toBe('not_measured')
    expect(body.metrics.mentionCoverage).toEqual({ state: 'unavailable', reason: 'no_completed_run' })

    const summary = await portfolio()
    expect(summary.body.measurement).toMatchObject({ state: 'not_measured', displayedRunId: null })
    expect(summary.body.metrics.mentionCoverage).toEqual({ state: 'unavailable', reason: 'no_completed_run' })
  })

  it('follows the comparable chain across two consecutive cosmetic publishes', async () => {
    const versionOne = seedVersion(1)
    const measured = seedMeasuredRun(versionOne)
    const versionTwo = seedVersion(2, renamedPlan(), versionOne)
    activate(seedVersion(3, renamedPlan(), versionTwo))

    const { status, body } = await overview('scope=all')
    expect(status).toBe(200)
    expect(body.measurement).toMatchObject({ state: 'complete', displayedRunId: measured })
    expect(body.metrics.mentionCoverage).toMatchObject({
      state: 'available', value: 2 / 4, numerator: 2, denominator: 4,
    })

    // Naming the served run explicitly (a drill-down) is continuity too.
    const named = await portfolio(`runId=${measured}`)
    expect(named.status).toBe(200)
    expect(named.body.measurement).toMatchObject({ displayedRunId: measured, planRevision: 3 })
  })

  it('prefers a newer run on the active revision over the comparable predecessor', async () => {
    const versionOne = seedVersion(1)
    seedMeasuredRun(versionOne, { createdAt: '2026-08-02T08:00:00.000Z' })
    const versionTwo = seedVersion(2, renamedPlan(), versionOne)
    activate(versionTwo)
    const fresh = seedMeasuredRun(versionTwo, { createdAt: '2026-08-02T09:00:00.000Z' })

    const { body } = await overview('scope=all')
    expect(body.measurement).toMatchObject({ state: 'complete', displayedRunId: fresh })
  })

  it('keeps period-over-period comparison alive across a cosmetic publish', async () => {
    const versionOne = seedVersion(1)
    const previous = seedMeasuredRun(versionOne, { createdAt: '2026-08-02T08:00:00.000Z' })
    const current = seedMeasuredRun(versionOne, { createdAt: '2026-08-02T09:00:00.000Z' })
    db.update(querySnapshots).set({
      answerText: 'Harbor Homes and Bayside Homes are strong options.',
      citationState: 'cited',
      citedUrls: [
        'https://northstar.example/locations/harbor/details',
        'https://northstar.example/locations/bayside/details',
      ],
    }).where(eq(querySnapshots.runId, current)).run()
    activate(seedVersion(2, renamedPlan(), versionOne))

    const { status, body } = await changes('limit=2')
    expect(status).toBe(200)
    expect(body.current).toMatchObject({ displayedRunId: current, planRevision: 2 })
    expect(body.comparison).toMatchObject({
      state: 'available', previous: { displayedRunId: previous, planRevision: 2 },
    })
    if (body.comparison.state !== 'available') throw new Error('Expected a comparable measurement run.')
    // Every slot now mentions and cites both Properties, up from Harbor's
    // Non-brand-only presence: slot coverage moves 2/4 -> 4/4.
    expect(body.comparison.metrics.mentionCoverage).toMatchObject({
      state: 'available',
      previous: { value: 2 / 4 },
      current: { value: 1 },
      delta: 1 - 2 / 4,
    })
    expect(body.comparison.metrics.citationCoverage).toMatchObject({
      state: 'available',
      previous: { value: 2 / 4 },
      current: { value: 1 },
      delta: 1 - 2 / 4,
    })
  })

  it('never bridges through a version outside the comparable chain', async () => {
    // v1 <- comparable v2, but v3 breaks the chain (execution changed), and a
    // later v4 is comparable only to v3. Runs on v1/v2 must not leak into v4.
    const versionOne = seedVersion(1)
    seedMeasuredRun(versionOne)
    const versionTwo = seedVersion(2, renamedPlan(), versionOne)
    seedMeasuredRun(versionTwo)
    const versionThree = seedVersion(3, renamedPlan(), null)
    activate(seedVersion(4, renamedPlan(), versionThree))

    const { body } = await overview('scope=all')
    expect(body.measurement.state).toBe('not_measured')
    expect(body.metrics.mentionCoverage).toEqual({ state: 'unavailable', reason: 'no_completed_run' })
  })
})
