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

export interface AnswerMentionResult {
  mentioned: boolean
  matchedTerms: string[]
}

export function extractAnswerMentions(
  answerText: string | null | undefined,
  brandNames: string[],
  domains: string[],
  answerDomains?: readonly string[],
): AnswerMentionResult {
  if (!answerText) return { mentioned: false, matchedTerms: [] }

  const matchedTerms: string[] = []
  const matchedDomainTerms = new Set<string>()
  const extractedAnswerDomains = answerDomains ?? extractDomainsFromText(answerText)

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
      answerText,
    )
    // Push in the original order: names before domain labels, which the
    // dedup below depends on.
    for (const candidate of candidates) {
      if (hits.has(candidate.key)) matchedTerms.push(candidate.term)
    }
  }

  // Deduplicate and remove tokens already subsumed by a domain match
  // e.g. if 'ainyc.ai' is in matchedTerms, don't also show 'ainyc'
  const unique = [...new Set(matchedTerms)]
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
