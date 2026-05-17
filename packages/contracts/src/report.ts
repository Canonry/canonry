/**
 * Aggregated report bundle for `GET /projects/:name/report` and
 * `canonry report <project>`. Combines every signal a client-facing AEO
 * report needs into a single, deterministic JSON payload — see issue #401.
 *
 * Field names follow the canonry vocabulary rules: `mention*` for answer-text
 * presence, `cite*` for source-list presence; never blend the two.
 */

import { z } from 'zod'

import {
  contentTargetRowDtoSchema,
  contentSourceRowDtoSchema,
  contentGapRowDtoSchema,
} from './content.js'

const providerLocationTreatmentSchema = z.enum([
  'prompt',
  'request-param',
  'browser-geo',
  'ignored',
])

export const reportMetaLocationSchema = z.object({
  /** Human-readable label as configured on the project (e.g. "michigan"). */
  label: z.string(),
  /** Resolved city/region/country from the project's `LocationContext`. */
  city: z.string(),
  region: z.string(),
  country: z.string(),
  /**
   * Other locations configured on the project that did NOT power this report.
   * When non-empty, callers should make clear that the report is location-scoped:
   * a separate sweep is needed to see how AI engines respond from each one.
   */
  otherConfiguredLabels: z.array(z.string()),
})

export type ReportMetaLocation = z.infer<typeof reportMetaLocationSchema>

export const reportProviderLocationHandlingSchema = z.object({
  /** Provider name (matches `query_snapshots.provider`). */
  provider: z.string(),
  /** How this provider applied the configured location during this run. */
  treatment: providerLocationTreatmentSchema,
  /** One-sentence explanation suitable for the report. */
  description: z.string(),
})

export type ReportProviderLocationHandling = z.infer<typeof reportProviderLocationHandlingSchema>

export const reportMetaSchema = z.object({
  /** ISO timestamp the report was generated (server clock). */
  generatedAt: z.string(),
  /** Project the report covers. */
  project: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
    canonicalDomain: z.string(),
    country: z.string(),
    language: z.string(),
  }),
  /**
   * The location that powered the latest visibility run, when one was set.
   * `null` means the run had no location attached — providers received the
   * query verbatim with no geographic hint.
   */
  location: reportMetaLocationSchema.nullable(),
  /**
   * Per-provider location handling for the providers that ran in the latest
   * visibility sweep. Empty when there were no providers (or no run). Use
   * this to tell the reader whether the configured location actually shaped
   * each provider's answer — some providers append it to the prompt, some
   * pass it as a structured request field, and some (CDP) ignore it.
   */
  providerLocationHandling: z.array(reportProviderLocationHandlingSchema),
  /** Earliest data point referenced by the report (ISO date). */
  periodStart: z.string().nullable(),
  /** Latest data point referenced by the report (ISO date). */
  periodEnd: z.string().nullable(),
})

export type ReportMeta = z.infer<typeof reportMetaSchema>

export const reportExecutiveSummarySchema = z.object({
  /**
   * 0..100 — share of tracked queries that were cited by at least one
   * provider in the latest run. "Cited" means the project's domain appeared
   * in the source list / grounding the AI used to answer. Computed per-query
   * (not per-(query × provider)) so the rate is invariant to provider count.
   */
  citationRate: z.number(),
  /** Numerator of `citationRate` — distinct tracked queries cited by ≥1 provider in the latest run. */
  citedQueryCount: z.number(),
  /** Denominator of `citationRate` — total tracked queries. */
  totalQueryCount: z.number(),
  /**
   * 0..100 — share of tracked queries where the project's brand or domain
   * appeared in at least one provider's answer text in the latest run.
   * "Mentioned" is independent from "cited": a model can mention you in
   * the prose without citing your domain in its sources, and vice versa.
   * Same per-query denominator as `citationRate` for consistency.
   */
  mentionRate: z.number(),
  /** Numerator of `mentionRate` — distinct tracked queries mentioned in ≥1 provider's answer text. */
  mentionedQueryCount: z.number(),
  /** Compared to the previous run: 'up' | 'down' | 'flat' | 'unknown' (no prior run). */
  trend: z.enum(['up', 'down', 'flat', 'unknown']),
  /** Total tracked queries. */
  queryCount: z.number(),
  /** Total tracked competitors. */
  competitorCount: z.number(),
  /** Number of providers in the latest run. */
  providerCount: z.number(),
  /** GSC totals across the most-recent sync window. Null when GSC is not connected. */
  gsc: z.object({
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    avgPosition: z.number(),
    periodStart: z.string(),
    periodEnd: z.string(),
  }).nullable(),
  /** GA4 totals across the most-recent sync period. Null when GA4 is not connected. */
  ga: z.object({
    sessions: z.number(),
    users: z.number(),
    periodStart: z.string(),
    periodEnd: z.string(),
  }).nullable(),
  /** Top 3-5 findings, each rendered as a single-sentence narrative. */
  findings: z.array(z.object({
    title: z.string(),
    detail: z.string(),
    tone: z.enum(['positive', 'caution', 'negative', 'neutral']),
  })),
})

export type ReportExecutiveSummary = z.infer<typeof reportExecutiveSummarySchema>

export const citationCellSchema = z.object({
  citationState: z.enum(['cited', 'not-cited', 'pending']),
  answerMentioned: z.boolean().nullable(),
  model: z.string().nullable(),
})

export type CitationCell = z.infer<typeof citationCellSchema>

export const citationScorecardSchema = z.object({
  queries: z.array(z.string()),
  providers: z.array(z.string()),
  /** matrix[queryIndex][providerIndex] — null when no snapshot exists for the pair. */
  matrix: z.array(z.array(citationCellSchema.nullable())),

  /** Per-provider citation rate (0..100). */
  providerRates: z.array(z.object({
    provider: z.string(),
    citedCount: z.number(),
    totalCount: z.number(),
    citationRate: z.number(),
  })),
})

export type CitationScorecard = z.infer<typeof citationScorecardSchema>

export const competitorRowSchema = z.object({
  domain: z.string(),
  /** Number of (query × provider) pairs that cited this competitor. */
  citationCount: z.number(),
  /** Out-of count for the same denominator. */
  totalCount: z.number(),
  /** 'High' | 'Moderate' | 'Low' | 'None' — from buildPortfolioProject pressure logic. */
  pressureLabel: z.enum(['High', 'Moderate', 'Low', 'None']),
  /** Distinct queries on which this competitor was cited. */
  citedQueries: z.array(z.string()),
  /**
   * Citation share 0..100. Numerator = this competitor's `citationCount`.
   * Denominator = sum of `citationCount` across all competitors plus the
   * project's own `projectCitationCount`. Equals 0 when there are no cited
   * slots in the snapshot. Distinct from the project-level Mention Share
   * gauge — that one is brand-in-answer-text, this one is domain-in-source-list.
   */
  sharePct: z.number(),
  /**
   * URLs from the latest run's grounding sources whose host matches this
   * competitor's domain, with the queries each URL was cited for. Empty
   * when no grounding-source data is available (e.g. no `rawResponse` JSON
   * stored for the snapshots).
   */
  theirCitedPages: z.array(z.object({ url: z.string(), citedFor: z.array(z.string()) })),
})

export type CompetitorRow = z.infer<typeof competitorRowSchema>

export const competitorLandscapeSchema = z.object({
  /** Project's own citation count (for the bar chart comparing project vs competitors). */
  projectCitationCount: z.number(),
  competitors: z.array(competitorRowSchema),
})

export type CompetitorLandscape = z.infer<typeof competitorLandscapeSchema>

export const mentionRowSchema = z.object({
  domain: z.string(),
  /** Number of (query × provider) pairs whose answer text mentioned this competitor's brand or domain. */
  mentionCount: z.number(),
  /** Out-of count for the same denominator (snapshots that had answer text). */
  totalCount: z.number(),
  /** 'High' | 'Moderate' | 'Low' | 'None' — mention frequency tier (mirrors CompetitorRow.pressureLabel). */
  pressureLabel: z.enum(['High', 'Moderate', 'Low', 'None']),
  /** Distinct queries on which this competitor was mentioned. */
  mentionedQueries: z.array(z.string()),
  /**
   * Mention share 0..100. Numerator = this competitor's `mentionCount`.
   * Denominator = sum of `mentionCount` across all competitors plus the
   * project's own `projectMentionCount`. Equals 0 when no snapshot had any
   * mention. Per-competitor split of the same head-to-head measure the
   * project's hero `MentionShareDto` gauge headlines.
   */
  sharePct: z.number(),
})

export type MentionRow = z.infer<typeof mentionRowSchema>

export const mentionLandscapeSchema = z.object({
  /** Project's own mention count (for the bar chart comparing project vs competitors). */
  projectMentionCount: z.number(),
  /** Snapshots considered — those with non-empty answerText. Drives the totalCount denominator. */
  totalAnswerSnapshots: z.number(),
  competitors: z.array(mentionRowSchema),
})

export type MentionLandscape = z.infer<typeof mentionLandscapeSchema>

export const aiSourceCategoryBucketSchema = z.object({
  /** Category slug from packages/contracts/src/source-categories. */
  category: z.string(),
  /** Display label. */
  label: z.string(),
  /** Number of citations falling in this category. */
  count: z.number(),
  /** 0..100 share of total citations. */
  sharePct: z.number(),
})

export type AiSourceCategoryBucket = z.infer<typeof aiSourceCategoryBucketSchema>

export const aiSourceOriginSchema = z.object({
  categories: z.array(aiSourceCategoryBucketSchema),
  /** Top 20 source domains by citation count (excluding the project's own domain). */
  topDomains: z.array(z.object({
    domain: z.string(),
    count: z.number(),
    /** True when the domain is one of the project's tracked competitors. */
    isCompetitor: z.boolean(),
  })),
})

export type AiSourceOrigin = z.infer<typeof aiSourceOriginSchema>

export const gscQueryRowSchema = z.object({
  query: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  avgPosition: z.number(),
  /** Heuristic categorization: 'brand' | 'lead-gen' | 'industry' | 'other'. */
  category: z.enum(['brand', 'lead-gen', 'industry', 'other']),
})

export type GscQueryRow = z.infer<typeof gscQueryRowSchema>

export const gscSectionSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  totalClicks: z.number(),
  totalImpressions: z.number(),
  ctr: z.number(),
  avgPosition: z.number(),
  topQueries: z.array(gscQueryRowSchema),
  categoryBreakdown: z.array(z.object({
    category: z.enum(['brand', 'lead-gen', 'industry', 'other']),
    clicks: z.number(),
    impressions: z.number(),
    sharePct: z.number(),
  })),
  trend: z.array(z.object({ date: z.string(), clicks: z.number(), impressions: z.number() })),
  /**
   * Tracked AEO queries that have no GSC impressions in the report window.
   * Surfaces queries that may not represent real search demand.
   */
  trackedButNoGsc: z.array(z.string()),
  /**
   * GSC top queries (sorted by impressions desc) that are not tracked as
   * AEO queries — the candidate set for adding to the AEO project.
   */
  gscButNotTracked: z.array(z.string()),
})

export type GscSection = z.infer<typeof gscSectionSchema>

export const gaTrafficSectionSchema = z.object({
  totalSessions: z.number(),
  totalUsers: z.number(),
  totalOrganicSessions: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
  topLandingPages: z.array(z.object({
    page: z.string(),
    sessions: z.number(),
    users: z.number(),
    organicSessions: z.number(),
  })),
  channelBreakdown: z.array(z.object({
    channel: z.string(),
    sessions: z.number(),
    sharePct: z.number(),
  })),
})

export type GaTrafficSection = z.infer<typeof gaTrafficSectionSchema>

export const socialReferralSectionSchema = z.object({
  totalSessions: z.number(),
  organicSessions: z.number(),
  paidSessions: z.number(),
  channels: z.array(z.object({
    channelGroup: z.string(),
    sessions: z.number(),
    sharePct: z.number(),
  })),
  topCampaigns: z.array(z.object({
    source: z.string(),
    medium: z.string(),
    sessions: z.number(),
  })),
})

export type SocialReferralSection = z.infer<typeof socialReferralSectionSchema>

export const aiReferralSectionSchema = z.object({
  totalSessions: z.number(),
  totalUsers: z.number(),
  bySource: z.array(z.object({
    source: z.string(),
    sessions: z.number(),
    users: z.number(),
    sharePct: z.number(),
  })),
  trend: z.array(z.object({ date: z.string(), sessions: z.number() })),
  topLandingPages: z.array(z.object({
    page: z.string(),
    sessions: z.number(),
    users: z.number(),
  })),
})

export type AiReferralSection = z.infer<typeof aiReferralSectionSchema>

/**
 * Server-side AI visibility — what AI engines actually do in your server logs.
 * Distinct from `aiReferrals` (GA4 click-throughs) and `mentions/cited`
 * (model-side answer presence). Sourced from `crawler_events_hourly` and
 * `ai_referral_events_hourly` populated by the traffic-sync pipeline.
 *
 * Headline framing: "AI Visibility — Server-Side" (parallels "AI Citations").
 *
 * Section is null when the project has no traffic source connected at all.
 * When `hasData=false`, a source is connected but no events have synced yet
 * (different empty state from "no source").
 */
export const serverActivitySectionSchema = z.object({
  /** ISO8601 inclusive lower bound of the report window (default: 7 days). */
  windowStart: z.string(),
  /** ISO8601 inclusive upper bound. */
  windowEnd: z.string(),
  hasData: z.boolean(),

  /** Last-7d total verified crawler hits, with prior 7d for delta. */
  verifiedCrawlerHits: z.object({ current: z.number(), prior: z.number(), deltaPct: z.number().nullable() }),
  /** Last-7d total unverified crawler hits, separated from verified trust metrics. */
  unverifiedCrawlerHits: z.object({ current: z.number(), prior: z.number(), deltaPct: z.number().nullable() }),
  /** Last-7d AI-referral sessions (sessionized from server-side request evidence). */
  referralArrivals: z.object({ current: z.number(), prior: z.number(), deltaPct: z.number().nullable() }),

  /** Per-AI-operator breakdown (OpenAI, Anthropic, Google AI, Perplexity, …). */
  byOperator: z.array(z.object({
    operator: z.string(),
    verifiedHits: z.number(),
    /** Shown to agency audience only — claimed-bot UA, rDNS not confirmed. */
    unverifiedHits: z.number(),
    referralArrivals: z.number(),
    deltaPct: z.number().nullable(),
  })),

  /**
   * Top crawled paths (verified only, last-7d). Path-level citation cross-reference
   * is intentionally NOT included today — the citation store is domain-grain
   * (`query_snapshots.cited_domains` is a JSON array of hostnames), so a path-level
   * "cited?" flag would be misleading. A future iteration that lands URL-grain
   * citation evidence can extend this entry with a `citationState` field without
   * breaking the contract.
   */
  topCrawledPaths: z.array(z.object({
    path: z.string(),
    verifiedHits: z.number(),
    /** How many distinct AI operators crawled this path in the window. */
    distinctOperators: z.number(),
  })),

  /** AI products that sent ≥1 session in the window (referral by destination). */
  referralProducts: z.array(z.object({
    product: z.string(),
    arrivals: z.number(),
    distinctLandingPaths: z.number(),
  })),

  /** Daily trend, last 14d for sparkline / chart rendering. */
  dailyTrend: z.array(z.object({
    date: z.string(),
    verifiedCrawlerHits: z.number(),
    referralArrivals: z.number(),
  })),

  /**
   * Top landing paths for AI-referral sessions (last-7d).
   * Complements `topCrawledPaths` (what bots fetch) with what humans actually land on.
   */
  topReferralLandingPaths: z.array(z.object({
    path: z.string(),
    arrivals: z.number(),
    distinctProducts: z.number(),
  })),
})

export type ServerActivitySection = z.infer<typeof serverActivitySectionSchema>

export const indexingHealthSectionSchema = z.object({
  /** Source: 'google' | 'bing' | null when neither is connected. */
  provider: z.enum(['google', 'bing']).nullable(),
  total: z.number(),
  indexed: z.number(),
  notIndexed: z.number(),
  /** Google-only — pages explicitly marked as deindexed. Bing reports 'unknown' instead. */
  deindexed: z.number(),
  /** Bing-only — pages with no inspection data yet. */
  unknown: z.number(),
  /** 0..100. */
  indexedPct: z.number(),
})

export type IndexingHealthSection = z.infer<typeof indexingHealthSectionSchema>

export const citationsTrendPointSchema = z.object({
  /** Run ID — anchor for cross-section linking. */
  runId: z.string(),
  /** ISO timestamp when the run finished (or createdAt fallback). */
  date: z.string(),
  /**
   * 0..100 — same per-query unique-cited definition as
   * `ReportExecutiveSummary.citationRate`. Stable across runs with different
   * provider counts so the trend line measures real movement rather than
   * provider-count variance.
   */
  citationRate: z.number(),
  /** Numerator of `citationRate` for this run. */
  citedQueryCount: z.number(),
  /** Denominator of `citationRate` for this run. */
  totalQueryCount: z.number(),
  /** 0..100 — same per-query unique-mentioned definition as `ReportExecutiveSummary.mentionRate`. */
  mentionRate: z.number(),
  /** Numerator of `mentionRate` for this run. */
  mentionedQueryCount: z.number(),
  /**
   * Per-provider rates for the same run. Each provider's rate is per-pair
   * within that provider (`cited / scanned`), so it remains comparable
   * between providers in the same run.
   */
  providerRates: z.array(z.object({ provider: z.string(), citationRate: z.number() })),
})

export type CitationsTrendPoint = z.infer<typeof citationsTrendPointSchema>

export const reportInsightSchema = z.object({
  id: z.string(),
  type: z.enum(['regression', 'gain', 'opportunity']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string(),
  query: z.string(),
  provider: z.string(),
  recommendation: z.string().nullable(),
  createdAt: z.string(),
  /**
   * How many times this insight fired across recent runs for the same
   * `(query, provider, type)` tuple. Always ≥ 1. Insights returned by the
   * report API are already deduped to one row per tuple, with this counter
   * surfacing the multiplicity. Use it directly instead of grouping again
   * client-side — counts derived from raw insight rows will overcount.
   */
  instanceCount: z.number(),
})

export type ReportInsight = z.infer<typeof reportInsightSchema>

export const recommendedNextStepSchema = z.object({
  /** 'immediate' | 'short-term' | 'medium-term' — bucketed by severity heuristic. */
  horizon: z.enum(['immediate', 'short-term', 'medium-term']),
  title: z.string(),
  rationale: z.string(),
})

export type RecommendedNextStep = z.infer<typeof recommendedNextStepSchema>

/**
 * "What's changed" — the trend-focused act of the report. Pre-computed
 * deltas between the latest run/period and the prior one. Renderers must
 * not recompute these from `citationsTrend` etc. — read them directly.
 *
 * `enoughHistory: false` means there is not enough run/trend data to compute
 * meaningful deltas; renderers should fall back to a baseline message.
 */
export const reportRateDeltaSchema = z.object({
  /** Current value (0..100 for rates, raw count otherwise). When `window`
   *  is present this is the average over the last `window` checks. */
  current: z.number(),
  /** Prior value compared against. When `window` is present this is the
   *  average over the prior `window` checks before that. */
  prior: z.number(),
  /** Absolute delta (current − prior). Negative = decrease. */
  deltaAbs: z.number(),
  /**
   * Direction tag for tone mapping. Threshold is metric-specific (3pp for
   * rates, 0.5 for counts) so small noise lands as 'flat' rather than
   * flipping up/down each run.
   */
  direction: z.enum(['up', 'down', 'flat']),
  /**
   * How many points went into each side of the average. Omitted (or 1)
   * means point-to-point (legacy "since last check"). Higher values mean
   * a rolling-average comparison — renderers should label it as
   * "vs prior N checks" when this is ≥ 2.
   */
  window: z.number().optional(),
})

export type ReportRateDelta = z.infer<typeof reportRateDeltaSchema>

export const reportProviderMovementSchema = z.object({
  provider: z.string(),
  current: z.number(),
  prior: z.number(),
  deltaAbs: z.number(),
  direction: z.enum(['up', 'down', 'flat']),
})

export type ReportProviderMovement = z.infer<typeof reportProviderMovementSchema>

export const whatsChangedSectionSchema = z.object({
  /**
   * False when there's no prior run (or fewer than the trend baseline),
   * meaning all per-metric deltas will be null. Renderers use this to swap
   * in a "establishing baseline" fallback rather than rendering empty
   * delta tiles.
   */
  enoughHistory: z.boolean(),
  /**
   * One-sentence narrative summary suitable as a section subtitle.
   * Always present — even on baseline, narrates whatever signal exists.
   */
  headline: z.string(),
  /** Citation rate delta vs the prior completed run. Null when no prior run. */
  citationRate: reportRateDeltaSchema.nullable(),
  /** Mention rate delta vs the prior completed run. Null when no prior run. */
  mentionRate: reportRateDeltaSchema.nullable(),
  /** Cited query count delta vs the prior completed run. Null when no prior run. */
  citedQueryCount: reportRateDeltaSchema.nullable(),
  /**
   * GSC clicks delta — last 14 days of `gsc.trend` vs the 14 days before
   * that. Null when GSC isn't connected or fewer than 28 trend points exist.
   */
  gscClicksDelta: reportRateDeltaSchema.nullable(),
  /**
   * AI referral sessions delta — last 14 days of `aiReferrals.trend` vs the
   * 14 days before that. Null when AI referrals aren't tracked or fewer
   * than 28 trend points exist.
   */
  aiReferralsDelta: reportRateDeltaSchema.nullable(),
  /**
   * Per-provider citation rate movements (latest run vs prior run). Empty
   * when no prior run. Sorted by |deltaAbs| desc — providers with the
   * biggest swing first.
   */
  providerMovements: z.array(reportProviderMovementSchema),
  /**
   * Top wins this period — gains surfaced by the intelligence engine.
   * Capped at 5; sourced from `insights` filtered to `type: 'gain'`.
   */
  wins: z.array(reportInsightSchema),
  /**
   * Top regressions this period — citations or mentions lost. Capped at 5;
   * sourced from `insights` filtered to `type: 'regression'`.
   */
  regressions: z.array(reportInsightSchema),
})

export type WhatsChangedSection = z.infer<typeof whatsChangedSectionSchema>

export const reportAudienceSchema = z.enum(['agency', 'client'])
export type ReportAudience = z.infer<typeof reportAudienceSchema>

export const reportActionAudienceSchema = z.enum(['agency', 'client', 'both'])
export type ReportActionAudience = z.infer<typeof reportActionAudienceSchema>

export const reportActionHorizonSchema = z.enum(['immediate', 'short-term', 'medium-term'])
export type ReportActionHorizon = z.infer<typeof reportActionHorizonSchema>

export const reportActionConfidenceSchema = z.enum(['high', 'medium', 'low'])
export type ReportActionConfidence = z.infer<typeof reportActionConfidenceSchema>

export const reportToneSchema = z.enum(['positive', 'caution', 'negative', 'neutral'])
export type ReportTone = z.infer<typeof reportToneSchema>

export const reportActionCategorySchema = z.enum([
  'content',
  'competitors',
  'provider',
  'search-demand',
  'indexing',
  'location',
  'monitoring',
])
export type ReportActionCategory = z.infer<typeof reportActionCategorySchema>

export const reportActionPlanItemSchema = z.object({
  /** Which report audience should see this action. `both` renders in both modes. */
  audience: reportActionAudienceSchema,
  /** Stable sort priority. Lower numbers render earlier. */
  priority: z.number(),
  /** When this should be tackled. */
  horizon: reportActionHorizonSchema,
  category: reportActionCategorySchema,
  title: z.string(),
  /** Direct next step written as an operator/client-friendly imperative. */
  action: z.string(),
  /** Why this matters. Keep each entry concise and evidence-backed. */
  why: z.array(z.string()),
  /** Specific observations that justify the action. */
  evidence: z.array(z.string()),
  /** What should move if the action worked. */
  successMetric: z.string(),
  /** Confidence in the recommendation based on the available evidence. */
  confidence: reportActionConfidenceSchema,
})

export type ReportActionPlanItem = z.infer<typeof reportActionPlanItemSchema>

export const reportClientSummarySchema = z.object({
  headline: z.string(),
  overview: z.string(),
  actionItems: z.array(reportActionPlanItemSchema),
  confidenceNotes: z.array(z.string()),
})

export type ReportClientSummary = z.infer<typeof reportClientSummarySchema>

export const reportAgencyDiagnosticSchema = z.object({
  title: z.string(),
  detail: z.string(),
  severity: z.enum(['positive', 'caution', 'negative', 'neutral']),
  evidence: z.array(z.string()),
})

export type ReportAgencyDiagnostic = z.infer<typeof reportAgencyDiagnosticSchema>

export const reportAgencyDiagnosticsSchema = z.object({
  priorities: z.array(reportActionPlanItemSchema),
  diagnostics: z.array(reportAgencyDiagnosticSchema),
})

export type ReportAgencyDiagnostics = z.infer<typeof reportAgencyDiagnosticsSchema>

export function reportActionTone(
  action: Pick<ReportActionPlanItem, 'horizon' | 'confidence'>,
): ReportTone {
  if (action.horizon === 'immediate') return 'negative'
  if (action.confidence === 'high') return 'caution'
  if (action.confidence === 'low') return 'neutral'
  return 'caution'
}

/**
 * Human-readable labels for enum values that appear in the report DTO. The
 * underlying field values (e.g. `'short-term'`, `'add-schema'`) are stable
 * identifiers used for routing, sorting, and tone — never render them
 * directly to the UI. Always run them through these helpers so titles,
 * badges, and summaries read like prose.
 */
export function reportSeverityLabel(severity: ReportInsight['severity']): string {
  switch (severity) {
    case 'critical': return 'Critical'
    case 'high': return 'High'
    case 'medium': return 'Medium'
    case 'low': return 'Low'
  }
}

export function reportHorizonLabel(horizon: ReportActionHorizon): string {
  switch (horizon) {
    case 'immediate': return 'Immediate'
    case 'short-term': return 'Short term'
    case 'medium-term': return 'Medium term'
  }
}

export function reportActionCategoryLabel(category: ReportActionCategory): string {
  switch (category) {
    case 'content': return 'Content'
    case 'competitors': return 'Competitors'
    case 'provider': return 'Provider'
    case 'search-demand': return 'Search demand'
    case 'indexing': return 'Indexing'
    case 'location': return 'Location'
    case 'monitoring': return 'Monitoring'
  }
}

export function reportConfidenceLabel(confidence: ReportActionConfidence): string {
  switch (confidence) {
    case 'high': return 'High'
    case 'medium': return 'Medium'
    case 'low': return 'Low'
  }
}

export const projectReportDtoSchema = z.object({
  meta: reportMetaSchema,
  executiveSummary: reportExecutiveSummarySchema,
  citationScorecard: citationScorecardSchema,
  competitorLandscape: competitorLandscapeSchema,
  mentionLandscape: mentionLandscapeSchema,
  aiSourceOrigin: aiSourceOriginSchema,
  gsc: gscSectionSchema.nullable(),
  ga: gaTrafficSectionSchema.nullable(),
  socialReferrals: socialReferralSectionSchema.nullable(),
  aiReferrals: aiReferralSectionSchema.nullable(),
  /** Server-side log-evidence visibility (crawls + click-through sessions). Null when no traffic source connected. */
  serverActivity: serverActivitySectionSchema.nullable(),
  indexingHealth: indexingHealthSectionSchema.nullable(),
  citationsTrend: z.array(citationsTrendPointSchema),
  /**
   * Trend-focused "what's changed" summary for the report's act 2. Always
   * present; renderers gate empty/baseline states via `enoughHistory`.
   */
  whatsChanged: whatsChangedSectionSchema,
  insights: z.array(reportInsightSchema),
  recommendedNextSteps: z.array(recommendedNextStepSchema),
  /** Canonical structured actions shared by the client and agency render modes. */
  actionPlan: z.array(reportActionPlanItemSchema),
  /** Polished client-facing summary and action shortlist. */
  clientSummary: reportClientSummarySchema,
  /** Technical, evidence-oriented operator diagnostics for agency mode. */
  agencyDiagnostics: reportAgencyDiagnosticsSchema,
  /**
   * Ranked, action-typed content opportunities sourced from the existing
   * intelligence layer (`buildContentTargetRows`). Empty when no run has
   * produced candidate queries with demand or competitor signal.
   */
  contentOpportunities: z.array(contentTargetRowDtoSchema),
  /**
   * Queries where competitors were cited but the project was not. Sourced
   * from `buildContentGapRows`. Empty until the first answer-visibility run.
   */
  contentGaps: z.array(contentGapRowDtoSchema),
  /**
   * Per-query grounding source map (own + competitor cited URLs). Sourced
   * from `buildContentSourceRows`. Empty until the first answer-visibility run.
   */
  groundingSources: z.array(contentSourceRowDtoSchema),
})

export type ProjectReportDto = z.infer<typeof projectReportDtoSchema>
