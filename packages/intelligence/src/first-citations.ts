import type { RunData, FirstCitation } from './types.js'
import { observedKeys } from './observation-coverage.js'

/**
 * A first-citation is a (query, provider) pair where the query had **no
 * cited provider** in the previous run, and now has at least one cited
 * provider in the current run. We emit one row per cited provider on the
 * query so the dashboard/CLI can show every provider that picked it up.
 */
export function detectFirstCitations(currentRun: RunData, previousRun: RunData): FirstCitation[] {
  // "Had not been cited by any provider" is only knowable for a query the
  // baseline actually measured. A newly-added query, or one every provider
  // errored on, has no rows — that is not evidence of a first citation.
  // See `observation-coverage.ts`.
  const previousObservedQueries = observedKeys(previousRun, snap => snap.query)
  const previousCitedQueries = new Set<string>()
  for (const snap of previousRun.snapshots) {
    if (snap.cited === true) previousCitedQueries.add(snap.query)
  }

  const result: FirstCitation[] = []
  const seen = new Set<string>()
  for (const snap of currentRun.snapshots) {
    if (snap.cited !== true) continue
    if (!previousObservedQueries.has(snap.query)) continue
    if (previousCitedQueries.has(snap.query)) continue
    const key = `${snap.query}:${snap.provider}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      query: snap.query,
      provider: snap.provider,
      citationUrl: snap.citationUrl,
      position: snap.position,
      runId: currentRun.runId,
    })
  }
  return result
}
