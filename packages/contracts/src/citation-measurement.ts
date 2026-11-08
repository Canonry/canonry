import { ProviderNames } from './provider.js'
import { RetrievalStatuses, type RetrievalStatus } from './retrieval.js'
import { CitationStates, type CitationState } from './run.js'

/** The stored fields that decide how an answer's citation reads. */
export interface StoredCitationObservation {
  /** The engine that answered, as stored on the row. */
  provider: string
  citationState: CitationState
  /** Null on rows written before retrieval was recorded. */
  retrievalStatus?: RetrievalStatus | null
}

/**
 * Engines that have returned no source links in any release, so none of
 * their stored rows observed a citation. The Local adapter (a model with no
 * web access) is the only one. Until #871 (2026-07-28) it filled
 * `citedDomains` with domains written in the answer text, so its rows from
 * then could even store `cited`; a domain written in prose is a mention,
 * never a source link. Its rows before migration 112 (2026-07-30) carry no
 * retrieval status at all.
 */
const ENGINES_WITHOUT_SOURCES: ReadonlySet<string> = new Set([ProviderNames.local])

/**
 * The citation state a stored answer reads as. Every citation figure reads
 * stored rows through this, never `citationState` directly. The row itself is
 * never rewritten.
 *
 * - A stored `not-measured` stands: the sweep recorded that the engine
 *   returned no sources.
 * - A row from an engine that has never returned source links (Local) reads
 *   `not-measured` whatever it stored, so one engine's series never mixes
 *   rows written before `not-measured` existed with rows written after it.
 * - A stored `not-cited` whose retrieval status says the engine has no
 *   retrieval step (`not-applicable`) had no sources to check, so it reads
 *   `not-measured` too.
 * - Everything else keeps its stored state. A `cited` from an engine that
 *   returns sources stands: a source link proves the citation.
 *
 * Answer-service rows need no rule: a profile runs in a sweep only when its
 * sources are tied to the answer (`answerServiceDescriptorProblems`), so every
 * stored sweep answer of one was measured, before and after this state existed.
 */
export function readCitationState(row: StoredCitationObservation): CitationState {
  if (row.citationState === CitationStates['not-measured']) return row.citationState
  if (ENGINES_WITHOUT_SOURCES.has(row.provider)) return CitationStates['not-measured']
  if (row.citationState === CitationStates['not-cited'] && row.retrievalStatus === RetrievalStatuses['not-applicable']) {
    return CitationStates['not-measured']
  }
  return row.citationState
}

/** Whether a citation state was observed (cited or not cited), so it belongs in a cited denominator. */
export function isCitationStateMeasured(state: CitationState): boolean {
  return state !== CitationStates['not-measured']
}

/**
 * One query's citation state across several answers (engines, locations):
 * `cited` when any answer cites the project, `not-cited` when at least one
 * answer's sources were checked and none cites it, and `not-measured` only
 * when no answer carries sources. Null for no answers at all.
 */
export function combineCitationStates(states: Iterable<CitationState>): CitationState | null {
  let combined: CitationState | null = null
  for (const state of states) {
    if (state === CitationStates.cited) return CitationStates.cited
    if (state === CitationStates['not-cited'] || combined === null) combined = state
  }
  return combined
}
