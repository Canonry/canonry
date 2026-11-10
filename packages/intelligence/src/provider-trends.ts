import { CitationStates, percentOf, RetrievalStatuses, type RetrievalStatus } from '@canonry/canonry-contracts'

export interface ProviderTrendRun {
  id: string
  createdAt: string
}

export interface ProviderTrendSnapshot {
  provider: string
  model: string | null
  queryId: string
  citationState: string
  /** Absent / null for rows written before retrieval was recorded: they stay in the cited denominator. */
  retrievalStatus?: RetrievalStatus | null
}

export interface ProviderTrendPoint {
  /** Per-run citation rate as 0-100 at wire precision, for this (provider, model). */
  rate: number
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
 * point so the sparkline length matches across rows.
 *
 * A run whose snapshots for a (provider, model) were all written with no
 * retrieval step (`retrievalStatus = 'not-used'`) likewise contributes a
 * 0-rate point: the run measured no searched citation for that key, the
 * same "no evidence" reading as a run with no snapshots. The headline row
 * from `buildProviderScores` carries the `excludedNoRetrieval` count, so
 * the loss is visible there rather than in the per-point rate.
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
      // An answer written with no retrieval step cites nothing by
      // construction (#1161): it leaves the cited denominator rather than
      // counting as a searched miss. Rows that predate retrieval recording
      // stay in — an unobserved absence is not an observed one.
      if (snap.retrievalStatus === RetrievalStatuses['not-used']) continue
      const key = providerKey(snap.provider, snap.model)
      const queryMap = perKey.get(key) ?? new Map<string, boolean>()
      if (!queryMap.has(snap.queryId)) queryMap.set(snap.queryId, false)
      if (snap.citationState === CitationStates.cited) queryMap.set(snap.queryId, true)
      perKey.set(key, queryMap)
    }
    for (const key of keys) {
      const queryMap = perKey.get(key)
      const cited = queryMap ? [...queryMap.values()].filter(Boolean).length : 0
      const rate = percentOf(cited, queryMap?.size ?? 0) ?? 0
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
