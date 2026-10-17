import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import Fastify from 'fastify'
import { createClient, migrate, projects, runs, gscSearchData } from '@canonry/canonry-db'
import { AppError } from '@canonry/canonry-contracts'
import { googleRoutes } from '../src/google.js'

/**
 * Regression suite for the GSC performance read.
 *
 * The defect this locks down is NOT the size of the default limit. It is the
 * ordering: the route ordered by `date desc` and then truncated, so on a real
 * project (measured 2026-08-01: 253 distinct dates, newest day 671 rows,
 * median day 724 rows) the 500-row cap was consumed before the first date
 * boundary and every call returned a single day. Raising the limit only moves
 * the cliff, so the fix is to order by a metric (clicks) by default and to
 * report truncation explicitly.
 */

type PerformanceRow = { date: string; query: string; clicks: number; impressions: number }

type PerformanceResponse = {
  rows: PerformanceRow[]
  totalMatching: number
  truncated: boolean
  latestAvailableDate: string | null
}

/**
 * Shape-tolerant row reader. The ordering assertions below are about ordering,
 * not about the envelope, so they read rows from either the pre-envelope bare
 * array or the envelope. That keeps the ordering failure legible on its own.
 */
function rowsOf(body: unknown): PerformanceRow[] {
  if (Array.isArray(body)) return body as PerformanceRow[]
  return (body as PerformanceResponse).rows
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-perf-order-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
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
    googleStateSecret: 'test-state-secret',
    getGoogleAuthConfig: () => ({ clientId: 'cid', clientSecret: 'csec' }),
    googleConnectionStore: {
      listConnections: () => [],
      getConnection: () => undefined,
      upsertConnection: (connection) => connection,
      updateConnection: () => undefined,
      deleteConnection: () => false,
    },
  })
  return { app, db, tmpDir }
}

/**
 * Dates are seeded newest-first with the newest day holding more rows than the
 * default limit, mirroring the real distribution that produced the bug.
 */
const DATES = ['2026-01-20', '2026-01-19', '2026-01-18'] as const
const NEWEST_DAY_ROWS = 620

describe('googleRoutes: GET /projects/:name/google/gsc/performance ordering', () => {
  let context: ReturnType<typeof buildApp>
  let projectId: string

  beforeEach(async () => {
    context = buildApp()
    await context.app.ready()
    projectId = crypto.randomUUID()
    const now = '2026-01-21T00:00:00.000Z'
    context.db.insert(projects).values({
      id: projectId,
      name: 'perf',
      displayName: 'Perf',
      canonicalDomain: 'perf.example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
    const syncRunId = crypto.randomUUID()
    context.db.insert(runs).values({
      id: syncRunId,
      projectId,
      kind: 'gsc-sync',
      status: 'completed',
      trigger: 'manual',
      createdAt: now,
    }).run()

    const rows: Array<typeof gscSearchData.$inferInsert> = []
    for (const [dateIndex, date] of DATES.entries()) {
      // The newest date alone exceeds the 500-row default limit.
      const rowCount = dateIndex === 0 ? NEWEST_DAY_ROWS : 40
      for (let i = 0; i < rowCount; i++) {
        rows.push({
          id: crypto.randomUUID(),
          projectId,
          syncRunId,
          date,
          query: `q-${date}-${i}`,
          page: `/p${i}`,
          country: 'usa',
          device: 'DESKTOP',
          // Older dates carry the biggest click counts, so a clicks-desc
          // ordering has to reach past the newest day.
          impressions: (i + 1) * 10,
          clicks: dateIndex === 0 ? 1 : 100 + i,
          ctr: '0.1',
          position: '3.5',
          createdAt: now,
        })
      }
    }
    for (const row of rows) {
      context.db.insert(gscSearchData).values(row).run()
    }
  })

  afterEach(async () => {
    await context.app.close()
    fs.rmSync(context.tmpDir, { recursive: true, force: true })
  })

  it('does not report truncation for a page that sits past the end', async () => {
    // `rows.length < totalMatching` alone is wrong here: the page is empty
    // because it starts past the last row, and there is nothing further to
    // fetch. Truncation has to be measured from where this page ends.
    const total = DATES.length === 3 ? NEWEST_DAY_ROWS + 40 + 40 : 0
    const res = await context.app.inject({
      method: 'GET',
      url: `/projects/perf/google/gsc/performance?offset=${total}&limit=10`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as PerformanceResponse
    expect(body.totalMatching).toBe(total)
    expect(body.rows).toHaveLength(0)
    expect(body.truncated).toBe(false)
  })

  it('reports truncation from the end of the current page, not its length', async () => {
    const total = NEWEST_DAY_ROWS + 40 + 40
    const lastPage = await context.app.inject({
      method: 'GET',
      url: `/projects/perf/google/gsc/performance?offset=${total - 10}&limit=100`,
    })
    const lastBody = lastPage.json() as PerformanceResponse
    expect(lastBody.rows).toHaveLength(10)
    expect(lastBody.truncated).toBe(false)

    const firstPage = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?offset=0&limit=100',
    })
    const firstBody = firstPage.json() as PerformanceResponse
    expect(firstBody.rows).toHaveLength(100)
    expect(firstBody.truncated).toBe(true)
  })

  it('resolves ?days= server-side against the published frontier', async () => {
    // The CLI used to turn `--days N` into client-computed UTC dates and send
    // them as EXPLICIT bounds, which the route honours over its own anchor —
    // so the relative window skipped the published-day anchoring entirely and
    // was pinned to the caller's clock. The span is now resolved here.
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?days=1&limit=500',
    })
    expect(res.statusCode).toBe(200)
    // A 1-day span ends at the frontier and covers exactly that one date.
    const dates = new Set(rowsOf(res.json()).map((r) => r.date))
    expect(dates.size).toBe(1)
    expect([...dates][0]).toBe(DATES[0])
  })

  it('rejects a non-positive or non-integer ?days=', async () => {
    for (const bad of ['0', '-3', '2.5', 'abc']) {
      const res = await context.app.inject({
        method: 'GET',
        url: `/projects/perf/google/gsc/performance?days=${bad}`,
      })
      expect(res.statusCode, `days=${bad}`).toBe(400)
    }
  })

  it('refuses a caller range that runs backwards', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?startDate=2030-01-01&endDate=2026-01-06',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/is after endDate/)
  })

  it('returns rows spanning more than one date on a default call', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance',
    })
    expect(res.statusCode).toBe(200)
    const dates = new Set(rowsOf(res.json()).map((r) => r.date))
    expect(dates.size).toBeGreaterThan(1)
  })

  it('defaults to clicks descending', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=10',
    })
    const clicks = rowsOf(res.json()).map((r) => r.clicks)
    expect(clicks).toHaveLength(10)
    expect([...clicks].sort((a, b) => b - a)).toEqual(clicks)
    // Top clicks live on the older dates in this fixture.
    expect(clicks[0]).toBe(139)
  })

  it('reports totalMatching, truncated and latestAvailableDate', async () => {
    const total = NEWEST_DAY_ROWS + 40 + 40
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=500',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as PerformanceResponse
    expect(body.rows).toHaveLength(500)
    expect(body.totalMatching).toBe(total)
    expect(body.totalMatching).toBeGreaterThan(500)
    expect(body.truncated).toBe(true)
    expect(body.latestAvailableDate).toBe('2026-01-20')
  })

  it('reports truncated false when the page covers every matching row', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?startDate=2026-01-18&endDate=2026-01-18&limit=500',
    })
    const body = res.json() as PerformanceResponse
    expect(body.rows).toHaveLength(40)
    expect(body.totalMatching).toBe(40)
    expect(body.truncated).toBe(false)
  })

  it('orders by impressions descending when asked', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=impressions&limit=5',
    })
    const impressions = rowsOf(res.json()).map((r) => r.impressions)
    expect([...impressions].sort((a, b) => b - a)).toEqual(impressions)
    expect(impressions[0]).toBe(NEWEST_DAY_ROWS * 10)
  })

  it('orders by date descending when asked', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=5',
    })
    expect(rowsOf(res.json()).map((r) => r.date)).toEqual(Array(5).fill('2026-01-20'))
  })

  it('rejects an unknown orderBy with 400 instead of silently falling back', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=nonsense',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining('orderBy') }),
    })
  })

  it('filters by startDate/endDate and counts only the filtered rows', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?startDate=2026-01-18&endDate=2026-01-19&limit=10',
    })
    const body = res.json() as PerformanceResponse
    expect(body.rows).toHaveLength(10)
    expect(body.totalMatching).toBe(80)
    expect(body.truncated).toBe(true)
    // latestAvailableDate ignores the date filter: it is what the project holds.
    expect(body.latestAvailableDate).toBe('2026-01-20')
    for (const row of body.rows) {
      expect(['2026-01-18', '2026-01-19']).toContain(row.date)
    }
  })

  it('returns latestAvailableDate even when the filtered window is empty', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?startDate=2026-02-01&endDate=2026-02-05',
    })
    const body = res.json() as PerformanceResponse
    expect(body.rows).toEqual([])
    expect(body.totalMatching).toBe(0)
    expect(body.truncated).toBe(false)
    expect(body.latestAvailableDate).toBe('2026-01-20')
  })

  it('returns a null latestAvailableDate for a project with no GSC rows', async () => {
    const emptyId = crypto.randomUUID()
    const now = '2026-01-21T00:00:00.000Z'
    context.db.insert(projects).values({
      id: emptyId,
      name: 'empty',
      displayName: 'Empty',
      canonicalDomain: 'empty.example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/empty/google/gsc/performance',
    })
    const body = res.json() as PerformanceResponse
    expect(body.rows).toEqual([])
    expect(body.totalMatching).toBe(0)
    expect(body.latestAvailableDate).toBeNull()
  })
})
