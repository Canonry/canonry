import { describe, it, expect } from 'vitest'
import { analyzeGbp, type GbpLocationSignals } from '../src/gbp-analyzer.js'

/** A fully-healthy location: no gaps, no drops. Override fields per test. */
function healthy(overrides: Partial<GbpLocationSignals> = {}): GbpLocationSignals {
  return {
    locationName: 'locations/1',
    displayName: 'Test Hotel',
    metricRecent7d: { WEBSITE_CLICKS: 100, BUSINESS_DIRECTION_REQUESTS: 50, CALL_CLICKS: 20 },
    metricPrior7d: { WEBSITE_CLICKS: 100, BUSINESS_DIRECTION_REQUESTS: 50, CALL_CLICKS: 20 },
    metricDeltaPct: { WEBSITE_CLICKS: 0, BUSINESS_DIRECTION_REQUESTS: 0, CALL_CLICKS: 0 },
    lodgingCapable: true,
    lodgingEmpty: false,
    placesAmenities: [],
    placeActionCount: 2,
    hasDirectMerchantCta: true,
    keywordRecentMonth: '2026-04',
    keywordPriorMonth: '2026-03',
    keywordPoints: [{ keyword: 'venice beach hotel', recent: 100, prior: 100 }],
    ...overrides,
  }
}

describe('analyzeGbp', () => {
  it('produces no insights for a fully-healthy location', () => {
    expect(analyzeGbp([healthy()])).toEqual([])
  })

  it('produces no insights for empty input', () => {
    expect(analyzeGbp([])).toEqual([])
  })

  describe('lodging gap', () => {
    it('flags an unreadable lodging profile as a low-severity verify (not a confirmed gap)', () => {
      const insights = analyzeGbp([healthy({ lodgingCapable: true, lodgingEmpty: true })])
      const lodging = insights.filter((i) => i.type === 'gbp-lodging-gap')
      expect(lodging).toHaveLength(1)
      // An empty Lodging API result does NOT prove the owner set no amenities
      // (the "Hotel details" panel is a separate surface the API can't read),
      // so this is a verify-nudge, not a high-severity defect.
      expect(lodging[0]!.severity).toBe('low')
      expect(lodging[0]!.provider).toBe('gbp')
      expect(lodging[0]!.query).toBe('Test Hotel')
      expect(lodging[0]!.locationName).toBe('locations/1')
      // Frames it honestly: verify the "Hotel details" panel, not "you have none".
      expect(lodging[0]!.recommendation?.reason).toMatch(/Hotel details/)
      expect(lodging[0]!.recommendation?.reason).toMatch(/not a confirmed gap/)
    })

    it('does not flag a populated lodging profile', () => {
      const insights = analyzeGbp([healthy({ lodgingCapable: true, lodgingEmpty: false })])
      expect(insights.some((i) => i.type === 'gbp-lodging-gap')).toBe(false)
    })

    it('does not flag a non-lodging location even when "empty"', () => {
      const insights = analyzeGbp([healthy({ lodgingCapable: false, lodgingEmpty: true })])
      expect(insights.some((i) => i.type === 'gbp-lodging-gap')).toBe(false)
    })
  })

  describe('listing discrepancy (#648 Phase B)', () => {
    it('fires gbp-listing-discrepancy (medium) with Places amenities as evidence', () => {
      const insights = analyzeGbp([healthy({
        lodgingCapable: true, lodgingEmpty: true,
        placesAmenities: ['breakfast', 'parking', 'pet-friendly'],
      })])
      const disc = insights.filter((i) => i.type === 'gbp-listing-discrepancy')
      expect(disc).toHaveLength(1)
      // Places evidence makes it worth a look, but the Lodging API still can't
      // read the "Hotel details" panel, so it's a verify (medium), not a high.
      expect(disc[0]!.severity).toBe('medium')
      expect(disc[0]!.provider).toBe('gbp')
      // Title carries the count (plural), reason names the specific amenities.
      expect(disc[0]!.title).toContain('3 amenities')
      expect(disc[0]!.recommendation?.reason).toContain('breakfast, parking, and pet-friendly')
    })

    it('SUPERSEDES the generic lodging-gap when Places evidence exists', () => {
      const insights = analyzeGbp([healthy({
        lodgingCapable: true, lodgingEmpty: true, placesAmenities: ['breakfast'],
      })])
      expect(insights.some((i) => i.type === 'gbp-listing-discrepancy')).toBe(true)
      expect(insights.some((i) => i.type === 'gbp-lodging-gap')).toBe(false)
    })

    it('uses the singular noun for a single amenity', () => {
      const insights = analyzeGbp([healthy({
        lodgingCapable: true, lodgingEmpty: true, placesAmenities: ['breakfast'],
      })])
      const disc = insights.find((i) => i.type === 'gbp-listing-discrepancy')!
      expect(disc.title).toContain('1 amenity')
      expect(disc.title).not.toContain('amenities')
    })

    it('falls back to gbp-lodging-gap when there is no Places evidence', () => {
      const insights = analyzeGbp([healthy({ lodgingCapable: true, lodgingEmpty: true, placesAmenities: [] })])
      expect(insights.some((i) => i.type === 'gbp-lodging-gap')).toBe(true)
      expect(insights.some((i) => i.type === 'gbp-listing-discrepancy')).toBe(false)
    })

    it('does NOT fire when the profile is populated, even if Places lists amenities', () => {
      const insights = analyzeGbp([healthy({
        lodgingCapable: true, lodgingEmpty: false, placesAmenities: ['breakfast', 'parking'],
      })])
      expect(insights.some((i) => i.type === 'gbp-listing-discrepancy')).toBe(false)
      expect(insights.some((i) => i.type === 'gbp-lodging-gap')).toBe(false)
    })

    it('does NOT fire for a non-lodging location', () => {
      const insights = analyzeGbp([healthy({
        lodgingCapable: false, lodgingEmpty: true, placesAmenities: ['breakfast'],
      })])
      expect(insights.some((i) => i.type === 'gbp-listing-discrepancy')).toBe(false)
    })
  })

  describe('CTA gap', () => {
    it('flags place actions present without a direct-merchant CTA (medium)', () => {
      const insights = analyzeGbp([healthy({ placeActionCount: 3, hasDirectMerchantCta: false })])
      const cta = insights.filter((i) => i.type === 'gbp-cta-gap')
      expect(cta).toHaveLength(1)
      expect(cta[0]!.severity).toBe('medium')
    })

    it('does not flag when a direct-merchant CTA exists', () => {
      const insights = analyzeGbp([healthy({ placeActionCount: 3, hasDirectMerchantCta: true })])
      expect(insights.some((i) => i.type === 'gbp-cta-gap')).toBe(false)
    })

    it('does not flag when there are no place actions at all', () => {
      const insights = analyzeGbp([healthy({ placeActionCount: 0, hasDirectMerchantCta: false })])
      expect(insights.some((i) => i.type === 'gbp-cta-gap')).toBe(false)
    })
  })

  describe('metric drop (week-over-week)', () => {
    it('flags a meaningful headline-metric drop as medium', () => {
      const insights = analyzeGbp([healthy({
        metricPrior7d: { WEBSITE_CLICKS: 100 },
        metricRecent7d: { WEBSITE_CLICKS: 50 },
        metricDeltaPct: { WEBSITE_CLICKS: -50 },
      })])
      const drop = insights.filter((i) => i.type === 'gbp-metric-drop')
      expect(drop).toHaveLength(1)
      expect(drop[0]!.severity).toBe('medium')
    })

    it('escalates a severe drop to high', () => {
      const insights = analyzeGbp([healthy({
        metricPrior7d: { BUSINESS_DIRECTION_REQUESTS: 100 },
        metricRecent7d: { BUSINESS_DIRECTION_REQUESTS: 15 },
        metricDeltaPct: { BUSINESS_DIRECTION_REQUESTS: -85 },
      })])
      const drop = insights.filter((i) => i.type === 'gbp-metric-drop')
      expect(drop).toHaveLength(1)
      expect(drop[0]!.severity).toBe('high')
    })

    it('ignores drops on a tiny prior baseline (noise guard)', () => {
      const insights = analyzeGbp([healthy({
        metricPrior7d: { WEBSITE_CLICKS: 4 },
        metricRecent7d: { WEBSITE_CLICKS: 1 },
        metricDeltaPct: { WEBSITE_CLICKS: -75 },
      })])
      expect(insights.some((i) => i.type === 'gbp-metric-drop')).toBe(false)
    })

    it('ignores a null delta (no prior window)', () => {
      const insights = analyzeGbp([healthy({
        metricPrior7d: { WEBSITE_CLICKS: 0 },
        metricRecent7d: { WEBSITE_CLICKS: 0 },
        metricDeltaPct: { WEBSITE_CLICKS: null },
      })])
      expect(insights.some((i) => i.type === 'gbp-metric-drop')).toBe(false)
    })

    it('ignores non-headline metrics (e.g. impressions)', () => {
      const insights = analyzeGbp([healthy({
        metricPrior7d: { BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 1000 },
        metricRecent7d: { BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 100 },
        metricDeltaPct: { BUSINESS_IMPRESSIONS_DESKTOP_MAPS: -90 },
      })])
      expect(insights.some((i) => i.type === 'gbp-metric-drop')).toBe(false)
    })

    it('emits a single insight citing the worst-dropped headline metric', () => {
      const insights = analyzeGbp([healthy({
        metricPrior7d: { WEBSITE_CLICKS: 100, CALL_CLICKS: 100 },
        metricRecent7d: { WEBSITE_CLICKS: 50, CALL_CLICKS: 10 },
        metricDeltaPct: { WEBSITE_CLICKS: -50, CALL_CLICKS: -90 },
      })])
      const drop = insights.filter((i) => i.type === 'gbp-metric-drop')
      expect(drop).toHaveLength(1)
      // The worst drop (CALL_CLICKS, -90%) drives the insight → high severity.
      expect(drop[0]!.severity).toBe('high')
      expect(drop[0]!.title.toLowerCase()).toContain('call')
    })
  })

  describe('keyword drop (month-over-month)', () => {
    it('flags a meaningful keyword impressions drop as medium', () => {
      const insights = analyzeGbp([healthy({
        keywordPoints: [{ keyword: 'venice hotel', recent: 40, prior: 100 }],
      })])
      const drop = insights.filter((i) => i.type === 'gbp-keyword-drop')
      expect(drop).toHaveLength(1)
      expect(drop[0]!.severity).toBe('medium')
      expect(drop[0]!.title).toContain('venice hotel')
    })

    it('escalates a severe keyword drop to high', () => {
      const insights = analyzeGbp([healthy({
        keywordPoints: [{ keyword: 'venice hotel', recent: 10, prior: 100 }],
      })])
      const drop = insights.filter((i) => i.type === 'gbp-keyword-drop')
      expect(drop[0]!.severity).toBe('high')
    })

    it('ignores keywords with a tiny prior baseline', () => {
      const insights = analyzeGbp([healthy({
        keywordPoints: [{ keyword: 'rare term', recent: 1, prior: 5 }],
      })])
      expect(insights.some((i) => i.type === 'gbp-keyword-drop')).toBe(false)
    })

    it('ignores thresholded (null) keyword counts in either month', () => {
      const insights = analyzeGbp([healthy({
        keywordPoints: [
          { keyword: 'redacted recent', recent: null, prior: 100 },
          { keyword: 'redacted prior', recent: 30, prior: null },
        ],
      })])
      expect(insights.some((i) => i.type === 'gbp-keyword-drop')).toBe(false)
    })

    it('does not flag when there is no prior month to compare', () => {
      const insights = analyzeGbp([healthy({
        keywordPriorMonth: null,
        keywordPoints: [{ keyword: 'venice hotel', recent: 40, prior: null }],
      })])
      expect(insights.some((i) => i.type === 'gbp-keyword-drop')).toBe(false)
    })

    it('emits a single insight citing the worst-dropped keyword', () => {
      const insights = analyzeGbp([healthy({
        keywordPoints: [
          { keyword: 'mild drop', recent: 60, prior: 100 },
          { keyword: 'severe drop', recent: 5, prior: 100 },
        ],
      })])
      const drop = insights.filter((i) => i.type === 'gbp-keyword-drop')
      expect(drop).toHaveLength(1)
      expect(drop[0]!.title).toContain('severe drop')
      expect(drop[0]!.severity).toBe('high')
    })
  })

  it('scopes insights to the correct location across a multi-location chain', () => {
    const insights = analyzeGbp([
      healthy({ locationName: 'locations/1', displayName: 'Gjelina', lodgingEmpty: true }),
      healthy({ locationName: 'locations/2', displayName: 'Gjelina', placeActionCount: 1, hasDirectMerchantCta: false }),
    ])
    const byLoc = (loc: string) => insights.filter((i) => i.locationName === loc).map((i) => i.type)
    // Two locations sharing a displayName must still produce distinct,
    // location-scoped insights.
    expect(byLoc('locations/1')).toEqual(['gbp-lodging-gap'])
    expect(byLoc('locations/2')).toEqual(['gbp-cta-gap'])
  })
})
