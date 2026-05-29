import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  runs,
  insights,
  healthSnapshots,
  gbpLocations,
  gbpDailyMetrics,
  gbpPlaceActions,
  gbpLodgingSnapshots,
  gbpKeywordMonthly,
  gbpPlaceDetails,
} from '@ainyc/canonry-db'
import { IntelligenceService } from '../src/intelligence-service.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gbp-intel-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return { db, tmpDir }
}

const NOW = '2026-05-25T00:00:00.000Z'
const STALE = '2026-05-20T00:00:00.000Z'

/**
 * Seed a project with two selected locations (A: unhealthy on every axis,
 * B: healthy) and one deselected location (C, must be ignored).
 */
function seed(db: ReturnType<typeof createClient>) {
  db.insert(projects).values({
    id: 'proj_gbp', name: 'gjelina', displayName: 'Gjelina', canonicalDomain: 'gjelina.example.com',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()

  db.insert(gbpLocations).values([
    { id: 'la', projectId: 'proj_gbp', accountName: 'accounts/1', locationName: 'locations/A', displayName: 'Gjelina Venice', selected: true, syncedAt: NOW, createdAt: NOW, updatedAt: NOW },
    { id: 'lb', projectId: 'proj_gbp', accountName: 'accounts/1', locationName: 'locations/B', displayName: 'Gjelina Marina', selected: true, syncedAt: NOW, createdAt: NOW, updatedAt: NOW },
    { id: 'lc', projectId: 'proj_gbp', accountName: 'accounts/1', locationName: 'locations/C', displayName: 'Gjelina Closed', selected: false, syncedAt: NOW, createdAt: NOW, updatedAt: NOW },
  ]).run()

  // Daily metrics: A drops 100 → 20 week-over-week (refDate = max date 2026-05-20);
  // B is flat. C (deselected) gets a drop too, to prove it's ignored.
  const metric = (id: string, loc: string, date: string, value: number) =>
    ({ id, projectId: 'proj_gbp', locationName: loc, date, metric: 'WEBSITE_CLICKS', value, syncRunId: null })
  db.insert(gbpDailyMetrics).values([
    metric('m1', 'locations/A', '2026-05-10', 100),
    metric('m2', 'locations/A', '2026-05-20', 20),
    metric('m3', 'locations/B', '2026-05-10', 50),
    metric('m4', 'locations/B', '2026-05-20', 50),
    metric('m5', 'locations/C', '2026-05-10', 100),
    metric('m6', 'locations/C', '2026-05-20', 5),
  ]).run()

  // Place actions: A has only an aggregator link; B has a direct merchant link.
  db.insert(gbpPlaceActions).values([
    { id: 'pa1', projectId: 'proj_gbp', locationName: 'locations/A', placeActionLinkName: 'x/1', placeActionType: 'BOOK', uri: 'https://ota.com', isPreferred: false, providerType: 'AGGREGATOR', syncRunId: null },
    { id: 'pa2', projectId: 'proj_gbp', locationName: 'locations/B', placeActionLinkName: 'x/2', placeActionType: 'BOOK', uri: 'https://gjelina.com', isPreferred: true, providerType: 'MERCHANT', syncRunId: null },
  ]).run()

  // Lodging: A is empty (AEO gap); B is populated.
  db.insert(gbpLodgingSnapshots).values([
    { id: 'lg1', projectId: 'proj_gbp', locationName: 'locations/A', contentHash: 'h1', attributes: {}, populatedGroupCount: 0, syncedAt: NOW, syncRunId: null },
    { id: 'lg2', projectId: 'proj_gbp', locationName: 'locations/B', contentHash: 'h2', attributes: {}, populatedGroupCount: 4, syncedAt: NOW, syncRunId: null },
  ]).run()

  // Keyword monthly: A's head term fell 100 → 30 month-over-month (70% → high).
  db.insert(gbpKeywordMonthly).values([
    { id: 'kw1', projectId: 'proj_gbp', locationName: 'locations/A', month: '2026-03', keyword: 'venice beach hotel', valueCount: 100, valueThreshold: null, syncRunId: null, syncedAt: NOW },
    { id: 'kw2', projectId: 'proj_gbp', locationName: 'locations/A', month: '2026-04', keyword: 'venice beach hotel', valueCount: 30, valueThreshold: null, syncRunId: null, syncedAt: NOW },
  ]).run()
}

function seedRun(db: ReturnType<typeof createClient>, runId: string, projectId = 'proj_gbp') {
  db.insert(runs).values({
    id: runId, projectId, kind: 'gbp-sync', status: 'completed', trigger: 'manual',
    createdAt: NOW, startedAt: NOW, finishedAt: NOW,
  }).run()
}

describe('IntelligenceService.analyzeAndPersistGbp', () => {
  test('persists location-scoped insights for unhealthy selected locations only', () => {
    const { db, tmpDir } = createTempDb()
    try {
      seed(db)
      seedRun(db, 'run_gbp')
      const service = new IntelligenceService(db)

      const result = service.analyzeAndPersistGbp('run_gbp', 'proj_gbp')

      // Location A is unhealthy on all four axes; B and C produce nothing.
      const types = result.map((i) => i.type).sort()
      expect(types).toEqual(['gbp-cta-gap', 'gbp-keyword-drop', 'gbp-lodging-gap', 'gbp-metric-drop'])
      for (const i of result) {
        expect(i.provider).toBe('gbp')
        expect(i.query).toBe('Gjelina Venice')
        expect(i.id.startsWith('proj_gbp::gbp::locations/A::')).toBe(true)
      }

      // Severities: lodging high, cta medium, metric -80% high, keyword -70% high.
      const sev = Object.fromEntries(result.map((i) => [i.type, i.severity]))
      expect(sev['gbp-lodging-gap']).toBe('high')
      expect(sev['gbp-cta-gap']).toBe('medium')
      expect(sev['gbp-metric-drop']).toBe('high')
      expect(sev['gbp-keyword-drop']).toBe('high')

      // Persisted to the insights table; nothing references the deselected loc C.
      const rows = db.select().from(insights).where(eq(insights.runId, 'run_gbp')).all()
      expect(rows).toHaveLength(4)
      expect(rows.every((r) => r.id.includes('locations/A'))).toBe(true)
      expect(rows.some((r) => r.id.includes('locations/C'))).toBe(false)

      // GBP runs never write a health snapshot.
      expect(db.select().from(healthSnapshots).where(eq(healthSnapshots.runId, 'run_gbp')).all()).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('upgrades the lodging gap to gbp-listing-discrepancy when a Places snapshot shows amenities (#648)', () => {
    const { db, tmpDir } = createTempDb()
    try {
      seed(db)
      // Location A has an EMPTY lodging profile but a Places snapshot proving
      // its public listing advertises amenities — the evidence-backed case.
      db.insert(gbpPlaceDetails).values({
        id: 'pd1', projectId: 'proj_gbp', locationName: 'locations/A', placeId: 'ChIJa',
        contentHash: 'ph1', tier: 'atmosphere',
        attributes: { servesBreakfast: true, allowsDogs: true, parkingOptions: { freeParkingLot: true } },
        syncedAt: NOW, syncRunId: null,
      }).run()
      seedRun(db, 'run_gbp')

      const result = new IntelligenceService(db).analyzeAndPersistGbp('run_gbp', 'proj_gbp')
      const types = result.map((i) => i.type).sort()

      // The discrepancy supersedes the generic lodging-gap for location A.
      expect(types).toContain('gbp-listing-discrepancy')
      expect(types).not.toContain('gbp-lodging-gap')
      const disc = result.find((i) => i.type === 'gbp-listing-discrepancy')!
      expect(disc.severity).toBe('high')
      expect(disc.query).toBe('Gjelina Venice')
      // The reason names the specific amenities extracted from the Places snapshot.
      expect(disc.recommendation?.reason).toContain('breakfast')
      expect(disc.recommendation?.reason).toContain('parking')
      expect(disc.recommendation?.reason).toContain('pet-friendly')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('returns empty and writes nothing when no locations are selected', () => {
    const { db, tmpDir } = createTempDb()
    try {
      db.insert(projects).values({
        id: 'proj_empty', name: 'empty', displayName: 'Empty', canonicalDomain: 'empty.example.com',
        country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
      }).run()
      seedRun(db, 'run_empty', 'proj_empty')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersistGbp('run_empty', 'proj_empty')
      expect(result).toEqual([])
      expect(db.select().from(insights).where(eq(insights.runId, 'run_empty')).all()).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('ignores stale location data that was not synced during the current run', () => {
    const { db, tmpDir } = createTempDb()
    try {
      seed(db)
      db.update(gbpLocations)
        .set({ syncedAt: STALE, updatedAt: STALE })
        .where(eq(gbpLocations.projectId, 'proj_gbp'))
        .run()
      seedRun(db, 'run_stale')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersistGbp('run_stale', 'proj_gbp')

      expect(result).toEqual([])
      expect(db.select().from(insights).where(eq(insights.runId, 'run_stale')).all()).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('preserves a dismissed insight across re-analysis of the same run', () => {
    const { db, tmpDir } = createTempDb()
    try {
      seed(db)
      seedRun(db, 'run_gbp')
      const service = new IntelligenceService(db)

      service.analyzeAndPersistGbp('run_gbp', 'proj_gbp')
      // Dismiss the lodging-gap insight.
      const lodgingId = 'proj_gbp::gbp::locations/A::lodging'
      db.update(insights).set({ dismissed: true }).where(eq(insights.id, lodgingId)).run()

      // Re-analyze the same run — the dismissed flag must survive.
      service.analyzeAndPersistGbp('run_gbp', 'proj_gbp')
      const row = db.select().from(insights).where(eq(insights.id, lodgingId)).get()
      expect(row).toBeDefined()
      expect(row!.dismissed).toBe(true)
      // Non-dismissed insights stay active.
      const cta = db.select().from(insights)
        .where(and(eq(insights.runId, 'run_gbp'), eq(insights.type, 'gbp-cta-gap'))).get()
      expect(cta!.dismissed).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('replaces prior-run insights instead of duplicating, and supersedes the lodging gap across runs', () => {
    const { db, tmpDir } = createTempDb()
    try {
      seed(db)
      const service = new IntelligenceService(db)

      // First sync: location A has an empty lodging profile, no Places data.
      seedRun(db, 'run_1')
      service.analyzeAndPersistGbp('run_1', 'proj_gbp')
      expect(db.select().from(insights).where(eq(insights.provider, 'gbp')).all().map((r) => r.type).sort())
        .toEqual(['gbp-cta-gap', 'gbp-keyword-drop', 'gbp-lodging-gap', 'gbp-metric-drop'])

      // A Places snapshot now proves the public listing advertises amenities.
      db.insert(gbpPlaceDetails).values({
        id: 'pd1', projectId: 'proj_gbp', locationName: 'locations/A', placeId: 'ChIJa',
        contentHash: 'ph1', tier: 'atmosphere',
        attributes: { servesBreakfast: true, parkingOptions: { freeParkingLot: true } },
        syncedAt: NOW, syncRunId: null,
      }).run()

      // Second sync must NOT duplicate: still exactly 4 GBP insights for the
      // project, and the lodging slot now holds the discrepancy (gap superseded).
      seedRun(db, 'run_2')
      service.analyzeAndPersistGbp('run_2', 'proj_gbp')
      const after = db.select().from(insights).where(eq(insights.provider, 'gbp')).all()
      expect(after).toHaveLength(4)
      expect(after.map((r) => r.type).sort())
        .toEqual(['gbp-cta-gap', 'gbp-keyword-drop', 'gbp-listing-discrepancy', 'gbp-metric-drop'])
      const lodgingRow = db.select().from(insights)
        .where(eq(insights.id, 'proj_gbp::gbp::locations/A::lodging')).get()
      expect(lodgingRow!.type).toBe('gbp-listing-discrepancy')
      // The latest run owns the refreshed rows.
      expect(after.every((r) => r.runId === 'run_2')).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('clears a location insight once its gap is resolved', () => {
    const { db, tmpDir } = createTempDb()
    try {
      seed(db)
      const service = new IntelligenceService(db)
      seedRun(db, 'run_1')
      service.analyzeAndPersistGbp('run_1', 'proj_gbp')
      expect(db.select().from(insights).where(eq(insights.id, 'proj_gbp::gbp::locations/A::lodging')).get()).toBeDefined()

      // Operator fills location A's lodging attributes — the gap is resolved.
      db.update(gbpLodgingSnapshots).set({ populatedGroupCount: 5 })
        .where(eq(gbpLodgingSnapshots.locationName, 'locations/A')).run()

      seedRun(db, 'run_2')
      service.analyzeAndPersistGbp('run_2', 'proj_gbp')
      // No lodging insight remains for A, and no stale duplicate lingers.
      expect(db.select().from(insights).where(eq(insights.id, 'proj_gbp::gbp::locations/A::lodging')).get()).toBeUndefined()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('preserves a dismissal across a later run that re-emits the same slot', () => {
    const { db, tmpDir } = createTempDb()
    try {
      seed(db)
      const service = new IntelligenceService(db)
      seedRun(db, 'run_1')
      service.analyzeAndPersistGbp('run_1', 'proj_gbp')
      const lodgingId = 'proj_gbp::gbp::locations/A::lodging'
      db.update(insights).set({ dismissed: true }).where(eq(insights.id, lodgingId)).run()

      // A later run re-emits the lodging gap for the same location/slot.
      seedRun(db, 'run_2')
      service.analyzeAndPersistGbp('run_2', 'proj_gbp')
      const row = db.select().from(insights).where(eq(insights.id, lodgingId)).get()
      expect(row).toBeDefined()
      expect(row!.dismissed).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
