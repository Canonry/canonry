import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import { createClient, migrate, projects, gscQueryDailyTotals } from '@ainyc/canonry-db'
import { mergeGscQueryTotalsWithFallback, readGscQueryTotals } from '../src/gsc-totals.js'

/**
 * `gsc_search_data` carries the `page` dimension, so one SERP showing several
 * of the site's URLs becomes several rows. Summing it by query multiplies
 * impressions by how many pages ranked together. Measured on a live property:
 * "gjelina hotel" read 14,366 impressions summed against a true 2,415 (+495%),
 * while single-page queries were within 1%.
 */
describe('mergeGscQueryTotalsWithFallback', () => {
  const fallback = [
    { query: 'gjelina', clicks: 120, impressions: 11518, position: 2.1 },
    { query: 'gjelina hotel', clicks: 40, impressions: 14366, position: 4.4 },
  ]

  test('prefers Google per-query rows over the page-summed fallback', () => {
    const merged = mergeGscQueryTotalsWithFallback(
      [{ query: 'gjelina hotel', clicks: 40, impressions: 2415, position: 3.8 }],
      fallback,
    )
    const hotel = merged.find(r => r.query === 'gjelina hotel')!
    expect(hotel.impressions).toBe(2415)
    expect(hotel.position).toBe(3.8)
    expect(hotel.source).toBe('google')
  })

  test('keeps the fallback for queries the accurate fetch has not covered', () => {
    const merged = mergeGscQueryTotalsWithFallback(
      [{ query: 'gjelina hotel', clicks: 40, impressions: 2415, position: 3.8 }],
      fallback,
    )
    const brand = merged.find(r => r.query === 'gjelina')!
    expect(brand.impressions).toBe(11518)
    expect(brand.source).toBe('page-summed')
  })

  test('never blends the two sources silently', () => {
    const merged = mergeGscQueryTotalsWithFallback(
      [{ query: 'gjelina hotel', clicks: 40, impressions: 2415, position: 3.8 }],
      fallback,
    )
    // Every row is labelled, so a caller can tell an accurate impression count
    // from an inflated one.
    expect(merged.every(r => r.source === 'google' || r.source === 'page-summed')).toBe(true)
    expect(new Set(merged.map(r => r.source))).toEqual(new Set(['google', 'page-summed']))
  })

  test('corrects an impressions-ordered ranking', () => {
    // Page-summed order puts the multi-page query first. Google's real numbers
    // put it second. A surface that sorts by impressions reports the wrong
    // top query until this merge runs.
    const bySummed = [...fallback].sort((a, b) => b.impressions - a.impressions)
    expect(bySummed[0]!.query).toBe('gjelina hotel')

    const merged = mergeGscQueryTotalsWithFallback(
      [
        { query: 'gjelina', clicks: 120, impressions: 11384, position: 2.1 },
        { query: 'gjelina hotel', clicks: 40, impressions: 2415, position: 3.8 },
      ],
      fallback,
    ).sort((a, b) => b.impressions - a.impressions)
    expect(merged[0]!.query).toBe('gjelina')
  })

  test('an empty accurate set leaves the fallback untouched', () => {
    const merged = mergeGscQueryTotalsWithFallback([], fallback)
    expect(merged).toHaveLength(2)
    expect(merged.every(r => r.source === 'page-summed')).toBe(true)
  })
})

describe('readGscQueryTotals', () => {
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

  test('sums clicks and impressions across days for one query', () => {
    seed('2026-07-01', 'gjelina', 10, 100, '2.0')
    seed('2026-07-02', 'gjelina', 5, 400, '3.0')
    const [row] = readGscQueryTotals(db, projectId, '2026-07-01', '2026-07-31')
    expect(row!.clicks).toBe(15)
    expect(row!.impressions).toBe(500)
  })

  test('weights position by impressions, not a plain average', () => {
    // Plain mean of 2.0 and 3.0 would be 2.5. Impression-weighted:
    // (2.0*100 + 3.0*400) / 500 = 2.8. Position is not additive across days.
    seed('2026-07-01', 'gjelina', 10, 100, '2.0')
    seed('2026-07-02', 'gjelina', 5, 400, '3.0')
    const [row] = readGscQueryTotals(db, projectId, '2026-07-01', '2026-07-31')
    expect(row!.position).toBeCloseTo(2.8, 10)
  })

  test('respects the date window', () => {
    seed('2026-06-30', 'gjelina', 99, 999, '9.0')
    seed('2026-07-01', 'gjelina', 10, 100, '2.0')
    const [row] = readGscQueryTotals(db, projectId, '2026-07-01', '2026-07-31')
    expect(row!.impressions).toBe(100)
  })

  test('returns nothing when no rows exist for the window', () => {
    expect(readGscQueryTotals(db, projectId, '2026-07-01', '2026-07-31')).toEqual([])
  })

  test('does not divide by zero when a query has no impressions', () => {
    seed('2026-07-01', 'zero', 0, 0, '0')
    const [row] = readGscQueryTotals(db, projectId, '2026-07-01', '2026-07-31')
    expect(row!.position).toBe(0)
    expect(row!.impressions).toBe(0)
  })
})
