/**
 * Trailing-period vs prior-equal-period comparison for GSC search performance.
 *
 * Why this exists, and why it is not the fitted trend line.
 *
 * The dashboard used to express each tile's percentage as the least-squares
 * line's start-to-end movement over its own START value. Two things go wrong
 * with that, and both were observed on a real property:
 *
 * 1. The fit is unconstrained, so the value it predicts for day one can be zero
 *    or negative even for a metric that cannot be negative. Impressions on that
 *    property fitted to -13.98 on day one, so there was no baseline to divide
 *    by and the tile printed nothing at all — on a metric that had grown almost
 *    six-fold. The longer the window, the likelier this is: a steep recent ramp
 *    drags the backward extrapolation below zero.
 * 2. Where it did print, it described the LINE rather than the data. Average
 *    position fitted 17.70 -> 25.81 and read as a 45.8% improvement, while the
 *    property's actual position went from 22.6 to 24.2, i.e. slightly WORSE.
 *    A number that points the opposite way to reality is worse than a blank.
 *
 * So the comparison is between two equal-length stretches of REAL recorded
 * days. Nothing is extrapolated; omitted dates inside the observed frontier are
 * zero-count days, while dates beyond the frontier are kept out by the route
 * because their state is unknown.
 *
 * The caller chooses which span to hand in, and that choice is the `basis`:
 *
 * - `prior-window` — the span is TWICE the selected window, so the halves come
 *   out as the selected window itself against the equal-length period
 *   immediately before it. This is what a reader means by "90d": clicking 90d
 *   and reading "vs prior 45d" was the split talking, not the button.
 * - `split-window` — the span is the selected window, so the halves are its own
 *   trailing and leading halves. The fallback, and the only thing available
 *   when the selection is unbounded (`window=all` has nothing before it) or
 *   when the period before it was never synced.
 *
 * Either way this module does one thing: split the span it is given down the
 * middle of the CALENDAR and aggregate both sides. It does not decide the
 * basis, it only records which one the caller asked for.
 *
 * No DB, no clock, no I/O — same posture as `gbp-summary.ts` and
 * `visibility-compare.ts`, so the whole thing is unit-testable from literals.
 */

/**
 * Which table a figure came from.
 *
 * `gsc_daily_totals` (property-daily) and `SUM(gsc_search_data)` (dimensioned)
 * are NOT interchangeable, and the difference is large: on one real
 * property-month the same period reads 1,142 clicks / 34,916 impressions from
 * the property table and 792 / 45,266 from the dimensioned sum, because Google
 * withholds rare queries (under-counting clicks) and fans one impression out
 * across every query x page x country x device row (over-counting impressions).
 */
export type GscTotalsSource = 'property-daily' | 'dimensioned' | 'mixed' | 'empty'

/**
 * Which two periods the percentages compare.
 *
 * `prior-window` is the selected window against the equal-length period before
 * it. `split-window` is the selected window's own two halves, so its `days` is
 * HALF the selected window and a surface printing "vs prior {days}d" is naming
 * a period shorter than the button the reader pressed. That is honest but
 * surprising, which is exactly why it is labelled rather than left implicit.
 */
export type GscComparisonBasis = 'prior-window' | 'split-window'

const DAY_MS = 86_400_000

/** UTC midnight for one canonical `YYYY-MM-DD`, or null for an impossible date. */
function calendarDateMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null
  return parsed.getTime()
}

function calendarDateAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** One day as the performance route assembles it. `position` is nullable. */
export interface GscDailyRow {
  date: string
  clicks: number
  impressions: number
  position: number | null
  /**
   * True when this date came from the un-dimensioned property-daily table.
   *
   * The route merges both sources per date, so an install that synced
   * dimensioned data before the property-daily table existed has a window whose
   * older half is one source and newer half the other. Comparing across that
   * boundary divides one measurement system by another.
   */
  fromPropertyTotals: boolean
}

export interface GscPeriodTotals {
  startDate: string
  endDate: string
  clicks: number
  impressions: number
  /** `clicks / impressions` for the WHOLE period, never a mean of daily ratios. */
  ctr: number | null
  /** Impression-weighted mean position, or null when no day carried one. */
  position: number | null
  /** Which table this period's figures came from. */
  source: GscTotalsSource
}

export interface GscPeriodChange {
  clicks: number | null
  impressions: number | null
  ctr: number | null
  position: number | null
}

export interface GscPeriodComparison {
  /** Length of EACH period in calendar days. */
  days: number
  /**
   * Which two periods these are. Under `prior-window`, `days` equals the
   * selected window; under `split-window` it is half of it.
   */
  basis: GscComparisonBasis
  prior: GscPeriodTotals
  trailing: GscPeriodTotals
  /**
   * False when either period contains dimensioned fallback totals, in which
   * case every `change` is null. Empty/property-daily halves remain comparable.
   *
   * A ratio of one source to the other is not a change in the property, it is
   * the gap between two counting methods. On the measured pair above, a
   * perfectly FLAT property whose window uses the two sources would report
   * clicks +44%, impressions -23% and CTR +87%. `totals` tolerates the mix
   * because a uniform bias in a level is still monotone; a ratio of two
   * differently-sourced halves is not. Even dimensioned/dimensioned is refused:
   * the table is valid for rankings, not property totals. Same posture as
   * `top-pages`, which returns null rather than falling back for a total.
   */
  comparable: boolean
  /**
   * Relative change as a ratio (0.5 = +50%), or null where the prior period
   * gives nothing to divide by or the trailing metric is unavailable. Sign is
   * mathematical: for position, a POSITIVE value means the number went up,
   * which is a worse rank. Desirability is the renderer's business, not this
   * module's.
   */
  change: GscPeriodChange
}

/**
 * Relative change, or null when the baseline cannot support one or the trailing
 * value is unavailable.
 *
 * A zero baseline is the honest blank: going from no clicks to some clicks is
 * an infinite increase, and "+∞%" or a silently substituted "+100%" would both
 * be inventions. A null baseline means the metric was never measured.
 */
function relativeChange(trailing: number | null, prior: number | null): number | null {
  if (trailing === null || prior === null) return null
  if (!Number.isFinite(trailing) || !Number.isFinite(prior)) return null
  if (prior <= 0) return null
  return (trailing - prior) / prior
}

function aggregate(
  startDate: string,
  endDate: string,
  byDate: Map<string, GscDailyRow>,
): GscPeriodTotals {
  let clicks = 0
  let impressions = 0
  let positionWeight = 0
  let positionWeighted = 0
  let propertyDays = 0
  let dimensionedDays = 0

  for (const row of byDate.values()) {
    if (row.date < startDate || row.date > endDate) continue
    if (row.fromPropertyTotals) propertyDays += 1
    else dimensionedDays += 1
    // Calendar dates with no row add zero to the counts. Search Analytics omits
    // zero-data days rather than reporting them, so the explicit boundaries —
    // not the number of returned rows — define the period length.
    clicks += row.clicks
    impressions += row.impressions
    // Position is non-additive and weighted by impressions, matching how the
    // route computes the window total. A day with one impression must not pull
    // the mean as hard as a day with a thousand, and a day with no impressions
    // has no weight to contribute at all.
    if (row.position !== null && row.impressions > 0) {
      positionWeight += row.impressions
      positionWeighted += row.position * row.impressions
    }
  }

  return {
    startDate,
    endDate,
    clicks,
    impressions,
    // CTR is a ratio of the period's own totals. Averaging the daily ratios
    // instead would weight a 1-impression day equally with a 1000-impression
    // one and would not reconcile with the clicks and impressions beside it.
    ctr: impressions > 0 ? clicks / impressions : null,
    position: positionWeight > 0 ? positionWeighted / positionWeight : null,
    // Empty is its own provenance. It is a real zero-count period, not evidence
    // from the invalid-for-totals dimensioned table.
    source: propertyDays > 0 && dimensionedDays > 0
      ? 'mixed'
      : propertyDays > 0 ? 'property-daily' : dimensionedDays > 0 ? 'dimensioned' : 'empty',
  }
}

/**
 * Split the given span into two equal, adjacent calendar periods and compare
 * them.
 *
 * `bounds` is the whole span to divide, NOT the window the caller is showing.
 * Hand in twice the selected window and the halves come out as that window
 * against the equal-length period before it (`basis: 'prior-window'`); hand in
 * the selected window itself and they come out as its own two halves
 * (`basis: 'split-window'`). This module does not choose — the route does, and
 * passes the `basis` so the number can be labelled for what it is.
 *
 * The split is over the CALENDAR, not over the row array. `daily` carries only
 * dates that produced data, so splitting it down the middle puts a different
 * number of real days on each side whenever the property had a quiet stretch —
 * the same defect that made the trend fit compress quiet periods before it was
 * densified.
 *
 * When the span is an odd number of days the OLDEST day is dropped, because two
 * periods of equal length is the whole point of the comparison; an off-by-one
 * on the older side would quietly flatter or punish the trailing period. A
 * `prior-window` span is even by construction and never loses a day.
 *
 * Returns null when the span cannot make two periods of at least one day each.
 */
export function computeGscPeriodComparison(
  daily: readonly GscDailyRow[],
  bounds?: { startDate: string; endDate: string; basis?: GscComparisonBasis },
): GscPeriodComparison | null {
  const first = bounds?.startDate ?? daily[0]?.date
  const last = bounds?.endDate ?? daily[daily.length - 1]?.date
  if (!first || !last) return null
  const firstMs = calendarDateMs(first)
  const lastMs = calendarDateMs(last)
  if (firstMs === null || lastMs === null || firstMs > lastMs) return null
  const spanDays = Math.floor((lastMs - firstMs) / DAY_MS) + 1
  const periodDays = Math.floor(spanDays / 2)
  if (periodDays < 1) return null

  const byDate = new Map(daily.map((row) => [row.date, row]))
  // Anchor both periods on the requested end. This drops the OLDEST day when
  // the span is odd and needs only four boundary strings even for a very wide
  // custom range — no million-entry calendar allocation.
  const trailingStart = calendarDateAt(lastMs - (periodDays - 1) * DAY_MS)
  const priorEnd = calendarDateAt(lastMs - periodDays * DAY_MS)
  const priorStart = calendarDateAt(lastMs - (periodDays * 2 - 1) * DAY_MS)

  const prior = aggregate(priorStart, priorEnd, byDate)
  const trailing = aggregate(trailingStart, last, byDate)

  // An explicitly requested range can be entirely quiet. There is then no
  // observed measurement source and no useful comparison payload to return.
  if (prior.source === 'empty' && trailing.source === 'empty') return null

  // Only property-level daily evidence can support totals. An empty half is a
  // real zero and may be compared with a property-daily half; any dimensioned
  // evidence (alone or mixed into a half) makes the ratio unavailable.
  const comparable = prior.source !== 'dimensioned'
    && prior.source !== 'mixed'
    && trailing.source !== 'dimensioned'
    && trailing.source !== 'mixed'

  return {
    days: periodDays,
    basis: bounds?.basis ?? 'split-window',
    prior,
    trailing,
    comparable,
    change: {
      clicks: comparable ? relativeChange(trailing.clicks, prior.clicks) : null,
      impressions: comparable ? relativeChange(trailing.impressions, prior.impressions) : null,
      ctr: comparable ? relativeChange(trailing.ctr, prior.ctr) : null,
      position: comparable ? relativeChange(trailing.position, prior.position) : null,
    },
  }
}
