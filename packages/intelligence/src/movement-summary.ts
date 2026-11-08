import {
  CitationStates,
  RetrievalStatuses,
  type MetricTone,
  type MovementComparisonDto,
  type MovementSummaryDto,
  type RetrievalStatus,
} from '@canonry/canonry-contracts'

export interface MovementSummarySnapshot {
  queryId: string
  citationState: string
  answerMentioned?: boolean | null
  /** Absent / null for rows written before retrieval was recorded: they stay in the cited denominator. */
  retrievalStatus?: RetrievalStatus | null
}

export interface MovementSummaryOptions {
  /** Optional queryId -> query-text lookup used to populate the human-readable lists. */
  queryLookup?: ReadonlyMap<string, string>
}

export interface MovementComparisonOptions extends MovementSummaryOptions {
  previousRunAt?: string | null
}

type SignalPredicate = (snapshot: MovementSummarySnapshot) => boolean

/**
 * Backward-compatible citation movement builder. New callers should prefer
 * `buildCitationMovementSummary`, which makes the signal explicit at the call
 * site. Movement is query-level: any cited snapshot marks that query cited.
 *
 * When both sweeps exist, only query IDs present in both baskets participate.
 * Added or removed queries belong to `buildMovementComparison`; they must not
 * masquerade as citation gains or losses.
 *
 * An answer the provider wrote with no retrieval step at all
 * (`retrievalStatus = 'not-used'`) cites nothing by construction, so a query
 * whose snapshots in a run are all unsearched cannot be judged to have
 * gained or lost citation in that run: it leaves the comparable cohort
 * rather than reporting a false `lost` (a query cited last run and
 * unsearched this run is not a regression), and is counted in
 * `excludedNoRetrieval`. Rows that predate retrieval recording stay in —
 * an unobserved absence is not an observed one.
 */
export function buildMovementSummary(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
  options: MovementSummaryOptions = {},
): MovementSummaryDto {
  const result = buildSignalMovementSummary(
    currentSnapshots,
    previousSnapshots,
    snapshot => snapshot.citationState === CitationStates.cited,
    options,
    snapshot => snapshot.retrievalStatus !== RetrievalStatuses['not-used'],
  )
  const excludedNoRetrieval = countUnjudgeableComparable(currentSnapshots, previousSnapshots)
  return excludedNoRetrieval > 0 ? { ...result, excludedNoRetrieval } : result
}

export function buildCitationMovementSummary(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
  options: MovementSummaryOptions = {},
): MovementSummaryDto {
  return buildMovementSummary(currentSnapshots, previousSnapshots, options)
}

/** Query-level answer-mention movement, computed independently of citations. */
export function buildMentionMovementSummary(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
  options: MovementSummaryOptions = {},
): MovementSummaryDto {
  return buildSignalMovementSummary(
    currentSnapshots,
    previousSnapshots,
    snapshot => snapshot.answerMentioned === true,
    options,
  )
}

/**
 * Reports query-basket drift between the latest two sweeps. The movement
 * builders use `comparableQueryCount` (the set intersection) as their cohort.
 */
export function buildMovementComparison(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
  options: MovementComparisonOptions = {},
): MovementComparisonDto {
  const currentIds = collectQueryIds(currentSnapshots)
  const previousIds = collectQueryIds(previousSnapshots)
  const hasPreviousRun = previousSnapshots.length > 0

  if (!hasPreviousRun) {
    return {
      hasPreviousRun: false,
      comparable: false,
      querySetChanged: false,
      previousRunAt: null,
      currentQueryCount: currentIds.size,
      previousQueryCount: 0,
      comparableQueryCount: 0,
      addedQueryCount: 0,
      removedQueryCount: 0,
      addedQueries: [],
      removedQueries: [],
    }
  }

  const comparableIds = intersection(currentIds, previousIds)
  const addedIds = difference(currentIds, previousIds)
  const removedIds = difference(previousIds, currentIds)
  const querySetChanged = addedIds.size > 0 || removedIds.size > 0

  return {
    hasPreviousRun: true,
    comparable: !querySetChanged && currentIds.size > 0,
    querySetChanged,
    previousRunAt: options.previousRunAt ?? null,
    currentQueryCount: currentIds.size,
    previousQueryCount: previousIds.size,
    comparableQueryCount: comparableIds.size,
    addedQueryCount: addedIds.size,
    removedQueryCount: removedIds.size,
    addedQueries: resolveQueryTexts(addedIds, options.queryLookup),
    removedQueries: resolveQueryTexts(removedIds, options.queryLookup),
  }
}

function buildSignalMovementSummary(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
  isActive: SignalPredicate,
  options: MovementSummaryOptions,
  isObservable: SignalPredicate = () => true,
): MovementSummaryDto {
  if (previousSnapshots.length === 0) {
    const activeIds = collectActiveQueryIds(currentSnapshots, isActive, isObservable)
    return withQueryLists(
      {
        gained: activeIds.size,
        lost: 0,
        tone: activeIds.size > 0 ? 'positive' : 'neutral',
        hasPreviousRun: false,
      },
      activeIds,
      new Set(),
      options.queryLookup,
    )
  }

  const comparableIds = intersection(
    collectQueryIds(currentSnapshots, isObservable),
    collectQueryIds(previousSnapshots, isObservable),
  )
  const currentActive = intersection(collectActiveQueryIds(currentSnapshots, isActive, isObservable), comparableIds)
  const previousActive = intersection(collectActiveQueryIds(previousSnapshots, isActive, isObservable), comparableIds)
  const gainedIds = difference(currentActive, previousActive)
  const lostIds = difference(previousActive, currentActive)

  return withQueryLists(
    {
      gained: gainedIds.size,
      lost: lostIds.size,
      tone: movementTone(gainedIds.size, lostIds.size),
      hasPreviousRun: true,
    },
    gainedIds,
    lostIds,
    options.queryLookup,
  )
}

/**
 * Comparable queries the citation signal cannot judge: they sit in both
 * baskets, but at least one run holds no searched snapshot for them (every
 * snapshot `retrievalStatus = 'not-used'`). On a first run, the queries in
 * the current run with no searched snapshot. Mention movement never calls
 * this — brand recall does not need search.
 */
function countUnjudgeableComparable(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
): number {
  const isObservable = (snapshot: MovementSummarySnapshot): boolean =>
    snapshot.retrievalStatus !== RetrievalStatuses['not-used']
  if (previousSnapshots.length === 0) {
    const all = collectQueryIds(currentSnapshots)
    const checked = collectQueryIds(currentSnapshots, isObservable)
    return all.size - checked.size
  }
  const comparableRaw = intersection(
    collectQueryIds(currentSnapshots),
    collectQueryIds(previousSnapshots),
  )
  const comparableChecked = intersection(
    collectQueryIds(currentSnapshots, isObservable),
    collectQueryIds(previousSnapshots, isObservable),
  )
  return comparableRaw.size - comparableChecked.size
}

function movementTone(gained: number, lost: number): MetricTone {
  if (lost > gained) return 'negative'
  if (gained > lost) return 'positive'
  return 'neutral'
}

function withQueryLists(
  base: MovementSummaryDto,
  gainedIds: ReadonlySet<string>,
  lostIds: ReadonlySet<string>,
  lookup: ReadonlyMap<string, string> | undefined,
): MovementSummaryDto {
  if (!lookup) return base
  return {
    ...base,
    gainedQueries: resolveQueryTexts(gainedIds, lookup),
    lostQueries: resolveQueryTexts(lostIds, lookup),
  }
}

function resolveQueryTexts(
  ids: ReadonlySet<string>,
  lookup: ReadonlyMap<string, string> | undefined,
): string[] {
  if (!lookup) return []
  const out: string[] = []
  for (const id of ids) {
    const text = lookup.get(id)
    if (text) out.push(text)
  }
  return out.sort()
}

function collectQueryIds(
  snapshots: readonly MovementSummarySnapshot[],
  isObservable: SignalPredicate = () => true,
): Set<string> {
  const ids = new Set<string>()
  for (const snapshot of snapshots) {
    if (snapshot.queryId && isObservable(snapshot)) ids.add(snapshot.queryId)
  }
  return ids
}

function collectActiveQueryIds(
  snapshots: readonly MovementSummarySnapshot[],
  isActive: SignalPredicate,
  isObservable: SignalPredicate = () => true,
): Set<string> {
  const active = new Set<string>()
  for (const snapshot of snapshots) {
    if (snapshot.queryId && isObservable(snapshot) && isActive(snapshot)) active.add(snapshot.queryId)
  }
  return active
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const value of left) {
    if (right.has(value)) out.add(value)
  }
  return out
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const value of left) {
    if (!right.has(value)) out.add(value)
  }
  return out
}
