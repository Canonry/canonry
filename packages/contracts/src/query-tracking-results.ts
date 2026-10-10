import { z } from 'zod'
import { queryTrackingModeSchema } from './query-tracking.js'
import { RunStatuses } from './run.js'
import { visibilityReportPopulationClassSchema, visibilityReportScopeKindSchema } from './visibility-report.js'

/**
 * Engine results for every tracked query in one read: was a covered location
 * mentioned in the answer text, and was one cited in the answer's sources.
 * The two are separate signals and neither is ever computed from the other.
 * Branded and non-brand results of one query are separate rows, never pooled.
 */

const nonBlankIdSchema = z.string().trim().min(1)
const countSchema = z.number().int().nonnegative()

const queryTrackingResultsRequestShape = {
  /** The place whose pairings are read. Resolved against the active plan. */
  scope: visibilityReportScopeKindSchema.default('project'),
  scopeKey: nonBlankIdSchema.optional(),
  /** One completed or partial whole-project sweep. Omit for the default sweep. */
  runId: nonBlankIdSchema.optional(),
}

/** Plain serializable wire schema used by MCP and generated clients. */
export const queryTrackingResultsRequestSchema = z.object(queryTrackingResultsRequestShape).strict().superRefine((value, ctx) => {
  if (value.scope !== 'project' && value.scopeKey === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeKey'], message: `scopeKey is required for ${value.scope} scope` })
  }
  if (value.scope === 'project' && value.scopeKey !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeKey'], message: 'scopeKey is not valid for project scope' })
  }
})
export type QueryTrackingResultsRequest = z.input<typeof queryTrackingResultsRequestSchema>
export type QueryTrackingResultsQuery = z.output<typeof queryTrackingResultsRequestSchema>

/**
 * One engine's result for one query and class in the place. A count never
 * stands in for the other signal: `mentionedAnswers` reads answer text,
 * `citedAnswers` reads sources.
 */
export const queryTrackingEngineResultSchema = z.object({
  provider: nonBlankIdSchema,
  /** Answers the sweep asked this engine for: one per search location the row is asked at. */
  expectedAnswers: countSchema,
  /** Answers saved, the base of both counts. */
  answers: countSchema,
  /** Saved answers whose text names a location the row covers in the place. */
  mentionedAnswers: countSchema,
  /** Saved answers with fully saved sources that cite a location the row covers in the place. */
  citedAnswers: countSchema,
  /** Saved answers whose sources were only partly saved. They are in neither side of the cited count. */
  uncheckedSourceAnswers: countSchema,
  /** True when any answer mentions it, false when every expected answer was checked and none did, else null (not checked). */
  mentioned: z.boolean().nullable(),
  /** The same rule over sources. Null is not checked, never no. */
  cited: z.boolean().nullable(),
}).strict()
export type QueryTrackingEngineResult = z.output<typeof queryTrackingEngineResultSchema>

export const queryTrackingResultRowSchema = z.object({
  queryId: nonBlankIdSchema,
  /** The text the sweep asked, which is the text tracked now. */
  queryText: z.string().trim().min(1),
  /** A class the workspace row carries in `queryClasses`, or `unknown` when it carries none. */
  queryClass: visibilityReportPopulationClassSchema,
  /** One entry per engine the sweep asked for this row, sorted by provider. */
  engines: z.array(queryTrackingEngineResultSchema),
}).strict()
export type QueryTrackingResultRow = z.output<typeof queryTrackingResultRowSchema>

export const queryTrackingResultsRunSchema = z.object({
  id: nonBlankIdSchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  status: z.enum([RunStatuses.completed, RunStatuses.partial]),
  /** The plan revision the sweep ran with; null for a simple project. */
  revision: z.number().int().positive().nullable(),
  /**
   * False when tracking changed after this sweep, so some pairings may have no
   * row until the next one. A label-only republish keeps it true.
   */
  matchesCurrentTracking: z.boolean(),
}).strict()
export type QueryTrackingResultsRun = z.output<typeof queryTrackingResultsRunSchema>

export const queryTrackingResultsResponseSchema = z.object({
  mode: queryTrackingModeSchema,
  /** The place read. `key` is null for the whole project. */
  scope: z.object({
    kind: visibilityReportScopeKindSchema,
    key: nonBlankIdSchema.nullable(),
  }).strict(),
  /** The sweep read; null when no whole-project sweep has finished. */
  run: queryTrackingResultsRunSchema.nullable(),
  /** Every engine that sweep asked, sorted. Empty with no sweep. */
  engines: z.array(nonBlankIdSchema),
  /**
   * One row per query and class whose every pairing in the place was asked by
   * the sweep exactly as it is asked now. A query moved, re-typed or reworded
   * since has no row until the next sweep.
   */
  rows: z.array(queryTrackingResultRowSchema),
  /** Query and class pairs asked in the place now that the sweep did not measure. */
  pendingRows: countSchema,
}).strict()
export type QueryTrackingResultsResponse = z.output<typeof queryTrackingResultsResponseSchema>
