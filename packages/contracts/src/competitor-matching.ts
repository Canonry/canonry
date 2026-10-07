import { stripCitationChips } from './answer-prose.js'
import { brandKeyFromText, textContainsAnyBrandAlias, textContainsBrandAlias } from './brand-matching.js'
import type { NormalizedQueryResult } from './provider.js'
import { isListingMarketplace } from './source-categories.js'
import { brandLabelFromDomain, hostMatchesDomain, registrableDomain, textContainsDomain } from './url-normalize.js'

/**
 * Per-snapshot competitor matching: the stored `competitorOverlap` and
 * `recommendedCompetitors` columns. A sweep computes them when it records an
 * answer, and every rescore (an alias edit, a backfill, a run that finishes
 * after a mid-sweep alias edit) recomputes them with these same functions.
 */

export function computeCompetitorOverlap(
  normalized: NormalizedQueryResult,
  competitorDomains: string[],
  /** Domain -> names an operator gave that competitor (a plan's label and aliases). */
  competitorAliases: ReadonlyMap<string, readonly string[]> = new Map(),
): string[] {
  const overlapSet = new Set<string>()

  for (const d of normalized.citedDomains) {
    for (const cd of competitorDomains) {
      if (hostMatchesDomain(d, cd)) {
        overlapSet.add(cd)
      }
    }
  }

  for (const source of normalized.groundingSources) {
    for (const cd of competitorDomains) {
      if (hostMatchesDomain(source.uri, cd)) {
        overlapSet.add(cd)
      }
    }
  }

  if (normalized.answerText) {
    for (const cd of competitorDomains) {
      if (textContainsDomain(normalized.answerText, cd)) {
        overlapSet.add(cd)
      }
      // Use the registrable domain's brand label (eTLD+1's leftmost label) so
      // a stored competitor like `offers.quotebird.test` is matched against the
      // brand `quotebird`, not the subdomain `offers` — otherwise the literal
      // word "offers" in the answer prose would falsely flag the competitor.
      const brand = brandLabelFromDomain(cd)
      if (brandKeyFromText(brand).length >= 4 && textContainsBrandAlias(normalized.answerText, brand)) {
        overlapSet.add(cd)
      }
      // A competitor's own names ("QRA" for qravelhomes.example) are operator-approved, so
      // they match even when the domain's label would not.
      const named = competitorAliases.get(cd)
      if (named?.length && textContainsAnyBrandAlias(normalized.answerText, named)) {
        overlapSet.add(cd)
      }
    }
  }

  return [...overlapSet]
}

/**
 * Extract brand names from the answer, but only when they line up with
 * domains we already know were cited or matched as competitors.
 *
 * `ownBrandNames` (the project's displayName + aliases) seeds the "own" set
 * so a recommended-name match against, say, "LlamaParse" does not flag the
 * project's own product as a competitor.
 */
export function extractRecommendedCompetitors(
  answerText: string | null | undefined,
  ownDomains: string[],
  citedDomains: string[],
  competitorDomains: string[],
  ownBrandNames: readonly string[] = [],
  /** Domain -> names an operator gave that competitor (a plan's label and aliases). */
  competitorAliases: ReadonlyMap<string, readonly string[]> = new Map(),
): string[] {
  if (!answerText || answerText.length < 20) return []

  const ownBrandAliases = new Set<string>(
    ownDomains.flatMap(domain => collectBrandAliasesFromDomain(domain)),
  )
  for (const name of ownBrandNames) {
    if (brandKeyFromText(name).length >= 4) ownBrandAliases.add(name)
  }
  const ownKeys = new Set([...ownBrandAliases].map(brandKeyFromText))
  // A cited listing marketplace is where an answer sends people to search, not
  // a rival: an answer that lists "Apartments.com" as a bullet is not
  // recommending a competitor. Tracked competitors are always eligible, as are
  // the names a measurement plan gave them.
  const knownCompetitorAliases = new Set(
    [...citedDomains.filter(domain => !isListingMarketplace(domain)), ...competitorDomains]
      .flatMap(domain => collectBrandAliasesFromDomain(domain))
      .concat([...competitorAliases.values()].flat())
      .filter(alias => !ownKeys.has(brandKeyFromText(alias))),
  )

  if (knownCompetitorAliases.size === 0) return []

  const candidatePatterns = [
    /^\s*(?:[-*]|\d+\.)\s+(?:\*\*)?([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)(?:\*\*)?\s*[:\u2014\u2013-]/gm,
    /\*\*([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50})\*\*/g,
    /^#{1,4}\s+(?:\d+\.\s+)?(?:\*\*)?([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)(?:\*\*)?$/gm,
    /\[([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50})\]\(https?:\/\/[^\s)]+\)/g,
  ]
  const genericKeys = new Set([
    'additional',
    'best',
    'benefits',
    'bottomline',
    'comparison',
    'conclusion',
    'directorylisting',
    'example',
    'expertise',
    'features',
    'finalthoughts',
    'howitworks',
    'important',
    'keybenefits',
    'keyfeatures',
    'major',
    'note',
    'notable',
    'option',
    'other',
    'overview',
    'pricing',
    'pros',
    'reviews',
    'step',
    'summary',
    'top',
    'verdict',
    'whattolookfor',
    'whyitmatters',
    'whyitstandsout',
    'whywechoseit',
  ])

  // A name that appears only in a citation chip (`([Rival](https://...))`) is
  // a citation, not a recommendation. Links written in prose stay as markdown
  // for the `[Name](url)` pattern.
  const scanText = stripCitationChips(answerText)
  const seen = new Map<string, string>()
  for (const pattern of candidatePatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(scanText)) !== null) {
      const candidate = cleanCandidateName(match[1])
      const candidateKey = brandKeyFromText(candidate)
      if (!candidateKey) continue
      if (genericKeys.has(candidateKey)) continue
      if (candidate.split(/\s+/).length > 6) continue
      if (matchesBrandAlias(candidate, ownBrandAliases)) continue
      if (!matchesBrandAlias(candidate, knownCompetitorAliases)) continue
      if (!seen.has(candidateKey)) seen.set(candidateKey, candidate)
    }
  }

  return [...seen.values()].slice(0, 10)
}

function cleanCandidateName(candidate: string): string {
  return candidate
    .replace(/^[\s"'`]+|[\s"'`.,:;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectBrandAliasesFromDomain(domain: string): string[] {
  // Source aliases from the registrable domain only — never from
  // subdomain labels — so a competitor `offers.quotebird.test` does not contribute
  // `offers` as a brand alias (which would let the answer-text word "offers"
  // false-match in extractRecommendedCompetitors).
  const reg = registrableDomain(domain)
  if (!reg) return []
  const aliases = new Set<string>()
  if (brandKeyFromText(reg).length >= 4) aliases.add(reg)
  const brand = brandLabelFromDomain(reg)
  if (brandKeyFromText(brand).length >= 4) aliases.add(brand)
  return [...aliases]
}

function matchesBrandAlias(candidate: string, aliases: ReadonlySet<string>): boolean {
  return [...aliases].some(alias => textContainsBrandAlias(candidate, alias))
}
