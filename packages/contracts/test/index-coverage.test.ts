import { describe, it, expect } from 'vitest'
import { deriveIndexCoverage } from '../src/index-coverage.js'

/**
 * The invariant that matters most here is the three-state one. Collapsing
 * "unknown" into "not-indexed" would turn every unmeasured page into a
 * reported problem the moment coverage stopped being truncated to 50 pages —
 * a fabricated regression at exactly the wrong moment.
 */
describe('deriveIndexCoverage', () => {
  it('treats an impression as proof of indexing, with no inspection needed', () => {
    const out = deriveIndexCoverage({
      pages: [
        { page: '/a', impressions: 90 },
        { page: '/b', impressions: 1 },
      ],
    })

    expect(out.states.get('/a')).toBe('indexed')
    expect(out.states.get('/b')).toBe('indexed')
    expect(out.indexed).toBe(2)
    expect(out.derivedFromImpressions).toBe(2)
    expect(out.verifiedByInspection).toBe(0)
  })

  it('reports a page with no impressions and no inspection as unknown, NOT not-indexed', () => {
    const out = deriveIndexCoverage({ pages: [{ page: '/quiet', impressions: 0 }] })

    expect(out.states.get('/quiet')).toBe('unknown')
    expect(out.unknown).toBe(1)
    expect(out.notIndexed).toBe(0)
  })

  it('uses the inspection verdict when there are no impressions to go on', () => {
    const out = deriveIndexCoverage({
      pages: [{ page: '/a', impressions: 0 }, { page: '/b', impressions: 0 }],
      inspections: [
        { url: '/a', indexingState: 'INDEXING_ALLOWED' },
        { url: '/b', indexingState: 'BLOCKED_BY_ROBOTS_TXT', coverageState: 'Blocked by robots.txt' },
      ],
    })

    expect(out.states.get('/a')).toBe('indexed')
    expect(out.states.get('/b')).toBe('not-indexed')
    expect(out.reasonBreakdown).toEqual({ 'Blocked by robots.txt': 1 })
    expect(out.verifiedByInspection).toBe(2)
  })

  it('lets impressions override a stale not-indexed inspection', () => {
    // The page was blocked, someone fixed it, and it now ranks. Google serving
    // it is newer and stronger evidence than an inspection from before the fix.
    const out = deriveIndexCoverage({
      pages: [{ page: '/fixed', impressions: 40 }],
      inspections: [{ url: '/fixed', indexingState: 'BLOCKED_BY_ROBOTS_TXT', coverageState: 'Blocked by robots.txt' }],
    })

    expect(out.states.get('/fixed')).toBe('indexed')
    expect(out.notIndexed).toBe(0)
    expect(out.reasonBreakdown).toEqual({})
  })

  it('includes pages that were inspected but never appeared in the window', () => {
    // Dropping these would silently shrink the denominator and flatter coverage.
    const out = deriveIndexCoverage({
      pages: [{ page: '/ranks', impressions: 10 }],
      inspections: [{ url: '/never-ranked', indexingState: 'INDEXING_ALLOWED' }],
    })

    expect(out.states.size).toBe(2)
    expect(out.states.get('/never-ranked')).toBe('indexed')
    expect(out.indexed).toBe(2)
  })

  it('sums impressions across the multiple rows one page produces', () => {
    // Search analytics is dimensioned by query, so one page arrives many times.
    const out = deriveIndexCoverage({
      pages: [
        { page: '/a', impressions: 0 },
        { page: '/a', impressions: 3 },
        { page: '/a', impressions: 0 },
      ],
    })

    expect(out.states.get('/a')).toBe('indexed')
    expect(out.indexed).toBe(1)
    expect(out.states.size).toBe(1)
    expect([out.notIndexed, out.unknown, out.derivedFromImpressions, out.verifiedByInspection]).toEqual([0, 0, 1, 0])
  })

  it('conserves every page across the three buckets', () => {
    const out = deriveIndexCoverage({
      pages: [
        { page: '/ranks', impressions: 5 },
        { page: '/quiet', impressions: 0 },
        { page: '/blocked', impressions: 0 },
      ],
      inspections: [{ url: '/blocked', indexingState: 'BLOCKED_BY_ROBOTS_TXT', coverageState: 'Blocked' }],
    })

    expect(out.indexed + out.notIndexed + out.unknown).toBe(out.states.size)
    expect(out.states.size).toBe(3)
    expect([out.indexed, out.notIndexed, out.unknown]).toEqual([1, 1, 1])
  })

  it('scales to a site far past the inspection quota without inspecting anything', () => {
    // 5,000 pages is 9.9 hours and 2.5x the daily quota to inspect. Derivation
    // resolves the ranked ones for free; the rest are honestly unknown.
    const pages = Array.from({ length: 5000 }, (_, i) => ({ page: `/p${i}`, impressions: i % 2 === 0 ? 1 : 0 }))
    const out = deriveIndexCoverage({ pages })

    expect(out.indexed).toBe(2500)
    expect(out.unknown).toBe(2500)
    expect(out.notIndexed).toBe(0)
    expect(out.verifiedByInspection).toBe(0)
  })

  it('returns empty rather than throwing on no data at all', () => {
    const out = deriveIndexCoverage({ pages: [] })
    expect([out.indexed, out.notIndexed, out.unknown]).toEqual([0, 0, 0])
    expect(out.states.size).toBe(0)
  })
})
