import { brandKeyFromText } from './brand-matching.js'
import { cleanBusinessNameCandidate } from './business-name-candidates.js'
import { isAutoAliasNameShaped } from './competitor-auto-aliases.js'

/**
 * The other names an answer gave, as a "who won" list shows them: each stored
 * name cleaned (a trailing address or other parenthetical and a list marker
 * dropped), kept only when it is shaped like a business name (no heading,
 * sentence or place name), never one of the project's own names, and listed
 * once per brand key under its first spelling. Order is the stored order.
 */
export function alternativeNames(names: readonly string[], ownNameKeys: ReadonlySet<string>): string[] {
  const seen = new Set<string>()
  const listed: string[] = []
  for (const stored of names) {
    const name = cleanBusinessNameCandidate(stored)
    if (!name || !isAutoAliasNameShaped(name)) continue
    const key = brandKeyFromText(name)
    if (!key || ownNameKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    listed.push(name)
  }
  return listed
}
