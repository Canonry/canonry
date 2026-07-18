export const CANONRY_MCP_TIERS = ['core', 'monitoring', 'setup', 'gsc', 'ga', 'gbp', 'ads', 'traffic', 'agent', 'discovery'] as const
export type CanonryMcpTier = typeof CANONRY_MCP_TIERS[number]

export const CANONRY_MCP_TOOLKIT_NAMES = ['monitoring', 'setup', 'gsc', 'ga', 'gbp', 'ads', 'traffic', 'agent', 'discovery'] as const
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
    description: 'Manage queries, competitors, schedules, project upsert, and config-as-code roundtrips.',
    whenToLoad: 'Load when onboarding a new project or editing tracked queries, competitors, or schedules.',
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
    name: 'gbp',
    title: 'Google Business Profile',
    description: 'Local AEO signals: discover GBP locations under a connected account and toggle which ones sync. Future phases will add reviews, keyword impressions, daily performance metrics, and hotel attributes.',
    whenToLoad: 'Load when the project tracks local search visibility or has connected Google Business Profile.',
  },
  {
    name: 'ads',
    title: 'OpenAI ads (ChatGPT ads)',
    description: 'Live OpenAI ad-account review state, targetable geo IDs, conversion pixels/event settings, synced campaign structure, paid-performance rollups, and guarded lifecycle operations.',
    whenToLoad: 'Load when planning, creating, reviewing, or measuring ChatGPT ads, including geo and conversion-readiness checks before launch.',
  },
  {
    name: 'traffic',
    title: 'Server-side traffic ingestion',
    description: 'Connect Cloud Run traffic sources, trigger syncs, and read crawler / AI-referral hourly rollups straight from server logs (no GA dependency).',
    whenToLoad: 'Load when you need server-log evidence of crawler hits or AI-referral sessions (e.g. confirming GPTBot or ChatGPT-User on a page), or when wiring up / syncing a Cloud Run traffic source.',
  },
  {
    name: 'agent',
    title: 'Aero agent lifecycle and memory',
    description: 'Manage the built-in Aero agent: durable project-scoped memory (list/set/forget), clear the rolling transcript, and detach the external-agent webhook.',
    whenToLoad: 'Load when reading or writing project-scoped Aero notes, clearing a stuck conversation, or removing an external agent webhook.',
  },
  {
    name: 'discovery',
    title: 'Tracked-basket discovery (ICP → buckets)',
    description: 'Start and inspect discovery sessions. Each session expands an ICP description into a deduped set of representative queries, probes them against Gemini grounding, classifies each probe into cited / aspirational / wasted-surface, and aggregates a competitor map for the project.',
    whenToLoad: 'Load when the operator wants to expand or audit a project\'s tracked-query basket, audit competitive surface, or preview a promotion plan from a discovery session.',
  },
] as const

export function isCanonryMcpToolkitName(value: string): value is CanonryMcpToolkitName {
  return (CANONRY_MCP_TOOLKIT_NAMES as readonly string[]).includes(value)
}
