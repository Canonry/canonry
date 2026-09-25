import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createClient, migrate, projects, runs, gscQueryDailyTotals, gscSearchData } from '@ainyc/canonry-db'
import {
  mergeGscQueryTotalsWithFallback, readGscQueryDailyFallbackRows, readGscQueryDailyRows,
  readGscQueryTotalsPage, type GscQueryAggregate,
} from '../src/gsc-totals.js'

/**
 * `readGscQueryTotalsPage` is the SQL form of the JS merge: it picks the source
 * per (date, query), aggregates per query, orders and pages inside SQLite so a
 * page never loads the whole window. These tests hold it to the JS merge over
 * the two readers, on the same stored rows, row for row. Every query and figure
 * is fictional.
 */

const NOW = '2026-07-21T00:00:00Z'
const PROJECT = 'p1'
const OTHER = 'p2'

/** Code point order, the order the contract promises (UTF-8 bytes compare the same way). */
function byCodePoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** The JS reference: the merge over both readers, in the route's order. */
function reference(
  db: ReturnType<typeof createClient>, projectId: string, start: string | null, end: string | null,
): GscQueryAggregate[] {
  const from = start ?? ''
  const to = end ?? '9999-12-31'
  return mergeGscQueryTotalsWithFallback(
    readGscQueryDailyRows(db, projectId, from, to),
    readGscQueryDailyFallbackRows(db, projectId, from, to),
  ).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || byCodePoint(a.query, b.query))
}

/**
 * Integer fields, the source tag and the order must match exactly. Position is
 * a float sum, and SQLite's SUM() compensates rounding (Kahan-Babuska-Neumaier)
 * where the JS loop adds naively, so the two may differ in the last bits; they
 * are held to 1e-12 relative, far below any displayed precision.
 */
function expectSameRows(actual: GscQueryAggregate[], expected: GscQueryAggregate[]) {
  expect(actual.map(r => r.query)).toEqual(expected.map(r => r.query))
  const strip = (r: GscQueryAggregate) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, days: r.days, source: r.source })
  expect(actual.map(strip)).toEqual(expected.map(strip))
  actual.forEach((row, i) => {
    const want = expected[i]!.position
    expect(Math.abs(row.position - want)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(want)))
  })
}

/** Deterministic PRNG (mulberry32), so a failing seed replays exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('readGscQueryTotalsPage', () => {
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-query-totals-sql-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    for (const id of [PROJECT, OTHER]) {
      db.insert(projects).values({
        id, name: id, displayName: id, canonicalDomain: `${id}.example.com`,
        country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
      }).run()
      db.insert(runs).values({
        id: `run-${id}`, projectId: id, kind: 'gsc-sync', status: 'completed', trigger: 'manual', createdAt: NOW,
      }).run()
    }
  })

  afterEach(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function accurate(date: string, query: string, clicks: number, impressions: number, position: string, projectId = PROJECT) {
    db.insert(gscQueryDailyTotals).values({
      id: crypto.randomUUID(), projectId, date, query, clicks, impressions, position, syncedAt: NOW, createdAt: NOW,
    }).run()
  }

  function page(date: string, query: string, url: string, clicks: number, impressions: number, position: string, projectId = PROJECT) {
    db.insert(gscSearchData).values({
      id: crypto.randomUUID(), projectId, syncRunId: `run-${projectId}`, date, query, page: url,
      country: 'usa', device: 'DESKTOP', clicks, impressions, ctr: '0', position, createdAt: NOW,
    }).run()
  }

  function all(start: string | null, end: string | null, projectId = PROJECT) {
    return readGscQueryTotalsPage(db, projectId, start, end, 1_000_000, 0)
  }

  test('matches the JS merge on the edge cases', () => {
    // Day covered by both sources: accurate wins, legacy fills the other days.
    page('2026-07-01', 'blue widget', 'https://p1.example.com/a', 2, 200, '4')
    page('2026-07-02', 'blue widget', 'https://p1.example.com/a', 9, 900, '4')
    page('2026-07-02', 'blue widget', 'https://p1.example.com/b', 1, 100, '7.25')
    accurate('2026-07-02', 'blue widget', 3, 300, '2')
    // Legacy only, fanned across two pages on one day.
    page('2026-07-01', 'red widget', 'https://p1.example.com/a', 1, 30, '10.5')
    page('2026-07-01', 'red widget', 'https://p1.example.com/b', 0, 10, '9.5')
    // Accurate only.
    accurate('2026-07-03', 'green widget', 4, 80, '1')
    // Zero impressions on every day: the plain mean of the daily positions.
    accurate('2026-07-01', 'quiet widget', 0, 0, '4')
    accurate('2026-07-02', 'quiet widget', 0, 0, '7')
    // Zero-impression legacy rows are not a query anyone saw.
    page('2026-07-01', 'ghost widget', 'https://p1.example.com/a', 0, 0, '3')
    // Zero on the accurate day, impressions on the legacy one.
    accurate('2026-07-01', 'half widget', 0, 0, '9')
    page('2026-07-02', 'half widget', 'https://p1.example.com/a', 0, 20, '3')
    // Empty queries: the legacy reader drops them; the accurate reader keeps them.
    page('2026-07-01', '', 'https://p1.example.com/a', 50, 5000, '1')
    accurate('2026-07-02', '', 1, 3, '2')
    // Ties on clicks and impressions, broken by code point: capitals, accents,
    // a private-use character and an emoji (UTF-16 order would put the emoji
    // before the private-use character; code point order puts it after).
    for (const q of ['alpha', 'Gamma', 'Élan', '\uE000 widget', '\u{1F600} widget', 'beta']) {
      accurate('2026-07-03', q, 5, 100, '5')
    }
    // Unparseable text positions become 0 in both readers.
    accurate('2026-07-03', 'odd widget', 1, 10, 'n/a')
    // Outside the window and in another project: never counted.
    accurate('2026-06-30', 'blue widget', 99, 9900, '1')
    page('2026-07-05', 'blue widget', 'https://p1.example.com/a', 99, 9900, '1')
    accurate('2026-07-02', 'blue widget', 77, 7700, '1', OTHER)
    page('2026-07-02', 'other widget', 'https://p2.example.com/a', 7, 70, '1', OTHER)

    const expected = reference(db, PROJECT, '2026-07-01', '2026-07-04')
    const { rows, totalMatching } = all('2026-07-01', '2026-07-04')
    expectSameRows(rows, expected)
    expect(totalMatching).toBe(expected.length)

    const byQuery = new Map(rows.map(r => [r.query, r]))
    expect(byQuery.get('blue widget')).toMatchObject({ clicks: 5, impressions: 500, days: 2, source: 'mixed' })
    expect(byQuery.get('red widget')).toMatchObject({ clicks: 1, impressions: 40, days: 1, source: 'page-summed' })
    expect(byQuery.get('red widget')!.position).toBeCloseTo(10.25, 12)
    expect(byQuery.get('quiet widget')!.position).toBe(5.5)
    expect(byQuery.get('half widget')).toMatchObject({ impressions: 20, days: 2, source: 'mixed' })
    expect(byQuery.get('')).toMatchObject({ clicks: 1, impressions: 3, source: 'google' })
    expect(byQuery.get('odd widget')!.position).toBe(0)
    expect(byQuery.has('ghost widget')).toBe(false)
    expect(rows.filter(r => r.clicks === 5 && r.impressions === 100).map(r => r.query)).toEqual(['Gamma', 'alpha', 'beta', 'Élan', '\uE000 widget', '\u{1F600} widget'])
  })

  test('matches the JS merge on randomized stores, for every page and open bounds', () => {
    const queries = [
      '', 'blue widget', 'Blue widget', 'red widget', 'green widget', 'widget repair', 'widget repair near me',
      'Élan widget', '\u{1F600} widget', '\uE000 widget', 'widgets', 'widget-2', 'widget 10', 'widget 9',
      ...Array.from({ length: 20 }, (_, i) => `gadget ${i}`),
    ]
    const dates = Array.from({ length: 14 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`)
    const positionText = (rand: () => number): string => {
      const r = rand()
      if (r < 0.2) return String(Math.floor(1 + rand() * 30))
      if (r < 0.25) return '0'
      return String(1 + rand() * 40)
    }

    for (const seed of [1, 7, 42, 1234, 99991]) {
      // Fresh stores per seed.
      db.$client.exec('DELETE FROM gsc_query_daily_totals; DELETE FROM gsc_search_data;')
      const rand = prng(seed)
      for (const date of dates) {
        for (const query of queries) {
          const r = rand()
          // Small click and impression ranges so ties are common.
          if (r < 0.35) accurate(date, query, Math.floor(rand() * 4), rand() < 0.15 ? 0 : Math.floor(rand() * 60), positionText(rand))
          if (rand() < 0.45) {
            const pages = 1 + Math.floor(rand() * 3)
            for (let p = 0; p < pages; p++) {
              page(date, query, `https://p1.example.com/${p}`, Math.floor(rand() * 3), rand() < 0.15 ? 0 : Math.floor(rand() * 40), positionText(rand))
            }
          }
          if (rand() < 0.1) accurate(date, query, 50, 500, '1', OTHER)
        }
      }

      for (const [start, end] of [
        ['2026-07-01', '2026-07-14'], ['2026-07-03', '2026-07-09'], ['2026-07-05', '2026-07-05'],
        [null, '2026-07-10'], ['2026-07-04', null], [null, null], ['2026-08-01', '2026-08-31'],
      ] as const) {
        const expected = reference(db, PROJECT, start, end)
        const whole = all(start, end)
        expectSameRows(whole.rows, expected)
        expect(whole.totalMatching).toBe(expected.length)

        for (const limit of [1, 3, 7]) {
          for (let offset = 0; offset <= expected.length + limit; offset += limit) {
            const pageResult = readGscQueryTotalsPage(db, PROJECT, start, end, limit, offset)
            expectSameRows(pageResult.rows, expected.slice(offset, offset + limit))
            expect(pageResult.totalMatching).toBe(expected.length)
          }
        }
      }
    }
  })

  test('returns no rows and a zero count for an empty window', () => {
    expect(all('2026-07-01', '2026-07-31')).toEqual({ rows: [], totalMatching: 0 })
    expect(readGscQueryTotalsPage(db, PROJECT, null, null, 5, 10)).toEqual({ rows: [], totalMatching: 0 })
  })

  test('accepts a limit or offset past 64-bit integers', () => {
    accurate('2026-07-01', 'blue widget', 1, 10, '1')
    expect(readGscQueryTotalsPage(db, PROJECT, null, null, 1e20, 0).rows).toHaveLength(1)
    expect(readGscQueryTotalsPage(db, PROJECT, null, null, 1, 1e20)).toEqual({ rows: [], totalMatching: 1 })
  })

  test('counts every query on a page past the end', () => {
    accurate('2026-07-01', 'blue widget', 1, 10, '1')
    page('2026-07-01', 'red widget', 'https://p1.example.com/a', 1, 10, '1')
    expect(readGscQueryTotalsPage(db, PROJECT, null, null, 5, 10)).toEqual({ rows: [], totalMatching: 2 })
  })
})
