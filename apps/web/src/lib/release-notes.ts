import { CANONRY_COMMUNITY_LINKS, CANONRY_NPM_PACKAGE_URL, compareSemver, isStrictSemver } from '@canonry/canonry-contracts'

interface ReleaseHighlight {
  text: string
  action?: { label: string; href: string; icon: 'Discord' }
}

// List stable releases newest first. A skipped upgrade can show notes from several releases.
const releases = [
  {
    version: '7.117.0',
    highlights: (showResourceLinks: boolean): ReleaseHighlight[] => showResourceLinks ? [{
      text: 'Meet other Canonry users, get help, and share what you’re building.',
      action: { label: 'Join our Discord', href: CANONRY_COMMUNITY_LINKS.discord, icon: 'Discord' },
    }] : [],
  },
]

function reachedRelease(version: string, release: string): boolean {
  const order = compareSemver(version, release)
  // The shared comparator handles version cores. A prerelease precedes its stable release.
  return order > 0 || (order === 0 && !version.split('+', 1)[0]?.includes('-'))
}

export function releaseHighlights(previous: string, current: string, showResourceLinks = true): ReleaseHighlight[] {
  if (!isStrictSemver(previous) || !isStrictSemver(current)) return []
  return releases
    .filter(({ version }) => !reachedRelease(previous, version) && reachedRelease(current, version))
    .flatMap(({ highlights }) => highlights(showResourceLinks))
}

export function latestReleaseNotes(current: string, showResourceLinks = true): { version: string; highlights: ReleaseHighlight[] } | undefined {
  if (!isStrictSemver(current)) return undefined
  for (const release of releases) {
    if (!reachedRelease(current, release.version)) continue
    const highlights = release.highlights(showResourceLinks)
    if (highlights.length > 0) return { version: release.version, highlights }
  }
  return undefined
}

const repositoryUrl = 'https://github.com/Canonry/canonry'

function gitSha(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : undefined
}

export function releaseChangesUrl(previousCommit: string | undefined, currentCommit: string | undefined, version: string): string {
  const current = gitSha(currentCommit)
  if (current) {
    const previous = gitSha(previousCommit)
    // The build stamp and the environment fallback may use different lengths for the same SHA.
    if (previous && !current.startsWith(previous) && !previous.startsWith(current)) {
      return `${repositoryUrl}/compare/${previous}...${current}`
    }
    return `${repositoryUrl}/commits/${current}`
  }
  return isStrictSemver(version)
    ? `${CANONRY_NPM_PACKAGE_URL}/v/${encodeURIComponent(version)}`
    : CANONRY_NPM_PACKAGE_URL
}
