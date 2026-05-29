import { describe, it, expect } from 'vitest'
import {
  computeMetricTotals,
  computeWindowDelta,
  computeKeywordCoverage,
  summarizePlaceActions,
  summarizeLodging,
  buildGbpSummary,
} from '../src/gbp-summary.js'

describe('computeMetricTotals', () => {
  it('sums values per metric', () => {
    expect(computeMetricTotals([
      { metric: 'WEBSITE_CLICKS', date: '2026-05-01', value: 10 },
      { metric: 'WEBSITE_CLICKS', date: '2026-05-02', value: 5 },
      { metric: 'CALL_CLICKS', date: '2026-05-01', value: 2 },
    ])).toEqual({ WEBSITE_CLICKS: 15, CALL_CLICKS: 2 })
  })

  it('returns {} for empty input', () => {
    expect(computeMetricTotals([])).toEqual({})
  })

  it('keeps a zero-valued metric at 0 (does not drop it)', () => {
    expect(computeMetricTotals([
      { metric: 'BOOKINGS', date: '2026-05-01', value: 0 },
      { metric: 'BOOKINGS', date: '2026-05-02', value: 0 },
    ])).toEqual({ BOOKINGS: 0 })
  })
})

describe('computeWindowDelta', () => {
  // referenceDate 2026-05-15. recent7d = (05-08, 05-15], prior7d = (05-01, 05-08].
  const ref = '2026-05-15'

  it('partitions recent vs prior by the 7-day boundary (inclusive upper, exclusive lower)', () => {
    const rows = [
      { metric: 'WEBSITE_CLICKS', date: '2026-05-15', value: 1 }, // recent (== ref, included)
      { metric: 'WEBSITE_CLICKS', date: '2026-05-09', value: 2 }, // recent
      { metric: 'WEBSITE_CLICKS', date: '2026-05-08', value: 4 }, // prior (== ref-7, lower-exclusive for recent)
      { metric: 'WEBSITE_CLICKS', date: '2026-05-02', value: 8 }, // prior
      { metric: 'WEBSITE_CLICKS', date: '2026-05-01', value: 16 }, // outside both (== ref-14, lower-exclusive for prior)
    ]
    const out = computeWindowDelta(rows, ref)
    expect(out.recent7d).toEqual({ WEBSITE_CLICKS: 3 })   // 1 + 2
    expect(out.prior7d).toEqual({ WEBSITE_CLICKS: 12 })   // 4 + 8
  })

  it('deltaPct is null when the prior window is 0 (no divide-by-zero)', () => {
    const rows = [{ metric: 'WEBSITE_CLICKS', date: '2026-05-10', value: 5 }]
    const out = computeWindowDelta(rows, ref)
    expect(out.recent7d).toEqual({ WEBSITE_CLICKS: 5 })
    expect(out.prior7d).toEqual({ WEBSITE_CLICKS: 0 })
    expect(out.deltaPct).toEqual({ WEBSITE_CLICKS: null })
  })

  it('deltaPct is 0 when recent equals prior', () => {
    const rows = [
      { metric: 'CALL_CLICKS', date: '2026-05-10', value: 10 }, // recent
      { metric: 'CALL_CLICKS', date: '2026-05-04', value: 10 }, // prior
    ]
    expect(computeWindowDelta(rows, ref).deltaPct).toEqual({ CALL_CLICKS: 0 })
  })

  it('deltaPct is +100 when recent doubles prior, -50 when it halves', () => {
    const doubled = computeWindowDelta([
      { metric: 'X', date: '2026-05-10', value: 20 },
      { metric: 'X', date: '2026-05-04', value: 10 },
    ], ref)
    expect(doubled.deltaPct).toEqual({ X: 100 })

    const halved = computeWindowDelta([
      { metric: 'X', date: '2026-05-10', value: 5 },
      { metric: 'X', date: '2026-05-04', value: 10 },
    ], ref)
    expect(halved.deltaPct).toEqual({ X: -50 })
  })

  it('rounds deltaPct to the nearest integer', () => {
    // recent 10, prior 3 → (10-3)/3*100 = 233.33 → 233
    const out = computeWindowDelta([
      { metric: 'X', date: '2026-05-10', value: 10 },
      { metric: 'X', date: '2026-05-04', value: 3 },
    ], ref)
    expect(out.deltaPct).toEqual({ X: 233 })
  })

  it('returns empty maps for empty input', () => {
    expect(computeWindowDelta([], ref)).toEqual({ recent7d: {}, prior7d: {}, deltaPct: {} })
  })
})

describe('computeKeywordCoverage', () => {
  it('counts thresholded rows and rounds the percentage', () => {
    // 1 exact + 2 thresholded of 3 → 67%
    const out = computeKeywordCoverage([
      { valueCount: 100, valueThreshold: null },
      { valueCount: null, valueThreshold: 15 },
      { valueCount: null, valueThreshold: 15 },
    ])
    expect(out).toEqual({ total: 3, thresholdedCount: 2, thresholdedPct: 67 })
  })

  it('rounds 1/3 to 33', () => {
    expect(computeKeywordCoverage([
      { valueCount: null, valueThreshold: 15 },
      { valueCount: 5, valueThreshold: null },
      { valueCount: 5, valueThreshold: null },
    ]).thresholdedPct).toBe(33)
  })

  it('is 100 when all are thresholded (the small-business norm)', () => {
    expect(computeKeywordCoverage([
      { valueCount: null, valueThreshold: 15 },
      { valueCount: null, valueThreshold: 15 },
    ]).thresholdedPct).toBe(100)
  })

  it('is 0 when none are thresholded', () => {
    expect(computeKeywordCoverage([{ valueCount: 9, valueThreshold: null }]).thresholdedPct).toBe(0)
  })

  it('returns 0 (not NaN) for an empty set', () => {
    expect(computeKeywordCoverage([])).toEqual({ total: 0, thresholdedCount: 0, thresholdedPct: 0 })
  })
})

describe('summarizePlaceActions', () => {
  it('detects reservation, booking, and direct-merchant CTAs', () => {
    const out = summarizePlaceActions([
      { placeActionType: 'RESERVATION', providerType: 'MERCHANT' },
      { placeActionType: 'BOOK', providerType: 'AGGREGATOR' },
    ])
    expect(out).toEqual({ total: 2, hasReservationCta: true, hasBookingCta: true, hasDirectMerchantCta: true })
  })

  it('aggregator-only booking is NOT a direct-merchant CTA', () => {
    const out = summarizePlaceActions([{ placeActionType: 'BOOK', providerType: 'AGGREGATOR' }])
    expect(out).toEqual({ total: 1, hasReservationCta: false, hasBookingCta: true, hasDirectMerchantCta: false })
  })

  it('empty → all false, total 0 (the common real-world case)', () => {
    expect(summarizePlaceActions([])).toEqual({
      total: 0, hasReservationCta: false, hasBookingCta: false, hasDirectMerchantCta: false,
    })
  })
})

describe('summarizeLodging', () => {
  it('splits lodging locations into populated vs empty', () => {
    const out = summarizeLodging([
      { locationName: 'locations/1', populatedGroupCount: 0 },  // empty hotel profile (AEO gap)
      { locationName: 'locations/2', populatedGroupCount: 5 },
    ])
    expect(out).toEqual({ lodgingLocationCount: 2, populatedLodgingCount: 1, emptyLodgingCount: 1 })
  })

  it('all-empty profiles → emptyLodgingCount equals the location count', () => {
    expect(summarizeLodging([
      { locationName: 'locations/1', populatedGroupCount: 0 },
      { locationName: 'locations/2', populatedGroupCount: 0 },
    ])).toEqual({ lodgingLocationCount: 2, populatedLodgingCount: 0, emptyLodgingCount: 2 })
  })

  it('no lodging locations → all zero (non-hotel project)', () => {
    expect(summarizeLodging([])).toEqual({ lodgingLocationCount: 0, populatedLodgingCount: 0, emptyLodgingCount: 0 })
  })
})

describe('buildGbpSummary (composition)', () => {
  it('composes every sub-calculation into one summary', () => {
    const summary = buildGbpSummary({
      locationName: null,
      locationCount: 2,
      referenceDate: '2026-05-15',
      dailyMetrics: [
        { metric: 'WEBSITE_CLICKS', date: '2026-05-10', value: 20 },
        { metric: 'WEBSITE_CLICKS', date: '2026-05-04', value: 10 },
        { metric: 'CALL_CLICKS', date: '2026-05-10', value: 3 },
      ],
      keywords: [
        { valueCount: 500, valueThreshold: null },
        { valueCount: null, valueThreshold: 15 },
      ],
      placeActions: [{ placeActionType: 'RESERVATION', providerType: 'MERCHANT' }],
      lodging: [{ locationName: 'locations/1', populatedGroupCount: 0 }],
    })

    expect(summary.scope).toEqual({ locationName: null, locationCount: 2 })
    expect(summary.performance.totals).toEqual({ WEBSITE_CLICKS: 30, CALL_CLICKS: 3 })
    expect(summary.performance.deltaPct).toEqual({ WEBSITE_CLICKS: 100, CALL_CLICKS: null })
    expect(summary.keywords).toEqual({ total: 2, thresholdedCount: 1, thresholdedPct: 50 })
    expect(summary.placeActions).toMatchObject({ total: 1, hasReservationCta: true, hasDirectMerchantCta: true })
    expect(summary.lodging).toEqual({ lodgingLocationCount: 1, populatedLodgingCount: 0, emptyLodgingCount: 1 })
  })

  it('produces an all-zero/empty summary for a freshly-connected project with no data', () => {
    const summary = buildGbpSummary({
      locationName: null, locationCount: 0, referenceDate: '2026-05-15',
      dailyMetrics: [], keywords: [], placeActions: [], lodging: [],
    })
    expect(summary.performance.totals).toEqual({})
    expect(summary.keywords.thresholdedPct).toBe(0)
    expect(summary.placeActions.total).toBe(0)
    expect(summary.lodging.lodgingLocationCount).toBe(0)
  })
})
