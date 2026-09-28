import { describe, expect, it } from 'vitest'
import { aggregateGscByQuery, windowEndingOn } from '../src/content-data.js'

/**
 * gsc_search_data is keyed (date, query, page, country, device), so a query
 * ranking on several pages produces several rows for ONE SERP impression.
 * Summing them over-counts. On a live property before this fix, one query
 * summed to several times its accurate all-time impressions (illustrative
 * figures: 120,400 summed against an accurate all-time 21,300 and a 30-day
 * window of 1,240).
 */
const PAGE_ROWS = [
  { query: 'boutique hotel', page: 'https://x.test/rooms', impressions: 100, clicks: 4, ctr: '0.04', position: '3' },
  { query: 'boutique hotel', page: 'https://x.test/', impressions: 100, clicks: 6, ctr: '0.06', position: '5' },
]

describe('aggregateGscByQuery', () => {
  it('takes impressions and clicks from the accurate per-query aggregate, not the page sum', () => {
    const out = aggregateGscByQuery(PAGE_ROWS, [
      { query: 'boutique hotel', impressions: 100, clicks: 10, position: 3.8 },
    ])
    const row = out.get('boutique hotel')!
    // 100, not the 200 the two page rows sum to.
    expect(row.impressions).toBe(100)
    expect(row.clicks).toBe(10)
    expect(row.position).toBeCloseTo(3.8)
    expect(row.ctr).toBeCloseTo(0.1)
  })

  it('still attributes the best page from the page rows, which is what they are for', () => {
    const out = aggregateGscByQuery([
      { query: 'boutique hotel', page: 'https://x.test/rooms', impressions: 10, clicks: 0, ctr: '0', position: '9' },
      { query: 'boutique hotel', page: 'https://x.test/suites', impressions: 90, clicks: 5, ctr: '0.05', position: '2' },
    ], [{ query: 'boutique hotel', impressions: 100, clicks: 5, position: 2.7 }])
    expect(out.get('boutique hotel')!.page).toBe('/suites')
  })

  it('falls back to page-summed figures when a query has no accurate aggregate', () => {
    const out = aggregateGscByQuery(PAGE_ROWS, [])
    // Legacy behaviour preserved for un-backfilled days: still an over-count,
    // which is why the fallback is a fallback.
    expect(out.get('boutique hotel')!.impressions).toBe(200)
    expect(out.get('boutique hotel')!.clicks).toBe(10)
  })

  it('derives CTR from the aggregate rather than from any single row', () => {
    const out = aggregateGscByQuery(PAGE_ROWS, [
      { query: 'boutique hotel', impressions: 250, clicks: 25, position: 4 },
    ])
    expect(out.get('boutique hotel')!.ctr).toBeCloseTo(0.1)
  })
})

/**
 * The window half of the fix. Before it, the read had no date bound at all and
 * reported lifetime demand under the report's window heading: on a live
 * property one query showed lifetime impressions many times its 30-day figure
 * (illustrative figures: 120,400 against 1,240).
 */
describe('resolveContentGscWindow', () => {
  it('spans exactly windowDays days, inclusive of both ends', () => {
    // Exported for this test; the arithmetic is where an off-by-one would hide.
    const w = windowEndingOn('2026-09-02', 30)
    expect(w).toEqual({ startDate: '2026-08-04', endDate: '2026-09-02' })
  })

  it('anchors on the newest published day, not the wall clock', () => {
    // Google finalises a day two to three days late, so a clock-anchored window
    // ends in a partial or empty span.
    const w = windowEndingOn('2026-08-15', 7)
    expect(w.endDate).toBe('2026-08-15')
    expect(w.startDate).toBe('2026-08-09')
  })

  it('never collapses to a zero-day span', () => {
    expect(windowEndingOn('2026-09-02', 1)).toEqual({ startDate: '2026-09-02', endDate: '2026-09-02' })
    expect(windowEndingOn('2026-09-02', 0)).toEqual({ startDate: '2026-09-02', endDate: '2026-09-02' })
  })
})
