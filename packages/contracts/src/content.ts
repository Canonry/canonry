import { z } from 'zod'

import { providerNameSchema } from './provider.js'

// ─── Enums ───────────────────────────────────────────────────────────────────

export const contentActionSchema = z.enum(['create', 'expand', 'refresh', 'add-schema'])
export type ContentAction = z.infer<typeof contentActionSchema>
export const ContentActions = contentActionSchema.enum

/** Title-cased label for `ContentAction` — never render the raw enum to UI. */
export function contentActionLabel(action: ContentAction): string {
  switch (action) {
    case 'create': return 'Create'
    case 'expand': return 'Expand'
    case 'refresh': return 'Refresh'
    case 'add-schema': return 'Add schema'
  }
}

export const demandSourceSchema = z.enum(['gsc', 'competitor-evidence', 'both'])
export type DemandSource = z.infer<typeof demandSourceSchema>
export const DemandSources = demandSourceSchema.enum

export const actionConfidenceSchema = z.enum(['high', 'medium', 'low'])
export type ActionConfidence = z.infer<typeof actionConfidenceSchema>
export const ActionConfidences = actionConfidenceSchema.enum

/** Title-cased label for `ActionConfidence` — never render the raw enum to UI. */
export function actionConfidenceLabel(confidence: ActionConfidence): string {
  switch (confidence) {
    case 'high': return 'High'
    case 'medium': return 'Medium'
    case 'low': return 'Low'
  }
}

export const pageTypeSchema = z.enum([
  'blog-post',
  'comparison',
  'listicle',
  'how-to',
  'guide',
  'glossary',
])
export type PageType = z.infer<typeof pageTypeSchema>
export const PageTypes = pageTypeSchema.enum

export const contentActionStateSchema = z.enum([
  'proposed',
  'briefed',
  'payload-generated',
  'draft-created',
  'published',
  'validated',
  'dismissed',
])
export type ContentActionState = z.infer<typeof contentActionStateSchema>
export const ContentActionStates = contentActionStateSchema.enum

// ─── Shared sub-shapes ───────────────────────────────────────────────────────

const ourBestPageSchema = z.object({
  url: z.string(),
  gscImpressions: z.number().nonnegative(),
  gscClicks: z.number().nonnegative(),
  // Null when the page came from the inventory fallback (no GSC ranking data).
  gscAvgPosition: z.number().nonnegative().nullable(),
  organicSessions: z.number().nonnegative(),
})

const winningCompetitorSchema = z.object({
  domain: z.string(),
  url: z.string(),
  title: z.string(),
  citationCount: z.number().int().nonnegative(),
})

const scoreBreakdownSchema = z.object({
  demand: z.number(),
  competitor: z.number(),
  absence: z.number(),
  gapSeverity: z.number(),
})

const existingActionRefSchema = z.object({
  actionId: z.string(),
  state: contentActionStateSchema,
  lastUpdated: z.string(),
})

// ─── ContentTargetRowDto ─────────────────────────────────────────────────────

export const contentTargetRowDtoSchema = z.object({
  targetRef: z.string(),
  query: z.string(),
  action: contentActionSchema,
  ourBestPage: ourBestPageSchema.nullable(),
  winningCompetitor: winningCompetitorSchema.nullable(),
  score: z.number(),
  scoreBreakdown: scoreBreakdownSchema,
  drivers: z.array(z.string()),
  demandSource: demandSourceSchema,
  actionConfidence: actionConfidenceSchema,
  existingAction: existingActionRefSchema.nullable(),
})

export type ContentTargetRowDto = z.infer<typeof contentTargetRowDtoSchema>

export const contentTargetsResponseDtoSchema = z.object({
  targets: z.array(contentTargetRowDtoSchema),
  contextMetrics: z.object({
    totalAiReferralSessions: z.number().int().nonnegative(),
    latestRunId: z.string(),
    runTimestamp: z.string(),
  }),
})

export type ContentTargetsResponseDto = z.infer<typeof contentTargetsResponseDtoSchema>

// ─── Content target dismissals ──────────────────────────────────────────────
//
// Manual "mark addressed" affordance for content opportunities. Recommendations
// are recomputed on every report load from live GSC/GA inventory; a dismissal
// row drops the matching recommendation from the report until explicitly
// un-dismissed. See `packages/db/src/schema.ts → contentTargetDismissals` and
// the AGENTS.md "Report parity" rule.

export const contentTargetDismissalDtoSchema = z.object({
  targetRef: z.string(),
  addressedUrl: z.string().nullable(),
  note: z.string().nullable(),
  dismissedAt: z.string(),
})

export type ContentTargetDismissalDto = z.infer<typeof contentTargetDismissalDtoSchema>

export const contentTargetDismissalsResponseDtoSchema = z.object({
  dismissals: z.array(contentTargetDismissalDtoSchema),
})

export type ContentTargetDismissalsResponseDto = z.infer<typeof contentTargetDismissalsResponseDtoSchema>

export const contentTargetDismissRequestSchema = z.object({
  targetRef: z.string().min(1),
  /** URL of the page the user wrote that addresses this recommendation. Stored verbatim for the audit trail; not currently used to suppress the slug-token matcher. */
  addressedUrl: z.string().url().optional(),
  /** Free-form note (e.g. "covered in our Q1 content sprint"). 500 char cap is the API surface limit; the DB column is unbounded. */
  note: z.string().max(500).optional(),
})

export type ContentTargetDismissRequest = z.infer<typeof contentTargetDismissRequestSchema>

// ─── Recommendation explanations (LLM rationale per card) ──────────────────
//
// Phase 1 of the LLM-augmented recommendation engine. The heuristic
// classifier produces the structured recommendation; an on-demand LLM
// call ("Why this?" button in the UI) explains the reasoning and
// suggests concrete next steps in natural language. Cached per
// (project, target_ref, prompt_version) so repeat clicks are free.

export const recommendationExplanationDtoSchema = z.object({
  targetRef: z.string(),
  /** Version of the prompt template used. Bumping the version invalidates the cache forward without touching the table. */
  promptVersion: z.string(),
  /** Provider that produced the explanation (e.g. "claude", "gemini"). */
  provider: z.string(),
  /** Model id within that provider (e.g. "claude-sonnet-4-6"). */
  model: z.string(),
  /** Markdown-formatted rationale + recommended next steps. */
  responseText: z.string(),
  /** Estimated cost in millicents (1/100 of a cent). 0 when unknown. */
  costMillicents: z.number().int().nonnegative(),
  generatedAt: z.string(),
})

export type RecommendationExplanationDto = z.infer<typeof recommendationExplanationDtoSchema>

export const recommendationExplainRequestSchema = z.object({
  /**
   * Optional provider override (e.g. "claude" to force Claude even if
   * the project's default is Gemini). Falls through to project default
   * → auto-detect when omitted.
   */
  provider: z.string().optional(),
  /**
   * Optional model override within the chosen provider. Falls through to
   * the `analyze`-tier default model when omitted.
   */
  model: z.string().optional(),
  /**
   * Force a fresh LLM call even if a cached explanation exists for the
   * current prompt version. Use sparingly — defeats the cache.
   */
  forceRefresh: z.boolean().optional(),
})

export type RecommendationExplainRequest = z.infer<typeof recommendationExplainRequestSchema>

// ─── ContentSources ──────────────────────────────────────────────────────────

const contentGroundingSourceSchema = z.object({
  uri: z.string(),
  title: z.string(),
  domain: z.string(),
  isOurDomain: z.boolean(),
  isCompetitor: z.boolean(),
  citationCount: z.number().int().nonnegative(),
  providers: z.array(providerNameSchema),
})

export const contentSourceRowDtoSchema = z.object({
  query: z.string(),
  groundingSources: z.array(contentGroundingSourceSchema),
})

export type ContentSourceRowDto = z.infer<typeof contentSourceRowDtoSchema>

export const contentSourcesResponseDtoSchema = z.object({
  sources: z.array(contentSourceRowDtoSchema),
  latestRunId: z.string(),
})

export type ContentSourcesResponseDto = z.infer<typeof contentSourcesResponseDtoSchema>

// ─── ContentGaps ─────────────────────────────────────────────────────────────

export const contentGapRowDtoSchema = z.object({
  query: z.string(),
  competitorDomains: z.array(z.string()),
  competitorCount: z.number().int().nonnegative(),
  missRate: z.number().min(0).max(1),
  lastSeenInRunId: z.string(),
})

export type ContentGapRowDto = z.infer<typeof contentGapRowDtoSchema>

export const contentGapsResponseDtoSchema = z.object({
  gaps: z.array(contentGapRowDtoSchema),
  latestRunId: z.string(),
})

export type ContentGapsResponseDto = z.infer<typeof contentGapsResponseDtoSchema>
