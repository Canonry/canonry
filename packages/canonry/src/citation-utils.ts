import type { NormalizedQueryResult } from '@ainyc/canonry-contracts'
import { hostMatchesDomain } from '@ainyc/canonry-contracts'

/**
 * Of the domains an engine cited for a (query, provider) snapshot, return the
 * first that belongs to the project (canonical or owned domain), or `undefined`
 * when none do.
 *
 * `citedDomains` is the FULL set of cited sources — project domains, tracked
 * competitors, and third-party references intermingled in provider order. A
 * project citation gain/regression must be labeled with the project's OWN
 * cited URL, not `citedDomains[0]`, which is frequently a co-cited competitor
 * (e.g. a regression on the project's page mislabeled "audit tilerival.test").
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
