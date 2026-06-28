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

const DOMAIN = 'gjelina.example.com'
const PROPERTY = 'sc-domain:gjelina.example.com'

/** YYYY-MM-DD for `n` days before now — used so seeded dates land inside the
 * sync window (`daysAgo(lag+1)` .. `daysAgo(lag+days)`, lag=3, days=30). */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
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
    name: 'gjelina',
    displayName: 'Gjelina',
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
            { keys: ['gjelina brand', 'https://gjelina.example.com/a', 'usa', 'DESKTOP', earlyDate], clicks: 400, impressions: 25_000, ctr: 0.016, position: 4 },
            { keys: ['venice hotel', 'https://gjelina.example.com/b', 'usa', 'MOBILE', lateDate], clicks: 320, impressions: 21_325, ctr: 0.015, position: 6 },
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
