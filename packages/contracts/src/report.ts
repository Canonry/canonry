/**
 * Aggregated report bundle for `GET /projects/:name/report` and
 * `canonry report <project>`. Combines every signal a client-facing AEO
 * report needs into a single, deterministic JSON payload — see issue #401.
 *
 * Field names follow the canonry vocabulary rules: `mention*` for answer-text
 * presence, `cite*` for source-list presence; never blend the two.
 */

export interface ReportMeta {
  /** ISO timestamp the report was generated (server clock). */
  generatedAt: string
  /** Project the report covers. */
  project: {
    id: string
    name: string
    displayName: string
    canonicalDomain: string
    country: string
    language: string
  }
  /** Earliest data point referenced by the report (ISO date). */
  periodStart: string | null
  /** Latest data point referenced by the report (ISO date). */
  periodEnd: string | null
}

export interface ReportExecutiveSummary {
  /** 0..100 — share of (keyword × provider) pairs in the latest run that were cited. */
  citationRate: number
  /** Compared to the previous run: 'up' | 'down' | 'flat' | 'unknown' (no prior run). */
  trend: 'up' | 'down' | 'flat' | 'unknown'
  /** Total tracked keywords. */
  keywordCount: number
  /** Total tracked competitors. */
  competitorCount: number
  /** Number of providers in the latest run. */
  providerCount: number
  /** GSC totals across the most-recent sync window. Null when GSC is not connected. */
  gsc: {
    clicks: number
    impressions: number
    ctr: number
    avgPosition: number
  } | null
  /** GA4 totals across the most-recent sync period. Null when GA4 is not connected. */
  ga: {
    sessions: number
    users: number
    periodStart: string
    periodEnd: string
  } | null
  /** Top 3-5 findings, each rendered as a single-sentence narrative. */
  findings: Array<{
    title: string
    detail: string
    tone: 'positive' | 'caution' | 'negative' | 'neutral'
  }>
}

export interface CitationCell {
  citationState: 'cited' | 'not-cited' | 'pending'
  answerMentioned: boolean | null
  model: string | null
}

export interface CitationScorecard {
  keywords: string[]
  providers: string[]
  /** matrix[keywordIndex][providerIndex] — null when no snapshot exists for the pair. */
  matrix: Array<Array<CitationCell | null>>
  /** Per-provider citation rate (0..100). */
  providerRates: Array<{
    provider: string
    citedCount: number
    totalCount: number
    citationRate: number
  }>
}

export interface CompetitorRow {
  domain: string
  /** Number of (keyword × provider) pairs that cited this competitor. */
  citationCount: number
  /** Out-of count for the same denominator. */
  totalCount: number
  /** 'High' | 'Moderate' | 'Low' | 'None' — from buildPortfolioProject pressure logic. */
  pressureLabel: 'High' | 'Moderate' | 'Low' | 'None'
  /** Distinct keywords on which this competitor was cited. */
  citedKeywords: string[]
}

export interface CompetitorLandscape {
  /** Project's own citation count (for the bar chart comparing project vs competitors). */
  projectCitationCount: number
  competitors: CompetitorRow[]
}

export interface AiSourceCategoryBucket {
  /** Category slug from packages/contracts/src/source-categories. */
  category: string
  /** Display label. */
  label: string
  /** Number of citations falling in this category. */
  count: number
  /** 0..100 share of total citations. */
  sharePct: number
}

export interface AiSourceOrigin {
  categories: AiSourceCategoryBucket[]
  /** Top 20 source domains by citation count (excluding the project's own domain). */
  topDomains: Array<{
    domain: string
    count: number
    /** True when the domain is one of the project's tracked competitors. */
    isCompetitor: boolean
  }>
}

export interface GscQueryRow {
  query: string
  clicks: number
  impressions: number
  ctr: number
  avgPosition: number
  /** Heuristic categorization: 'brand' | 'lead-gen' | 'industry' | 'other'. */
  category: 'brand' | 'lead-gen' | 'industry' | 'other'
}

export interface GscSection {
  totalClicks: number
  totalImpressions: number
  ctr: number
  avgPosition: number
  topQueries: GscQueryRow[]
  categoryBreakdown: Array<{
    category: 'brand' | 'lead-gen' | 'industry' | 'other'
    clicks: number
    impressions: number
    sharePct: number
  }>
  trend: Array<{ date: string; clicks: number; impressions: number }>
}

export interface GaTrafficSection {
  totalSessions: number
  totalUsers: number
  totalOrganicSessions: number
  periodStart: string
  periodEnd: string
  topLandingPages: Array<{
    page: string
    sessions: number
    users: number
    organicSessions: number
  }>
  channelBreakdown: Array<{
    channel: string
    sessions: number
    sharePct: number
  }>
}

export interface SocialReferralSection {
  totalSessions: number
  organicSessions: number
  paidSessions: number
  channels: Array<{
    channelGroup: string
    sessions: number
    sharePct: number
  }>
  topCampaigns: Array<{
    source: string
    medium: string
    sessions: number
  }>
}

export interface AiReferralSection {
  totalSessions: number
  totalUsers: number
  bySource: Array<{
    source: string
    sessions: number
    users: number
    sharePct: number
  }>
  trend: Array<{ date: string; sessions: number }>
  topLandingPages: Array<{
    page: string
    sessions: number
    users: number
  }>
}

export interface IndexingHealthSection {
  /** Source: 'google' | 'bing' | null when neither is connected. */
  provider: 'google' | 'bing' | null
  total: number
  indexed: number
  notIndexed: number
  /** Google-only — pages explicitly marked as deindexed. Bing reports 'unknown' instead. */
  deindexed: number
  /** Bing-only — pages with no inspection data yet. */
  unknown: number
  /** 0..100. */
  indexedPct: number
}

export interface CitationsTrendPoint {
  /** Run ID — anchor for cross-section linking. */
  runId: string
  /** ISO timestamp when the run finished (or createdAt fallback). */
  date: string
  /** Citation rate for this run, 0..100. */
  citationRate: number
  /** Per-provider rates for the same run. */
  providerRates: Array<{ provider: string; citationRate: number }>
}

export interface ReportInsight {
  id: string
  type: 'regression' | 'gain' | 'opportunity'
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  keyword: string
  provider: string
  recommendation: string | null
  createdAt: string
}

export interface RecommendedNextStep {
  /** 'immediate' | 'short-term' | 'medium-term' — bucketed by severity heuristic. */
  horizon: 'immediate' | 'short-term' | 'medium-term'
  title: string
  rationale: string
}

export interface ProjectReportDto {
  meta: ReportMeta
  executiveSummary: ReportExecutiveSummary
  citationScorecard: CitationScorecard
  competitorLandscape: CompetitorLandscape
  aiSourceOrigin: AiSourceOrigin
  gsc: GscSection | null
  ga: GaTrafficSection | null
  socialReferrals: SocialReferralSection | null
  aiReferrals: AiReferralSection | null
  indexingHealth: IndexingHealthSection | null
  citationsTrend: CitationsTrendPoint[]
  insights: ReportInsight[]
  recommendedNextSteps: RecommendedNextStep[]
}
