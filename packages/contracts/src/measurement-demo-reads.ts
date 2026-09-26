import { z } from 'zod'
import { fraction } from './ratio-unit.js'
import { citedUrlCaptureStatusSchema } from './cited-urls.js'
import {
  measurementAttributionClassSchema,
} from './measurement-service.js'
import {
  measurementCountMetricValueSchema,
  measurementMetricUnavailableReasonSchema,
  measurementMetricValueSchema,
  type CountMetricValue,
  type MetricValue,
  measurementOverviewScopeKindSchema,
  measurementPropertyMetroSchema,
  measurementQueryClassFilterSchema,
  measurementQueryClassSchema,
  measurementStateSchema,
  measurementV2StableKeySchema,
} from './measurement-plan-v2.js'
import { providerNameSchema } from './provider.js'
import { retrievalContractSchema, retrievalStatusSchema } from './retrieval.js'
import { runFillStatusSchema } from './run-fill.js'

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

/**
 * Rows every portfolio-summary Property list returns when `limit` is omitted.
 * An agent reads this response through a 20,000-character tool-result cap.
 * Each weakest row carries its own answer evidence (about 2,300 indented
 * characters with the deprecated `recommendedInstead` copy), so ten of them
 * alone overran it. Four keeps the whole default response, every metro, both
 * rankings and the tie roll-ups included, near 19,700 characters of compact
 * JSON on a 200-Property, 20-metro portfolio (about 31,500 indented).
 */
export const MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT = 4
/** Names and cited domains returned per weakest Property row. */
export const MEASUREMENT_PORTFOLIO_ROW_EVIDENCE_LIMIT = 5
/** Domains returned in the response-level `weakestAnswerSources`. */
export const MEASUREMENT_PORTFOLIO_ANSWER_SOURCES_LIMIT = 10
/** Names returned in `tiedAtWeakest.namedInstead`, counted across the whole tie. */
export const MEASUREMENT_PORTFOLIO_TIE_NAMED_INSTEAD_LIMIT = 10
export const MEASUREMENT_PORTFOLIO_TIE_NOTE = 'tied Properties are ordered by name, not ranked'

/** The portfolio demo defaults to the non-brand basket so its weakest rows remain actionable. */
export const measurementPortfolioSummaryQuerySchema = z.object({
  runId: measurementDemoFilterQueryShape.runId,
  groupKey: measurementV2StableKeySchema.optional(),
  queryClass: measurementQueryClassFilterSchema.default('non-brand'),
  provider: measurementDemoFilterQueryShape.provider,
  location: measurementDemoFilterQueryShape.location,
  /** Caps the Property lists (Property rows and both mention rankings). Defaults to 4. Markets are never capped. */
  limit: z.number().int().positive().max(50).optional(),
  /**
   * Off by default: `markets` holds one level only, every top-level market (or
   * every direct child of the selected group), worst-first. True returns every
   * market in scope at every level, as the roll-up did before it was levelled.
   */
  includeNestedMarkets: z.boolean().optional(),
}).strict()
export type MeasurementPortfolioSummaryQuery = z.output<typeof measurementPortfolioSummaryQuerySchema>

/** A top-level reporting group: the root of a Property's market hierarchy. */
export const measurementPortfolioMetroSchema = measurementPropertyMetroSchema
export type MeasurementPortfolioMetro = z.output<typeof measurementPortfolioMetroSchema>

/**
 * Where a Property sits in the plan's reporting groups, and how many queries
 * stand behind its rates. Group a Property only by its own `metro`: a label
 * never implies a market.
 *
 * `queries` counts distinct queries in the response queryClass that the
 * displayed run asked for this Property (the plan's assignments before any run
 * completes). Coverage denominators count ANSWERS, one per query per engine
 * (and per location where a query runs in several), so 8 queries on 3 engines
 * is a denominator of 24 answers.
 */
const measurementPortfolioPropertyContextShape = {
  /** The top-level group holding this Property; null when it is in none. */
  metro: measurementPortfolioMetroSchema.nullable(),
  /** Further top-level groups holding the same Property. Present only when there are any. */
  otherMetros: z.array(measurementPortfolioMetroSchema).min(1).optional(),
  /** Labels of every nested (non-top-level) group holding this Property, shallowest first. */
  submarkets: z.array(measurementDemoLabelSchema),
  queries: measurementDemoCountSchema,
}

const measurementPortfolioCountedNameSchema = z.object({
  name: measurementDemoRecommendedNameSchema,
  /** Answers that wrote this name. */
  answers: measurementDemoCountSchema,
}).strict()

const measurementPortfolioRecommendedInsteadSchema = z.object({
  name: measurementDemoRecommendedNameSchema,
  /** Answers that wrote this name, one per answer however it spells it: the same count as `namedInsteadInAnswerText[].answers`. */
  occurrences: measurementDemoCountSchema,
}).strict()

const measurementPortfolioCountedDomainSchema = z.object({
  domain: z.string().trim().min(1),
  /** Answers citing at least one URL on this domain. */
  answers: measurementDemoCountSchema,
}).strict()

export const measurementPortfolioWeakestPropertySchema = measurementDemoPropertySchema.extend({
  ...measurementPortfolioPropertyContextShape,
  mentionCoverage: measurementMetricValueSchema,
  citationCoverage: measurementMetricValueSchema,
  flags: measurementDemoCountSchema,
  /**
   * Names WRITTEN IN THE ANSWER TEXT of this Property's answers that neither
   * named nor cited it, counted by answer. These are mentions, never
   * citations: a name here says nothing about which sources were linked.
   * Supersedes the deprecated `recommendedInstead`, whose name read as a
   * citation.
   */
  namedInsteadInAnswerText: z.array(measurementPortfolioCountedNameSchema).max(MEASUREMENT_PORTFOLIO_ROW_EVIDENCE_LIMIT),
  /** Distinct names across those answers; more than returned means the list was cut. */
  namedInsteadInAnswerTextTotal: measurementDemoCountSchema,
  /**
   * Domains cited by this Property's stored answers in this run and class,
   * every engine included: each answer's stored domains plus the hosts of its
   * captured source URLs, and answers whose text was not captured count too.
   */
  citedDomains: z.array(measurementPortfolioCountedDomainSchema).max(MEASUREMENT_PORTFOLIO_ROW_EVIDENCE_LIMIT),
  /** Distinct cited domains; more than returned means the list was cut. */
  citedDomainsTotal: measurementDemoCountSchema,
  /**
   * Deprecated: read `namedInsteadInAnswerText`. The same names in the same
   * order, kept for existing consumers. `occurrences` counts answers, one per
   * answer however it spells the name, exactly as `answers` does there.
   */
  recommendedInstead: z.array(measurementPortfolioRecommendedInsteadSchema).max(MEASUREMENT_PORTFOLIO_ROW_EVIDENCE_LIMIT)
    .meta({ deprecated: true, description: 'Deprecated: read namedInsteadInAnswerText, which carries the same names in the same order. occurrences counts answers, exactly as answers does there.' }),
  /** Deprecated: read `namedInsteadInAnswerTextTotal`, which it always equals. */
  recommendedInsteadTotal: measurementDemoCountSchema
    .meta({ deprecated: true, description: 'Deprecated: read namedInsteadInAnswerTextTotal, which it always equals.' }),
  /** Deprecated: true when `namedInsteadInAnswerTextTotal` exceeds the names returned. */
  recommendedInsteadTruncated: z.boolean()
    .meta({ deprecated: true, description: 'Deprecated: true when namedInsteadInAnswerTextTotal exceeds the names returned in namedInsteadInAnswerText.' }),
}).strict().superRefine((row, ctx) => {
  if (row.namedInsteadInAnswerText.length > row.namedInsteadInAnswerTextTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['namedInsteadInAnswerTextTotal'], message: 'Total cannot be smaller than the returned names' })
  }
  if (row.citedDomains.length > row.citedDomainsTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['citedDomainsTotal'], message: 'Total cannot be smaller than the returned domains' })
  }
  if (row.recommendedInsteadTotal !== row.namedInsteadInAnswerTextTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedInsteadTotal'], message: 'The deprecated total must equal namedInsteadInAnswerTextTotal' })
  }
  if (row.recommendedInstead.length > row.recommendedInsteadTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedInsteadTotal'], message: 'Total cannot be smaller than the returned replacements' })
  }
  if (row.recommendedInsteadTruncated !== (row.recommendedInstead.length < row.recommendedInsteadTotal)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedInsteadTruncated'], message: 'Truncation must agree with the replacement total' })
  }
})
export type MeasurementPortfolioWeakestProperty = z.output<typeof measurementPortfolioWeakestPropertySchema>

/**
 * Tied Properties in one top-level market, by that market's label (a
 * `markets` row carries its groupKey). A null `metro` counts the tied
 * Properties in no top-level group.
 */
export const measurementPortfolioTieMetroSchema = z.object({
  metro: measurementDemoLabelSchema.nullable(),
  count: z.number().int().positive(),
}).strict()
export type MeasurementPortfolioTieMetro = z.output<typeof measurementPortfolioTieMetroSchema>

/**
 * How many Properties share the weakest row's exact mention and citation
 * rates. Rows inside a tie are ordered by name, so their order is not a rank.
 *
 * `byMetro` and `namedInstead` cover EVERY tied Property, not only the
 * returned rows, so a large tie can be described without reading it row by
 * row. Both are absent on responses from servers that predate them.
 */
export const measurementPortfolioWeakestTieSchema = z.object({
  count: z.number().int().min(2),
  mentionRate: fraction(),
  citationRate: fraction(),
  note: z.literal(MEASUREMENT_PORTFOLIO_TIE_NOTE),
  /**
   * Tied Properties per top-level market, most first, then by label. A
   * Property in several top-level markets counts in each, so the counts can
   * sum past `count`.
   */
  byMetro: z.array(measurementPortfolioTieMetroSchema).optional(),
  /**
   * Names WRITTEN IN THE ANSWER TEXT of the tied Properties' answers that
   * neither named nor cited the Property, most first. `answers` counts
   * distinct answers: one answer serving several tied Properties counts once.
   * These are mentions, never citations.
   */
  namedInstead: z.array(measurementPortfolioCountedNameSchema).max(MEASUREMENT_PORTFOLIO_TIE_NAMED_INSTEAD_LIMIT).optional(),
  /** Distinct names across those answers; more than returned means the list was cut. */
  namedInsteadTotal: measurementDemoCountSchema.optional(),
}).strict().superRefine((tie, ctx) => {
  if (tie.namedInstead !== undefined && (tie.namedInsteadTotal === undefined || tie.namedInstead.length > tie.namedInsteadTotal)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['namedInsteadTotal'], message: 'Total cannot be smaller than the returned names' })
  }
})
export type MeasurementPortfolioWeakestTie = z.output<typeof measurementPortfolioWeakestTieSchema>

/**
 * Where engines got their answers for the weakest Properties: the returned
 * weakest rows plus every Property tied with the weakest. Each stored answer
 * counts once even when it serves several of those Properties. `answers`
 * counts every measured answer, including one whose text was not captured:
 * source capture does not depend on answer text.
 */
export const measurementPortfolioAnswerSourcesSchema = z.object({
  properties: measurementDemoCountSchema,
  answers: measurementDemoCountSchema,
  domains: z.array(measurementPortfolioCountedDomainSchema).max(MEASUREMENT_PORTFOLIO_ANSWER_SOURCES_LIMIT),
  domainTotal: measurementDemoCountSchema,
}).strict().superRefine((sources, ctx) => {
  if (sources.domains.length > sources.domainTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domainTotal'], message: 'Total cannot be smaller than the returned domains' })
  }
  if (sources.domains.some(row => row.answers > sources.answers)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains'], message: 'A domain cannot be cited by more answers than the basis holds' })
  }
})
export type MeasurementPortfolioAnswerSources = z.output<typeof measurementPortfolioAnswerSourcesSchema>

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
  /** Null for a top-level market. */
  parentGroupKey: measurementV2StableKeySchema.nullable(),
  /** Direct child markets; read one with `groupKey` to list them. */
  childMarketCount: measurementDemoCountSchema,
  propertyCount: measurementDemoCountSchema,
  propertiesMentioned: measurementCountMetricValueSchema,
  mentionCoverage: measurementMetricValueSchema,
  citationCoverage: measurementMetricValueSchema,
}).strict()
export type MeasurementPortfolioMarket = z.output<typeof measurementPortfolioMarketSchema>

const measurementPortfolioRankedPropertySchema = measurementDemoPropertySchema.extend({
  ...measurementPortfolioPropertyContextShape,
  mentionCoverage: measurementMetricValueSchema.options[0],
  citationCoverage: measurementMetricValueSchema,
}).strict()

/** Known mention rates remain rankable even when another Property or signal is unknown. */
export const measurementPortfolioMentionRankingSchema = z.object({
  eligiblePropertyCount: measurementDemoCountSchema,
  strongest: z.array(measurementPortfolioRankedPropertySchema).max(50),
  weakest: z.array(measurementPortfolioRankedPropertySchema).max(50),
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
  /** Engines behind the displayed answers, after any provider filter. Empty before a run completes. */
  engines: z.array(providerNameSchema),
  metrics: z.object({
    propertiesMentioned: measurementCountMetricValueSchema,
    mentionCoverage: measurementMetricValueSchema,
    citationCoverage: measurementMetricValueSchema,
  }).strict(),
  weakestProperties: z.array(measurementPortfolioWeakestPropertySchema),
  /** Set when two or more Properties share the weakest row's rates; null otherwise. */
  tiedAtWeakest: measurementPortfolioWeakestTieSchema.nullable(),
  /** Null before a run completes. */
  weakestAnswerSources: measurementPortfolioAnswerSourcesSchema.nullable(),
  /** Descriptive mention ranking, using the response queryClass and scope; aggregate unavailability does not invalidate it. */
  mentionRanking: measurementPortfolioMentionRankingSchema,
  /**
   * Markets worst-first. By default one level: every top-level market, or
   * every direct child of the selected group when `groupKey` is set (empty
   * when it has none). `limit` never caps it. `includeNestedMarkets` returns
   * every market in scope at every level. Empty when the plan defines no groups.
   */
  markets: z.array(measurementPortfolioMarketSchema),
  /** Markets at the returned level; more than returned means the list was cut. */
  totalMarkets: measurementDemoCountSchema,
  marketsTruncated: z.boolean(),
  totalProperties: measurementDemoCountSchema,
  truncated: z.boolean(),
}).strict().superRefine((response, ctx) => {
  if (response.marketsTruncated !== (response.markets.length < response.totalMarkets)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['marketsTruncated'], message: 'Market truncation must agree with the market total' })
  }
})
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

/** Domains returned in a Property competitors response's `citedDomains`. */
export const MEASUREMENT_PROPERTY_CITED_DOMAINS_LIMIT = 10

export const measurementPropertyCompetitorsResponseSchema = z.object({
  property: measurementDemoPropertySchema,
  measurement: measurementDemoRunMetadataSchema,
  queryClass: measurementQueryClassFilterSchema,
  basis: measurementPropertyCompetitorBasisSchema,
  competitors: z.array(measurementPropertyCompetitorRowSchema),
  total: measurementDemoCountSchema,
  truncated: z.boolean(),
  /**
   * Domains cited by this Property's own measured answers in this run, class
   * and filter, most first. Each answer counts once per domain: its stored
   * domains plus the hosts of its captured source URLs, and an answer whose
   * text was not captured counts too. These are sources, never names written
   * instead. Absent when no answer of this Property was measured.
   */
  citedDomains: z.array(measurementPortfolioCountedDomainSchema).max(MEASUREMENT_PROPERTY_CITED_DOMAINS_LIMIT).optional(),
  /** Distinct cited domains; more than returned means the list was cut. */
  citedDomainsTotal: measurementDemoCountSchema.optional(),
  /** Measured answers the domains were counted over, with or without answer text. */
  citedDomainsAnswers: measurementDemoCountSchema.optional(),
}).strict().superRefine((response, ctx) => {
  const { citedDomains, citedDomainsTotal, citedDomainsAnswers } = response
  if (citedDomains === undefined) return
  if (citedDomainsTotal === undefined || citedDomainsAnswers === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['citedDomains'], message: 'Cited domains require their total and answer basis' })
    return
  }
  if (citedDomains.length > citedDomainsTotal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['citedDomainsTotal'], message: 'Total cannot be smaller than the returned domains' })
  }
  if (citedDomains.some(row => row.answers > citedDomainsAnswers)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['citedDomains'], message: 'A domain cannot be cited by more answers than the basis holds' })
  }
})
export type MeasurementPropertyCompetitorsResponse = z.output<typeof measurementPropertyCompetitorsResponseSchema>

// ── Same-identity changes ─────────────────────────────────────────────────

/**
 * How changed Property rows are ordered. `magnitude` puts moves beyond noise
 * before moves within it; within each, the larger of the mention and citation
 * changes (in answers) first, then the other, then label, so a large
 * citation-only move outranks small mention wobbles. `label` is the original
 * alphabetical order.
 */
export const measurementChangesSortSchema = z.enum(['magnitude', 'label'])
export type MeasurementChangesSort = z.output<typeof measurementChangesSortSchema>
export const MEASUREMENT_CHANGES_DEFAULT_SORT: MeasurementChangesSort = 'magnitude'

/**
 * A sweep-over-sweep move of at most this many answers, in both the mention
 * count and the citation count, is within noise: one engine answering one or
 * two questions differently. Such a Property is reported, but never as a
 * real gain or loss.
 */
export const MEASUREMENT_CHANGES_NOISE_ANSWERS = 2

export const measurementChangesQuerySchema = z.object({
  runId: measurementDemoFilterQueryShape.runId,
  scope: measurementOverviewScopeKindSchema.default('all'),
  groupKey: measurementV2StableKeySchema.optional(),
  targetKey: measurementV2StableKeySchema.optional(),
  queryClass: measurementQueryClassFilterSchema.default('all'),
  provider: measurementDemoFilterQueryShape.provider,
  location: measurementDemoFilterQueryShape.location,
  limit: z.number().int().positive().max(50).optional(),
  /** Changed-row order. Omit for `magnitude`, the largest move first. */
  sort: measurementChangesSortSchema.optional(),
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

interface MetricMove {
  previous: MetricValue | CountMetricValue
  current: MetricValue | CountMetricValue
  delta: number
}

/** A metric's move between two runs: both must be measured, and `delta` is `current - previous`. */
function refineMetricMove(metric: MetricMove, ctx: z.RefinementCtx): void {
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
}

const unavailableMetricMoveSchema = z.object({
  state: z.literal('unavailable'),
  reason: measurementMetricUnavailableReasonSchema,
}).strict()

/** A coverage move, as a 0..1 fraction (0.05 is five points). */
export const measurementMetricDeltaSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    previous: measurementMetricValueSchema,
    current: measurementMetricValueSchema,
    delta: fraction(),
  }).strict().superRefine(refineMetricMove),
  unavailableMetricMoveSchema,
])
export type MeasurementMetricDelta = z.output<typeof measurementMetricDeltaSchema>

/** `propertiesMentioned` moves by a whole number of Properties. */
export const measurementCountMetricDeltaSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    previous: measurementCountMetricValueSchema,
    current: measurementCountMetricValueSchema,
    delta: z.number().int(),
  }).strict().superRefine(refineMetricMove),
  unavailableMetricMoveSchema,
])

const measurementChangesMetricsSchema = z.object({
  propertiesMentioned: measurementCountMetricDeltaSchema,
  mentionCoverage: measurementMetricDeltaSchema,
  citationCoverage: measurementMetricDeltaSchema,
}).strict()

/**
 * Every Property in scope, split by how it moved. The buckets are DISJOINT
 * and EXHAUSTIVE, so they sum to `total`, and they count every Property, not
 * the returned page. A move is the rate change times the larger run's
 * answers, so a rate that fell on a grown denominator is a decline even when
 * more answers named the Property, and a collapse on a shrunken denominator
 * is never noise. A Property whose every move is at most
 * `noiseAnswers` answers counts once, in `withinNoise`, whichever way it
 * moved; `improved`, `declined` and `mixed` hold only moves beyond that.
 * `mixed` is one signal up and the other down, each beyond noise.
 * `notComparable` is a metric measured in one run only.
 */
export const measurementChangesDistributionSchema = z.object({
  improved: measurementDemoCountSchema,
  declined: measurementDemoCountSchema,
  mixed: measurementDemoCountSchema,
  withinNoise: measurementDemoCountSchema,
  unchanged: measurementDemoCountSchema,
  notComparable: measurementDemoCountSchema,
  total: measurementDemoCountSchema,
  noiseAnswers: z.literal(MEASUREMENT_CHANGES_NOISE_ANSWERS),
}).strict().superRefine((distribution, ctx) => {
  const sum = distribution.improved + distribution.declined + distribution.mixed + distribution.withinNoise
    + distribution.unchanged + distribution.notComparable
  if (sum !== distribution.total) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['total'], message: 'Move buckets must sum to total' })
  }
})
export type MeasurementChangesDistribution = z.output<typeof measurementChangesDistributionSchema>

export const measurementChangedPropertySchema = measurementDemoPropertySchema.extend({
  mentionCoverage: measurementMetricDeltaSchema,
  citationCoverage: measurementMetricDeltaSchema,
  flags: measurementDemoCountSchema,
  /** Current minus previous answers that named the Property. Null unless both runs measured it. */
  mentionAnswersDelta: z.number().int().nullable().optional(),
  /** Current minus previous answers that cited the Property. Null unless both runs measured it. */
  citationAnswersDelta: z.number().int().nullable().optional(),
  /**
   * True when a metric measured in both runs was taken over a different
   * number of answers, so its answer delta above is not like for like. The
   * move is then sized on the larger of the two: 1 of 1 to 4 of 8 is a
   * delta of +3 but a move of four answers down.
   */
  denominatorChanged: z.boolean().optional(),
  /**
   * True when both moves are at most `MEASUREMENT_CHANGES_NOISE_ANSWERS`
   * answers (a metric unmeasured in both runs did not move). A move is the
   * rate change times the larger run's answers, which is the answer delta
   * whenever the denominator held. False when a metric was measured in one
   * run only.
   */
  withinNoise: z.boolean().optional(),
}).strict()
export type MeasurementChangedProperty = z.output<typeof measurementChangedPropertySchema>

export const measurementChangesResponseSchema = z.object({
  current: measurementComparableRunSchema,
  /** The question class every figure below is taken over. Absent on servers that predate it. */
  queryClass: measurementQueryClassFilterSchema.optional(),
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
      /** Over the response `queryClass`. When it is `all`, this pools branded with non-brand. */
      metrics: measurementChangesMetricsSchema,
      /**
       * Present only when `queryClass` is `all`: the same metrics for each
       * class alone, so a pooled move cannot hide a move in one class.
       */
      metricsByClass: z.object({
        branded: measurementChangesMetricsSchema,
        nonBrand: measurementChangesMetricsSchema,
      }).strict().optional(),
      /** The order of `changedProperties`. */
      sort: measurementChangesSortSchema.optional(),
      distribution: measurementChangesDistributionSchema.optional(),
      changedProperties: z.array(measurementChangedPropertySchema),
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
  const { distribution } = response.comparison
  if (distribution !== undefined && distribution.total - distribution.unchanged !== response.comparison.totalProperties) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparison', 'distribution'], message: 'Changed Properties must equal the distribution total less unchanged' })
  }
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

/**
 * One question class's answers whose mention identity could not be resolved
 * (an answer naming a Property only ambiguously). Every mention rate in that
 * class leaves them out of both sides and reports them as `unattributed`.
 * `answered` counts the class's answers with text; it is the basis, not a
 * rate denominator.
 */
export const measurementDataQualityUnattributedSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    answered: measurementDemoCountSchema,
    unattributed: measurementDemoCountSchema,
  }).strict(),
  measurementDataQualityUnavailableSchema,
]).superRefine((value, ctx) => {
  if (value.state === 'available' && value.unattributed > value.answered) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unattributed'], message: 'Unattributed answers cannot exceed answered' })
  }
})
export type MeasurementDataQualityUnattributed = z.output<typeof measurementDataQualityUnattributedSchema>

/**
 * The newest attempt to complete this run in place: the missing answers a
 * fill set out to record (`expected`) and those it recorded (`filled`). Its
 * answers already count in `completeness`; this says the run was topped up.
 */
export const measurementDataQualityFillSchema = z.object({
  status: runFillStatusSchema,
  providers: z.array(z.string()),
  expected: measurementDemoCountSchema,
  filled: measurementDemoCountSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
}).strict()
export type MeasurementDataQualityFill = z.output<typeof measurementDataQualityFillSchema>

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
  /**
   * Unattributed answers per question class, never pooled. A class is
   * unavailable when its mention rate is withheld for incomplete evidence or
   * the run asked no question of that class. Absent on servers that predate it.
   */
  unattributedByClass: z.object({
    branded: measurementDataQualityUnattributedSchema,
    nonBrand: measurementDataQualityUnattributedSchema,
  }).strict().optional(),
  /** The newest fill of this run; null when it was never filled. Absent on servers that predate it. */
  latestFill: measurementDataQualityFillSchema.nullable().optional(),
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
