import { normalizeProjectDomain } from '@ainyc/canonry-contracts'

/**
 * True when `citedDomain` is the project's canonical domain or a subdomain of any
 * domain in `projectDomains`. Mirrors `domainMatches` in
 * `packages/canonry/src/citation-utils.ts` (which `determineCitationState` uses).
 * Whenever the matching rules change, update both in lockstep — there is no
 * dependency seam between intelligence and canonry app code.
 */
export function citedDomainBelongsToProject(
  citedDomain: string,
  projectDomains: readonly string[],
): boolean {
  const candidate = normalizeProjectDomain(citedDomain)
  for (const domain of projectDomains) {
    const normalized = normalizeProjectDomain(domain)
    if (candidate === normalized || candidate.endsWith(`.${normalized}`)) return true
  }
  return false
}
