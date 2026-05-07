/**
 * Aggregated report bundle for `GET /projects/:name/report` and
 * `canonry report <project>`. Combines every signal a client-facing AEO
 * report needs into a single, deterministic JSON payload — see issue #401.
 *
 * Field names follow the canonry vocabulary rules: `mention*` for answer-text
 * presence, `cite*` for source-list presence; never blend the two.
 */

import type {
  ContentTargetRowDto,
  ContentSourceRowDto,
  ContentGapRowDto,
} from './content.js'
import type { ProviderLocationTreatment } from './provider.js'

export interface ReportMetaLocation {
  /** Human-readable label as configured on the project (e.g. "michigan"). */
  label: string
  /** Resolved city/region/country from the project's `LocationContext`. */
  city: string
  region: string
  country: string
  /**
   * Other locations configured on the project that did NOT power this report.
   * When non-empty, callers should make clear that the report is location-scoped:
   * a separate sweep is needed to see how AI engines respond from each one.
   */
  otherConfiguredLabels: string[]
}

export interface ReportProviderLocationHandling {
  /** Provider name (matches `query_snapshots.provider`). */
  provider: string
  /** How this provider applied the configured location during this run. */
  treatment: ProviderLocationTreatment
  /** One-sentence explanation suitable for the report. */
  description: string
}

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
  /**
   * The location that powered the latest visibility run, when one was set.
   * `null` means the run had no location attached — providers received the
   * query verbatim with no geographic hint.
   */
  location: ReportMetaLocation | null
  /**
   * Per-provider location handling for the providers that ran in the latest
   * visibility sweep. Empty when there were no providers (or no run). Use
   * this to tell the reader whether the configured location actually shaped
   * each provider's answer — some providers append it to the prompt, some
   * pass it as a structured request field, and some (CDP) ignore it.
   */
  providerLocationHandling: ReportProviderLocationHandling[]
  /** Earliest data point referenced by the report (ISO date). */
  periodStart: string | null
  /** Latest data point referenced by the report (ISO date). */
  periodEnd: string | null
}

export interface ReportExecutiveSummary {
  /**
   * 0..100 — share of tracked queries that were cited by at least one
   * provider in the latest run. "Cited" means the project's domain appeared
   * in the source list / grounding the AI used to answer. Computed per-query
   * (not per-(query × provider)) so the rate is invariant to provider count.
   */
  citationRate: number
  /** Numerator of `citationRate` — distinct tracked queries cited by ≥1 provider in the latest run. */
  citedQueryCount: number
  /** Denominator of `citationRate` — total tracked queries. */
  totalQueryCount: number
  /**
   * 0..100 — share of tracked queries where the project's brand or domain
   * appeared in at least one provider's answer text in the latest run.
   * "Mentioned" is independent from "cited": a model can mention you in
   * the prose without citing your domain in its sources, and vice versa.
   * Same per-query denominator as `citationRate` for consistency.
   */
  mentionRate: number
  /** Numerator of `mentionRate` — distinct tracked queries mentioned in ≥1 provider's answer text. */
  mentionedQueryCount: number
  /** Compared to the previous run: 'up' | 'down' | 'flat' | 'unknown' (no prior run). */
  trend: 'up' | 'down' | 'flat' | 'unknown'
  /** Total tracked queries. */
  queryCount: number
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
    periodStart: string
    periodEnd: string
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
  queries: string[]
  providers: string[]
  /** matrix[queryIndex][providerIndex] — null when no snapshot exists for the pair. */
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
  /** Number of (query × provider) pairs that cited this competitor. */
  citationCount: number
  /** Out-of count for the same denominator. */
  totalCount: number
  /** 'High' | 'Moderate' | 'Low' | 'None' — from buildPortfolioProject pressure logic. */
  pressureLabel: 'High' | 'Moderate' | 'Low' | 'None'
  /** Distinct queries on which this competitor was cited. */
  citedQueries: string[]
  /**
   * Share of voice 0..100. Numerator = this competitor's `citationCount`.
   * Denominator = sum of `citationCount` across all competitors plus the
   * project's own `projectCitationCount`. Equals 0 when there are no cited
   * slots in the snapshot.
   */
  sharePct: number
  /**
   * URLs from the latest run's grounding sources whose host matches this
   * competitor's domain, with the queries each URL was cited for. Empty
   * when no grounding-source data is available (e.g. no `rawResponse` JSON
   * stored for the snapshots).
   */
  theirCitedPages: Array<{ url: string; citedFor: string[] }>
}

export interface CompetitorLandscape {
  /** Project's own citation count (for the bar chart comparing project vs competitors). */
  projectCitationCount: number
  competitors: CompetitorRow[]
}

export interface MentionRow {
  domain: string
  /** Number of (query × provider) pairs whose answer text mentioned this competitor's brand or domain. */
  mentionCount: number
  /** Out-of count for the same denominator (snapshots that had answer text). */
  totalCount: number
  /** 'High' | 'Moderate' | 'Low' | 'None' — mention frequency tier (mirrors CompetitorRow.pressureLabel). */
  pressureLabel: 'High' | 'Moderate' | 'Low' | 'None'
  /** Distinct queries on which this competitor was mentioned. */
  mentionedQueries: string[]
  /**
   * Share of voice 0..100. Numerator = this competitor's `mentionCount`.
   * Denominator = sum of `mentionCount` across all competitors plus the
   * project's own `projectMentionCount`. Equals 0 when no snapshot had any
   * mention.
   */
  sharePct: number
}

export interface MentionLandscape {
  /** Project's own mention count (for the bar chart comparing project vs competitors). */
  projectMentionCount: number
  /** Snapshots considered — those with non-empty answerText. Drives the totalCount denominator. */
  totalAnswerSnapshots: number
  competitors: MentionRow[]
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
  periodStart: string
  periodEnd: string
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
  /**
   * Tracked AEO queries that have no GSC impressions in the report window.
   * Surfaces queries that may not represent real search demand.
   */
  trackedButNoGsc: string[]
  /**
   * GSC top queries (sorted by impressions desc) that are not tracked as
   * AEO queries — the candidate set for adding to the AEO project.
   */
  gscButNotTracked: string[]
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
  /**
   * 0..100 — same per-query unique-cited definition as
   * `ReportExecutiveSummary.citationRate`. Stable across runs with different
   * provider counts so the trend line measures real movement rather than
   * provider-count variance.
   */
  citationRate: number
  /** Numerator of `citationRate` for this run. */
  citedQueryCount: number
  /** Denominator of `citationRate` for this run. */
  totalQueryCount: number
  /** 0..100 — same per-query unique-mentioned definition as `ReportExecutiveSummary.mentionRate`. */
  mentionRate: number
  /** Numerator of `mentionRate` for this run. */
  mentionedQueryCount: number
  /**
   * Per-provider rates for the same run. Each provider's rate is per-pair
   * within that provider (`cited / scanned`), so it remains comparable
   * between providers in the same run.
   */
  providerRates: Array<{ provider: string; citationRate: number }>
}

export interface ReportInsight {
  id: string
  type: 'regression' | 'gain' | 'opportunity'
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  query: string
  provider: string
  recommendation: string | null
  createdAt: string
  /**
   * How many times this insight fired across recent runs for the same
   * `(query, provider, type)` tuple. Always ≥ 1. Insights returned by the
   * report API are already deduped to one row per tuple, with this counter
   * surfacing the multiplicity. Use it directly instead of grouping again
   * client-side — counts derived from raw insight rows will overcount.
   */
  instanceCount: number
}

export interface RecommendedNextStep {
  /** 'immediate' | 'short-term' | 'medium-term' — bucketed by severity heuristic. */
  horizon: 'immediate' | 'short-term' | 'medium-term'
  title: string
  rationale: string
}

export type ReportAudience = 'agency' | 'client'
export type ReportActionAudience = ReportAudience | 'both'
export type ReportActionHorizon = 'immediate' | 'short-term' | 'medium-term'
export type ReportActionConfidence = 'high' | 'medium' | 'low'
export type ReportTone = 'positive' | 'caution' | 'negative' | 'neutral'
export type ReportActionCategory =
  | 'content'
  | 'competitors'
  | 'provider'
  | 'search-demand'
  | 'indexing'
  | 'location'
  | 'monitoring'

export interface ReportActionPlanItem {
  /** Which report audience should see this action. `both` renders in both modes. */
  audience: ReportActionAudience
  /** Stable sort priority. Lower numbers render earlier. */
  priority: number
  /** When this should be tackled. */
  horizon: ReportActionHorizon
  category: ReportActionCategory
  title: string
  /** Direct next step written as an operator/client-friendly imperative. */
  action: string
  /** Why this matters. Keep each entry concise and evidence-backed. */
  why: string[]
  /** Specific observations that justify the action. */
  evidence: string[]
  /** What should move if the action worked. */
  successMetric: string
  /** Confidence in the recommendation based on the available evidence. */
  confidence: ReportActionConfidence
}

export interface ReportClientSummary {
  headline: string
  overview: string
  actionItems: ReportActionPlanItem[]
  confidenceNotes: string[]
}

export interface ReportAgencyDiagnostic {
  title: string
  detail: string
  severity: 'positive' | 'caution' | 'negative' | 'neutral'
  evidence: string[]
}

export interface ReportAgencyDiagnostics {
  priorities: ReportActionPlanItem[]
  diagnostics: ReportAgencyDiagnostic[]
}

export function reportActionTone(
  action: Pick<ReportActionPlanItem, 'horizon' | 'confidence'>,
): ReportTone {
  if (action.horizon === 'immediate') return 'negative'
  if (action.confidence === 'high') return 'caution'
  if (action.confidence === 'low') return 'neutral'
  return 'caution'
}

export interface ProjectReportDto {
  meta: ReportMeta
  executiveSummary: ReportExecutiveSummary
  citationScorecard: CitationScorecard
  competitorLandscape: CompetitorLandscape
  mentionLandscape: MentionLandscape
  aiSourceOrigin: AiSourceOrigin
  gsc: GscSection | null
  ga: GaTrafficSection | null
  socialReferrals: SocialReferralSection | null
  aiReferrals: AiReferralSection | null
  indexingHealth: IndexingHealthSection | null
  citationsTrend: CitationsTrendPoint[]
  insights: ReportInsight[]
  recommendedNextSteps: RecommendedNextStep[]
  /** Canonical structured actions shared by the client and agency render modes. */
  actionPlan: ReportActionPlanItem[]
  /** Polished client-facing summary and action shortlist. */
  clientSummary: ReportClientSummary
  /** Technical, evidence-oriented operator diagnostics for agency mode. */
  agencyDiagnostics: ReportAgencyDiagnostics
  /**
   * Ranked, action-typed content opportunities sourced from the existing
   * intelligence layer (`buildContentTargetRows`). Empty when no run has
   * produced candidate queries with demand or competitor signal.
   */
  contentOpportunities: ContentTargetRowDto[]
  /**
   * Queries where competitors were cited but the project was not. Sourced
   * from `buildContentGapRows`. Empty until the first answer-visibility run.
   */
  contentGaps: ContentGapRowDto[]
  /**
   * Per-query grounding source map (own + competitor cited URLs). Sourced
   * from `buildContentSourceRows`. Empty until the first answer-visibility run.
   */
  groundingSources: ContentSourceRowDto[]
}
