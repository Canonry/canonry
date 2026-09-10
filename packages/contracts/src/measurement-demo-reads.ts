import { z } from 'zod'
import { citedUrlCaptureStatusSchema } from './cited-urls.js'
import {
  measurementAttributionClassSchema,
} from './measurement-service.js'
import {
  measurementMetricUnavailableReasonSchema,
  measurementMetricValueSchema,
  measurementOverviewScopeKindSchema,
  measurementQueryClassFilterSchema,
  measurementQueryClassSchema,
  measurementStateSchema,
  measurementV2StableKeySchema,
} from './measurement-plan-v2.js'
import { providerNameSchema } from './provider.js'
import { retrievalContractSchema, retrievalStatusSchema } from './retrieval.js'

const measurementDemoIdSchema = z.string().trim().min(1)
const measurementDemoLabelSchema = z.string().trim().min(1)
const measurementDemoLocationSchema = z.string().trim().min(1)
const measurementDemoCountSchema = z.number().int().nonnegative()

/** Shared, revision-pinned context for every demo read. Nulls describe N/A, never a zero run. */
export const measurementDemoRunMetadataSchema = z.object({
  state: measurementStateSchema,
  displayedRunId: measurementDemoIdSchema.nullable(),
  planRevision: z.number().int().positive(),
  completedAt: z.string().datetime().nullable(),
}).strict()
export type MeasurementDemoRunMetadata = z.output<typeof measurementDemoRunMetadataSchema>

export const measurementDemoPropertySchema = z.object({
  targetKey: measurementV2StableKeySchema,
  label: measurementDemoLabelSchema,
}).strict()
export type MeasurementDemoProperty = z.output<typeof measurementDemoPropertySchema>

const measurementDemoFilterQueryShape = {
  runId: measurementDemoIdSchema.optional(),
  provider: providerNameSchema.optional(),
  location: measurementDemoLocationSchema.optional(),
}

const measurementDemoRecommendedNameSchema = z.string().trim().min(1)

// ── Portfolio summary ────────────────────────────────────────────────────

/** The portfolio demo defaults to the non-brand basket so its weakest rows remain actionable. */
export const measurementPortfolioSummaryQuerySchema = z.object({
  runId: measurementDemoFilterQueryShape.runId,
  groupKey: measurementV2StableKeySchema.optional(),
  queryClass: measurementQueryClassFilterSchema.default('non-brand'),
  provider: measurementDemoFilterQueryShape.provider,
  location: measurementDemoFilterQueryShape.location,
  limit: z.number().int().positive().max(50).optional(),
}).strict()
export type MeasurementPortfolioSummaryQuery = z.output<typeof measurementPortfolioSummaryQuerySchema>

export const measurementPortfolioWeakestPropertySchema = measurementDemoPropertySchema.extend({
  mentionCoverage: measurementMetricValueSchema,
  citationCoverage: measurementMetricValueSchema,
  flags: measurementDemoCountSchema,
  recommendedInstead: z.array(z.object({
    name: measurementDemoRecommendedNameSchema,
    occurrences: measurementDemoCountSchema,
  }).strict()).max(5),
  recommendedInsteadTotal: measurementDemoCountSchema,
  recommendedInsteadTruncated: z.boolean(),
}).strict().superRefine((row, ctx) => {
  if (row.recommendedInstead.length > row.recommendedInsteadTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedInsteadTotal'], message: 'Total cannot be smaller than the returned replacements' })
  }
  if (row.recommendedInsteadTruncated !== (row.recommendedInstead.length < row.recommendedInsteadTotal)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedInsteadTruncated'], message: 'Truncation must agree with the replacement total' })
  }
})
export type MeasurementPortfolioWeakestProperty = z.output<typeof measurementPortfolioWeakestPropertySchema>

/**
 * One market's roll-up, so a portfolio owner can compare markets side by side
 * instead of selecting each from a dropdown in turn.
 *
 * `propertyCount` is the market's membership IN THE DISPLAYED RUN, NOT a
 * denominator. It matches the `totalProperties` the same market reports when
 * read with `groupKey`, so a spot check never states two populations for one
 * market. Coverage denominators count measured answers, and a question aimed at
 * a market is one answer serving every member, so the two never reconcile and
 * must never be rendered as though they do.
 *
 * Markets may SHARE Properties: nothing stops a Property belonging to two, and
 * a portfolio may have Properties in none. So `propertyCount` and
 * `propertiesMentioned.numerator` do not sum to the portfolio totals in either
 * direction, and a surface that adds them up is reporting a number the plan
 * does not contain.
 */
export const measurementPortfolioMarketSchema = z.object({
  groupKey: measurementV2StableKeySchema,
  label: measurementDemoLabelSchema,
  propertyCount: measurementDemoCountSchema,
  propertiesMentioned: measurementMetricValueSchema,
  mentionCoverage: measurementMetricValueSchema,
  citationCoverage: measurementMetricValueSchema,
}).strict()
export type MeasurementPortfolioMarket = z.output<typeof measurementPortfolioMarketSchema>

/** Known mention rates remain rankable even when another Property or signal is unknown. */
export const measurementPortfolioMentionRankingSchema = z.object({
  eligiblePropertyCount: measurementDemoCountSchema,
  strongest: z.array(measurementDemoPropertySchema.extend({
    mentionCoverage: measurementMetricValueSchema.options[0],
    citationCoverage: measurementMetricValueSchema,
  }).strict()).max(50),
  weakest: z.array(measurementDemoPropertySchema.extend({
    mentionCoverage: measurementMetricValueSchema.options[0],
    citationCoverage: measurementMetricValueSchema,
  }).strict()).max(50),
  /** All excluded Properties in this scope, independent of the ranked list limit. */
  excluded: z.array(measurementDemoPropertySchema.extend({
    reason: measurementMetricUnavailableReasonSchema,
  }).strict()),
  /** Each ranked list is limited; tied rates use stable label/key order. */
  truncated: z.boolean(),
}).strict()
export type MeasurementPortfolioMentionRanking = z.output<typeof measurementPortfolioMentionRankingSchema>

export const measurementPortfolioSummaryResponseSchema = z.object({
  /** A null group key means no named reporting group; spot checks may still narrow the effective Property set. */
  portfolio: z.object({
    groupKey: measurementV2StableKeySchema.nullable(),
    label: measurementDemoLabelSchema.nullable(),
    measurementScope: z.union([z.enum(['full', 'spot_check']), z.null()]),
  }).strict(),
  measurement: measurementDemoRunMetadataSchema,
  queryClass: measurementQueryClassFilterSchema,
  metrics: z.object({
    propertiesMentioned: measurementMetricValueSchema,
    mentionCoverage: measurementMetricValueSchema,
    citationCoverage: measurementMetricValueSchema,
  }).strict(),
  weakestProperties: z.array(measurementPortfolioWeakestPropertySchema),
  /** Descriptive mention ranking, using the response queryClass and scope; aggregate unavailability does not invalidate it. */
  mentionRanking: measurementPortfolioMentionRankingSchema,
  /**
   * Every named market, worst-first. Empty when the request already narrowed to
   * one group (a roll-up would only restate the scope) and when the plan defines
   * no groups. Additive field.
   */
  markets: z.array(measurementPortfolioMarketSchema),
  totalProperties: measurementDemoCountSchema,
  truncated: z.boolean(),
}).strict()
export type MeasurementPortfolioSummaryResponse = z.output<typeof measurementPortfolioSummaryResponseSchema>

// ── Property questions and one result ────────────────────────────────────

export const measurementPropertyQuestionsQuerySchema = z.object({
  targetKey: measurementV2StableKeySchema,
  runId: measurementDemoFilterQueryShape.runId,
  provider: measurementDemoFilterQueryShape.provider,
  location: measurementDemoFilterQueryShape.location,
  queryClass: measurementQueryClassFilterSchema.optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(100).optional(),
}).strict()
export type MeasurementPropertyQuestionsQuery = z.output<typeof measurementPropertyQuestionsQuerySchema>

export const measurementQuestionStatusSchema = z.enum(['answered', 'missing'])
export type MeasurementQuestionStatus = z.output<typeof measurementQuestionStatusSchema>

const measurementQuestionCommonShape = {
  queryId: measurementDemoIdSchema,
  text: measurementDemoLabelSchema,
  class: measurementQueryClassSchema,
  provider: providerNameSchema,
  requestedModel: z.string().nullable(),
  servedModel: z.string().nullable(),
  location: z.string().nullable(),
}

/** `missing` has no result or observed booleans, so it cannot be rendered as a false answer. */
export const measurementPropertyQuestionRowSchema = z.discriminatedUnion('status', [
  z.object({
    resultId: measurementDemoIdSchema,
    ...measurementQuestionCommonShape,
    status: z.literal('answered'),
    /** Null when the frozen Property declares mention matching not applicable. */
    mentioned: z.boolean().nullable(),
    /** Null when citation capture is partial or otherwise cannot support a verdict. */
    cited: z.boolean().nullable(),
    recommendedInstead: z.array(measurementDemoRecommendedNameSchema),
    answerExcerpt: z.string().nullable(),
  }).strict(),
  z.object({
    resultId: z.null(),
    ...measurementQuestionCommonShape,
    status: z.literal('missing'),
    mentioned: z.null(),
    cited: z.null(),
    recommendedInstead: z.array(measurementDemoRecommendedNameSchema).length(0),
    answerExcerpt: z.null(),
  }).strict(),
])
export type MeasurementPropertyQuestionRow = z.output<typeof measurementPropertyQuestionRowSchema>

export const measurementPropertyQuestionsResponseSchema = z.object({
  property: measurementDemoPropertySchema,
  measurement: measurementDemoRunMetadataSchema,
  queryClass: measurementQueryClassFilterSchema,
  questions: z.array(measurementPropertyQuestionRowSchema),
  total: measurementDemoCountSchema,
  truncated: z.boolean(),
}).strict()
export type MeasurementPropertyQuestionsResponse = z.output<typeof measurementPropertyQuestionsResponseSchema>

export const measurementQuestionResultQuerySchema = z.object({
  targetKey: measurementV2StableKeySchema,
  resultId: measurementDemoIdSchema,
}).strict()
export type MeasurementQuestionResultQuery = z.output<typeof measurementQuestionResultQuerySchema>

export const measurementQuestionResultSourceSchema = z.object({
  /** Keep invalid provider URLs inspectable; `classification: invalid` explains them. */
  url: measurementDemoIdSchema,
  classification: measurementAttributionClassSchema,
  matchedTargetKeys: z.array(measurementV2StableKeySchema),
  assigned: z.boolean(),
  historical: z.boolean(),
  evidenceComplete: z.boolean(),
}).strict().superRefine((source, ctx) => {
  if (source.assigned !== (source.classification === 'assigned')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assigned'],
      message: 'Assigned must agree with the source attribution classification',
    })
  }
})
export type MeasurementQuestionResultSource = z.output<typeof measurementQuestionResultSourceSchema>

export const measurementQuestionResultResponseSchema = z.object({
  property: measurementDemoPropertySchema,
  measurement: measurementDemoRunMetadataSchema,
  question: z.object({
    resultId: measurementDemoIdSchema,
    ...measurementQuestionCommonShape,
    status: z.literal('answered'),
  }).strict(),
  mentioned: z.boolean().nullable(),
  cited: z.boolean().nullable(),
  recommendedInstead: z.array(measurementDemoRecommendedNameSchema),
  answer: z.string().nullable(),
  sources: z.array(measurementQuestionResultSourceSchema),
  // Null preserves the meaningful "not recorded on this historical result" state.
  // Explicit unions keep enum nullability in the generated TypeScript SDK.
  captureStatus: z.union([citedUrlCaptureStatusSchema, z.null()]),
  retrievalStatus: z.union([retrievalStatusSchema, z.null()]),
  retrievalContract: z.union([retrievalContractSchema, z.null()]),
}).strict()
export type MeasurementQuestionResultResponse = z.output<typeof measurementQuestionResultResponseSchema>

// ── Property competitors ─────────────────────────────────────────────────

export const measurementPropertyCompetitorsQuerySchema = z.object({
  targetKey: measurementV2StableKeySchema,
  runId: measurementDemoFilterQueryShape.runId,
  provider: measurementDemoFilterQueryShape.provider,
  location: measurementDemoFilterQueryShape.location,
  queryClass: measurementQueryClassFilterSchema.optional(),
  limit: z.number().int().positive().max(50).optional(),
}).strict()
export type MeasurementPropertyCompetitorsQuery = z.output<typeof measurementPropertyCompetitorsQuerySchema>

/** Counts are supplied only when this Property has a measured answer population. */
export const measurementPropertyCompetitorBasisSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    answeredResults: measurementDemoCountSchema,
    targetMissResults: measurementDemoCountSchema,
    recommendationOccurrences: measurementDemoCountSchema,
  }).strict(),
  z.object({
    state: z.literal('unavailable'),
    reason: measurementMetricUnavailableReasonSchema,
  }).strict(),
])
export type MeasurementPropertyCompetitorBasis = z.output<typeof measurementPropertyCompetitorBasisSchema>

export const measurementPropertyCompetitorRowSchema = z.object({
  name: measurementDemoRecommendedNameSchema,
  occurrences: measurementDemoCountSchema,
  providers: z.array(providerNameSchema).max(5),
  providerTotal: measurementDemoCountSchema,
  providersTruncated: z.boolean(),
  questions: z.array(measurementDemoLabelSchema).max(5),
  questionTotal: measurementDemoCountSchema,
  questionsTruncated: z.boolean(),
}).strict().superRefine((row, ctx) => {
  if (row.providers.length > row.providerTotal || row.questions.length > row.questionTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Evidence totals cannot be smaller than returned evidence' })
  }
  if (row.providersTruncated !== (row.providers.length < row.providerTotal)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providersTruncated'], message: 'Provider truncation must agree with its total' })
  }
  if (row.questionsTruncated !== (row.questions.length < row.questionTotal)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questionsTruncated'], message: 'Question truncation must agree with its total' })
  }
})
export type MeasurementPropertyCompetitorRow = z.output<typeof measurementPropertyCompetitorRowSchema>

export const measurementPropertyCompetitorsResponseSchema = z.object({
  property: measurementDemoPropertySchema,
  measurement: measurementDemoRunMetadataSchema,
  queryClass: measurementQueryClassFilterSchema,
  basis: measurementPropertyCompetitorBasisSchema,
  competitors: z.array(measurementPropertyCompetitorRowSchema),
  total: measurementDemoCountSchema,
  truncated: z.boolean(),
}).strict()
export type MeasurementPropertyCompetitorsResponse = z.output<typeof measurementPropertyCompetitorsResponseSchema>

// ── Same-identity changes ─────────────────────────────────────────────────

export const measurementChangesQuerySchema = z.object({
  runId: measurementDemoFilterQueryShape.runId,
  scope: measurementOverviewScopeKindSchema.default('all'),
  groupKey: measurementV2StableKeySchema.optional(),
  targetKey: measurementV2StableKeySchema.optional(),
  queryClass: measurementQueryClassFilterSchema.default('all'),
  provider: measurementDemoFilterQueryShape.provider,
  location: measurementDemoFilterQueryShape.location,
  limit: z.number().int().positive().max(50).optional(),
}).strict().superRefine((query, ctx) => {
  if (query.scope === 'all' && (query.groupKey !== undefined || query.targetKey !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scope'], message: 'All scope cannot name a group or Property' })
  }
  if (query.scope === 'group' && (query.groupKey === undefined || query.targetKey !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['groupKey'], message: 'Group scope requires groupKey only' })
  }
  if (query.scope === 'property' && (query.targetKey === undefined || query.groupKey !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetKey'], message: 'Property scope requires targetKey only' })
  }
})
export type MeasurementChangesQuery = z.output<typeof measurementChangesQuerySchema>

export const measurementComparisonUnavailableReasonSchema = z.enum([
  'no_previous_run',
  'execution_identity_changed',
  'incomplete',
  'not_comparable',
])
export type MeasurementComparisonUnavailableReason = z.output<typeof measurementComparisonUnavailableReasonSchema>

const measurementComparableRunSchema = measurementDemoRunMetadataSchema.extend({
  executionIdentity: measurementDemoIdSchema.nullable(),
  measurementScope: z.union([z.enum(['full', 'spot_check']), z.null()]),
}).strict()

export const measurementMetricDeltaSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    previous: measurementMetricValueSchema,
    current: measurementMetricValueSchema,
    delta: z.number(),
  }).strict().superRefine((metric, ctx) => {
    if (metric.previous.state !== 'available' || metric.current.state !== 'available') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Available deltas require two available metrics',
      })
      return
    }
    if (Math.abs(metric.delta - (metric.current.value - metric.previous.value)) > Number.EPSILON) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['delta'], message: 'Delta must equal current minus previous' })
    }
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: measurementMetricUnavailableReasonSchema,
  }).strict(),
])
export type MeasurementMetricDelta = z.output<typeof measurementMetricDeltaSchema>

export const measurementChangesResponseSchema = z.object({
  current: measurementComparableRunSchema,
  comparison: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('available'),
      previous: z.object({
        displayedRunId: measurementDemoIdSchema,
        planRevision: z.number().int().positive(),
        completedAt: z.string().datetime().nullable(),
        executionIdentity: measurementDemoIdSchema,
        measurementScope: z.enum(['full', 'spot_check']),
      }).strict(),
      metrics: z.object({
        propertiesMentioned: measurementMetricDeltaSchema,
        mentionCoverage: measurementMetricDeltaSchema,
        citationCoverage: measurementMetricDeltaSchema,
      }).strict(),
      changedProperties: z.array(measurementDemoPropertySchema.extend({
        mentionCoverage: measurementMetricDeltaSchema,
        citationCoverage: measurementMetricDeltaSchema,
        flags: measurementDemoCountSchema,
      }).strict()),
      totalProperties: measurementDemoCountSchema,
      truncated: z.boolean(),
    }).strict(),
    z.object({
      state: z.literal('unavailable'),
      reason: measurementComparisonUnavailableReasonSchema,
    }).strict(),
  ]),
}).strict().superRefine((response, ctx) => {
  if (response.comparison.state !== 'available') return
  if (response.current.displayedRunId === null || response.current.executionIdentity === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current'], message: 'A comparison requires an identified current run' })
    return
  }
  if (response.comparison.previous.planRevision !== response.current.planRevision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparison', 'previous', 'planRevision'], message: 'Comparisons cannot cross plan revisions' })
  }
  if (response.comparison.previous.executionIdentity !== response.current.executionIdentity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparison', 'previous', 'executionIdentity'], message: 'Comparisons cannot cross execution identities' })
  }
})
export type MeasurementChangesResponse = z.output<typeof measurementChangesResponseSchema>

// ── Data quality ─────────────────────────────────────────────────────────

export const measurementDataQualityQuerySchema = z.object({
  runId: measurementDemoFilterQueryShape.runId,
}).strict()
export type MeasurementDataQualityQuery = z.output<typeof measurementDataQualityQuerySchema>

export const measurementDataQualityUnavailableReasonSchema = z.enum([
  'no_completed_run',
  'incomplete',
  'evidence_incomplete',
  'no_population',
  'not_applicable',
])
export type MeasurementDataQualityUnavailableReason = z.output<typeof measurementDataQualityUnavailableReasonSchema>

const measurementDataQualityUnavailableSchema = z.object({
  state: z.literal('unavailable'),
  reason: measurementDataQualityUnavailableReasonSchema,
}).strict()

const measurementDataQualityCompletenessAvailableSchema = z.object({
  state: z.literal('available'),
  expected: measurementDemoCountSchema,
  executed: measurementDemoCountSchema,
  answered: measurementDemoCountSchema,
  missing: measurementDemoCountSchema,
}).strict()

export const measurementDataQualityCompletenessSchema = z.discriminatedUnion('state', [
  measurementDataQualityCompletenessAvailableSchema,
  measurementDataQualityUnavailableSchema,
]).superRefine((value, ctx) => {
  if (value.state !== 'available') return
  if (value.executed + value.missing !== value.expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected must equal executed plus missing' })
  }
  if (value.answered > value.executed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answered'], message: 'Answered cannot exceed executed' })
  }
})
export type MeasurementDataQualityCompleteness = z.output<typeof measurementDataQualityCompletenessSchema>

const measurementDataQualityCaptureAvailableSchema = z.object({
  state: z.literal('available'),
  complete: measurementDemoCountSchema,
  partial: measurementDemoCountSchema,
  failed: measurementDemoCountSchema,
  unsupported: measurementDemoCountSchema,
  notRecorded: measurementDemoCountSchema,
}).strict()

export const measurementDataQualityCaptureSchema = z.discriminatedUnion('state', [
  measurementDataQualityCaptureAvailableSchema,
  measurementDataQualityUnavailableSchema,
])
export type MeasurementDataQualityCapture = z.output<typeof measurementDataQualityCaptureSchema>

const measurementDataQualityRetrievalAvailableSchema = z.object({
  state: z.literal('available'),
  used: measurementDemoCountSchema,
  notUsed: measurementDemoCountSchema,
  unknown: measurementDemoCountSchema,
  notApplicable: measurementDemoCountSchema,
  notRecorded: measurementDemoCountSchema,
}).strict()

export const measurementDataQualityRetrievalSchema = z.discriminatedUnion('state', [
  measurementDataQualityRetrievalAvailableSchema,
  measurementDataQualityUnavailableSchema,
])
export type MeasurementDataQualityRetrieval = z.output<typeof measurementDataQualityRetrievalSchema>

const measurementDataQualityPopulationAvailableSchema = z.object({
  state: z.literal('available'),
  expectedQuestions: measurementDemoCountSchema,
  answeredQuestions: measurementDemoCountSchema,
  missingQuestions: measurementDemoCountSchema,
}).strict()

export const measurementDataQualityPopulationSchema = z.discriminatedUnion('state', [
  measurementDataQualityPopulationAvailableSchema,
  measurementDataQualityUnavailableSchema,
]).superRefine((value, ctx) => {
  if (value.state === 'available' && value.answeredQuestions + value.missingQuestions !== value.expectedQuestions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected questions must equal answered plus missing' })
  }
})
export type MeasurementDataQualityPopulation = z.output<typeof measurementDataQualityPopulationSchema>

export const measurementDataQualityResponseSchema = z.object({
  run: measurementComparableRunSchema,
  completeness: measurementDataQualityCompletenessSchema,
  capture: measurementDataQualityCaptureSchema,
  retrieval: measurementDataQualityRetrievalSchema,
  /** Exact observed populations; intentionally no pass/fail threshold is invented here. */
  population: measurementDataQualityPopulationSchema,
  comparison: z.discriminatedUnion('state', [
    z.object({ state: z.literal('available'), previousDisplayedRunId: measurementDemoIdSchema }).strict(),
    z.object({ state: z.literal('unavailable'), reason: measurementComparisonUnavailableReasonSchema }).strict(),
  ]),
}).strict().superRefine((response, ctx) => {
  if (response.completeness.state !== 'available') return
  // Capture and retrieval are recorded for every persisted snapshot. A
  // snapshot with a null answer body is still an executed observation.
  const executed = response.completeness.executed
  if (response.capture.state === 'available') {
    const captureCount = response.capture.complete + response.capture.partial + response.capture.failed
      + response.capture.unsupported + response.capture.notRecorded
    if (captureCount !== executed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capture'], message: 'Capture counts must total executed snapshots' })
    }
  }
  if (response.retrieval.state === 'available') {
    const retrievalCount = response.retrieval.used + response.retrieval.notUsed + response.retrieval.unknown
      + response.retrieval.notApplicable + response.retrieval.notRecorded
    if (retrievalCount !== executed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retrieval'], message: 'Retrieval counts must total executed snapshots' })
    }
  }
})
export type MeasurementDataQualityResponse = z.output<typeof measurementDataQualityResponseSchema>
