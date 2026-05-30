import { describe, it, expect } from 'vitest'
import {
  computeMetricTotals,
  computeWindowDelta,
  computeFreshness,
  buildTimeseries,
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

describe('computeFreshness', () => {
  it('returns nulls / 0 for empty input', () => {
    expect(computeFreshness([], '2026-05-15')).toEqual({
      dataThroughDate: null, latestStoredDate: null, pendingDays: 0,
    })
  })

  it('excludes the trailing all-zero (reporting-lag) tail from the complete date', () => {
    // Data is real through 05-12, then Google has emitted not-yet-final zeros
    // for 05-13 / 05-14. The complete date is 05-12; 05-14 is the max stored.
    const rows = [
      { metric: 'WEBSITE_CLICKS', date: '2026-05-12', value: 5 },
      { metric: 'WEBSITE_CLICKS', date: '2026-05-13', value: 0 },
      { metric: 'CALL_CLICKS', date: '2026-05-13', value: 0 },
      { metric: 'WEBSITE_CLICKS', date: '2026-05-14', value: 0 },
    ]
    expect(computeFreshness(rows, '2026-05-15')).toEqual({
      dataThroughDate: '2026-05-12', latestStoredDate: '2026-05-14', pendingDays: 3,
    })
  })

  it('treats a stale series (no trailing zeros stored) as pending relative to asOf', () => {
    const rows = [{ metric: 'WEBSITE_CLICKS', date: '2026-05-12', value: 5 }]
    expect(computeFreshness(rows, '2026-05-15')).toEqual({
      dataThroughDate: '2026-05-12', latestStoredDate: '2026-05-12', pendingDays: 3,
    })
  })

  it('a zero day in the MIDDLE of the series does not end completeness', () => {
    const rows = [
      { metric: 'WEBSITE_CLICKS', date: '2026-05-10', value: 4 },
      { metric: 'WEBSITE_CLICKS', date: '2026-05-11', value: 0 },
      { metric: 'WEBSITE_CLICKS', date: '2026-05-12', value: 7 },
    ]
    expect(computeFreshness(rows, '2026-05-12').dataThroughDate).toBe('2026-05-12')
  })

  it('all-zero series → no complete date, pendingDays 0, latestStoredDate still set', () => {
    const rows = [
      { metric: 'BUSINESS_BOOKINGS', date: '2026-05-10', value: 0 },
      { metric: 'BUSINESS_BOOKINGS', date: '2026-05-11', value: 0 },
    ]
    expect(computeFreshness(rows, '2026-05-15')).toEqual({
      dataThroughDate: null, latestStoredDate: '2026-05-11', pendingDays: 0,
    })
  })

  it('clamps pendingDays at 0 when asOf is on/before the complete date', () => {
    const rows = [{ metric: 'WEBSITE_CLICKS', date: '2026-05-15', value: 5 }]
    expect(computeFreshness(rows, '2026-05-15').pendingDays).toBe(0)
    expect(computeFreshness(rows, '2026-05-14').pendingDays).toBe(0)
  })
})

describe('buildTimeseries', () => {
  it('returns [] for empty input', () => {
    expect(buildTimeseries([], { dataThroughDate: null, latestStoredDate: null, pendingDays: 0 })).toEqual([])
  })

  it('pivots per day, fills 0 for an absent metric, and flags the pending tail', () => {
    const rows = [
      { metric: 'WEBSITE_CLICKS', date: '2026-05-12', value: 20 },
      { metric: 'CALL_CLICKS', date: '2026-05-12', value: 3 },
      { metric: 'WEBSITE_CLICKS', date: '2026-05-13', value: 0 },
    ]
    const freshness = computeFreshness(rows, '2026-05-15') // through 05-12, stored to 05-13
    expect(buildTimeseries(rows, freshness)).toEqual([
      { date: '2026-05-12', pending: false, metrics: { WEBSITE_CLICKS: 20, CALL_CLICKS: 3 } },
      { date: '2026-05-13', pending: true, metrics: { WEBSITE_CLICKS: 0, CALL_CLICKS: 0 } },
    ])
  })

  it('excludes days older than the window', () => {
    const rows = [
      { metric: 'WEBSITE_CLICKS', date: '2026-03-01', value: 99 }, // > 30d before the max stored date
      { metric: 'WEBSITE_CLICKS', date: '2026-05-15', value: 5 },
    ]
    const out = buildTimeseries(rows, computeFreshness(rows, '2026-05-15'), 30)
    expect(out.map((d) => d.date)).toEqual(['2026-05-15'])
  })

  it('sorts ascending by date', () => {
    const rows = [
      { metric: 'X', date: '2026-05-14', value: 1 },
      { metric: 'X', date: '2026-05-10', value: 1 },
      { metric: 'X', date: '2026-05-12', value: 1 },
    ]
    expect(buildTimeseries(rows, computeFreshness(rows, '2026-05-15')).map((d) => d.date))
      .toEqual(['2026-05-10', '2026-05-12', '2026-05-14'])
  })
})

describe('buildGbpSummary (composition)', () => {
  it('composes sub-calculations and anchors deltas to complete days (lag-safe)', () => {
    const summary = buildGbpSummary({
      locationName: null,
      locationCount: 2,
      asOfDate: '2026-05-15',
      dailyMetrics: [
        { metric: 'WEBSITE_CLICKS', date: '2026-05-12', value: 20 }, // recent (anchor 05-12)
        { metric: 'CALL_CLICKS', date: '2026-05-12', value: 3 },     // recent
        { metric: 'WEBSITE_CLICKS', date: '2026-05-01', value: 10 }, // prior
        { metric: 'WEBSITE_CLICKS', date: '2026-05-15', value: 0 },  // lag tail — excluded from delta
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
    // Anchor is the last complete day (05-12), NOT the stored zero tail (05-15):
    // recent7d = (05-05, 05-12], prior7d = (04-28, 05-05].
    expect(summary.performance.recent7d).toEqual({ WEBSITE_CLICKS: 20, CALL_CLICKS: 3 })
    expect(summary.performance.prior7d).toEqual({ WEBSITE_CLICKS: 10, CALL_CLICKS: 0 })
    expect(summary.performance.deltaPct).toEqual({ WEBSITE_CLICKS: 100, CALL_CLICKS: null })
    expect(summary.freshness).toEqual({
      dataThroughDate: '2026-05-12', latestStoredDate: '2026-05-15', pendingDays: 3,
    })
    expect(summary.timeseries).toEqual([
      { date: '2026-05-01', pending: false, metrics: { WEBSITE_CLICKS: 10, CALL_CLICKS: 0 } },
      { date: '2026-05-12', pending: false, metrics: { WEBSITE_CLICKS: 20, CALL_CLICKS: 3 } },
      { date: '2026-05-15', pending: true, metrics: { WEBSITE_CLICKS: 0, CALL_CLICKS: 0 } },
    ])
    expect(summary.keywords).toEqual({ total: 2, thresholdedCount: 1, thresholdedPct: 50 })
    expect(summary.placeActions).toMatchObject({ total: 1, hasReservationCta: true, hasDirectMerchantCta: true })
    expect(summary.lodging).toEqual({ lodgingLocationCount: 1, populatedLodgingCount: 0, emptyLodgingCount: 1 })
  })

  it('does not show a red delta when the recent window is pure reporting-lag zeros', () => {
    // The exact bug from #658: flat-then-lag. Real, steady traffic through
    // 05-10, then stored zeros for the lagging tail. The recent-vs-prior delta
    // must be ~0 (flat), never a large negative driven by the zero tail.
    const daily: { metric: string; date: string; value: number }[] = []
    for (let d = 1; d <= 10; d++) {
      daily.push({ metric: 'WEBSITE_CLICKS', date: `2026-05-${String(d).padStart(2, '0')}`, value: 10 })
    }
    daily.push({ metric: 'WEBSITE_CLICKS', date: '2026-05-11', value: 0 })
    daily.push({ metric: 'WEBSITE_CLICKS', date: '2026-05-12', value: 0 })
    daily.push({ metric: 'WEBSITE_CLICKS', date: '2026-05-13', value: 0 })
    const summary = buildGbpSummary({
      locationName: null, locationCount: 1, asOfDate: '2026-05-13',
      dailyMetrics: daily, keywords: [], placeActions: [], lodging: [],
    })
    // Anchor 05-10: recent (05-03, 05-10] = 7×10 = 70; prior (04-26, 05-03] = 05-01..05-03 = 3×10 = 30.
    expect(summary.performance.deltaPct.WEBSITE_CLICKS).toBeGreaterThanOrEqual(0)
    expect(summary.freshness.dataThroughDate).toBe('2026-05-10')
    expect(summary.freshness.pendingDays).toBe(3)
  })

  it('produces an all-zero/empty summary for a freshly-connected project with no data', () => {
    const summary = buildGbpSummary({
      locationName: null, locationCount: 0, asOfDate: '2026-05-15',
      dailyMetrics: [], keywords: [], placeActions: [], lodging: [],
    })
    expect(summary.performance.totals).toEqual({})
    expect(summary.freshness).toEqual({ dataThroughDate: null, latestStoredDate: null, pendingDays: 0 })
    expect(summary.timeseries).toEqual([])
    expect(summary.keywords.thresholdedPct).toBe(0)
    expect(summary.placeActions.total).toBe(0)
    expect(summary.lodging.lodgingLocationCount).toBe(0)
  })
})
