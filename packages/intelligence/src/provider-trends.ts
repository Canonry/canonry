import { CitationStates, isCitationStateMeasured, percentOf, type CitationState } from '@canonry/canonry-contracts'

export interface ProviderTrendRun {
  id: string
  createdAt: string
}

export interface ProviderTrendSnapshot {
  provider: string
  model: string | null
  queryId: string
  /** As read through `readCitationState`. */
  citationState: CitationState
}

export interface ProviderTrendPoint {
  /**
   * Per-run citation rate as 0-100 at wire precision, for this (provider,
   * model), over the queries whose answers carry sources. Null when the run's
   * answers from it carry none (citation not measured).
   */
  rate: number | null
  /** ISO timestamp of the run for tooltips / ordering. */
  createdAt: string
}

/**
 * Per-(provider, model) sparkline series — the citation rate for that
 * provider on each of the most recent `limit` runs in chronological order
 * (oldest first, so a sparkline reads left-to-right).
 *
 * Pairs with `buildProviderScores` (current-run snapshot) to give the
 * dashboard a per-model row with both a headline score AND a trend chip.
 * A run with no snapshots for a (provider, model) contributes a 0-rate
 * point so the sparkline length matches across rows. A run whose answers from
 * it all lack sources contributes a null point: not measured, never a 0.
 *
 * The key shape `${provider}::${model ?? 'unknown'}` matches the key used
 * by `buildProviderScores` so the dashboard can zip them without re-deriving.
 */
export function buildProviderTrends(
  runs: readonly ProviderTrendRun[],
  snapshotsByRunId: ReadonlyMap<string, readonly ProviderTrendSnapshot[]>,
  limit = 12,
): Map<string, ProviderTrendPoint[]> {
  const recent = [...runs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const keys = collectProviderKeys(snapshotsByRunId.values())
  const result = new Map<string, ProviderTrendPoint[]>()
  for (const key of keys) result.set(key, [])

  for (const run of recent) {
    const snaps = snapshotsByRunId.get(run.id) ?? []
    const perKey = new Map<string, Map<string, boolean>>()
    for (const snap of snaps) {
      const key = providerKey(snap.provider, snap.model)
      const queryMap = perKey.get(key) ?? new Map<string, boolean>()
      perKey.set(key, queryMap)
      if (!isCitationStateMeasured(snap.citationState)) continue
      if (!queryMap.has(snap.queryId)) queryMap.set(snap.queryId, false)
      if (snap.citationState === CitationStates.cited) queryMap.set(snap.queryId, true)
    }
    for (const key of keys) {
      const queryMap = perKey.get(key)
      let rate: number | null = 0
      if (queryMap && queryMap.size === 0) {
        // Answered, but no answer carried sources: not measured, never a 0.
        rate = null
      } else if (queryMap) {
        rate = percentOf([...queryMap.values()].filter(Boolean).length, queryMap.size)
      }
      result.get(key)!.push({ rate, createdAt: run.createdAt })
    }
  }

  return result
}

export function providerKey(provider: string, model: string | null | undefined): string {
  return `${provider}::${model ?? 'unknown'}`
}

function collectProviderKeys(
  perRun: Iterable<readonly ProviderTrendSnapshot[]>,
): Set<string> {
  const keys = new Set<string>()
  for (const snaps of perRun) {
    for (const snap of snaps) {
      keys.add(providerKey(snap.provider, snap.model))
    }
  }
  return keys
}
