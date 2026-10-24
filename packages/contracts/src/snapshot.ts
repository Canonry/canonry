import { z } from 'zod'
import { answerEvidenceSchema } from './answer-evidence.js'
import { groundingSourceSchema } from './run.js'

export const snapshotProviderModeSchema = z.enum(['all', 'api', 'browser'])
export const SnapshotProviderModes = snapshotProviderModeSchema.enum

export const snapshotAccuracySchema = z.enum(['yes', 'no', 'unknown', 'not-mentioned'])
export type SnapshotAccuracy = z.infer<typeof snapshotAccuracySchema>

const snapshotQueryListSchema = z.array(z.string().min(1))

export const snapshotRequestInputSchema = z.object({
  companyName: z.string().min(1),
  domain: z.string().min(1),
  queries: snapshotQueryListSchema.optional(),
  phrases: snapshotQueryListSchema.optional(),
  competitors: z.array(z.string().min(1)).optional(),
  providers: z.array(z.string().trim().min(1)).min(1).optional()
    .describe('Configured provider names to use for both answers and analysis. Omit to use all providers matching providerMode.'),
  providerMode: snapshotProviderModeSchema.optional()
    .describe('Filter providers by transport; defaults to all. Browser-only selection requires manual queries and uses no API provider for analysis.'),
}).superRefine((input, ctx) => {
  if (input.queries !== undefined && input.phrases !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Use queries; phrases is accepted only as a legacy alias when queries is omitted',
      path: ['phrases'],
    })
  }
})

export const snapshotRequestSchema = snapshotRequestInputSchema.safeExtend({
  competitors: snapshotRequestInputSchema.shape.competitors.default([]),
})

export type SnapshotRequestDto = z.infer<typeof snapshotRequestSchema>
export type SnapshotRequestInput = z.input<typeof snapshotRequestSchema>

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
  /** Vendor-neutral answer evidence (answer services); absent for answer engines. */
  evidence: answerEvidenceSchema.nullable().optional(),
  /** False when the provider's sources are not tied to its answer, so `cited` was not measured. */
  citationMeasured: z.boolean().optional(),
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
  /** Successful responses whose citation was measured and found the domain cited; read against `citationComparisons`. */
  citationCount: z.number().int().nonnegative(),
  /**
   * Successful responses whose citation could be measured: the denominator of
   * `citationCount`. Lower than `totalComparisons` when a provider's sources
   * are not tied to its answer, so those answers are neither cited nor not
   * cited. Absent on reports made before it existed (read `totalComparisons`).
   */
  citationComparisons: z.number().int().nonnegative().optional(),
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
