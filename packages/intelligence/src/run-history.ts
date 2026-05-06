import { CitationStates, type RunHistoryPointDto } from '@ainyc/canonry-contracts'

export interface RunHistoryRun {
  id: string
  createdAt: string
  status: string
}

export interface RunHistorySnapshot {
  queryId: string
  citationState: string
}

export const DEFAULT_RUN_HISTORY_LIMIT = 12

/**
 * Per-run citation rate sparkline data for the overview. Returns up to `limit`
 * most-recent runs in chronological order (oldest first), so consumers can
 * render a left-to-right trend chart without sorting.
 *
 * Each point is computed at the *query* level: a query is "cited" for a run
 * if any snapshot in that run has citationState='cited'. Runs without any
 * snapshots produce a zero-rate point.
 */
export function buildRunHistory(
  runs: readonly RunHistoryRun[],
  snapshotsByRunId: ReadonlyMap<string, readonly RunHistorySnapshot[]>,
  limit: number = DEFAULT_RUN_HISTORY_LIMIT,
): RunHistoryPointDto[] {
  // Take the most recent `limit` runs by createdAt, then re-sort ascending
  // so the sparkline reads left-to-right.
  const recent = [...runs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return recent.map(run => {
    const snapshots = snapshotsByRunId.get(run.id) ?? []
    const queryCited = new Map<string, boolean>()
    for (const snap of snapshots) {
      if (!queryCited.has(snap.queryId)) queryCited.set(snap.queryId, false)
      if (snap.citationState === CitationStates.cited) queryCited.set(snap.queryId, true)
    }
    const totalCount = queryCited.size
    const citedCount = [...queryCited.values()].filter(Boolean).length
    const citationRate = totalCount > 0 ? Math.round((citedCount / totalCount) * 100) : 0
    return {
      runId: run.id,
      createdAt: run.createdAt,
      citedCount,
      totalCount,
      citationRate,
      status: run.status,
    }
  })
}
