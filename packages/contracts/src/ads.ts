import { z } from 'zod'

// OpenAI Advertiser API (ChatGPT ads) DTOs. Money is integer micros
// everywhere (spendMicros, cpcMicros, budget/bid micros) — the upstream
// insights API's decimal dollars are normalized at ingest. Vocabulary:
// paid metrics are "paid" / "sponsored"; never reuse "mentioned" / "cited"
// (those mean answer-text and source-list presence).

export const adsConnectRequestSchema = z.object({
  /** Ads Manager "SDK key" scoped to one ad account. Stored in config.yaml, never the DB. */
  apiKey: z.string().min(1),
})
export type AdsConnectRequest = z.infer<typeof adsConnectRequestSchema>

/** Normalized current-account metadata returned by the OpenAI Ads API. */
export const adsAccountDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  currencyCode: z.string().nullable(),
  timezone: z.string().nullable(),
  url: z.string().nullable(),
  reviewStatus: z.string().nullable(),
  integrityReviewStatus: z.string().nullable(),
  integrityDecision: z.string().nullable(),
})
export type AdsAccountDto = z.infer<typeof adsAccountDtoSchema>

export const adsGeoSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(100).default(20),
})
export type AdsGeoSearchQuery = z.infer<typeof adsGeoSearchQuerySchema>

const adsGeoLocationDtoSchema = z.object({
  id: z.string(),
  type: z.string(),
  canonicalName: z.string(),
  countryCode: z.string(),
  name: z.string(),
  regionCode: z.string().nullable(),
})

export const adsGeoSearchResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  query: z.string(),
  results: z.array(adsGeoLocationDtoSchema),
})
export type AdsGeoSearchResponse = z.infer<typeof adsGeoSearchResponseSchema>

const adsConversionPixelDtoSchema = z.object({
  id: z.string(),
  clientType: z.string().optional(),
  name: z.string().optional(),
  pixelId: z.string().optional(),
})

export const adsConversionPixelListResponseSchema = z.object({
  pixels: z.array(adsConversionPixelDtoSchema),
})
export type AdsConversionPixelListResponse = z.infer<typeof adsConversionPixelListResponseSchema>

const adsConversionEventSettingSourceDtoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
})

const adsConversionEventSettingDtoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  eventType: z.string().optional(),
  customEventName: z.string().nullable().optional(),
  attributionWindowDays: z.number().int().positive().optional(),
  adAccountId: z.string().optional(),
  sourceIds: z.array(z.string()).optional(),
  sources: z.array(adsConversionEventSettingSourceDtoSchema).optional(),
  archived: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
})

export const adsConversionEventSettingListResponseSchema = z.object({
  eventSettings: z.array(adsConversionEventSettingDtoSchema),
})
export type AdsConversionEventSettingListResponse = z.infer<typeof adsConversionEventSettingListResponseSchema>

export const adsConnectionStatusDtoSchema = z.object({
  connected: z.boolean(),
  adAccountId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  currencyCode: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  reviewStatus: z.string().nullable().optional(),
  integrityReviewStatus: z.string().nullable().optional(),
  integrityDecision: z.string().nullable().optional(),
  lastSyncedAt: z.string().nullable().optional(),
  /** Whether the ad account has OpenAI conversion tracking (pixel or CAPI) configured,
   *  detected from synced campaigns carrying conversion_event_setting_ids. Optional:
   *  only present when connected. */
  conversionTrackingConfigured: z.boolean().optional(),
})
export type AdsConnectionStatusDto = z.infer<typeof adsConnectionStatusDtoSchema>

export const adsDisconnectResponseSchema = z.object({
  disconnected: z.boolean(),
})
export type AdsDisconnectResponse = z.infer<typeof adsDisconnectResponseSchema>

export const adsSyncResponseSchema = z.object({
  runId: z.string(),
  status: z.string(),
})
export type AdsSyncResponse = z.infer<typeof adsSyncResponseSchema>

export const adsCreativeDtoSchema = z.object({
  type: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
  fileId: z.string().nullable().optional(),
})
export type AdsCreativeDto = z.infer<typeof adsCreativeDtoSchema>

/** Campaign-level optimization objective accepted by the OpenAI Advertiser API. */
export const adsCampaignBiddingTypeSchema = z.enum(['impressions', 'clicks'])
export type AdsCampaignBiddingType = z.infer<typeof adsCampaignBiddingTypeSchema>
export const AdsCampaignBiddingTypes = adsCampaignBiddingTypeSchema.enum

/** Ad-group event used to bill the campaign's configured bid. */
export const adsAdGroupBillingEventTypeSchema = z.enum(['impression', 'click'])
export type AdsAdGroupBillingEventType = z.infer<typeof adsAdGroupBillingEventTypeSchema>
export const AdsAdGroupBillingEventTypes = adsAdGroupBillingEventTypeSchema.enum

export const adsAdDtoSchema = z.object({
  id: z.string(),
  adGroupId: z.string(),
  name: z.string(),
  status: z.string(),
  reviewStatus: z.string().nullable().optional(),
  creative: adsCreativeDtoSchema.nullable().optional(),
  upstreamUpdatedAt: z.number().int().nullable().optional(),
  syncedAt: z.string().optional(),
})
export type AdsAdDto = z.infer<typeof adsAdDtoSchema>

export const adsAdGroupDtoSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  billingEventType: z.union([adsAdGroupBillingEventTypeSchema, z.null()]).optional(),
  maxBidMicros: z.number().int().nullable().optional(),
  /**
   * The targeting primitive: entries are multi-line strings of
   * newline-separated example queries (the live Ads Manager format).
   */
  contextHints: z.array(z.string()).default([]),
  ads: z.array(adsAdDtoSchema).default([]),
  upstreamUpdatedAt: z.number().int().nullable().optional(),
  syncedAt: z.string().optional(),
})
export type AdsAdGroupDto = z.infer<typeof adsAdGroupDtoSchema>

export const adsCampaignDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  startTime: z.number().int().nullable().optional(),
  endTime: z.number().int().nullable().optional(),
  biddingType: z.union([adsCampaignBiddingTypeSchema, z.null()]).optional(),
  dailySpendLimitMicros: z.number().int().nullable().optional(),
  lifetimeSpendLimitMicros: z.number().int().nullable().optional(),
  conversionEventSettingIds: z.array(z.string()).default([]),
  locationIds: z.array(z.string()).optional(),
  adGroups: z.array(adsAdGroupDtoSchema).default([]),
  upstreamUpdatedAt: z.number().int().nullable().optional(),
  syncedAt: z.string().optional(),
})
export type AdsCampaignDto = z.infer<typeof adsCampaignDtoSchema>

export const adsCampaignListResponseSchema = z.object({
  campaigns: z.array(adsCampaignDtoSchema),
})
export type AdsCampaignListResponse = z.infer<typeof adsCampaignListResponseSchema>

// Only campaign and ad_group rollups are produced by the sync. account- and
// ad-level insights are deferred until the upstream endpoints are exercised
// against a live account; widen this enum when they land (and start writing
// those rows) rather than advertising filters that always return empty.
export const adsInsightLevelSchema = z.enum(['campaign', 'ad_group'])
export type AdsInsightLevel = z.infer<typeof adsInsightLevelSchema>
export const AdsInsightLevels = adsInsightLevelSchema.enum

export const adsInsightRowDtoSchema = z.object({
  level: adsInsightLevelSchema,
  entityId: z.string(),
  date: z.string(),
  impressions: z.number().int(),
  clicks: z.number().int(),
  spendMicros: z.number().int(),
  /** Conversion count for the row. 0 when conversion tracking is not configured.
   *  Conversion VALUE (for ROAS) is a deliberate follow-up: the upstream value
   *  field is not yet captured against a live conversion-tracking account. */
  conversions: z.number().int(),
  /** clicks / impressions; null when impressions is 0. */
  ctr: z.number().nullable(),
  /** spendMicros / clicks, rounded to integer micros; null when clicks is 0. */
  cpcMicros: z.number().int().nullable(),
})
export type AdsInsightRowDto = z.infer<typeof adsInsightRowDtoSchema>

export const adsInsightsResponseSchema = z.object({
  rows: z.array(adsInsightRowDtoSchema),
  /** Account currency for rendering spend/cpc; null before the first sync. */
  currencyCode: z.string().nullable().optional(),
})
export type AdsInsightsResponse = z.infer<typeof adsInsightsResponseSchema>

export const adsTotalsDtoSchema = z.object({
  impressions: z.number().int(),
  clicks: z.number().int(),
  spendMicros: z.number().int(),
  conversions: z.number().int(),
  ctr: z.number().nullable(),
  cpcMicros: z.number().int().nullable(),
})
export type AdsTotalsDto = z.infer<typeof adsTotalsDtoSchema>

export const adsSummaryDtoSchema = z.object({
  connected: z.boolean(),
  displayName: z.string().nullable().optional(),
  currencyCode: z.string().nullable().optional(),
  lastSyncedAt: z.string().nullable().optional(),
  campaignCount: z.number().int(),
  adGroupCount: z.number().int(),
  adCount: z.number().int(),
  /** Date range the totals cover (oldest/newest rollup date), null when empty. */
  window: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  /** Campaign-level rollup totals over the window (levels are not summed across). */
  totals: adsTotalsDtoSchema,
})
export type AdsSummaryDto = z.infer<typeof adsSummaryDtoSchema>

// Campaign lifecycle writes are intentionally narrower than the upstream API:
// creates are always paused, status is never accepted on update, and archive is
// omitted because it is irreversible. The route layer injects the safe status.
const adsOperationKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\w.:-]+$/, 'operationKey may contain letters, numbers, dot, underscore, colon, and hyphen')

const adsEntityIdSchema = z.string().min(1).max(200)
const adsNameSchema = z.string().min(3).max(1000).refine((value) => value.trim().length > 0)
const adsTimestampSchema = z.number().int().min(946684800).max(4102444800)
const adsMicrosSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const adsSha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const adsConversionEventSettingIdsSchema = z
  .array(adsEntityIdSchema)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'conversionEventSettingIds must be unique')
const adsHttpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:', {
  message: 'URL must use https',
})

export const adsOperationKindSchema = z.enum([
  'image_upload',
  'campaign_create',
  'campaign_update',
  'campaign_pause',
  'ad_group_create',
  'ad_group_update',
  'ad_group_pause',
  'ad_create',
  'ad_update',
  'ad_pause',
])
export type AdsOperationKind = z.infer<typeof adsOperationKindSchema>
export const AdsOperationKinds = adsOperationKindSchema.enum

export const adsOperationStateSchema = z.enum(['pending', 'reconciling', 'succeeded', 'failed', 'unknown'])
export type AdsOperationState = z.infer<typeof adsOperationStateSchema>
export const AdsOperationStates = adsOperationStateSchema.enum

export const adsReconcileStrategySchema = z.enum(['known_entity', 'create_fingerprint', 'manual_only'])
export type AdsReconcileStrategy = z.infer<typeof adsReconcileStrategySchema>
export const AdsReconcileStrategies = adsReconcileStrategySchema.enum

export const adsUnresolvedOperationStateSchema = z.enum([
  AdsOperationStates.pending,
  AdsOperationStates.unknown,
  AdsOperationStates.reconciling,
])
export type AdsUnresolvedOperationState = z.infer<typeof adsUnresolvedOperationStateSchema>
export const AdsUnresolvedOperationStates = adsUnresolvedOperationStateSchema.enum

export const adsEntityStatusSchema = z.enum(['active', 'paused', 'archived'])
export type AdsEntityStatus = z.infer<typeof adsEntityStatusSchema>
export const AdsEntityStatuses = adsEntityStatusSchema.enum

export const adsEntityTypeSchema = z.enum(['file', 'campaign', 'ad_group', 'ad'])
export type AdsEntityType = z.infer<typeof adsEntityTypeSchema>
export const AdsEntityTypes = adsEntityTypeSchema.enum

/**
 * Deliberately narrow projection used to verify an upstream entity after an
 * ambiguous mutation. It excludes request payloads, credentials, and URLs;
 * create matching uses the separate one-way fingerprint.
 */
export const adsReconcileFieldsSchema = z
  .object({
    name: adsNameSchema.optional(),
    description: z.string().max(4000).nullable().optional(),
    status: adsEntityStatusSchema.optional(),
    startTime: adsTimestampSchema.nullable().optional(),
    endTime: adsTimestampSchema.nullable().optional(),
    lifetimeSpendLimitMicros: adsMicrosSchema.min(1_000_000).optional(),
    locationIds: z.array(adsEntityIdSchema).max(100).optional(),
    biddingType: adsCampaignBiddingTypeSchema.optional(),
    conversionEventSettingIds: adsConversionEventSettingIdsSchema.optional(),
    campaignId: adsEntityIdSchema.optional(),
    contextHints: z.array(z.string().min(1).max(1000)).max(100).optional(),
    maxBidMicros: adsMicrosSchema.max(100_000_000).optional(),
    billingEventType: adsAdGroupBillingEventTypeSchema.optional(),
    adGroupId: adsEntityIdSchema.optional(),
    creativeFingerprint: adsSha256Schema.optional(),
  })
  .strict()
export type AdsReconcileFields = z.infer<typeof adsReconcileFieldsSchema>

export const adsImageUploadRequestSchema = z.object({
  operationKey: adsOperationKeySchema,
  imageUrl: adsHttpsUrlSchema,
})
export type AdsImageUploadRequest = z.infer<typeof adsImageUploadRequestSchema>

export const adsCampaignCreateRequestSchema = z
  .object({
    operationKey: adsOperationKeySchema,
    name: adsNameSchema,
    description: z.string().max(4000).optional(),
    startTime: adsTimestampSchema.optional(),
    endTime: adsTimestampSchema.optional(),
    lifetimeSpendLimitMicros: adsMicrosSchema.min(1_000_000),
    locationIds: z.array(adsEntityIdSchema).min(1).max(100),
    biddingType: adsCampaignBiddingTypeSchema.optional(),
    conversionEventSettingIds: adsConversionEventSettingIdsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.startTime !== undefined && value.endTime !== undefined && value.endTime <= value.startTime) {
      ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime must be after startTime' })
    }
    if (
      value.biddingType === AdsCampaignBiddingTypes.clicks &&
      (value.conversionEventSettingIds === undefined || value.conversionEventSettingIds.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['conversionEventSettingIds'],
        message: 'conversionEventSettingIds must be non-empty when biddingType is clicks',
      })
    }
  })
export type AdsCampaignCreateRequest = z.infer<typeof adsCampaignCreateRequestSchema>

export const adsAdGroupCreateRequestSchema = z.object({
  operationKey: adsOperationKeySchema,
  campaignId: adsEntityIdSchema,
  name: adsNameSchema,
  description: z.string().max(4000).optional(),
  contextHints: z.array(z.string().min(1).max(1000)).min(1).max(100),
  maxBidMicros: adsMicrosSchema.max(100_000_000),
  billingEventType: adsAdGroupBillingEventTypeSchema.optional(),
})
export type AdsAdGroupCreateRequest = z.infer<typeof adsAdGroupCreateRequestSchema>

export const adsChatCardCreativeRequestSchema = z.object({
  title: z.string().min(3).max(50),
  body: z.string().min(1).max(100),
  targetUrl: adsHttpsUrlSchema,
  fileId: adsEntityIdSchema,
})
export type AdsChatCardCreativeRequest = z.infer<typeof adsChatCardCreativeRequestSchema>

export const adsAdCreateRequestSchema = z.object({
  operationKey: adsOperationKeySchema,
  adGroupId: adsEntityIdSchema,
  name: adsNameSchema,
  creative: adsChatCardCreativeRequestSchema,
})
export type AdsAdCreateRequest = z.infer<typeof adsAdCreateRequestSchema>

function hasMutationField(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => key !== 'operationKey' && key !== 'expectedUpdatedAt')
}

export const adsCampaignUpdateRequestSchema = z
  .object({
    operationKey: adsOperationKeySchema,
    expectedUpdatedAt: z.number().int().nonnegative(),
    name: adsNameSchema.optional(),
    description: z.string().max(4000).nullable().optional(),
    startTime: adsTimestampSchema.nullable().optional(),
    endTime: adsTimestampSchema.nullable().optional(),
    lifetimeSpendLimitMicros: adsMicrosSchema.min(1_000_000).optional(),
    locationIds: z.array(adsEntityIdSchema).min(1).max(100).optional(),
  })
  .refine(hasMutationField, { message: 'At least one campaign field must be updated' })
export type AdsCampaignUpdateRequest = z.infer<typeof adsCampaignUpdateRequestSchema>

export const adsAdGroupUpdateRequestSchema = z
  .object({
    operationKey: adsOperationKeySchema,
    expectedUpdatedAt: z.number().int().nonnegative(),
    name: adsNameSchema.optional(),
    description: z.string().max(4000).nullable().optional(),
    contextHints: z.array(z.string().min(1).max(1000)).min(1).max(100).optional(),
    maxBidMicros: adsMicrosSchema.max(100_000_000).optional(),
  })
  .refine(hasMutationField, { message: 'At least one ad group field must be updated' })
export type AdsAdGroupUpdateRequest = z.infer<typeof adsAdGroupUpdateRequestSchema>

export const adsAdUpdateRequestSchema = z
  .object({
    operationKey: adsOperationKeySchema,
    expectedUpdatedAt: z.number().int().nonnegative(),
    name: adsNameSchema.optional(),
    creative: adsChatCardCreativeRequestSchema.optional(),
  })
  .refine(hasMutationField, { message: 'At least one ad field must be updated' })
export type AdsAdUpdateRequest = z.infer<typeof adsAdUpdateRequestSchema>

export const adsPauseRequestSchema = z.object({
  operationKey: adsOperationKeySchema,
})
export type AdsPauseRequest = z.infer<typeof adsPauseRequestSchema>

export const adsOperationDtoSchema = z.object({
  id: z.string(),
  adAccountId: z.string().nullable(),
  operationKey: z.string(),
  kind: adsOperationKindSchema,
  state: adsOperationStateSchema,
  entityType: z.union([adsEntityTypeSchema, z.null()]),
  entityId: z.string().nullable(),
  upstreamUpdatedAt: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  reconcileStrategy: z.union([adsReconcileStrategySchema, z.null()]),
  reconcileParentId: adsEntityIdSchema.nullable(),
  reconcileFingerprint: adsSha256Schema.nullable(),
  reconcileFields: adsReconcileFieldsSchema.nullable(),
  reconcileAttempts: z.number().int().nonnegative(),
  lastReconciledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AdsOperationDto = z.infer<typeof adsOperationDtoSchema>

export const adsOperationResponseSchema = z.object({
  operation: adsOperationDtoSchema,
  replayed: z.boolean(),
})
export type AdsOperationResponse = z.infer<typeof adsOperationResponseSchema>

const adsUnresolvedOperationStatesDefault = [
  AdsOperationStates.pending,
  AdsOperationStates.unknown,
  AdsOperationStates.reconciling,
] satisfies AdsUnresolvedOperationState[]

function parseUnresolvedOperationStates(value: unknown): unknown {
  if (value === undefined || value === '') return adsUnresolvedOperationStatesDefault
  if (Array.isArray(value)) {
    const states: unknown[] = []
    for (const item of value as unknown[]) {
      if (typeof item === 'string') states.push(...item.split(','))
      else states.push(item)
    }
    return states
  }
  return typeof value === 'string' ? value.split(',').filter(Boolean) : value
}

export const adsUnresolvedOperationListQuerySchema = z.object({
  state: z.preprocess(
    parseUnresolvedOperationStates,
    z
      .array(adsUnresolvedOperationStateSchema)
      .min(1)
      .max(3)
      .refine((states) => new Set(states).size === states.length, 'state values must be unique'),
  ),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).max(1000).optional(),
})
export type AdsUnresolvedOperationListQuery = z.infer<typeof adsUnresolvedOperationListQuerySchema>

export const adsUnresolvedOperationListResponseSchema = z.object({
  operations: z.array(adsOperationDtoSchema),
  count: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
})
export type AdsUnresolvedOperationListResponse = z.infer<typeof adsUnresolvedOperationListResponseSchema>

export const adsOperationReconcileRequestSchema = z.object({}).strict()
export type AdsOperationReconcileRequest = z.infer<typeof adsOperationReconcileRequestSchema>

export const adsOperationReconcileResponseSchema = z.object({
  operation: adsOperationDtoSchema,
  resolved: z.boolean(),
})
export type AdsOperationReconcileResponse = z.infer<typeof adsOperationReconcileResponseSchema>

/** clicks / impressions; null when impressions is 0 (never divide by zero). */
export function adsCtr(clicks: number, impressions: number): number | null {
  return impressions > 0 ? clicks / impressions : null
}

/** spendMicros / clicks rounded to integer micros; null when clicks is 0. */
export function adsCpcMicros(spendMicros: number, clicks: number): number | null {
  return clicks > 0 ? Math.round(spendMicros / clicks) : null
}
