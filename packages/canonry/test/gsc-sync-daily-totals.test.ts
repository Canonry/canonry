import { describe, test, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  runs,
  gscSearchData,
  gscDailyTotals,
  gscDataWatermarks,
} from '@ainyc/canonry-db'
import type { CanonryConfig } from '../src/config.js'

// --- mock the integration HTTP clients (no network in unit tests) ---
const fetchSearchAnalyticsMock = vi.fn()
const inspectUrlMock = vi.fn()
const refreshAccessTokenMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>(
    '@ainyc/canonry-integration-google',
  )
  return {
    ...actual,
    fetchSearchAnalytics: (...a: unknown[]) => fetchSearchAnalyticsMock(...a),
    inspectUrl: (...a: unknown[]) => inspectUrlMock(...a),
    refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a),
  }
})

// Imported AFTER the mock is registered so the module picks up the mocked deps.
const { executeGscSync } = await import('../src/gsc-sync.js')

const DOMAIN = 'harborline.example.com'
const PROPERTY = 'sc-domain:harborline.example.com'

/** YYYY-MM-DD for `n` days before now — used so seeded dates land inside the
 * sync window (`daysAgo(lag+1)` .. `daysAgo(lag+days)`, lag=3, days=30). */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

/**
 * Today on GSC's PACIFIC reporting calendar — the calendar the sync bounds its
 * fetch by. A UTC "today" names the next day between 00:00 and 08:00 UTC.
 */
function pacificToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gsc-sync-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return { db, tmpDir }
}

function seedProject(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'proj_gsc',
    name: 'harborline',
    displayName: 'Harborline',
    canonicalDomain: DOMAIN,
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
}

function seedRun(db: ReturnType<typeof createClient>, runId: string) {
  db.insert(runs).values({
    id: runId,
    projectId: 'proj_gsc',
    kind: 'gsc-sync',
    status: 'queued',
    trigger: 'manual',
    createdAt: new Date().toISOString(),
  }).run()
}

function testConfig(): CanonryConfig {
  return {
    google: {
      clientId: 'cid',
      clientSecret: 'csec',
      connections: [
        {
          domain: DOMAIN,
          connectionType: 'gsc',
          accessToken: 'tok',
          refreshToken: 'rt',
          // Far-future expiry so the refresh branch (and saveConfigPatch) is skipped.
          tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          propertyId: PROPERTY,
          scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  } as unknown as CanonryConfig
}

beforeEach(() => {
  vi.clearAllMocks()
  // No URL inspections (keeps the secondary inspection pass a no-op).
  inspectUrlMock.mockResolvedValue({
    inspectionResult: { indexStatusResult: { indexingState: 'INDEXING_ALLOWED' } },
  })
})

describe('executeGscSync — fetch window', () => {
  test('asks Google through today instead of stopping at a hard-coded lag', async () => {
    // The ceiling used to be `today - GSC_DATA_LAG_DAYS`, so the sync never
    // requested the most recent day Google had already published and stored
    // data stayed a day behind the Search Console UI on every run. Google's
    // delay varies, so the only correct ceiling is today: the API returns the
    // days that exist and omits the rest.
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      seedRun(db, 'run_window')
      fetchSearchAnalyticsMock.mockResolvedValue([])

      await executeGscSync(db, 'run_window', 'proj_gsc', { config: testConfig() })

      // GSC's reporting calendar is Pacific, not UTC.
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date())
      for (const call of fetchSearchAnalyticsMock.mock.calls) {
        expect((call[2] as { endDate: string }).endDate).toBe(today)
      }
      // The lag still pads the START, so a 30-day request still covers 30 days
      // of PUBLISHED data rather than 30 minus the delay.
      const firstCall = fetchSearchAnalyticsMock.mock.calls[0]!
      const start = new Date(Date.parse(`${today}T00:00:00Z`) - 33 * 86_400_000)
        .toISOString().slice(0, 10)
      expect((firstCall[2] as { startDate: string }).startDate).toBe(start)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('executeGscSync — data watermark', () => {
  /** Return only property-level (`dimensions: ['date']`) rows for these dates. */
  function respondWithDates(dates: readonly string[]) {
    fetchSearchAnalyticsMock.mockImplementation(
      (_t: string, _p: string, opts: { dimensions?: string[] }) => {
        const dateOnly = Array.isArray(opts.dimensions)
          && opts.dimensions.length === 1 && opts.dimensions[0] === 'date'
        if (!dateOnly) return Promise.resolve([])
        return Promise.resolve(dates.map((d) => ({
          keys: [d], clicks: 1, impressions: 10, ctr: 0.1, position: 5,
        })))
      },
    )
  }

  function watermark(db: ReturnType<typeof createClient>) {
    return db.select().from(gscDataWatermarks)
      .where(eq(gscDataWatermarks.projectId, 'proj_gsc')).get()
  }

  test('records the furthest date the sync observed, and how far it asked', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      seedRun(db, 'run_wm1')
      respondWithDates([daysAgo(9), daysAgo(5), daysAgo(4)])

      await executeGscSync(db, 'run_wm1', 'proj_gsc', { config: testConfig() })

      const row = watermark(db)
      expect(row?.dataThroughDate).toBe(daysAgo(4))
      // We asked through today even though Google stopped at day-4; the gap is
      // what makes "zero traffic" distinguishable from "never requested".
      expect(row?.syncedThroughDate).toBe(pacificToday())
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('NEVER moves the frontier backward when a later sync sees a quiet tail', async () => {
    // The P1 this table exists for. Search Analytics omits zero-data days, so a
    // quiet stretch makes the observed max walk backward. If the watermark
    // followed it, every anchored window would slide into the past and its
    // totals would move for a reason unrelated to the site.
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)

      seedRun(db, 'run_wm2')
      respondWithDates([daysAgo(6), daysAgo(4)])
      await executeGscSync(db, 'run_wm2', 'proj_gsc', { config: testConfig() })
      expect(watermark(db)?.dataThroughDate).toBe(daysAgo(4))

      // Second sync: the property went quiet, so Google returns nothing past
      // day-8. The observed max is now OLDER than the stored frontier.
      seedRun(db, 'run_wm3')
      respondWithDates([daysAgo(8)])
      await executeGscSync(db, 'run_wm3', 'proj_gsc', { config: testConfig() })

      expect(watermark(db)?.dataThroughDate).toBe(daysAgo(4))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('advances when real data moves past the stored frontier', async () => {
    // Monotonic means "never backward", not "frozen".
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)

      seedRun(db, 'run_wm4')
      respondWithDates([daysAgo(8)])
      await executeGscSync(db, 'run_wm4', 'proj_gsc', { config: testConfig() })
      expect(watermark(db)?.dataThroughDate).toBe(daysAgo(8))

      seedRun(db, 'run_wm5')
      respondWithDates([daysAgo(8), daysAgo(3)])
      await executeGscSync(db, 'run_wm5', 'proj_gsc', { config: testConfig() })
      expect(watermark(db)?.dataThroughDate).toBe(daysAgo(3))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('executeGscSync — gsc_daily_totals (property total)', () => {
  test('stores property-level daily totals from the dimensions:[date] call', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      seedRun(db, 'run_1')

      const earlyDate = daysAgo(20)
      const lateDate = daysAgo(5)

      // The dimensioned default call returns query×page×date rows that SUM to
      // 46,325 impressions / 720 clicks. The dimensions:['date'] call returns
      // the property total (37,100 / 982). The sync must store the latter in
      // gsc_daily_totals and the former in gsc_search_data.
      fetchSearchAnalyticsMock.mockImplementation(
        (_token: string, _property: string, opts: { dimensions?: string[] }) => {
          const isDateOnly = Array.isArray(opts.dimensions) && opts.dimensions.length === 1 && opts.dimensions[0] === 'date'
          if (isDateOnly) {
            return Promise.resolve([
              { keys: [earlyDate], clicks: 500, impressions: 17_100, ctr: 500 / 17_100, position: 4 },
              { keys: [lateDate], clicks: 482, impressions: 20_000, ctr: 482 / 20_000, position: 6 },
            ])
          }
          // Dimensioned: query, page, country, device, date
          return Promise.resolve([
            { keys: ['harborline brand', 'https://harborline.example.com/a', 'usa', 'DESKTOP', earlyDate], clicks: 400, impressions: 25_000, ctr: 0.016, position: 4 },
            { keys: ['bayport hotel', 'https://harborline.example.com/b', 'usa', 'MOBILE', lateDate], clicks: 320, impressions: 21_325, ctr: 0.015, position: 6 },
          ])
        },
      )

      await executeGscSync(db, 'run_1', 'proj_gsc', { config: testConfig() })

      // The dimensions:['date'] call was made.
      const dateOnlyCall = fetchSearchAnalyticsMock.mock.calls.find(
        (c) => Array.isArray((c[2] as { dimensions?: string[] }).dimensions)
          && (c[2] as { dimensions?: string[] }).dimensions!.length === 1
          && (c[2] as { dimensions?: string[] }).dimensions![0] === 'date',
      )
      expect(dateOnlyCall).toBeDefined()

      // gsc_daily_totals holds the property total (NOT the dimensioned sum).
      const totals = db
        .select()
        .from(gscDailyTotals)
        .where(eq(gscDailyTotals.projectId, 'proj_gsc'))
        .orderBy(asc(gscDailyTotals.date))
        .all()
      expect(totals).toHaveLength(2)
      expect(totals.map((t) => t.date)).toEqual([earlyDate, lateDate])
      expect(totals.reduce((s, t) => s + t.impressions, 0)).toBe(37_100)
      expect(totals.reduce((s, t) => s + t.clicks, 0)).toBe(982)
      expect(totals[0]!.position).toBe('4')
      expect(totals[1]!.position).toBe('6')

      // gsc_search_data still holds the dimensioned rows (sum 46,325 / 720).
      const dimensioned = db.select().from(gscSearchData).where(eq(gscSearchData.projectId, 'proj_gsc')).all()
      expect(dimensioned).toHaveLength(2)
      expect(dimensioned.reduce((s, r) => s + r.impressions, 0)).toBe(46_325)
      expect(dimensioned.reduce((s, r) => s + r.clicks, 0)).toBe(720)

      // Run completed.
      const run = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
      expect(run!.status).toBe('completed')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('re-sync replaces daily totals for the window (no duplicates)', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)

      const theDate = daysAgo(10)
      fetchSearchAnalyticsMock.mockImplementation(
        (_token: string, _property: string, opts: { dimensions?: string[] }) => {
          const isDateOnly = Array.isArray(opts.dimensions) && opts.dimensions[0] === 'date' && opts.dimensions.length === 1
          if (isDateOnly) {
            return Promise.resolve([
              { keys: [theDate], clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
            ])
          }
          return Promise.resolve([])
        },
      )

      seedRun(db, 'run_a')
      await executeGscSync(db, 'run_a', 'proj_gsc', { config: testConfig() })
      seedRun(db, 'run_b')
      await executeGscSync(db, 'run_b', 'proj_gsc', { config: testConfig() })

      const totals = db.select().from(gscDailyTotals).where(eq(gscDailyTotals.projectId, 'proj_gsc')).all()
      // One date in the window → exactly one row after two syncs (replace, not append).
      expect(totals).toHaveLength(1)
      expect(totals[0]!.date).toBe(theDate)
      expect(totals[0]!.clicks).toBe(10)
      expect(totals[0]!.impressions).toBe(100)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
