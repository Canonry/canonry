import { z } from 'zod'
import {
  citationStateSchema,
  groundingSourceSchema,
  mentionStateSchema,
  runStatusSchema,
  runTriggerSchema,
} from './run.js'

/** Download format for the historical answer-engine results export. */
export const resultsExportFormatSchema = z.enum(['json', 'csv'])
export type ResultsExportFormat = z.infer<typeof resultsExportFormatSchema>

/**
 * One persisted answer-engine observation, not a recomputed dashboard metric.
 * `answerMentioned: null` and `mentionState: null` preserve the historical
 * "not evaluated" state of legacy snapshots.
 */
export const resultsExportRecordSchema = z.object({
  runId: z.string(),
  runKind: z.literal('answer-visibility'),
  runStatus: runStatusSchema,
  runTrigger: runTriggerSchema,
  runCreatedAt: z.string(),
  runStartedAt: z.string().nullable(),
  runFinishedAt: z.string().nullable(),
  snapshotId: z.string(),
  snapshotCreatedAt: z.string(),
  /** Nullable when a tracked query was removed after this observation. */
  queryId: z.string().nullable(),
  /** Snapshot-time query text, preserving removed queries where available. */
  query: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  location: z.string().nullable(),
  citationState: citationStateSchema,
  cited: z.boolean(),
  answerMentioned: z.boolean().nullable(),
  // A union keeps OpenAPI generators from dropping `null` on this enum.
  mentionState: z.union([mentionStateSchema, z.null()]),
  citedDomains: z.array(z.string()),
  competitorOverlap: z.array(z.string()),
  recommendedCompetitors: z.array(z.string()),
  answerText: z.string().nullable(),
  groundingSources: z.array(groundingSourceSchema),
  searchQueries: z.array(z.string()),
})
export type ResultsExportRecord = z.infer<typeof resultsExportRecordSchema>

export const resultsExportFiltersSchema = z.object({
  since: z.string().nullable(),
  until: z.string().nullable(),
  includeProbes: z.boolean(),
})
export type ResultsExportFilters = z.infer<typeof resultsExportFiltersSchema>

/** Stable, portable JSON artifact behind the results export. */
export const resultsExportDtoSchema = z.object({
  schemaVersion: z.literal('canonry.results-export/v1'),
  generatedAt: z.string(),
  project: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
    canonicalDomain: z.string(),
    country: z.string(),
    language: z.string(),
  }),
  filters: resultsExportFiltersSchema,
  recordCount: z.number().int().nonnegative(),
  records: z.array(resultsExportRecordSchema),
})
export type ResultsExportDto = z.infer<typeof resultsExportDtoSchema>
