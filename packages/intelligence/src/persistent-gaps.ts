import type { RunData, PersistentGap } from './types.js'

export const PERSISTENT_GAP_THRESHOLD = 3

/**
 * A persistent-gap is a query that has had **no cited provider** for at least
 * `threshold` consecutive runs ending with the most recent run.
 *
 * `runs` is the list of runs ordered **oldest to newest**. The detector
 * walks the tail of each query's history and reports the streak only when
 * it reaches the threshold.
 */
export function detectPersistentGaps(
  runs: RunData[],
  threshold: number = PERSISTENT_GAP_THRESHOLD,
): PersistentGap[] {
  if (runs.length < threshold) return []

  // Collect the set of all queries observed in any run, then walk the
  // tail to compute each query's uncited streak.
  const queries = new Set<string>()
  for (const run of runs) {
    for (const snap of run.snapshots) {
      if (snap.query) queries.add(snap.query)
    }
  }

  const result: PersistentGap[] = []
  for (const query of queries) {
    let streak = 0
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i]!
      const snaps = run.snapshots.filter(s => s.query === query)
      if (snaps.length === 0) break
      const anyCited = snaps.some(s => s.cited)
      if (anyCited) break
      streak++
    }
    if (streak >= threshold) {
      result.push({ query, streak, threshold })
    }
  }
  return result
}
