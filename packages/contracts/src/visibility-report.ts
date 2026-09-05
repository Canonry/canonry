import { z } from 'zod'

/**
 * Shared, stored-evidence visibility report.
 *
 * This is intentionally distinct from the older visibility-stats and
 * measurement-overview reads: one resolved selection owns every figure and
 * detail row in this response. A caller never recomputes a rate or joins a
 * drawer run onto an independently selected aggregate.
 */

export const visibilityReportModeSchema = z.enum(['auto', 'simple', 'advanced'])
export type VisibilityReportMode = z.output<typeof visibilityReportModeSchema>

export const visibilityReportResolvedModeSchema = z.enum(['simple', 'advanced'])
export type VisibilityReportResolvedMode = z.output<typeof visibilityReportResolvedModeSchema>

/** `all` is a request for three independent populations, never a pooled one. */
export const visibilityReportQueryClassSchema = z.enum(['branded', 'non-brand', 'unknown', 'all'])
export type VisibilityReportQueryClass = z.output<typeof visibilityReportQueryClassSchema>

export const visibilityReportPopulationClassSchema = z.enum(['branded', 'non-brand', 'unknown'])
export type VisibilityReportPopulationClass = z.output<typeof visibilityReportPopulationClassSchema>

export const visibilityReportScopeKindSchema = z.enum(['project', 'group', 'market', 'property'])
export type VisibilityReportScopeKind = z.output<typeof visibilityReportScopeKindSchema>

export const visibilityReportLocationSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('exact'), value: z.string().trim().min(1) }).strict(),
])
export type VisibilityReportLocationSelection = z.output<typeof visibilityReportLocationSelectionSchema>

function locationSelection(value: string | undefined): VisibilityReportLocationSelection {
  if (value === undefined || value === '') return { kind: 'all' }
  const normalized = value.normalize('NFKC').trim()
  if (normalized === '') return { kind: 'all' }
  return normalized.toLocaleLowerCase('en') === 'none'
    ? { kind: 'none' }
    : { kind: 'exact', value: normalized }
}

const nonBlankIdSchema = z.string().trim().min(1)
const dateTimeSchema = z.string().datetime()

/**
 * URL query contract for the single report endpoint.
 *
 * `location=none` is intentionally separate from an omitted location (all
 * execution contexts). `runId` is only an input to this response and has no
 * UI-state meaning.
 */
const visibilityReportRequestShape = {
  mode: visibilityReportModeSchema.default('auto'),
  queryClass: visibilityReportQueryClassSchema.default('non-brand'),
  scope: visibilityReportScopeKindSchema.default('project'),
  scopeKey: nonBlankIdSchema.optional(),
  provider: nonBlankIdSchema.optional(),
  /** Exact stored served-model identity. Null/absent model evidence never matches this filter. */
  model: nonBlankIdSchema.optional(),
  /** `none` means an explicit no-location execution; omit for all contexts. */
  location: z.string().trim().min(1).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  revision: z.number().int().positive().optional(),
  runId: nonBlankIdSchema.optional(),
  /** Optional bounded drill-in without changing the aggregate selection. */
  queryKey: nonBlankIdSchema.optional(),
  queryId: nonBlankIdSchema.optional(),
  /** List-only refinement: it never changes summary, trend, evidence, or competitor populations. */
  search: z.string().trim().min(1).optional(),
  /** Opaque, selection-bound pagination token issued by this endpoint. */
  cursor: nonBlankIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}

/** Plain serializable wire schema used by MCP and generated clients. */
export const visibilityReportRequestSchema = z.object(visibilityReportRequestShape).strict().superRefine((value, ctx) => {
  if (value.scope !== 'project' && value.scopeKey === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeKey'],
      message: `scopeKey is required for ${value.scope} scope`,
    })
  }
  if (value.scope === 'project' && value.scopeKey !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeKey'],
      message: 'scopeKey is not valid for project scope',
    })
  }
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'to must be on or after from',
    })
  }
  if (value.queryKey !== undefined && value.queryId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['queryId'],
      message: 'queryKey and queryId cannot both be supplied',
    })
  }
})

export type VisibilityReportRequest = z.output<typeof visibilityReportRequestSchema>

/**
 * Server-normalized query. Route code first converts URL number strings to the
 * plain request shape, then this transform makes no-location vs all explicit
 * for the frozen reader. Keep this separate from the MCP-facing schema.
 */
export const visibilityReportQuerySchema = visibilityReportRequestSchema.transform(value => ({
  ...value,
  location: locationSelection(value.location),
}))
export type VisibilityReportQuery = z.output<typeof visibilityReportQuerySchema>

/** A report rate always travels with its denominator. */
export const visibilityReportRateSchema = z.object({
  numerator: z.number().int().nonnegative().nullable(),
  denominator: z.number().int().nonnegative().nullable(),
  rate: z.number().min(0).max(1).nullable(),
  reason: z.enum(['no-population', 'incomplete', 'evidence-incomplete', 'not-applicable']).optional(),
}).strict().superRefine((value, ctx) => {
  const unavailable = value.numerator === null || value.denominator === null || value.rate === null
  if (unavailable) {
    if (value.numerator !== null || value.denominator !== null || value.rate !== null || value.reason === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unavailable rates require null values and a reason' })
    }
    return
  }
  if (value.reason !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Available rates cannot carry a reason' })
  }
  const { numerator, denominator } = value
  if (denominator === null || numerator === null) return
  if (denominator === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['denominator'], message: 'Available rates require a positive denominator' })
  }
  if (numerator > denominator) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['numerator'], message: 'Numerator cannot exceed denominator' })
  }
})
export type VisibilityReportRate = z.output<typeof visibilityReportRateSchema>

export const visibilityReportProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('frozen-simple'), definitionRevision: z.null() }).strict(),
  /** Historic simple rows had no frozen definition; never relabel them as frozen. */
  z.object({ kind: z.literal('legacy-simple'), definitionRevision: z.null() }).strict(),
  z.object({ kind: z.literal('frozen-advanced'), definitionRevision: z.number().int().positive() }).strict(),
  /** A schema-v1 Advanced revision has no assignment-class provenance this reader can safely reconstruct. */
  z.object({ kind: z.literal('unsupported-advanced-v1'), definitionRevision: z.number().int().positive() }).strict(),
])
export type VisibilityReportProvenance = z.output<typeof visibilityReportProvenanceSchema>

export const visibilityReportScopeOptionSchema = z.object({
  id: nonBlankIdSchema,
  label: z.string().trim().min(1),
  kind: visibilityReportScopeKindSchema,
  targetCount: z.number().int().nonnegative(),
}).strict()
export type VisibilityReportScopeOption = z.output<typeof visibilityReportScopeOptionSchema>

export const visibilityReportModelOptionSchema = z.object({
  provider: nonBlankIdSchema,
  /** A concrete observed model only. Missing model evidence has no fabricated option. */
  model: nonBlankIdSchema,
}).strict()
export type VisibilityReportModelOption = z.output<typeof visibilityReportModelOptionSchema>

export const visibilityReportFilterOptionsSchema = z.object({
  providers: z.array(nonBlankIdSchema),
  models: z.array(visibilityReportModelOptionSchema),
  locations: z.array(visibilityReportLocationSelectionSchema),
}).strict()
export type VisibilityReportFilterOptions = z.output<typeof visibilityReportFilterOptionsSchema>

export const visibilityReportSummarySchema = z.object({
  queryCount: z.number().int().nonnegative(),
  answerCount: z.number().int().nonnegative(),
  mentionCoverage: visibilityReportRateSchema,
  citationCoverage: visibilityReportRateSchema,
  /** Distinct selected Properties named / distinct selected Properties eligible. */
  propertyReach: visibilityReportRateSchema,
  /**
   * Exhaustive Property outcome partition over the selected population. It is
   * computed over the full selection, never only the visible query page.
   */
  outcomes: z.object({
    bothSignals: z.number().int().nonnegative(),
    mentionedOnly: z.number().int().nonnegative(),
    citedOnly: z.number().int().nonnegative(),
    neither: z.number().int().nonnegative(),
    notMeasured: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict().superRefine((value, ctx) => {
    if (value.bothSignals + value.mentionedOnly + value.citedOnly + value.neither + value.notMeasured !== value.total) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Outcome partition must sum to total' })
    }
  }),
}).strict()
export type VisibilityReportSummary = z.output<typeof visibilityReportSummarySchema>

export const visibilityReportTrendPointSchema = z.object({
  runId: nonBlankIdSchema,
  createdAt: dateTimeSchema,
  revision: z.number().int().positive().nullable(),
  provenance: visibilityReportProvenanceSchema,
  queryCount: z.number().int().nonnegative(),
  answerCount: z.number().int().nonnegative(),
  mentionCoverage: visibilityReportRateSchema,
  citationCoverage: visibilityReportRateSchema,
  /** The boundary to the prior returned point; charts must break when this is not comparable. */
  continuity: z.object({
    state: z.enum(['first', 'comparable', 'definition-changed', 'model-changed', 'legacy-unknown']),
    comparedRunId: z.string().nullable(),
  }).strict(),
}).strict()
export type VisibilityReportTrendPoint = z.output<typeof visibilityReportTrendPointSchema>

export const visibilityReportQueryRowSchema = z.object({
  queryKey: nonBlankIdSchema,
  queryId: z.string().nullable(),
  query: z.string(),
  provider: nonBlankIdSchema,
  /** Exact observed served-model identity; null means the provider did not disclose one. */
  model: z.string().nullable(),
  location: z.string().nullable(),
  targetKeys: z.array(nonBlankIdSchema),
  answerCount: z.number().int().nonnegative(),
  mentionCoverage: visibilityReportRateSchema,
  citationCoverage: visibilityReportRateSchema,
}).strict()
export type VisibilityReportQueryRow = z.output<typeof visibilityReportQueryRowSchema>

export const visibilityReportEvidenceRowSchema = z.object({
  answerId: nonBlankIdSchema,
  runId: nonBlankIdSchema,
  queryKey: nonBlankIdSchema,
  query: z.string(),
  provider: nonBlankIdSchema,
  model: z.string().nullable(),
  location: z.string().nullable(),
  targetKeys: z.array(nonBlankIdSchema),
  mentioned: z.boolean().nullable(),
  cited: z.boolean().nullable(),
  /** Present only for a query-key detail reading; aggregate listings never return answer bodies. */
  answerText: z.string().nullable(),
  createdAt: dateTimeSchema,
  sources: z.array(z.string()),
  /** Names stored with this answer; they are observations, not denominator-bearing competitors. */
  observedCompetitors: z.array(nonBlankIdSchema),
}).strict()
export type VisibilityReportEvidenceRow = z.output<typeof visibilityReportEvidenceRowSchema>

export const visibilityReportCompetitorRowSchema = z.object({
  domain: nonBlankIdSchema,
  answerCount: z.number().int().nonnegative(),
  mentionCoverage: visibilityReportRateSchema,
  citationCoverage: visibilityReportRateSchema,
}).strict()
export type VisibilityReportCompetitorRow = z.output<typeof visibilityReportCompetitorRowSchema>

export const visibilityReportObservedCompetitorRowSchema = z.object({
  name: nonBlankIdSchema,
  answerCount: z.number().int().nonnegative(),
}).strict()
export type VisibilityReportObservedCompetitorRow = z.output<typeof visibilityReportObservedCompetitorRowSchema>

/** No frozen identity means competitor rows cannot safely be reconstructed. */
export const visibilityReportCompetitorAvailabilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available') }).strict(),
  z.object({ state: z.literal('unavailable'), reason: z.literal('frozen-competitor-identity-missing') }).strict(),
])
export type VisibilityReportCompetitorAvailability = z.output<typeof visibilityReportCompetitorAvailabilitySchema>

export const visibilityReportBreakdownRowSchema = z.object({
  id: nonBlankIdSchema,
  label: z.string().trim().min(1),
  queryCount: z.number().int().nonnegative(),
  mentionCoverage: visibilityReportRateSchema,
  citationCoverage: visibilityReportRateSchema,
}).strict()
export type VisibilityReportBreakdownRow = z.output<typeof visibilityReportBreakdownRowSchema>

/** Bounded detail rows. Cursors are opaque and bound to the resolved report selection. */
export function visibilityReportPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative(),
  }).strict()
}

export const visibilityReportPopulationSchema = z.object({
  queryClass: visibilityReportPopulationClassSchema,
  summary: visibilityReportSummarySchema,
  trend: z.array(visibilityReportTrendPointSchema),
  queries: visibilityReportPageSchema(visibilityReportQueryRowSchema),
  evidence: visibilityReportPageSchema(visibilityReportEvidenceRowSchema),
  /** `items: []` alone means no measured competitors only when this is available. */
  competitorAvailability: visibilityReportCompetitorAvailabilitySchema,
  competitors: z.array(visibilityReportCompetitorRowSchema),
  /** Stored answer-level observations kept separate from frozen competitor rates. */
  observedCompetitors: z.array(visibilityReportObservedCompetitorRowSchema),
  breakdown: z.object({
    properties: z.array(visibilityReportBreakdownRowSchema),
    groups: z.array(visibilityReportBreakdownRowSchema),
  }).strict(),
}).strict()
export type VisibilityReportPopulation = z.output<typeof visibilityReportPopulationSchema>

export const visibilityReportMeasurementStateSchema = z.enum(['measured', 'not-measured', 'partial'])
export type VisibilityReportMeasurementState = z.output<typeof visibilityReportMeasurementStateSchema>

export const visibilityReportMeasurementSchema = z.object({
  state: visibilityReportMeasurementStateSchema,
  /** Revision currently active at read time; null for a simple project. */
  activeRevision: z.number().int().positive().nullable(),
  /** Revision that supplied the selected stored evidence; null with no stored evidence. */
  measuredRevision: z.number().int().positive().nullable(),
  /** A material active-plan change has assignments that no selected run measured yet. */
  awaitingSweep: z.boolean(),
  pendingAssignmentCount: z.number().int().nonnegative(),
  completedAt: dateTimeSchema.nullable(),
}).strict()
export type VisibilityReportMeasurement = z.output<typeof visibilityReportMeasurementSchema>

export const visibilityReportSelectionSchema = z.object({
  mode: visibilityReportResolvedModeSchema,
  queryClass: visibilityReportQueryClassSchema,
  scope: visibilityReportScopeOptionSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  location: visibilityReportLocationSelectionSchema,
  time: z.object({ from: dateTimeSchema.nullable(), to: dateTimeSchema.nullable() }).strict(),
  revision: z.number().int().positive().nullable(),
  run: z.object({ id: z.string().nullable(), explicit: z.boolean() }).strict(),
  provenance: visibilityReportProvenanceSchema,
  measurement: visibilityReportMeasurementSchema,
  availability: z.discriminatedUnion('state', [
    z.object({ state: z.literal('available') }).strict(),
    z.object({ state: z.literal('unsupported'), reason: z.literal('advanced-v1') }).strict(),
  ]),
}).strict()
export type VisibilityReportSelection = z.output<typeof visibilityReportSelectionSchema>

export const visibilityReportResponseSchema = z.object({
  selection: visibilityReportSelectionSchema,
  /** Server-derived choices from the same frozen definitions and stored evidence. */
  scopeOptions: z.array(visibilityReportScopeOptionSchema),
  filterOptions: visibilityReportFilterOptionsSchema,
  populations: z.array(visibilityReportPopulationSchema).min(1),
}).strict().superRefine((value, ctx) => {
  const expected = value.selection.queryClass === 'all'
    ? ['branded', 'non-brand', 'unknown']
    : [value.selection.queryClass]
  const actual = value.populations.map(population => population.queryClass)
  if (actual.length !== expected.length || actual.some((queryClass, index) => queryClass !== expected[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['populations'],
      message: 'Populations must exactly match the selected query class order',
    })
  }
})
export type VisibilityReportResponse = z.output<typeof visibilityReportResponseSchema>
