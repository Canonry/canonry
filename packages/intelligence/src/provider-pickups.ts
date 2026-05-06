import type { RunData, ProviderPickup } from './types.js'

/**
 * A provider-pickup is a (query, provider) pair where:
 *   - The query was **already cited by some other provider** in the previous run
 *   - This specific provider was not citing the query in the previous run
 *   - This specific provider is now citing the query in the current run
 *
 * Excludes (query, provider) pairs that fall under "first-citation" (where
 * no provider was citing the query previously).
 */
export function detectProviderPickups(currentRun: RunData, previousRun: RunData): ProviderPickup[] {
  const previousCitedQueries = new Set<string>()
  const previousCitedPairs = new Set<string>()
  for (const snap of previousRun.snapshots) {
    if (!snap.cited) continue
    previousCitedQueries.add(snap.query)
    previousCitedPairs.add(`${snap.query}:${snap.provider}`)
  }

  const result: ProviderPickup[] = []
  const seen = new Set<string>()
  for (const snap of currentRun.snapshots) {
    if (!snap.cited) continue
    if (!previousCitedQueries.has(snap.query)) continue
    const key = `${snap.query}:${snap.provider}`
    if (previousCitedPairs.has(key)) continue
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
