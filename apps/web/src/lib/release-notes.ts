import { CANONRY_COMMUNITY_LINKS, compareSemver, isStrictSemver } from '@canonry/canonry-contracts'

interface ReleaseHighlight {
  title?: string
  text: string
  action?: { label: string; href: string; icon: 'Discord' }
}

export interface ReleaseNotes {
  version: string
  highlights: ReleaseHighlight[]
}

// Stable, user-facing releases, newest first. The badge only features minor and major releases.
const releases = [
  {
    version: '7.117.0',
    highlights: (showResourceLinks: boolean): ReleaseHighlight[] => showResourceLinks ? [{
      title: 'Canonry on Discord',
      text: 'Meet other Canonry users, get help, and share what you’re building.',
      action: { label: 'Join our Discord', href: CANONRY_COMMUNITY_LINKS.discord, icon: 'Discord' },
    }] : [],
  },
]

export function validBuildVersion(version: unknown): version is string {
  if (typeof version !== 'string' || !isStrictSemver(version)) return false
  const prerelease = /^[^-+]+-([^+]+)/.exec(version)?.[1]
  return !prerelease?.split('.').some(part => /^0\d+$/.test(part))
}

/** Only stable release boundaries matter to the catalog. Prereleases of the same core share a boundary. */
export function compareReleaseBoundaries(left: string, right: string): number {
  const core = compareSemver(left, right)
  if (core) return core
  const beforeStable = (version: string) => /^[^+]+-/.test(version)
  return Number(beforeStable(right)) - Number(beforeStable(left))
}

export function availableReleaseNotes(current: string, showResourceLinks = true): ReleaseNotes[] {
  if (!validBuildVersion(current)) return []
  return releases.flatMap(({ version, highlights }) => {
    if (!/^\d+\.\d+\.0$/.test(version) || compareReleaseBoundaries(current, version) < 0) return []
    const visible = highlights(showResourceLinks)
    return visible.length ? [{ version, highlights: visible }] : []
  })
}
