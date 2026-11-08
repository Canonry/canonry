import { RetrievalStatuses, type RetrievalStatus } from './retrieval.js'
import { CitationStates, type CitationState } from './run.js'

/** The stored fields that decide how an answer's citation reads. */
export interface StoredCitationObservation {
  citationState: CitationState
  /** Null on rows written before retrieval was recorded. */
  retrievalStatus?: RetrievalStatus | null
}

/**
 * The citation state a stored answer reads as. Every citation figure reads
 * stored rows through this, never `citationState` directly.
 *
 * Sweeps store `not-measured` for an answer whose engine returns no sources.
 * Rows written before that stored `not-cited` for the same answers. A stored
 * `not-cited` whose retrieval status says the engine has no retrieval step
 * (`not-applicable`, recorded since retrieval was) had no sources to check, so
 * it reads as `not-measured`. The row itself is never rewritten.
 *
 * A stored `cited` always stands: a source link proves the citation. A row
 * written before retrieval was recorded keeps its stored state, because
 * nothing on it says it could not cite.
 */
export function readCitationState(row: StoredCitationObservation): CitationState {
  if (row.citationState === CitationStates['not-cited'] && row.retrievalStatus === RetrievalStatuses['not-applicable']) {
    return CitationStates['not-measured']
  }
  return row.citationState
}

/** Whether a citation state was observed (cited or not cited), so it belongs in a cited denominator. */
export function isCitationStateMeasured(state: CitationState): boolean {
  return state !== CitationStates['not-measured']
}
