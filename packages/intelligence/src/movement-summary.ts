import {
  CitationStates,
  type MetricTone,
  type MovementComparisonDto,
  type MovementSummaryDto,
} from '@ainyc/canonry-contracts'

export interface MovementSummarySnapshot {
  queryId: string
  citationState: string
  answerMentioned?: boolean | null
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
 */
export function buildMovementSummary(
  currentSnapshots: readonly MovementSummarySnapshot[],
  previousSnapshots: readonly MovementSummarySnapshot[],
  options: MovementSummaryOptions = {},
): MovementSummaryDto {
  return buildSignalMovementSummary(
    currentSnapshots,
    previousSnapshots,
    snapshot => snapshot.citationState === CitationStates.cited,
    options,
  )
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
): MovementSummaryDto {
  if (previousSnapshots.length === 0) {
    const activeIds = collectActiveQueryIds(currentSnapshots, isActive)
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
    collectQueryIds(currentSnapshots),
    collectQueryIds(previousSnapshots),
  )
  const currentActive = intersection(collectActiveQueryIds(currentSnapshots, isActive), comparableIds)
  const previousActive = intersection(collectActiveQueryIds(previousSnapshots, isActive), comparableIds)
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

function collectQueryIds(snapshots: readonly MovementSummarySnapshot[]): Set<string> {
  const ids = new Set<string>()
  for (const snapshot of snapshots) {
    if (snapshot.queryId) ids.add(snapshot.queryId)
  }
  return ids
}

function collectActiveQueryIds(
  snapshots: readonly MovementSummarySnapshot[],
  isActive: SignalPredicate,
): Set<string> {
  const active = new Set<string>()
  for (const snapshot of snapshots) {
    if (snapshot.queryId && isActive(snapshot)) active.add(snapshot.queryId)
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
