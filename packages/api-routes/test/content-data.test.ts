import { describe, it, expect } from 'vitest'

import { aggregateGscByQuery } from '../src/content-data.js'

function row(opts: {
  query: string
  page: string
  impressions: number
  clicks: number
  ctr: string
  position: string
}) {
  return opts
}

describe('aggregateGscByQuery', () => {
  it('computes CTR from summed clicks and impressions, not from the row with most impressions', () => {
    // Mirrors the bug in issue #469 ("spray foam insulation"). The row with
    // the most impressions has ctr=0; the row with the actual click sits on a
    // different dimension combination with ctr=1.0. The fix must aggregate.
    const rows = [
      row({ query: 'spray foam insulation', page: 'https://example.com/a', impressions: 26, clicks: 0, ctr: '0', position: '12' }),
      row({ query: 'spray foam insulation', page: 'https://example.com/a', impressions: 1, clicks: 1, ctr: '1', position: '8' }),
      row({ query: 'spray foam insulation', page: 'https://example.com/a', impressions: 1, clicks: 0, ctr: '0', position: '20' }),
      row({ query: 'spray foam insulation', page: 'https://example.com/a', impressions: 1, clicks: 0, ctr: '0', position: '15' }),
      row({ query: 'spray foam insulation', page: 'https://example.com/a', impressions: 1, clicks: 0, ctr: '0', position: '10' }),
    ]
    const result = aggregateGscByQuery(rows)
    const entry = result.get('spray foam insulation')
    expect(entry).toBeDefined()
    expect(entry!.clicks).toBe(1)
    expect(entry!.impressions).toBe(30)
    // 1 / 30 = 0.0333... — must come from the aggregate, not a single row
    expect(entry!.ctr).toBeCloseTo(1 / 30, 10)
    // Impression-weighted average position
    const expectedPosition = (12 * 26 + 8 * 1 + 20 * 1 + 15 * 1 + 10 * 1) / 30
    expect(entry!.position).toBeCloseTo(expectedPosition, 10)
  })

  it('uses the page with the most impressions as the representative page', () => {
    const rows = [
      row({ query: 'best crm', page: 'https://example.com/winner', impressions: 100, clicks: 5, ctr: '0.05', position: '4' }),
      row({ query: 'best crm', page: 'https://example.com/loser', impressions: 10, clicks: 1, ctr: '0.1', position: '7' }),
    ]
    const result = aggregateGscByQuery(rows)
    const entry = result.get('best crm')
    expect(entry).toBeDefined()
    expect(entry!.page).toBe('/winner')
    expect(entry!.clicks).toBe(6)
    expect(entry!.impressions).toBe(110)
    expect(entry!.ctr).toBeCloseTo(6 / 110, 10)
  })

  it('normalizes the representative page to a path (matches gaTrafficByPage)', () => {
    const rows = [
      row({ query: 'q', page: 'https://example.com/posts/foo', impressions: 5, clicks: 0, ctr: '0', position: '9' }),
    ]
    const result = aggregateGscByQuery(rows)
    expect(result.get('q')!.page).toBe('/posts/foo')
  })

  it('returns ctr=0 and position=0 when total impressions are zero', () => {
    const rows = [
      row({ query: 'zero', page: '/p', impressions: 0, clicks: 0, ctr: '0', position: '0' }),
    ]
    const result = aggregateGscByQuery(rows)
    const entry = result.get('zero')!
    expect(entry.ctr).toBe(0)
    expect(entry.position).toBe(0)
    expect(entry.clicks).toBe(0)
    expect(entry.impressions).toBe(0)
  })

  it('aggregates separately per query', () => {
    const rows = [
      row({ query: 'a', page: '/x', impressions: 10, clicks: 1, ctr: '0.1', position: '5' }),
      row({ query: 'b', page: '/y', impressions: 20, clicks: 0, ctr: '0', position: '10' }),
      row({ query: 'a', page: '/x', impressions: 10, clicks: 0, ctr: '0', position: '7' }),
    ]
    const result = aggregateGscByQuery(rows)
    expect(result.get('a')!.clicks).toBe(1)
    expect(result.get('a')!.impressions).toBe(20)
    expect(result.get('a')!.ctr).toBeCloseTo(0.05, 10)
    expect(result.get('b')!.clicks).toBe(0)
    expect(result.get('b')!.impressions).toBe(20)
    expect(result.get('b')!.ctr).toBe(0)
  })

  it('returns an empty map for no rows', () => {
    expect(aggregateGscByQuery([]).size).toBe(0)
  })
})
