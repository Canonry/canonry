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
