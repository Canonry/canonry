import { CANONRY_COMMUNITY_LINKS, compareSemver, isStrictSemver } from '@canonry/canonry-contracts'

interface ReleaseHighlight {
  title?: string
  text: string
  /** A terminal command shown on its own line, never inside `text`. */
  command?: string
  action?: { label: string; href: string; icon: 'Discord' }
}

/** Who is reading. A release shows only the highlights this reader can act on. */
export interface ReleaseAudience {
  /**
   * Community and guide links are allowed (`dashboard.showResourceLinks`). Hosted
   * dashboards keep the release invitation even though their footer hides
   * community links (#1546, `app-public-demo.test.tsx`).
   */
  showResourceLinks: boolean
  /** A hosted engine dashboard (`dashboard.whatsNewOnly`): customer highlights only, no CLI or self-hosting steps. */
  whatsNewOnly: boolean
  /** The signed-in viewer has general write authority. */
  canWrite: boolean
  /** The operator lets the dashboard point to product feedback (`dashboard.showFeedback`). */
  showFeedback: boolean
}

const SELF_HOSTED_OPERATOR: ReleaseAudience = { showResourceLinks: true, whatsNewOnly: false, canWrite: true, showFeedback: true }

export interface ReleaseNotes {
  version: string
  highlights: ReleaseHighlight[]
}

// Stable, user-facing releases, newest first. The badge only features minor and major releases.
const releases: { version: string; highlights: (audience: ReleaseAudience) => ReleaseHighlight[] }[] = [
  {
    version: '7.122.0',
    // Sending feedback needs write authority, and an operator who hid feedback
    // (`dashboard.showFeedback: false`) gets no pointer to it. A hosted
    // customer has no CLI but can still ask a connected agent (`canonry_feedback`).
    highlights: ({ whatsNewOnly, canWrite, showFeedback }) => !canWrite || !showFeedback ? [] : [whatsNewOnly ? {
      title: 'Send feedback from your agent',
      text: 'Ask your AI agent to send feedback to the Canonry team. It replaces the Feedback button, and API keys are removed before anything is sent.',
    } : {
      title: 'Send feedback from your agent',
      text: 'Ask your AI agent to send feedback to the Canonry team, or run this in a terminal. It replaces the Feedback button, and API keys are removed before anything is sent.',
      command: 'canonry feedback "what happened"',
    }],
  },
  {
    version: '7.117.0',
    highlights: ({ showResourceLinks }) => showResourceLinks ? [{
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

export function availableReleaseNotes(current: string, audience: ReleaseAudience = SELF_HOSTED_OPERATOR): ReleaseNotes[] {
  if (!validBuildVersion(current)) return []
  return releases.flatMap(({ version, highlights }) => {
    if (!/^\d+\.\d+\.0$/.test(version) || compareReleaseBoundaries(current, version) < 0) return []
    const visible = highlights(audience)
    return visible.length ? [{ version, highlights: visible }] : []
  })
}
