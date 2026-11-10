/** Shared AI visibility evidence labels for the browser and CLI. */
export const VISIBILITY_DISPLAY_COPY = { ambiguous: 'Property identity unverified' } as const

/** Why a mention rate is unavailable when no answer could be attributed. */
export const UNATTRIBUTED_MENTION_REASON = 'No answer could be tied to one property'

/** Name excluded answers beside the denominator that admits attributable evidence only. */
export function unattributedAnswersLabel(value: { denominator?: number | null; unattributed?: number }): string | null {
  if (value.denominator === null || value.denominator === undefined) return null
  if (value.unattributed === undefined || value.unattributed <= 0) return null
  return `${value.unattributed} of ${value.denominator + value.unattributed} answers could not be tied to one property`
}

/**
 * Name the saved answers a citation rate could not check beside its
 * denominator: their source-link capture was incomplete, so they are in
 * neither side of the rate. The total is every saved answer the rate read.
 */
export function uncheckedSourcesLabel(value: { denominator?: number | null; unchecked?: number }): string | null {
  if (value.denominator === null || value.denominator === undefined) return null
  if (value.unchecked === undefined || value.unchecked <= 0) return null
  const total = value.denominator + value.unchecked
  return `${value.unchecked} of ${total} ${total === 1 ? 'answer' : 'answers'} had sources that could not be checked`
}

/**
 * Name the saved answers a citation rate left out because the provider
 * wrote them with no web search beside its denominator: they cite nothing
 * by construction, so they are in neither side of the rate. They stay in
 * the mention denominator, since brand recall does not need search.
 */
export function excludedNoRetrievalLabel(value: { excludedNoRetrieval?: number }): string | null {
  if (value.excludedNoRetrieval === undefined || value.excludedNoRetrieval <= 0) return null
  return `Excluded from the cited rate: ${value.excludedNoRetrieval} answer(s) written without a web search`
}
