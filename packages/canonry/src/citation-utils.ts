import type { NormalizedQueryResult } from '@ainyc/canonry-contracts'
import {
  brandKeyFromText,
  brandLabelFromDomain,
  hostMatchesDomain,
  isListingMarketplace,
  textContainsAnyBrandAlias,
  registrableDomain,
  textContainsBrandAlias,
  textContainsDomain,
} from '@ainyc/canonry-contracts'

/**
 * Of the domains an engine cited for a (query, provider) snapshot, return the
 * first that belongs to the project (canonical or owned domain), or `undefined`
 * when none do.
 *
 * `citedDomains` is the FULL set of cited sources — project domains, tracked
 * competitors, and third-party references intermingled in provider order. A
 * project citation gain/regression must be labeled with the project's OWN
 * cited URL, not `citedDomains[0]`, which is frequently a co-cited competitor
 * (e.g. a regression on the project's page mislabeled "audit winntile.com").
 * Returns `undefined` when the citation was established via a grounding-source
 * match with no project domain present in `citedDomains` — better an empty
 * target than a competitor's.
 */
export function pickProjectCitedDomain(
  citedDomains: readonly string[],
  projectDomains: string[],
): string | undefined {
  for (const cited of citedDomains) {
    if (projectDomains.some(pd => hostMatchesDomain(cited, pd))) return cited
  }
  return undefined
}

export function determineCitationState(
  normalized: NormalizedQueryResult,
  domains: string[],
): 'cited' | 'not-cited' {
  for (const canonicalDomain of domains) {
    if (normalized.citedDomains.some(d => hostMatchesDomain(d, canonicalDomain))) {
      return 'cited'
    }

    for (const source of normalized.groundingSources) {
      if (hostMatchesDomain(source.uri, canonicalDomain)) return 'cited'
      if (source.title && hostMatchesDomain(source.title, canonicalDomain)) return 'cited'
    }
  }

  return 'not-cited'
}

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
      // a stored competitor like `offers.roofle.com` is matched against the
      // brand `roofle`, not the subdomain `offers` — otherwise the literal
      // word "offers" in the answer prose would falsely flag the competitor.
      const brand = brandLabelFromDomain(cd)
      if (brandKeyFromText(brand).length >= 4 && textContainsBrandAlias(normalized.answerText, brand)) {
        overlapSet.add(cd)
      }
      // A competitor's own names ("MAA" for maac.com) are operator-approved, so
      // they match even when the domain's label would not.
      const named = competitorAliases.get(cd)
      if (named?.length && textContainsAnyBrandAlias(normalized.answerText, named)) {
        overlapSet.add(cd)
      }
    }
  }

  return [...overlapSet]
}

/** Domains from the final citation list that belong to tracked competitors. */
export function computeCitedCompetitorDomains(
  citedDomains: readonly string[],
  competitorDomains: readonly string[],
): string[] {
  const citedCompetitors = new Set<string>()
  for (const citedDomain of citedDomains) {
    for (const competitorDomain of competitorDomains) {
      if (hostMatchesDomain(citedDomain, competitorDomain)) citedCompetitors.add(competitorDomain)
    }
  }
  return [...citedCompetitors]
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

  const seen = new Map<string, string>()
  for (const pattern of candidatePatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(answerText)) !== null) {
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
  // subdomain labels — so a competitor `offers.roofle.com` does not contribute
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
