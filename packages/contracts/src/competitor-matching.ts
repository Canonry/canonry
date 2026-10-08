import { brandKeyFromText, compileBrandAliases, matcherMatchesText, prepareBrandMatchText } from './brand-matching.js'
import { extractLaidOutBusinessNames } from './business-name-candidates.js'
import type { NormalizedQueryResult } from './provider.js'
import { isListingMarketplace } from './source-categories.js'
import { brandLabelFromDomain, extractDomainsFromText, hostMatchesDomain, registrableDomain } from './url-normalize.js'

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
    // The answer is read once (written hosts, normalized words) and checked
    // against every competitor: a recompute runs this over every stored
    // answer of a project, once per tracked competitor.
    const writtenHosts = extractDomainsFromText(normalized.answerText)
    const prepared = prepareBrandMatchText(normalized.answerText)
    for (const cd of competitorDomains) {
      if (writtenHosts.some(host => hostMatchesDomain(host, cd))) {
        overlapSet.add(cd)
      }
      // Use the registrable domain's brand label (eTLD+1's leftmost label) so
      // a stored competitor like `offers.quotebird.test` is matched against the
      // brand `quotebird`, not the subdomain `offers` — otherwise the literal
      // word "offers" in the answer prose would falsely flag the competitor.
      const brand = brandLabelFromDomain(cd)
      if (brandKeyFromText(brand).length >= 4 && matcherMatchesText(compileBrandAliases([brand]), prepared)) {
        overlapSet.add(cd)
      }
      // A competitor's own names ("QRA" for qravelhomes.example) are operator-approved, so
      // they match even when the domain's label would not.
      const named = competitorAliases.get(cd)
      if (named?.length && matcherMatchesText(compileBrandAliases(named), prepared)) {
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

  // The shared layout stage (layouts, layout words, chips removed), names
  // kept whole (`Quillan's`, `Name (site.example)`); this extractor keeps only
  // names that line up with a known identity.
  // Each alias set compiles once; a candidate matches the set when it
  // matches any one alias in it.
  const ownMatcher = compileBrandAliases([...ownBrandAliases])
  const knownMatcher = compileBrandAliases([...knownCompetitorAliases])
  const seen = new Map<string, string>()
  for (const candidate of extractLaidOutBusinessNames(answerText)) {
    const candidateKey = brandKeyFromText(candidate)
    const prepared = prepareBrandMatchText(candidate)
    if (matcherMatchesText(ownMatcher, prepared)) continue
    if (!matcherMatchesText(knownMatcher, prepared)) continue
    if (!seen.has(candidateKey)) seen.set(candidateKey, candidate)
  }

  return [...seen.values()].slice(0, 10)
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
