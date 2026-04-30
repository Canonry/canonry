export const CANONRY_MCP_TIERS = ['core', 'monitoring', 'setup', 'gsc', 'ga', 'agent'] as const
export type CanonryMcpTier = typeof CANONRY_MCP_TIERS[number]

export const CANONRY_MCP_TOOLKIT_NAMES = ['monitoring', 'setup', 'gsc', 'ga', 'agent'] as const
export type CanonryMcpToolkitName = typeof CANONRY_MCP_TOOLKIT_NAMES[number]

export interface CanonryMcpToolkit {
  name: CanonryMcpToolkitName
  title: string
  description: string
  whenToLoad: string
}

export const CANONRY_MCP_TOOLKITS: readonly CanonryMcpToolkit[] = [
  {
    name: 'monitoring',
    title: 'Runs, snapshots, insights, health',
    description: 'Inspect run history, query snapshots, intelligence insights, and health timelines.',
    whenToLoad: 'Load when investigating regressions, comparing runs, or reviewing insights and health history.',
  },
  {
    name: 'setup',
    title: 'Project configuration',
    description: 'Manage keywords, competitors, schedules, project upsert, and config-as-code roundtrips.',
    whenToLoad: 'Load when onboarding a new project or editing tracked keywords, competitors, or schedules.',
  },
  {
    name: 'gsc',
    title: 'Google Search Console',
    description: 'Read GSC performance, inspections, coverage, sitemaps, and deindexed URLs.',
    whenToLoad: 'Load when you need indexing, coverage, or sitemap data from Google Search Console.',
  },
  {
    name: 'ga',
    title: 'Google Analytics 4',
    description: 'Read GA traffic, AI/social referral history, attribution trend, and session history.',
    whenToLoad: 'Load when you need traffic, referral, or attribution data from Google Analytics 4.',
  },
  {
    name: 'agent',
    title: 'Aero agent lifecycle and memory',
    description: 'Manage the built-in Aero agent: durable project-scoped memory (list/set/forget), clear the rolling transcript, and detach the external-agent webhook.',
    whenToLoad: 'Load when reading or writing project-scoped Aero notes, clearing a stuck conversation, or removing an external agent webhook.',
  },
] as const

export function isCanonryMcpToolkitName(value: string): value is CanonryMcpToolkitName {
  return (CANONRY_MCP_TOOLKIT_NAMES as readonly string[]).includes(value)
}
