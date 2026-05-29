import { describe, test, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  runs,
  gbpLocations,
  gbpKeywordImpressions,
  gbpKeywordMonthly,
} from '@ainyc/canonry-db'
import { executeGbpSync } from '../src/gbp-sync.js'
import type { CanonryConfig } from '../src/config.js'

// --- mock the integration HTTP clients (no network in unit tests) ---
const fetchDailyMetricsMock = vi.fn()
const listMonthlyKeywordsMock = vi.fn()
const listPlaceActionLinksMock = vi.fn()
const getLodgingMock = vi.fn()
const refreshAccessTokenMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google-business-profile', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google-business-profile')>(
    '@ainyc/canonry-integration-google-business-profile',
  )
  return {
    ...actual,
    fetchDailyMetrics: (...a: unknown[]) => fetchDailyMetricsMock(...a),
    listMonthlyKeywords: (...a: unknown[]) => listMonthlyKeywordsMock(...a),
    listPlaceActionLinks: (...a: unknown[]) => listPlaceActionLinksMock(...a),
    getLodging: (...a: unknown[]) => getLodgingMock(...a),
  }
})
vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>(
    '@ainyc/canonry-integration-google',
  )
  return { ...actual, refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a) }
})

const DOMAIN = 'gjelina.example.com'
const LOCATION = 'locations/12345'

/** YYYY-MM string for `n` calendar months before now (mirrors the sync's monthMinus + monthKey). */
function monthsAgoKey(n: number): string {
  const d = new Date()
  d.setUTCDate(1) // anchor before shifting months to avoid short-month overflow
  d.setUTCMonth(d.getUTCMonth() - n)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gbp-sync-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return { db, tmpDir }
}

function seedProject(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'proj_gbp',
    name: 'gjelina',
    displayName: 'Gjelina',
    canonicalDomain: DOMAIN,
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(gbpLocations).values({
    id: 'loc_1',
    projectId: 'proj_gbp',
    accountName: 'accounts/1',
    locationName: LOCATION,
    displayName: 'Gjelina Venice',
    selected: true,
    createdAt: now,
    updatedAt: now,
  }).run()
}

function seedRun(db: ReturnType<typeof createClient>, runId: string) {
  db.insert(runs).values({
    id: runId,
    projectId: 'proj_gbp',
    kind: 'gbp-sync',
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
          connectionType: 'gbp',
          accessToken: 'tok',
          refreshToken: 'rt',
          // Far-future expiry so the refresh branch (and saveConfigPatch) is skipped.
          tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          propertyId: null,
          sitemapUrl: null,
          scopes: ['https://www.googleapis.com/auth/business.manage'],
          createdByProjectId: 'proj_gbp',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  } as unknown as CanonryConfig
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchDailyMetricsMock.mockResolvedValue([])
  listPlaceActionLinksMock.mockResolvedValue([])
  getLodgingMock.mockResolvedValue(null)
  // Month-aware: a per-month call (startMonth === endMonth) returns a count
  // derived from the month so the test can assert which month was stored; the
  // legacy trailing-window call (startMonth !== endMonth) returns one aggregate.
  listMonthlyKeywordsMock.mockImplementation(
    (_token: string, _loc: string, opts: { startMonth: { year: number; month: number }; endMonth: { year: number; month: number } }) => {
      const single = opts.startMonth.year === opts.endMonth.year && opts.startMonth.month === opts.endMonth.month
      if (single) {
        return Promise.resolve([{ keyword: 'venice beach hotel', valueCount: opts.startMonth.month * 10, valueThreshold: null }])
      }
      return Promise.resolve([{ keyword: 'venice beach hotel', valueCount: 999, valueThreshold: null }])
    },
  )
})

describe('executeGbpSync — keyword monthly accumulate', () => {
  test('writes a per-month keyword series into gbp_keyword_monthly (one row per fetched month)', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      seedRun(db, 'run_1')

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })

      const monthly = db.select().from(gbpKeywordMonthly)
        .where(eq(gbpKeywordMonthly.projectId, 'proj_gbp')).all()

      // The three most recent COMPLETE months were fetched, one row each.
      const expectedMonths = [monthsAgoKey(1), monthsAgoKey(2), monthsAgoKey(3)].sort()
      expect(monthly.map((r) => r.month).sort()).toEqual(expectedMonths)
      // Each row carries the run id and the month-derived count.
      for (const row of monthly) {
        expect(row.keyword).toBe('venice beach hotel')
        expect(row.syncRunId).toBe('run_1')
        const monthNum = Number(row.month.split('-')[1])
        expect(row.valueCount).toBe(monthNum * 10)
      }

      // The legacy trailing-window table is still populated unchanged.
      const trailing = db.select().from(gbpKeywordImpressions)
        .where(eq(gbpKeywordImpressions.projectId, 'proj_gbp')).all()
      expect(trailing).toHaveLength(1)
      expect(trailing[0]!.valueCount).toBe(999)

      const runRow = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
      expect(runRow!.status).toBe('completed')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('accumulates — preserves older in-retention months, prunes beyond retention, idempotent on re-run', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      const now = new Date().toISOString()
      // Pre-seed history from earlier syncs: one month inside the retention
      // window but outside the fetch window (must be preserved), and one month
      // older than retention (must be pruned).
      const preserved = monthsAgoKey(6)
      const prunable = monthsAgoKey(30)
      db.insert(gbpKeywordMonthly).values([
        { id: 'k_pres', projectId: 'proj_gbp', locationName: LOCATION, month: preserved, keyword: 'old keyword', valueCount: 5, valueThreshold: null, syncRunId: null, syncedAt: now },
        { id: 'k_prune', projectId: 'proj_gbp', locationName: LOCATION, month: prunable, keyword: 'ancient keyword', valueCount: 7, valueThreshold: null, syncRunId: null, syncedAt: now },
      ]).run()

      seedRun(db, 'run_2')
      await executeGbpSync(db, 'run_2', 'proj_gbp', { config: testConfig() })

      const months = db.select().from(gbpKeywordMonthly)
        .where(eq(gbpKeywordMonthly.projectId, 'proj_gbp')).all()
        .map((r) => r.month)

      // Older in-retention month survived; beyond-retention month pruned.
      expect(months).toContain(preserved)
      expect(months).not.toContain(prunable)
      // Plus the three freshly-fetched months.
      expect(months).toContain(monthsAgoKey(1))

      // Re-run with a new run id: fetched months are replaced (not duplicated).
      seedRun(db, 'run_3')
      await executeGbpSync(db, 'run_3', 'proj_gbp', { config: testConfig() })

      const afterReRun = db.select().from(gbpKeywordMonthly)
        .where(and(eq(gbpKeywordMonthly.projectId, 'proj_gbp'), eq(gbpKeywordMonthly.month, monthsAgoKey(1)))).all()
      expect(afterReRun).toHaveLength(1)
      expect(afterReRun[0]!.syncRunId).toBe('run_3')
      // The preserved older month is untouched by the re-run.
      expect(
        db.select().from(gbpKeywordMonthly)
          .where(and(eq(gbpKeywordMonthly.projectId, 'proj_gbp'), eq(gbpKeywordMonthly.month, preserved))).all(),
      ).toHaveLength(1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
