import { z } from 'zod'
import {
  competitorLandscapeScopeSchema,
  metricsWindowSchema,
  competitorLandscapeSurfaceClassSchema,
  COMPETITOR_LANDSCAPE_COUNT_UNITS,
} from './analytics.js'

export const competitorSuggestionsQuerySchema = z.object({
  window: metricsWindowSchema.optional(),
  minAnswers: z.coerce.number().int().min(1).max(1000).optional(),
  queryClass: z.enum(['non-brand', 'branded', 'all']).optional(),
  groupKey: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict()
export type CompetitorSuggestionsQuery = z.infer<typeof competitorSuggestionsQuerySchema>

export const competitorSuggestionNameSchema = z.object({
  name: z.string().trim().min(1),
  answerCount: z.number().int().nonnegative(),
  pairedAnswers: z.number().int().nonnegative(),
}).strict()

export const competitorSuggestionReasonSchema = z.enum([
  'below-min-answers',
  'not-named',
  'own-site',
  'listing-marketplace',
  'non-competitor-surface',
  'claimed-by-alias',
  'shared-host',
])
export type CompetitorSuggestionReason = z.infer<typeof competitorSuggestionReasonSchema>

export const competitorSuggestionSchema = z.object({
  domain: z.string().trim().min(1),
  label: z.string().trim().min(1),
  names: z.array(competitorSuggestionNameSchema).max(5),
  namingAnswers: z.number().int().nonnegative(),
  citingAnswers: z.number().int().nonnegative(),
  bothAnswers: z.number().int().nonnegative(),
  pairedAnswers: z.number().int().nonnegative(),
  namedByOtherNameAnswers: z.number().int().nonnegative(),
  sweeps: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  surfaceClass: competitorLandscapeSurfaceClassSchema,
  tracked: z.boolean(),
  marketKeys: z.array(z.string().trim().min(1)).optional(),
  status: z.enum(['suggested', 'tracked', 'excluded']),
  reason: competitorSuggestionReasonSchema.nullable(),
  sampleUrls: z.array(z.string().url()).max(3),
}).strict()
export type CompetitorSuggestion = z.infer<typeof competitorSuggestionSchema>

export const competitorSuggestionsResponseSchema = z.object({
  project: z.string().trim().min(1),
  window: metricsWindowSchema,
  scope: competitorLandscapeScopeSchema,
  filters: z.object({
    queryClass: z.enum(['non-brand', 'branded', 'all']),
    groupKey: z.string().nullable(),
    limit: z.number().int().positive(),
    minAnswers: z.number().int().positive(),
  }).strict(),
  thresholds: z.object({ minAnswers: z.number().int().positive() }).strict(),
  candidates: z.array(competitorSuggestionSchema),
  candidatesTotal: z.number().int().nonnegative(),
  excludedCounts: z.record(z.string(), z.number().int().nonnegative()),
  unresolvedNames: z.array(z.object({ name: z.string().trim().min(1), answerCount: z.number().int().nonnegative() }).strict()),
  evidence: z.object({
    answeredResults: z.number().int().nonnegative(),
    sourceResults: z.number().int().nonnegative(),
    excludedProbeResults: z.number().int().nonnegative(),
    excludedNonCompletedResults: z.number().int().nonnegative(),
  }).strict(),
  runCount: z.number().int().nonnegative(),
  runIds: z.array(z.string()),
  countUnits: z.object({
    answers: z.array(z.string()),
    distinctNames: z.array(z.string()),
    runs: z.array(z.string()),
  }).strict(),
  truncated: z.boolean(),
}).strict()
export type CompetitorSuggestionsResponse = z.infer<typeof competitorSuggestionsResponseSchema>

export const COMPETITOR_SUGGESTION_COUNT_UNITS = {
  ...COMPETITOR_LANDSCAPE_COUNT_UNITS,
  answers: [
    'candidates[].namingAnswers',
    'candidates[].citingAnswers',
    'candidates[].bothAnswers',
    'candidates[].pairedAnswers',
    'candidates[].names[].answerCount',
    'candidates[].names[].pairedAnswers',
    'candidates[].namedByOtherNameAnswers',
  ],
  distinctNames: ['unresolvedNames[].name'],
  runs: ['candidates[].sweeps'],
}
