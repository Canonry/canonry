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

import { deltaPercent, roundRatio, type RatioUnit } from '@ainyc/canonry-contracts'

export interface SmoothedRunDelta {
  /** Average of the most recent `window` points: the ratio wire precision for
   *  a ratio series (`ratioUnit`), otherwise rounded to 1 decimal. */
  current: number
  /** Average of the prior `window` points before that, rounded like `current`. */
  prior: number
  /** Unrounded `current - prior` average. Caller compares against a
   *  threshold (e.g. 3pp for rates) to decide up/down/flat. */
  deltaAbs: number
  /** Signed percent change of `current` vs `prior` (rounded averages), in
   *  percent units to two decimals (`deltaPercent`). Null when `prior <= 0`.
   *  Renderers route count tiles through the "smart %" rule with this. */
  deltaPct: number | null
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
 *   - `ratioUnit` says the series is a ratio in that unit (a 0..100 rate is
 *     `percent`). Its averages then keep the ratio wire precision
 *     (`roundRatio`), so a display never shows a tenth that rounding made up
 *     or a 100% that was 99.96%. Without it the points are counts and their
 *     averages keep one decimal.
 */
export function smoothedRunDelta<T>(
  points: readonly T[],
  valueFn: (point: T) => number,
  maxWindow: number = SMOOTHED_RUN_DELTA_MAX_WINDOW,
  ratioUnit?: RatioUnit,
): SmoothedRunDelta | null {
  if (points.length < 2) return null
  const window = Math.min(maxWindow, Math.floor(points.length / 2))
  const tail = points.slice(-window)
  const prior = points.slice(-window * 2, -window)
  const sum = (arr: readonly T[]): number => arr.reduce((s, p) => s + valueFn(p), 0)
  const currentAvg = sum(tail) / tail.length
  const priorAvg = sum(prior) / prior.length
  const round = (value: number): number => ratioUnit ? roundRatio(value, ratioUnit) : roundTo1Decimal(value)
  const current = round(currentAvg)
  const prior_ = round(priorAvg)
  return {
    current,
    prior: prior_,
    deltaAbs: currentAvg - priorAvg,
    deltaPct: deltaPercent(current, prior_),
    window,
  }
}

function roundTo1Decimal(value: number): number {
  return Math.round(value * 10) / 10
}
