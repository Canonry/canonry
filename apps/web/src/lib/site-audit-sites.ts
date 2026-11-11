import { hostOf } from '@canonry/canonry-contracts'

/**
 * The sites an Agent Readiness scan can cover: the main domain, which every
 * scan covers, and each owned domain once. All are bare hosts (lower case, no
 * `www.`), the form the API stores and the `site` filters take, so an owned
 * domain written as `https://www.example.org/` is offered as `example.org`.
 */
export function scanSiteChoices(project: { canonicalDomain?: string; ownedDomains?: readonly string[] } | undefined): {
  main: string | null
  owned: string[]
} {
  const main = project?.canonicalDomain ? hostOf(project.canonicalDomain) ?? project.canonicalDomain : null
  const owned: string[] = []
  for (const domain of project?.ownedDomains ?? []) {
    const host = hostOf(domain)
    if (!host || host === main || owned.includes(host)) continue
    owned.push(host)
  }
  return { main, owned }
}

/** True when two lists name the same sites, in any order. */
export function sameSites(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((site) => right.includes(site))
}

/** Ticks one site on or off, keeping the order the choices are listed in. */
export function toggleSite(choices: readonly string[], current: readonly string[], site: string, checked: boolean): string[] {
  return choices.filter((choice) => choice === site ? checked : current.includes(choice))
}
