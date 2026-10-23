import { z } from 'zod'
import { fraction } from './ratio-unit.js'

export const seoCapabilitySchema = z.enum(['keyword-metrics', 'domain-intelligence', 'ranked-keywords'])
export type SeoCapability = z.infer<typeof seoCapabilitySchema>
export const SeoCapabilities = seoCapabilitySchema.enum
export const seoProviderSchema = z.enum(['dataforseo'])
export const SeoProviders = seoProviderSchema.enum
export const seoTargetKindSchema = z.enum(['domain', 'host'])
export const SeoTargetKinds = seoTargetKindSchema.enum
export const seoScopeKindSchema = z.enum(['project', 'group', 'market', 'property'])
export const SeoScopeKinds = seoScopeKindSchema.enum
export const seoRunStatusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'reconciliation-required'])
export type SeoRunStatus = z.infer<typeof seoRunStatusSchema>
export const SeoRunStatuses = seoRunStatusSchema.enum
export const seoAvailabilitySchema = z.enum(['ready', 'unavailable'])
export const SeoAvailability = seoAvailabilitySchema.enum

export const seoTargetSchema = z.object({
  kind: seoTargetKindSchema,
  value: z.string().min(1).max(253),
  includeSubdomains: z.boolean(),
}).strict()
export type SeoTarget = z.infer<typeof seoTargetSchema>
export const seoScopeSelectionSchema = z.object({
  kind: seoScopeKindSchema,
  key: z.string().min(1).max(200).optional(),
  expectedPlanRevision: z.number().int().nonnegative().optional(),
}).strict()
export type SeoScopeSelection = z.infer<typeof seoScopeSelectionSchema>

/** A saved scope is explicit. An omitted API field never silently selects a market. */
export const seoProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  connectionId: z.string().min(1).max(100),
  capabilities: z.array(seoCapabilitySchema).min(1).max(3),
  targets: z.array(seoTargetSchema).max(20),
  keywords: z.array(z.string().trim().min(1).max(80).regex(/^\S+(?:\s+\S+){0,9}$/, 'Use at most 10 words per keyword.')).max(700),
  locationCode: z.number().int().positive(),
  languageCode: z.string().min(2).max(10),
  limit: z.number().int().min(1).max(1000),
  scope: seoScopeSelectionSchema,
}).strict()
export type SeoProfileInput = z.infer<typeof seoProfileInputSchema>
export const seoProfileSchema = seoProfileInputSchema.extend({
  id: z.string(), revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(),
})
export type SeoProfile = z.infer<typeof seoProfileSchema>
export const seoProfileListSchema = z.object({ profiles: z.array(seoProfileSchema) }).strict()
export type SeoProfileList = z.infer<typeof seoProfileListSchema>

export const seoConnectionSummarySchema = z.object({
  id: z.string(), label: z.string(), provider: seoProviderSchema,
  capabilities: z.array(seoCapabilitySchema),
}).strict()
export const seoContextSchema = z.object({
  available: z.boolean(), reason: z.string().nullable(),
  connections: z.array(seoConnectionSummarySchema),
  scopes: z.array(z.object({
    kind: seoScopeKindSchema, key: z.string().nullable(), label: z.string(),
    planRevision: z.number().int().nonnegative().optional(),
    supported: z.boolean(), reason: z.string().nullable(),
    capabilities: z.array(seoCapabilitySchema).optional(),
  }).strict()),
  access: z.object({ canRun: z.boolean(), canWrite: z.boolean() }).strict(),
}).strict()
export type SeoContext = z.infer<typeof seoContextSchema>
export const seoStatusSchema = z.object({
  available: z.boolean(), reason: z.string().nullable(),
  capabilities: z.array(seoCapabilitySchema),
  profileCount: z.number().int().nonnegative(),
  latestRunId: z.string().nullable(),
  latestRunStatus: seoRunStatusSchema.nullable(),
  lastCompletedAt: z.string().nullable(),
}).strict()
export type SeoStatus = z.infer<typeof seoStatusSchema>

export const seoEstimateInputSchema = z.object({ profileId: z.string().min(1) }).strict()
export type SeoEstimateInput = z.infer<typeof seoEstimateInputSchema>
export const seoRefreshIntentInputSchema = seoEstimateInputSchema
export type SeoRefreshIntentInput = SeoEstimateInput
/** Customer-safe intent. Its opaque token must not disclose financial claims. */
export const seoQuoteSchema = z.object({
  token: z.string(), expiresAt: z.string(), profileId: z.string(),
  profileRevision: z.number().int().positive(), taskCount: z.number().int().nonnegative(),
  targets: z.array(seoTargetSchema), capabilities: z.array(seoCapabilitySchema),
  availability: seoAvailabilitySchema, reason: z.string().nullable(),
}).strict()
export type SeoQuote = z.infer<typeof seoQuoteSchema>
export const seoRefreshIntentSchema = seoQuoteSchema
export type SeoRefreshIntent = SeoQuote
export const seoSyncInputSchema = z.object({
  quoteToken: z.string().min(1).max(16384), idempotencyKey: z.string().min(1).max(200),
}).strict()
export type SeoSyncInput = z.infer<typeof seoSyncInputSchema>

export const seoProvenanceSchema = z.object({
  provider: seoProviderSchema, dataset: z.string(), engine: z.literal('google'),
  locationCode: z.number().int().positive(), languageCode: z.string(),
  device: z.literal('unspecified'),
  collectedAt: z.string(), sourceUpdatedAt: z.string().nullable(),
}).strict()
export type SeoProvenance = z.infer<typeof seoProvenanceSchema>
export const seoMonthlyVolumeSchema = z.object({
  year: z.number().int(), month: z.number().int().min(1).max(12),
  searchVolume: z.number().int().nonnegative().nullable(),
}).strict()
export const seoKeywordMetricsSchema = z.object({
  keyword: z.string(), searchVolume: z.number().int().nonnegative().nullable(),
  cpcUsd: z.number().nonnegative().nullable(),
  adCompetition: fraction(z.number().min(0).max(1)).nullable(),
  keywordDifficulty: z.number().min(0).max(100).nullable().describe('Provider difficulty score on a 0–100 scale; not a percentage.'),
  searchIntent: z.string().nullable(),
  monthlySearches: z.array(seoMonthlyVolumeSchema),
  coreKeyword: z.string().nullable(), provenance: seoProvenanceSchema,
}).strict()
export type SeoKeywordMetrics = z.infer<typeof seoKeywordMetricsSchema>
export const seoDomainIntelligenceSchema = z.object({
  target: seoTargetSchema,
  organicKeywords: z.number().int().nonnegative().nullable(),
  estimatedOrganicTraffic: z.number().nonnegative().nullable(),
  estimatedOrganicTrafficValueUsd: z.number().nonnegative().nullable(),
  top1: z.number().int().nonnegative().nullable(),
  top2To3: z.number().int().nonnegative().nullable(),
  top4To10: z.number().int().nonnegative().nullable(),
  top11To20: z.number().int().nonnegative().nullable(),
  provenance: seoProvenanceSchema,
}).strict()
export type SeoDomainIntelligence = z.infer<typeof seoDomainIntelligenceSchema>
export const seoRankedKeywordSchema = z.object({
  target: seoTargetSchema, keyword: z.string(), url: z.string().nullable(),
  rankOrganic: z.number().int().positive().nullable(),
  rankAbsolute: z.number().int().positive().nullable(),
  searchVolume: z.number().int().nonnegative().nullable(),
  estimatedTraffic: z.number().nonnegative().nullable(),
  cpcUsd: z.number().nonnegative().nullable(),
  keywordDifficulty: z.number().min(0).max(100).nullable().describe('Provider difficulty score on a 0–100 scale; not a percentage.'),
  serpFeatures: z.array(z.string()), provenance: seoProvenanceSchema,
}).strict()
export type SeoRankedKeyword = z.infer<typeof seoRankedKeywordSchema>
export const seoResultsSchema = z.object({
  keywordMetrics: z.array(seoKeywordMetricsSchema),
  domainIntelligence: z.array(seoDomainIntelligenceSchema),
  rankedKeywords: z.array(seoRankedKeywordSchema),
}).strict()
export type SeoResults = z.infer<typeof seoResultsSchema>

/** A fresh accumulator for normalized SEO observations. */
export function emptySeoResults(): SeoResults {
  return { keywordMetrics: [], domainIntelligence: [], rankedKeywords: [] }
}

export const seoRunSchema = z.object({
  id: z.string(), projectId: z.string(), profileId: z.string(),
  profileRevision: z.number().int().positive(),
  locationCode: z.number().int().positive(), languageCode: z.string(),
  cancelRequested: z.boolean(),
  status: seoRunStatusSchema, capabilities: z.array(seoCapabilitySchema),
  scope: seoScopeSelectionSchema, taskCount: z.number().int().nonnegative(),
  completedTasks: z.number().int().nonnegative(), failedTasks: z.number().int().nonnegative(),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
  error: z.string().nullable(),
}).strict()
export type SeoRun = z.infer<typeof seoRunSchema>
export const seoTaskSchema = z.object({
  id: z.string(), capability: seoCapabilitySchema, target: seoTargetSchema.nullable(),
  status: seoRunStatusSchema, error: z.string().nullable(), remoteTaskId: z.string().nullable(),
}).strict()
export type SeoTask = z.infer<typeof seoTaskSchema>
export const seoResultCountsSchema = z.object({
  keywordMetrics: z.number().int().nonnegative(),
  domainIntelligence: z.number().int().nonnegative(),
  rankedKeywords: z.number().int().nonnegative(),
}).strict()
export const seoRunDetailSchema = seoRunSchema.extend({
  tasks: z.array(seoTaskSchema), results: seoResultsSchema,
  resultCounts: seoResultCountsSchema, resultsTruncated: z.boolean(),
})
export type SeoRunDetail = z.infer<typeof seoRunDetailSchema>
export const seoRunListSchema = z.object({ runs: z.array(seoRunSchema) }).strict()
export type SeoRunList = z.infer<typeof seoRunListSchema>
export const seoEvidenceQuerySchema = z.object({
  profileId: z.string().optional(), runId: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
}).strict()
export type SeoEvidenceQuery = z.infer<typeof seoEvidenceQuerySchema>
const seoPageShape = {
  runId: z.string().nullable(), total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative(),
}
export const seoKeywordMetricsListSchema = z.object({ ...seoPageShape, items: z.array(seoKeywordMetricsSchema) }).strict()
export const seoDomainIntelligenceListSchema = z.object({ ...seoPageShape, items: z.array(seoDomainIntelligenceSchema) }).strict()
export const seoRankedKeywordListSchema = z.object({ ...seoPageShape, items: z.array(seoRankedKeywordSchema) }).strict()
export type SeoKeywordMetricsList = z.infer<typeof seoKeywordMetricsListSchema>
export type SeoDomainIntelligenceList = z.infer<typeof seoDomainIntelligenceListSchema>
export type SeoRankedKeywordList = z.infer<typeof seoRankedKeywordListSchema>
export const seoOverviewSchema = z.object({
  status: seoStatusSchema, profiles: z.array(seoProfileSchema), latestRun: seoRunSchema.nullable(),
  evidenceRunId: z.string().nullable(),
  evidenceRun: seoRunSchema.nullable(),
  summary: z.object({
    target: seoTargetSchema,
    organicKeywords: z.number().int().nonnegative().nullable(),
    inTop10: z.number().int().nonnegative().nullable(),
    estimatedOrganicTraffic: z.number().nonnegative().nullable(),
    provenance: seoProvenanceSchema,
  }).strict().nullable(),
  keywordMetricsCount: z.number().int().nonnegative(),
  domainIntelligenceCount: z.number().int().nonnegative(),
  rankedKeywordCount: z.number().int().nonnegative(),
}).strict()
export type SeoOverview = z.infer<typeof seoOverviewSchema>

/** Host-operator-only financial inspection; never embedded in customer run DTOs. */
const seoMicrosSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const seoOperatorTaskSchema = z.object({
  id: z.string(), runId: z.string(), status: seoRunStatusSchema,
  reservedCostMicros: seoMicrosSchema, actualCostMicros: seoMicrosSchema.nullable(),
  receipts: z.array(z.object({
    remoteTaskId: z.string().nullable(), statusCode: z.number().int().nullable(), costMicros: seoMicrosSchema.nullable(),
  }).strict()),
}).strict()
export type SeoOperatorTask = z.infer<typeof seoOperatorTaskSchema>
export const seoReconcileInputSchema = z.object({
  actualCostMicros: seoMicrosSchema, remoteTaskId: z.string().min(1).max(255),
  outcome: z.enum(['completed', 'failed']), note: z.string().trim().min(10).max(2000),
}).strict()
export type SeoReconcileInput = z.infer<typeof seoReconcileInputSchema>
export const seoReconcileResultSchema = z.object({ id: z.string(), status: seoRunStatusSchema }).strict()
export type SeoReconcileResult = z.infer<typeof seoReconcileResultSchema>

/** Internal adapter boundary. These cost fields never enter customer DTOs. */
export interface SeoAdapterRequest {
  capability: SeoCapability
  target: SeoTarget | null
  keywords: string[]
  locationCode: number
  languageCode: string
  limit: number
  tag: string
}
export interface SeoAdapterEstimate {
  maxCostMicros: number
  catalogRevision: string
}
export const seoAdapterOutcomeSchema = z.enum(['completed', 'partial', 'failed', 'unknown'])
export const SeoAdapterOutcomes = seoAdapterOutcomeSchema.enum
export interface SeoAdapterReceipt {
  remoteTaskId: string | null
  statusCode: number | null
  costMicros: number | null
}
export interface SeoAdapterResult {
  outcome: z.infer<typeof seoAdapterOutcomeSchema>
  tasks: SeoAdapterReceipt[]
  results: SeoResults
  error: string | null
  fetchedAt: string
}
export interface SeoAdapter {
  readonly provider: z.infer<typeof seoProviderSchema>
  /** Stable non-secret funding identity shared by aliases of the same account. */
  readonly accountKey: string
  readonly capabilities: readonly SeoCapability[]
  estimate(request: SeoAdapterRequest): SeoAdapterEstimate
  execute(request: SeoAdapterRequest, options?: { signal?: AbortSignal }): Promise<SeoAdapterResult>
}
