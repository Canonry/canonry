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
  gbpPlaceDetails,
  gbpLodgingSnapshots,
  gbpAttributesSnapshots,
} from '@ainyc/canonry-db'
import { hashPlaceDetails } from '@ainyc/canonry-integration-google-places'
import { hashLodging, countPopulatedGroups, hashAttributes, type GbpLocation } from '@ainyc/canonry-integration-google-business-profile'
import { executeGbpSync } from '../src/gbp-sync.js'
import type { CanonryConfig } from '../src/config.js'

// --- mock the integration HTTP clients (no network in unit tests) ---
const listLocationsMock = vi.fn()
const fetchDailyMetricsMock = vi.fn()
const listMonthlyKeywordsMock = vi.fn()
const listPlaceActionLinksMock = vi.fn()
const getLodgingMock = vi.fn()
const getAttributesMock = vi.fn()
const getPlaceDetailsMock = vi.fn()
const refreshAccessTokenMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google-business-profile', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google-business-profile')>(
    '@ainyc/canonry-integration-google-business-profile',
  )
  return {
    ...actual,
    listLocations: (...a: unknown[]) => listLocationsMock(...a),
    fetchDailyMetrics: (...a: unknown[]) => fetchDailyMetricsMock(...a),
    listMonthlyKeywords: (...a: unknown[]) => listMonthlyKeywordsMock(...a),
    listPlaceActionLinks: (...a: unknown[]) => listPlaceActionLinksMock(...a),
    getLodging: (...a: unknown[]) => getLodgingMock(...a),
    getAttributes: (...a: unknown[]) => getAttributesMock(...a),
  }
})
vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>(
    '@ainyc/canonry-integration-google',
  )
  return { ...actual, refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a) }
})
// Keep hashPlaceDetails real (snapshot-on-change depends on it); mock only the network call.
vi.mock('@ainyc/canonry-integration-google-places', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google-places')>(
    '@ainyc/canonry-integration-google-places',
  )
  return { ...actual, getPlaceDetails: (...a: unknown[]) => getPlaceDetailsMock(...a) }
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

function listedLocation(opts: { placeId?: string | null; description?: string | null } = {}): GbpLocation {
  return {
    name: LOCATION,
    title: 'Gjelina Venice',
    profile: opts.description === undefined || opts.description === null
      ? undefined
      : { description: opts.description },
    metadata: opts.placeId ? { placeId: opts.placeId, mapsUri: `https://maps.google.com/?q=${opts.placeId}` } : undefined,
  }
}

function seedProject(db: ReturnType<typeof createClient>, opts: { placeId?: string; description?: string | null } = {}) {
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
    placeId: opts.placeId ?? null,
    description: opts.description ?? null,
    selected: true,
    createdAt: now,
    updatedAt: now,
  }).run()
  listLocationsMock.mockResolvedValue([listedLocation({ placeId: opts.placeId ?? null, description: opts.description ?? null })])
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
  listLocationsMock.mockResolvedValue([listedLocation()])
  fetchDailyMetricsMock.mockResolvedValue([])
  listPlaceActionLinksMock.mockResolvedValue([])
  getLodgingMock.mockResolvedValue(null)
  getAttributesMock.mockResolvedValue([])
  getPlaceDetailsMock.mockResolvedValue({ id: 'place_default', servesBreakfast: true, allowsDogs: false })
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

describe('executeGbpSync — selected location profile refresh', () => {
  test('refreshes owner profile fields from the Business Information API during sync', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { description: null })
      listLocationsMock.mockResolvedValue([{
        ...listedLocation({ description: 'Fresh owner description.' }),
        categories: {
          primaryCategory: { displayName: 'Restaurant' },
          additionalCategories: [{ displayName: 'Hotel' }],
        },
        storefrontAddress: {
          addressLines: ['1429 Abbot Kinney Blvd'],
          locality: 'Venice',
          administrativeArea: 'CA',
          postalCode: '90291',
          regionCode: 'US',
        },
        websiteUri: 'https://gjelina.example.com',
        phoneNumbers: { primaryPhone: '+1 310-555-1212' },
        openInfo: { status: 'OPEN', openingDate: { year: 2008 } },
      }])
      seedRun(db, 'run_1')

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })

      expect(listLocationsMock).toHaveBeenCalledWith('tok', 'accounts/1')
      const row = db.select().from(gbpLocations).where(eq(gbpLocations.id, 'loc_1')).get()
      expect(row!.description).toBe('Fresh owner description.')
      expect(row!.primaryCategoryDisplayName).toBe('Restaurant')
      expect(row!.additionalCategories).toEqual(['Hotel'])
      expect(row!.storefrontAddress).toBe('1429 Abbot Kinney Blvd, Venice, CA, 90291, US')
      expect(row!.websiteUri).toBe('https://gjelina.example.com')
      expect(row!.primaryPhone).toBe('+1 310-555-1212')
      expect(row!.openStatus).toBe('OPEN')
      expect(row!.openingDate).toBe('2008')
      expect(row!.syncedAt).toBeTruthy()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
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

describe('executeGbpSync — Places enrichment (#648)', () => {
  const PLACE_ID = 'ChIJgjelina'
  const LODGING = { name: `${LOCATION}/lodging`, pools: { pool: true } }

  function placesConfig(places: NonNullable<CanonryConfig['places']>): CanonryConfig {
    return { ...testConfig(), places }
  }

  function placeRows(db: ReturnType<typeof createClient>) {
    return db.select().from(gbpPlaceDetails).where(eq(gbpPlaceDetails.projectId, 'proj_gbp')).all()
  }

  test('snapshots Place Details for a lodging location with a placeId + key', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { placeId: PLACE_ID })
      seedRun(db, 'run_1')
      getLodgingMock.mockResolvedValue(LODGING)
      getPlaceDetailsMock.mockResolvedValue({ id: 'p', servesBreakfast: true, allowsDogs: false })

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: placesConfig({ apiKey: 'K', tier: 'atmosphere' }) })

      expect(getPlaceDetailsMock).toHaveBeenCalledWith(PLACE_ID, 'K', expect.objectContaining({ tier: 'atmosphere' }))
      const rows = placeRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.placeId).toBe(PLACE_ID)
      expect(rows[0]!.tier).toBe('atmosphere')
      expect(rows[0]!.syncRunId).toBe('run_1')
      expect((rows[0]!.attributes as { servesBreakfast?: boolean }).servesBreakfast).toBe(true)
      expect(db.select().from(runs).where(eq(runs.id, 'run_1')).get()!.status).toBe('completed')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('does NOT call Places when no API key is configured', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { placeId: PLACE_ID })
      seedRun(db, 'run_1')
      getLodgingMock.mockResolvedValue(LODGING)

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() }) // no places config

      expect(getPlaceDetailsMock).not.toHaveBeenCalled()
      expect(placeRows(db)).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('does NOT call Places when tier is off', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { placeId: PLACE_ID })
      seedRun(db, 'run_1')
      getLodgingMock.mockResolvedValue(LODGING)

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: placesConfig({ apiKey: 'K', tier: 'off' }) })

      expect(getPlaceDetailsMock).not.toHaveBeenCalled()
      expect(placeRows(db)).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('does NOT call Places for a non-lodging location', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { placeId: PLACE_ID })
      seedRun(db, 'run_1')
      getLodgingMock.mockResolvedValue(null) // not lodging-capable

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: placesConfig({ apiKey: 'K', tier: 'atmosphere' }) })

      expect(getPlaceDetailsMock).not.toHaveBeenCalled()
      expect(placeRows(db)).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('does NOT call Places when the location has no placeId', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db) // no placeId
      seedRun(db, 'run_1')
      getLodgingMock.mockResolvedValue(LODGING)

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: placesConfig({ apiKey: 'K', tier: 'atmosphere' }) })

      expect(getPlaceDetailsMock).not.toHaveBeenCalled()
      expect(placeRows(db)).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('refresh cadence: skips the Places call on an immediate re-run within the interval', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { placeId: PLACE_ID })
      getLodgingMock.mockResolvedValue(LODGING)
      const cfg = placesConfig({ apiKey: 'K', tier: 'atmosphere', refreshIntervalDays: 7 })

      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: cfg })
      seedRun(db, 'run_2')
      await executeGbpSync(db, 'run_2', 'proj_gbp', { config: cfg })

      // Snapshot from run_1 is seconds old (< 7d) → run_2 must not re-fetch.
      expect(getPlaceDetailsMock).toHaveBeenCalledTimes(1)
      expect(placeRows(db)).toHaveLength(1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('refresh cadence: a stable listing past the interval is not re-fetched on every sync', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { placeId: PLACE_ID })
      getLodgingMock.mockResolvedValue(LODGING)
      const content = { id: 'p', servesBreakfast: true }
      getPlaceDetailsMock.mockResolvedValue(content)
      const cfg = placesConfig({ apiKey: 'K', tier: 'atmosphere', refreshIntervalDays: 7 })

      // Existing snapshot 10 days old whose content matches what the next fetch
      // returns, so the fetch finds the listing UNCHANGED (the common steady
      // state — amenities change rarely).
      db.insert(gbpPlaceDetails).values({
        id: 'seed', projectId: 'proj_gbp', locationName: LOCATION, placeId: PLACE_ID,
        contentHash: hashPlaceDetails(content), tier: 'atmosphere', attributes: content,
        syncedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), syncRunId: null,
      }).run()

      // First sync: 10d old → re-fetch; unchanged → no new row, but the row's
      // syncedAt is re-stamped to now so the cadence gate can throttle next time.
      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: cfg })
      expect(getPlaceDetailsMock).toHaveBeenCalledTimes(1)
      expect(placeRows(db)).toHaveLength(1)

      // Immediate second sync: just verified (< 7d) → must NOT re-fetch (the bug
      // was that an unchanged listing past the interval re-fetched every sync).
      seedRun(db, 'run_2')
      await executeGbpSync(db, 'run_2', 'proj_gbp', { config: cfg })
      expect(getPlaceDetailsMock).toHaveBeenCalledTimes(1)
      expect(placeRows(db)).toHaveLength(1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('snapshot-on-change: re-fetch with identical content adds no new row; changed content does', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { placeId: PLACE_ID })
      getLodgingMock.mockResolvedValue(LODGING)
      const cfg = placesConfig({ apiKey: 'K', tier: 'atmosphere', refreshIntervalDays: 0 }) // always re-fetch

      getPlaceDetailsMock.mockResolvedValue({ id: 'p', servesBreakfast: true })
      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: cfg })
      seedRun(db, 'run_2')
      await executeGbpSync(db, 'run_2', 'proj_gbp', { config: cfg })
      // Identical content → no second row even though the fetch ran twice.
      expect(getPlaceDetailsMock).toHaveBeenCalledTimes(2)
      expect(placeRows(db)).toHaveLength(1)

      // Changed content → a new snapshot.
      getPlaceDetailsMock.mockResolvedValue({ id: 'p', servesBreakfast: false })
      seedRun(db, 'run_3')
      await executeGbpSync(db, 'run_3', 'proj_gbp', { config: cfg })
      expect(placeRows(db)).toHaveLength(2)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a Places API error does not fail the run (supplemental, best-effort)', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db, { placeId: PLACE_ID })
      seedRun(db, 'run_1')
      getLodgingMock.mockResolvedValue(LODGING)
      getPlaceDetailsMock.mockRejectedValue(new Error('Places 403 PERMISSION_DENIED'))

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: placesConfig({ apiKey: 'K', tier: 'atmosphere' }) })

      // Metrics/keywords/lodging succeeded → run completes; Places error swallowed.
      expect(db.select().from(runs).where(eq(runs.id, 'run_1')).get()!.status).toBe('completed')
      expect(placeRows(db)).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('executeGbpSync — lodging snapshot freshness', () => {
  const LODGING = { name: `${LOCATION}/lodging`, pools: { pool: true } }

  function lodgingRows(db: ReturnType<typeof createClient>) {
    return db.select().from(gbpLodgingSnapshots).where(eq(gbpLodgingSnapshots.projectId, 'proj_gbp')).all()
  }

  test('an unchanged lodging re-fetch re-stamps the latest snapshot (no new row, syncedAt advances)', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      getLodgingMock.mockResolvedValue(LODGING)

      // Existing snapshot 30 days old whose content matches what the fetch
      // returns, so the sync finds the lodging profile UNCHANGED — the common
      // steady state (hotel attributes change rarely). Before the touch this
      // row kept its 30-day-old syncedAt and read as stale.
      const oldSyncedAt = new Date(Date.now() - 30 * 86_400_000).toISOString()
      db.insert(gbpLodgingSnapshots).values({
        id: 'seed_lodging',
        projectId: 'proj_gbp',
        locationName: LOCATION,
        contentHash: hashLodging(LODGING),
        attributes: LODGING,
        populatedGroupCount: countPopulatedGroups(LODGING),
        syncedAt: oldSyncedAt,
        syncRunId: null,
      }).run()

      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })

      const rows = lodgingRows(db)
      expect(rows).toHaveLength(1)                  // unchanged → no duplicate row
      expect(rows[0]!.id).toBe('seed_lodging')       // same row, touched in place
      expect(rows[0]!.syncRunId).toBe('run_1')       // re-stamped by this run
      // Freshness advanced: the row no longer reads as 30 days stale.
      expect(new Date(rows[0]!.syncedAt).getTime()).toBeGreaterThan(new Date(oldSyncedAt).getTime())
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('changed lodging content appends a new snapshot (snapshot-on-change preserved)', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)

      getLodgingMock.mockResolvedValue(LODGING)
      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })
      expect(lodgingRows(db)).toHaveLength(1)

      // Different attributes → a new content hash → a new snapshot row, so the
      // touch must not swallow a genuine change.
      getLodgingMock.mockResolvedValue({ ...LODGING, services: { roomService: true } })
      seedRun(db, 'run_2')
      await executeGbpSync(db, 'run_2', 'proj_gbp', { config: testConfig() })
      expect(lodgingRows(db)).toHaveLength(2)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('first-ever lodging sync inserts a snapshot (no prior row to touch)', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      getLodgingMock.mockResolvedValue(LODGING)

      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })

      const rows = lodgingRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.syncRunId).toBe('run_1')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('executeGbpSync — owner-set attributes snapshot', () => {
  const ATTRS = [
    { name: 'attributes/has_onsite_services', valueType: 'BOOL', values: [true], unsetValues: [], uris: [] },
    { name: 'attributes/url_instagram', valueType: 'URL', values: [], unsetValues: [], uris: ['https://instagram.com/x'] },
  ]

  function attrRows(db: ReturnType<typeof createClient>) {
    return db.select().from(gbpAttributesSnapshots).where(eq(gbpAttributesSnapshots.projectId, 'proj_gbp')).all()
  }

  test('first sync writes a snapshot with the owner attributes + count', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      getAttributesMock.mockResolvedValue(ATTRS)
      seedRun(db, 'run_1')

      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })

      const rows = attrRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.attributeCount).toBe(2)
      expect(rows[0]!.syncRunId).toBe('run_1')
      expect(rows[0]!.attributes).toEqual(ATTRS)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('unchanged attributes re-stamp the latest row (no duplicate)', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      getAttributesMock.mockResolvedValue(ATTRS)
      const oldSyncedAt = new Date(Date.now() - 30 * 86_400_000).toISOString()
      db.insert(gbpAttributesSnapshots).values({
        id: 'seed_attrs',
        projectId: 'proj_gbp',
        locationName: LOCATION,
        contentHash: hashAttributes(ATTRS),
        attributes: ATTRS,
        attributeCount: 2,
        syncedAt: oldSyncedAt,
        syncRunId: null,
      }).run()

      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })

      const rows = attrRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).toBe('seed_attrs')
      expect(rows[0]!.syncRunId).toBe('run_1')
      expect(new Date(rows[0]!.syncedAt).getTime()).toBeGreaterThan(new Date(oldSyncedAt).getTime())
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('changed attributes append a new snapshot', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      getAttributesMock.mockResolvedValue(ATTRS)
      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })
      expect(attrRows(db)).toHaveLength(1)

      getAttributesMock.mockResolvedValue([...ATTRS, { name: 'attributes/is_owned_by_women', valueType: 'BOOL', values: [true], unsetValues: [], uris: [] }])
      seedRun(db, 'run_2')
      await executeGbpSync(db, 'run_2', 'proj_gbp', { config: testConfig() })
      const rows = attrRows(db)
      expect(rows).toHaveLength(2)
      expect(Math.max(...rows.map((r) => r.attributeCount))).toBe(3)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('changed REPEATED_ENUM unset values append a new snapshot', async () => {
    const { db, tmpDir } = createTempDb()
    try {
      seedProject(db)
      getAttributesMock.mockResolvedValue([{ name: 'attributes/payments', valueType: 'REPEATED_ENUM', values: ['cash'], unsetValues: ['check'], uris: [] }])
      seedRun(db, 'run_1')
      await executeGbpSync(db, 'run_1', 'proj_gbp', { config: testConfig() })
      expect(attrRows(db)).toHaveLength(1)

      getAttributesMock.mockResolvedValue([{ name: 'attributes/payments', valueType: 'REPEATED_ENUM', values: ['cash'], unsetValues: ['credit_card'], uris: [] }])
      seedRun(db, 'run_2')
      await executeGbpSync(db, 'run_2', 'proj_gbp', { config: testConfig() })

      const rows = attrRows(db)
      const expectedHashes = [
        hashAttributes([{ name: 'attributes/payments', valueType: 'REPEATED_ENUM', values: ['cash'], unsetValues: ['check'], uris: [] }]),
        hashAttributes([{ name: 'attributes/payments', valueType: 'REPEATED_ENUM', values: ['cash'], unsetValues: ['credit_card'], uris: [] }]),
      ]
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.contentHash).sort()).toEqual(expectedHashes.sort())
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
