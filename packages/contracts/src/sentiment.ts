import { z } from 'zod'
import { wilsonInterval } from './statistics.js'
import { locationContextSchema } from './provider.js'

export const SENTIMENT_MODEL = 'jev-1.13.0' as const
export const SENTIMENT_MAX_THEMES = 24
export const SENTIMENT_INTERVAL_LIMITATION = 'Wilson 95% intervals assume independent observations. They exclude classifier error and dependence among related queries, Properties, and sweeps.'
const id = z.string().trim().min(1).max(256)
const count = z.number().int().nonnegative()
const rate = z.number().min(0).max(1).nullable()
export const sentimentOutcomeSchema = z.enum([
  'favorable', 'mixed', 'unfavorable', 'factual', 'wrong-subject', 'ambiguous-subject',
  'ambiguous-judgment', 'subject-not-applicable', 'unsupported-language', 'missing-source-text',
  'input-too-large', 'invalid-conclusion-evidence', 'pending', 'running', 'waiting-to-retry', 'failed', 'canceled',
])
export const SentimentOutcomes = sentimentOutcomeSchema.enum
export type SentimentOutcome = z.infer<typeof sentimentOutcomeSchema>
export const sentimentStateSchema = z.enum(['disabled', 'not-measured', 'processing', 'partial', 'complete', 'failed', 'canceled', 'unsupported'])
export type SentimentState = z.infer<typeof sentimentStateSchema>
export const sentimentThemeSchema = z.object({
  id, name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(400),
  source: z.enum(['default', 'multifamily', 'custom']),
  evaluationStatus: z.enum(['experimental', 'evaluated', 'custom-not-evaluated']),
}).strict()
export type SentimentTheme = z.infer<typeof sentimentThemeSchema>
export const sentimentThemesSchema = z.array(sentimentThemeSchema).max(SENTIMENT_MAX_THEMES).superRefine((themes, ctx) => {
  const names = new Set<string>()
  const ids = new Set<string>()
  themes.forEach((theme, index) => {
    const name = theme.name.normalize('NFKC').trim().toLocaleLowerCase('en')
    if (names.has(name) || ids.has(theme.id)) ctx.addIssue({ code: 'custom', path: [index], message: 'Theme names and IDs must be unique' })
    if (theme.source === 'custom' && theme.evaluationStatus !== 'custom-not-evaluated') ctx.addIssue({ code: 'custom', path: [index, 'evaluationStatus'], message: 'Custom themes require their own evaluation' })
    names.add(name)
    ids.add(theme.id)
  })
})
const presets = {
  default: ['Customer service', 'Quality', 'Price and value', 'Reliability', 'Trust and reputation', 'Location and convenience'],
  multifamily: ['Management', 'Maintenance', 'Noise', 'Parking', 'Pests', 'Safety', 'Cleanliness', 'Pricing', 'Amenities', 'Location', 'Pets', 'Building systems'],
} as const
export function sentimentPresetThemes(preset: keyof typeof presets = 'default'): SentimentTheme[] {
  return presets[preset].map(name => ({ id: `${preset}:${name.toLowerCase().replaceAll(' ', '-')}`, name, description: `Discussion, praise, or criticism of ${name.toLowerCase()} for the intended subject.`, source: preset, evaluationStatus: 'experimental' }))
}
export const sentimentEvaluationDefinitionSchema = z.object({
  schemaVersion: z.literal(1), requestedModel: z.literal(SENTIMENT_MODEL),
  verdictVersion: id, identityVersion: id, evidenceVersion: id, segmentationVersion: id, preprocessingVersion: id,
  languagePolicy: z.literal('en-only'), comparisonMethodVersion: z.literal('wilson-independent-v1'),
  confidenceThreshold: z.number().min(0).max(1).nullable(), themes: sentimentThemesSchema,
  questions: z.record(z.string(), z.string()),
}).strict()
export type SentimentEvaluationDefinition = z.infer<typeof sentimentEvaluationDefinitionSchema>
export function createSentimentEvaluationDefinition(themes: SentimentTheme[] = sentimentPresetThemes()): SentimentEvaluationDefinition {
  return sentimentEvaluationDefinitionSchema.parse({
    schemaVersion: 1, requestedModel: SENTIMENT_MODEL, verdictVersion: 'stance-v1', identityVersion: 'qualified-subject-v1',
    evidenceVersion: 'sentence-evidence-v1', segmentationVersion: 'sentence-spans-v1', preprocessingVersion: 'verbatim-v1',
    languagePolicy: 'en-only', comparisonMethodVersion: 'wilson-independent-v1', confidenceThreshold: null, themes,
    questions: {
      identity: 'Does the answer discuss the intended subject, using qualified aliases, URLs, and execution context? A bare shared name is insufficient. Choose correct, wrong, or ambiguous.',
      judgment: 'Does the answer make an evaluative judgment about that subject? Choose judged, factual, or ambiguous.',
      stance: 'Classify the overall evaluative conclusion as favorable, mixed, or unfavorable. A favorable conclusion can still contain a caveat.',
      conclusion: 'Select a source sentence supporting the overall conclusion about the intended subject, or absent.',
      complaint: 'Select the most serious complaint about the intended subject, or absent.',
      theme: 'For each theme independently identify discussion, praise, and criticism about the intended subject, each with its own supporting sentence or absent.',
    },
  })
}
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
export const sentimentUsageEdgeSchema = z.object({ queryId: id, executionNodeKey: id.nullable(), targetId: id, propertyId: id.nullable(), groupId: id.nullable(), marketId: id.nullable(), queryClass: z.enum(['branded', 'non-brand']), location: z.string().nullable() }).strict()
export const sentimentExecutionContextSchema = z.object({
  queryId: id, queryText: z.string(), queryClass: z.enum(['branded', 'non-brand']), provider: id,
  requestedModel: z.string().nullable(), servedModel: z.string().nullable(), location: z.string().nullable(), revision: z.number().int().nullable(),
  usageEdges: z.array(sentimentUsageEdgeSchema), locationContext: locationContextSchema.nullable().default(null),
}).strict()
export type SentimentExecutionContext = z.infer<typeof sentimentExecutionContextSchema>
export const sentimentEvidenceSchema = z.object({ id, text: z.string().min(1), start: count, end: count }).strict()
export type SentimentEvidence = z.infer<typeof sentimentEvidenceSchema>
export type SentimentSentenceSpan = SentimentEvidence
export const sentimentThemeResultSchema = z.object({
  themeId: id, discussed: z.boolean().nullable(), praised: z.boolean().nullable(), criticized: z.boolean().nullable(),
  evidence: z.object({ discussed: z.array(sentimentEvidenceSchema), praised: z.array(sentimentEvidenceSchema), criticized: z.array(sentimentEvidenceSchema) }).strict(),
  reason: z.string().nullable(),
}).strict()
export type SentimentThemeResult = z.infer<typeof sentimentThemeResultSchema>
export const sentimentUsageSchema = z.object({ kind: z.enum(['reported', 'estimated', 'unknown']), inputTokens: count.nullable(), outputTokens: count.nullable() }).strict()
export type SentimentUsage = z.infer<typeof sentimentUsageSchema>
export const sentimentClassifierInputSchema = z.object({
  sourceSnapshotId: id, sourceText: z.string(), sourceTextHash: id, subject: sentimentSubjectSchema, subjectHash: id,
  context: sentimentExecutionContextSchema, language: z.string(), definition: sentimentEvaluationDefinitionSchema, sentences: z.array(sentimentEvidenceSchema),
}).strict()
export type SentimentClassifierInput = z.infer<typeof sentimentClassifierInputSchema>
const classifierCommon = { returnedModel: z.string().nullable(), usage: sentimentUsageSchema }
export const sentimentClassifierOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('classified'), ...classifierCommon, returnedModel: z.string(), outcome: sentimentOutcomeSchema,
    conclusion: z.array(sentimentEvidenceSchema), complaint: z.array(sentimentEvidenceSchema).nullable(), themes: z.array(sentimentThemeResultSchema), confidence: z.number().min(0).max(1).nullable() }).strict(),
  z.object({ kind: z.literal('abstained'), ...classifierCommon, outcome: sentimentOutcomeSchema, reason: z.string(), themes: z.array(sentimentThemeResultSchema) }).strict(),
  z.object({ kind: z.literal('failed'), ...classifierCommon, outcome: z.literal('failed'), error: z.object({ code: id, message: z.string(), retryable: z.boolean(), retryAfterMs: z.number().nonnegative().nullable() }).strict() }).strict(),
]).superRefine((result, ctx) => {
  if (result.kind === 'classified' && ['favorable', 'mixed', 'unfavorable'].includes(result.outcome) && result.conclusion.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['conclusion'], message: 'Judgments require conclusion evidence' })
  }
})
export type SentimentClassifierOutput = z.infer<typeof sentimentClassifierOutputSchema>
export interface SentimentClassifier { classify(input: SentimentClassifierInput, options?: { signal?: AbortSignal }): Promise<SentimentClassifierOutput> }
export const sentimentSelectionSchema = z.object({
  runId: id.optional(), revision: z.coerce.number().int().positive().optional(), mode: z.enum(['auto', 'simple', 'advanced']).default('auto'),
  queryClass: z.enum(['branded', 'non-brand']).default('branded'), scope: z.enum(['project', 'property', 'group', 'market']).default('project'),
  scopeKey: id.optional(), marketKey: id.optional(), provider: id.optional(), model: id.optional(), location: z.string().min(1).optional(), evaluationDefinitionId: id.optional(),
}).strict()
export type SentimentSelection = z.infer<typeof sentimentSelectionSchema>
export const sentimentEvidenceRequestSchema = sentimentSelectionSchema.extend({ cursor: z.string().min(1).max(16384).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
export const sentimentCompareRequestSchema = sentimentSelectionSchema.extend({ fromRunId: id, toRunId: id })
export const sentimentResolvedSelectionSchema = sentimentSelectionSchema.extend({ runId: id.nullable(), revision: z.number().int().nullable(), evaluationDefinitionId: id.nullable(), mode: z.enum(['simple', 'advanced']) })
export type SentimentResolvedSelection = z.infer<typeof sentimentResolvedSelectionSchema>
export const sentimentCountsSchema = z.object(Object.fromEntries(sentimentOutcomeSchema.options.map(outcome => [outcome, count])) as Record<SentimentOutcome, typeof count>).strict()
export type SentimentCounts = z.infer<typeof sentimentCountsSchema>
export const sentimentCoverageSchema = z.object({ selected: count, eligibleAssessments: count, unadmittedAssessments: count, judged: count, distinctSourceAnswers: count, counts: sentimentCountsSchema, expectedProviderSlots: count, completedProviderSlots: count }).strict()
export const sentimentScoreSchema = z.object({ favorableRate: rate, mixedRate: rate, unfavorableRate: rate, favorableDisplay: z.string(), mixedDisplay: z.string(), unfavorableDisplay: z.string(), interval: z.object({ low: z.number(), high: z.number() }).strict().nullable(), method: z.literal('wilson-independent-v1'), limitation: z.string() }).strict()
export const sentimentThemeCountsSchema = z.object({ theme: sentimentThemeSchema, discussed: count, praised: count, criticized: count, both: count, unclassified: count }).strict()
export const sentimentBreakdownSchema = z.object({ dimension: z.enum(['provider', 'property', 'market']), key: z.string(), label: z.string(), coverage: sentimentCoverageSchema, score: sentimentScoreSchema }).strict()
export const sentimentSummarySchema = z.object({
  state: sentimentStateSchema, reason: z.string().nullable(), selection: sentimentResolvedSelectionSchema,
  evaluationDefinition: sentimentEvaluationDefinitionSchema.nullable(), coverage: sentimentCoverageSchema, score: sentimentScoreSchema,
  provisional: z.boolean(), themes: z.array(sentimentThemeCountsSchema), breakdowns: z.array(sentimentBreakdownSchema),
}).strict()
export type SentimentSummary = z.infer<typeof sentimentSummarySchema>
export const sentimentSettingsUpdateSchema = z.object({ enabled: z.boolean().optional(), preset: z.enum(['default', 'multifamily']).optional(), customThemes: z.array(z.object({ id, name: z.string().min(1).max(80), description: z.string().min(1).max(400) }).strict()).max(SENTIMENT_MAX_THEMES).optional() }).strict()
export const sentimentSettingsSchema = z.object({
  installEnabled: z.boolean(), enabled: z.boolean(), ready: z.boolean(), readinessReasons: z.array(z.string()), model: z.string(),
  enablementEpoch: count, completionBoundary: count, preset: z.enum(['default', 'multifamily']), themes: sentimentThemesSchema,
  evaluationDefinitionId: id.nullable(), actions: z.object({ configure: z.boolean(), backfill: z.boolean() }).strict(),
  experimental: z.literal(true), disclosure: z.string(),
}).strict()
export type SentimentSettings = z.infer<typeof sentimentSettingsSchema>
export const sentimentBackfillSelectionSchema = sentimentSelectionSchema.extend({ runIds: z.array(id).min(1).max(100).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() })
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
}).strict()
export type SentimentJob = z.infer<typeof sentimentJobSchema>
export const sentimentJobsSchema = z.object({ jobs: z.array(sentimentJobSchema) }).strict()
export const sentimentEvidenceItemSchema = z.object({
  assessmentId: id, runId: id, sourceSnapshotId: id, sourceText: z.string(), sourceTextHash: id, subject: sentimentSubjectSchema,
  subjectHash: id, context: sentimentExecutionContextSchema, evaluationDefinitionId: id, outcome: sentimentOutcomeSchema,
  conclusion: z.array(sentimentEvidenceSchema), complaint: z.array(sentimentEvidenceSchema).nullable(), themes: z.array(sentimentThemeResultSchema),
  returnedModel: z.string().nullable(), reason: z.string().nullable(),
}).strict()
export type SentimentEvidenceItem = z.infer<typeof sentimentEvidenceItemSchema>
export const sentimentEvidencePageSchema = z.object({ state: sentimentStateSchema, selection: sentimentResolvedSelectionSchema, items: z.array(sentimentEvidenceItemSchema), nextCursor: z.string().nullable() }).strict()
export const sentimentComparisonSchema = z.object({
  from: sentimentSummarySchema, to: sentimentSummarySchema, verdict: z.enum(['improved', 'declined', 'no-clear-change']).nullable(),
  favorableRateDelta: z.number().nullable(), refusalReasons: z.array(z.string()), commonUnits: count,
  excludedFrom: count, excludedTo: count, changedScope: z.boolean(), method: z.literal('wilson-independent-v1'), limitation: z.string(),
}).strict()
export type SentimentComparison = z.infer<typeof sentimentComparisonSchema>
export interface SentimentAggregateItem { assessmentId: string; sourceSnapshotId: string; outcome: SentimentOutcome; themes: SentimentThemeResult[] }
export function emptySentimentCounts(): SentimentCounts {
  return Object.fromEntries(sentimentOutcomeSchema.options.map(outcome => [outcome, 0])) as SentimentCounts
}
export function sentimentRateDisplay(value: number | null): string {
  if (value === null) return 'Unavailable'
  if (value > 0 && value < 0.01) return '<1%'
  return `${Math.round(value * 100)}%`
}
/** Every selected assessment appears once. Theme polarities intentionally overlap. */
export function aggregateSentiment(items: readonly SentimentAggregateItem[], themes: readonly SentimentTheme[] = [], options: { disabled?: boolean; eligibleAssessments?: number; expectedProviderSlots?: number; completedProviderSlots?: number } = {}) {
  const unique = [...new Map(items.map(item => [item.assessmentId, item])).values()]
  const counts = emptySentimentCounts()
  for (const item of unique) counts[item.outcome]++
  const judged = counts.favorable + counts.mixed + counts.unfavorable
  const processing = counts.pending + counts.running + counts['waiting-to-retry']
  const provisional = processing + counts.failed + counts.canceled > 0
  const state: SentimentState = options.disabled ? 'disabled' : unique.length === 0 ? 'not-measured' : counts.canceled === unique.length ? 'canceled' : counts.failed === unique.length ? 'failed' : processing === unique.length ? 'processing' : provisional ? 'partial' : 'complete'
  const favorableRate = judged && !options.disabled ? counts.favorable / judged : null
  const mixedRate = judged && !options.disabled ? counts.mixed / judged : null
  const unfavorableRate = judged && !options.disabled ? counts.unfavorable / judged : null
  return {
    state, provisional,
    coverage: { selected: unique.length, eligibleAssessments: Math.max(options.eligibleAssessments ?? unique.length, unique.length), unadmittedAssessments: Math.max(0, (options.eligibleAssessments ?? unique.length) - unique.length), judged, distinctSourceAnswers: new Set(unique.map(item => item.sourceSnapshotId)).size, counts, expectedProviderSlots: options.expectedProviderSlots ?? 0, completedProviderSlots: options.completedProviderSlots ?? 0 },
    score: { favorableRate, mixedRate, unfavorableRate, favorableDisplay: sentimentRateDisplay(favorableRate), mixedDisplay: sentimentRateDisplay(mixedRate), unfavorableDisplay: sentimentRateDisplay(unfavorableRate), interval: options.disabled ? null : wilsonInterval(counts.favorable, judged), method: 'wilson-independent-v1' as const, limitation: SENTIMENT_INTERVAL_LIMITATION },
    themes: themes.map(theme => {
      let discussed = 0, praised = 0, criticized = 0, both = 0, unclassified = 0
      for (const item of unique) {
        const result = item.themes.find(value => value.themeId === theme.id)
        if (!result || result.discussed === null || result.praised === null || result.criticized === null || ((!result.discussed) && (result.praised || result.criticized))) { unclassified++; continue }
        if (result.discussed) discussed++
        if (result.praised) praised++
        if (result.criticized) criticized++
        if (result.praised && result.criticized) both++
      }
      return { theme, discussed, praised, criticized, both, unclassified }
    }),
  }
}
