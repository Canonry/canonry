import { CitationStates, percentOf, RetrievalStatuses, type RetrievalStatus, type RunHistoryPointDto } from '@canonry/canonry-contracts'

export interface RunHistoryRun {
  id: string
  createdAt: string
  status: string
}

export interface RunHistorySnapshot {
  queryId: string
  citationState: string
  /** True when the project's brand or domain appeared in the AI answer text.
   *  Optional so legacy callers that only track citations still compile; a
   *  missing value counts as not-mentioned. */
  answerMentioned?: boolean | null
  /** Absent / null for rows written before retrieval was recorded: they stay in the cited denominator. */
  retrievalStatus?: RetrievalStatus | null
}

export const DEFAULT_RUN_HISTORY_LIMIT = 12

/**
 * Per-run sparkline data for the overview. Returns up to `limit` most-recent
 * runs in chronological order (oldest first), so consumers can render a
 * left-to-right trend chart without sorting.
 *
 * Each point carries both signals, computed independently at the *query*
 * level: a query is "cited" for a run if any searched snapshot in that run
 * has citationState='cited', and "mentioned" if any snapshot has
 * answerMentioned===true. The two are never derived from each other. Rates
 * are 0..100 at wire precision (2 of 3 is 66.666667). Runs without any snapshots
 * produce a zero-rate point.
 *
 * The two rates have different denominators when the run holds answers
 * written with no web search: `citationRate` reads the searched population
 * (`citedTotalCount`, present only when it differs from `totalCount`),
 * while `mentionRate` reads every query in `totalCount`, since brand recall
 * does not need search. A query whose snapshots were all written with no
 * retrieval step leaves the citation population and is counted in
 * `excludedNoRetrieval`; rows that predate retrieval recording stay in.
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
    const queryMentioned = new Map<string, boolean>()
    const queryChecked = new Set<string>()
    for (const snap of snapshots) {
      if (!queryMentioned.has(snap.queryId)) queryMentioned.set(snap.queryId, false)
      if (snap.answerMentioned === true) queryMentioned.set(snap.queryId, true)
      // A no-search answer never had a chance to cite; it must not mark its
      // query either way. Only searched snapshots decide the citation side.
      if (snap.retrievalStatus === RetrievalStatuses['not-used']) continue
      queryChecked.add(snap.queryId)
      if (!queryCited.has(snap.queryId)) queryCited.set(snap.queryId, false)
      if (snap.citationState === CitationStates.cited) queryCited.set(snap.queryId, true)
    }
    const totalCount = queryMentioned.size
    const citedTotalCount = queryCited.size
    const excludedNoRetrieval = totalCount - citedTotalCount
    const citedCount = [...queryCited.values()].filter(Boolean).length
    const citationRate = percentOf(citedCount, citedTotalCount) ?? 0
    const mentionedCount = [...queryMentioned.values()].filter(Boolean).length
    const mentionRate = percentOf(mentionedCount, totalCount) ?? 0
    return {
      runId: run.id,
      createdAt: run.createdAt,
      citedCount,
      totalCount,
      citationRate,
      mentionedCount,
      mentionRate,
      status: run.status,
      // Present only when nonzero, so a smaller cited denominator is always
      // visible next to the rate it shrank.
      ...(excludedNoRetrieval > 0 ? { citedTotalCount, excludedNoRetrieval } : {}),
    }
  })
}
