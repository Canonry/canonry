import { describe, expect, it } from 'vitest'
import { buildSuggestedQueries, type SuggestedQueryGscRow } from '../src/suggested-queries.js'

function row(query: string, impressions: number, opts: Partial<SuggestedQueryGscRow> = {}): SuggestedQueryGscRow {
  return {
    query,
    impressions,
    clicks: opts.clicks ?? 0,
    avgPosition: opts.avgPosition ?? 50,
  }
}

describe('buildSuggestedQueries', () => {
  it('returns empty rows when no GSC data', () => {
    const result = buildSuggestedQueries([], { trackedQueries: [] })
    expect(result.rows).toEqual([])
    expect(result.totalCandidates).toBe(0)
    expect(result.skippedAlreadyTracked).toBe(0)
  })

  it('filters out queries already in the tracked basket (case-insensitive)', () => {
    const gsc = [
      row('best CRM software', 500),
      row('top crm tools', 300),
      row('untracked query', 200),
    ]
    const result = buildSuggestedQueries(gsc, {
      trackedQueries: ['Best CRM Software', 'TOP CRM TOOLS'],
    })
    expect(result.rows.map(r => r.query)).toEqual(['untracked query'])
    expect(result.skippedAlreadyTracked).toBe(2)
  })

  it('trims whitespace before matching', () => {
    const gsc = [row('  best crm  ', 500), row('other query', 200)]
    const result = buildSuggestedQueries(gsc, { trackedQueries: ['best crm'] })
    expect(result.skippedAlreadyTracked).toBe(1)
    expect(result.rows.map(r => r.query)).toEqual(['other query'])
  })

  it('drops queries below the impression floor (default 10)', () => {
    const gsc = [
      row('high traffic', 500),
      row('low traffic', 5),
      row('boundary', 10),
    ]
    const result = buildSuggestedQueries(gsc, { trackedQueries: [] })
    expect(result.rows.map(r => r.query)).toEqual(['high traffic', 'boundary'])
    expect(result.totalCandidates).toBe(2)
  })

  it('respects custom minImpressions floor', () => {
    const gsc = [row('q1', 50), row('q2', 20), row('q3', 100)]
    const result = buildSuggestedQueries(gsc, { trackedQueries: [], minImpressions: 30 })
    expect(result.rows.map(r => r.query)).toEqual(['q3', 'q1'])
  })

  it('sorts by impressions descending', () => {
    const gsc = [
      row('medium', 200),
      row('low', 50),
      row('high', 1000),
    ]
    const result = buildSuggestedQueries(gsc, { trackedQueries: [] })
    expect(result.rows.map(r => r.query)).toEqual(['high', 'medium', 'low'])
  })

  it('caps the returned rows at the limit but preserves totalCandidates', () => {
    const gsc = Array.from({ length: 25 }, (_, i) => row(`q${i}`, 100 + i))
    const result = buildSuggestedQueries(gsc, { trackedQueries: [], limit: 5 })
    expect(result.rows).toHaveLength(5)
    expect(result.totalCandidates).toBe(25)
    // Highest impressions first
    expect(result.rows[0]!.query).toBe('q24')
  })

  it('builds reason copy that includes impressions and ranking position', () => {
    const result = buildSuggestedQueries(
      [
        row('top-10 query', 5_000, { avgPosition: 6 }),
        row('top-20 query', 800, { avgPosition: 15 }),
        row('deep query', 200, { avgPosition: 45 }),
      ],
      { trackedQueries: [] },
    )
    expect(result.rows[0]!.reason).toMatch(/5\.0K impressions.*#6/)
    expect(result.rows[1]!.reason).toMatch(/800 impressions.*#15.*close to top 10/)
    expect(result.rows[2]!.reason).toMatch(/200 impressions.*#45/)
  })

  it('formats large impression counts in K/M', () => {
    const result = buildSuggestedQueries(
      [
        row('million', 2_500_000, { avgPosition: 8 }),
        row('thousands', 12_500, { avgPosition: 8 }),
        row('mid-thousand', 3_400, { avgPosition: 8 }),
      ],
      { trackedQueries: [] },
    )
    expect(result.rows[0]!.reason).toMatch(/2\.5M/)
    expect(result.rows[1]!.reason).toMatch(/13K/)
    expect(result.rows[2]!.reason).toMatch(/3\.4K/)
  })

  it('skips empty / whitespace-only queries', () => {
    const gsc = [row('', 500), row('   ', 300), row('real query', 200)]
    const result = buildSuggestedQueries(gsc, { trackedQueries: [] })
    expect(result.rows.map(r => r.query)).toEqual(['real query'])
  })

  it('totalCandidates reflects eligible queries (post-floor, post-tracked-filter) not the raw input size', () => {
    const gsc = [
      row('high', 500),
      row('low-traffic', 5), // below floor
      row('already-tracked', 200),
      row('candidate', 100),
    ]
    const result = buildSuggestedQueries(gsc, {
      trackedQueries: ['already-tracked'],
    })
    expect(result.totalCandidates).toBe(2) // 'high' and 'candidate'
    expect(result.skippedAlreadyTracked).toBe(1)
  })

  it('preserves the original query casing in the output (for one-click "Add to tracking")', () => {
    const result = buildSuggestedQueries(
      [row('Best CRM Software 2026', 500)],
      { trackedQueries: [] },
    )
    expect(result.rows[0]!.query).toBe('Best CRM Software 2026')
  })
})
