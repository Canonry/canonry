import { z } from 'zod'
import { citationStateSchema, type CitationState } from './run.js'

export const citationCoverageProviderSchema = z.object({
  provider: z.string(),
  citationState: citationStateSchema,
  cited: z.boolean(),
  mentioned: z.boolean(),
  runId: z.string(),
  runCreatedAt: z.string(),
})
export type CitationCoverageProvider = z.infer<typeof citationCoverageProviderSchema>

export const citationCoverageRowSchema = z.object({
  keywordId: z.string(),
  keyword: z.string(),
  providers: z.array(citationCoverageProviderSchema),
  citedCount: z.number().int().nonnegative(),
  mentionedCount: z.number().int().nonnegative(),
  totalProviders: z.number().int().nonnegative(),
})
export type CitationCoverageRow = z.infer<typeof citationCoverageRowSchema>

export const competitorGapRowSchema = z.object({
  keywordId: z.string(),
  keyword: z.string(),
  provider: z.string(),
  citingCompetitors: z.array(z.string()),
  runId: z.string(),
  runCreatedAt: z.string(),
})
export type CompetitorGapRow = z.infer<typeof competitorGapRowSchema>

export const citationVisibilitySummarySchema = z.object({
  providersConfigured: z.number().int().nonnegative(),
  providersCiting: z.number().int().nonnegative(),
  providersMentioning: z.number().int().nonnegative(),
  totalKeywords: z.number().int().nonnegative(),
  // Cross-tab buckets — each tracked keyword with at least one snapshot lands
  // in exactly one of these. Keywords with zero snapshots are not counted in
  // any bucket; (sum of buckets) ≤ totalKeywords.
  keywordsCitedAndMentioned: z.number().int().nonnegative(),
  keywordsCitedOnly: z.number().int().nonnegative(),
  keywordsMentionedOnly: z.number().int().nonnegative(),
  keywordsInvisible: z.number().int().nonnegative(),
  latestRunId: z.string().nullable(),
  latestRunAt: z.string().nullable(),
})
export type CitationVisibilitySummary = z.infer<typeof citationVisibilitySummarySchema>

export const citationVisibilityResponseSchema = z.object({
  summary: citationVisibilitySummarySchema,
  byKeyword: z.array(citationCoverageRowSchema),
  competitorGaps: z.array(competitorGapRowSchema),
  status: z.enum(['ready', 'no-data']),
  reason: z.enum(['no-runs-yet', 'no-keywords']).optional(),
})
export type CitationVisibilityResponse = z.infer<typeof citationVisibilityResponseSchema>

export function emptyCitationVisibility(reason: 'no-runs-yet' | 'no-keywords'): CitationVisibilityResponse {
  return {
    summary: {
      providersConfigured: 0,
      providersCiting: 0,
      providersMentioning: 0,
      totalKeywords: 0,
      keywordsCitedAndMentioned: 0,
      keywordsCitedOnly: 0,
      keywordsMentionedOnly: 0,
      keywordsInvisible: 0,
      latestRunId: null,
      latestRunAt: null,
    },
    byKeyword: [],
    competitorGaps: [],
    status: 'no-data',
    reason,
  }
}

export function citationStateToCited(state: CitationState): boolean {
  return state === 'cited'
}
