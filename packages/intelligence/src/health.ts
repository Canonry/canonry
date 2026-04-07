import type { RunData, HealthScore, HealthTrend } from './types.js'

export function computeHealth(run: RunData): HealthScore {
  const providerStats = new Map<string, { cited: number; total: number }>()

  let totalPairs = 0
  let citedPairs = 0

  for (const snap of run.snapshots) {
    totalPairs++
    if (snap.cited) citedPairs++

    const stats = providerStats.get(snap.provider) ?? { cited: 0, total: 0 }
    stats.total++
    if (snap.cited) stats.cited++
    providerStats.set(snap.provider, stats)
  }

  const providerBreakdown: HealthScore['providerBreakdown'] = {}
  for (const [provider, stats] of providerStats) {
    providerBreakdown[provider] = {
      citedRate: stats.total > 0 ? stats.cited / stats.total : 0,
      cited: stats.cited,
      total: stats.total,
    }
  }

  return {
    overallCitedRate: totalPairs > 0 ? citedPairs / totalPairs : 0,
    totalPairs,
    citedPairs,
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
