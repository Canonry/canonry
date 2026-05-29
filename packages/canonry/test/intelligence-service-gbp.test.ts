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
        expect(i.id.startsWith('run_gbp::gbp::locations/A::')).toBe(true)
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
      const lodgingId = 'run_gbp::gbp::locations/A::gbp-lodging-gap'
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
})
