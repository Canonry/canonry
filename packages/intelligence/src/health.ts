import type { RunData, HealthScore, HealthTrend } from './types.js'

export function computeHealth(run: RunData): HealthScore {
  const providerStats = new Map<string, { cited: number; mentioned: number; total: number }>()

  let totalPairs = 0
  let citedPairs = 0
  let mentionedPairs = 0

  for (const snap of run.snapshots) {
    totalPairs++
    if (snap.cited) citedPairs++
    // Mention is the independent answer-text signal. Tri-state: count a pair
    // ONLY when it is exactly `true`. `false` and `null`/`undefined` ("not
    // checked") both leave the numerator untouched — null is never coerced to
    // false. Never derive this from `cited`.
    if (snap.answerMentioned === true) mentionedPairs++

    const stats = providerStats.get(snap.provider) ?? { cited: 0, mentioned: 0, total: 0 }
    stats.total++
    if (snap.cited) stats.cited++
    if (snap.answerMentioned === true) stats.mentioned++
    providerStats.set(snap.provider, stats)
  }

  const providerBreakdown: HealthScore['providerBreakdown'] = {}
  for (const [provider, stats] of providerStats) {
    providerBreakdown[provider] = {
      citedRate: stats.total > 0 ? stats.cited / stats.total : 0,
      mentionRate: stats.total > 0 ? stats.mentioned / stats.total : 0,
      cited: stats.cited,
      mentioned: stats.mentioned,
      total: stats.total,
    }
  }

  return {
    overallCitedRate: totalPairs > 0 ? citedPairs / totalPairs : 0,
    overallMentionRate: totalPairs > 0 ? mentionedPairs / totalPairs : 0,
    totalPairs,
    citedPairs,
    mentionedPairs,
    providerBreakdown,
  }
}

export function computeHealthTrend(runs: RunData[]): HealthTrend {
  if (runs.length === 0) {
    return { current: 0, previous: 0, delta: 0 }
  }

  const current = computeHealth(runs[runs.length - 1]).overallCitedRate

  if (runs.length === 1) {
    return { current, previous: 0, delta: current }
  }

  const previous = computeHealth(runs[runs.length - 2]).overallCitedRate

  return {
    current,
    previous,
    delta: current - previous,
  }
}
