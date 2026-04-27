import { describe, it, expect } from 'vitest'

import { calculateActionConfidence } from '../src/content-confidence.js'

describe('calculateActionConfidence', () => {
  it('high when GSC dense (impr ≥ 100) AND ≥ 3 runs of citation history', () => {
    expect(
      calculateActionConfidence({
        hasGsc: true,
        gscImpressions: 1200,
        runsOfHistory: 5,
        hasCompetitorEvidence: true,
        hasInventoryMatch: false,
      }),
    ).toBe('high')
  })

  it('low when no GSC AND only competitor evidence fired (no inventory match)', () => {
    expect(
      calculateActionConfidence({
        hasGsc: false,
        gscImpressions: 0,
        runsOfHistory: 3,
        hasCompetitorEvidence: true,
        hasInventoryMatch: false,
      }),
    ).toBe('low')
  })

  it('medium when GSC sparse (impr < 100)', () => {
    expect(
      calculateActionConfidence({
        hasGsc: true,
        gscImpressions: 50,
        runsOfHistory: 5,
        hasCompetitorEvidence: true,
        hasInventoryMatch: false,
      }),
    ).toBe('medium')
  })

  it('medium when run history < 3', () => {
    expect(
      calculateActionConfidence({
        hasGsc: true,
        gscImpressions: 1200,
        runsOfHistory: 2,
        hasCompetitorEvidence: true,
        hasInventoryMatch: false,
      }),
    ).toBe('medium')
  })

  it('medium when no GSC but inventory match found', () => {
    // We have a page (via GA4 / sitemap / WP) but no ranking data — better than nothing.
    expect(
      calculateActionConfidence({
        hasGsc: false,
        gscImpressions: 0,
        runsOfHistory: 5,
        hasCompetitorEvidence: true,
        hasInventoryMatch: true,
      }),
    ).toBe('medium')
  })

  it('low when no signals fire at all', () => {
    expect(
      calculateActionConfidence({
        hasGsc: false,
        gscImpressions: 0,
        runsOfHistory: 0,
        hasCompetitorEvidence: false,
        hasInventoryMatch: false,
      }),
    ).toBe('low')
  })

  it('high requires BOTH gsc dense AND ≥3 runs (not either-or)', () => {
    expect(
      calculateActionConfidence({
        hasGsc: true,
        gscImpressions: 1200,
        runsOfHistory: 1,
        hasCompetitorEvidence: true,
        hasInventoryMatch: false,
      }),
    ).not.toBe('high')

    expect(
      calculateActionConfidence({
        hasGsc: true,
        gscImpressions: 50,
        runsOfHistory: 10,
        hasCompetitorEvidence: true,
        hasInventoryMatch: false,
      }),
    ).not.toBe('high')
  })
})
