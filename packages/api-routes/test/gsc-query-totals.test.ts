import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import { createClient, migrate, projects, runs, gscQueryDailyTotals, gscSearchData } from '@ainyc/canonry-db'
import { mergeGscQueryTotalsWithFallback, readGscQueryDailyFallbackRows, readGscQueryDailyRows } from '../src/gsc-totals.js'

/**
 * `gsc_search_data` carries the `page` dimension, so one SERP showing several
 * of the site's URLs becomes several rows. Summing it by query multiplies
 * impressions by how many pages ranked together. Measured on a live property:
 * "harborline hotel" read 11,900 impressions summed against a true 2,000 (+495%),
 * while single-page queries were within 1%.
 */
describe('mergeGscQueryTotalsWithFallback', () => {
  const day = (date: string, query: string, clicks: number, impressions: number, position = 3) =>
    ({ date, query, clicks, impressions, position })

  test('prefers the accurate source for a day both cover', () => {
    const merged = mergeGscQueryTotalsWithFallback(
      [day('2026-07-01', 'harborline hotel', 4, 2000, 3.8)],
      [day('2026-07-01', 'harborline hotel', 4, 11900, 4.4)],
    )
    expect(merged[0]!.impressions).toBe(2000)
    expect(merged[0]!.source).toBe('google')
  })

  test('KEEPS legacy days the backfill has not reached (the partial-window bug)', () => {
    // A 3-day window where only the newest day is backfilled. Aggregating
    // first and then preferring the accurate total would report ONLY day 3
    // (100) and silently drop days 1-2 — a 90-day report undercounting to
    // whatever the backfill reached.
    const merged = mergeGscQueryTotalsWithFallback(
      [day('2026-07-03', 'q', 1, 100)],
      [day('2026-07-01', 'q', 1, 500), day('2026-07-02', 'q', 1, 500), day('2026-07-03', 'q', 1, 900)],
    )
    expect(merged).toHaveLength(1)
    // 500 + 500 legacy + 100 accurate (replacing the 900 legacy for that day).
    expect(merged[0]!.impressions).toBe(1100)
    expect(merged[0]!.clicks).toBe(3)
  })

  test('reports `mixed` when a window spans both sources', () => {
    const merged = mergeGscQueryTotalsWithFallback(
      [day('2026-07-03', 'q', 1, 100)],
      [day('2026-07-01', 'q', 1, 500), day('2026-07-03', 'q', 1, 900)],
    )
    expect(merged[0]!.source).toBe('mixed')
  })

  test('reports `google` only when every day is accurate', () => {
    const merged = mergeGscQueryTotalsWithFallback(
      [day('2026-07-01', 'q', 1, 10), day('2026-07-02', 'q', 1, 20)],
      [day('2026-07-01', 'q', 1, 99), day('2026-07-02', 'q', 1, 99)],
    )
    expect(merged[0]!.impressions).toBe(30)
    expect(merged[0]!.source).toBe('google')
  })

  test('reports `page-summed` when no accurate day exists', () => {
    const merged = mergeGscQueryTotalsWithFallback([], [day('2026-07-01', 'q', 1, 500)])
    expect(merged[0]!.source).toBe('page-summed')
    expect(merged[0]!.impressions).toBe(500)
  })

  test('a partially-backfilled query never loses to a fully-backfilled one', () => {
    // Ordering regression: `slow` has 3 legacy days, `fast` has 1 accurate day.
    // Under the aggregate-then-prefer bug `slow` would collapse to its single
    // accurate day and sort below `fast`.
    const merged = mergeGscQueryTotalsWithFallback(
      [day('2026-07-03', 'slow', 0, 50), day('2026-07-03', 'fast', 0, 400)],
      [
        day('2026-07-01', 'slow', 0, 600), day('2026-07-02', 'slow', 0, 600), day('2026-07-03', 'slow', 0, 600),
        day('2026-07-03', 'fast', 0, 400),
      ],
    ).sort((a, b) => b.impressions - a.impressions)
    expect(merged[0]!.query).toBe('slow')
    expect(merged[0]!.impressions).toBe(1250)
  })

  test('weights position by impressions across merged days', () => {
    // (2.0*100 + 3.0*400) / 500 = 2.8, not the plain mean 2.5.
    const merged = mergeGscQueryTotalsWithFallback(
      [day('2026-07-01', 'q', 0, 100, 2.0), day('2026-07-02', 'q', 0, 400, 3.0)],
      [],
    )
    expect(merged[0]!.position).toBeCloseTo(2.8, 10)
  })

  test('falls back to an unweighted position when the window has no impressions', () => {
    const merged = mergeGscQueryTotalsWithFallback(
      [day('2026-07-01', 'q', 0, 0, 4), day('2026-07-02', 'q', 0, 0, 6)],
      [],
    )
    expect(merged[0]!.position).toBe(5)
  })

  test('returns nothing for two empty sources', () => {
    expect(mergeGscQueryTotalsWithFallback([], [])).toEqual([])
  })

  test('reports the distinct days a query appeared across both sources', () => {
    // Day 1 legacy only, day 2 both (one day, not two), day 3 accurate only.
    const merged = mergeGscQueryTotalsWithFallback(
      [day('2026-07-02', 'blue widget', 1, 10), day('2026-07-03', 'blue widget', 1, 10), day('2026-07-03', 'red widget', 0, 5)],
      [day('2026-07-01', 'blue widget', 1, 50), day('2026-07-02', 'blue widget', 1, 90)],
    )
    const byQuery = new Map(merged.map(r => [r.query, r]))
    expect(byQuery.get('blue widget')!.days).toBe(3)
    expect(byQuery.get('red widget')!.days).toBe(1)
  })
})

describe('readGscQueryDailyRows', () => {
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  const projectId = 'p1'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-query-totals-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = '2026-07-21T00:00:00Z'
    db.insert(projects).values({
      id: projectId, name: 'p', displayName: 'P', canonicalDomain: 'example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
  })

  afterEach(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seed(date: string, query: string, clicks: number, impressions: number, position: string) {
    db.insert(gscQueryDailyTotals).values({
      id: crypto.randomUUID(), projectId, date, query, clicks, impressions,
      position, syncedAt: '2026-07-21T00:00:00Z', createdAt: '2026-07-21T00:00:00Z',
    }).run()
  }

  test('returns one row per (date, query), not a per-query fold', () => {
    seed('2026-07-01', 'harborline', 10, 100, '2.0')
    seed('2026-07-02', 'harborline', 5, 400, '3.0')
    const rows = readGscQueryDailyRows(db, projectId, '2026-07-01', '2026-07-31')
    // Day grain is the contract: the merge needs it to decide source per day.
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.date).sort()).toEqual(['2026-07-01', '2026-07-02'])
    expect(rows.every(r => r.query === 'harborline')).toBe(true)
  })

  test('parses position out of its text column', () => {
    seed('2026-07-01', 'harborline', 10, 100, '2.5')
    const [row] = readGscQueryDailyRows(db, projectId, '2026-07-01', '2026-07-31')
    expect(row!.position).toBe(2.5)
  })

  test('coerces an unparseable position to 0 rather than NaN', () => {
    seed('2026-07-01', 'harborline', 10, 100, 'not-a-number')
    const [row] = readGscQueryDailyRows(db, projectId, '2026-07-01', '2026-07-31')
    expect(row!.position).toBe(0)
  })

  test('respects the date window', () => {
    seed('2026-06-30', 'harborline', 99, 999, '9.0')
    seed('2026-07-01', 'harborline', 10, 100, '2.0')
    const rows = readGscQueryDailyRows(db, projectId, '2026-07-01', '2026-07-31')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.impressions).toBe(100)
  })

  test('returns nothing when no rows exist for the window', () => {
    expect(readGscQueryDailyRows(db, projectId, '2026-07-01', '2026-07-31')).toEqual([])
  })

  test('round-trips through the merge to a correct per-query total', () => {
    seed('2026-07-01', 'harborline', 10, 100, '2.0')
    seed('2026-07-02', 'harborline', 5, 400, '3.0')
    const merged = mergeGscQueryTotalsWithFallback(
      readGscQueryDailyRows(db, projectId, '2026-07-01', '2026-07-31'),
      [],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.clicks).toBe(15)
    expect(merged[0]!.impressions).toBe(500)
    expect(merged[0]!.position).toBeCloseTo(2.8, 10)
    expect(merged[0]!.source).toBe('google')
  })
})

describe('readGscQueryDailyFallbackRows', () => {
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  const projectId = 'p1'
  const runId = 'r1'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-query-fallback-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = '2026-07-21T00:00:00Z'
    db.insert(projects).values({
      id: projectId, name: 'p', displayName: 'P', canonicalDomain: 'example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
    db.insert(runs).values({
      id: runId, projectId, kind: 'gsc-sync', status: 'completed', trigger: 'manual', createdAt: now,
    }).run()
  })

  afterEach(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedPage(date: string, query: string, page: string, clicks: number, impressions: number, position: string) {
    db.insert(gscSearchData).values({
      id: crypto.randomUUID(), projectId, syncRunId: runId, date, query, page,
      country: 'usa', device: 'DESKTOP', clicks, impressions, ctr: '0', position,
      createdAt: '2026-07-21T00:00:00Z',
    }).run()
  }

  test('folds page rows to one row per (date, query) with an impression-weighted position', () => {
    seedPage('2026-07-01', 'blue widget', 'https://example.com/a', 3, 100, '2.0')
    seedPage('2026-07-01', 'blue widget', 'https://example.com/b', 1, 400, '3.0')
    seedPage('2026-07-02', 'blue widget', 'https://example.com/a', 2, 50, '4.0')
    const rows = readGscQueryDailyFallbackRows(db, projectId, '2026-07-01', '2026-07-31')
      .sort((a, b) => a.date.localeCompare(b.date))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ date: '2026-07-01', query: 'blue widget', clicks: 4, impressions: 500, position: expect.closeTo(2.8, 10) })
    expect(rows[1]).toEqual({ date: '2026-07-02', query: 'blue widget', clicks: 2, impressions: 50, position: 4 })
  })

  test('casts text positions', () => {
    // A text compare would sort '10.5' below '9.0'; the arithmetic must be numeric.
    seedPage('2026-07-01', 'blue widget', 'https://example.com/a', 0, 10, '10.5')
    seedPage('2026-07-01', 'blue widget', 'https://example.com/b', 0, 30, '9.5')
    const [row] = readGscQueryDailyFallbackRows(db, projectId, '2026-07-01', '2026-07-31')
    expect(typeof row!.position).toBe('number')
    // (10.5*10 + 9.5*30) / 40 = 9.75
    expect(row!.position).toBeCloseTo(9.75, 10)
  })

  test('skips empty queries', () => {
    seedPage('2026-07-01', '', 'https://example.com/a', 7, 700, '1.0')
    seedPage('2026-07-01', 'blue widget', 'https://example.com/a', 1, 10, '2.0')
    const rows = readGscQueryDailyFallbackRows(db, projectId, '2026-07-01', '2026-07-31')
    expect(rows.map(r => r.query)).toEqual(['blue widget'])
  })

  test('respects the window', () => {
    seedPage('2026-06-30', 'blue widget', 'https://example.com/a', 9, 900, '1.0')
    seedPage('2026-07-01', 'blue widget', 'https://example.com/a', 1, 10, '2.0')
    seedPage('2026-07-31', 'blue widget', 'https://example.com/a', 1, 20, '2.0')
    seedPage('2026-08-01', 'blue widget', 'https://example.com/a', 9, 900, '1.0')
    const rows = readGscQueryDailyFallbackRows(db, projectId, '2026-07-01', '2026-07-31')
    expect(rows.map(r => r.date).sort()).toEqual(['2026-07-01', '2026-07-31'])
    expect(rows.reduce((n, r) => n + r.impressions, 0)).toBe(30)
  })
})
