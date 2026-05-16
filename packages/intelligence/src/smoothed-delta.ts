/**
 * Rolling-window comparison for per-run trend points. Replaces brittle
 * point-to-point deltas ("latest run vs prior run") with an average-of-recent
 * vs average-of-prior comparison so a single noisy run doesn't flip the
 * tone arrow.
 *
 * Twitchy example this exists to fix: a 20-query basket where one query
 * happens to cite this week and not next week swings the citation rate
 * by 5 percentage points run-over-run. Reading that as "down 5pp" tells
 * the operator nothing real. Averaging the last 3 runs against the prior
 * 3 runs collapses that single-query bounce into the noise floor.
 *
 * Pure function. No DB access, no I/O. Caller passes the trend array and
 * a value extractor; this helper does the windowing math.
 */

export interface SmoothedRunDelta {
  /** Average of the most recent `window` points, rounded to 1 decimal. */
  current: number
  /** Average of the prior `window` points before that, rounded to 1 decimal. */
  prior: number
  /** Unrounded `current - prior` average. Caller compares against a
   *  threshold (e.g. 3pp for rates) to decide up/down/flat. */
  deltaAbs: number
  /** How many points went into each side of the average. 1 = point-to-point
   *  (only 2–3 runs in history); higher = real smoothing. Renderers use
   *  this to label "vs prior N checks" vs "since last check". */
  window: number
}

export const SMOOTHED_RUN_DELTA_MAX_WINDOW = 3

/**
 * Compute a smoothed-trend delta from a series of per-run points.
 *
 * Behavior:
 *   - `points` is ordered oldest → newest (newest last). 1 or 0 points → null.
 *   - Window grows up to `maxWindow` based on how much history exists.
 *     With 6+ points we use `maxWindow` on each side. With 2 points we
 *     fall back to window=1 (point-to-point, matching the legacy delta).
 *     The two windows never overlap.
 *   - Caller owns the up/down/flat threshold — this helper just emits
 *     `deltaAbs` so the caller can pick a meaningful floor (e.g. 3pp for
 *     percentage rates, 0.5 for integer counts).
 */
export function smoothedRunDelta<T>(
  points: readonly T[],
  valueFn: (point: T) => number,
  maxWindow: number = SMOOTHED_RUN_DELTA_MAX_WINDOW,
): SmoothedRunDelta | null {
  if (points.length < 2) return null
  const window = Math.min(maxWindow, Math.floor(points.length / 2))
  const tail = points.slice(-window)
  const prior = points.slice(-window * 2, -window)
  const sum = (arr: readonly T[]): number => arr.reduce((s, p) => s + valueFn(p), 0)
  const currentAvg = sum(tail) / tail.length
  const priorAvg = sum(prior) / prior.length
  return {
    current: roundTo1Decimal(currentAvg),
    prior: roundTo1Decimal(priorAvg),
    deltaAbs: currentAvg - priorAvg,
    window,
  }
}

function roundTo1Decimal(value: number): number {
  return Math.round(value * 10) / 10
}
