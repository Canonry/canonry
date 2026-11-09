import { CitationStates, type CitationState, type ObservedQueryCounts, type RunQueryCountsByClass } from './run.js'
import { isCitationStateMeasured } from './citation-measurement.js'
import { QueryClasses, type QueryClass } from './query-class.js'

export interface IdentifiedQuerySignal {
  queryId: string
  /** As read through `readCitationState`. */
  citationState: CitationState
  answerMentioned: boolean | null | undefined
}

/**
 * Count observed query IDs once, independently crediting any cited or
 * mentioned answer. A query none of whose answers carries sources counts in
 * `citationNotMeasuredQueries`, never as not cited.
 */
export function summarizeObservedQueryCounts(snapshots: readonly IdentifiedQuerySignal[]): ObservedQueryCounts {
  const queries = new Set<string>()
  const cited = new Set<string>()
  const citationMeasured = new Set<string>()
  const mentioned = new Set<string>()
  for (const snapshot of snapshots) {
    queries.add(snapshot.queryId)
    if (snapshot.citationState === CitationStates.cited) cited.add(snapshot.queryId)
    if (isCitationStateMeasured(snapshot.citationState)) citationMeasured.add(snapshot.queryId)
    if (snapshot.answerMentioned === true) mentioned.add(snapshot.queryId)
  }
  return {
    totalQueries: queries.size,
    citedQueries: cited.size,
    mentionedQueries: mentioned.size,
    citationNotMeasuredQueries: queries.size - citationMeasured.size,
  }
}

/**
 * {@link summarizeObservedQueryCounts} for each query class. `classOf` returns
 * a query's class, or null when it has none; that query counts in neither class
 * and in `unclassifiedQueries`. Returns null when queries were observed and none
 * has a class, because those counts can only be pooled.
 */
export function summarizeObservedQueryCountsByClass(
  snapshots: readonly IdentifiedQuerySignal[],
  classOf: (queryId: string) => QueryClass | null,
): RunQueryCountsByClass | null {
  const byClass: Record<QueryClass, IdentifiedQuerySignal[]> = { [QueryClasses.branded]: [], [QueryClasses['non-brand']]: [] }
  const observed = new Set<string>()
  const unclassified = new Set<string>()
  for (const snapshot of snapshots) {
    observed.add(snapshot.queryId)
    const queryClass = classOf(snapshot.queryId)
    if (queryClass === null) unclassified.add(snapshot.queryId)
    else byClass[queryClass].push(snapshot)
  }
  if (observed.size > 0 && unclassified.size === observed.size) return null
  return {
    nonBrand: summarizeObservedQueryCounts(byClass[QueryClasses['non-brand']]),
    branded: summarizeObservedQueryCounts(byClass[QueryClasses.branded]),
    unclassifiedQueries: unclassified.size,
  }
}
