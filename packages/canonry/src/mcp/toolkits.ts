export const CANONRY_MCP_TIERS = [
  'core',
  'monitoring',
  'setup',
  'gsc',
  'ga',
  'gbp',
  // `ads` is deliberately OpenAI / ChatGPT Ads. Google Ads has its own
  // toolkit so an agent never mistakes the two provider surfaces.
  'ads',
  'google-ads',
  'gtm',
  'conversion-tracking',
  'traffic',
  'agent',
  'discovery',
] as const
export type CanonryMcpTier = typeof CANONRY_MCP_TIERS[number]

export const CANONRY_MCP_TOOLKIT_NAMES = [
  'monitoring',
  'setup',
  'gsc',
  'ga',
  'gbp',
  'ads',
  'google-ads',
  'gtm',
  'conversion-tracking',
  'traffic',
  'agent',
  'discovery',
] as const
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
    title: 'Measurement, runs, insights, health',
    description: 'Inspect portfolio and Property measurement, question results, run history, intelligence insights, health timelines, and bounded Site Health reads (overview, page audit evidence, focused subgraphs, paths, and scan changes).',
    whenToLoad: 'Load when finding weak Properties, reviewing answers and competitors, checking data quality, tying a Site Health page score to concrete findings, investigating site architecture, comparing scans, or diagnosing regressions.',
  },
  {
    name: 'setup',
    title: 'Project setup and measurement',
    description: 'Manage project configuration, Advanced Measurement drafts, query assets, competitors, and schedules.',
    whenToLoad: 'Load when onboarding a project, editing its measurement plan, or managing tracked queries, competitors, or schedules.',
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
    name: 'google-ads',
    title: 'Google Ads conversion evidence',
    description: 'Read a connected Google Ads account, its conversion actions, effective campaign goals, and bounded stored snapshots. v1 only reads provider state; it never edits campaigns, conversion actions, or bidding goals.',
    whenToLoad: 'Load when selecting a Google Ads customer, reviewing conversion-action and effective-goal evidence, or starting a bounded read-only sync.',
  },
  {
    name: 'gtm',
    title: 'Google Tag Manager conversion evidence',
    description: 'Read GTM accounts, containers, workspaces, and sanitized live/draft tag graphs used to verify a conversion contract. v1 never edits a workspace or publishes a container version.',
    whenToLoad: 'Load when selecting a GTM container, reviewing a live or draft conversion-tag graph, or starting a bounded read-only sync.',
  },
  {
    name: 'conversion-tracking',
    title: 'Cross-provider conversion integrity',
    description: 'Read declared conversion contracts and assess them against stored Google Ads and GTM evidence without calling or mutating either provider.',
    whenToLoad: 'Load when listing or inspecting declared conversion contracts, or when checking whether stored Google Ads and GTM evidence is consistent with one contract.',
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
    title: 'Query discovery and research',
    description: 'Two linked workflows: find queries expands an ICP into a promotable tracked-query basket; research runs saved free-form experiments against one API model. Research stays isolated until an explicit preview and checksum-guarded promotion commit.',
    whenToLoad: 'Load when the operator wants to find ICP-led candidates for a tracked basket, research specific free-form queries, inspect saved answers and sources, or preview and commit an explicit research-to-tracking promotion.',
  },
] as const

export function isCanonryMcpToolkitName(value: string): value is CanonryMcpToolkitName {
  return (CANONRY_MCP_TOOLKIT_NAMES as readonly string[]).includes(value)
}
