import { CitationStates, type CitationState, type ObservedQueryCounts } from './run.js'
import { isCitationStateMeasured } from './citation-measurement.js'

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
