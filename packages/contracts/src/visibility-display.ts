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
