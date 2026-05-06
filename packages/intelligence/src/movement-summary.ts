import { CitationStates, type MetricTone, type MovementSummaryDto } from '@ainyc/canonry-contracts'

export interface MovementSummarySnapshot {
  queryId: string
  citationState: string
}

/**
 * Compares two runs at the query level. A query is "cited" if ANY snapshot for
 * that query (across providers) has citationState='cited'. Gained = queries
 * cited now but not before; lost = queries cited before but not now.
 *
 * When `previousSnapshots` is empty, returns `gained = citedCount` of the
 * current run (treating the first run as "everything is new"), `lost = 0`,
 * and `hasPreviousRun = false` so the dashboard / CLI can render an
 * appropriate "first run" hint.
 */
export function buildMovementSummary(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
): MovementSummaryDto {
  if (previousSnapshots.length === 0) {
    const citedCount = collectCitedQueryIds(currentSnapshots).size
    const tone: MetricTone = citedCount > 0 ? 'positive' : 'neutral'
    return { gained: citedCount, lost: 0, tone, hasPreviousRun: false }
  }

  const latestCited = collectCitedQueryIds(currentSnapshots)
  const previousCited = collectCitedQueryIds(previousSnapshots)

  let gained = 0
  let lost = 0
  for (const id of latestCited) {
    if (!previousCited.has(id)) gained++
  }
  for (const id of previousCited) {
    if (!latestCited.has(id)) lost++
  }

  const tone: MetricTone = lost > gained ? 'negative' : gained > lost ? 'positive' : 'neutral'
  return { gained, lost, tone, hasPreviousRun: true }
}

function collectCitedQueryIds(snapshots: readonly MovementSummarySnapshot[]): Set<string> {
  const cited = new Set<string>()
  for (const s of snapshots) {
    if (s.citationState === CitationStates.cited && s.queryId) cited.add(s.queryId)
  }
  return cited
}
