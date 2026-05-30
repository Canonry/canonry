/**
 * Pure calculation helpers for the GBP summary endpoint.
 *
 * Every derived number the dashboard shows is computed here, not in the
 * route handler or the web component — so the math has one home and one set
 * of tests (`gbp-summary.test.ts`). The functions take plain values and a
 * caller-supplied `referenceDate` (never `Date.now()`), so they're fully
 * deterministic and unit-testable.
 *
 * Conventions:
 *   - Percentages are integers in [0, 100], rounded.
 *   - A delta against a zero baseline is `null` (not `Infinity`/`NaN`).
 *   - Empty input yields zeros / empty maps, never `NaN`.
 */

export interface DailyMetricInput {
  metric: string
  /** YYYY-MM-DD */
  date: string
  value: number
}

export interface KeywordInput {
  valueCount: number | null
  valueThreshold: number | null
}

export interface PlaceActionInput {
  placeActionType: string
  providerType: string | null
}

export interface LodgingInput {
  locationName: string
  populatedGroupCount: number
}

/** Sum `value` grouped by `metric`. A metric that only ever sees 0 stays at 0. */
export function computeMetricTotals(rows: DailyMetricInput[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const row of rows) {
    totals[row.metric] = (totals[row.metric] ?? 0) + row.value
  }
  return totals
}

/** Shift a YYYY-MM-DD date string by `days` (negative = earlier). Pure. */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!))
  dt.setUTCDate(dt.getUTCDate() + days)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** Whole calendar days from `from` to `to` (YYYY-MM-DD); negative when `to` is earlier. Pure. */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000)
}

function roundPct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 100)
}

export interface WindowDelta {
  recent7d: Record<string, number>
  prior7d: Record<string, number>
  /** Per-metric % change recent-vs-prior; null when the prior window is 0. */
  deltaPct: Record<string, number | null>
}

/**
 * Split daily metrics into the most recent 7 days and the 7 days before that,
 * relative to `referenceDate`, and compute the per-metric percent change.
 *
 * Windows (so the boundary day lands in exactly one bucket):
 *   recent7d: (referenceDate - 7, referenceDate]
 *   prior7d:  (referenceDate - 14, referenceDate - 7]
 */
export function computeWindowDelta(rows: DailyMetricInput[], referenceDate: string): WindowDelta {
  const recentLow = shiftDate(referenceDate, -7)   // exclusive
  const priorLow = shiftDate(referenceDate, -14)   // exclusive
  const recent7d: Record<string, number> = {}
  const prior7d: Record<string, number> = {}

  for (const row of rows) {
    if (row.date > recentLow && row.date <= referenceDate) {
      recent7d[row.metric] = (recent7d[row.metric] ?? 0) + row.value
    } else if (row.date > priorLow && row.date <= recentLow) {
      prior7d[row.metric] = (prior7d[row.metric] ?? 0) + row.value
    }
  }

  // Backfill both windows with the union of metrics so a consumer comparing
  // recent-vs-prior per metric always sees both sides (0 where a window had
  // no rows for that metric), rather than a key present on one side only.
  const deltaPct: Record<string, number | null> = {}
  const metrics = new Set([...Object.keys(recent7d), ...Object.keys(prior7d)])
  for (const metric of metrics) {
    const recent = recent7d[metric] ?? 0
    const prior = prior7d[metric] ?? 0
    recent7d[metric] = recent
    prior7d[metric] = prior
    deltaPct[metric] = prior === 0 ? null : Math.round(((recent - prior) / prior) * 100)
  }

  return { recent7d, prior7d, deltaPct }
}

export interface GbpFreshness {
  /** Latest day with reported (non-zero) activity — the last complete day. Null when there's no data. */
  dataThroughDate: string | null
  /** Max stored metric date (>= dataThroughDate when the lag tail was stored as zeros). Null when there's no data. */
  latestStoredDate: string | null
  /** Calendar days between dataThroughDate and `asOfDate` — the trailing pending window. */
  pendingDays: number
}

/**
 * Detect the reporting-lag tail. GBP Performance data lags a few days, and the
 * most recent stored days can be not-yet-reported zeros. The last day with any
 * activity is the last day we trust as complete; everything after it (up to the
 * max stored date) is pending. `pendingDays` is measured against `asOfDate` so
 * it reflects how stale the data is relative to "now", matching what the
 * dashboard labels ("data through <date> · Nd pending").
 *
 * A zero day in the MIDDLE of the series is a real reported zero, not pending —
 * only the TRAILING zeros count, which is exactly what "latest non-zero date"
 * captures.
 */
export function computeFreshness(rows: DailyMetricInput[], asOfDate: string): GbpFreshness {
  if (rows.length === 0) return { dataThroughDate: null, latestStoredDate: null, pendingDays: 0 }

  let latestStoredDate = ''
  const totalByDate = new Map<string, number>()
  for (const row of rows) {
    if (row.date > latestStoredDate) latestStoredDate = row.date
    totalByDate.set(row.date, (totalByDate.get(row.date) ?? 0) + row.value)
  }

  let dataThroughDate: string | null = null
  for (const [date, total] of totalByDate) {
    if (total > 0 && (dataThroughDate === null || date > dataThroughDate)) dataThroughDate = date
  }

  const pendingDays = dataThroughDate ? Math.max(0, daysBetween(dataThroughDate, asOfDate)) : 0
  return { dataThroughDate, latestStoredDate: latestStoredDate || null, pendingDays }
}

export interface TimeseriesDay {
  /** YYYY-MM-DD */
  date: string
  /** True when this day is in the trailing unreported window (date > dataThroughDate). */
  pending: boolean
  /** Every metric present in the window, 0 where this day had no row for it. */
  metrics: Record<string, number>
}

/**
 * Pivot the daily rows into a chart-ready series over the most recent
 * `windowDays` days (relative to the max stored date). Every day carries every
 * metric seen in the window (0 where a metric had no row that day) so the lines
 * stay continuous, and each day is flagged `pending` when it falls in the
 * reporting-lag tail. Only days that actually have rows are included — we never
 * fabricate days Google didn't report.
 */
export function buildTimeseries(rows: DailyMetricInput[], freshness: GbpFreshness, windowDays = 30): TimeseriesDay[] {
  if (rows.length === 0 || freshness.latestStoredDate === null) return []
  const windowLow = shiftDate(freshness.latestStoredDate, -(windowDays - 1))

  const metricKeys = new Set<string>()
  const byDate = new Map<string, Record<string, number>>()
  for (const row of rows) {
    if (row.date < windowLow || row.date > freshness.latestStoredDate) continue
    metricKeys.add(row.metric)
    const day = byDate.get(row.date) ?? {}
    day[row.metric] = (day[row.metric] ?? 0) + row.value
    byDate.set(row.date, day)
  }

  return [...byDate.keys()].sort().map((date) => {
    const present = byDate.get(date)!
    const metrics: Record<string, number> = {}
    for (const key of metricKeys) metrics[key] = present[key] ?? 0
    return {
      date,
      pending: freshness.dataThroughDate !== null && date > freshness.dataThroughDate,
      metrics,
    }
  })
}

export interface KeywordCoverage {
  total: number
  thresholdedCount: number
  /** Share of keywords privacy-redacted by Google, 0–100. */
  thresholdedPct: number
}

/** A keyword is "thresholded" when Google withheld the exact count. */
export function computeKeywordCoverage(rows: KeywordInput[]): KeywordCoverage {
  const total = rows.length
  const thresholdedCount = rows.filter((r) => r.valueCount === null).length
  return { total, thresholdedCount, thresholdedPct: roundPct(thresholdedCount, total) }
}

export interface PlaceActionSummary {
  total: number
  hasReservationCta: boolean
  hasBookingCta: boolean
  /** A direct (MERCHANT) CTA, as opposed to an OTA/aggregator link. */
  hasDirectMerchantCta: boolean
}

export function summarizePlaceActions(rows: PlaceActionInput[]): PlaceActionSummary {
  return {
    total: rows.length,
    hasReservationCta: rows.some((r) => r.placeActionType === 'RESERVATION'),
    hasBookingCta: rows.some((r) => r.placeActionType === 'BOOK'),
    hasDirectMerchantCta: rows.some((r) => r.providerType === 'MERCHANT'),
  }
}

export interface LodgingSummary {
  /** Locations that have a lodging profile at all (lodging-capable). */
  lodgingLocationCount: number
  populatedLodgingCount: number
  /** Lodging-capable locations with zero structured attributes — an AEO gap. */
  emptyLodgingCount: number
}

export function summarizeLodging(rows: LodgingInput[]): LodgingSummary {
  const populatedLodgingCount = rows.filter((r) => r.populatedGroupCount > 0).length
  return {
    lodgingLocationCount: rows.length,
    populatedLodgingCount,
    emptyLodgingCount: rows.length - populatedLodgingCount,
  }
}

export interface GbpSummaryInput {
  locationName: string | null
  locationCount: number
  /** The server "today" (YYYY-MM-DD). The complete-day anchor is derived from the data, not this. */
  asOfDate: string
  dailyMetrics: DailyMetricInput[]
  keywords: KeywordInput[]
  placeActions: PlaceActionInput[]
  lodging: LodgingInput[]
}

export interface GbpSummary {
  scope: { locationName: string | null; locationCount: number }
  performance: {
    totals: Record<string, number>
    recent7d: Record<string, number>
    prior7d: Record<string, number>
    deltaPct: Record<string, number | null>
  }
  freshness: GbpFreshness
  timeseries: TimeseriesDay[]
  keywords: KeywordCoverage
  placeActions: PlaceActionSummary
  lodging: LodgingSummary
}

/** Compose every sub-calculation into the summary the API returns. */
export function buildGbpSummary(input: GbpSummaryInput): GbpSummary {
  const freshness = computeFreshness(input.dailyMetrics, input.asOfDate)
  // Anchor the recent/prior windows to the last COMPLETE day, not the lagging
  // tail — so the trailing not-yet-reported zeros can never drag the recent
  // window into a false red decline. Fall back to asOfDate when no data yet.
  const anchor = freshness.dataThroughDate ?? input.asOfDate
  const window = computeWindowDelta(input.dailyMetrics, anchor)
  return {
    scope: { locationName: input.locationName, locationCount: input.locationCount },
    performance: {
      totals: computeMetricTotals(input.dailyMetrics),
      recent7d: window.recent7d,
      prior7d: window.prior7d,
      deltaPct: window.deltaPct,
    },
    freshness,
    timeseries: buildTimeseries(input.dailyMetrics, freshness),
    keywords: computeKeywordCoverage(input.keywords),
    placeActions: summarizePlaceActions(input.placeActions),
    lodging: summarizeLodging(input.lodging),
  }
}
