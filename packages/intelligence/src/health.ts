import type { RunData, HealthScore, HealthTrend } from './types.js'

/**
 * Citation and mention health for one run, per (query × provider) pair.
 *
 * The two signals never share a denominator. Mention is over every pair.
 * Citation is over the pairs whose sources were checked: a pair whose engine
 * returns no sources (`cited === null`) is counted in `citationNotMeasured`
 * and left out of every cited rate, which is null when no pair was checked.
 */
export function computeHealth(run: RunData): HealthScore {
  const providerStats = new Map<string, { cited: number; mentioned: number; total: number; citationNotMeasured: number }>()

  let totalPairs = 0
  let citedPairs = 0
  let citationNotMeasuredPairs = 0
  let mentionedPairs = 0

  for (const snap of run.snapshots) {
    totalPairs++
    if (snap.cited === true) citedPairs++
    if (snap.cited === null) citationNotMeasuredPairs++
    // Mention is the independent answer-text signal. Tri-state: count a pair
    // ONLY when it is exactly `true`. `false` and `null`/`undefined` ("not
    // checked") both leave the numerator untouched — null is never coerced to
    // false. Never derive this from `cited`.
    if (snap.answerMentioned === true) mentionedPairs++

    const stats = providerStats.get(snap.provider) ?? { cited: 0, mentioned: 0, total: 0, citationNotMeasured: 0 }
    stats.total++
    if (snap.cited === true) stats.cited++
    if (snap.cited === null) stats.citationNotMeasured++
    if (snap.answerMentioned === true) stats.mentioned++
    providerStats.set(snap.provider, stats)
  }

  const providerBreakdown: HealthScore['providerBreakdown'] = {}
  for (const [provider, stats] of providerStats) {
    providerBreakdown[provider] = {
      citedRate: citedRateOver(stats.cited, stats.total - stats.citationNotMeasured),
      mentionRate: stats.total > 0 ? stats.mentioned / stats.total : 0,
      cited: stats.cited,
      mentioned: stats.mentioned,
      total: stats.total,
      citationNotMeasured: stats.citationNotMeasured,
    }
  }

  return {
    // No pairs at all stays 0, as before; pairs none of which was checked is null.
    overallCitedRate: totalPairs === 0 ? 0 : citedRateOver(citedPairs, totalPairs - citationNotMeasuredPairs),
    overallMentionRate: totalPairs > 0 ? mentionedPairs / totalPairs : 0,
    totalPairs,
    citedPairs,
    citationNotMeasuredPairs,
    mentionedPairs,
    providerBreakdown,
  }
}

function citedRateOver(cited: number, measured: number): number | null {
  return measured > 0 ? cited / measured : null
}

export function computeHealthTrend(runs: RunData[]): HealthTrend {
  if (runs.length === 0) {
    return { current: 0, previous: 0, delta: 0 }
  }

  const current = computeHealth(runs[runs.length - 1]!).overallCitedRate

  if (runs.length === 1) {
    return { current, previous: 0, delta: current }
  }

  const previous = computeHealth(runs[runs.length - 2]!).overallCitedRate

  return {
    current,
    previous,
    // A movement needs a measured rate on both sides.
    delta: current === null || previous === null ? null : current - previous,
  }
}
