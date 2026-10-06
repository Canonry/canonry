import { CitationStates, type CitationState, type ObservedQueryCounts } from './run.js'

export interface IdentifiedQuerySignal {
  queryId: string
  citationState: CitationState
  answerMentioned: boolean | null | undefined
}

/** Count observed query IDs once, independently crediting any cited or mentioned answer. */
export function summarizeObservedQueryCounts(snapshots: readonly IdentifiedQuerySignal[]): ObservedQueryCounts {
  const queries = new Set<string>()
  const cited = new Set<string>()
  const mentioned = new Set<string>()
  for (const snapshot of snapshots) {
    queries.add(snapshot.queryId)
    if (snapshot.citationState === CitationStates.cited) cited.add(snapshot.queryId)
    if (snapshot.answerMentioned === true) mentioned.add(snapshot.queryId)
  }
  return { totalQueries: queries.size, citedQueries: cited.size, mentionedQueries: mentioned.size }
}
