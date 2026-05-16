import { CitationStates, type MetricTone, type MovementSummaryDto } from '@ainyc/canonry-contracts'

export interface MovementSummarySnapshot {
  queryId: string
  citationState: string
}

export interface MovementSummaryOptions {
  /** Optional queryId → query-text lookup. When provided, the returned DTO
   *  includes `gainedQueries[]` / `lostQueries[]` arrays with the actual
   *  query strings so the dashboard can render WHICH queries moved.
   *  Without it, the lists are omitted (preserves backward-compatible
   *  consumers). */
  queryLookup?: ReadonlyMap<string, string>
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
 *
 * Pass `options.queryLookup` to enrich the result with the actual query
 * strings (`gainedQueries`, `lostQueries`). Missing IDs in the lookup are
 * silently dropped — the count fields still reflect the unfiltered total.
 */
export function buildMovementSummary(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
  options: MovementSummaryOptions = {},
): MovementSummaryDto {
  if (previousSnapshots.length === 0) {
    const citedIds = collectCitedQueryIds(currentSnapshots)
    const citedCount = citedIds.size
    const tone: MetricTone = citedCount > 0 ? 'positive' : 'neutral'
    return withQueryLists(
      { gained: citedCount, lost: 0, tone, hasPreviousRun: false },
      citedIds,
      new Set(),
      options.queryLookup,
    )
  }

  const latestCited = collectCitedQueryIds(currentSnapshots)
  const previousCited = collectCitedQueryIds(previousSnapshots)

  const gainedIds = new Set<string>()
  const lostIds = new Set<string>()
  for (const id of latestCited) {
    if (!previousCited.has(id)) gainedIds.add(id)
  }
  for (const id of previousCited) {
    if (!latestCited.has(id)) lostIds.add(id)
  }

  const tone: MetricTone = lostIds.size > gainedIds.size
    ? 'negative'
    : gainedIds.size > lostIds.size
      ? 'positive'
      : 'neutral'
  return withQueryLists(
    { gained: gainedIds.size, lost: lostIds.size, tone, hasPreviousRun: true },
    gainedIds,
    lostIds,
    options.queryLookup,
  )
}

function withQueryLists(
  base: MovementSummaryDto,
  gainedIds: Set<string>,
  lostIds: Set<string>,
  lookup: ReadonlyMap<string, string> | undefined,
): MovementSummaryDto {
  if (!lookup) return base
  return {
    ...base,
    gainedQueries: resolveQueryTexts(gainedIds, lookup),
    lostQueries: resolveQueryTexts(lostIds, lookup),
  }
}

function resolveQueryTexts(ids: Set<string>, lookup: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  for (const id of ids) {
    const text = lookup.get(id)
    if (text) out.push(text)
  }
  return out.sort()
}

function collectCitedQueryIds(snapshots: readonly MovementSummarySnapshot[]): Set<string> {
  const cited = new Set<string>()
  for (const s of snapshots) {
    if (s.citationState === CitationStates.cited && s.queryId) cited.add(s.queryId)
  }
  return cited
}
