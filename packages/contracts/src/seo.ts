import { z } from 'zod'
import { queryClassSchema } from './query-class.js'
import { fraction } from './ratio-unit.js'

export const seoCapabilitySchema = z.enum(['keyword-metrics', 'domain-intelligence', 'ranked-keywords', 'market-rankings'])
export type SeoCapability = z.infer<typeof seoCapabilitySchema>
export const SeoCapabilities = seoCapabilitySchema.enum
export const seoProviderSchema = z.enum(['dataforseo'])
export const SeoProviders = seoProviderSchema.enum
/** A dataset path segment that carries a provider name, such as `dataforseo-labs`. */
const SEO_PROVIDER_SEGMENT = new RegExp(`^(?:${seoProviderSchema.options.join('|')})(?:[-_].*)?$`, 'i')

/**
 * A stored dataset id without its provider segment: `dataforseo-labs/google/ranked-keywords`
 * becomes `google/ranked-keywords`. Customer-facing surfaces name an SEO source by the host's
 * connection label, never by the vendor behind it.
 */
export function seoDatasetWithoutVendor(dataset: string): string {
  return dataset.split('/').filter(segment => !SEO_PROVIDER_SEGMENT.test(segment)).join('/')
}
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

/** The device a Google results page was collected for. Labs datasets do not say, so they read `unspecified`. */
export const seoDeviceSchema = z.enum(['desktop', 'mobile'])
export type SeoDevice = z.infer<typeof seoDeviceSchema>
export const SeoDevices = seoDeviceSchema.enum

/**
 * What a market-rankings profile searches on Google for each tracked query. Market
 * rankings always measure the project's tracked queries, never a separate keyword list.
 * `query` searches the query as written. `query-without-market-region` drops a trailing
 * ", <region>" when it names the market's region (the part of the market label after
 * its last comma), so "best apartments in Dallas, Dallas-Fort Worth" in the market
 * "Dallas, Dallas-Fort Worth" is searched as "best apartments in Dallas".
 */
export const seoSearchTextSchema = z.enum(['query', 'query-without-market-region'])
export type SeoSearchText = z.infer<typeof seoSearchTextSchema>
export const SeoSearchTexts = seoSearchTextSchema.enum

/**
 * Where one market's searches run. `key` names an Advanced market or one of its
 * groups (a market uses the first match among itself, its group and that group's
 * parents), or a Simple project location by label. `project` is the whole project.
 */
export const seoMarketLocationSchema = z.object({
  key: z.string().trim().min(1).max(200),
  locationCode: z.number().int().positive(),
  /** The provider's name for the location, shown beside results. */
  label: z.string().trim().min(1).max(200),
}).strict()
export type SeoMarketLocation = z.infer<typeof seoMarketLocationSchema>

/** One market-rankings refresh may run at most this many searches. */
export const SEO_MARKET_RANKING_MAX_SEARCHES = 1000
/** The key a project with no markets or locations uses for its one market. */
export const SEO_PROJECT_MARKET_KEY = 'project'

/** Market-rankings settings: required with that capability, rejected without it. */
export const seoRankingSettingsSchema = z.object({
  locations: z.array(seoMarketLocationSchema).max(500),
  /** How many organic results to check per search, in steps of 10. A target past this reads as not ranked. */
  depth: z.number().int().min(10).max(100).multipleOf(10),
  device: seoDeviceSchema,
  searchText: seoSearchTextSchema,
}).strict()
export type SeoRankingSettings = z.infer<typeof seoRankingSettingsSchema>

/** A saved scope is explicit. An omitted API field never silently selects a market. */
export const seoProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  connectionId: z.string().min(1).max(100),
  capabilities: z.array(seoCapabilitySchema).min(1).max(4),
  targets: z.array(seoTargetSchema).max(20),
  keywords: z.array(z.string().trim().min(1).max(80).regex(/^\S+(?:\s+\S+){0,9}$/, 'Use at most 10 words per keyword.')).max(700),
  locationCode: z.number().int().positive(),
  languageCode: z.string().min(2).max(10),
  limit: z.number().int().min(1).max(1000),
  scope: seoScopeSelectionSchema,
  rankings: seoRankingSettingsSchema.optional(),
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
  device: z.union([z.literal('unspecified'), seoDeviceSchema]),
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

/** The market and tracked query one market-rankings search answers. */
export const seoMarketRankingContextSchema = z.object({
  marketKey: z.string(), marketLabel: z.string(),
  /** The market's top-level group (a metro, say), or null when it has none. */
  regionKey: z.string().nullable(), regionLabel: z.string().nullable(),
  queryId: z.string().nullable(), queryText: z.string(), queryClass: queryClassSchema,
}).strict()
export type SeoMarketRankingContext = z.infer<typeof seoMarketRankingContextSchema>

const seoMarketRankingCompetitorSchema = z.object({ domain: z.string(), rankOrganic: z.number().int().positive() }).strict()

/**
 * The target's position for one tracked query, searched on Google from the market's
 * location, as the adapter records it. A null rank means the target was not in the
 * checked results. `checkedDepth` is present only when fewer results came back than
 * `depth` asked for (a partial results page).
 */
export const seoMarketRankingObservationSchema = seoMarketRankingContextSchema.extend({
  /** The exact text searched on Google for `queryText` (see `seoSearchTextSchema`). */
  searchText: z.string(), locationLabel: z.string(), target: seoTargetSchema,
  rankOrganic: z.number().int().positive().nullable(),
  rankAbsolute: z.number().int().positive().nullable(),
  url: z.string().nullable(),
  depth: z.number().int().positive(),
  checkedDepth: z.number().int().positive().optional(),
  /** Tracked competitors found in the same results, by their best organic position. */
  competitors: z.array(seoMarketRankingCompetitorSchema),
  provenance: seoProvenanceSchema,
}).strict()
export type SeoMarketRankingObservation = z.infer<typeof seoMarketRankingObservationSchema>

/**
 * How one market-rankings search ended: its whole results page came back, part of it
 * came back (fewer results than `depth`), it failed at the source, or it never ran
 * because the refresh was cancelled or stopped at a spending limit first.
 */
export const seoMarketRankingSearchStatusSchema = z.enum(['completed', 'partial', 'failed', 'not-run'])
export const SeoMarketRankingSearchStatuses = seoMarketRankingSearchStatusSchema.enum
export type SeoMarketRankingSearchStatus = z.infer<typeof seoMarketRankingSearchStatusSchema>

/**
 * Where a query landed: page 1 (ranks 1 to 10), ranks 11 to 20, rank 21 or deeper
 * within the checked results, not in the checked results, or no result.
 */
export const seoMarketRankingOutcomeSchema = z.enum(['page-1', 'ranks-11-20', 'ranks-21-plus', 'not-ranked', 'failed', 'not-run'])
export const SeoMarketRankingOutcomes = seoMarketRankingOutcomeSchema.enum
export type SeoMarketRankingOutcome = z.infer<typeof seoMarketRankingOutcomeSchema>

/**
 * One market-rankings row as reads return it: the observation plus how its search
 * ended and where it landed. Failed and not-run searches have rows too, with no rank,
 * no competitors and no provenance, so a missing result is never a missing row.
 */
export const seoMarketRankingSchema = seoMarketRankingContextSchema.extend({
  /** The exact text searched on Google for `queryText` (see `seoSearchTextSchema`). */
  searchText: z.string(), locationLabel: z.string(), target: seoTargetSchema,
  rankOrganic: z.number().int().positive().nullable(),
  rankAbsolute: z.number().int().positive().nullable(),
  url: z.string().nullable(),
  depth: z.number().int().positive(),
  /** Results actually checked: `depth` for a whole page, fewer for a partial one, 0 with no result. */
  checkedDepth: z.number().int().nonnegative(),
  searchStatus: seoMarketRankingSearchStatusSchema,
  outcome: seoMarketRankingOutcomeSchema,
  /** A tracked competitor ranks above the target in these results, or ranks while the target is not in them. */
  rivalAhead: z.boolean(),
  /** Tracked competitors found in the same results at their best organic position, best first. */
  competitors: z.array(seoMarketRankingCompetitorSchema),
  /** Null when the search produced no result (failed or not run). */
  provenance: seoProvenanceSchema.nullable(),
}).strict()
export type SeoMarketRanking = z.infer<typeof seoMarketRankingSchema>

export const seoResultsSchema = z.object({
  keywordMetrics: z.array(seoKeywordMetricsSchema),
  domainIntelligence: z.array(seoDomainIntelligenceSchema),
  rankedKeywords: z.array(seoRankedKeywordSchema),
  marketRankings: z.array(seoMarketRankingObservationSchema),
}).strict()
export type SeoResults = z.infer<typeof seoResultsSchema>

/** SEO results as a task stores them: tasks saved before market rankings existed have no `marketRankings`. */
export type StoredSeoResults = Omit<SeoResults, 'marketRankings'> & Partial<Pick<SeoResults, 'marketRankings'>>

/** A fresh accumulator for normalized SEO observations. */
export function emptySeoResults(): SeoResults {
  return { keywordMetrics: [], domainIntelligence: [], rankedKeywords: [], marketRankings: [] }
}

/**
 * The region a market label names: the part after its last comma, so
 * "Buckhead, Atlanta" is "Atlanta". Null for a label without a comma.
 */
export function marketRegionName(marketLabel: string): string | null {
  const comma = marketLabel.lastIndexOf(',')
  if (comma < 0) return null
  const region = marketLabel.slice(comma + 1).trim()
  return region || null
}

/**
 * The text a tracked query is searched as on Google. Whitespace is collapsed. With
 * `query-without-market-region`, a trailing ", <region>" is dropped only when it is
 * exactly the market label's region, ignoring case; any other query is kept as written.
 */
export function seoSearchTextForQuery(queryText: string, marketLabel: string | null, rule: SeoSearchText): string {
  const text = queryText.replace(/\s+/g, ' ').trim()
  if (rule === SeoSearchTexts.query || marketLabel === null) return text
  const region = marketRegionName(marketLabel.replace(/\s+/g, ' '))
  if (!region) return text
  const suffix = `, ${region}`
  if (text.length <= suffix.length || text.slice(-suffix.length).toLowerCase() !== suffix.toLowerCase()) return text
  return text.slice(0, -suffix.length).trim()
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
  marketRankings: z.number().int().nonnegative(),
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
/**
 * Market-rankings outcome filters: one outcome, `needs-work` (ranks 11 and deeper or
 * not ranked: everything off page 1 that has a result), or `rival-ahead`.
 */
export const seoMarketRankingFilterSchema = z.enum(['needs-work', 'page-1', 'ranks-11-20', 'ranks-21-plus', 'not-ranked', 'rival-ahead', 'failed', 'not-run'])
export const SeoMarketRankingFilters = seoMarketRankingFilterSchema.enum
export type SeoMarketRankingFilter = z.infer<typeof seoMarketRankingFilterSchema>
/**
 * Market-rankings row order. `market` (the default) reads region, market, then search
 * text. `rank` puts the best rank first, then queries not in the results with the
 * strongest rival first, then searches with no result; `-rank` puts queries not in the
 * results first, then the worst rank. `query` and `-query` order by query text.
 */
export const seoMarketRankingSortSchema = z.enum(['market', 'rank', '-rank', 'query', '-query'])
export const SeoMarketRankingSorts = seoMarketRankingSortSchema.enum
export type SeoMarketRankingSort = z.infer<typeof seoMarketRankingSortSchema>
/** Market-rankings evidence narrows to one market or one region (both apply when given), an outcome and query text. */
export const seoMarketRankingQuerySchema = seoEvidenceQuerySchema.extend({
  marketKey: z.string().min(1).max(200).optional(),
  regionKey: z.string().min(1).max(200).optional(),
  outcome: seoMarketRankingFilterSchema.optional(),
  /** Case-insensitive text found in the query, its searched text or its market label. */
  q: z.string().trim().min(1).max(200).optional(),
  sort: seoMarketRankingSortSchema.optional(),
}).strict()
export type SeoMarketRankingQuery = z.infer<typeof seoMarketRankingQuerySchema>
/** One page of rows in the requested order (region, market and search text by default). */
export const seoMarketRankingListSchema = z.object({ ...seoPageShape, items: z.array(seoMarketRankingSchema) }).strict()
export type SeoMarketRankingList = z.infer<typeof seoMarketRankingListSchema>

/** Rows by outcome. The outcome counts add up to `queries`; `needsWork` is ranks 11-20 plus 21 and deeper plus not ranked. */
export const seoMarketRankingCountsSchema = z.object({
  queries: z.number().int().nonnegative(),
  page1: z.number().int().nonnegative(),
  ranks11To20: z.number().int().nonnegative(),
  ranks21Plus: z.number().int().nonnegative(),
  notRanked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  notRun: z.number().int().nonnegative(),
  needsWork: z.number().int().nonnegative(),
  /** Rows where a tracked competitor ranks above the target; overlaps the outcome counts. */
  rivalAhead: z.number().int().nonnegative(),
}).strict()
export type SeoMarketRankingCounts = z.infer<typeof seoMarketRankingCountsSchema>
export const seoMarketRankingGroupKindSchema = z.enum(['region', 'market'])
export const SeoMarketRankingGroupKinds = seoMarketRankingGroupKindSchema.enum
export type SeoMarketRankingGroupKind = z.infer<typeof seoMarketRankingGroupKindSchema>
/** One region (a metro) or one market with its rows' counts. */
export const seoMarketRankingGroupSchema = z.object({
  key: z.string(), label: z.string(), kind: seoMarketRankingGroupKindSchema, counts: seoMarketRankingCountsSchema,
}).strict()
export type SeoMarketRankingGroup = z.infer<typeof seoMarketRankingGroupSchema>
/** A summary narrows to one region or one market; with neither it covers the whole profile. */
export const seoMarketRankingSummaryQuerySchema = seoEvidenceQuerySchema.pick({ profileId: true, runId: true }).extend({
  marketKey: z.string().min(1).max(200).optional(),
  regionKey: z.string().min(1).max(200).optional(),
}).strict()
export type SeoMarketRankingSummaryQuery = z.infer<typeof seoMarketRankingSummaryQuerySchema>
/**
 * Outcome counts for the selected scope and the groups under it: regions for the
 * whole profile (markets without a region stand alone), markets within one region,
 * none within one market. Groups come in needs-work order: most ranks 11-20, then
 * most ranks 21 and deeper, then label. `depth` is the results each search checks.
 */
export const seoMarketRankingSummarySchema = z.object({
  runId: z.string().nullable(), depth: z.number().int().positive().nullable(),
  regionKey: z.string().nullable(), marketKey: z.string().nullable(),
  /** Names of the selected region and market; null when none is selected or the refresh has no rows for it. */
  regionLabel: z.string().nullable(), marketLabel: z.string().nullable(),
  totals: seoMarketRankingCountsSchema, groups: z.array(seoMarketRankingGroupSchema),
}).strict()
export type SeoMarketRankingSummary = z.infer<typeof seoMarketRankingSummarySchema>
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
  /** Rows the market-rankings read returns for the evidence refresh, searches that failed or never ran included. */
  marketRankingCount: z.number().int().nonnegative(),
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

/** One market and tracked query a market-rankings search answers, with the competitors its row reports. */
export interface SeoMarketRankingSearchMarket {
  context: SeoMarketRankingContext
  /**
   * Registrable domains of the competitors tracked for this query in this market: the project's,
   * plus those pinned to the Advanced groups whose Properties ask it. Markets that share a search
   * can track different competitors, so each row reports only its own.
   */
  competitors: string[]
}

/** One market-rankings search: how it runs and which markets and queries it answers. */
export interface SeoMarketRankingSearch {
  device: SeoDevice
  depth: number
  locationLabel: string
  markets: SeoMarketRankingSearchMarket[]
}

/** Internal adapter boundary. These cost fields never enter customer DTOs. */
export interface SeoAdapterRequest {
  capability: SeoCapability
  target: SeoTarget | null
  keywords: string[]
  locationCode: number
  languageCode: string
  limit: number
  tag: string
  /** Market rankings only: `keywords` holds the one search text, searched at `locationCode`. */
  search?: SeoMarketRankingSearch
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
  /**
   * A failed request the source says may succeed if sent again (a search engine error
   * on its side). The repository runs one new, separately reserved attempt at the end
   * of the refresh; never set for an uncertain or partly accepted request.
   */
  retryable?: boolean
}
export interface SeoAdapter {
  readonly provider: z.infer<typeof seoProviderSchema>
  /** Stable non-secret funding identity shared by aliases of the same account. */
  readonly accountKey: string
  readonly capabilities: readonly SeoCapability[]
  estimate(request: SeoAdapterRequest): SeoAdapterEstimate
  execute(request: SeoAdapterRequest, options?: { signal?: AbortSignal }): Promise<SeoAdapterResult>
}
