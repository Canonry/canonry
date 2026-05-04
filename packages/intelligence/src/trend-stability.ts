/**
 * Pure trend-meaningfulness predicate.
 *
 * A 5%→1% trend on N=2 reads as a crisis to a non-analyst reader, but is
 * pure noise on a sample of two runs. Anywhere a trend is consumed — the
 * report renderer's line chart, the dashboard's project tile, Aero's
 * narration — should suppress the trend visualization until enough runs
 * exist to support it.
 *
 * `MIN_TREND_POINTS` is the minimum sample size before a trend is shown.
 * Tuned conservatively: 4 = at least one full direction-change is observable.
 */

export const MIN_TREND_POINTS = 4

/** True when the series is too small to support a meaningful trend display. */
export function isTrendBaseline(points: readonly unknown[]): boolean {
  return points.length < MIN_TREND_POINTS
}
