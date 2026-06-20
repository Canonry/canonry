import { z } from 'zod'
import { citationStateSchema, latestProjectRunDtoSchema } from './run.js'
import type { LatestProjectRunDto } from './run.js'
import { projectDtoSchema } from './project.js'
import type { ProjectDto } from './project.js'
import type { HealthSnapshotDto, InsightDto } from './intelligence.js'

// One-call summary for "how is project X doing?". The shape stays stable so
// agents can build prompts on it without falling back to four list endpoints.
export interface ProjectOverviewQueryCountsDto {
  totalQueries: number
  citedQueries: number
  notCitedQueries: number
  citedRate: number
  // Mention is a distinct signal from cited (see AGENTS.md "Vocabulary"): a
  // query is `mentioned` when its brand/domain appears in the AI answer text
  // (`answerMentioned`) on at least one snapshot — computed independently of
  // `cited`, never derived from it. Mirrors the cited triplet above.
  mentionedQueries: number
  notMentionedQueries: number
  mentionRate: number
}

export interface ProjectOverviewProviderEntryDto {
  provider: string
  citedRate: number
  cited: number
  total: number
}

// `since` is the createdAt of the run before `latestRun`, so callers can render
// "2 of 8 queries transitioned since the previous sweep" without a second
// fetch. Null when no prior run exists.
export interface ProjectOverviewTransitionsDto {
  since: string | null
  gained: number
  lost: number
  emerging: number
}

// Tone used by the dashboard, CLI human output, and any agent rendering the
// overview. The server is the source of truth — clients map to colors/icons
// per their surface but never recompute the tone themselves.
export type MetricTone = 'positive' | 'caution' | 'negative' | 'neutral'

// One score gauge — used for visibility, gap queries, index coverage,
// competitor pressure, and run status. `value` is presentational (e.g. "67",
// "No data") so the same string renders in CLI, dashboard gauges, and report
// HTML. `progress` is the 0–100 numeric used by progress rings; absent for
// gauges that aren't ratio-based.
export interface ScoreSummaryDto {
  label: string
  value: string
  delta: string
  tone: MetricTone
  description: string
  tooltip?: string
  trend: number[]
  progress?: number
  providerCoverage?: string
}

// The score gauges shown at the top of the project page. Each is a
// `ScoreSummaryDto` so the SPA renders them with one component and the CLI
// formats them with one helper.
//
// `mention` is the dashboard's primary metric — what most operators care
// about (did the AI actually say my brand?). `visibility` is the legacy
// citation-source metric, kept as a secondary tile for analysts who track
// source-list presence.
export interface ProjectOverviewScoresDto {
  /** Primary headline gauge — % of tracked queries whose AI answer text mentioned the brand. */
  mention: ScoreSummaryDto
  /** Secondary tile — % of tracked queries whose answer cited the domain in its source list. */
  visibility: ScoreSummaryDto
  /** Mention Share — head-to-head competitive metric: of brand mentions in
   *  answer text across the run (project + tracked competitors), the % that
   *  were the project. Replaces the misleading "Share of Voice" metric. */
  mentionShare: MentionShareDto
  /** Tracked queries where a competitor is cited but the project is not. */
  gapQueries: ScoreSummaryDto
  /** Mention-side sibling of `gapQueries`: competitor surfaces in the answer but the project brand never does. */
  mentionGaps: ScoreSummaryDto
  indexCoverage: ScoreSummaryDto
  competitorPressure: ScoreSummaryDto
  runStatus: ScoreSummaryDto
}

export interface MentionShareCompetitorRowDto {
  domain: string
  mentionSnapshots: number
  /** % of competitive total — rounded to one decimal. Sums to ~100 across rows. */
  shareOfCompetitiveTotal: number
}

export interface MentionShareBreakdownDto {
  projectMentionSnapshots: number
  competitorMentionSnapshots: number
  perCompetitor: MentionShareCompetitorRowDto[]
  snapshotsWithAnswerText: number
  snapshotsTotal: number
}

/** Mention Share — `ScoreSummaryDto` plus a structured breakdown so the
 *  dashboard can render a per-competitor table without parsing prose. */
export interface MentionShareDto extends ScoreSummaryDto {
  breakdown: MentionShareBreakdownDto
}

// Gained / lost since the previous comparable run. The surrounding field name
// (`citationMovement` or `mentionMovement`) names the signal; this shared shape
// never implies one from the other.
export interface MovementSummaryDto {
  gained: number
  lost: number
  tone: MetricTone
  hasPreviousRun: boolean
  /** Query strings that newly gained the named signal. Empty when no query-text lookup was provided to the builder. */
  gainedQueries?: string[]
  /** Query strings that lost the named signal. */
  lostQueries?: string[]
}

/** Describes whether latest-vs-previous movement compares the same tracked
 *  query basket. Movement counts are always computed over the intersection of
 *  both baskets; added and removed queries are reported separately so clients
 *  never present cohort churn as a signal gain or loss. */
export interface MovementComparisonDto {
  hasPreviousRun: boolean
  /** True only when both sweeps contain the same non-empty query set. */
  comparable: boolean
  querySetChanged: boolean
  previousRunAt: string | null
  currentQueryCount: number
  previousQueryCount: number
  comparableQueryCount: number
  addedQueryCount: number
  removedQueryCount: number
  /** Added query text, sorted alphabetically. May be shorter than the count if a historical query cannot be resolved. */
  addedQueries: string[]
  /** Removed query text, sorted alphabetically. May be shorter than the count if a historical query cannot be resolved. */
  removedQueries: string[]
}

// Per-competitor row for the overview's competitor list. Distinct from the
// `competitorLandscape` shape used by the report — narrower, no per-page
// breakdown. `id` is stable across calls (uses the competitor row id when
// available, falls back to a deterministic suffix).
export interface ProjectOverviewCompetitorDto {
  id: string
  domain: string
  citationCount: number
  totalQueries: number
  pressureLabel: 'None' | 'Low' | 'Moderate' | 'High'
  citedQueries: string[]
}

// Per-(provider, model) score from the latest run. Different from
// `ProjectOverviewProviderEntryDto`, which is per-provider only.
export interface ProjectOverviewProviderScoreDto {
  provider: string
  model: string | null
  score: number
  cited: number
  total: number
  /** Per-recent-run citation rate (0-100) for this (provider, model), oldest first. Up to 12 points. Omitted when only a single run exists. */
  trend?: number[]
}

// Item in the "look at this" queue at the top of the dashboard. `href` is
// relative to the SPA's basePath; CLI consumers can ignore it.
export interface AttentionItemDto {
  id: string
  tone: MetricTone
  title: string
  detail: string
  actionLabel: string
  href: string
}

// Per-run point used for sparklines in the overview. One entry per run in
// the history window (newest first or oldest first — see endpoint docs).
// Carries both signals per run (see AGENTS.md "Vocabulary"): `cited*` counts
// queries whose answer cited the domain, `mentioned*` counts queries whose
// answer text mentioned the brand. They are independent — never derive one
// from the other — so the portfolio sparkline can track whichever the
// headline metric uses.
export interface RunHistoryPointDto {
  runId: string
  createdAt: string
  citedCount: number
  totalCount: number
  citationRate: number
  mentionedCount: number
  mentionRate: number
  status: string
}

/** One row in the "Track new queries" panel — a GSC query the project is
 *  already getting impressions for that isn't in the tracked basket yet.
 *  Pre-ranked and copy-built server-side so the dashboard, CLI, and any
 *  agent surface render the same suggestion verbatim. */
export interface SuggestedQueryDto {
  query: string
  impressions: number
  clicks: number
  avgPosition: number
  /** Operator-facing rationale ("5.0K impressions · ranks #6 on Google"). */
  reason: string
}

export interface SuggestedQueriesSummaryDto {
  rows: SuggestedQueryDto[]
  /** Eligible candidates (post-impression-floor, post-tracked-filter) before
   *  the `rows` array was truncated to the display limit. Lets the UI render
   *  "showing 10 of 47" when more suggestions exist than fit. */
  totalCandidates: number
  /** GSC queries dropped because the basket already covers them. Powers the
   *  small subtitle copy on the panel. */
  skippedAlreadyTracked: number
}

export interface ProjectOverviewDto {
  project: ProjectDto
  latestRun: LatestProjectRunDto
  health: HealthSnapshotDto | null
  topInsights: InsightDto[]
  queryCounts: ProjectOverviewQueryCountsDto
  providers: ProjectOverviewProviderEntryDto[]
  transitions: ProjectOverviewTransitionsDto

  // Phase 2 additions — populated from the same snapshot data the existing
  // fields use. All additive; older clients that only read the legacy fields
  // continue to work.
  scores: ProjectOverviewScoresDto
  /** @deprecated Citation-only alias. Read `citationMovement` in new clients. */
  movementSummary: MovementSummaryDto
  /** Query-level citation gains and losses over queries shared by both sweeps. */
  citationMovement: MovementSummaryDto
  /** Query-level answer-mention gains and losses over queries shared by both sweeps. */
  mentionMovement: MovementSummaryDto
  /** Query-basket comparability and cohort changes for both movement fields. */
  movementComparison: MovementComparisonDto
  competitors: ProjectOverviewCompetitorDto[]
  providerScores: ProjectOverviewProviderScoreDto[]
  attentionItems: AttentionItemDto[]
  runHistory: RunHistoryPointDto[]
  /** GSC queries that have impressions but aren't yet in the tracked basket.
   *  Rides on the overview DTO so the Opportunities tab and `canonry overview`
   *  render the same suggestions without a follow-up fetch. Empty when GSC
   *  isn't connected or there are no eligible candidates. */
  suggestedQueries: SuggestedQueriesSummaryDto
  dateRangeLabel: string
  contextLabel: string
}

const metricToneSchema = z.enum(['positive', 'caution', 'negative', 'neutral'])

const scoreSummarySchema = z.object({
  label: z.string(),
  value: z.string(),
  delta: z.string(),
  tone: metricToneSchema,
  description: z.string(),
  tooltip: z.string().optional(),
  trend: z.array(z.number()),
  progress: z.number().optional(),
  providerCoverage: z.string().optional(),
})

const mentionShareSchema = scoreSummarySchema.extend({
  breakdown: z.object({
    projectMentionSnapshots: z.number().int().nonnegative(),
    competitorMentionSnapshots: z.number().int().nonnegative(),
    perCompetitor: z.array(z.object({
      domain: z.string(),
      mentionSnapshots: z.number().int().nonnegative(),
      shareOfCompetitiveTotal: z.number(),
    })),
    snapshotsWithAnswerText: z.number().int().nonnegative(),
    snapshotsTotal: z.number().int().nonnegative(),
  }),
})

const movementSummarySchema = z.object({
  gained: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(),
  tone: metricToneSchema,
  hasPreviousRun: z.boolean(),
  gainedQueries: z.array(z.string()).optional(),
  lostQueries: z.array(z.string()).optional(),
})

const movementComparisonSchema = z.object({
  hasPreviousRun: z.boolean(),
  comparable: z.boolean(),
  querySetChanged: z.boolean(),
  previousRunAt: z.string().nullable(),
  currentQueryCount: z.number().int().nonnegative(),
  previousQueryCount: z.number().int().nonnegative(),
  comparableQueryCount: z.number().int().nonnegative(),
  addedQueryCount: z.number().int().nonnegative(),
  removedQueryCount: z.number().int().nonnegative(),
  addedQueries: z.array(z.string()),
  removedQueries: z.array(z.string()),
})

const projectOverviewInsightSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  type: z.enum([
    'regression',
    'gain',
    'opportunity',
    'first-citation',
    'provider-pickup',
    'persistent-gap',
    'competitor-gained',
    'competitor-lost',
    'gbp-lodging-gap',
    'gbp-listing-discrepancy',
    'gbp-cta-gap',
    'gbp-metric-drop',
    'gbp-keyword-drop',
  ]),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string(),
  query: z.string(),
  provider: z.string(),
  recommendation: z.object({
    action: z.string(),
    target: z.string().optional(),
    reason: z.string(),
  }).optional(),
  cause: z.object({
    cause: z.string(),
    competitorDomain: z.string().optional(),
    details: z.string().optional(),
  }).optional(),
  dismissed: z.boolean(),
  createdAt: z.string(),
})

const projectOverviewHealthSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  overallCitedRate: z.number(),
  overallMentionRate: z.number(),
  totalPairs: z.number().int().nonnegative(),
  citedPairs: z.number().int().nonnegative(),
  mentionedPairs: z.number().int().nonnegative(),
  providerBreakdown: z.record(z.string(), z.object({
    citedRate: z.number(),
    mentionRate: z.number(),
    cited: z.number().int().nonnegative(),
    mentioned: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })),
  createdAt: z.string(),
  status: z.enum(['ready', 'no-data']),
  reason: z.literal('no-runs-yet').optional(),
})

/** Runtime and OpenAPI schema for the agent-first composite overview. */
export const projectOverviewDtoSchema = z.object({
  project: projectDtoSchema,
  latestRun: latestProjectRunDtoSchema,
  health: projectOverviewHealthSchema.nullable(),
  topInsights: z.array(projectOverviewInsightSchema),
  queryCounts: z.object({
    totalQueries: z.number().int().nonnegative(),
    citedQueries: z.number().int().nonnegative(),
    notCitedQueries: z.number().int().nonnegative(),
    citedRate: z.number(),
    mentionedQueries: z.number().int().nonnegative(),
    notMentionedQueries: z.number().int().nonnegative(),
    mentionRate: z.number(),
  }),
  providers: z.array(z.object({
    provider: z.string(),
    citedRate: z.number(),
    cited: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })),
  transitions: z.object({
    since: z.string().nullable(),
    gained: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
    emerging: z.number().int().nonnegative(),
  }),
  scores: z.object({
    mention: scoreSummarySchema,
    visibility: scoreSummarySchema,
    mentionShare: mentionShareSchema,
    gapQueries: scoreSummarySchema,
    mentionGaps: scoreSummarySchema,
    indexCoverage: scoreSummarySchema,
    competitorPressure: scoreSummarySchema,
    runStatus: scoreSummarySchema,
  }),
  movementSummary: movementSummarySchema,
  citationMovement: movementSummarySchema,
  mentionMovement: movementSummarySchema,
  movementComparison: movementComparisonSchema,
  competitors: z.array(z.object({
    id: z.string(),
    domain: z.string(),
    citationCount: z.number().int().nonnegative(),
    totalQueries: z.number().int().nonnegative(),
    pressureLabel: z.enum(['None', 'Low', 'Moderate', 'High']),
    citedQueries: z.array(z.string()),
  })),
  providerScores: z.array(z.object({
    provider: z.string(),
    model: z.string().nullable(),
    score: z.number(),
    cited: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    trend: z.array(z.number()).optional(),
  })),
  attentionItems: z.array(z.object({
    id: z.string(),
    tone: metricToneSchema,
    title: z.string(),
    detail: z.string(),
    actionLabel: z.string(),
    href: z.string(),
  })),
  runHistory: z.array(z.object({
    runId: z.string(),
    createdAt: z.string(),
    citedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    citationRate: z.number(),
    mentionedCount: z.number().int().nonnegative(),
    mentionRate: z.number(),
    status: z.string(),
  })),
  suggestedQueries: z.object({
    rows: z.array(z.object({
      query: z.string(),
      impressions: z.number(),
      clicks: z.number(),
      avgPosition: z.number(),
      reason: z.string(),
    })),
    totalCandidates: z.number().int().nonnegative(),
    skippedAlreadyTracked: z.number().int().nonnegative(),
  }),
  dateRangeLabel: z.string(),
  contextLabel: z.string(),
}) satisfies z.ZodType<ProjectOverviewDto>

export const searchHitKindSchema = z.enum(['snapshot', 'insight'])
export type SearchHitKind = z.infer<typeof searchHitKindSchema>

export const projectSearchSnapshotHitSchema = z.object({
  kind: z.literal('snapshot'),
  id: z.string(),
  runId: z.string(),
  query: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  citationState: citationStateSchema,
  matchedField: z.enum(['answerText', 'citedDomains', 'searchQueries', 'query']),
  snippet: z.string(),
  createdAt: z.string(),
})

export type ProjectSearchSnapshotHitDto = z.infer<typeof projectSearchSnapshotHitSchema>

export const projectSearchInsightHitSchema = z.object({
  kind: z.literal('insight'),
  id: z.string(),
  runId: z.string().nullable(),
  type: z.enum([
    'regression',
    'gain',
    'opportunity',
    'first-citation',
    'provider-pickup',
    'persistent-gap',
    'competitor-gained',
    'competitor-lost',
    // Google Business Profile (local-AEO) insight types — see InsightType.
    'gbp-lodging-gap',
    'gbp-listing-discrepancy',
    'gbp-cta-gap',
    'gbp-metric-drop',
    'gbp-keyword-drop',
  ]),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string(),
  query: z.string(),
  provider: z.string(),
  matchedField: z.enum(['title', 'query', 'recommendation', 'cause']),
  snippet: z.string(),
  dismissed: z.boolean(),
  createdAt: z.string(),
})

export type ProjectSearchInsightHitDto = z.infer<typeof projectSearchInsightHitSchema>

export const projectSearchHitSchema = z.discriminatedUnion('kind', [
  projectSearchSnapshotHitSchema,
  projectSearchInsightHitSchema,
])

export type ProjectSearchHitDto = z.infer<typeof projectSearchHitSchema>

export const projectSearchResponseSchema = z.object({
  query: z.string(),
  totalHits: z.number().int().nonnegative(),
  truncated: z.boolean(),
  hits: z.array(projectSearchHitSchema),
})

export type ProjectSearchResponseDto = z.infer<typeof projectSearchResponseSchema>
