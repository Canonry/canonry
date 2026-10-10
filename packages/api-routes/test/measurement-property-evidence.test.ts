import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
  type MeasurementPropertyEvidenceResponse,
  type MeasurementReportResponse,
  type MeasurementPlanV2,
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

const NOW = '2026-08-01T12:00:00.000Z'

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
): void {
  const node = plan.executionNodes.find(candidate => candidate.stableKey === executionKey)!
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId: null,
    queryText: node.queryText,
    provider,
    citationState: 'cited',
    answerMentioned: true,
    answerText: 'Northstar Harbor Homes and Challenger both come up.',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    measurementExecutionId: executionKey,
    requestedContext: node.context.location,
    supportedContext: { status: 'applied', resolved: node.context.location },
    location: node.context.location?.label ?? null,
    citedUrls: ['https://northstar.example/locations/harbor/details'],
    captureStatus: 'complete',
    createdAt: NOW,
    ...values,
  }).run()
}

/**
 * A completed sweep whose Branded answers cite a second Harbor URL, so a
 * Branded page has more than one row per engine and the cursor has something
 * to page through.
 */
function seedMeasuredRun(versionId: string): string {
  const runId = seedRun(versionId)
  for (const provider of ['openai', 'gemini']) {
    seedSnapshot(runId, 'exec-nearby', provider)
    seedSnapshot(runId, 'exec-brand', provider, {
      answerText: 'Northstar is well reviewed.',
      citedUrls: [
        'https://northstar.example/locations/harbor/details',
        'https://northstar.example/locations/harbor/reviews',
      ],
    })
  }
  return runId
}

async function evidence(query: string): Promise<{ status: number; body: MeasurementPropertyEvidenceResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-property-evidence?${query}`,
  })
  return { status: response.statusCode, body: response.json() as MeasurementPropertyEvidenceResponse }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-property-evidence-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'current.example',
    ownedDomains: ['current-owned.example'],
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

describe('measurement property evidence', () => {
  it('answers 404 until a plan is active', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northstar/measurement-property-evidence?targetKey=harbor',
    })
    expect(response.statusCode).toBe(404)
  })

  it('refuses a Property that is not in the active revision', async () => {
    activate(seedVersion(1))

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northstar/measurement-property-evidence?targetKey=missing',
    })
    expect(response.statusCode).toBe(400)
  })

  it('reports an unmeasured Property as not measured rather than as an empty result', async () => {
    activate(seedVersion(1))

    const { status, body } = await evidence('targetKey=harbor')

    expect(status).toBe(200)
    expect(body.measurement.state).toBe('not_measured')
    expect(body.measurement.displayedRunId).toBeUndefined()
    expect(body.evidence).toEqual({ items: [], nextCursor: null, totalEstimate: 0 })
    expect(body.property).toEqual({ targetKey: 'harbor', label: 'Harbor Homes' })
  })

  it('returns only the named Property\'s rows, narrowed to one question class', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedMeasuredRun(versionId)

    const branded = await evidence('targetKey=harbor&queryClass=branded')
    const nonBrand = await evidence('targetKey=harbor&queryClass=non-brand')

    expect(branded.body.measurement).toMatchObject({ state: 'complete', displayedRunId: runId })
    expect(branded.body.queryClass).toBe('branded')
    // Two engines x two cited URLs on the Branded execution, and nothing from
    // the Non-brand one.
    expect(branded.body.evidence.items).toHaveLength(4)
    expect(new Set(branded.body.evidence.items.map(row => row.queryText))).toEqual(new Set(['northstar reviews']))
    expect(branded.body.evidence.items.every(row => row.classification === 'assigned')).toBe(true)

    expect(nonBrand.body.evidence.items).toHaveLength(2)
    expect(new Set(nonBrand.body.evidence.items.map(row => row.queryText))).toEqual(new Set(['homes near harbor']))
  })

  it('scopes rows to the Property\'s own usage edges, not to whoever the URL matched', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const bayside = await evidence('targetKey=bayside')

    // Bayside shares the Non-brand execution with Harbor but the cited URL is
    // Harbor's, so its own rows exist and are classified sibling. Returning
    // Harbor's assigned rows here would credit Bayside with Harbor's coverage.
    expect(bayside.body.evidence.items).toHaveLength(2)
    expect(bayside.body.evidence.items.every(row => row.classification === 'sibling')).toBe(true)
    expect(bayside.body.evidence.items.every(row => row.usageEdgeId.includes('bayside'))).toBe(true)
  })

  it('narrows rows by provider and location', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const byProvider = await evidence('targetKey=harbor&provider=openai')
    expect(byProvider.body.evidence.items.every(row => row.provider === 'openai')).toBe(true)
    expect(byProvider.body.evidence.items).toHaveLength(3)

    const byLocation = await evidence('targetKey=harbor&location=harbor')
    expect(byLocation.body.evidence.items).toHaveLength(6)

    const elsewhere = await evidence('targetKey=harbor&location=nowhere')
    expect(elsewhere.body.evidence.items).toHaveLength(0)
    expect(elsewhere.body.measurement.state).toBe('complete')
  })

  it('pages deterministically through an opaque cursor', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const first = await evidence('targetKey=harbor&queryClass=branded&limit=3')
    expect(first.body.evidence.items).toHaveLength(3)
    expect(first.body.evidence.totalEstimate).toBe(4)
    expect(first.body.evidence.nextCursor).toEqual(expect.any(String))

    const second = await evidence(
      `targetKey=harbor&queryClass=branded&limit=3&cursor=${encodeURIComponent(first.body.evidence.nextCursor!)}`,
    )
    expect(second.body.evidence.items).toHaveLength(1)
    expect(second.body.evidence.nextCursor).toBeNull()

    const keyOf = (row: { expectedSlotId: string; usageEdgeId: string; sourceUrl: string }) =>
      [row.expectedSlotId, row.usageEdgeId, row.sourceUrl].join(' ')
    const paged = [...first.body.evidence.items, ...second.body.evidence.items].map(keyOf)
    expect(new Set(paged).size).toBe(4)
  })

  it('refuses a cursor whose filters or evidence moved underneath it', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedMeasuredRun(versionId)

    const first = await evidence('targetKey=harbor&queryClass=branded&limit=1')
    const cursor = encodeURIComponent(first.body.evidence.nextCursor!)

    const changedFilters = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-property-evidence?targetKey=harbor&queryClass=non-brand&limit=1&cursor=${cursor}`,
    })
    expect(changedFilters.statusCode).toBe(400)

    db.update(querySnapshots)
      .set({ answerText: 'Northstar now names Bayside Homes as well.' })
      .where(eq(querySnapshots.runId, runId))
      .run()
    const changedEvidence = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-property-evidence?targetKey=harbor&queryClass=branded&limit=1&cursor=${cursor}`,
    })
    expect(changedEvidence.statusCode).toBe(400)
    expect(changedEvidence.json()).toMatchObject({
      error: { message: 'The measurement property evidence changed between pages.' },
    })
  })

  it('refuses a run pinned to another revision rather than joining across them', async () => {
    const older = seedVersion(1)
    const active = seedVersion(2)
    activate(active)
    const olderRun = seedRun(older)
    seedMeasuredRun(active)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-property-evidence?targetKey=harbor&runId=${olderRun}`,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error: { code: 'MEASUREMENT_RUN_REVISION_MISMATCH', details: { runRevision: 1, activeRevision: 2 } },
    })
  })

  it('agrees exactly with the whole-revision report narrowed to the same Property', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedMeasuredRun(versionId)

    const scoped = await evidence('targetKey=harbor&limit=100')
    const reportResponse = await app.inject({
      method: 'GET',
      // Both reads over every class: Property evidence pools them by default.
      url: `/api/v1/projects/northstar/measurement-report?revision=1&runId=${runId}&queryClass=all`,
    })
    const report = reportResponse.json() as MeasurementReportResponse

    // The scoped read must be a filter over the same rows, never a second
    // computation that can drift from the report.
    const expected = report.evidence.filter(row => row.usageEdgeId.startsWith('target:harbor:'))
    expect(scoped.body.evidence.items).toEqual(expected)
    expect(expected.length).toBeGreaterThan(0)
  })

  it('refuses a schema v1 revision instead of inventing a question class for it', async () => {
    const v1 = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{
        stableKey: 'harbor',
        label: 'Harbor Homes',
        urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }],
        aliases: ['Harbor Homes'],
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-nearby'] }],
    }, {
      canonicalDomain: 'northstar.example',
      ownedDomains: [],
      brandNames: ['Northstar'],
      trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }],
      locations: [],
      defaultContext: null,
      expectedSnapshots: 1,
    })
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: versionId,
      projectId,
      revision: 1,
      canonicalJson: canonicalMeasurementPlanJson(v1),
      checksum: 'a'.repeat(64),
      createdAt: NOW,
    }).run()
    activate(versionId)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northstar/measurement-property-evidence?targetKey=harbor',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('schema v1') as unknown as string },
    })
  })
})
