import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createClient, migrate, projects, runs,
  gscSearchData, gscQueryDailyTotals, gscDailyTotals,
} from '@ainyc/canonry-db'
import { AppError, gscQueryTotalsDtoSchema, type GscQueryTotalsDto } from '@ainyc/canonry-contracts'
import { googleRoutes } from '../src/google.js'

/**
 * `GET /projects/:name/google/gsc/query-totals` folds the stored per-(date,
 * query) Search Console rows into one row per query for a window. Every figure
 * below is fictional and chosen so the arithmetic is exact.
 */

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-query-totals-route-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })
  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({ clientId: 'cid', clientSecret: 'csec' }),
    googleConnectionStore: {
      listConnections: () => [],
      getConnection: () => undefined,
      upsertConnection: (connection) => connection,
      updateConnection: () => undefined,
      deleteConnection: () => false,
    },
    googleStateSecret: 'test-secret-32-bytes-long-enough!',
  })

  return { app, db, tmpDir }
}

const NOW = '2026-08-02T00:00:00.000Z'

describe('googleRoutes: GET /projects/:name/google/gsc/query-totals', () => {
  let context: ReturnType<typeof buildApp>
  let projectId: string
  let otherProjectId: string
  let syncRunId: string
  let otherSyncRunId: string

  function insertProject(id: string, name: string) {
    context.db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: `${name}.example.com`,
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
    }).run()
    const runId = crypto.randomUUID()
    context.db.insert(runs).values({
      id: runId, projectId: id, kind: 'gsc-sync', status: 'completed', trigger: 'manual', createdAt: NOW,
    }).run()
    return runId
  }

  beforeEach(async () => {
    context = buildApp()
    await context.app.ready()
    projectId = crypto.randomUUID()
    otherProjectId = crypto.randomUUID()
    syncRunId = insertProject(projectId, 'widgets')
    otherSyncRunId = insertProject(otherProjectId, 'gadgets')
  })

  afterEach(async () => {
    await context.app.close()
    fs.rmSync(context.tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /** A row in the accurate un-dimensioned `['date','query']` table. */
  function seedAccurate(
    date: string, query: string, clicks: number, impressions: number, position: string,
    project = projectId,
  ) {
    context.db.insert(gscQueryDailyTotals).values({
      id: crypto.randomUUID(), projectId: project, date, query, clicks, impressions,
      position, syncedAt: NOW, createdAt: NOW,
    }).run()
  }

  /** A row in the legacy page-dimensioned `gsc_search_data` table. */
  function seedPage(
    date: string, query: string, page: string, clicks: number, impressions: number, position: string,
    project = projectId,
  ) {
    context.db.insert(gscSearchData).values({
      id: crypto.randomUUID(), projectId: project,
      syncRunId: project === projectId ? syncRunId : otherSyncRunId,
      date, query, page, country: 'usa', device: 'DESKTOP', clicks, impressions,
      ctr: '0', position, createdAt: NOW,
    }).run()
  }

  function seedPropertyDaily(date: string) {
    context.db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(), projectId, date, clicks: 1, impressions: 1, position: '1', createdAt: NOW,
    }).run()
  }

  async function get(query: string, project = 'widgets') {
    return context.app.inject({
      method: 'GET',
      url: `/projects/${project}/google/gsc/query-totals${query ? `?${query}` : ''}`,
    })
  }

  async function body(query: string): Promise<GscQueryTotalsDto> {
    const res = await get(query)
    expect(res.statusCode).toBe(200)
    const parsed = gscQueryTotalsDtoSchema.parse(res.json())
    return parsed
  }

  const JULY = 'startDate=2026-07-01&endDate=2026-07-31'

  /** Seven queries with distinct click counts, for the paging cases. */
  function seedSeven() {
    for (let i = 0; i < 7; i++) {
      seedAccurate('2026-07-10', `widget ${i}`, 70 - i * 10, 1000, '3')
    }
  }

  it('sums clicks and impressions per query and weights position by impressions', async () => {
    seedAccurate('2026-07-01', 'blue widget', 3, 100, '2.0')
    seedAccurate('2026-07-02', 'blue widget', 2, 400, '3.0')
    const data = await body(JULY)
    expect(data.rows).toHaveLength(1)
    const row = data.rows[0]!
    expect(row.query).toBe('blue widget')
    expect(row.clicks).toBe(5)
    expect(row.impressions).toBe(500)
    // 5 / 500
    expect(row.ctr).toBeCloseTo(0.01, 12)
    // (2.0*100 + 3.0*400) / 500 = 2.8, not the plain mean 2.5.
    expect(row.position).toBeCloseTo(2.8, 12)
    expect(row.source).toBe('google')
  })

  it('counts the distinct days each query appeared', async () => {
    seedAccurate('2026-07-01', 'blue widget', 1, 10, '1')
    seedAccurate('2026-07-02', 'blue widget', 1, 10, '1')
    seedAccurate('2026-07-03', 'blue widget', 1, 10, '1')
    seedAccurate('2026-07-03', 'red widget', 1, 10, '1')
    // A legacy day already covered by the accurate table is the same day, not a
    // second one; a legacy-only day is a new one.
    seedPage('2026-07-03', 'red widget', 'https://widgets.example.com/a', 1, 40, '1')
    seedPage('2026-07-04', 'red widget', 'https://widgets.example.com/a', 1, 40, '1')
    const data = await body(JULY)
    const days = Object.fromEntries(data.rows.map(r => [r.query, r.days]))
    expect(days).toEqual({ 'blue widget': 3, 'red widget': 2 })
  })

  it('orders by clicks desc, then impressions desc, then query asc', async () => {
    seedAccurate('2026-07-01', 'delta widget', 0, 50, '5')
    seedAccurate('2026-07-01', 'alpha widget', 5, 100, '5')
    seedAccurate('2026-07-01', 'Gamma widget', 5, 100, '5')
    seedAccurate('2026-07-01', 'beta widget', 5, 300, '5')
    seedAccurate('2026-07-01', 'zeta widget', 9, 10, '5')
    const data = await body(JULY)
    // Ties on clicks and impressions break by code point, so the capitalised
    // query sorts first and the order never depends on the host locale.
    expect(data.rows.map(r => r.query)).toEqual([
      'zeta widget', 'beta widget', 'Gamma widget', 'alpha widget', 'delta widget',
    ])
  })

  it('pages with limit and offset; concatenated pages equal the unpaged rows', async () => {
    seedSeven()
    // A tie on clicks and impressions, so the page boundary rests on the query tiebreak.
    seedAccurate('2026-07-10', 'widget 3b', 40, 1000, '3')
    const all = await body(`${JULY}&limit=5000`)
    expect(all.rows).toHaveLength(8)
    const pages: GscQueryTotalsDto['rows'] = []
    for (const offset of [0, 3, 6]) {
      pages.push(...(await body(`${JULY}&limit=3&offset=${offset}`)).rows)
    }
    expect(pages).toEqual(all.rows)
  })

  it('reports totalMatching and truncated from the end of the page', async () => {
    seedSeven()
    const first = await body(`${JULY}&limit=3&offset=0`)
    expect(first.rows.map(r => r.query)).toEqual(['widget 0', 'widget 1', 'widget 2'])
    expect(first.totalMatching).toBe(7)
    expect(first.truncated).toBe(true)

    const exactEnd = await body(`${JULY}&limit=4&offset=3`)
    expect(exactEnd.rows).toHaveLength(4)
    expect(exactEnd.truncated).toBe(false)

    const last = await body(`${JULY}&limit=3&offset=6`)
    expect(last.rows.map(r => r.query)).toEqual(['widget 6'])
    expect(last.totalMatching).toBe(7)
    expect(last.truncated).toBe(false)
  })

  it('defaults to 500 rows and clamps a zero limit to 1', async () => {
    seedSeven()
    const unpaged = await body(JULY)
    expect(unpaged.rows).toHaveLength(7)
    const clamped = await body(`${JULY}&limit=0`)
    expect(clamped.rows).toHaveLength(1)
    expect(clamped.truncated).toBe(true)
  })

  it('reports truncated false for a page past the end', async () => {
    seedSeven()
    const data = await body(`${JULY}&limit=3&offset=10`)
    expect(data.rows).toEqual([])
    expect(data.totalMatching).toBe(7)
    expect(data.truncated).toBe(false)
  })

  it('respects startDate and endDate inclusively and echoes the window', async () => {
    seedAccurate('2026-06-30', 'blue widget', 100, 1000, '1')
    seedAccurate('2026-07-01', 'blue widget', 1, 10, '1')
    seedAccurate('2026-07-15', 'blue widget', 2, 20, '1')
    seedAccurate('2026-07-31', 'blue widget', 4, 40, '1')
    seedAccurate('2026-08-01', 'blue widget', 100, 1000, '1')
    seedPage('2026-08-01', 'green widget', 'https://widgets.example.com/a', 1, 10, '1')
    const data = await body(JULY)
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0]!.clicks).toBe(7)
    expect(data.rows[0]!.impressions).toBe(70)
    expect(data.rows[0]!.days).toBe(3)
    expect(data.window.startDate).toBe('2026-07-01')
    expect(data.window.endDate).toBe('2026-07-31')
    expect(data.window.latestDataDate).toBe('2026-08-01')
  })

  it('anchors a labelled window on the last published day', async () => {
    seedPropertyDaily('2026-07-31')
    seedAccurate('2026-07-24', 'blue widget', 100, 1000, '1')
    seedAccurate('2026-07-25', 'blue widget', 1, 10, '1')
    seedAccurate('2026-07-31', 'blue widget', 2, 20, '1')
    const data = await body('window=7d')
    // Inclusive seven days ending on the latest data date: 25th through 31st.
    expect(data.window.startDate).toBe('2026-07-25')
    expect(data.window.endDate).toBe('2026-07-31')
    expect(data.rows[0]!.clicks).toBe(3)
    expect(data.rows[0]!.days).toBe(2)
  })

  it('prefers accurate rows over the page table for the same day and fills unbackfilled days (source google, page-summed, mixed)', async () => {
    // blue: day 1 legacy only, day 2 both sources (accurate wins).
    seedPage('2026-07-01', 'blue widget', 'https://widgets.example.com/a', 2, 200, '4')
    seedPage('2026-07-02', 'blue widget', 'https://widgets.example.com/a', 9, 900, '4')
    seedAccurate('2026-07-02', 'blue widget', 3, 300, '2')
    // red: legacy only.
    seedPage('2026-07-01', 'red widget', 'https://widgets.example.com/b', 1, 50, '6')
    // green: accurate only.
    seedAccurate('2026-07-02', 'green widget', 4, 80, '1')
    const data = await body(JULY)
    const byQuery = Object.fromEntries(data.rows.map(r => [r.query, r]))
    expect(byQuery['blue widget']).toMatchObject({ clicks: 5, impressions: 500, days: 2, source: 'mixed' })
    // (4*200 + 2*300) / 500 = 2.8
    expect(byQuery['blue widget']!.position).toBeCloseTo(2.8, 12)
    expect(byQuery['red widget']).toMatchObject({ clicks: 1, impressions: 50, position: 6, days: 1, source: 'page-summed' })
    expect(byQuery['green widget']).toMatchObject({ clicks: 4, impressions: 80, position: 1, days: 1, source: 'google' })
  })

  it('does not count the page fan-out: two pages on one SERP report the accurate impressions', async () => {
    seedPage('2026-07-01', 'blue widget', 'https://widgets.example.com/a', 2, 300, '3')
    seedPage('2026-07-01', 'blue widget', 'https://widgets.example.com/b', 1, 300, '5')
    seedAccurate('2026-07-01', 'blue widget', 3, 320, '3')
    const data = await body(JULY)
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0]!.impressions).toBe(320)
    expect(data.rows[0]!.clicks).toBe(3)
    expect(data.rows[0]!.source).toBe('google')
  })

  it('casts text positions', async () => {
    // A string compare would put '10.5' before '9.5'; the weighting must be numeric.
    seedAccurate('2026-07-01', 'blue widget', 0, 10, '10.5')
    seedAccurate('2026-07-02', 'blue widget', 0, 30, '9.5')
    seedPage('2026-07-01', 'red widget', 'https://widgets.example.com/a', 0, 10, '10.5')
    seedPage('2026-07-01', 'red widget', 'https://widgets.example.com/b', 0, 30, '9.5')
    const data = await body(JULY)
    const byQuery = Object.fromEntries(data.rows.map(r => [r.query, r]))
    // (10.5*10 + 9.5*30) / 40 = 9.75, in both sources.
    expect(byQuery['blue widget']!.position).toBeCloseTo(9.75, 12)
    expect(byQuery['red widget']!.position).toBeCloseTo(9.75, 12)
    expect(typeof byQuery['red widget']!.position).toBe('number')
  })

  it('excludes empty queries from the page-table fallback', async () => {
    seedPage('2026-07-01', '', 'https://widgets.example.com/a', 50, 5000, '1')
    seedPage('2026-07-01', 'blue widget', 'https://widgets.example.com/a', 1, 10, '1')
    const data = await body(JULY)
    expect(data.rows.map(r => r.query)).toEqual(['blue widget'])
    expect(data.totalMatching).toBe(1)
  })

  it('rejects an invalid calendar date with 400', async () => {
    const res = await get('startDate=2026-02-30&endDate=2026-03-31')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toContain('2026-02-30')
  })

  it('rejects a range that runs backwards with 400', async () => {
    const res = await get('startDate=2026-07-31&endDate=2026-07-01')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toContain('after endDate')
  })

  it('rejects an unknown window with 400', async () => {
    const res = await get('window=forever')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toContain('Invalid window')
  })

  it('returns empty rows and totalMatching 0 for a window with no data', async () => {
    seedAccurate('2026-06-01', 'blue widget', 1, 10, '1')
    const data = await body(JULY)
    expect(data.rows).toEqual([])
    expect(data.totalMatching).toBe(0)
    expect(data.truncated).toBe(false)
  })

  it('scopes rows to the project', async () => {
    seedAccurate('2026-07-01', 'blue widget', 1, 10, '1')
    seedAccurate('2026-07-01', 'blue widget', 90, 900, '1', otherProjectId)
    seedAccurate('2026-07-01', 'gadget only', 90, 900, '1', otherProjectId)
    seedPage('2026-07-02', 'gadget legacy', 'https://gadgets.example.com/a', 9, 90, '1', otherProjectId)
    const data = await body(JULY)
    expect(data.rows.map(r => [r.query, r.clicks])).toEqual([['blue widget', 1]])
  })

  it('returns 404 for an unknown project', async () => {
    const res = await get(JULY, 'no-such-project')
    expect(res.statusCode).toBe(404)
  })

  it('writes nothing and calls no network', async () => {
    seedAccurate('2026-07-01', 'blue widget', 1, 10, '1')
    seedPage('2026-07-01', 'red widget', 'https://widgets.example.com/a', 1, 10, '1')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const counts = () => ({
      accurate: context.db.select().from(gscQueryDailyTotals).all().length,
      legacy: context.db.select().from(gscSearchData).all().length,
      daily: context.db.select().from(gscDailyTotals).all().length,
      runs: context.db.select().from(runs).all().length,
    })
    const before = counts()
    const data = await body(JULY)
    expect(data.rows).toHaveLength(2)
    expect(counts()).toEqual(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
