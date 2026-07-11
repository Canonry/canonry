/**
 * Small, exact statistical helpers shared across the platform.
 *
 * Kept in `contracts` (pure, no I/O) per the Shared Utilities rule so the
 * report, the API, and the CLI all attach the SAME interval to a proportion
 * instead of each hand-rolling one — see `visibility-compare`, which reports
 * every monthly rate as `point (Wilson low–high)`.
 */

export interface ConfidenceInterval {
  /** Lower bound of the interval, clamped to [0, 1]. */
  low: number
  /** Upper bound of the interval, clamped to [0, 1]. */
  high: number
}

/** Rounds to `dp` decimal places (default 4) with no negative-zero. */
function round(value: number, dp = 4): number {
  const f = 10 ** dp
  return (Math.round(value * f) + 0) / f
}

/**
 * Wilson score interval for a binomial proportion — the display default for
 * mention / cited / share-of-voice rates.
 *
 * Preferred over the normal (Wald) interval because it behaves at the extremes
 * these AEO datasets actually hit: at `successes = 0` it returns `[0, upper]`
 * rather than the degenerate `[0, 0]` Wald gives, and it never overshoots
 * `[0, 1]`. Default `z = 1.96` (95%).
 *
 * Returns `null` when `n === 0` — a proportion over no samples is undefined, and
 * a caller must render "no data", not a fabricated interval.
 *
 * Caveat for the caller: this treats the `n` snapshots as independent Bernoulli
 * draws. AEO snapshots CLUSTER within query and sweep, so the true interval is
 * wider; the rigorous version is a cluster bootstrap over sweeps, which is only
 * meaningful at K >= 5 sweeps. Wilson is the honest, reproducible display floor.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): ConfidenceInterval | null {
  if (!Number.isFinite(n) || n <= 0) return null
  const s = Math.max(0, Math.min(successes, n))
  const p = s / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    low: round(Math.max(0, center - margin)),
    high: round(Math.min(1, center + margin)),
  }
}
