import { z } from 'zod'
import { groundingSourceSchema } from './run.js'

export const snapshotAccuracySchema = z.enum(['yes', 'no', 'unknown', 'not-mentioned'])
export type SnapshotAccuracy = z.infer<typeof snapshotAccuracySchema>

const snapshotQueryListSchema = z.array(z.string().min(1))

export const snapshotRequestSchema = z.object({
  companyName: z.string().min(1),
  domain: z.string().min(1),
  queries: snapshotQueryListSchema.optional(),
  phrases: snapshotQueryListSchema.optional(),
  competitors: z.array(z.string().min(1)).optional().default([]),
}).superRefine((input, ctx) => {
  if (input.queries !== undefined && input.phrases !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Use queries; phrases is accepted only as a legacy alias when queries is omitted',
      path: ['phrases'],
    })
  }
})

export type SnapshotRequestDto = z.infer<typeof snapshotRequestSchema>

export function resolveSnapshotRequestQueries(input: { queries?: string[]; phrases?: string[] }): string[] {
  return input.queries ?? input.phrases ?? []
}

export const snapshotCompetitorEntrySchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
})

export type SnapshotCompetitorEntryDto = z.infer<typeof snapshotCompetitorEntrySchema>

export const snapshotAuditFactorSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number(),
  score: z.number(),
  findings: z.array(z.object({
    type: z.string(),
    message: z.string(),
  })).default([]),
  recommendations: z.array(z.string()).default([]),
})

export type SnapshotAuditFactorDto = z.infer<typeof snapshotAuditFactorSchema>

export const snapshotAuditSchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  auditedAt: z.string(),
  overallScore: z.number(),
  summary: z.string(),
  factors: z.array(snapshotAuditFactorSchema).default([]),
})

export type SnapshotAuditDto = z.infer<typeof snapshotAuditSchema>

export const snapshotProfileSchema = z.object({
  industry: z.string(),
  summary: z.string(),
  services: z.array(z.string()).default([]),
  categoryTerms: z.array(z.string()).default([]),
})

export type SnapshotProfileDto = z.infer<typeof snapshotProfileSchema>

export const snapshotProviderResultSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  model: z.string().nullable().optional(),
  mentioned: z.boolean(),
  cited: z.boolean(),
  describedAccurately: snapshotAccuracySchema,
  accuracyNotes: z.string().nullable().optional(),
  incorrectClaims: z.array(z.string()).default([]),
  recommendedCompetitors: z.array(z.string()).default([]),
  citedDomains: z.array(z.string()).default([]),
  groundingSources: z.array(groundingSourceSchema).default([]),
  searchQueries: z.array(z.string()).default([]),
  answerText: z.string(),
  error: z.string().nullable().optional(),
})

export type SnapshotProviderResultDto = z.infer<typeof snapshotProviderResultSchema>

export const snapshotQueryResultSchema = z.object({
  query: z.string(),
  providerResults: z.array(snapshotProviderResultSchema).default([]),
})

export type SnapshotQueryResultDto = z.infer<typeof snapshotQueryResultSchema>

export const snapshotSummarySchema = z.object({
  totalQueries: z.number().int().nonnegative(),
  totalProviders: z.number().int().nonnegative(),
  totalComparisons: z.number().int().nonnegative(),
  mentionCount: z.number().int().nonnegative(),
  citationCount: z.number().int().nonnegative(),
  topCompetitors: z.array(snapshotCompetitorEntrySchema).default([]),
  visibilityGap: z.string(),
  whatThisMeans: z.array(z.string()).default([]),
  recommendedActions: z.array(z.string()).default([]),
})

export type SnapshotSummaryDto = z.infer<typeof snapshotSummarySchema>

export const snapshotReportSchema = z.object({
  companyName: z.string(),
  domain: z.string(),
  homepageUrl: z.string(),
  generatedAt: z.string(),
  queries: z.array(z.string()).default([]),
  competitors: z.array(z.string()).default([]),
  profile: snapshotProfileSchema,
  audit: snapshotAuditSchema,
  queryResults: z.array(snapshotQueryResultSchema).default([]),
  summary: snapshotSummarySchema,
})

export type SnapshotReportDto = z.infer<typeof snapshotReportSchema>
