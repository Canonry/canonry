import { answerProseForMentions } from './answer-prose.js'
import { brandKeyFromText, compileBrandAliases, matchedAliasKeys } from './brand-matching.js'
import type { MentionState, VisibilityState } from './run.js'
import {
  brandLabelFromDomain,
  extractDomainsFromText,
  hostMatchesDomain,
  hostOf,
} from './url-normalize.js'

/** Domain-derived labels need enough specificity to be safe as mention identities. */
export const MIN_DOMAIN_BRAND_KEY_LENGTH = 4

/**
 * The shortest brand alias that may be matched in answer prose.
 *
 * Three, because real brands are three letters (`COS`, `IBM`) and the matcher
 * this feeds requires COMPLETE adjacent words: `cos` never matches inside
 * `cosmetics`, so length is not what protects against a false hit. The one
 * threshold lives here rather than at each call site: the same brand counted by
 * one surface and dropped by another is a silent disagreement about the same
 * answer, which is exactly the class of bug that made a stored citation-side
 * column and this metric report different mention counts for the same run.
 *
 * Operator-curated aliases (project aliases, competitor aliases) take this
 * floor; a label DERIVED from a domain takes the stricter
 * `MIN_DOMAIN_BRAND_KEY_LENGTH`, so a 3-letter brand counts only once someone
 * approved it.
 */
export const MIN_BRAND_ALIAS_KEY_LENGTH = 3

/** Aliases worth compiling: short/empty tokens would match noise, not identity. */
export function usableBrandAliases(aliases: readonly string[]): string[] {
  return aliases.filter(alias => brandKeyFromText(alias).length >= MIN_BRAND_ALIAS_KEY_LENGTH)
}

export interface AnswerMentionResult {
  mentioned: boolean
  matchedTerms: string[]
}

/**
 * Which approved identities the answer's PROSE names.
 *
 * Both halves (owned domains written out, and brand names or domain labels)
 * read `answerProseForMentions(answerText)`, never the raw text: a citation
 * chip or source link in the answer is a citation, not a mention.
 *
 * `answerDomains`, when given, must be the hosts of that same prose,
 * `extractDomainsFromText(answerProseForMentions(answerText))`. It exists so
 * a request that reads one answer for several signals parses it once.
 */
export function extractAnswerMentions(
  answerText: string | null | undefined,
  brandNames: string[],
  domains: string[],
  answerDomains?: readonly string[],
): AnswerMentionResult {
  if (!answerText) return { mentioned: false, matchedTerms: [] }
  const prose = answerProseForMentions(answerText)

  const matchedTerms: string[] = []
  const matchedDomainTerms = new Set<string>()
  const extractedAnswerDomains = answerDomains ?? extractDomainsFromText(prose)

  for (const domain of domains) {
    const normalizedDomain = hostOf(domain)
    if (!normalizedDomain || !normalizedDomain.includes('.')) continue
    if (extractedAnswerDomains.some(candidate => hostMatchesDomain(candidate, normalizedDomain))) {
      matchedTerms.push(normalizedDomain)
      matchedDomainTerms.add(normalizedDomain)
    }
  }

  // ONE segmentation for every approved identity, names and domain labels
  // together. Asking per term re-walked the whole answer each time, and this
  // runs over every stored answer of every property.
  const candidates: { term: string; key: string }[] = []
  for (const brandName of brandNames) {
    if (!brandName || !brandName.trim()) continue
    const key = brandKeyFromText(brandName)
    if (key) candidates.push({ term: brandName, key })
  }
  // A domain is operator-approved project identity too. Its registrable brand
  // label is useful when no display name exists, but only as an exact
  // presentation-normalized match.
  for (const domain of domains) {
    const brand = brandLabelFromDomain(domain)
    const key = brandKeyFromText(brand)
    if (key.length >= MIN_DOMAIN_BRAND_KEY_LENGTH) candidates.push({ term: brand, key })
  }
  if (candidates.length > 0) {
    const hits = matchedAliasKeys(
      compileBrandAliases(candidates.map(c => c.term)),
      prose,
    )
    // Push in the original order: names before domain labels, which the
    // dedup below depends on.
    for (const candidate of candidates) {
      if (hits.has(candidate.key)) matchedTerms.push(candidate.term)
    }
  }

  // Deduplicate terms that differ only in case, keeping the first spelling (a
  // display name 'Acme' before its own domain label 'acme'), then remove
  // tokens already subsumed by a domain match
  // e.g. if 'ainyc.ai' is in matchedTerms, don't also show 'ainyc'
  const seenTerms = new Set<string>()
  const unique = matchedTerms.filter(term => {
    const folded = term.toLowerCase()
    if (seenTerms.has(folded)) return false
    seenTerms.add(folded)
    return true
  })
  const domainBrandKeys = new Set(
    [...matchedDomainTerms]
      .map(domain => brandKeyFromText(brandLabelFromDomain(domain)))
      .filter(Boolean),
  )
  const dedupedFinal = unique.filter(term => {
    if (matchedDomainTerms.has(term)) return true
    // Drop a matching brand label when the full written domain is already
    // stronger evidence.
    return !domainBrandKeys.has(brandKeyFromText(term))
  })
  return { mentioned: dedupedFinal.length > 0, matchedTerms: dedupedFinal }
}

export function determineAnswerMentioned(
  answerText: string | null | undefined,
  brandNames: string[],
  domains: string[],
  answerDomains?: readonly string[],
): boolean {
  return extractAnswerMentions(answerText, brandNames, domains, answerDomains).mentioned
}

export function visibilityStateFromAnswerMentioned(answerMentioned: boolean | null | undefined): VisibilityState {
  return answerMentioned ? 'visible' : 'not-visible'
}

/**
 * Canonical-vocabulary equivalent of `visibilityStateFromAnswerMentioned`.
 * Returns `'mentioned'` / `'not-mentioned'` — the language new APIs, CLI
 * flags, and UI labels must use per the AGENTS.md vocabulary rules.
 */
export function mentionStateFromAnswerMentioned(answerMentioned: boolean | null | undefined): MentionState {
  return answerMentioned ? 'mentioned' : 'not-mentioned'
}
