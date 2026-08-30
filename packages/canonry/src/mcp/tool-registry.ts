import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import {
  AGENT_MEMORY_KEY_MAX_LENGTH,
  AGENT_MEMORY_VALUE_MAX_BYTES,
  adsAdCreateRequestSchema,
  adsAdGroupCreateRequestSchema,
  adsAdGroupUpdateRequestSchema,
  adsAdUpdateRequestSchema,
  adsCampaignCreateRequestSchema,
  adsActivateTreeRequestSchema,
  adsCampaignUpdateRequestSchema,
  adsGeoSearchQuerySchema,
  adsImageUploadRequestSchema,
  adsOperationReconcileRequestSchema,
  adsPauseRequestSchema,
  adsUnresolvedOperationListQuerySchema,
  competitorBatchRequestSchema,
  DISCOVERY_MAX_PROBES_CAP,
  DISCOVERY_PROBE_CONCURRENCY_CAP,
  discoveryBucketSchema,
  discoveryCompetitorTypeSchema,
  discoveryPromoteRequestSchema,
  discoveryRunRequestSchema,
  researchPromotionPreviewRequestSchema,
  researchRunCreateSchema,
  keywordBatchRequestSchema,
  keywordGenerateRequestSchema,
  gaMeasurementAnalysisWindowSchema,
  gaMeasurementHostScopeSchema,
  queryGenerateRequestSchema,
  queryBatchRequestSchema,
  notificationCreateRequestSchema,
  notificationEventSchema,
  projectConfigSchema,
  projectUpsertRequestSchema,
  runTriggerRequestSchema,
  backlinkSourceSchema,
  organicEvidencePeriodSchema,
  reportPeriodSchema,
  schedulableRunKindSchema,
  scheduleUpsertRequestSchema,
  trafficConnectCloudRunRequestSchema,
  trafficConnectWordpressRequestSchema,
  trafficConnectVercelRequestSchema,
  trafficEventKindSchema,
  trafficSeriesGranularitySchema,
  measurementPlanAuthoringSchema,
  measurementPlanPublishRequestSchema,
  measurementDiscoveryRequestSchema,
  measurementDraftCollectionQuerySchema,
  measurementOverviewQuerySchema,
  measurementPortfolioSummaryQuerySchema,
  measurementPropertyQuestionsQuerySchema,
  measurementQuestionResultQuerySchema,
  measurementPropertyCompetitorsQuerySchema,
  measurementChangesQuerySchema,
  measurementDataQualityQuerySchema,
  measurementPropertyEvidenceQuerySchema,
  measurementPlanDeactivateRequestSchema,
  measurementQuerySetUpsertRequestSchema,
  measurementQueryTemplateApplyRequestSchema,
  measurementQueryTemplateUpsertRequestSchema,
  GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX,
  googleAdsMetricsWindowSchema,
  canonicalizeGtmAccountId,
  canonicalizeGtmResourceSelection,
  type NotificationEvent,
  describeError,
} from '@ainyc/canonry-contracts'
import { z } from 'zod'
import type { ApiClient } from '../client.js'
import { CliError, EXIT_SYSTEM_ERROR } from '../cli-error.js'
import {
  measurementDraftOperationSchema as sharedMeasurementDraftOperationSchema,
  runMeasurementDraftAction as runSharedMeasurementDraftAction,
} from '../measurement-draft-actions.js'
import { gscPerformanceOrderBySchema } from '@ainyc/canonry-contracts'
import {
  analyticsWindowSchema,
  compactStringParams,
  emptyInputSchema,
  insightIdSchema,
  projectInputSchema,
  projectNameSchema,
  runIdSchema,
  toJsonSchema,
  uniqueStrings,
} from './schema.js'
import type { CanonryMcpTier } from './toolkits.js'

export type McpToolAccess = 'read' | 'write'

export interface CanonryMcpTool<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TName extends string = string,
> {
  name: TName
  title: string
  description: string
  access: McpToolAccess
  tier: CanonryMcpTier
  inputSchema: TSchema
  inputJsonSchema: unknown
  annotations: ToolAnnotations
  openApiOperations: string[]
  handler: (client: ApiClient, input: z.infer<TSchema>) => Promise<unknown>
}

const readAnnotations = (openWorldHint?: boolean): ToolAnnotations => ({
  readOnlyHint: true,
  ...(openWorldHint ? { openWorldHint } : {}),
})

const writeAnnotations = (opts: { idempotentHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean }): ToolAnnotations => ({
  readOnlyHint: false,
  idempotentHint: opts.idempotentHint,
  destructiveHint: Boolean(opts.destructiveHint),
  ...(opts.openWorldHint ? { openWorldHint: opts.openWorldHint } : {}),
})

function defineTool<TSchema extends z.ZodTypeAny, TName extends string>(
  tool: Omit<CanonryMcpTool<TSchema, TName>, 'inputJsonSchema'>,
): CanonryMcpTool<TSchema, TName> {
  return {
    ...tool,
    inputJsonSchema: toJsonSchema(tool.inputSchema, tool.name),
  }
}

const runTriggerInputSchema = z.object({
  project: projectNameSchema,
  request: runTriggerRequestSchema.optional(),
})
const measurementPlanVersionInputSchema = z.object({ project: projectNameSchema, revision: z.number().int().positive() })
const measurementReportInputSchema = measurementPlanVersionInputSchema.extend({
  runId: runIdSchema.optional().describe('Exact eligible full measurement run to reconstruct. Omit for the latest run in the revision.'),
})
const measurementPlanPreviewInputSchema = z.object({ project: projectNameSchema, plan: measurementPlanAuthoringSchema })
const measurementPlanPublishInputSchema = measurementPlanPublishRequestSchema.extend({ project: projectNameSchema })
const measurementPlanRetireInputSchema = z.object({ project: projectNameSchema, stableKey: z.string().min(1) })
const measurementDiscoveryInputSchema = measurementDiscoveryRequestSchema.extend({ project: projectNameSchema })
const idempotencyKeyInputSchema = z.string().trim().min(1).describe('A fresh request key. Reuse it only when retrying the identical request.')
const measurementOverviewInputSchema = z.object({
  project: projectNameSchema,
  scope: measurementOverviewQuerySchema.shape.scope.describe('Read all Properties, one reporting group, or one Property.'),
  groupKey: measurementOverviewQuerySchema.shape.groupKey.describe('Group stable key. Required only for group scope.'),
  targetKey: measurementOverviewQuerySchema.shape.targetKey.describe('Property stable key. Required only for property scope.'),
  queryClass: measurementOverviewQuerySchema.shape.queryClass,
  provider: measurementOverviewQuerySchema.shape.provider,
  location: measurementOverviewQuerySchema.shape.location,
  from: measurementOverviewQuerySchema.shape.from,
  to: measurementOverviewQuerySchema.shape.to,
  runId: measurementOverviewQuerySchema.shape.runId,
  search: measurementOverviewQuerySchema.shape.search,
  sort: measurementOverviewQuerySchema.shape.sort,
  cursor: measurementOverviewQuerySchema.shape.cursor,
  limit: measurementOverviewQuerySchema.shape.limit,
}).strict().superRefine((input, context) => {
  if (input.scope === 'group' && !input.groupKey) {
    context.addIssue({ code: 'custom', path: ['groupKey'], message: 'Group scope requires groupKey.' })
  }
  if (input.scope === 'property' && !input.targetKey) {
    context.addIssue({ code: 'custom', path: ['targetKey'], message: 'Property scope requires targetKey.' })
  }
  if (input.scope !== 'group' && input.groupKey) {
    context.addIssue({ code: 'custom', path: ['groupKey'], message: `${input.scope} scope does not accept groupKey.` })
  }
  if (input.scope !== 'property' && input.targetKey) {
    context.addIssue({ code: 'custom', path: ['targetKey'], message: `${input.scope} scope does not accept targetKey.` })
  }
})
const measurementPropertyEvidenceInputSchema = measurementPropertyEvidenceQuerySchema.extend({
  project: projectNameSchema,
  targetKey: measurementPropertyEvidenceQuerySchema.shape.targetKey.describe('Property stable key. Required — this read is scoped to exactly one Property.'),
  shape: measurementPropertyEvidenceQuerySchema.shape.shape.describe(
    'What one row is. Omit for sources (one row per cited URL). answers gives one row per measured answer with its cited URLs nested, including the answers that cited nothing.',
  ),
}).strict()
const measurementPortfolioSummaryInputSchema = measurementPortfolioSummaryQuerySchema.extend({
  project: projectNameSchema,
}).strict()
const measurementPropertyQuestionsInputSchema = measurementPropertyQuestionsQuerySchema.extend({
  project: projectNameSchema,
}).strict()
const measurementQuestionResultInputSchema = measurementQuestionResultQuerySchema.extend({
  project: projectNameSchema,
}).strict()
const measurementPropertyCompetitorsInputSchema = measurementPropertyCompetitorsQuerySchema.extend({
  project: projectNameSchema,
}).strict()
const measurementChangesInputSchema = measurementChangesQuerySchema.extend({
  project: projectNameSchema,
}).strict()
const measurementDataQualityInputSchema = measurementDataQualityQuerySchema.extend({
  project: projectNameSchema,
}).strict()
const measurementDraftCollectionInputSchema = measurementDraftCollectionQuerySchema.extend({ project: projectNameSchema })
const measurementQuerySetInputSchema = z.object({
  project: projectNameSchema,
  setId: z.string().trim().min(1),
}).strict()
const measurementQuerySetUpsertInputSchema = measurementQuerySetInputSchema.extend({
  request: measurementQuerySetUpsertRequestSchema,
}).strict()
const measurementQueryTemplateInputSchema = z.object({
  project: projectNameSchema,
  templateId: z.string().trim().min(1),
}).strict()
const measurementQueryTemplateUpsertInputSchema = measurementQueryTemplateInputSchema.extend({
  request: measurementQueryTemplateUpsertRequestSchema,
}).strict()
const measurementQueryTemplateApplyInputSchema = measurementQueryTemplateInputSchema.extend({
  request: measurementQueryTemplateApplyRequestSchema,
  idempotencyKey: idempotencyKeyInputSchema,
}).strict()
const measurementPlanDeactivateInputSchema = measurementPlanDeactivateRequestSchema.extend({
  project: projectNameSchema,
  idempotencyKey: idempotencyKeyInputSchema,
}).strict()

// The MCP SDK advertises only top-level object schemas. Nesting the union keeps
// that envelope compatible while preserving action/request/header correlation
// in the live listTools schema consumed by unfamiliar agents and Aero.
const measurementDraftActionInputSchema = z.object({
  project: projectNameSchema,
  operation: sharedMeasurementDraftOperationSchema.describe('Typed draft operation. Select exactly one action branch.'),
}).strict()

const measurementDraftActionOpenApiOperations = [
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/create',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/import-sitemap',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/apply-sitemap-selection',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/upsert-target',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/rename-target',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/merge-targets',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/exclude-target',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/rebind-target',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/apply-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/replace-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/apply-paired-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/remove-assignment',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/clear-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/classify-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/upsert-group',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/remove-group',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-group-membership',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/apply-group-membership',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/upsert-competitor',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/remove-competitor',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/compile-preview',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/diff-preview',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/publish',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/discard',
]

const runsListInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(500).optional(),
})

const runGetInputSchema = z.object({
  runId: runIdSchema,
})

const timelineInputSchema = z.object({
  project: projectNameSchema,
  location: z.string().optional().describe('Location label. Use an empty string for locationless results.'),
  limit: z.number().int().positive().max(100).optional().describe('Restrict history to the most recent N project runs.'),
})

const historyFilterShape = {
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
  since: z.string().optional().describe('ISO 8601 lower bound.'),
  action: z.string().optional().describe('Exact audit action filter.'),
  actor: z.string().optional().describe('Exact actor filter.'),
  entityType: z.string().optional().describe('Exact entity type filter.'),
}

const projectHistoryInputSchema = z.object({ project: projectNameSchema, ...historyFilterShape })
const globalHistoryInputSchema = z.object(historyFilterShape)

const snapshotsListInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
  location: z.string().optional().describe('Location label. Use an empty string for locationless results.'),
})

const snapshotsDiffInputSchema = z.object({
  project: projectNameSchema,
  run1: runIdSchema,
  run2: runIdSchema,
})

const insightsListInputSchema = z.object({
  project: projectNameSchema,
  dismissed: z.boolean().optional(),
  runId: runIdSchema.optional(),
})

const insightInputSchema = z.object({
  project: projectNameSchema,
  insightId: insightIdSchema,
})

const healthHistoryInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(100).optional(),
})

const gscPerformanceInputSchema = z.object({
  project: projectNameSchema,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  query: z.string().optional(),
  page: z.string().optional(),
  limit: z.number().int().positive().max(5000).optional(),
  offset: z.number().int().nonnegative().optional(),
  orderBy: gscPerformanceOrderBySchema.optional(),
  window: analyticsWindowSchema.optional(),
})

const gscPerformanceDailyInputSchema = z.object({
  project: projectNameSchema,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  window: analyticsWindowSchema.optional(),
})

const gscTopPagesInputSchema = z.object({
  project: projectNameSchema,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  window: analyticsWindowSchema.optional(),
})

const gscInspectionsInputSchema = z.object({
  project: projectNameSchema,
  url: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
})

const gscCoverageHistoryInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(500).optional(),
})

const gscSitemapsInputSchema = z.object({
  project: projectNameSchema,
  sitemapIndex: z.string().url().optional(),
})

const gscSitemapsSubmitInputSchema = z.union([
  z.object({
    project: projectNameSchema,
    sitemapUrls: z.array(z.string().url()).min(1).max(50),
  }).strict(),
  z.object({
    project: projectNameSchema,
    mode: z.enum(['indexes', 'all-files']),
  }).strict(),
])

type GscSitemapsSubmitInput = z.infer<typeof gscSitemapsSubmitInputSchema>

async function submitGscSitemapsFromMcp(
  client: ApiClient,
  input: GscSitemapsSubmitInput,
): Promise<Awaited<ReturnType<ApiClient['gscSubmitSitemaps']>>> {
  let sitemapUrls: string[]
  if ('sitemapUrls' in input) {
    sitemapUrls = uniqueStrings(input.sitemapUrls)
  } else {
    const topLevel = await client.gscSitemaps(input.project)
    if (input.mode === 'indexes') {
      sitemapUrls = uniqueStrings(
        topLevel.preferredSubmissionUrls.length > 0
          ? topLevel.preferredSubmissionUrls
          : topLevel.sitemaps.map((sitemap) => sitemap.path),
      )
    } else {
      const indexes = topLevel.sitemaps
        .filter((sitemap) => sitemap.isSitemapsIndex)
        .map((sitemap) => sitemap.path)
      const expandedIndexUrls: string[] = []
      for (let offset = 0; offset < indexes.length; offset += 4) {
        const children = await Promise.all(
          indexes.slice(offset, offset + 4).map(
            (sitemapIndex) => client.gscSitemaps(input.project, { sitemapIndex }),
          ),
        )
        children.forEach((result, index) => {
          const sitemapIndex = indexes[offset + index]!
          expandedIndexUrls.push(...(
            result.sitemaps.length > 0
              ? result.sitemaps.map((sitemap) => sitemap.path)
              : [sitemapIndex]
          ))
        })
      }
      sitemapUrls = uniqueStrings([
        ...topLevel.sitemaps
          .filter((sitemap) => !sitemap.isSitemapsIndex)
          .map((sitemap) => sitemap.path),
        ...expandedIndexUrls,
      ])
    }
  }

  if (sitemapUrls.length === 0) {
    throw new Error('No GSC sitemaps found. Submit an explicit sitemap URL first.')
  }

  const aggregate: Awaited<ReturnType<ApiClient['gscSubmitSitemaps']>> = {
    summary: { total: 0, accepted: 0, failed: 0 },
    results: [],
  }
  for (let offset = 0; offset < sitemapUrls.length; offset += 50) {
    const batchSitemapUrls = sitemapUrls.slice(offset, offset + 50)
    try {
      const result = await client.gscSubmitSitemaps(input.project, {
        sitemapUrls: batchSitemapUrls,
      })
      aggregate.summary.total += result.summary.total
      aggregate.summary.accepted += result.summary.accepted
      aggregate.summary.failed += result.summary.failed
      aggregate.results.push(...result.results)
    } catch (cause) {
      if (offset === 0) throw cause
      const attempted = aggregate.summary.total + batchSitemapUrls.length
      const remaining = sitemapUrls.length - attempted
      throw new CliError({
        code: 'GOOGLE_SITEMAP_SUBMISSION_PARTIAL',
        message: `Sitemap submission stopped after ${aggregate.summary.total} completed results; ${batchSitemapUrls.length} are unconfirmed and ${remaining} were not attempted.`,
        exitCode: cause instanceof CliError && cause.exitCode === 1 ? 1 : EXIT_SYSTEM_ERROR,
        details: {
          project: input.project,
          accepted: aggregate.summary.accepted,
          failed: aggregate.summary.failed,
          completed: aggregate.summary.total,
          attempted,
          unconfirmed: batchSitemapUrls.length,
          remaining,
          unconfirmedBatch: { index: Math.floor(offset / 50) + 1, sitemapUrls: batchSitemapUrls },
          partialResult: aggregate,
          cause: cause instanceof CliError
            ? { code: cause.code, message: cause.message, details: cause.details }
            : { message: describeError(cause) },
        },
      })
    }
  }
  return aggregate
}

// `window` is rolling from now and cannot name a calendar month, so every
// date-scoped GA read also takes explicit YYYY-MM-DD bounds. Explicit dates win
// over `window` server-side.
const gaWindowInputSchema = z.object({
  project: projectNameSchema,
  window: analyticsWindowSchema.optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
})

const GA_RANGE_PARAMS = ['window', 'startDate', 'endDate'] as const

const gaTrafficInputSchema = gaWindowInputSchema.extend({
  limit: z.number().int().positive().max(500).optional(),
})

const gaMeasurementAnalysisInputSchema = z.object({
  project: projectNameSchema,
  window: gaMeasurementAnalysisWindowSchema.optional(),
  hostScope: gaMeasurementHostScopeSchema.optional(),
  pathPrefix: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
})

const queriesInputSchema = z.object({
  project: projectNameSchema,
  request: queryBatchRequestSchema,
})

const queryGenerateInputSchema = z.object({
  project: projectNameSchema,
  request: queryGenerateRequestSchema,
})

const gbpListLocationsInputSchema = z.object({
  project: projectNameSchema,
  selected: z.boolean().optional(),
})

const gbpDiscoverInputSchema = z.object({
  project: projectNameSchema,
  selectAllNew: z.boolean().optional().default(true),
  accountName: z.string().regex(/^accounts\//, 'accountName must be a Google resource name like "accounts/12345"').optional(),
  switchAccount: z.boolean().optional().default(false),
})

const gbpLocationSelectionInputSchema = z.object({
  project: projectNameSchema,
  locationName: z.string().min(1).regex(/^locations\//, 'locationName must be a Google resource name like "locations/12345"'),
  selected: z.boolean(),
})

const gbpSyncInputSchema = z.object({
  project: projectNameSchema,
  locationNames: z.array(z.string()).optional(),
  daysOfMetrics: z.number().int().positive().max(540).optional(),
  monthsOfKeywords: z.number().int().positive().max(18).optional(),
})

const gbpMetricsInputSchema = z.object({
  project: projectNameSchema,
  locationName: z.string().optional(),
  metric: z.string().optional(),
})

const gbpLocationScopedInputSchema = z.object({
  project: projectNameSchema,
  locationName: z.string().optional(),
})

const gbpAccountsInputSchema = z.object({
  project: projectNameSchema,
})

const adsInsightsInputSchema = z.object({
  project: projectNameSchema,
  level: z.enum(['campaign', 'ad_group']).optional(),
  entityId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})

const adsGeoSearchInputSchema = adsGeoSearchQuerySchema.extend({
  project: projectNameSchema,
})

const adsLiveDeliveryInputSchema = z.object({
  project: projectNameSchema,
  campaignId: z.string().min(1).max(200).optional(),
  lookbackDays: z.number().int().min(1).max(30).optional(),
})

const adsOperationInputSchema = z.object({
  project: projectNameSchema,
  operationKey: z.string().min(8).max(128),
})

const adsOperationResumeActivationInputSchema = adsOperationInputSchema.strict()

const adsUnresolvedOperationsInputSchema = adsUnresolvedOperationListQuerySchema.extend({
  project: projectNameSchema,
})

const adsOperationReconcileInputSchema = adsOperationReconcileRequestSchema.extend({
  project: projectNameSchema,
  operationKey: z.string().min(8).max(128),
})

const adsImageUploadInputSchema = z.object({
  project: projectNameSchema,
  request: adsImageUploadRequestSchema,
})

const adsCampaignCreateInputSchema = z.object({
  project: projectNameSchema,
  request: adsCampaignCreateRequestSchema,
})

const adsCampaignUpdateInputSchema = z.object({
  project: projectNameSchema,
  campaignId: z.string().min(1),
  request: adsCampaignUpdateRequestSchema,
})

const adsCampaignActivateTreeInputSchema = z.object({
  project: projectNameSchema,
  campaignId: z.string().min(1),
  request: adsActivateTreeRequestSchema,
})

const adsCampaignPauseInputSchema = z.object({
  project: projectNameSchema,
  campaignId: z.string().min(1),
  request: adsPauseRequestSchema,
})

const adsAdGroupCreateInputSchema = z.object({
  project: projectNameSchema,
  request: adsAdGroupCreateRequestSchema,
})

const adsAdGroupUpdateInputSchema = z.object({
  project: projectNameSchema,
  adGroupId: z.string().min(1),
  request: adsAdGroupUpdateRequestSchema,
})

const adsAdGroupPauseInputSchema = z.object({
  project: projectNameSchema,
  adGroupId: z.string().min(1),
  request: adsPauseRequestSchema,
})

const adsAdCreateInputSchema = z.object({
  project: projectNameSchema,
  request: adsAdCreateRequestSchema,
})

const adsAdUpdateInputSchema = z.object({
  project: projectNameSchema,
  adId: z.string().min(1),
  request: adsAdUpdateRequestSchema,
})

const adsAdPauseInputSchema = z.object({
  project: projectNameSchema,
  adId: z.string().min(1),
  request: adsPauseRequestSchema,
})

// Google Marketing keeps Google Ads and GTM explicit: `ads` remains the
// OpenAI/ChatGPT Ads surface. OAuth, resource selection, disconnect, and
// conversion-contract mutations remain deliberate operator actions outside
// MCP. These schemas cover the agent-safe stored/live/sync/integrity reads.
const googleMarketingSnapshotPageInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().min(1).max(GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX).optional(),
  cursor: z.string().trim().min(1).optional(),
}).strict()

const googleAdsPerformanceInputSchema = z.object({
  project: projectNameSchema,
  window: googleAdsMetricsWindowSchema.optional(),
}).strict()

const googleMarketingSnapshotInputSchema = z.object({
  project: projectNameSchema,
  snapshotId: z.string().trim().min(1),
}).strict()

const gtmAccountInputSchema = z.object({
  project: projectNameSchema,
  accountId: z.string().trim().min(1),
}).strict().superRefine((input, context) => {
  if (!canonicalizeGtmAccountId(input.accountId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accountId'],
      message: 'Expected a safe GTM account ID or accounts/{id} resource path.',
    })
  }
})

const gtmContainerInputSchema = z.object({
  project: projectNameSchema,
  accountId: z.string().trim().min(1),
  containerId: z.string().trim().min(1),
}).strict().superRefine((input, context) => {
  if (!canonicalizeGtmResourceSelection(input)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['containerId'],
      message: 'Expected matching safe GTM account/container IDs or resource paths.',
    })
  }
})

function canonicalGtmMcpAccountId(accountId: string): string {
  const canonical = canonicalizeGtmAccountId(accountId)
  if (!canonical) throw new Error('Invalid GTM account input.')
  return canonical
}

function canonicalGtmMcpSelection(accountId: string, containerId: string): {
  accountId: string
  containerId: string
} {
  const canonical = canonicalizeGtmResourceSelection({ accountId, containerId })
  if (!canonical) throw new Error('Invalid GTM account/container input.')
  return canonical
}

const conversionTrackingContractInputSchema = z.object({
  project: projectNameSchema,
  contractId: z.string().trim().min(1),
}).strict()

const keywordsInputSchema = z.object({
  project: projectNameSchema,
  request: keywordBatchRequestSchema,
})

const keywordGenerateInputSchema = z.object({
  project: projectNameSchema,
  request: keywordGenerateRequestSchema,
})

const competitorsInputSchema = z.object({
  project: projectNameSchema,
  request: competitorBatchRequestSchema,
})

const projectUpsertInputSchema = z.object({
  project: projectNameSchema,
  request: projectUpsertRequestSchema,
})

const applyConfigInputSchema = z.object({
  config: projectConfigSchema,
})

const scheduleSetInputSchema = z.object({
  project: projectNameSchema,
  schedule: scheduleUpsertRequestSchema,
})

const scheduleReadInputSchema = z.object({
  project: projectNameSchema,
  kind: schedulableRunKindSchema.optional().describe('Schedulable run kind. Defaults to "answer-visibility" if omitted.'),
})

const agentWebhookAttachInputSchema = z.object({
  project: projectNameSchema,
  url: z.string().url(),
})

const doctorInputSchema = z.object({
  project: projectNameSchema.optional().describe('Project name to scope project-level checks. Omit to run global checks (provider keys, config, etc.).'),
  checks: z.array(z.string().min(1)).optional().describe('Optional check IDs or wildcard prefixes (e.g. "google.auth.*", "config.providers"). Empty/omitted runs all matching checks for the chosen scope.'),
})

const contentTargetsInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(500).optional().describe('Max rows. Defaults to all. Use a small number (3-10) when summarizing for the user.'),
  includeInProgress: z.boolean().optional().describe('Include rows that already have an in-flight tracked action. Default false.'),
  winnabilityClass: z.enum(['ownable', 'ceded']).optional().describe('Filter by winnability: "ownable" (worth a brief) or "ceded" (aggregator/editorial head term to skip).'),
  ownable: z.boolean().optional().describe('Convenience: when true, return only ownable targets (same as winnabilityClass="ownable").'),
})

const contentBriefInputSchema = z.object({
  project: projectNameSchema,
  targetRef: z.string().min(1).describe('Stable target ref from canonry_content_targets. The target must be ownable; ceded targets are rejected.'),
  provider: z.string().optional().describe('Optional provider override (claude|openai|gemini|zai|deepinfra).'),
  model: z.string().optional().describe('Optional model override within the chosen provider.'),
  forceRefresh: z.boolean().optional().describe('Force a fresh synthesis even if a cached brief exists.'),
})

const contentMapInputSchema = z.object({
  project: projectNameSchema,
})

const backlinksDomainsInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(200).optional().describe('Max linking-domain rows. Default 50, max 200.'),
  release: z.string().optional().describe('Common Crawl release id, e.g. cc-main-2026-jan-feb-mar. Omit for the most recent release with data.'),
  source: backlinkSourceSchema.optional().describe('Stored source. Common Crawl is active; bing-webmaster is historical-only.'),
})

const backlinksSourcesInputSchema = z.object({
  project: projectNameSchema,
})

const memoryUpsertInputSchema = z.object({
  project: projectNameSchema,
  key: z.string().min(1).max(AGENT_MEMORY_KEY_MAX_LENGTH).describe(`Stable identifier for the note (max ${AGENT_MEMORY_KEY_MAX_LENGTH} chars). Writing the same key overwrites the prior value.`),
  value: z.string().min(1).describe(`Plain-text note body (max ${AGENT_MEMORY_VALUE_MAX_BYTES} bytes). Use for durable operator preferences, migration context, or non-obvious reasoning that should survive future sessions.`),
})

const memoryForgetInputSchema = z.object({
  project: projectNameSchema,
  key: z.string().min(1).max(AGENT_MEMORY_KEY_MAX_LENGTH).describe('Exact key of the note to remove. No-op (status=missing) when no note exists for that key.'),
})

const trafficConnectCloudRunInputSchema = z.object({
  project: projectNameSchema,
  request: trafficConnectCloudRunRequestSchema,
})

const trafficConnectWordpressInputSchema = z.object({
  project: projectNameSchema,
  request: trafficConnectWordpressRequestSchema,
})

const trafficConnectVercelInputSchema = z.object({
  project: projectNameSchema,
  request: trafficConnectVercelRequestSchema,
})

const trafficSyncInputSchema = z.object({
  project: projectNameSchema,
  sourceId: z.string().min(1).describe('Traffic source ID returned by canonry_traffic_connect_cloud_run or canonry_traffic_sources_list.'),
  sinceMinutes: z
    .number()
    .int()
    .positive()
    .max(365 * 24 * 60)
    .optional()
    .describe('Optional lookback in minutes. Defaults are adapter-specific and clamp forward to lastSyncedAt; a new or idle WordPress source uses 365d to cover the plugin’s maximum configurable retention.'),
})

const trafficBackfillInputSchema = z.object({
  project: projectNameSchema,
  sourceId: z.string().min(1).describe('Traffic source ID returned by canonry_traffic_sources_list.'),
  days: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe('Lookback window in days. Default 30, capped by the adapter at 90d. Generic WordPress replace backfill is unavailable because retained coverage is unproven.'),
})

const trafficResetInputSchema = z.object({
  project: projectNameSchema,
  sourceId: z.string().min(1).describe('Traffic source ID returned by canonry_traffic_sources_list.'),
  advanceToNow: z
    .literal(true)
    .describe('Must be `true`. Explicit gate against accidental resets. Advances lastSyncedAt to NOW and clears the source\'s error state; WordPress also clears its continuation state and records an unrecovered span that needs retention-aware repair.'),
})

const trafficEventsInputSchema = z.object({
  project: projectNameSchema,
  since: z.string().optional().describe('ISO 8601 lower bound. Defaults to 24h ago when omitted.'),
  until: z.string().optional().describe('ISO 8601 upper bound. Defaults to now when omitted.'),
  kind: z.union([trafficEventKindSchema, z.literal('all')]).optional().describe('Filter to one traffic kind; "all" (default) returns every kind.'),
  sourceId: z.string().min(1).optional().describe('Restrict to a single traffic source ID.'),
  limit: z.number().int().positive().max(5000).optional().describe('Max combined rows. Defaults to 500, max 5000. Totals always reflect the full window.'),
  granularity: trafficSeriesGranularitySchema.optional().describe('Full-window chart series bucket size: hour (default) or day.'),
})
// ai-referral rows and totals split sessions into paid / organic / unclassified.
// `unclassified` are rows ingested before the classifier shipped; their UTM tags
// were never persisted, so they can never be resolved. Never report them as
// organic — for an ads client that overstates earned AI traffic by their whole
// ad volume. `organic` means "no paid evidence found", not "confirmed unpaid".

const trafficSourceIdInputSchema = z.object({
  project: projectNameSchema,
  sourceId: z.string().min(1).describe('Traffic source ID.'),
})

const discoveryRunInputSchema = z.object({
  project: projectNameSchema,
  request: discoveryRunRequestSchema
    .extend({
      // Stronger descriptions for the LLM. The base Zod schema enforces the
      // upper bound; this just clarifies the meaning of each knob.
      icpDescription: z.string().min(1).optional().describe('Free-text ICP description. If omitted, the project must already have spec.icpDescription stored.'),
      buyerDescription: z.string().min(1).optional().describe('Who evaluates or buys the offering, separate from the ICP. When present, every generated query is anchored on this buyer.'),
      seedProviders: z.array(z.enum(['gemini', 'openai'])).min(1).optional().describe('Which providers generate seed candidates. Omit for the Gemini-only default; ["gemini","openai"] merges both phrasing distributions before dedup.'),
      dedupThreshold: z.number().min(0).max(1).optional().describe('Cosine similarity threshold for clustering seed candidates. Defaults to 0.85. Lower values dedupe more aggressively.'),
      maxProbes: z.number().int().positive().max(DISCOVERY_MAX_PROBES_CAP).optional().describe(`Max canonical queries to probe in this session. Default 100, hard cap ${DISCOVERY_MAX_PROBES_CAP}.`),
      probeConcurrency: z.number().int().min(1).max(DISCOVERY_PROBE_CONCURRENCY_CAP).optional().describe(`How many probes may run in parallel. Default 1 (strictly serial), hard cap ${DISCOVERY_PROBE_CONCURRENCY_CAP}. Probe rows are persisted in canonical order regardless of concurrency, so this only shortens wall-clock time.`),
    })
    .optional(),
})

const discoverySessionsListInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(200).optional().describe('Max sessions returned. Default 50.'),
})

const discoverySessionIdInputSchema = z.object({
  project: projectNameSchema,
  sessionId: z.string().min(1).describe('Discovery session ID returned by canonry_discover_run_start.'),
})

const researchRunStartInputSchema = z.object({
  project: projectNameSchema,
  request: researchRunCreateSchema.describe('One shared provider/model/location context for every free-form query in this saved research batch.'),
})

const researchRunsListInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(100).optional().describe('Max saved research runs returned. Default 20.'),
})

const researchRunIdInputSchema = z.object({
  project: projectNameSchema,
  runId: z.string().min(1).describe('Research run ID returned by canonry_research_run_start.'),
})

const researchPromotionPreviewInputSchema = z.object({
  project: projectNameSchema,
  runId: z.string().min(1).describe('Research run ID returned by canonry_research_run_start.'),
  queryId: z.string().min(1).describe('Completed saved research query ID from canonry_research_run_get.'),
  request: researchPromotionPreviewRequestSchema.describe('Optional active-v2 target/group selection and assignment query class.'),
})

const discoveryHarvestInputSchema = z.object({
  project: projectNameSchema,
  sessionId: z.string().min(1).describe('Discovery session ID returned by canonry_discover_run_start.'),
  minProbeHits: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Recurrence floor — a candidate must have appeared in at least this many distinct probes to be admitted. Default 1.'),
  anchor: z
    .boolean()
    .optional()
    .describe('Apply the subject-anchor filter that drops off-topic acronym collisions. Default true; pass false for new-subject discovery on a well-scoped project.'),
})

const discoveryPromoteInputSchema = z.object({
  project: projectNameSchema,
  sessionId: z.string().min(1).describe('Discovery session ID returned by canonry_discover_run_start.'),
  request: discoveryPromoteRequestSchema
    .extend({
      // Stronger descriptions for the LLM. The base Zod schema enforces the shape.
      buckets: z
        .array(discoveryBucketSchema)
        .min(1)
        .optional()
        .describe('Which probe buckets to adopt into the tracked basket. Omitted promotes cited + aspirational; include wasted-surface explicitly for off-ICP competitor gaps.'),
      includeCompetitors: z
        .boolean()
        .optional()
        .describe("Whether to also merge recurring discovered competitor domains into the project. Defaults to true."),
      competitorTypes: z
        .array(discoveryCompetitorTypeSchema)
        .min(1)
        .optional()
        .describe('Which classified competitor types to merge. Omitted promotes direct-competitor only; pass an explicit list to also adopt editorial-media channels or to recover legacy unknown entries. Ignored when includeCompetitors is false.'),
    })
    .optional(),
})

const technicalAeoScoreInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional().describe('Historical site-audit run ID. Omit for the latest audit.'),
})

const technicalAeoPagesInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional().describe('Historical site-audit run ID. Omit for the latest audit.'),
  status: z.enum(['success', 'error']).optional().describe('Filter to successfully-audited or errored pages.'),
  sort: z.enum(['score-asc', 'score-desc', 'url']).optional().describe('Sort order. Defaults to score-asc (worst pages first).'),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
})

const technicalAeoTrendInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(365).optional(),
})

const technicalAeoCrawlInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional().describe('Historical crawl-bearing site-audit run ID. Omit for the latest persisted crawl.'),
})

const siteHealthPageAuditInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional().describe('Historical crawl-bearing site-audit run ID. Omit for the latest persisted crawl.'),
  nodeKey: z.string().min(1).optional().describe('Exact crawl node key, as returned by Site Health page or subgraph reads.'),
  url: z.string().url().optional().describe('Exact page URL. Use this only when a crawl node key is unavailable.'),
}).refine((value) => Boolean(value.nodeKey || value.url), {
  message: 'Provide nodeKey or url.',
  path: ['nodeKey'],
}).refine((value) => !(value.nodeKey && value.url), {
  message: 'Provide nodeKey or url, not both.',
  path: ['nodeKey'],
})

const SITE_HEALTH_MCP_MAX_NODES = 25
const SITE_HEALTH_MCP_MAX_EDGES = 50

const siteHealthSubgraphInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional().describe('Historical crawl-bearing site-audit run ID. Omit for the latest complete crawl.'),
  nodeKey: z.string().min(1).optional().describe('Focus crawl node key. Omit with url to focus the crawl root.'),
  url: z.string().url().optional().describe('Focus canonical URL. Omit with nodeKey to focus the crawl root.'),
  hops: z.number().int().min(0).max(3).optional().describe('Neighborhood depth from the focus node. Keep this small.'),
  maxNodes: z.number().int().positive().max(SITE_HEALTH_MCP_MAX_NODES).default(SITE_HEALTH_MCP_MAX_NODES).describe('Hard MCP cap: at most 25 nodes. Narrow or refocus instead of loading the site.'),
  maxEdges: z.number().int().positive().max(SITE_HEALTH_MCP_MAX_EDGES).default(SITE_HEALTH_MCP_MAX_EDGES).describe('Hard MCP cap: at most 50 edges. Narrow or refocus instead of loading the site.'),
}).refine((value) => !(value.nodeKey && value.url), {
  message: 'Provide nodeKey or url, not both.',
  path: ['nodeKey'],
})

const siteHealthPathInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional().describe('Historical crawl-bearing site-audit run ID. Omit for the latest complete crawl.'),
  fromNodeKey: z.string().min(1).optional().describe('Origin node key. Omit with fromUrl to start at the crawl root.'),
  fromUrl: z.string().url().optional().describe('Origin URL. Omit with fromNodeKey to start at the crawl root.'),
  toNodeKey: z.string().min(1).optional().describe('Required destination node key.'),
  toUrl: z.string().url().optional().describe('Required destination URL.'),
  maxDepth: z.number().int().positive().max(24).optional().describe('Maximum directed-link depth to search.'),
}).refine((value) => !(value.fromNodeKey && value.fromUrl), {
  message: 'Provide fromNodeKey or fromUrl, not both.',
  path: ['fromNodeKey'],
}).refine((value) => Boolean(value.toNodeKey || value.toUrl), {
  message: 'Provide toNodeKey or toUrl.',
  path: ['toNodeKey'],
}).refine((value) => !(value.toNodeKey && value.toUrl), {
  message: 'Provide toNodeKey or toUrl, not both.',
  path: ['toNodeKey'],
})

const siteHealthChangesInputSchema = z.object({
  project: projectNameSchema,
  fromRunId: runIdSchema.optional().describe('Earlier complete crawl run ID. Omit to compare the previous complete crawl.'),
  toRunId: runIdSchema.optional().describe('Later complete crawl run ID. Omit to compare the latest complete crawl.'),
  scope: z.enum(['all', 'pages', 'links']).optional().describe('Limit the diff to page or link changes. Omit or use all for both.'),
  change: z.enum(['all', 'added', 'removed', 'changed']).optional().describe('Limit the diff to one change kind. Omit or use all for every kind.'),
  cursor: z.string().min(1).optional().describe('Opaque cursor from the previous Site Health changes result.'),
  limit: z.number().int().positive().max(25).default(25).describe('Hard MCP cap: 25 records, because each change carries before and after DTOs.'),
})

const technicalAeoCrawlPagesInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional(),
  inventoryEligible: z.boolean().optional().describe('Filter Canonry technical-inventory eligibility. This is not actual Google index coverage.'),
  fetchState: z.string().min(1).optional().describe('Filter crawler fetch state, for example html, redirect, non-html, or fetch-error.'),
  indexabilityState: z.string().min(1).optional().describe('Filter crawler-derived indexability state. This is not Google index coverage.'),
  auditState: z.string().min(1).optional().describe('Filter audit state.'),
  sort: z.enum(['url', 'path', 'score-asc', 'score-desc']).optional(),
  cursor: z.string().min(1).optional().describe('Opaque cursor from the previous crawl-pages result.'),
  limit: z.number().int().positive().max(200).optional(),
})

const technicalAeoStructureInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional(),
  parentPath: z.string().min(1).optional().describe('Path whose immediate children to list. Defaults to /. This never returns a whole site tree.'),
  cursor: z.string().min(1).optional().describe('Opaque cursor from the previous structure result.'),
  limit: z.number().int().positive().max(100).optional(),
})

const linkKindSchema = z.enum(['all', 'content', 'template']).optional().describe(
  'Restrict to content links (excludes nav, header, and footer links) or to template links only. Defaults to all. Check templateDetection before reading an empty content list as a real zero, and before comparing a count with an older scan: it says whether the split came from where each link sits in the page or from how many pages repeat it.',
)

const technicalAeoInternalLinksInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional(),
  sourceUrl: z.string().url().optional(),
  targetUrl: z.string().url().optional(),
  followable: z.boolean().optional(),
  linkKind: linkKindSchema,
  cursor: z.string().min(1).optional().describe('Opaque cursor from the previous internal-links result.'),
  limit: z.number().int().positive().max(200).optional(),
})

const technicalAeoLinkNeighborsInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional(),
  nodeKey: z.string().min(1).optional(),
  url: z.string().url().optional(),
  linkKind: linkKindSchema,
  limit: z.number().int().positive().max(100).optional(),
}).refine((value) => Boolean(value.nodeKey || value.url), {
  message: 'Provide nodeKey or url.',
  path: ['nodeKey'],
})

const technicalAeoDeadLinksInputSchema = z.object({
  project: projectNameSchema,
  runId: runIdSchema.optional(),
  cursor: z.string().min(1).optional().describe('Opaque cursor from the previous dead-links result.'),
  limit: z.number().int().positive().max(200).optional(),
})

const technicalAeoRunInputSchema = z.object({
  project: projectNameSchema,
  sitemapUrl: z.string().url().optional().describe('Override the sitemap URL. Defaults to https://<canonicalDomain>/sitemap.xml.'),
  limit: z.number().int().positive().max(2000).optional().describe('Deprecated compatibility alias for maxPages.'),
  maxPages: z.number().int().positive().max(50_000).optional().describe('Maximum pages crawled and audited. Defaults to 1,000; hard maximum 50,000.'),
  maxEdges: z.number().int().positive().max(1_000_000).optional().describe('Maximum link observations retained for this crawl. Defaults to 100,000; hard maximum 1,000,000.'),
  maxDepth: z.number().int().min(0).max(100).optional().describe('Maximum internal-link depth from the root page.'),
  checkDeadLinks: z.boolean().optional().describe('Opt in to internal dead-link checks. Omitted and false both disable checks.'),
})

const AGENT_WEBHOOK_EVENTS = [
  notificationEventSchema.enum['run.completed'],
  notificationEventSchema.enum['insight.critical'],
  notificationEventSchema.enum['insight.high'],
  notificationEventSchema.enum['citation.gained'],
] satisfies NotificationEvent[]

export const canonryMcpTools = [
  defineTool({
    name: 'canonry_projects_list',
    title: 'List Canonry projects',
    description: 'List all Canonry projects available through the configured API.',
    access: 'read',
    tier: 'core',
    inputSchema: emptyInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects'],
    handler: (client) => client.listProjects(),
  }),
  defineTool({
    name: 'canonry_project_get',
    title: 'Get project',
    description: 'Get a Canonry project by name.',
    access: 'read',
    tier: 'core',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}'],
    handler: (client, input) => client.getProject(input.project),
  }),
  defineTool({
    name: 'canonry_project_delete_preview',
    title: 'Preview project delete impact',
    description: 'Returns the cascade impact of deleting a project — how many queries, competitors, runs, snapshots, and insights would be removed, plus how many audit_log rows would be detached (project_id set NULL). Read-only. Use this BEFORE invoking project delete on any project you didn\'t create yourself; the underlying delete is irreversible.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/delete-preview'],
    handler: (client, input) => client.previewProjectDelete(input.project),
  }),
  defineTool({
    name: 'canonry_project_overview',
    title: 'Get project overview (composite)',
    description: 'One-call summary for "how is project X doing?". Returns independent mention and citation coverage, separate query-level movement for each signal, query-basket comparability with added/removed counts, latest run and health, insights, provider/model breakdowns, competitors, attention items, and recent history. Movement excludes queries not shared by both sweeps. Filterable by location and time window. Prefer this over fanning out to separate tools.',
    access: 'read',
    tier: 'core',
    inputSchema: z.object({
      project: projectNameSchema,
      location: z.string().optional().describe('Filter to runs from this location label (e.g. "Boston, MA, US"). Omit for all locations.'),
      since: z.string().optional().describe('ISO 8601 datetime — only include runs at or after this time. Omit for full history.'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/overview'],
    handler: (client, input) => client.getProjectOverview(input.project, {
      location: input.location,
      since: input.since,
    }),
  }),
  defineTool({
    name: 'canonry_report',
    title: 'Get aggregated AEO report',
    description:
      'Returns the full canonical AEO report bundle for a project — executive summary, client summary, agency diagnostics, action plan, per-query × per-provider citation matrix, competitor landscape, AI citation sources, GSC/GA4 performance, social and AI referrals, indexing health, citations trend, prioritized insights, and recommended next steps. Same payload `canonry report <project>` consumes to render audience-specific HTML. Pass `period` (7/14/30/90 days, default 30) to scope the GSC/GA4/server-activity sections and the period-over-period comparisons.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: z.object({
      project: projectNameSchema,
      period: reportPeriodSchema.optional(),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/report'],
    handler: (client, input) => client.getReport(input.project, input.period !== undefined ? { period: input.period } : undefined),
  }),
  defineTool({
    name: 'canonry_organic_evidence',
    title: 'Reconcile organic and AI evidence',
    description:
      'One-call investigation of whether organic work is gaining visibility, traffic, or AI attention. Returns source-specific 30-day GSC and GA4 cohorts, URL-agnostic page evidence, available GA4 lead-event evidence (not lead attribution), server-observed AI crawling/user-fetch/referral evidence, the latest answer-visibility sweep, source coverage, findings, and limitations. It preserves native units. Prefer this over fanning out across GSC, GA, traffic, and visibility tools.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: z.object({
      project: projectNameSchema,
      period: organicEvidencePeriodSchema.optional().describe('Evidence window: 60 or 90 days (default 90).'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/organic-evidence'],
    handler: (client, input) => client.getOrganicEvidence(input.project, input.period),
  }),
  defineTool({
    name: 'canonry_analytics_metrics',
    title: 'Get citation & mention trend',
    description:
      'Citation and mention rates over time for a project, bucketed adaptively (daily → monthly by span) and probe-excluded. Returns overall + per-provider window aggregates AND a per-bucket `byProvider` breakdown so you can read how each engine\'s cited/mentioned rate moved run-over-run — the same data the dashboard\'s "Citations & mentions over time" chart plots. Includes trend direction (improving/declining/stable) for both signals and query-set-change annotations. Filter the range with `window` (7d/30d/90d/all).',
    access: 'read',
    tier: 'monitoring',
    inputSchema: z.object({
      project: projectNameSchema,
      window: analyticsWindowSchema.optional().describe('Time range: 7d, 30d, 90d, or all (default all).'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/analytics/metrics'],
    handler: (client, input) => client.getAnalyticsMetrics(input.project, input.window),
  }),
  defineTool({
    name: 'canonry_analytics_sources',
    title: 'Get cited-source rankings',
    description:
      'Where AI engines get the facts they cite for a project. Returns the FULL ranked list of cited domains (not truncated) — each tagged with a category and an actionable surface class (own / direct-competitor / ota-aggregator / editorial-media / other) — plus a surface-class roll-up and a per-provider breakdown (each provider\'s cited-domain mix + total cited slots). The surface class is deterministic (own/competitor from project data, the rest from the source allow-list) and enriched by discovery\'s stored per-domain classifications when present — no new LLM calls. Probe-excluded, window-filterable (7d/30d/90d/all). Use `limit` to cap each ranked list to the top N domains (an explicit long-tail rollup preserves the totals). All counts/shares/classification are computed server-side.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: z.object({
      project: projectNameSchema,
      window: analyticsWindowSchema.optional().describe('Time range: 7d, 30d, 90d, or all (default all).'),
      limit: z.number().int().positive().optional().describe('Cap each ranked list to the top N domains. Omit for the full list.'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/analytics/sources'],
    handler: (client, input) => client.getAnalyticsSources(input.project, { window: input.window, limit: input.limit }),
  }),
  defineTool({
    name: 'canonry_search',
    title: 'Search project (composite)',
    description: 'Search query snapshots and intelligence insights for the given text. Looks at snapshot answer text, cited domains, raw provider responses, and insight title/query/recommendation/cause. Returns ranked hits with snippets — use it instead of paginating snapshots when you need to find a competitor mention or term.',
    access: 'read',
    tier: 'core',
    inputSchema: z.object({
      project: projectNameSchema,
      q: z.string().min(2).describe('Search term, at least 2 characters.'),
      limit: z.number().int().positive().max(50).optional().describe('Max combined hits (1-50, default 25).'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/search'],
    handler: (client, input) => client.searchProject(input.project, { q: input.q, limit: input.limit }),
  }),
  defineTool({
    name: 'canonry_doctor',
    title: 'Run health checks',
    description:
      'Run canonry health checks. With `project`, runs project-scoped checks (Google/GA auth, redirect URI, scopes, property access). Without `project`, runs global checks (provider keys, etc.). Use `checks` to filter by exact ID or wildcard prefix (e.g. ["google.auth.*"]). Returns a structured DoctorReport with per-check status, code, summary, remediation, and details — use this to diagnose Google auth failures (401/403/redirect-mismatch/principal-mismatch) without parsing logs.',
    access: 'read',
    tier: 'core',
    inputSchema: doctorInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/doctor', 'GET /api/v1/projects/{name}/doctor'],
    handler: (client, input) => client.runDoctor({ project: input.project, checkIds: input.checks }),
  }),
  defineTool({
    name: 'canonry_project_export',
    title: 'Export project config',
    description: 'Export a Canonry project in config-as-code format.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/export'],
    handler: (client, input) => client.getExport(input.project),
  }),
  defineTool({
    name: 'canonry_project_history',
    title: 'Get project history',
    description: 'Get audit history for a Canonry project.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectHistoryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/history'],
    handler: (client, input) => client.getHistory(input.project, {
      limit: input.limit,
      offset: input.offset,
      since: input.since,
      action: input.action,
      actor: input.actor,
      entityType: input.entityType,
    }),
  }),
  defineTool({
    name: 'canonry_history_global',
    title: 'Get instance history',
    description: 'Get the instance-wide audit trail, including retained entries whose project was deleted. Full-instance keys only; project-scoped keys remain limited to their project.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: globalHistoryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/history'],
    handler: (client, input) => client.getGlobalHistory(input),
  }),
  defineTool({
    name: 'canonry_runs_list',
    title: 'List project runs',
    description: "List runs for a Canonry project. Includes both real runs (trigger='manual'/'scheduled'/'config-apply'/'backfill') AND probe runs (trigger='probe'). Probe runs are operator/agent test runs that don't influence dashboard, analytics, intelligence, or notifications — filter by `trigger !== 'probe'` if you only want runs that feed project metrics.",
    access: 'read',
    tier: 'monitoring',
    inputSchema: runsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/runs'],
    handler: (client, input) => client.listRuns(input.project, input.limit),
  }),
  defineTool({
    name: 'canonry_runs_latest',
    title: 'Get latest project run',
    description: 'Get the latest run and total run count for a Canonry project.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/runs/latest'],
    handler: (client, input) => client.getLatestRun(input.project),
  }),
  defineTool({
    name: 'canonry_run_get',
    title: 'Get run',
    description: 'Get a Canonry run with its snapshots.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: runGetInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/runs/{id}'],
    handler: (client, input) => client.getRun(input.runId),
  }),
  defineTool({
    name: 'canonry_timeline_get',
    title: 'Get project timeline',
    description: 'Get per-query citation history for a Canonry project.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: timelineInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/timeline'],
    handler: (client, input) => client.getTimeline(input.project, input.location, input.limit),
  }),
  defineTool({
    name: 'canonry_snapshots_list',
    title: 'List query snapshots',
    description: 'List paginated query snapshots for a Canonry project.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: snapshotsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/snapshots'],
    handler: (client, input) => client.getSnapshots(input.project, {
      limit: input.limit,
      offset: input.offset,
      location: input.location,
    }),
  }),
  defineTool({
    name: 'canonry_snapshots_diff',
    title: 'Diff snapshots',
    description: 'Compare query snapshot states between two Canonry runs.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: snapshotsDiffInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/snapshots/diff'],
    handler: (client, input) => client.getSnapshotDiff(input.project, input.run1, input.run2),
  }),
  defineTool({
    name: 'canonry_insights_list',
    title: 'List insights',
    description: 'List intelligence insights for a Canonry project.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: insightsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/insights'],
    handler: (client, input) => client.getInsights(input.project, { dismissed: input.dismissed, runId: input.runId }),
  }),
  defineTool({
    name: 'canonry_insight_get',
    title: 'Get insight',
    description: 'Get one intelligence insight for a Canonry project.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: insightInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/insights/{id}'],
    handler: (client, input) => client.getInsight(input.project, input.insightId),
  }),
  defineTool({
    name: 'canonry_health_latest',
    title: 'Get latest health',
    description: 'Get the latest health snapshot for a Canonry project. Always returns a snapshot once the project exists: real data carries `status: "ready"`; newly-created projects (or projects with only failed runs) carry `status: "no-data"` with `reason: "no-runs-yet"` and zeroed metrics.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/health/latest'],
    handler: (client, input) => client.getHealth(input.project),
  }),
  defineTool({
    name: 'canonry_health_history',
    title: 'Get health history',
    description: 'Get health snapshot history for a Canonry project.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: healthHistoryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/health/history'],
    handler: (client, input) => client.getHealthHistory(input.project, input.limit),
  }),
  defineTool({
    name: 'canonry_citations_visibility',
    title: 'Get citation visibility',
    description: 'Single-call AI citation surface for a Canonry project. Returns the project headline (cited by N of M engines), per-query engine coverage rows from the latest snapshot per (query × provider), and a competitor-gap list (queries where a configured competitor is cited but the project is not). Carries `status: "no-data"` with `reason: "no-queries"` or `"no-runs-yet"` when inputs are missing.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/citations/visibility'],
    handler: (client, input) => client.getCitationVisibility(input.project),
  }),
  defineTool({
    name: 'canonry_visibility_stats',
    title: 'Get aggregated mention/citation stats',
    description:
      'Per-query mention (answer-text) and citation (source-list) counts WITH a sample size, pooled across many answer-visibility runs (probe-excluded) — the data to compute a confidence-aware (Wilson) proportion or detect drift without fetching every run. Tri-state aware: `checked` (the n for the mention proportion) counts only snapshots where answerMentioned was recorded; `null` ("not checked") is excluded, never counted as not-mentioned. Returns per-query `total`/`checked`/`mentioned`/`cited` + derived `mentionRate` (mentioned/checked) and `citedRate` (cited/total), `firstObserved`/`lastObserved`, and pooled `totals`. Window with `since`/`until` (ISO), `lastRuns`, or `month=YYYY-MM` (mutually exclusive); with none set, EVERY completed/partial run is pooled (`window.runCount` says how many) — pass `lastRuns` for a recent sample. Set `groupBy=provider` for a per-provider breakdown whose counts sum to the pooled counts (`groupBy` is omitted from the response otherwise). Set `shareOfVoice=true` for project-vs-tracked-competitor brand-mention share across the same attributed snapshot set — scoped to NON-BRAND queries by default, because a branded query names the project (it is mentioned on nearly all of them and a competitor cannot be), so a pooled figure reports brand recall as category placement. Pass `queryClass="branded"` for the recall figure; the response echoes which class it served.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: z.object({
      project: projectNameSchema,
      since: z.string().optional().describe('Inclusive lower bound on run createdAt (ISO 8601). A date-only value (YYYY-MM-DD) is the start of that UTC day. Mutually exclusive with lastRuns/month.'),
      until: z.string().optional().describe('Inclusive upper bound on run createdAt (ISO 8601). A date-only value (YYYY-MM-DD) covers the whole UTC day (through 23:59:59.999). Mutually exclusive with lastRuns/month.'),
      lastRuns: z.number().int().positive().optional().describe('Aggregate only the most recent N answer-visibility runs. Mutually exclusive with since/until/month.'),
      month: z.string().optional().describe('Aggregate one calendar month (YYYY-MM), expanded to that month\'s inclusive UTC bounds. Mutually exclusive with since/until/lastRuns.'),
      groupBy: z.enum(['provider']).optional().describe('Set to "provider" for a per-provider breakdown.'),
      shareOfVoice: z.boolean().optional().describe('Include project-vs-tracked-competitor brand-mention share across the same window (non-brand queries unless queryClass says otherwise).'),
      queryClass: z.enum(['branded', 'non-brand']).optional().describe('Query class for shareOfVoice. Defaults to non-brand. There is no "all": branded and non-brand never share a denominator.'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/visibility-stats'],
    handler: (client, input) =>
      client.getVisibilityStats(input.project, {
        since: input.since,
        until: input.until,
        lastRuns: input.lastRuns,
        groupBy: input.groupBy,
        month: input.month,
        shareOfVoice: input.shareOfVoice,
        queryClass: input.queryClass,
      }),
  }),
  defineTool({
    name: 'canonry_visibility_compare',
    title: 'Compare AEO visibility month over month',
    description:
      'Statistically honest month-over-month AEO comparison in ONE call — use this instead of hand-computing deltas from two visibility-stats calls. Share of voice (`mention-share-of-voice`, `driftRobust: true`) is less exposed to broad model-wide naming propensity than absolute rates, but it never overrides model continuity. The response restricts to common query/provider pairs, then includes only providers with exactly one known, identical configured model id in both months. `continuity` surfaces every provider, its model evidence, and whether it was excluded for a changed, mixed mid-month, or unknown model. When no provider remains, metrics return `model-discontinuous` or `model-unknown`, never a directional call. A silent upstream version bump under an unchanged configured id remains undetectable. `from` must be a month strictly before `to`.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: z.object({
      project: projectNameSchema,
      from: z.string().describe('Earlier calendar month (YYYY-MM), the baseline. Must be strictly before "to".'),
      to: z.string().describe('Later calendar month (YYYY-MM), compared against "from".'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/visibility-compare'],
    handler: (client, input) => client.getVisibilityCompare(input.project, input.from, input.to),
  }),
  defineTool({
    name: 'canonry_content_targets',
    title: 'Get content targets',
    description: 'Ranked, action-typed content opportunities. Each row is `{query, action ∈ create|expand|refresh|add-schema, ourBestPage?, winningCompetitor?, score, scoreBreakdown, drivers[], demandSource, actionConfidence, winnabilityClass, winnability?}`. `winnabilityClass` is the winnability gate: "ownable" (worth a brief) vs "ceded" (aggregator/editorial head term to skip); ownable rows sort first. Filter with `winnabilityClass`/`ownable`. Use this to recommend which post the user should write or refresh next.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: contentTargetsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/content/targets'],
    handler: (client, input) => client.getContentTargets(input.project, {
      limit: input.limit,
      includeInProgress: input.includeInProgress,
      winnabilityClass: input.winnabilityClass,
      ownable: input.ownable,
    }),
  }),
  defineTool({
    name: 'canonry_content_brief',
    title: 'Synthesize content brief',
    description: 'Synthesize (or fetch cached) a STRUCTURED content brief for an ownable target: `{targetQuery, winnabilityClass, angle, whyWinnable, schemaHookup, controllableSurfaceRationale}`. Gated to ownable targets — a ceded head term is rejected. Costs one analyze-tier LLM call on a cache miss; repeat calls are free. Pass a targetRef from canonry_content_targets.',
    access: 'write',
    tier: 'monitoring',
    inputSchema: contentBriefInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/content/recommendations/{targetRef}/brief'],
    handler: (client, input) => client.synthesizeContentBrief(input.project, input.targetRef, {
      provider: input.provider,
      model: input.model,
      forceRefresh: input.forceRefresh,
    }),
  }),
  defineTool({
    name: 'canonry_content_map',
    title: 'Get domain classifications (winnability map)',
    description: 'The per-domain cited-surface classifications behind the winnabilityClass gate: `{domain, competitorType ∈ direct-competitor|ota-aggregator|editorial-media|other|unknown, hits, updatedAt}`, ranked by recurrence. Aggregator/editorial domains are the "ceded" surfaces. Running discovery improves coverage.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: contentMapInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/content/domain-classifications'],
    handler: (client, input) => client.getDomainClassifications(input.project),
  }),
  defineTool({
    name: 'canonry_content_sources',
    title: 'Get grounding sources',
    description: 'URL-level competitive grounding-source map. Per query, lists every URL the LLM cited (our domain vs competitors) with citation count and providers. Read this to understand which specific competitor URL is winning a query.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/content/sources'],
    handler: (client, input) => client.getContentSources(input.project),
  }),
  defineTool({
    name: 'canonry_content_gaps',
    title: 'Get content gaps',
    description: 'Queries where competitors are cited but our domain is not, ranked by miss rate. The blunt-instrument view of "what competitors are winning that we are not." Use canonry_content_targets for action-typed recommendations on the same data.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/content/gaps'],
    handler: (client, input) => client.getContentGaps(input.project),
  }),
  defineTool({
    name: 'canonry_queries_list',
    title: 'List queries',
    description: 'List tracked queries for a Canonry project.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/queries'],
    handler: (client, input) => client.listQueries(input.project),
  }),
  defineTool({
    name: 'canonry_keywords_list',
    title: 'List keywords (legacy alias)',
    description: 'Legacy alias for canonry_queries_list. Returns tracked queries using the pre-queries keyword response shape.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/keywords'],
    handler: (client, input) => client.listKeywords(input.project),
  }),
  defineTool({
    name: 'canonry_competitors_list',
    title: 'List competitors',
    description: 'List tracked competitors for a Canonry project.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/competitors'],
    handler: (client, input) => client.listCompetitors(input.project),
  }),
  defineTool({
    name: 'canonry_schedule_get',
    title: 'Get schedule',
    description: 'Get the scheduled run configuration for a Canonry project. Pass `kind` to read a non-default schedule (e.g. "traffic-sync"); defaults to "answer-visibility".',
    access: 'read',
    tier: 'setup',
    inputSchema: scheduleReadInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/schedule'],
    handler: (client, input) => client.getSchedule(input.project, input.kind),
  }),
  defineTool({
    name: 'canonry_backlinks_latest_release',
    title: 'Discover latest Common Crawl release',
    description:
      'Probes Common Crawl to find the latest published hyperlinkgraph release. Returns the release id and file URLs/sizes ready to feed into a backlinks sync (or null if no candidate slug responded).',
    access: 'read',
    tier: 'setup',
    inputSchema: emptyInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/backlinks/latest-release'],
    handler: (client) => client.backlinksLatestRelease(),
  }),
  defineTool({
    name: 'canonry_backlinks_domains',
    title: 'List backlink domains',
    description: 'Source-aware backlink summary + top linking domains for a project. `source=commoncrawl` (default) reads the most recent ready Common Crawl release; `source=bing-webmaster` is retained only for historical rows created by older Canonry versions. Off-site authority signal that correlates with citation likelihood. Returns null summary when the source has no data yet.',
    access: 'read',
    tier: 'setup',
    inputSchema: backlinksDomainsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/backlinks/domains'],
    handler: (client, input) => client.backlinksDomains(input.project, {
      limit: input.limit ?? 50,
      release: input.release,
      source: input.source,
    }),
  }),
  defineTool({
    name: 'canonry_backlinks_sources',
    title: 'Backlink source availability',
    description: 'Reports active Common Crawl readiness plus any retained historical backlink rows. `bing-webmaster` is never reported as connected and is not refreshed.',
    access: 'read',
    tier: 'setup',
    inputSchema: backlinksSourcesInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/backlinks/sources'],
    handler: (client, input) => client.backlinksSources(input.project),
  }),
  defineTool({
    name: 'canonry_settings_get',
    title: 'Get settings',
    description: 'Get Canonry API settings and configured provider status.',
    access: 'read',
    tier: 'core',
    inputSchema: emptyInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/settings'],
    handler: (client) => client.getSettings(),
  }),
  defineTool({
    name: 'canonry_google_connections_list',
    title: 'List Google connections',
    description: 'List configured Google connections for a Canonry project.',
    access: 'read',
    tier: 'gsc',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/connections'],
    handler: (client, input) => client.googleConnections(input.project),
  }),
  defineTool({
    name: 'canonry_gsc_performance',
    title: 'Get GSC performance',
    description: 'Get stored Google Search Console performance rows for a Canonry project. Rows are ordered by clicks descending unless orderBy says otherwise, and the response reports totalMatching / truncated / latestAvailableDate. Never sum these rows for a property total, use canonry_gsc_performance_daily.',
    access: 'read',
    tier: 'gsc',
    inputSchema: gscPerformanceInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/performance'],
    handler: (client, input) => client.gscPerformance(input.project, compactStringParams(input, ['startDate', 'endDate', 'query', 'page', 'limit', 'offset', 'orderBy', 'window'])),
  }),
  defineTool({
    name: 'canonry_gsc_performance_daily',
    title: 'Get GSC daily performance summary',
    description: 'Get GSC search performance aggregated by date with window totals (clicks, impressions, CTR). Use this for charts and headline metrics — never recompute by summing the paged canonry_gsc_performance rows, which only cover one page.',
    access: 'read',
    tier: 'gsc',
    inputSchema: gscPerformanceDailyInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/performance/daily'],
    handler: (client, input) => client.gscPerformanceDaily(input.project, compactStringParams(input, ['startDate', 'endDate', 'window'])),
  }),
  defineTool({
    name: 'canonry_gsc_top_pages',
    title: 'Get top GSC pages',
    description: 'Get the project\'s pages ranked by summed GSC clicks, aggregated in SQL. The rows are a RANKING and their clicks/impressions do NOT add up to the site total: Google withholds rare queries and repeats one impression per ranking page. Read the window total from the returned `totals` block (labelled totalsSource "property-daily"), which is null when no property-level figure covers the window. Never sum the rows.',
    access: 'read',
    tier: 'gsc',
    inputSchema: gscTopPagesInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/top-pages'],
    handler: (client, input) => client.gscTopPages(input.project, compactStringParams(input, ['startDate', 'endDate', 'limit', 'window'])),
  }),
  defineTool({
    name: 'canonry_gsc_inspections',
    title: 'List GSC inspections',
    description: 'List stored URL inspection rows for a Canonry project.',
    access: 'read',
    tier: 'gsc',
    inputSchema: gscInspectionsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/inspections'],
    handler: (client, input) => client.gscInspections(input.project, compactStringParams(input, ['url', 'limit'])),
  }),
  defineTool({
    name: 'canonry_gsc_deindexed',
    title: 'List deindexed GSC URLs',
    description: 'List URLs that appear to have become deindexed in Google Search Console data.',
    access: 'read',
    tier: 'gsc',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/deindexed'],
    handler: (client, input) => client.gscDeindexed(input.project),
  }),
  defineTool({
    name: 'canonry_gsc_coverage',
    title: 'Get GSC coverage',
    description: 'Get Google Search Console coverage summary for a Canonry project.',
    access: 'read',
    tier: 'gsc',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/coverage'],
    handler: (client, input) => client.gscCoverage(input.project),
  }),
  defineTool({
    name: 'canonry_gsc_coverage_history',
    title: 'Get GSC coverage history',
    description: 'Get Google Search Console coverage history snapshots for a Canonry project.',
    access: 'read',
    tier: 'gsc',
    inputSchema: gscCoverageHistoryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/coverage/history'],
    handler: (client, input) => client.gscCoverageHistory(input.project, { limit: input.limit }),
  }),
  defineTool({
    name: 'canonry_gsc_sitemaps',
    title: 'Get GSC sitemaps',
    description: 'Get sitemap data from Google Search Console for a Canonry project.',
    access: 'read',
    tier: 'gsc',
    inputSchema: gscSitemapsInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/sitemaps'],
    handler: (client, input) => client.gscSitemaps(input.project, { sitemapIndex: input.sitemapIndex }),
  }),
  defineTool({
    name: 'canonry_gsc_sitemaps_submit',
    title: 'Submit GSC sitemaps',
    description: 'Submit up to 50 explicit sitemap URLs, preferred sitemap indexes, or every standalone top-level file plus index child to Google Search Console for refetching. Parent indexes are not redundantly submitted in all-files mode. Google acceptance does not guarantee indexing.',
    access: 'write',
    tier: 'gsc',
    inputSchema: gscSitemapsSubmitInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/google/gsc/sitemaps/submit'],
    handler: submitGscSitemapsFromMcp,
  }),
  defineTool({
    name: 'canonry_ga_status',
    title: 'Get GA status',
    description: 'Get Google Analytics connection status for a Canonry project.',
    access: 'read',
    tier: 'ga',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/status'],
    handler: (client, input) => client.gaStatus(input.project),
  }),
  defineTool({
    name: 'canonry_ga_properties',
    title: 'List GA4 properties',
    description:
      'List the GA4 properties the project\'s connected Google account can read, with their numeric property ids. Use this to find the id that "canonry ga connect --property-id" needs; it cannot be derived from the domain or the OAuth grant.',
    access: 'read',
    tier: 'ga',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/properties'],
    handler: (client, input) => client.gaProperties(input.project),
  }),
  defineTool({
    name: 'canonry_ga_measurement_analysis',
    title: 'Analyze GA acquisition and search demand',
    description: 'Compare native GA4 channels and lead events with branded/non-brand Search Console demand over fixed 30-day cohorts.',
    access: 'read',
    tier: 'ga',
    inputSchema: gaMeasurementAnalysisInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/measurement-analysis'],
    handler: (client, input) => client.gaMeasurementAnalysis(
      input.project,
      compactStringParams(input, ['window', 'hostScope', 'pathPrefix', 'limit']),
    ),
  }),
  defineTool({
    name: 'canonry_ga_traffic',
    title: 'Get GA traffic',
    description: 'Get Google Analytics traffic summary for a Canonry project.',
    access: 'read',
    tier: 'ga',
    inputSchema: gaTrafficInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/traffic'],
    handler: (client, input) => client.gaTraffic(input.project, compactStringParams(input, ['limit', ...GA_RANGE_PARAMS])),
  }),
  defineTool({
    name: 'canonry_ga_coverage',
    title: 'Get GA coverage',
    description: 'Get Google Analytics page coverage for a Canonry project.',
    access: 'read',
    tier: 'ga',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/coverage'],
    handler: (client, input) => client.gaCoverage(input.project),
  }),
  defineTool({
    name: 'canonry_ga_ai_referral_history',
    title: 'Get GA AI referral detail rows',
    description: 'Get raw AI referral rows per day, landing page, and attribution dimension. Detail, not totals: use canonry_ga_ai_referral_daily for session counts.',
    access: 'read',
    tier: 'ga',
    inputSchema: gaWindowInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/ai-referral-history'],
    handler: (client, input) => client.gaAiReferralHistory(input.project, compactStringParams(input, GA_RANGE_PARAMS)),
  }),
  defineTool({
    name: 'canonry_ga_ai_referral_daily',
    title: 'Get GA AI referral sessions per day',
    description: 'Get AI referral sessions per day and per source, deduplicated across attribution dimensions. Totals match the AI sessions reported by canonry_ga_traffic.',
    access: 'read',
    tier: 'ga',
    inputSchema: gaWindowInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/ai-referral-daily'],
    handler: (client, input) => client.gaAiReferralDaily(input.project, compactStringParams(input, GA_RANGE_PARAMS)),
  }),
  defineTool({
    name: 'canonry_ga_social_referral_history',
    title: 'Get GA social referral history',
    description: 'Get social referral sessions per day grouped by source.',
    access: 'read',
    tier: 'ga',
    inputSchema: gaWindowInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/social-referral-history'],
    handler: (client, input) => client.gaSocialReferralHistory(input.project, compactStringParams(input, GA_RANGE_PARAMS)),
  }),
  defineTool({
    name: 'canonry_ga_social_referral_trend',
    title: 'Get GA social referral trend',
    description: 'Get social referral trend with biggest mover for a Canonry project.',
    access: 'read',
    tier: 'ga',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/social-referral-trend'],
    handler: (client, input) => client.gaSocialReferralTrend(input.project),
  }),
  defineTool({
    name: 'canonry_ga_attribution_trend',
    title: 'Get GA attribution trend',
    description: 'Get per-channel attribution trends for organic, AI, social, direct, and total sessions.',
    access: 'read',
    tier: 'ga',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/attribution-trend'],
    handler: (client, input) => client.gaAttributionTrend(input.project),
  }),
  defineTool({
    name: 'canonry_ga_session_history',
    title: 'Get GA session history',
    description: 'Get total sessions per day for a Canonry project.',
    access: 'read',
    tier: 'ga',
    inputSchema: gaWindowInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/session-history'],
    handler: (client, input) => client.gaSessionHistory(input.project, compactStringParams(input, GA_RANGE_PARAMS)),
  }),
  // ----- Google Business Profile (Phase 1: auth + discovery) -----
  defineTool({
    name: 'canonry_gbp_accounts',
    title: 'List Google Business Profile accounts',
    description: 'List the Google Business Profile accounts the connected OAuth user can access. Use this to pick which account a project should track via canonry_gbp_locations_discover (accountName).',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpAccountsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/accounts'],
    handler: (client, input) => client.listGbpAccounts(input.project),
  }),
  defineTool({
    name: 'canonry_gbp_locations',
    title: 'List Google Business Profile locations',
    description: 'List discovered Google Business Profile locations for a Canonry project, including their selection state.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpListLocationsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/locations'],
    handler: (client, input) => client.listGbpLocations(input.project, input.selected === undefined ? undefined : { selected: input.selected }),
  }),
  defineTool({
    name: 'canonry_gbp_locations_discover',
    title: 'Discover Google Business Profile locations',
    description: 'Re-discover Google Business Profile locations from Google and upsert them. New locations get the default selection state from `selectAllNew`; existing locations keep their selection. Pass `accountName` ("accounts/{n}", from canonry_gbp_accounts) to target a specific account; switching a project to a DIFFERENT account is destructive and requires `switchAccount: true`.',
    access: 'write',
    tier: 'gbp',
    inputSchema: gbpDiscoverInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/gbp/locations/discover'],
    handler: (client, input) => client.discoverGbpLocations(input.project, {
      selectAllNew: input.selectAllNew,
      accountName: input.accountName,
      switchAccount: input.switchAccount,
    }),
  }),
  defineTool({
    name: 'canonry_gbp_location_select',
    title: 'Toggle GBP location selection',
    description: 'Mark a Google Business Profile location as selected or deselected for sync.',
    access: 'write',
    tier: 'gbp',
    inputSchema: gbpLocationSelectionInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/gbp/locations/{locationName}/selection'],
    handler: (client, input) => client.setGbpLocationSelection(input.project, input.locationName, input.selected),
  }),
  defineTool({
    name: 'canonry_gbp_disconnect',
    title: 'Disconnect Google Business Profile',
    description: 'Remove the Google Business Profile OAuth connection and all discovered locations for a project.',
    access: 'write',
    tier: 'gbp',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/gbp/connection'],
    handler: (client, input) => client.disconnectGbp(input.project),
  }),
  // ----- Google Business Profile (Phase 2: performance sync) -----
  defineTool({
    name: 'canonry_gbp_sync',
    title: 'Sync Google Business Profile performance',
    description: 'Trigger a GBP performance sync (daily metrics + monthly keyword impressions) for the project\'s selected locations. Returns the run id; poll canonry_run_get for status.',
    access: 'write',
    tier: 'gbp',
    inputSchema: gbpSyncInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/gbp/sync'],
    handler: (client, input) => client.triggerGbpSync(input.project, {
      locationNames: input.locationNames,
      daysOfMetrics: input.daysOfMetrics,
      monthsOfKeywords: input.monthsOfKeywords,
    }),
  }),
  defineTool({
    name: 'canonry_gbp_metrics',
    title: 'Get GBP daily metrics',
    description: 'List stored Google Business Profile daily performance metrics (impressions, direction requests, website/call clicks) for a project.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpMetricsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/metrics'],
    handler: (client, input) => client.listGbpMetrics(input.project, compactStringParams(input, ['locationName', 'metric'])),
  }),
  defineTool({
    name: 'canonry_gbp_keywords',
    title: 'Get GBP keyword impressions',
    description: 'List stored Google Business Profile monthly search-keyword impressions for a project. Includes a thresholdedPct (share privacy-redacted by Google).',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/keywords'],
    handler: (client, input) => client.listGbpKeywords(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_gbp_place_actions',
    title: 'Get GBP place actions',
    description: 'List stored Google Business Profile place action links (booking / reservation / order CTAs) for a project.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/place-actions'],
    handler: (client, input) => client.listGbpPlaceActions(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_gbp_lodging',
    title: 'Get GBP lodging attributes',
    description: 'List the latest Google Business Profile lodging snapshot per location (hotel structured attributes). populatedGroupCount=0 means the Lodging API returned no readable structured groups, which can happen even for complete hotels whose owner-facing "Hotel details" panel has amenities set. Treat it as a "verify the Hotel details panel", not a confirmed gap.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/lodging'],
    handler: (client, input) => client.listGbpLodging(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_gbp_attributes',
    title: 'Get GBP owner-set attributes',
    description: 'List the latest Google Business Profile owner-set attribute snapshot per location: the generic amenity / service / accessibility / identity / social-URL tags the owner has set (e.g. has_onsite_services, offers_online_estimates, is_owned_by_women, wheelchair accessibility, url_instagram). Works for every business category, unlike canonry_gbp_lodging (hotels only). Returns only attributes the owner has set, so attributeCount is a real, owner-readable completeness signal (not a verify-nudge).',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/attributes'],
    handler: (client, input) => client.listGbpAttributes(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_gbp_places',
    title: 'Get GBP Places rendered-listing data',
    description: "List the latest Google Places (New) snapshot per location — the amenities Google's public listing advertises (server-derived `amenities`), cross-referenced against the GBP profile to surface listing discrepancies. Empty until a Places API key is configured and a gbp sync runs.",
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/places'],
    handler: (client, input) => client.listGbpPlaces(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_gbp_summary',
    title: 'Get GBP local-AEO summary',
    description: 'Composite Google Business Profile summary for a project: performance totals + 7d deltas, keyword thresholded %, place-action CTA presence, Lodging API readable-group counts, and owner-content profile completeness (how many selected locations populate secondary categories / description / service area / hours / phone, plus closed-status counts). All derived numbers computed server-side.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/summary'],
    handler: (client, input) => client.getGbpSummary(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_traffic_sources_list',
    title: 'List traffic sources',
    description: 'List server-side traffic sources for a Canonry project (Cloud Run, etc.). Returns non-archived sources with status, last sync timestamp, last error, and the stored config (gcpProjectId, serviceName, location, authMode). Pair with canonry_traffic_source_get for last-24h totals on a single source.',
    access: 'read',
    tier: 'traffic',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/traffic/sources'],
    handler: (client, input) => client.trafficListSources(input.project),
  }),
  defineTool({
    name: 'canonry_traffic_source_get',
    title: 'Get traffic source detail',
    description: 'Get one traffic source plus 24h totals (crawler hits, AI-referral sessions, raw event sample count) and the latest traffic-sync run summary. Use to confirm a source is healthy and observing traffic before drilling into events.',
    access: 'read',
    tier: 'traffic',
    inputSchema: trafficSourceIdInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/traffic/sources/{id}'],
    handler: (client, input) => client.trafficGetSource(input.project, input.sourceId),
  }),
  defineTool({
    name: 'canonry_traffic_status',
    title: 'Traffic status (all sources)',
    description: 'Single-call composite returning every non-archived traffic source plus its last-24h totals (crawler hits, AI-referral sessions, sample count) and latest source-scoped traffic-sync run. Same per-entry shape as canonry_traffic_source_get, but one call covers all sources — prefer this over a list+per-source fan-out.',
    access: 'read',
    tier: 'traffic',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/traffic/status'],
    handler: (client, input) => client.trafficStatus(input.project),
  }),
  defineTool({
    name: 'canonry_traffic_events',
    title: 'List traffic events',
    description: 'Read crawler, AI user-fetch, and AI-referral rollups from server-side traffic sources. Returns complete full-window chart series and totals plus a capped discriminated detail list with explicit truncation metadata. Window defaults to last 24h.',
    access: 'read',
    tier: 'traffic',
    inputSchema: trafficEventsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/traffic/events'],
    handler: (client, input) => {
      const params: NonNullable<Parameters<ApiClient['trafficListEvents']>[1]> = {}
      if (input.since) params.since = input.since
      if (input.until) params.until = input.until
      if (input.kind) params.kind = input.kind
      if (input.sourceId) params.sourceId = input.sourceId
      if (input.limit !== undefined) params.limit = input.limit
      if (input.granularity) params.granularity = input.granularity
      return client.trafficListEvents(input.project, params)
    },
  }),
  defineTool({
    name: 'canonry_traffic_connect_cloud_run',
    title: 'Connect Cloud Run traffic source',
    description: 'Connect a Google Cloud Run service as a server-side traffic source. v1 requires service-account JSON content (paste the file contents into `keyJson`); OAuth-mode is not yet supported. Reconnecting an existing source updates the credential and config in place. The private key is stored in ~/.canonry/config.yaml (not the DB) and never echoed back.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficConnectCloudRunInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/connect/cloud-run'],
    handler: (client, input) => client.trafficConnectCloudRun(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_traffic_connect_wordpress',
    title: 'Connect WordPress traffic-logger source',
    description: 'Connect a WordPress site (running the canonry traffic-logger plugin) as a server-side traffic source. Probes the plugin endpoint with the supplied Application Password before persisting; a bad credential or unreachable host surfaces as a 502 error. Reconnecting the same endpoint updates the active source in place. Changing baseUrl archives the old lineage and creates a fresh source so rollups cannot mix across endpoints. The Application Password is stored in ~/.canonry/config.yaml (not the DB) and never echoed back.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficConnectWordpressInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/connect/wordpress'],
    handler: (client, input) => client.trafficConnectWordpress(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_traffic_connect_vercel',
    title: 'Connect Vercel traffic source',
    description: 'Connect a Vercel project as a server-side traffic source. Pulls request logs from Vercel\'s internal request-logs endpoint — no in-app instrumentation needed. Probes the endpoint with the supplied API token before persisting — a bad token or wrong project / team id surfaces as a 502 error. Reconnecting updates the existing active Vercel source in place. The API token is stored in ~/.canonry/config.yaml (not the DB) and never echoed back.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficConnectVercelInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/connect/vercel'],
    handler: (client, input) => client.trafficConnectVercel(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_traffic_sync',
    title: 'Sync traffic source',
    description: 'Pull a Cloud Run, WordPress, Vercel, or Cloudflare Queue traffic source, classify crawler / AI-referral / unknown traffic, and upsert hourly rollups plus raw samples. Time-window pulls clamp forward to lastSyncedAt. WordPress uses a fixed bounded window, defaults a new or idle source to 365d, validates the returned events remain inside that window, and serializes syncs with a source lease.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficSyncInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/sources/{id}/sync'],
    handler: (client, input) => client.trafficSync(input.project, input.sourceId, input.sinceMinutes !== undefined ? { sinceMinutes: input.sinceMinutes } : undefined),
  }),
  defineTool({
    name: 'canonry_traffic_backfill',
    title: 'Backfill traffic source',
    description: 'Async one-shot reclassification for Cloud Run or Vercel traffic. It replaces the selected window’s rollups with a fresh bounded pull and current classifier output. WordPress generic replace backfill is unavailable because the endpoint cannot prove retained coverage; use a retention-aware repair that explicitly declares any unrecoverable span. Returns `{ runId, status: "running" }`; poll canonry_run_get for completion.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficBackfillInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/sources/{id}/backfill'],
    handler: (client, input) => client.trafficBackfill(input.project, input.sourceId, input.days !== undefined ? { days: input.days } : undefined),
  }),
  defineTool({
    name: 'canonry_traffic_reset',
    title: 'Advance traffic source lastSyncedAt to NOW',
    description: 'Operator recovery for a stuck traffic source. Advances `lastSyncedAt` to NOW, sets `status` back to `connected`, and clears `last_error`. A WordPress reset also clears its continuation state and records an unrecovered span so its next bounded drain cannot combine an old cursor with a new window. That stops replay but is not historical repair. Generic WordPress replace-mode backfill is unavailable because retained coverage is unproven; use a retention-aware repair that explicitly declares any unrecoverable span. Archived sources are rejected; reconnect them with the appropriate canonry_traffic_connect_* tool.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficResetInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/sources/{id}/reset'],
    handler: (client, input) => client.trafficReset(input.project, input.sourceId),
  }),
  defineTool({
    name: 'canonry_project_upsert',
    title: 'Create or replace project',
    description: 'Create or replace a Canonry project. PUT semantics — fields not in the request are reset to their defaults. Provide the full intended project shape.',
    access: 'write',
    tier: 'setup',
    inputSchema: projectUpsertInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}'],
    handler: (client, input) => client.putProject(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_apply_config',
    title: 'Apply project config',
    description: 'Apply one Canonry config-as-code project document. Replaces the project to match the config — fields omitted from the spec are reset to defaults. For multi-document YAML, call this tool once per project document.',
    access: 'write',
    tier: 'core',
    inputSchema: applyConfigInputSchema,
    // Declarative apply is safe to repeat, but it replaces configured child state.
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['POST /api/v1/apply'],
    handler: (client, input) => client.apply(input.config),
  }),
  defineTool({
    name: 'canonry_queries_generate',
    title: 'Generate query suggestions',
    description: 'Generate candidate queries using a configured provider. Returns suggestions only; use canonry_queries_add to persist them.',
    access: 'write',
    tier: 'setup',
    inputSchema: queryGenerateInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/queries/generate'],
    handler: (client, input) => client.generateQueries(input.project, input.request.provider, input.request.count),
  }),
  defineTool({
    name: 'canonry_keywords_generate',
    title: 'Generate keyword suggestions (legacy alias)',
    description: 'Legacy alias for canonry_queries_generate. Returns suggestions using the pre-queries keyword response shape.',
    access: 'write',
    tier: 'setup',
    inputSchema: keywordGenerateInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/keywords/generate'],
    handler: (client, input) => client.generateKeywords(input.project, input.request.provider, input.request.count),
  }),
  defineTool({
    name: 'canonry_queries_replace',
    title: 'Replace queries',
    description: 'Replace the tracked query set for a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: queriesInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/queries'],
    handler: async (client, input) => {
      await client.putQueries(input.project, uniqueStrings(input.request.queries))
    },
  }),
  defineTool({
    name: 'canonry_queries_replace_preview',
    title: 'Preview query replace',
    description: 'Preview the impact of replacing a project\'s tracked query set: current vs proposed, added/removed/unchanged diff, and the count of snapshots that would detach (queryId → NULL; queryText preserved). Read-only.',
    access: 'read',
    tier: 'setup',
    inputSchema: queriesInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['POST /api/v1/projects/{name}/queries/replace-preview'],
    handler: (client, input) => client.previewReplaceQueries(input.project, uniqueStrings(input.request.queries)),
  }),
  defineTool({
    name: 'canonry_keywords_replace',
    title: 'Replace keywords (legacy alias)',
    description: 'Legacy alias for canonry_queries_replace. Replaces the same canonical tracked query set.',
    access: 'write',
    tier: 'setup',
    inputSchema: keywordsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/keywords'],
    handler: async (client, input) => {
      await client.putKeywords(input.project, uniqueStrings(input.request.keywords))
    },
  }),
  defineTool({
    name: 'canonry_measurement_discovery',
    title: 'Discover measurement Targets',
    description: 'Fetch a public sitemap under bounded network policy and deterministically classify project-owned URLs into Target proposals, aliases, shared paths, unmatched paths, and exclusions. Does not publish a plan.',
    access: 'write',
    tier: 'setup',
    inputSchema: measurementDiscoveryInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/measurement-discovery'],
    handler: (client, input) => client.discoverMeasurementTargets(input.project, {
      sitemapUrl: input.sitemapUrl,
      rule: input.rule,
      ...(input.maxUrls === undefined ? {} : { maxUrls: input.maxUrls }),
    }),
  }),
  defineTool({
    name: 'canonry_measurement_plan_get', title: 'Get measurement plan', description: 'Get the active measurement plan for a project.', access: 'read', tier: 'setup', inputSchema: projectInputSchema, annotations: readAnnotations(), openApiOperations: ['GET /api/v1/projects/{name}/measurement-plan'], handler: (client, input) => client.getMeasurementPlan(input.project),
  }),
  defineTool({
    name: 'canonry_measurement_plan_versions', title: 'List measurement plan versions', description: 'List immutable measurement-plan revisions.', access: 'read', tier: 'setup', inputSchema: projectInputSchema, annotations: readAnnotations(), openApiOperations: ['GET /api/v1/projects/{name}/measurement-plan/versions'], handler: (client, input) => client.listMeasurementPlanVersions(input.project),
  }),
  defineTool({
    name: 'canonry_measurement_plan_version_get', title: 'Get measurement plan revision', description: 'Get one immutable measurement-plan revision.', access: 'read', tier: 'setup', inputSchema: measurementPlanVersionInputSchema, annotations: readAnnotations(), openApiOperations: ['GET /api/v1/projects/{name}/measurement-plan/versions/{revision}'], handler: (client, input) => client.getMeasurementPlanVersion(input.project, input.revision),
  }),
  defineTool({
    name: 'canonry_measurement_plan_compile_preview', title: 'Compile measurement plan', description: 'Validate and compile a Target/group plan without publishing it.', access: 'write', tier: 'setup', inputSchema: measurementPlanPreviewInputSchema, annotations: writeAnnotations({ idempotentHint: true }), openApiOperations: ['POST /api/v1/projects/{name}/measurement-plan/compile-preview'], handler: (client, input) => client.compileMeasurementPlanPreview(input.project, input.plan),
  }),
  defineTool({
    name: 'canonry_measurement_plan_diff_preview', title: 'Preview measurement plan changes', description: 'Compare a compiled Target/group plan with the active immutable revision without publishing it.', access: 'write', tier: 'setup', inputSchema: measurementPlanPreviewInputSchema, annotations: writeAnnotations({ idempotentHint: true }), openApiOperations: ['POST /api/v1/projects/{name}/measurement-plan/diff-preview'], handler: (client, input) => client.diffMeasurementPlanPreview(input.project, input.plan),
  }),
  defineTool({
    name: 'canonry_measurement_plan_publish', title: 'Publish measurement plan (legacy v1)', description: 'Legacy schema-v1 publish. For Advanced Measurement use canonry_measurement_draft_action instead: this tool compiles only schema v1 and refuses when the active revision is schema v2 rather than downgrade it. Publish only when the active revision still matches the revision you reviewed. Use null only when you reviewed a planless project.', access: 'write', tier: 'setup', inputSchema: measurementPlanPublishInputSchema, annotations: writeAnnotations({ idempotentHint: true }), openApiOperations: ['PUT /api/v1/projects/{name}/measurement-plan'], handler: (client, input) => client.publishMeasurementPlan(input.project, {
      expectedActiveRevision: input.expectedActiveRevision,
      plan: input.plan,
    }),
  }),
  defineTool({
    name: 'canonry_measurement_plan_segment_retire', title: 'Retire measurement segment', description: 'Permanently retire an inactive Target or group stable key. Publish a revision without it first; there is no unretire.', access: 'write', tier: 'setup', inputSchema: measurementPlanRetireInputSchema, annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }), openApiOperations: ['POST /api/v1/projects/{name}/measurement-plan/segments/{stableKey}/retire'], handler: (client, input) => client.retireMeasurementPlanSegment(input.project, input.stableKey),
  }),
  defineTool({
    name: 'canonry_measurement_setup',
    title: 'Get Advanced Measurement setup state',
    description: 'Return the project’s stored Advanced Measurement setup state, mode, active revision, draft freshness, and next action. It never starts provider work or incurs provider cost, and refuses an unknown project.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-setup'],
    handler: (client, input) => client.getMeasurementSetup(input.project),
  }),
  defineTool({
    name: 'canonry_measurement_overview',
    title: 'Get Advanced Measurement overview',
    description: 'Return stored, revision-pinned Advanced Measurement metrics and a bounded page of Property rows for all Properties, one reporting group, or one Property. Filter by query class, provider, location, date window, run, or Property search; search filters rows without changing metric denominators. It ranks one run snapshot only and never infers a trend or compares across revisions. Choose label-asc (default), label-desc, citationCoverage-asc/desc, or mentionCoverage-asc/desc. For a coverage sort, unavailable rows form the first bucket in either direction; available rows then follow the requested numeric direction. The cursor is sort-aware, pins pagination to the active revision, displayed run, evidence snapshot, and filters even if a newer run completes, and must be reused unchanged with the same sort and filters. Legacy label cursors work only when sort is omitted, while any explicit sort needs a new sort-bound cursor. It never starts provider work or incurs provider cost; page size is at most 100, and it refuses invalid scope keys, cursor combinations, appended evidence, or a run pinned to another revision.',
    access: 'read',
    tier: 'setup',
    inputSchema: measurementOverviewInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-overview'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementOverview(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_property_evidence',
    title: 'Page one Property\'s measurement evidence',
    description: 'Return the stored evidence rows for exactly one Property out of one revision-pinned run, optionally narrowed to a question class, provider, or location. shape chooses what a row is: sources (the default) returns one row per cited URL under evidence; answers returns one row per measured answer under answers, with the cited URLs nested inside and both signals on the row (mentioned, cited). Use shape=answers to explain a GAP — an answer that mentioned the Property without linking it, or that named nobody at all, has no URL to hang a source row on and does not appear in the default shape, so counting source rows understates what was measured. mentioned is null, never false, when the answer text was never captured: that is a missing signal, not a measured no. Exactly one of evidence or answers is returned and the other is absent rather than empty. A cursor is bound to the shape that issued it and is refused on the other. Prefer this over canonry_measurement_report when you want one Property: the report reconstructs every group and every Target for a revision and does not paginate. Run selection matches canonry_measurement_overview — the most recent completed run pinned to the active revision unless runId names another, and a run pinned to a different revision is refused rather than joined. The cursor also pins the active revision, displayed run, evidence snapshot, and filters; reuse it unchanged. Not available for a schema v1 revision, which records no question class to scope by. It never starts provider work; page size is at most 100. An empty page under measurement.state = not_measured means the Property has not been measured at all, which is NOT a measured result of zero.',
    access: 'read',
    tier: 'setup',
    inputSchema: measurementPropertyEvidenceInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-property-evidence'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementPropertyEvidence(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_portfolio_summary',
    title: 'Summarize measured Properties',
    description: 'Start here to rank the weakest measured Properties and their stored replacement names, and to compare every named market worst-first. Each market is scoped to the displayed run; markets may share Properties, so they never sum to the portfolio totals. Reads stored data only; it never starts provider work.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: measurementPortfolioSummaryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-portfolio-summary'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementPortfolioSummary(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_property_questions',
    title: 'List a Property’s stored questions',
    description: 'After identifying a Property, list its stored question outcomes and use a returned resultId with canonry_measurement_question_result. Reads stored data only; it never starts provider work.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: measurementPropertyQuestionsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-property-questions'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementPropertyQuestions(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_question_result',
    title: 'Get a stored question result',
    description: 'After listing a Property’s questions, expand one returned resultId into its stored answer and attribution sources. Reads stored data only; it never starts provider work.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: measurementQuestionResultInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-question-result'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementQuestionResult(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_property_competitors',
    title: 'List a Property’s stored replacements',
    description: 'After reviewing a Property’s question outcomes, find repeated stored replacement names for its misses. Reads stored data only; it never starts provider work.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: measurementPropertyCompetitorsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-property-competitors'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementPropertyCompetitors(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_changes',
    title: 'Compare stored measurement changes',
    description: 'After reviewing the current summary, compare stored runs only when their execution identity is compatible. Reads stored data only; it never starts provider work.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: measurementChangesInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-changes'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementChanges(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_data_quality',
    title: 'Inspect stored measurement data quality',
    description: 'Before acting on a measurement, inspect its stored completeness, capture, retrieval, and comparability context. Reads stored data only; it never starts provider work.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: measurementDataQualityInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-data-quality'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementDataQuality(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_draft_get',
    title: 'Get Advanced Measurement draft',
    description: 'Return the stored v2 draft and its current ETag, or draft:null when none exists. It never starts provider work or incurs provider cost, and refuses an unknown project.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-plan/draft'],
    handler: (client, input) => client.getMeasurementPlanDraft(input.project),
  }),
  defineTool({
    name: 'canonry_measurement_draft_targets',
    title: 'List Advanced Measurement draft Targets',
    description: 'Return one stored, cursor-paged set of draft Targets. It never starts provider work or incurs provider cost; pages are capped at 100 rows and it refuses a missing draft or unknown project.',
    access: 'read',
    tier: 'setup',
    inputSchema: measurementDraftCollectionInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-plan/draft/targets'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementDraftTargets(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_draft_assignments',
    title: 'List Advanced Measurement draft assignments',
    description: 'Return one stored, cursor-paged set of draft Target-to-query assignments. It never starts provider work or incurs provider cost; pages are capped at 100 rows and it refuses a missing draft or unknown project.',
    access: 'read',
    tier: 'setup',
    inputSchema: measurementDraftCollectionInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-plan/draft/assignments'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementDraftAssignments(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_draft_groups',
    title: 'List Advanced Measurement draft groups',
    description: 'Return one stored, cursor-paged set of draft reporting groups and competitors. It never starts provider work or incurs provider cost; pages are capped at 100 rows and it refuses a missing draft or unknown project.',
    access: 'read',
    tier: 'setup',
    inputSchema: measurementDraftCollectionInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-plan/draft/groups'],
    handler: (client, input) => {
      const { project, ...query } = input
      return client.getMeasurementDraftGroups(project, query)
    },
  }),
  defineTool({
    name: 'canonry_measurement_query_sets',
    title: 'List Advanced Measurement query sets',
    description: 'Return stored query-set metadata for one project. It never starts provider work or incurs provider cost, and refuses an unknown project.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-query-sets'],
    handler: (client, input) => client.listMeasurementQuerySets(input.project),
  }),
  defineTool({
    name: 'canonry_measurement_query_set_get',
    title: 'Get Advanced Measurement query set',
    description: 'Return one stored query set with its ordered query members. It never starts provider work or incurs provider cost, and refuses an unknown project or query-set ID.',
    access: 'read',
    tier: 'setup',
    inputSchema: measurementQuerySetInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-query-sets/{setId}'],
    handler: (client, input) => client.getMeasurementQuerySet(input.project, input.setId),
  }),
  defineTool({
    name: 'canonry_measurement_query_templates',
    title: 'List Advanced Measurement query templates',
    description: 'Return stored query-template metadata for one project. It never starts provider work or incurs provider cost, and refuses an unknown project.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-query-templates'],
    handler: (client, input) => client.listMeasurementQueryTemplates(input.project),
  }),
  defineTool({
    name: 'canonry_measurement_draft_action',
    title: 'Act on an Advanced Measurement draft',
    description: 'Create, edit, inspect, publish, or discard one v2 draft. Pass project plus exactly one typed operation branch; each operation correlates its action with the required request, ETag, and idempotency key so the live schema is self-describing. Requires measurement-plan write authority. Every mutating action needs idempotencyKey: reuse it only for an identical retry; a changed request with the same key is refused. Create has no ETag. Draft edits, publish, and discard should pass the latest ETag from canonry_measurement_draft_get; a missing ETag reaches the API as actionable 428, while a stale ETag returns 412. Compile-preview and diff-preview never mutate or start provider work and require neither header. Import-sitemap performs a bounded public sitemap fetch but does not publish or run measurement; publish replaces the active plan after validation, and discard permanently removes the draft.',
    access: 'write',
    tier: 'setup',
    inputSchema: measurementDraftActionInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true, openWorldHint: true }),
    openApiOperations: measurementDraftActionOpenApiOperations,
    handler: (client, input) => runSharedMeasurementDraftAction(client, input.project, input.operation),
  }),
  defineTool({
    name: 'canonry_measurement_plan_deactivate',
    title: 'Deactivate Advanced Measurement plan',
    description: 'Remove the active Advanced Measurement plan pointer while retaining immutable revisions. Requires measurement-plan write authority, the active revision you reviewed, and idempotencyKey; reuse that key only to retry the identical request. It does not use a draft ETag and refuses a moved or missing active plan.',
    access: 'write',
    tier: 'setup',
    inputSchema: measurementPlanDeactivateInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/measurement-plan/actions/deactivate'],
    handler: (client, input) => client.deactivateMeasurementPlan(input.project, {
      expectedActiveRevision: input.expectedActiveRevision,
    }, input.idempotencyKey),
  }),
  defineTool({
    name: 'canonry_measurement_query_set_upsert',
    title: 'Create or replace Advanced Measurement query set',
    description: 'Create or replace one query set and its ordered query references. Requires measurement-plan write authority. This is an idempotent PUT with no mutation headers; safely retry the same request. It replaces the named query-set contents but never deletes project queries or published plans.',
    access: 'write',
    tier: 'setup',
    inputSchema: measurementQuerySetUpsertInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/measurement-query-sets/{setId}'],
    handler: (client, input) => client.upsertMeasurementQuerySet(input.project, input.setId, input.request),
  }),
  defineTool({
    name: 'canonry_measurement_query_set_delete',
    title: 'Delete Advanced Measurement query set',
    description: 'Delete one query set without deleting its project queries or published plans. Requires measurement-plan write authority. DELETE is idempotent and uses no mutation headers; retrying the same request is safe, while an unknown query-set ID is refused.',
    access: 'write',
    tier: 'setup',
    inputSchema: measurementQuerySetInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/measurement-query-sets/{setId}'],
    handler: (client, input) => client.deleteMeasurementQuerySet(input.project, input.setId),
  }),
  defineTool({
    name: 'canonry_measurement_query_template_upsert',
    title: 'Create or replace Advanced Measurement query template',
    description: 'Create or replace one query template. Requires measurement-plan write authority. This is an idempotent PUT with no mutation headers; safely retry the same request. It replaces only the named template and does not create queries until an explicit apply.',
    access: 'write',
    tier: 'setup',
    inputSchema: measurementQueryTemplateUpsertInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/measurement-query-templates/{templateId}'],
    handler: (client, input) => client.upsertMeasurementQueryTemplate(input.project, input.templateId, input.request),
  }),
  defineTool({
    name: 'canonry_measurement_query_template_delete',
    title: 'Delete Advanced Measurement query template',
    description: 'Delete one query template without deleting previously expanded project queries. Requires measurement-plan write authority. DELETE is idempotent and uses no mutation headers; retrying the same request is safe, while an unknown template ID is refused.',
    access: 'write',
    tier: 'setup',
    inputSchema: measurementQueryTemplateInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/measurement-query-templates/{templateId}'],
    handler: (client, input) => client.deleteMeasurementQueryTemplate(input.project, input.templateId),
  }),
  defineTool({
    name: 'canonry_measurement_query_template_apply',
    title: 'Apply Advanced Measurement query template',
    description: 'Expand one query template into project queries and optionally add them to a query set. Requires measurement-plan write authority and idempotencyKey; reuse that key only to retry the identical apply. This additive action returns created and already-existing queries, does not use a draft ETag, and never removes prior queries.',
    access: 'write',
    tier: 'setup',
    inputSchema: measurementQueryTemplateApplyInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/measurement-query-templates/{templateId}/apply'],
    handler: (client, input) => client.applyMeasurementQueryTemplate(
      input.project,
      input.templateId,
      input.request,
      input.idempotencyKey,
    ),
  }),
  defineTool({
    name: 'canonry_measurement_report',
    title: 'Get measurement report',
    description: 'Get a revision-pinned Target and group measurement report from stored runs. Optionally pin the evidence to an exact eligible full run. Never starts live provider work.',
    access: 'read',
    tier: 'setup',
    inputSchema: measurementReportInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/measurement-report'],
    handler: (client, input) => client.getMeasurementReport(input.project, input.revision, input.runId),
  }),
  defineTool({
    name: 'canonry_run_trigger',
    title: 'Trigger run',
    description: "Trigger an answer-visibility run for a Canonry project. Omit both scoping fields for a full sweep. Pass request.queries[] to measure only some of the project's tracked questions. On a project with a published measurement plan, pass request.measurementScope with at least one group or target to measure one slice of that plan — a group stands for its member Targets, and only the questions those Targets selected are measured. A scope naming nothing is rejected rather than treated as a full sweep, so omit the field entirely when you want everything. Either kind of slice is recorded as a spot check: it never replaces a full sweep in the dashboard, analytics or report. For verification scenarios (testing whether a provider migration worked, reproducing a regression, sanity-checking after a code change), set request.trigger='probe' — probe runs write a snapshot you can inspect via canonry_runs_get but are EXCLUDED from dashboard, analytics, intelligence, report, and notifications. Use 'probe' whenever you are testing on your own initiative rather than producing data the user/dashboard will consume.",
    access: 'write',
    tier: 'core',
    inputSchema: runTriggerInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/runs'],
    handler: (client, input) => client.triggerRun(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_run_cancel',
    title: 'Cancel run',
    description: 'Cancel a queued or running Canonry run.',
    access: 'write',
    tier: 'core',
    inputSchema: runGetInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, destructiveHint: true }),
    openApiOperations: ['POST /api/v1/runs/{id}/cancel'],
    handler: (client, input) => client.cancelRun(input.runId),
  }),
  defineTool({
    name: 'canonry_queries_add',
    title: 'Add queries',
    description: 'Append tracked queries to a Canonry project; existing queries are skipped by the API.',
    access: 'write',
    tier: 'setup',
    inputSchema: queriesInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/queries'],
    handler: async (client, input) => {
      await client.appendQueries(input.project, uniqueStrings(input.request.queries))
    },
  }),
  defineTool({
    name: 'canonry_keywords_add',
    title: 'Add keywords (legacy alias)',
    description: 'Legacy alias for canonry_queries_add. Appends to the same canonical tracked query set.',
    access: 'write',
    tier: 'setup',
    inputSchema: keywordsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/keywords'],
    handler: async (client, input) => {
      await client.appendKeywords(input.project, uniqueStrings(input.request.keywords))
    },
  }),
  defineTool({
    name: 'canonry_queries_remove',
    title: 'Remove queries',
    description: 'Remove tracked queries from a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: queriesInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/queries'],
    handler: async (client, input) => {
      await client.deleteQueries(input.project, uniqueStrings(input.request.queries))
    },
  }),
  defineTool({
    name: 'canonry_keywords_remove',
    title: 'Remove keywords (legacy alias)',
    description: 'Legacy alias for canonry_queries_remove. Removes from the same canonical tracked query set.',
    access: 'write',
    tier: 'setup',
    inputSchema: keywordsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/keywords'],
    handler: async (client, input) => {
      await client.deleteKeywords(input.project, uniqueStrings(input.request.keywords))
    },
  }),
  defineTool({
    name: 'canonry_competitors_add',
    title: 'Add competitors',
    description: 'Add tracked competitor domains to a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: competitorsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/competitors'],
    handler: async (client, input) => {
      await client.appendCompetitors(input.project, uniqueStrings(input.request.competitors))
    },
  }),
  defineTool({
    name: 'canonry_competitors_remove',
    title: 'Remove competitors',
    description: 'Remove tracked competitor domains from a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: competitorsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/competitors'],
    handler: async (client, input) => {
      await client.deleteCompetitors(input.project, uniqueStrings(input.request.competitors))
    },
  }),
  defineTool({
    name: 'canonry_schedule_set',
    title: 'Set schedule',
    description: 'Create or replace the scheduled run configuration for a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: scheduleSetInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/schedule'],
    handler: (client, input) => client.putSchedule(input.project, input.schedule),
  }),
  defineTool({
    name: 'canonry_schedule_delete',
    title: 'Delete schedule',
    description: 'Delete the scheduled run configuration for a Canonry project. Pass `kind` to delete a non-default schedule (e.g. "traffic-sync"); defaults to "answer-visibility".',
    access: 'write',
    tier: 'setup',
    inputSchema: scheduleReadInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/schedule'],
    handler: async (client, input) => {
      await client.deleteSchedule(input.project, input.kind)
    },
  }),
  defineTool({
    name: 'canonry_insight_dismiss',
    title: 'Dismiss insight',
    description: 'Dismiss an intelligence insight for a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: insightInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/insights/{id}/dismiss'],
    handler: (client, input) => client.dismissInsight(input.project, input.insightId),
  }),
  defineTool({
    name: 'canonry_memory_list',
    title: 'List agent memory',
    description: 'Read project-scoped durable notes Aero has stored via canonry_memory_set (plus compaction summaries). Returns entries newest-first. The N most-recent entries are also injected into the system prompt at session start, so you usually do not need to call this — reach for it when you need older context or the full note value.',
    access: 'read',
    tier: 'agent',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/agent/memory'],
    handler: (client, input) => client.listAgentMemory(input.project),
  }),
  defineTool({
    name: 'canonry_memory_set',
    title: 'Upsert agent memory',
    description: 'Persist a project-scoped durable note visible to every future Aero session for this project. Upsert — writing the same key replaces the prior value. Capped at 2 KB per note. Reserved key prefix "compaction:" is rejected.',
    access: 'write',
    tier: 'agent',
    inputSchema: memoryUpsertInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/agent/memory'],
    handler: (client, input) => client.setAgentMemory(input.project, { key: input.key, value: input.value }),
  }),
  defineTool({
    name: 'canonry_memory_forget',
    title: 'Delete agent memory',
    description: 'Delete a durable note by key. Returns status="missing" (non-error) when the key did not exist. Reserved key prefix "compaction:" cannot be forgotten directly — those notes are pruned automatically.',
    access: 'write',
    tier: 'agent',
    inputSchema: memoryForgetInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/agent/memory'],
    handler: (client, input) => client.forgetAgentMemory(input.project, input.key),
  }),
  defineTool({
    name: 'canonry_agent_clear',
    title: 'Clear agent transcript',
    description: 'Clear the rolling Aero conversation for a project — wipes the transcript, the in-memory pending follow-up buffer, and the persisted follow-up queue. Memory entries (canonry_memory_*) are preserved. Use when starting a fresh dialogue or when the operator wants to reset context.',
    access: 'write',
    tier: 'agent',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/agent/transcript'],
    handler: async (client, input) => {
      await client.resetAgentTranscript(input.project)
      return { status: 'cleared' as const, project: input.project }
    },
  }),
  defineTool({
    name: 'canonry_agent_webhook_attach',
    title: 'Attach agent webhook',
    description: 'Attach an external agent webhook to project run and insight events.',
    access: 'write',
    tier: 'core',
    inputSchema: agentWebhookAttachInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['GET /api/v1/projects/{name}/notifications', 'POST /api/v1/projects/{name}/notifications'],
    handler: async (client, input) => {
      const existing = await client.listNotifications(input.project)
      const agentNotification = existing.find(notification => notification.source === 'agent')
      if (agentNotification) {
        return { status: 'already-attached', project: input.project, notificationId: agentNotification.id }
      }
      const request = notificationCreateRequestSchema.parse({
        channel: 'webhook',
        url: input.url,
        events: AGENT_WEBHOOK_EVENTS,
        source: 'agent',
      })
      const notification = await client.createNotification(input.project, request)
      return { status: 'attached', project: input.project, notificationId: notification.id }
    },
  }),
  defineTool({
    name: 'canonry_agent_webhook_detach',
    title: 'Detach agent webhook',
    description: 'Detach the external agent webhook for a Canonry project.',
    access: 'write',
    tier: 'agent',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['GET /api/v1/projects/{name}/notifications', 'DELETE /api/v1/projects/{name}/notifications/{id}'],
    handler: async (client, input) => {
      const existing = await client.listNotifications(input.project)
      const agentNotification = existing.find(notification => notification.source === 'agent')
      if (!agentNotification) {
        return { status: 'not-attached', project: input.project }
      }
      await client.deleteNotification(input.project, agentNotification.id)
      return { status: 'detached', project: input.project }
    },
  }),
  defineTool({
    name: 'canonry_research_run_start',
    title: 'Start research query run',
    description:
      'Run a batch of free-form queries once each against one API provider, with an optional exact model and location. Results are saved as a research run for later inspection. This does not add any query to the tracked basket or affect overview tracking.',
    access: 'write',
    tier: 'discovery',
    inputSchema: researchRunStartInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/research/runs'],
    handler: (client, input) => client.startResearchRun(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_research_runs_list',
    title: 'List research query runs',
    description:
      'List saved research query runs for a project, newest first. Research and ICP discovery are distinct workflows: these are direct free-form query experiments and never modify the tracked basket.',
    access: 'read',
    tier: 'discovery',
    inputSchema: researchRunsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/research/runs'],
    handler: (client, input) => client.listResearchRuns(input.project, input.limit === undefined ? undefined : { limit: input.limit }),
  }),
  defineTool({
    name: 'canonry_research_run_get',
    title: 'Get research query run',
    description:
      'Get saved per-query answers, source links, cited domains, answer-text named competitors, cited competitor domains, and independent mention/citation results for one research run. It is read-only and does not promote or track any query.',
    access: 'read',
    tier: 'discovery',
    inputSchema: researchRunIdInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/research/runs/{runId}'],
    handler: (client, input) => client.getResearchRun(input.project, input.runId),
  }),
  defineTool({
    name: 'canonry_research_promotion_preview',
    title: 'Preview research query promotion',
    description:
      'Project a completed saved research query into a tracked-query promotion. It makes no durable change, provider call, audit record, or receipt, and returns a structured refusal when setup or audience is unsuitable. It is classified as write because the read-only key gate rejects every POST route.',
    access: 'write',
    tier: 'discovery',
    inputSchema: researchPromotionPreviewInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/research/runs/{runId}/queries/{queryId}/promotion-preview'],
    handler: (client, input) => client.previewResearchPromotion(input.project, input.runId, input.queryId, input.request),
  }),
  defineTool({
    name: 'canonry_discover_run_start',
    title: 'Start discovery run',
    description:
      'Kick off a discovery session for a project: ICP → seed (Gemini grounded prompt) → embed + cluster + pick representative → probe each canonical → classify into cited / aspirational / wasted-surface → aggregate competitor map. Returns {runId, sessionId, status:"running"} immediately; the work runs in the background. Poll canonry_discover_session_get with the returned sessionId until status is "completed" or "failed". Costs roughly $1 / session at default budget; budget capped at 500 probes / session.',
    access: 'write',
    tier: 'discovery',
    inputSchema: discoveryRunInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/discover/run'],
    handler: (client, input) => client.triggerDiscoveryRun(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_discover_sessions_list',
    title: 'List discovery sessions',
    description: 'List recent discovery sessions for a project, newest first. Returns the session-level summary (status, seed counts, bucket counts, competitor map). Use canonry_discover_session_get to drill into per-query probe rows.',
    access: 'read',
    tier: 'discovery',
    inputSchema: discoverySessionsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/discover/sessions'],
    handler: (client, input) => client.listDiscoverySessions(input.project, input.limit !== undefined ? { limit: input.limit } : undefined),
  }),
  defineTool({
    name: 'canonry_discover_session_get',
    title: 'Get discovery session',
    description: 'Get one discovery session with the full probe list (per-query bucket + cited domains). Use after canonry_discover_run_start to inspect what the discovery pipeline produced; this is the canonical read for "what did discovery find" before calling canonry_discover_promote.',
    access: 'read',
    tier: 'discovery',
    inputSchema: discoverySessionIdInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/discover/sessions/{id}'],
    handler: (client, input) => client.getDiscoverySession(input.project, input.sessionId),
  }),
  defineTool({
    name: 'canonry_discover_harvest',
    title: 'Harvest discovery search queries',
    description:
      "Read the search queries the answer engine actually issued (Gemini's grounding fan-out) back out of a session's stored probes, gate them for buyer-intent + novelty, and return the survivors as candidate seeds ranked by how many distinct probes issued each one. These are a THIRD signal — issued retrieval queries — distinct from mention (answer text) and cited (source list); they carry no demand of their own. Read-only and derived: nothing is probed, tracked, or promoted. Use it to surface \"queries the model searched for that you aren't tracking yet\"; the operator/agent then decides what to add via canonry_query_add. minProbeHits raises the recurrence floor; anchor=false disables the subject filter. stats carries the raw count and per-reason rejection tally.",
    access: 'read',
    tier: 'discovery',
    inputSchema: discoveryHarvestInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/discover/sessions/{id}/harvest'],
    handler: (client, input) => client.getDiscoveryHarvest(input.project, input.sessionId, {
      minProbeHits: input.minProbeHits,
      anchor: input.anchor,
    }),
  }),
  defineTool({
    name: 'canonry_discover_promote_preview',
    title: 'Preview discovery promotion',
    description: 'Read-only preview of available promotion candidates for a session: bucketed query lists and recurring suggested competitor domains not already in the project\'s tracked competitor list. Use it to confirm a basket before calling canonry_discover_promote.',
    access: 'read',
    tier: 'discovery',
    inputSchema: discoverySessionIdInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/discover/sessions/{id}/promote'],
    handler: (client, input) => client.previewDiscoveryPromote(input.project, input.sessionId),
  }),
  defineTool({
    name: 'canonry_discover_promote',
    title: 'Promote discovery session',
    description: 'Adopt a completed discovery session\'s bucketed queries into the project\'s tracked basket, tagged with provenance "discovery:<sessionId>". By default, only cited + aspirational queries are promoted; include wasted-surface explicitly when off-ICP competitor gaps should also be tracked. Recurring discovered competitor domains classified as direct-competitor are also merged by default — pass request.competitorTypes to adopt editorial-media channels or recover legacy unknown entries. Add-only and idempotent: queries/domains already tracked are returned under `skipped`, never inserted twice. Only sessions with status "completed" can be promoted. Call canonry_discover_promote_preview first to inspect candidates.',
    access: 'write',
    tier: 'discovery',
    inputSchema: discoveryPromoteInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/discover/sessions/{id}/promote'],
    handler: (client, input) => client.promoteDiscovery(input.project, input.sessionId, input.request),
  }),
  defineTool({
    name: 'canonry_site_health_overview',
    title: 'Get Site Health overview',
    description: 'Start a Site Health investigation with the latest or selected scan summary: root URL, completeness, crawl and link counts, budgets, versions, termination, and dead-link check state. Follow with a focused Site Health subgraph, shortest path, or scan changes; never request the interactive graph projection through MCP.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoCrawlInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/crawl'],
    handler: (client, input) => client.getTechnicalAeoCrawl(input.project, { runId: input.runId }),
  }),
  defineTool({
    name: 'canonry_site_health_page_audit',
    title: 'Get Site Health page audit',
    description: 'Connect one graph page\'s audit score to its exact persisted evidence: factor scores, stable finding codes and messages, recommendations, and critical defects. The response includes crawl provenance and explicit no-crawl, details-unavailable, not-found, not-audited, ready/scores-only states. Use nodeKey from a Site Health page or subgraph read when possible. Link score remains an importance signal, not an audit finding.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: siteHealthPageAuditInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/crawl/pages/audit'],
    handler: (client, input) => client.getTechnicalAeoPageAudit(input.project, {
      runId: input.runId,
      nodeKey: input.nodeKey,
      url: input.url,
    }),
  }),
  defineTool({
    name: 'canonry_site_health_subgraph',
    title: 'Inspect focused Site Health subgraph',
    description: 'Read a compact canonical neighborhood around one page or the crawl root. Defaults to 25 nodes and 50 edges; expand hops or refocus only when needed. `countAccuracy=lower-bound` means traversal reached a cap, and `complete`/`termination` qualify partial-crawl results. This intentionally omits visualization coordinates and never materializes the full site graph.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: siteHealthSubgraphInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/subgraph'],
    handler: (client, input) => client.getSiteHealthSubgraph(input.project, {
      runId: input.runId,
      nodeKey: input.nodeKey,
      url: input.url,
      hops: input.hops,
      maxNodes: input.maxNodes,
      maxEdges: input.maxEdges,
    }),
  }),
  defineTool({
    name: 'canonry_site_health_path',
    title: 'Find shortest Site Health path',
    description: 'Find the shortest directed path of followable internal links from the crawl root or a selected page to one required destination. Use `complete` and `termination` to qualify unreachable or truncated outcomes from a partial crawl; it returns one path, not a graph traversal.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: siteHealthPathInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/path'],
    handler: (client, input) => client.getSiteHealthPath(input.project, {
      runId: input.runId,
      fromNodeKey: input.fromNodeKey,
      fromUrl: input.fromUrl,
      toNodeKey: input.toNodeKey,
      toUrl: input.toUrl,
      maxDepth: input.maxDepth,
    }),
  }),
  defineTool({
    name: 'canonry_site_health_changes',
    title: 'Compare Site Health scans',
    description: 'Compare two immutable complete scans (or the latest pair) for added, removed, and changed canonical pages or links. Results echo resolved filters and scan IDs; the first page has an exact summary, while continuations omit summary/total. MCP pages cap at 25 because every change carries before/after DTOs; filter before paging.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: siteHealthChangesInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/changes'],
    handler: (client, input) => client.getSiteHealthChanges(input.project, {
      fromRunId: input.fromRunId,
      toRunId: input.toRunId,
      scope: input.scope,
      change: input.change,
      cursor: input.cursor,
      limit: input.limit,
    }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_score',
    title: 'Get Technical AEO score',
    description:
      'Get the Technical AEO scorecard for a project: the latest site-audit aggregate 0–100 score, per-factor site-level averages (with pass/partial/fail distribution), cross-cutting issues, prioritized fixes, and the delta vs the previous audit. When `hasData` is false the project has never been audited — call canonry_technical_aeo_run first.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoScoreInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo'],
    handler: (client, input) => client.getTechnicalAeoScore(input.project, { runId: input.runId }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_pages',
    title: 'List Technical AEO pages',
    description:
      'List the per-page breakdown of the latest site-audit run (paginated). Filter status=error to surface unreachable pages, or sort score-asc (default) to surface the worst-scoring pages first. Use after canonry_technical_aeo_score to drill into which pages drag the site score down.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoPagesInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/pages'],
    handler: (client, input) => client.getTechnicalAeoPages(input.project, {
      runId: input.runId,
      status: input.status,
      sort: input.sort,
      limit: input.limit,
      offset: input.offset,
    }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_trend',
    title: 'Get Technical AEO trend',
    description: 'Get the aggregate Technical AEO score over time (oldest-first) across past site-audit runs. Use to answer "is our technical AEO improving?".',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoTrendInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/trend'],
    handler: (client, input) => client.getTechnicalAeoTrend(input.project, input.limit !== undefined ? { limit: input.limit } : undefined),
  }),
  defineTool({
    name: 'canonry_technical_aeo_crawl',
    title: 'Get persisted Technical AEO crawl',
    description: 'Read persisted full-crawl metadata for the latest or selected Technical AEO site-audit run: root URL, crawl/indexability/link-score versions, effective budgets, completeness, counts, and explicit dead-link check state. This does not fabricate a graph from older scorecard-only audits.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoCrawlInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/crawl'],
    handler: (client, input) => client.getTechnicalAeoCrawl(input.project, { runId: input.runId }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_crawl_pages',
    title: 'List Technical AEO crawl pages',
    description: 'Read one bounded, cursor-paged list of canonical crawl nodes. Filter crawler-derived indexability and audit state, then follow nextCursor; this is technical inventory eligibility, not a claim about Google index coverage.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoCrawlPagesInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/crawl/pages'],
    handler: (client, input) => client.getTechnicalAeoCrawlPages(input.project, {
      runId: input.runId,
      inventoryEligible: input.inventoryEligible,
      fetchState: input.fetchState,
      indexabilityState: input.indexabilityState,
      auditState: input.auditState,
      sort: input.sort,
      cursor: input.cursor,
      limit: input.limit,
    }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_structure',
    title: 'List Technical AEO site structure',
    description: 'Read one bounded level of the persisted site hierarchy below parentPath. Follow nextCursor for more siblings; request a child path separately rather than attempting to materialize the entire website tree.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoStructureInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/structure'],
    handler: (client, input) => client.getTechnicalAeoStructure(input.project, {
      runId: input.runId,
      parentPath: input.parentPath,
      cursor: input.cursor,
      limit: input.limit,
    }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_internal_links',
    title: 'List Technical AEO internal links',
    description: 'Read a bounded, cursor-paged list of persisted internal crawl edges. Filter by source URL, target URL, followability, or link kind. Nav, header, and footer links are marked isTemplate; templateSource says which rule decided each one (placement, ubiquity, or unmeasured when neither had evidence) and templateDetection reports the same for the scan, so an empty content-only list is not evidence of no content links and two scans classified by different rules are never compared as if they were the same measurement. Use the neighbors tool for one page rather than loading a graph.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoInternalLinksInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/internal-links'],
    handler: (client, input) => client.getTechnicalAeoInternalLinks(input.project, {
      runId: input.runId,
      sourceUrl: input.sourceUrl,
      targetUrl: input.targetUrl,
      followable: input.followable,
      linkKind: input.linkKind,
      cursor: input.cursor,
      limit: input.limit,
    }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_link_neighbors',
    title: 'Get Technical AEO page link neighbors',
    description: 'Read bounded inbound and outbound internal links for exactly one crawl node, selected by nodeKey or URL. Filter by link kind to separate editorial links from nav, header, and footer links. It returns independent truncation flags for inbound and outbound edges, not a transitive traversal.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoLinkNeighborsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/internal-links/neighbors'],
    handler: (client, input) => client.getTechnicalAeoInternalLinkNeighbors(input.project, {
      runId: input.runId,
      nodeKey: input.nodeKey,
      url: input.url,
      linkKind: input.linkKind,
      limit: input.limit,
    }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_dead_links',
    title: 'List Technical AEO dead links',
    description: 'Read the persisted dead-link check state and a bounded, cursor-paged list of findings. A disabled result means the crawl was run without opt-in checks; it never means zero dead links.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: technicalAeoDeadLinksInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/technical-aeo/dead-links'],
    handler: (client, input) => client.getTechnicalAeoDeadLinks(input.project, {
      runId: input.runId,
      cursor: input.cursor,
      limit: input.limit,
    }),
  }),
  defineTool({
    name: 'canonry_technical_aeo_run',
    title: 'Run Technical AEO site audit',
    description:
      'Start a site-audit run. The run discovers root, sitemap, and linked pages. Its unattended default is 1,000 pages and 100,000 link observations; callers may explicitly raise either to its hard maximum. It returns {runId, status} and continues in the background. If an active run has identical effective options, this tool returns it; different options are refused. Poll canonry_run_get, then read the crawl and score tools.',
    access: 'write',
    tier: 'monitoring',
    inputSchema: technicalAeoRunInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/technical-aeo/runs'],
    handler: (client, input) => client.triggerSiteAudit(input.project, {
      sitemapUrl: input.sitemapUrl,
      limit: input.limit,
      maxPages: input.maxPages,
      maxEdges: input.maxEdges,
      maxDepth: input.maxDepth,
      checkDeadLinks: input.checkDeadLinks,
    }),
  }),
  // ----- Google Marketing: Google Ads + Google Tag Manager -----
  // OAuth, selection, disconnect, and contract writes deliberately stay on
  // the operator CLI/dashboard. The agent surface can only inspect bounded
  // evidence, trigger bounded read-only syncs, and assess stored integrity.
  defineTool({
    name: 'canonry_google_ads_status',
    title: 'Get Google Ads connection status',
    description: 'Read the project-local Google Ads connection, selected customer, and stored-evidence freshness. This never exposes credentials or changes a Google Ads account.',
    access: 'read',
    tier: 'google-ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google-ads/status'],
    handler: (client, input) => client.getGoogleAdsStatus(input.project),
  }),
  defineTool({
    name: 'canonry_google_ads_customers',
    title: 'List live Google Ads customers',
    description: 'Read the bounded set of Google Ads customers available to the project OAuth connection. This makes live provider GET requests and requires google-marketing.read-live; customer selection remains an explicit operator action.',
    access: 'read',
    tier: 'google-ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/google-ads/customers'],
    handler: (client, input) => client.listGoogleAdsCustomers(input.project),
  }),
  defineTool({
    name: 'canonry_conversion_tracking_options',
    title: 'List selectable conversion actions and GTM tags',
    description: 'List the Google Ads conversion actions and Tag Manager tags a conversion contract can point at, read from the newest stored snapshots. Stored read: quota-free, never calls a provider, never spends the advertiser budget. An empty list means the provider has not synced, not that no options exist.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/conversion-tracking/options'],
    handler: (client, input) => client.getConversionTrackingOptions(input.project),
  }),
  defineTool({
    name: 'canonry_google_ads_performance',
    title: 'Read stored Google Ads performance',
    description: 'Read impressions, clicks, cost (integer micros), conversions, the densified daily series, per-campaign totals, and the prior-equal-period comparison from the newest stored campaign-metrics snapshot. Stored read: it is quota-free, never calls Google, and never spends the advertiser budget. The capture day is partial and is excluded, so every window ends on the newest closed day.',
    access: 'read',
    tier: 'google-ads',
    inputSchema: googleAdsPerformanceInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google-ads/performance'],
    handler: (client, input) => client.getGoogleAdsPerformance(
      input.project,
      input.window ? { window: input.window } : {},
    ),
  }),
  defineTool({
    name: 'canonry_google_ads_snapshots',
    title: 'List stored Google Ads evidence',
    description: 'List a bounded page of redacted, append-only Google Ads snapshots. Stored reads are quota-free and do not call Google.',
    access: 'read',
    tier: 'google-ads',
    inputSchema: googleMarketingSnapshotPageInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google-ads/snapshots'],
    handler: (client, input) => client.listGoogleAdsSnapshots(input.project, {
      limit: input.limit,
      cursor: input.cursor,
    }),
  }),
  defineTool({
    name: 'canonry_google_ads_snapshot_get',
    title: 'Get stored Google Ads evidence',
    description: 'Read one redacted Google Ads evidence snapshot by ID. It can show conversion actions and effective campaign goals, but cannot prove a browser conversion fired.',
    access: 'read',
    tier: 'google-ads',
    inputSchema: googleMarketingSnapshotInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google-ads/snapshots/{snapshotId}'],
    handler: (client, input) => client.getGoogleAdsSnapshot(input.project, input.snapshotId),
  }),
  defineTool({
    name: 'canonry_google_ads_sync',
    title: 'Sync Google Ads conversion evidence',
    description: 'Queue a bounded read-only Google Ads evidence sync using GETs and SearchStream POSTs. It creates a local run and sanitized snapshots, but never changes campaigns, conversion actions, goals, bids, or budgets. Requires google-marketing.read-live and write authority.',
    access: 'write',
    tier: 'google-ads',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/google-ads/sync'],
    handler: (client, input) => client.triggerGoogleAdsSync(input.project),
  }),
  defineTool({
    name: 'canonry_gtm_status',
    title: 'Get Google Tag Manager connection status',
    description: 'Read the project-local GTM connection, selected account/container/workspace, and stored-evidence freshness. This never exposes credentials or edits GTM.',
    access: 'read',
    tier: 'gtm',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gtm/status'],
    handler: (client, input) => client.getGtmStatus(input.project),
  }),
  defineTool({
    name: 'canonry_gtm_accounts',
    title: 'List live GTM accounts',
    description: 'Read the bounded set of GTM accounts available to the project OAuth connection. This makes live provider GET requests and requires google-marketing.read-live; resource selection remains operator-only.',
    access: 'read',
    tier: 'gtm',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/gtm/accounts'],
    handler: (client, input) => client.listGtmAccounts(input.project),
  }),
  defineTool({
    name: 'canonry_gtm_containers',
    title: 'List live GTM containers',
    description: 'Read the bounded set of containers in one GTM account. This is a live GET-only provider read; it cannot edit or publish a container.',
    access: 'read',
    tier: 'gtm',
    inputSchema: gtmAccountInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/gtm/accounts/{accountId}/containers'],
    handler: (client, input) => client.listGtmContainers(
      input.project,
      canonicalGtmMcpAccountId(input.accountId),
    ),
  }),
  defineTool({
    name: 'canonry_gtm_workspaces',
    title: 'List live GTM workspaces',
    description: 'Read the bounded set of workspaces in one GTM container. This is a live GET-only provider read; it cannot edit a workspace or publish a version.',
    access: 'read',
    tier: 'gtm',
    inputSchema: gtmContainerInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/gtm/accounts/{accountId}/containers/{containerId}/workspaces'],
    handler: (client, input) => {
      const selection = canonicalGtmMcpSelection(input.accountId, input.containerId)
      return client.listGtmWorkspaces(input.project, selection.accountId, selection.containerId)
    },
  }),
  defineTool({
    name: 'canonry_gtm_snapshots',
    title: 'List stored GTM evidence',
    description: 'List a bounded page of redacted, append-only GTM live/draft graph snapshots. Stored reads are quota-free and do not call Google.',
    access: 'read',
    tier: 'gtm',
    inputSchema: googleMarketingSnapshotPageInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gtm/snapshots'],
    handler: (client, input) => client.listGtmSnapshots(input.project, {
      limit: input.limit,
      cursor: input.cursor,
    }),
  }),
  defineTool({
    name: 'canonry_gtm_snapshot_get',
    title: 'Get stored GTM evidence',
    description: 'Read one redacted GTM live/draft graph snapshot by ID. It can prove static tag and trigger configuration only; it cannot prove a browser event fired.',
    access: 'read',
    tier: 'gtm',
    inputSchema: googleMarketingSnapshotInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gtm/snapshots/{snapshotId}'],
    handler: (client, input) => client.getGtmSnapshot(input.project, input.snapshotId),
  }),
  defineTool({
    name: 'canonry_gtm_sync',
    title: 'Sync GTM conversion evidence',
    description: 'Queue a bounded GTM GET-only evidence sync. It creates a local run and sanitized live/draft snapshots, but never edits a workspace or publishes a container version. Requires google-marketing.read-live and write authority.',
    access: 'write',
    tier: 'gtm',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/gtm/sync'],
    handler: (client, input) => client.triggerGtmSync(input.project),
  }),
  defineTool({
    name: 'canonry_conversion_tracking_contracts',
    title: 'List conversion-tracking contracts',
    description: 'List the project’s declared business contracts linking an application event to Google Ads and GTM identifiers. Contract creation and changes remain operator-only.',
    access: 'read',
    tier: 'conversion-tracking',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/conversion-tracking/contracts'],
    handler: (client, input) => client.listConversionTrackingContracts(input.project),
  }),
  defineTool({
    name: 'canonry_conversion_tracking_contract_get',
    title: 'Get conversion-tracking contract',
    description: 'Read one declared conversion-tracking contract. It declares intended semantics; use integrity assessment to evaluate stored evidence.',
    access: 'read',
    tier: 'conversion-tracking',
    inputSchema: conversionTrackingContractInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}'],
    handler: (client, input) => client.getConversionTrackingContract(input.project, input.contractId),
  }),
  defineTool({
    name: 'canonry_conversion_tracking_integrity',
    title: 'Assess stored conversion integrity',
    description: 'Evaluate a declared contract against stored redacted Google Ads and GTM evidence. This does not call providers and cannot treat static configuration as proof of a browser event or observed Google Ads conversion.',
    access: 'read',
    tier: 'conversion-tracking',
    inputSchema: conversionTrackingContractInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}/integrity'],
    handler: (client, input) => client.getConversionTrackingIntegrity(input.project, input.contractId),
  }),
  // ----- OpenAI ads (ChatGPT ads) -----
  defineTool({
    name: 'canonry_ads_status',
    title: 'OpenAI ads connection status',
    description: 'Connection status and last sync time for the project\'s OpenAI ad account (ChatGPT ads).',
    access: 'read',
    tier: 'ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/status'],
    handler: (client, input) => client.getAdsStatus(input.project),
  }),
  defineTool({
    name: 'canonry_ads_account',
    title: 'Read the live OpenAI ads account',
    description:
      'Read live OpenAI Ads account metadata, currency, timezone, status, and account-integrity review state. Use before planning or launch to confirm the connected advertiser account is the intended one and is eligible to serve.',
    access: 'read',
    tier: 'ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/account'],
    handler: (client, input) => client.getAdsAccount(input.project),
  }),
  defineTool({
    name: 'canonry_ads_geo_search',
    title: 'Search OpenAI ads locations',
    description:
      'Search the live OpenAI Ads geo catalog by place name. Returns provider location IDs and canonical labels; use those IDs in campaign locationIds instead of inventing or guessing targeting identifiers.',
    access: 'read',
    tier: 'ads',
    inputSchema: adsGeoSearchInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/geo/search'],
    handler: (client, input) => client.searchAdsGeo(input.project, { q: input.q, limit: input.limit }),
  }),
  defineTool({
    name: 'canonry_ads_conversion_pixels',
    title: 'List OpenAI ads conversion pixels',
    description:
      'List conversion pixels from the live OpenAI ad account. Use with conversion event settings to verify that measurable conversion infrastructure exists before recommending activation or budget changes.',
    access: 'read',
    tier: 'ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/conversions/pixels'],
    handler: (client, input) => client.getAdsConversionPixels(input.project),
  }),
  defineTool({
    name: 'canonry_ads_conversion_event_settings',
    title: 'List OpenAI ads conversion event settings',
    description:
      'List live OpenAI Ads conversion event settings, attribution windows, and attached pixel or CAPI sources. Use to select and verify the conversion goal before launch.',
    access: 'read',
    tier: 'ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/conversions/event-settings'],
    handler: (client, input) => client.getAdsConversionEventSettings(input.project),
  }),
  defineTool({
    name: 'canonry_ads_campaigns',
    title: 'List synced ad campaigns',
    description: 'Synced campaign snapshots with nested ad groups (context hints — the targeting primitive) and ads. Paid-surface structure; never conflate with organic cited/mentioned signals.',
    access: 'read',
    tier: 'ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/campaigns'],
    handler: (client, input) => client.getAdsCampaigns(input.project),
  }),
  defineTool({
    name: 'canonry_ads_insights',
    title: 'Daily paid-performance rollups',
    description: 'Daily paid-performance rollups per level (campaign/ad_group). Spend is integer micros; ctr/cpcMicros are derived server-side (null on zero denominators).',
    access: 'read',
    tier: 'ads',
    inputSchema: adsInsightsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/insights'],
    handler: (client, input) => client.getAdsInsights(input.project, compactStringParams(input, ['level', 'entityId', 'from', 'to'])),
  }),
  defineTool({
    name: 'canonry_ads_summary',
    title: 'Paid-performance summary',
    description: 'Composite paid summary: campaign/ad-group/ad counts, campaign-level totals (impressions, clicks, spend micros, derived ctr/cpc) and the covered date window.',
    access: 'read',
    tier: 'ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/summary'],
    handler: (client, input) => client.getAdsSummary(input.project),
  }),
  defineTool({
    name: 'canonry_ads_delivery_diagnostics',
    title: 'Stored ads delivery diagnostics',
    description: 'Read stored ads snapshot provenance, account/campaign/ad-group/ad configuration facts, and historical campaign activity in one call. This is not a live OpenAI eligibility or serving verdict.',
    access: 'read',
    tier: 'ads',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/delivery-diagnostics'],
    handler: (client, input) => client.getAdsDeliveryDiagnostics(input.project),
  }),
  defineTool({
    name: 'canonry_ads_live_delivery',
    title: 'Live ads read with stored-snapshot delta',
    description: 'Call the OpenAI Ads API right now and return the provider\'s current status and metrics per campaign / ad group / ad, unaggregated, alongside the stored snapshot values and an explicit per-entity delta. Use this when stored data is suspected of being stale or contradicted by the advertiser UI. Read-only: it mutates nothing and does not wait for a sync. The walk is bounded and one project may issue at most one live read per minute, so prefer canonry_ads_delivery_diagnostics for routine checks.',
    access: 'read',
    tier: 'ads',
    inputSchema: adsLiveDeliveryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/live-delivery'],
    handler: (client, input) => client.getAdsLiveDelivery(input.project, {
      campaignId: input.campaignId,
      lookbackDays: input.lookbackDays,
    }),
  }),
  defineTool({
    name: 'canonry_ads_operations_unresolved',
    title: 'List unresolved ads mutation receipts',
    description:
      'List pending, unknown, or actively reconciling OpenAI Ads mutation receipts that need recovery. Pass nextCursor back as cursor to advance past permanent rows. Use this before new lifecycle work so an ambiguous earlier outcome is settled instead of retried under another key. Route campaign_tree_activate receipts to canonry_ads_operation_resume_activation; use generic reconciliation only for other supported receipt kinds.',
    access: 'read',
    tier: 'ads',
    inputSchema: adsUnresolvedOperationsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/operations'],
    handler: (client, input) => client.getUnresolvedAdsOperations(input.project, {
      state: input.state,
      limit: input.limit,
      cursor: input.cursor,
    }),
  }),
  defineTool({
    name: 'canonry_ads_operation_get',
    title: 'Get an ads mutation receipt',
    description:
      'Read the durable receipt for an OpenAI Ads mutation by its caller-supplied operation key. Never retry a pending or unknown receipt with a new key because the upstream request may already have succeeded. Resume campaign_tree_activate receipts through canonry_ads_operation_resume_activation; send other supported receipt kinds to generic reconciliation.',
    access: 'read',
    tier: 'ads',
    inputSchema: adsOperationInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ads/operations/{operationKey}'],
    handler: (client, input) => client.getAdsOperation(input.project, input.operationKey),
  }),
  defineTool({
    name: 'canonry_ads_operation_reconcile',
    title: 'Reconcile an ads mutation receipt',
    description:
      'Verify a checkpointed provider entity against the receipt-bound OpenAI ad account without retrying the original mutation. Uncheckpointed creates remain unresolved because mutable-field matching cannot prove provenance. This generic tool rejects campaign_tree_activate receipts; use canonry_ads_operation_resume_activation for those.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsOperationReconcileInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/operations/{operationKey}/reconcile'],
    handler: (client, input) => client.reconcileAdsOperation(input.project, input.operationKey),
  }),
  defineTool({
    name: 'canonry_ads_operation_resume_activation',
    title: 'Resume an ads activation receipt',
    description:
      'Resume recovery for an existing campaign_tree_activate receipt using its durable approval grant and ordered step ledger. The request is bodyless, requires ads.activate on the exact executor key already bound to the grant, and cannot replace the operation, grant, manifest, campaign, or account. Canonry inspects provider state and never blindly resends an ambiguous activation mutation.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsOperationResumeActivationInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/operations/{operationKey}/resume-activation'],
    handler: (client, input) => client.resumeAdsActivation(input.project, input.operationKey),
  }),
  defineTool({
    name: 'canonry_ads_image_upload',
    title: 'Upload an ads image from URL',
    description:
      'Upload a public HTTPS image URL to the connected OpenAI ad account. The operation key makes a repeated identical request replay its receipt without another upstream upload. Save the returned file entityId for chat-card creation.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsImageUploadInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/files'],
    handler: (client, input) => client.uploadAdsImage(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_ads_campaign_create',
    title: 'Create a paused ads campaign',
    description:
      'Create an OpenAI Ads campaign PAUSED with an explicit lifetime spend limit and location allowlist. Set biddingType=clicks with one or more provider-issued conversionEventSettingIds for conversion-optimized delivery; omit both for legacy impressions bidding. The server ignores any status concept and always sends paused. Inspect the receipt, then create matching paused ad groups and ads. A human must separately approve the exact tree before this operator can activate it.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsCampaignCreateInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/campaigns'],
    handler: (client, input) => client.createAdsCampaign(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_ads_campaign_update',
    title: 'Update an ads campaign',
    description:
      'Update a PAUSED campaign copy, dates, lifetime spend limit, or locations without changing status. Active campaigns fail closed: pause first, sync, and use the refreshed upstreamUpdatedAt. A human must approve the exact updated tree before this operator can reactivate it. Uses a durable operation key.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsCampaignUpdateInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/campaigns/{id}'],
    handler: (client, input) => client.updateAdsCampaign(input.project, input.campaignId, input.request),
  }),
  defineTool({
    name: 'canonry_ads_campaign_activate_tree',
    title: 'Activate an approved ads campaign tree',
    description:
      'Execute one short-lived human approval grant for the exact paused campaign, ad groups, and reviewed ads named by its manifest. The grant is bound to this executor key and manifest hash. Canonry checkpoints every step, activates ads before parents, verifies active state, and rolls back parent-first on failure. This tool cannot create or widen an approval.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsCampaignActivateTreeInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/campaigns/{id}/activate-tree'],
    handler: (client, input) => client.activateAdsCampaignTree(input.project, input.campaignId, input.request),
  }),
  defineTool({
    name: 'canonry_ads_campaign_pause',
    title: 'Pause an ads campaign',
    description:
      'Pause a campaign immediately. Use this first when spend, conversion tracking, landing-page behavior, or policy status is unsafe. The operation is idempotent through its durable operation key.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsCampaignPauseInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/campaigns/{id}/pause'],
    handler: (client, input) => client.pauseAdsCampaign(input.project, input.campaignId, input.request),
  }),
  defineTool({
    name: 'canonry_ads_ad_group_create',
    title: 'Create a paused ads ad group',
    description:
      'Create a PAUSED ad group under a reviewed campaign. Context hints describe when the audit offer is useful. Set billingEventType=click under a clicks campaign; omit it for the legacy impression mode. Canonry reads the live parent and rejects a billing/bidding mismatch before mutation.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsAdGroupCreateInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/ad-groups'],
    handler: (client, input) => client.createAdsAdGroup(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_ads_ad_group_update',
    title: 'Update an ads ad group',
    description:
      'Update a PAUSED ad group name, description, context hints, or max bid without changing its billing event or status. Active ad groups fail closed: pause first, sync, and use the refreshed upstreamUpdatedAt. A human must reactivate after review. Uses a durable operation key.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsAdGroupUpdateInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/ad-groups/{id}'],
    handler: (client, input) => client.updateAdsAdGroup(input.project, input.adGroupId, input.request),
  }),
  defineTool({
    name: 'canonry_ads_ad_group_pause',
    title: 'Pause an ads ad group',
    description: 'Pause an ad group through a durable idempotent operation receipt.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsAdGroupPauseInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/ad-groups/{id}/pause'],
    handler: (client, input) => client.pauseAdsAdGroup(input.project, input.adGroupId, input.request),
  }),
  defineTool({
    name: 'canonry_ads_ad_create',
    title: 'Create a paused chat-card ad',
    description:
      'Create a PAUSED ChatGPT chat-card ad using a previously uploaded file entityId and an HTTPS destination. Title is 3-50 characters and body is at most 100. Activation is deliberately human-only for the beta.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsAdCreateInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/ads'],
    handler: (client, input) => client.createAdsAd(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_ads_ad_update',
    title: 'Update a chat-card ad',
    description:
      'Update a PAUSED ad name or full chat-card creative without changing status. Active ads fail closed: pause first, sync, and use the refreshed upstreamUpdatedAt. A human must reactivate after review. Uses a durable operation key.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsAdUpdateInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/ads/{id}'],
    handler: (client, input) => client.updateAdsAd(input.project, input.adId, input.request),
  }),
  defineTool({
    name: 'canonry_ads_ad_pause',
    title: 'Pause a chat-card ad',
    description: 'Pause an individual ad through a durable idempotent operation receipt.',
    access: 'write',
    tier: 'ads',
    inputSchema: adsAdPauseInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/ads/{id}/pause'],
    handler: (client, input) => client.pauseAdsAd(input.project, input.adId, input.request),
  }),
  defineTool({
    name: 'canonry_ads_sync',
    title: 'Trigger ads sync',
    description: 'Trigger an ads-sync run (entity snapshots + daily paid-performance rollups) for the connected OpenAI ad account. Returns the run id; poll canonry_run_get for status.',
    access: 'write',
    tier: 'ads',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/ads/sync'],
    handler: (client, input) => client.triggerAdsSync(input.project),
  }),
] as const

export const CANONRY_MCP_TOOL_COUNT = canonryMcpTools.length
export const CANONRY_MCP_READ_TOOL_COUNT = canonryMcpTools.filter(tool => tool.access === 'read').length
export const CANONRY_MCP_CORE_TOOL_COUNT = canonryMcpTools.filter(tool => tool.tier === 'core').length
export type CanonryMcpRegistryTool = typeof canonryMcpTools[number]
export type CanonryMcpToolName = CanonryMcpRegistryTool['name']
export const CanonryMcpToolNames = Object.freeze(
  Object.fromEntries(canonryMcpTools.map((tool) => [tool.name, tool.name])),
) as { readonly [K in CanonryMcpToolName]: K }
