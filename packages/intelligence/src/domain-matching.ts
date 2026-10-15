import { hostMatchesAnyDomain } from '@canonry/canonry-contracts'

/**
 * True when `citedDomain` is the project's canonical domain or a subdomain of any
 * domain in `projectDomains`. Domain normalization and the exact-or-subdomain
 * rule live in contracts so every caller stays in lockstep.
 */
export function citedDomainBelongsToProject(
  citedDomain: string,
  projectDomains: readonly string[],
): boolean {
  return hostMatchesAnyDomain(citedDomain, projectDomains)
}
