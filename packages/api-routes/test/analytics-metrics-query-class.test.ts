import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, queryBasketVersions, querySnapshots, runs,
} from '@canonry/canonry-db'
import { brandMetricsDtoSchema, canonicalMeasurementPlanV2Json, type BrandMetricsDto } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

/**
 * `?queryClass=` on the trend: a branded query added mid-history must not move
 * the non-brand line, and the branded line must not borrow the non-brand past.
 * Shaped like the case that prompted it: two non-brand queries tracked from the
 * start, one branded query added before the latest sweep.
 */

const DAY0 = '2026-05-01T00:00:00.000Z'
const DAY20 = '2026-05-21T00:00:00.000Z'
const SWEEP1 = '2026-05-02T12:00:00.000Z'
const SWEEP2 = '2026-05-22T12:00:00.000Z'

const NON_BRAND_A = 'apartments near the waterfront'
const NON_BRAND_B = 'best waterfront rentals'
const BRANDED = 'harbor homes reviews'

describe('GET /projects/:name/analytics/metrics?queryClass=', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  async function metrics(query: string, project = 'harbor-homes'): Promise<{ status: number; body: BrandMetricsDto | { error: { message: string } } }> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/analytics/metrics${query}` })
    const json = JSON.parse(res.payload)
    return { status: res.statusCode, body: res.statusCode === 200 ? brandMetricsDtoSchema.parse(json) : json }
  }

  async function ok(query: string): Promise<BrandMetricsDto> {
    const { status, body } = await metrics(query)
    expect(status).toBe(200)
    return body as BrandMetricsDto
  }

  function seedProject(name: string, identity: { displayName: string; canonicalDomain: string }): string {
    const id = crypto.randomUUID()
    db.insert(projects).values({
      id, name, ...identity, ownedDomains: [], country: 'US', language: 'en', tags: [], labels: {},
      providers: ['gemini'], locations: [], defaultLocation: null, configSource: 'api', configRevision: 1,
      createdAt: DAY0, updatedAt: DAY0,
    }).run()
    return id
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-metrics-class-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()

    const projectId = seedProject('harbor-homes', { displayName: 'Harbor Homes', canonicalDomain: 'harborhomes.example' })
    const qA = crypto.randomUUID()
    const qB = crypto.randomUUID()
    const qBranded = crypto.randomUUID()
    db.insert(queries).values([
      { id: qA, projectId, query: NON_BRAND_A, createdAt: DAY0 },
      { id: qB, projectId, query: NON_BRAND_B, createdAt: DAY0 },
      { id: qBranded, projectId, query: BRANDED, createdAt: DAY20 },
    ]).run()
    db.insert(queryBasketVersions).values([
      { projectId, revision: 1, membersJson: JSON.stringify([NON_BRAND_A, NON_BRAND_B]), checksum: 'a'.repeat(64), createdAt: DAY0 },
      { projectId, revision: 2, membersJson: JSON.stringify([NON_BRAND_A, NON_BRAND_B, BRANDED]), checksum: 'b'.repeat(64), createdAt: DAY20 },
    ]).run()
    const run1 = crypto.randomUUID()
    const run2 = crypto.randomUUID()
    db.insert(runs).values([
      { id: run1, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: null, createdAt: SWEEP1, queryBasketRevision: 1 },
      { id: run2, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: null, createdAt: SWEEP2, queryBasketRevision: 2 },
    ]).run()
    const snapshot = (runId: string, queryId: string, mentioned: boolean, cited: boolean, at: string) => ({
      id: crypto.randomUUID(), runId, queryId, provider: 'gemini', model: 'gemini-3.5-flash',
      citationState: cited ? 'cited' : 'not-cited',
      answerMentioned: mentioned,
      answerText: mentioned ? 'Harbor Homes is a strong pick.' : 'Try Listings Co instead.',
      citedDomains: cited ? ['harborhomes.example'] : [], competitorOverlap: [], location: null, rawResponse: '{}', createdAt: at,
    })
    db.insert(querySnapshots).values([
      // Sweep 1: non-brand 1 of 2 mentioned, 1 of 2 cited.
      snapshot(run1, qA, true, true, SWEEP1),
      snapshot(run1, qB, false, false, SWEEP1),
      // Sweep 2: non-brand 0 of 2; the new branded query mentioned and cited.
      snapshot(run2, qA, false, false, SWEEP2),
      snapshot(run2, qB, false, false, SWEEP2),
      snapshot(run2, qBranded, true, true, SWEEP2),
    ]).run()

    seedProject('no-brand', { displayName: '', canonicalDomain: '' })
    const planProjectId = seedProject('planned-homes', { displayName: 'Planned Homes', canonicalDomain: 'plannedhomes.example' })
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: versionId, projectId: planProjectId, revision: 1, schemaVersion: 2,
      canonicalJson: canonicalMeasurementPlanV2Json(measurementPlanV2Fixture()), checksum: 'c'.repeat(64), createdAt: DAY0,
    }).run()
    db.insert(measurementPlans).values({ projectId: planProjectId, activeVersionId: versionId, createdAt: DAY0, updatedAt: DAY0 }).run()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('pools both classes without queryClass, as before, and says so', async () => {
    const body = await ok('')
    expect(body.queryClass).toBe('all')
    expect(body.buckets.map(b => [b.mentionedCount, b.total, b.mentionRate, b.queryCount])).toEqual([
      [1, 2, 0.5, 2],
      [1, 3, 0.3333, 3],
    ])
    expect(body.overall).toMatchObject({ mentionedCount: 2, total: 5, cited: 2 })
    expect(body.basketChanges.map(c => [c.added, c.removed])).toEqual([[[BRANDED], []]])
    expect(body.queryChanges.map(c => c.delta)).toEqual([1])
    expect(await ok('?queryClass=all')).toEqual(body)
  })

  it('reads non-brand answers only: the branded add moves neither the line nor the query set', async () => {
    const body = await ok('?queryClass=non-brand')
    expect(body.queryClass).toBe('non-brand')
    expect(body.buckets.map(b => [b.mentionedCount, b.total, b.mentionRate, b.cited, b.citationRate, b.queryCount])).toEqual([
      [1, 2, 0.5, 1, 0.5, 2],
      [0, 2, 0, 0, 0, 2],
    ])
    expect(body.overall).toEqual({ citationRate: 0.25, cited: 1, total: 4, mentionRate: 0.25, mentionedCount: 1 })
    expect(body.windowChange.mentionRate).toEqual({ first: 0.5, latest: 0, delta: -0.5 })
    expect(body.basketChanges).toEqual([])
    expect(body.queryChanges).toEqual([])
  })

  it('reads branded answers only, on the same bucket dates as the pooled trend', async () => {
    const [pooled, body] = await Promise.all([ok(''), ok('?queryClass=branded')])
    expect(body.queryClass).toBe('branded')
    expect(body.buckets.map(b => [b.startDate, b.mentionedCount, b.total, b.mentionRate, b.queryCount])).toEqual([
      [pooled.buckets[1]!.startDate, 1, 1, 1, 1],
    ])
    expect(body.overall).toEqual({ citationRate: 1, cited: 1, total: 1, mentionRate: 1, mentionedCount: 1 })
    // One point has no first-to-latest change.
    expect(body.windowChange.mentionRate).toBeNull()
    expect(body.basketChanges.map(c => [c.added, c.removed])).toEqual([[[BRANDED], []]])
    // The branded query's creation day is its class's baseline, not a change.
    expect(body.queryChanges).toEqual([])
  })

  it('splits the pooled counts exactly, with nothing dropped or counted twice', async () => {
    const [pooled, nonBrand, branded] = await Promise.all([ok(''), ok('?queryClass=non-brand'), ok('?queryClass=branded')])
    expect(nonBrand.overall.total + branded.overall.total).toBe(pooled.overall.total)
    expect(nonBrand.overall.mentionedCount + branded.overall.mentionedCount).toBe(pooled.overall.mentionedCount)
    expect(nonBrand.overall.cited + branded.overall.cited).toBe(pooled.overall.cited)
  })

  it('rejects an unknown class', async () => {
    const { status } = await metrics('?queryClass=brand')
    expect(status).toBe(400)
  })

  it('refuses a class split on a project with no brand name to classify with', async () => {
    const { status, body } = await metrics('?queryClass=non-brand', 'no-brand')
    expect(status).toBe(400)
    expect((body as { error: { message: string } }).error.message).toContain('needs a brand name or alias')
    expect((await metrics('', 'no-brand')).status).toBe(200)
  })

  it('refuses a class split on a published v2 plan, whose classes live on its assignments', async () => {
    const { status, body } = await metrics('?queryClass=branded', 'planned-homes')
    expect(status).toBe(400)
    expect((body as { error: { message: string } }).error.message).toContain('visibility-report')
    expect((await metrics('', 'planned-homes')).status).toBe(200)
  })
})
