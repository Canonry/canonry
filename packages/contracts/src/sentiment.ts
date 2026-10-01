import { z } from 'zod'
import { wilsonInterval } from './statistics.js'
import { formatPercent } from './formatting.js'
import { fraction, RatioUnits, roundRatio } from './ratio-unit.js'
import { locationContextSchema } from './provider.js'

export const SENTIMENT_MODEL = 'jev-1.13.0' as const
export const SENTIMENT_INTERVAL_LIMITATION = 'Wilson 95% intervals assume independent observations. They exclude classifier error and dependence among related queries, Properties, and sweeps.'
const id = z.string().trim().min(1).max(256)
const count = z.number().int().nonnegative()
const runIds = z.preprocess(value => typeof value === 'string' ? [value] : value, z.array(id).min(1).max(100))
const rate = fraction(z.number().min(0).max(1)).nullable()
export const sentimentOutcomeSchema = z.enum([
  'favorable', 'mixed', 'unfavorable', 'factual', 'subject-not-mentioned', 'wrong-subject', 'ambiguous-subject',
  'ambiguous-judgment', 'subject-not-applicable', 'unsupported-language', 'missing-source-text',
  'input-too-large', 'invalid-conclusion-evidence', 'pending', 'running', 'waiting-to-retry', 'failed', 'canceled',
])
export const SentimentOutcomes = sentimentOutcomeSchema.enum
export type SentimentOutcome = z.infer<typeof sentimentOutcomeSchema>
export const sentimentStateSchema = z.enum(['disabled', 'not-measured', 'processing', 'partial', 'complete', 'failed', 'canceled', 'unsupported'])
export type SentimentState = z.infer<typeof sentimentStateSchema>
/** Schema 1 is readable archived metadata; only schema 2 is eligible for new dispatch. */
export const sentimentEvaluationDefinitionSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), requestedModel: z.literal(SENTIMENT_MODEL),
  verdictVersion: id, identityVersion: id, evidenceVersion: id, segmentationVersion: id, preprocessingVersion: id,
  languagePolicy: z.literal('en-only'), comparisonMethodVersion: z.literal('wilson-independent-v1'),
  confidenceThreshold: z.number().min(0).max(1).nullable(),
  questions: z.object({ identity: z.string(), judgment: z.string(), stance: z.string(), conclusion: z.string(), complaint: z.string() }).strict(),
}).strict()
export type SentimentEvaluationDefinition = z.infer<typeof sentimentEvaluationDefinitionSchema>
export function createSentimentEvaluationDefinition(): SentimentEvaluationDefinition {
  return sentimentEvaluationDefinitionSchema.parse({
    schemaVersion: 2, requestedModel: SENTIMENT_MODEL, verdictVersion: 'stance-v2', identityVersion: 'qualified-subject-v3',
    evidenceVersion: 'sentence-evidence-v1', segmentationVersion: 'sentence-spans-v2', preprocessingVersion: 'verbatim-v1',
    languagePolicy: 'en-only', comparisonMethodVersion: 'wilson-independent-v1', confidenceThreshold: null,
    questions: {
      identity: 'Does the answer discuss the intended subject, using qualified aliases, URLs, and execution context? A bare shared name is insufficient. Choose correct, absent, wrong, or ambiguous. Absent means the intended subject is not mentioned and is never an unfavorable judgment.',
      judgment: 'Does the answer make an evaluative judgment about that subject? Choose judged, factual, or ambiguous.',
      stance: 'Classify the overall evaluative conclusion as favorable, mixed, or unfavorable. A favorable conclusion can still contain a caveat. Judge only the intended subject when it is present.',
      conclusion: 'Select a source sentence supporting the overall conclusion about the intended subject, or absent.',
      complaint: 'Select the most serious complaint about the intended subject, or absent.',
    },
  })
}
const SENTIMENT_TEMPLATE_FIELDS = ['schemaVersion', 'verdictVersion', 'identityVersion', 'evidenceVersion', 'segmentationVersion', 'preprocessingVersion'] as const
/**
 * True when a stored definition was frozen under the request template this build implements, the
 * same versions the classifier pins. A definition from an earlier template stays readable but
 * never dispatches: the classifier would refuse it, so it waits for sentiment to be configured again.
 */
export function hasCurrentSentimentTemplate(definition: SentimentEvaluationDefinition): boolean {
  const current = createSentimentEvaluationDefinition()
  return SENTIMENT_TEMPLATE_FIELDS.every(field => definition[field] === current[field])
}
function storedDefinitionProjection(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1) return value
  const projected = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'themes'))
  if (typeof projected.questions === 'object' && projected.questions !== null) projected.questions = Object.fromEntries(Object.entries(projected.questions).filter(([key]) => key !== 'theme'))
  return projected
}
/** Read projection only: original immutable JSON and evaluator identity are never rewritten. */
export const storedSentimentEvaluationDefinitionSchema = z.preprocess(storedDefinitionProjection, sentimentEvaluationDefinitionSchema)
/** Canonical request content, excluding answer text and returned model metadata. Hash at the I/O boundary. */
export function canonicalSentimentJson(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical)
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
    return item
  }
  return JSON.stringify(canonical(value))
}
export function canonicalSentimentDefinitionJson(definition: SentimentEvaluationDefinition): string {
  return canonicalSentimentJson(sentimentEvaluationDefinitionSchema.parse(definition))
}
export const sentimentSubjectSchema = z.object({ id, displayName: z.string(), aliases: z.array(z.string()), qualifiedAliases: z.array(z.string()).default([]), urls: z.array(z.string()), mentionNotApplicable: z.boolean() }).strict()
export type SentimentSubject = z.infer<typeof sentimentSubjectSchema>
export const sentimentUsageEdgeSchema = z.object({ queryId: id, executionNodeKey: id.nullable(), targetId: id, propertyId: id.nullable(), groupId: id.nullable(), marketId: id.nullable(), queryClass: z.enum(['branded', 'non-brand']), queryText: z.string().optional(), location: z.string().nullable() }).strict()
export const sentimentExecutionContextSchema = z.object({
  queryId: id, queryText: z.string(), queryClass: z.enum(['branded', 'non-brand']), provider: id,
  requestedModel: z.string().nullable(), servedModel: z.string().nullable(), location: z.string().nullable(), revision: z.number().int().nullable(),
  usageEdges: z.array(sentimentUsageEdgeSchema), locationContext: locationContextSchema.nullable().default(null),
}).strict()
export type SentimentExecutionContext = z.infer<typeof sentimentExecutionContextSchema>
export const sentimentEvidenceSchema = z.object({ id, text: z.string().min(1), start: count, end: count }).strict()
export type SentimentEvidence = z.infer<typeof sentimentEvidenceSchema>
export type SentimentSentenceSpan = SentimentEvidence
export const sentimentUsageSchema = z.object({ kind: z.enum(['reported', 'estimated', 'unknown']), inputTokens: count.nullable(), outputTokens: count.nullable() }).strict()
export type SentimentUsage = z.infer<typeof sentimentUsageSchema>
export const sentimentClassifierInputSchema = z.object({
  sourceSnapshotId: id, sourceText: z.string(), sourceTextHash: id, subject: sentimentSubjectSchema, subjectHash: id,
  context: sentimentExecutionContextSchema, language: z.string(), definition: sentimentEvaluationDefinitionSchema, sentences: z.array(sentimentEvidenceSchema),
}).strict()
export type SentimentClassifierInput = z.infer<typeof sentimentClassifierInputSchema>
export const storedSentimentClassifierInputSchema = z.preprocess(value => {
  if (typeof value !== 'object' || value === null || !('definition' in value)) return value
  return { ...value, definition: storedDefinitionProjection(value.definition) }
}, sentimentClassifierInputSchema)
const classifierCommon = { returnedModel: z.string().nullable(), usage: sentimentUsageSchema }
export const sentimentClassifierOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('classified'), ...classifierCommon, returnedModel: z.string(), outcome: sentimentOutcomeSchema,
    conclusion: z.array(sentimentEvidenceSchema), complaint: z.array(sentimentEvidenceSchema).nullable(), confidence: z.number().min(0).max(1).nullable() }).strict(),
  z.object({ kind: z.literal('abstained'), ...classifierCommon, outcome: sentimentOutcomeSchema, reason: z.string() }).strict(),
  z.object({ kind: z.literal('failed'), ...classifierCommon, outcome: z.literal('failed'), error: z.object({ code: id, message: z.string(), retryable: z.boolean(), retryAfterMs: z.number().nonnegative().nullable() }).strict() }).strict(),
]).superRefine((result, ctx) => {
  if (result.kind === 'classified' && ['favorable', 'mixed', 'unfavorable'].includes(result.outcome) && result.conclusion.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['conclusion'], message: 'Judgments require conclusion evidence' })
  }
})
export const storedSentimentClassifierOutputSchema = z.preprocess(value => typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'themes')) : value, sentimentClassifierOutputSchema)
export type SentimentClassifierOutput = z.infer<typeof sentimentClassifierOutputSchema>
export interface SentimentClassifier { classify(input: SentimentClassifierInput, options?: { signal?: AbortSignal }): Promise<SentimentClassifierOutput> }
const sentimentSelectionBaseSchema = z.object({
  runId: id.optional(), runIds: runIds.optional(), revision: z.coerce.number().int().positive().optional(), mode: z.enum(['auto', 'simple', 'advanced']).default('auto'),
  queryClass: z.enum(['branded', 'non-brand']).default('branded'), scope: z.enum(['project', 'property', 'group', 'market']).default('project'),
  queryId: id.optional(), scopeKey: id.optional(), marketKey: id.optional(), provider: id.optional(), model: id.optional(), location: z.string().min(1).optional(), evaluationDefinitionId: id.optional(),
  /** Exact frozen Advanced execution node of the selected query. Identity: it narrows the assessed population. */
  executionNodeKey: id.optional(),
}).strict()
function exclusiveSentimentRuns(value: { runId?: string; runIds?: string[] }, ctx: z.RefinementCtx) {
  if (value.runId && value.runIds) ctx.addIssue({ code: 'custom', path: ['runIds'], message: 'Choose runId or runIds, not both.' })
  if (value.runIds && new Set(value.runIds).size !== value.runIds.length) ctx.addIssue({ code: 'custom', path: ['runIds'], message: 'Run IDs must be unique.' })
}
export const sentimentSelectionSchema = sentimentSelectionBaseSchema.superRefine(exclusiveSentimentRuns)
export type SentimentSelection = z.infer<typeof sentimentSelectionSchema>
export type SentimentEvidenceSelection = SentimentSelection & { assessmentId?: string }
export const sentimentSummaryIncludeSchema = z.enum(['assessments', 'locations'])
export type SentimentSummaryInclude = z.infer<typeof sentimentSummaryIncludeSchema>
export const SENTIMENT_QUERY_PAGE_DEFAULT = 25
export const SENTIMENT_QUERY_PAGE_MAX = 500
/**
 * Summary read. `include`, `queryLimit` and `queryCursor` are tuning: they shape the response
 * (per-query detail and paging) and never change which assessments are scored.
 */
export const sentimentSummaryRequestSchema = sentimentSelectionBaseSchema.extend({
  include: z.preprocess(value => typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : value, z.array(sentimentSummaryIncludeSchema).max(2)).optional(),
  queryLimit: z.coerce.number().int().min(1).max(SENTIMENT_QUERY_PAGE_MAX).default(SENTIMENT_QUERY_PAGE_DEFAULT),
  queryCursor: z.string().min(1).max(16384).optional(),
}).superRefine(exclusiveSentimentRuns)
export const sentimentEvidenceRequestSchema = sentimentSelectionBaseSchema.extend({ assessmentId: id.optional(), cursor: z.string().min(1).max(16384).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).superRefine(exclusiveSentimentRuns)
export const sentimentCompareRequestSchema = sentimentSelectionBaseSchema.extend({ fromRunId: id, toRunId: id }).superRefine((value, ctx) => { exclusiveSentimentRuns(value, ctx); if (value.runIds) ctx.addIssue({ code: 'custom', path: ['runIds'], message: 'Comparison requires one explicit run per period.' }) })
export const sentimentResolvedSelectionSchema = sentimentSelectionBaseSchema.extend({ runId: id.nullable(), revision: z.number().int().nullable(), evaluationDefinitionId: id.nullable(), mode: z.enum(['simple', 'advanced']) })
export type SentimentResolvedSelection = z.infer<typeof sentimentResolvedSelectionSchema>
export const sentimentCountsSchema = z.object(Object.fromEntries(sentimentOutcomeSchema.options.map(outcome => [outcome, count])) as Record<SentimentOutcome, typeof count>).strict()
export type SentimentCounts = z.infer<typeof sentimentCountsSchema>
/**
 * `selected`, `eligibleAssessments`, `unadmittedAssessments` and `judged` count answer-subject
 * assessments; `distinctSourceAnswers` counts the admitted source answers. The answer-level Rated
 * figure has its own fields, optional because older servers do not send them:
 * `eligibleAnswers` is every distinct source answer in the selection, admitted or not;
 * `ratedAnswers` is those with at least one favorable, mixed or unfavorable assessment in it
 * (an answer assessed for two subjects counts once); `ratedAnswerRate` is their share, null with
 * no eligible answers or while sentiment is disabled.
 */
export const sentimentCoverageSchema = z.object({
  selected: count, eligibleAssessments: count, unadmittedAssessments: count, judged: count, distinctSourceAnswers: count,
  eligibleAnswers: count.optional(), ratedAnswers: count.optional(), ratedAnswerRate: rate.optional(),
  counts: sentimentCountsSchema, expectedProviderSlots: count, completedProviderSlots: count,
}).strict()
export const sentimentScoreSchema = z.object({ favorableRate: rate, mixedRate: rate, unfavorableRate: rate, favorableDisplay: z.string(), mixedDisplay: z.string(), unfavorableDisplay: z.string(), interval: z.object({ low: z.number(), high: z.number() }).strict().nullable(), method: z.literal('wilson-independent-v1'), limitation: z.string() }).strict()
const headlineFields = { state: sentimentStateSchema, reason: z.string().nullable(), provisional: z.boolean(), coverage: sentimentCoverageSchema, score: sentimentScoreSchema }
export const sentimentHeadlineSchema = z.object({ ...headlineFields, selection: sentimentResolvedSelectionSchema, runIds: z.array(id) }).strict()
export type SentimentHeadline = z.infer<typeof sentimentHeadlineSchema>
/** Overview-only combined assessment population; class-specific analysis stays separate. */
export const sentimentOverallHeadlineSchema = z.object({ ...headlineFields, queryClass: z.literal('all'), runIds: z.array(id) }).strict()
export type SentimentOverallHeadline = z.infer<typeof sentimentOverallHeadlineSchema>
export const sentimentOverviewSchema = z.object({ configured: z.boolean(), branded: sentimentHeadlineSchema, nonBrand: sentimentHeadlineSchema, overall: sentimentOverallHeadlineSchema.optional() }).strict()
export type SentimentOverview = z.infer<typeof sentimentOverviewSchema>
/** Compact stored assessment metadata for exact engine rows; never carries answer text or quotes. */
export const sentimentAssessmentSummarySchema = z.object({
  assessmentId: id.nullable(), sourceSnapshotId: id, runId: id, subjectId: id, subjectLabel: z.string(),
  executionNodeKey: id.nullable(), provider: id, requestedModel: z.string().nullable(), servedModel: z.string().nullable(), location: z.string().nullable(),
  evaluationDefinitionId: id.nullable(), state: sentimentStateSchema, outcome: z.union([sentimentOutcomeSchema, z.null()]), reason: z.string().nullable(),
}).strict()
export type SentimentAssessmentSummary = z.infer<typeof sentimentAssessmentSummarySchema>
/** Advanced rows are per frozen execution node (`executionNodeKey`); Simple rows carry null. */
export const sentimentQuerySummarySchema = z.object({ ...headlineFields, queryId: id, executionNodeKey: id.nullable().optional(), queryText: z.string(), queryClass: z.enum(['branded', 'non-brand']), sourceSnapshotIds: z.array(id), assessments: z.array(sentimentAssessmentSummarySchema).default([]), locations: z.array(z.object({ ...headlineFields, location: z.string().nullable(), sourceSnapshotIds: z.array(id) }).strict()) }).strict()
export type SentimentQuerySummary = z.infer<typeof sentimentQuerySummarySchema>
export const sentimentBreakdownSchema = z.object({ ...headlineFields, dimension: z.enum(['provider', 'property', 'market', 'query']), key: z.string(), label: z.string(), queryClass: z.enum(['branded', 'non-brand']) }).strict()
export const sentimentSummarySchema = z.object({
  ...headlineFields, configured: z.boolean(), selection: sentimentResolvedSelectionSchema,
  evaluationDefinition: sentimentEvaluationDefinitionSchema.nullable(),
  breakdowns: z.array(sentimentBreakdownSchema), queries: z.array(sentimentQuerySummarySchema),
  /** Present on the paged summary read; follow `nextCursor` as `queryCursor` for the next query rows. */
  queryPage: z.object({ total: count, limit: count, nextCursor: z.string().nullable() }).strict().optional(),
}).strict()
export type SentimentSummary = z.infer<typeof sentimentSummarySchema>
export const sentimentSettingsUpdateSchema = z.object({ enabled: z.boolean().optional() }).strict()
export const sentimentSettingsSchema = z.object({
  installEnabled: z.boolean(), enabled: z.boolean(), ready: z.boolean(), readinessReasons: z.array(z.string()), model: z.string(),
  enablementEpoch: count, completionBoundary: count,
  evaluationDefinitionId: id.nullable(), actions: z.object({ configure: z.boolean(), backfill: z.boolean() }).strict(),
  experimental: z.literal(true), disclosure: z.string(),
}).strict()
export type SentimentSettings = z.infer<typeof sentimentSettingsSchema>
export const sentimentBackfillSelectionSchema = sentimentSelectionBaseSchema.extend({ runIds: runIds.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).superRefine(exclusiveSentimentRuns)
export type SentimentBackfillSelection = z.infer<typeof sentimentBackfillSelectionSchema>
export const sentimentBackfillRequestSchema = z.object({ previewToken: z.string().min(1).max(65536), idempotencyKey: z.string().trim().min(1).max(128) }).strict()
export const sentimentBackfillPreviewSchema = z.object({
  previewToken: z.string().nullable(), expiresAt: z.string().nullable(), selection: sentimentBackfillSelectionSchema,
  evaluationDefinitionId: id.nullable(), eligibleAssessments: count, alreadyClassified: count, skipped: z.array(z.object({ runId: id, reason: z.string(), count }).strict()),
  estimatedInputTokens: count, estimatedCostUsd: z.number().nonnegative().nullable(), estimateMethod: z.string(),
}).strict()
export type SentimentBackfillPreview = z.infer<typeof sentimentBackfillPreviewSchema>
export const sentimentJobStateSchema = z.enum(['pending', 'running', 'waiting-to-retry', 'complete', 'partial', 'failed', 'canceled'])
export const sentimentAttemptReceiptSchema = z.object({ id, workItemId: id, dispatchedAt: z.string(), completedAt: z.string().nullable(), returnedModel: z.string().nullable(), usage: sentimentUsageSchema, errorCode: z.string().nullable() }).strict()
export const sentimentJobSchema = z.object({
  id, projectId: id, origin: z.enum(['automatic', 'backfill']), state: sentimentJobStateSchema, enablementEpoch: count,
  evaluationDefinitionId: id, selection: sentimentBackfillSelectionSchema, createdAt: z.string(), updatedAt: z.string(),
  counts: sentimentCountsSchema, selected: count, cancellationReason: z.string().nullable(), attempts: z.array(sentimentAttemptReceiptSchema),
  /** Paged job read: every attempt of the job, and the cursor for the next (older) attempts. */
  attemptCount: count.optional(), nextAttemptCursor: z.string().nullable().optional(),
}).strict()
export type SentimentJob = z.infer<typeof sentimentJobSchema>
/** List entry: counts and an attempt total, never attempt receipts. */
export const sentimentJobSummarySchema = sentimentJobSchema.omit({ attempts: true, attemptCount: true, nextAttemptCursor: true }).extend({ attemptCount: count }).strict()
export type SentimentJobSummary = z.infer<typeof sentimentJobSummarySchema>
export const sentimentJobsSchema = z.object({ jobs: z.array(sentimentJobSummarySchema) }).strict()
export const SENTIMENT_ATTEMPT_PAGE_DEFAULT = 50
/** Attempt paging on the job read; tuning only. */
export const sentimentJobRequestSchema = z.object({
  attemptLimit: z.coerce.number().int().min(1).max(200).default(SENTIMENT_ATTEMPT_PAGE_DEFAULT),
  attemptCursor: z.string().min(1).max(4096).optional(),
}).strict()
export const sentimentEvidenceItemSchema = z.object({
  assessmentId: id, runId: id, sourceSnapshotId: id, sourceText: z.string(), sourceTextHash: id, subject: sentimentSubjectSchema,
  subjectHash: id, context: sentimentExecutionContextSchema, evaluationDefinitionId: id, outcome: sentimentOutcomeSchema,
  conclusion: z.array(sentimentEvidenceSchema), complaint: z.array(sentimentEvidenceSchema).nullable(),
  returnedModel: z.string().nullable(), reason: z.string().nullable(),
}).strict()
export type SentimentEvidenceItem = z.infer<typeof sentimentEvidenceItemSchema>
export const sentimentEvidencePageSchema = z.object({ state: sentimentStateSchema, selection: sentimentResolvedSelectionSchema.extend({ assessmentId: id.optional() }), items: z.array(sentimentEvidenceItemSchema), nextCursor: z.string().nullable() }).strict()
export type SentimentEvidencePage = z.infer<typeof sentimentEvidencePageSchema>
export const sentimentComparisonSchema = z.object({
  from: sentimentSummarySchema, to: sentimentSummarySchema, verdict: z.enum(['improved', 'declined', 'no-clear-change']).nullable(),
  favorableRateDelta: z.number().nullable(), refusalReasons: z.array(z.string()), commonUnits: count,
  excludedFrom: count, excludedTo: count, changedScope: z.boolean(), method: z.literal('wilson-independent-v1'), limitation: z.string(),
}).strict()
export type SentimentComparison = z.infer<typeof sentimentComparisonSchema>
export interface SentimentAggregateItem { assessmentId: string; sourceSnapshotId: string; outcome: SentimentOutcome }
export function emptySentimentCounts(): SentimentCounts {
  return Object.fromEntries(sentimentOutcomeSchema.options.map(outcome => [outcome, 0])) as SentimentCounts
}
/** The shared percent format; a missing rate reads 'Unavailable' rather than a dash. */
export function sentimentRateDisplay(value: number | null): string {
  return value === null ? 'Unavailable' : formatPercent(value, RatioUnits.fraction)
}
const JUDGED_OUTCOMES: ReadonlySet<SentimentOutcome> = new Set(['favorable', 'mixed', 'unfavorable'])
/**
 * Every selected answer-subject assessment appears once within the selected population.
 * `eligibleAnswers` is the number of distinct source answers in the selection, admitted or not;
 * it is the Rated share's denominator and never falls below the admitted answers. `ratedAnswers`
 * is the caller's count when the rated population is wider than `items` (a comparison scores its
 * matched units but rates every answer in the period); it never falls below the answers `items` rate.
 */
export function aggregateSentiment(items: readonly SentimentAggregateItem[], options: { disabled?: boolean; eligibleAssessments?: number; eligibleAnswers?: number; ratedAnswers?: number; expectedProviderSlots?: number; completedProviderSlots?: number } = {}) {
  const unique = [...new Map(items.map(item => [item.assessmentId, item])).values()]
  const counts = emptySentimentCounts()
  for (const item of unique) counts[item.outcome]++
  const judged = counts.favorable + counts.mixed + counts.unfavorable
  const distinctSourceAnswers = new Set(unique.map(item => item.sourceSnapshotId)).size
  const ratedInItems = new Set(unique.filter(item => JUDGED_OUTCOMES.has(item.outcome)).map(item => item.sourceSnapshotId)).size
  const ratedAnswers = Math.max(options.ratedAnswers ?? ratedInItems, ratedInItems)
  const eligibleAnswers = Math.max(options.eligibleAnswers ?? distinctSourceAnswers, distinctSourceAnswers)
  const ratedAnswerRate = options.disabled || eligibleAnswers === 0 ? null : roundRatio(ratedAnswers / eligibleAnswers, RatioUnits.fraction)
  const processing = counts.pending + counts.running + counts['waiting-to-retry']
  const provisional = processing + counts.failed + counts.canceled > 0
  const state: SentimentState = options.disabled ? 'disabled' : unique.length === 0 ? 'not-measured' : counts.canceled === unique.length ? 'canceled' : counts.failed === unique.length ? 'failed' : processing === unique.length ? 'processing' : provisional ? 'partial' : 'complete'
  const favorableRate = judged && !options.disabled ? counts.favorable / judged : null
  const mixedRate = judged && !options.disabled ? counts.mixed / judged : null
  const unfavorableRate = judged && !options.disabled ? counts.unfavorable / judged : null
  return {
    state, provisional,
    coverage: { selected: unique.length, eligibleAssessments: Math.max(options.eligibleAssessments ?? unique.length, unique.length), unadmittedAssessments: Math.max(0, (options.eligibleAssessments ?? unique.length) - unique.length), judged, distinctSourceAnswers, eligibleAnswers, ratedAnswers, ratedAnswerRate, counts, expectedProviderSlots: options.expectedProviderSlots ?? 0, completedProviderSlots: options.completedProviderSlots ?? 0 },
    score: { favorableRate, mixedRate, unfavorableRate, favorableDisplay: sentimentRateDisplay(favorableRate), mixedDisplay: sentimentRateDisplay(mixedRate), unfavorableDisplay: sentimentRateDisplay(unfavorableRate), interval: options.disabled ? null : wilsonInterval(counts.favorable, judged), method: 'wilson-independent-v1' as const, limitation: SENTIMENT_INTERVAL_LIMITATION },
  }
}
