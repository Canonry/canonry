import { z } from 'zod'
import { runStatusSchema } from './run.js'

/** Provider review values that gate any live-spend transition. Unknown values remain strings on reads and fail closed. */
export const AdsReviewStatuses = {
  approved: 'approved',
} as const

export const AdsIntegrityDecisions = {
  allowed: 'allowed',
} as const

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

/**
 * Tracking parameters the provider appends to every click URL under an entity
 * (`landing_page_configuration.query_string_template` upstream). Verified live
 * 2026-09-23: the provider accepts this on an ACTIVE campaign, requires no
 * pause, and leaves every other field untouched.
 *
 * Parameters from the ad, ad group, campaign, and ad account COMBINE. On a
 * duplicate key the winner is, in order: the destination URL, ad, ad group,
 * campaign, ad account. The provider appends its own `oppref` click id
 * regardless of this template.
 */
export const ADS_QUERY_STRING_TEMPLATE_MACROS = [
  'campaign_id',
  'ad_group_id',
  'ad_id',
  'ad_account_id',
  'oppref',
] as const
export type AdsQueryStringTemplateMacro = (typeof ADS_QUERY_STRING_TEMPLATE_MACROS)[number]

const ADS_QUERY_STRING_PAIR = /^[\w.-]+=[^&#\s]*$/
const ADS_QUERY_STRING_MACRO = /\{([^}]*)\}/g

/**
 * A bare query string: `key=value` pairs joined by `&`, no leading `?`, no
 * whitespace, no duplicate keys, and only the documented macros. Values are
 * otherwise opaque — the provider, not Canonry, expands them.
 */
export const adsQueryStringTemplateSchema = z
  .string()
  .min(1)
  .max(1000)
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (value.startsWith('?') || value.startsWith('&')) {
      fail('Tracking template must not start with ? or &')
      return
    }
    const seen = new Set<string>()
    for (const pair of value.split('&')) {
      if (!ADS_QUERY_STRING_PAIR.test(pair)) {
        fail(`Tracking template pair '${pair}' must be key=value without whitespace, # or &`)
        return
      }
      const key = pair.slice(0, pair.indexOf('='))
      if (seen.has(key)) {
        fail(`Tracking template repeats the parameter '${key}'`)
        return
      }
      seen.add(key)
    }
    for (const match of value.matchAll(ADS_QUERY_STRING_MACRO)) {
      const macro = match[1]
      if (!(ADS_QUERY_STRING_TEMPLATE_MACROS as readonly string[]).includes(macro)) {
        fail(`Tracking template macro '{${macro}}' is not supported`)
        return
      }
    }
  })
export type AdsQueryStringTemplate = z.infer<typeof adsQueryStringTemplateSchema>

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
  /** Provider tracking parameters appended to this entity's click URLs. */
  landingPageQueryStringTemplate: z.string().nullable().optional(),
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
  /** Provider tracking parameters appended to this entity's click URLs. */
  landingPageQueryStringTemplate: z.string().nullable().optional(),
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
  /** Provider tracking parameters appended to this entity's click URLs. */
  landingPageQueryStringTemplate: z.string().nullable().optional(),
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
  /**
   * True when `date` is the ad account's CURRENT local calendar date, so this
   * row is a running figure rather than a closed day. The sync re-reads the
   * open day and overwrites the row every time it runs, so the numbers here
   * keep rising until the day ends. Do not compare it against a finished day
   * or treat it as final.
   *
   * `conversions` is the one field that does NOT fill in live on such a row.
   * The provider serves the open day only from a call that may not request
   * conversion metrics, so the count stays at 0 until the day closes and the
   * next sync reads the real figure. Treat it as not yet reported.
   */
  inProgress: z.boolean(),
})
export type AdsInsightRowDto = z.infer<typeof adsInsightRowDtoSchema>

export const adsInsightsResponseSchema = z.object({
  rows: z.array(adsInsightRowDtoSchema),
  /** Account currency for rendering spend/cpc; null before the first sync. */
  currencyCode: z.string().nullable().optional(),
})
export type AdsInsightsResponse = z.infer<typeof adsInsightsResponseSchema>

/**
 * The stored rollup date range, and which date inside it is still filling.
 *
 * `inProgressDate` is the ad account's CURRENT local calendar date, present
 * only when the window actually reaches it. The row for that date is a partial
 * day: the sync re-reads the open day, so today's delivery lands as soon as it
 * happens and is overwritten on every later sync. Totals spanning it are a
 * running figure, not a closed one, and their `conversions` component excludes
 * that day entirely (the provider does not report conversions for a day still
 * open). `null` means every date in the window is a complete day, or that
 * there are no rows at all.
 */
export const adsRollupWindowDtoSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  inProgressDate: z.string().nullable(),
})
export type AdsRollupWindowDto = z.infer<typeof adsRollupWindowDtoSchema>

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
  window: adsRollupWindowDtoSchema,
  /** Campaign-level rollup totals over the window (levels are not summed across). */
  totals: adsTotalsDtoSchema,
})
export type AdsSummaryDto = z.infer<typeof adsSummaryDtoSchema>

/**
 * The completeness of the stored ads entity tree. This is provenance for a
 * local snapshot, not a statement from OpenAI about ad eligibility or serving.
 */
export const adsDeliverySnapshotStatusSchema = z.enum(['unavailable', 'partial', 'complete'])
export type AdsDeliverySnapshotStatus = z.infer<typeof adsDeliverySnapshotStatusSchema>
export const AdsDeliverySnapshotStatuses = adsDeliverySnapshotStatusSchema.enum

/** Why a stored entity tree cannot be treated as one complete ads snapshot. */
export const adsDeliverySnapshotIssueSchema = z.enum([
  'no_ads_connection',
  'connection_not_synced',
  'no_ads_sync',
  'entity_rows_missing_sync_run_id',
  'entity_rows_span_multiple_sync_runs',
  'source_sync_missing',
  'source_sync_not_ads_sync',
  'source_sync_not_completed',
])
export type AdsDeliverySnapshotIssue = z.infer<typeof adsDeliverySnapshotIssueSchema>
export const AdsDeliverySnapshotIssues = adsDeliverySnapshotIssueSchema.enum

export const adsHistoricalCampaignRollupStatusSchema = z.enum(['unavailable', 'reported'])
export type AdsHistoricalCampaignRollupStatus = z.infer<typeof adsHistoricalCampaignRollupStatusSchema>
export const AdsHistoricalCampaignRollupStatuses = adsHistoricalCampaignRollupStatusSchema.enum

export const AdsDeliveryConfigurationBases = {
  storedSnapshot: 'stored_ads_snapshot',
} as const

/**
 * A deliberately conservative interpretation of stored evidence. In
 * particular, `observed_activity` means historical campaign rollups contain
 * impressions; it never claims the provider currently considers an ad serving
 * or eligible.
 */
export const adsActivityAssessmentStateSchema = z.enum([
  'unavailable',
  'partial_snapshot',
  'metrics_unavailable',
  'observed_activity',
  'no_observed_activity',
])
export type AdsActivityAssessmentState = z.infer<typeof adsActivityAssessmentStateSchema>
export const AdsActivityAssessmentStates = adsActivityAssessmentStateSchema.enum

const adsDeliveryDiagnosticsAdSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  reviewStatus: z.string().nullable(),
})

const adsDeliveryDiagnosticsAdGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  billingEventType: z.union([adsAdGroupBillingEventTypeSchema, z.null()]),
  maxBidMicros: z.number().int().nullable(),
  contextHints: z.array(z.string()),
  ads: z.array(adsDeliveryDiagnosticsAdSchema),
})

const adsDeliveryDiagnosticsCampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  biddingType: z.union([adsCampaignBiddingTypeSchema, z.null()]),
  dailySpendLimitMicros: z.number().int().nullable(),
  lifetimeSpendLimitMicros: z.number().int().nullable(),
  conversionEventSettingIds: z.array(z.string()),
  adGroups: z.array(adsDeliveryDiagnosticsAdGroupSchema),
})

/**
 * One stored-fact read for an ads operator. It intentionally contains no
 * provider eligibility, delivery, or serving verdict: it reports only synced
 * structure, captured account facts, and historical campaign rollups.
 */
export const adsDeliveryDiagnosticsDtoSchema = z.object({
  snapshot: z.object({
    status: adsDeliverySnapshotStatusSchema,
    // A union keeps the OpenAPI form explicit enough for the generated SDK to
    // retain the complete-snapshot `null` value (rather than narrowing it to
    // the issue enum alone).
    issue: z.union([adsDeliverySnapshotIssueSchema, z.null()]),
    lastSyncedAt: z.string().nullable(),
    campaignCount: z.number().int().nonnegative(),
    adGroupCount: z.number().int().nonnegative(),
    adCount: z.number().int().nonnegative(),
    sourceSync: z.object({
      runId: z.string(),
      status: runStatusSchema,
    }).nullable(),
  }),
  historicalCampaignRollups: z.object({
    status: adsHistoricalCampaignRollupStatusSchema,
    window: adsRollupWindowDtoSchema,
    totals: adsTotalsDtoSchema.nullable(),
  }),
  storedConfiguration: z.object({
    basis: z.literal(AdsDeliveryConfigurationBases.storedSnapshot),
    connection: z.object({
      status: z.string().nullable(),
      reviewStatus: z.string().nullable(),
      integrityReviewStatus: z.string().nullable(),
      integrityDecision: z.string().nullable(),
      conversionTrackingConfigured: z.boolean(),
    }).nullable(),
    campaigns: z.array(adsDeliveryDiagnosticsCampaignSchema),
  }),
  assessment: z.object({ state: adsActivityAssessmentStateSchema }),
})
export type AdsDeliveryDiagnosticsDto = z.infer<typeof adsDeliveryDiagnosticsDtoSchema>

// Campaign lifecycle writes are intentionally narrower than the upstream API:
// creates are always paused and status is never accepted on update. The route
// layer injects the safe status. Archive IS supported, deliberately and behind
// more guards than pause: the entity must already be paused, the caller must
// pin the exact version it reviewed via expectedUpdatedAt, and the archived
// postcondition is never remediated because the write cannot be undone.
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
  'campaign_archive',
  'campaign_tree_activate',
  'ad_group_create',
  'ad_group_update',
  'ad_group_pause',
  'ad_group_archive',
  'ad_create',
  'ad_update',
  'ad_pause',
  'ad_archive',
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

/** Entity types that participate in an exact campaign-tree activation. */
export const adsActivationEntityTypeSchema = z.enum(['campaign', 'ad_group', 'ad'])
export type AdsActivationEntityType = z.infer<typeof adsActivationEntityTypeSchema>
export const AdsActivationEntityTypes = adsActivationEntityTypeSchema.enum

const adsActivationEntityRefSchema = z.object({
  id: adsEntityIdSchema,
  expectedUpdatedAt: z.number().int().nonnegative(),
}).strict()

const adsActivationAdSchema = adsActivationEntityRefSchema

/**
 * Structural ceiling for one activation manifest (1 campaign + ad groups +
 * ads). This bound lives in the SCHEMA, which participates in canonical
 * manifest hashing and validates STORED manifests, so it must never tighten:
 * it protects canonical hashing and keeps one approval/execution inside a
 * bounded SQLite and provider workload. Never configurable.
 */
export const ADS_ACTIVATION_ABSOLUTE_MAX_ENTITIES = 1000

/**
 * DEFAULT OPERATIONAL cap on entities in one activation manifest. Enforced at
 * the API entry points that accept a caller-assembled manifest (activation
 * grant creation and new activate-tree executions), where a deployment may
 * override it via `CANONRY_ADS_ACTIVATION_MAX_ENTITIES` up to
 * {@link ADS_ACTIVATION_ABSOLUTE_MAX_ENTITIES}. The schema below deliberately
 * does NOT enforce this cap: stored manifests approved under a larger
 * configured cap must keep validating and hashing unchanged.
 */
export const ADS_ACTIVATION_MAX_ENTITIES = 100

/**
 * Count the entities in one activation manifest: the campaign, plus one per
 * ad group, plus one per ad. This is THE entity-count formula, shared by the
 * manifest schema's absolute-ceiling check and the API entry points'
 * operational cap so the two counts can never drift apart. Typed over the
 * minimal structural shape so both the schema's pre-brand refinement input
 * and the parsed DTO satisfy it.
 */
export function countAdsActivationManifestEntities(
  manifest: { campaign: { adGroups: { ads: unknown[] }[] } },
): number {
  return 1 + manifest.campaign.adGroups.reduce(
    (count, group) => count + 1 + group.ads.length,
    0,
  )
}

const adsActivationAdGroupSchema = adsActivationEntityRefSchema.extend({
  ads: z.array(adsActivationAdSchema).min(1).max(ADS_ACTIVATION_ABSOLUTE_MAX_ENTITIES - 1),
}).strict()

const adsActivationCampaignSchema = adsActivationEntityRefSchema.extend({
  adGroups: z.array(adsActivationAdGroupSchema).min(1).max(ADS_ACTIVATION_ABSOLUTE_MAX_ENTITIES - 1),
}).strict()

function compareAdsActivationEntityIds(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function addCanonicalEntityOrderIssue(
  items: readonly { id: string }[],
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): void {
  for (let index = 1; index < items.length; index += 1) {
    if (compareAdsActivationEntityIds(items[index - 1]!.id, items[index]!.id) >= 0) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: 'Activation manifest entities must be uniquely sorted by id',
      })
      return
    }
  }
}

/**
 * Exact immutable campaign tree approved by a human. Arrays are required to
 * be uniquely sorted by provider id so JSON serialization has one canonical
 * representation for manifest hashing.
 */
export const adsActivationManifestSchema = z.object({
  campaign: adsActivationCampaignSchema,
}).strict().superRefine((manifest, ctx) => {
  const entityCount = countAdsActivationManifestEntities(manifest)
  if (entityCount > ADS_ACTIVATION_ABSOLUTE_MAX_ENTITIES) {
    ctx.addIssue({
      code: 'custom',
      path: ['campaign'],
      message: `Activation manifests may contain at most ${ADS_ACTIVATION_ABSOLUTE_MAX_ENTITIES} entities`,
    })
  }
  addCanonicalEntityOrderIssue(manifest.campaign.adGroups, ['campaign', 'adGroups'], ctx)
  const allAdIds = new Set<string>()
  for (let groupIndex = 0; groupIndex < manifest.campaign.adGroups.length; groupIndex += 1) {
    const group = manifest.campaign.adGroups[groupIndex]!
    addCanonicalEntityOrderIssue(group.ads, ['campaign', 'adGroups', groupIndex, 'ads'], ctx)
    for (let adIndex = 0; adIndex < group.ads.length; adIndex += 1) {
      const ad = group.ads[adIndex]!
      if (allAdIds.has(ad.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['campaign', 'adGroups', groupIndex, 'ads', adIndex, 'id'],
          message: 'An ad may appear only once in an activation manifest',
        })
      }
      allAdIds.add(ad.id)
    }
  }
})
export type AdsActivationManifest = z.infer<typeof adsActivationManifestSchema>

/**
 * Return a defensive, canonically ordered copy before validating and hashing
 * a caller-assembled activation tree.
 */
export function canonicalizeAdsActivationManifest(
  manifest: AdsActivationManifest,
): AdsActivationManifest {
  return {
    campaign: {
      id: manifest.campaign.id,
      expectedUpdatedAt: manifest.campaign.expectedUpdatedAt,
      adGroups: manifest.campaign.adGroups
        .map((group) => ({
          id: group.id,
          expectedUpdatedAt: group.expectedUpdatedAt,
          ads: group.ads
            .map((ad) => ({ id: ad.id, expectedUpdatedAt: ad.expectedUpdatedAt }))
            .sort((left, right) => compareAdsActivationEntityIds(left.id, right.id)),
        }))
        .sort((left, right) => compareAdsActivationEntityIds(left.id, right.id)),
    },
  }
}

export const adsActivationManifestHashSchema = adsSha256Schema

export const adsActivationGrantStateSchema = z.enum([
  'approved',
  'executing',
  'consumed',
  'revoked',
  'expired',
  'unknown',
])
export type AdsActivationGrantState = z.infer<typeof adsActivationGrantStateSchema>
export const AdsActivationGrantStates = adsActivationGrantStateSchema.enum

export const adsOperationStepStateSchema = z.enum([
  'pending',
  'executing',
  'active',
  'failed',
  'rollback_executing',
  'rolled_back',
  'rollback_failed',
  'unknown',
])
export type AdsOperationStepState = z.infer<typeof adsOperationStepStateSchema>
export const AdsOperationStepStates = adsOperationStepStateSchema.enum

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
    landingPageQueryStringTemplate: adsQueryStringTemplateSchema.nullable().optional(),
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
    // biddingType is BILLING (what the account pays for) and is immutable once
    // the provider creates the campaign. conversionEventSettingIds is
    // OPTIMIZATION (what delivery is steered toward). The two are independent,
    // and the provider accepts a clicks campaign carrying no conversion event
    // settings, so neither field is conditioned on the other here.
    biddingType: adsCampaignBiddingTypeSchema.optional(),
    conversionEventSettingIds: adsConversionEventSettingIdsSchema.optional(),
    /** Optional tracking parameters applied to click URLs under this entity. */
    landingPageQueryStringTemplate: adsQueryStringTemplateSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.startTime !== undefined && value.endTime !== undefined && value.endTime <= value.startTime) {
      ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime must be after startTime' })
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
  /** Optional tracking parameters applied to click URLs under this entity. */
  landingPageQueryStringTemplate: adsQueryStringTemplateSchema.optional(),
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
  /** Optional tracking parameters applied to click URLs under this entity. */
  landingPageQueryStringTemplate: adsQueryStringTemplateSchema.optional(),
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
    /** Tracking parameters for this entity's click URLs; null clears them. */
    landingPageQueryStringTemplate: adsQueryStringTemplateSchema.nullable().optional(),
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
    /** Tracking parameters for this entity's click URLs; null clears them. */
    landingPageQueryStringTemplate: adsQueryStringTemplateSchema.nullable().optional(),
  })
  .refine(hasMutationField, { message: 'At least one ad group field must be updated' })
export type AdsAdGroupUpdateRequest = z.infer<typeof adsAdGroupUpdateRequestSchema>

export const adsAdUpdateRequestSchema = z
  .object({
    operationKey: adsOperationKeySchema,
    expectedUpdatedAt: z.number().int().nonnegative(),
    name: adsNameSchema.optional(),
    creative: adsChatCardCreativeRequestSchema.optional(),
    /** Tracking parameters for this entity's click URLs; null clears them. */
    landingPageQueryStringTemplate: adsQueryStringTemplateSchema.nullable().optional(),
  })
  .refine(hasMutationField, { message: 'At least one ad field must be updated' })
export type AdsAdUpdateRequest = z.infer<typeof adsAdUpdateRequestSchema>

export const adsPauseRequestSchema = z.object({
  operationKey: adsOperationKeySchema,
})
export type AdsPauseRequest = z.infer<typeof adsPauseRequestSchema>

/**
 * Archive is irreversible, so unlike pause it must pin the version: the caller
 * archives the exact entity revision it looked at. A stale expectedUpdatedAt is
 * refused rather than applied to whatever the entity has since become.
 */
export const adsArchiveRequestSchema = z.object({
  operationKey: adsOperationKeySchema,
  expectedUpdatedAt: z.number().int().nonnegative(),
})
export type AdsArchiveRequest = z.infer<typeof adsArchiveRequestSchema>

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

const adsActivationIsoTimestampSchema = z.iso.datetime({ offset: true })

const adsActivationGrantBaseShape = {
  id: adsEntityIdSchema,
  projectId: adsEntityIdSchema,
  adAccountId: adsEntityIdSchema,
  manifestHash: adsActivationManifestHashSchema,
  manifest: adsActivationManifestSchema,
  executorApiKeyId: adsEntityIdSchema,
  approverApiKeyId: adsEntityIdSchema,
  expiresAt: adsActivationIsoTimestampSchema,
  approvedAt: adsActivationIsoTimestampSchema,
  createdAt: adsActivationIsoTimestampSchema,
  updatedAt: adsActivationIsoTimestampSchema,
  revocationRequestedAt: adsActivationIsoTimestampSchema.nullable(),
}

const adsActivationGrantApprovedDtoSchema = z.object({
  ...adsActivationGrantBaseShape,
  state: z.literal(AdsActivationGrantStates.approved),
  operationId: z.null(),
  executionStartedAt: z.null(),
  consumedAt: z.null(),
  revokedAt: z.null(),
  expiredAt: z.null(),
}).strict()

const adsActivationGrantExecutingDtoSchema = z.object({
  ...adsActivationGrantBaseShape,
  state: z.literal(AdsActivationGrantStates.executing),
  operationId: adsEntityIdSchema,
  executionStartedAt: adsActivationIsoTimestampSchema,
  consumedAt: z.null(),
  revokedAt: z.null(),
  expiredAt: z.null(),
}).strict()

const adsActivationGrantConsumedDtoSchema = z.object({
  ...adsActivationGrantBaseShape,
  state: z.literal(AdsActivationGrantStates.consumed),
  operationId: adsEntityIdSchema,
  executionStartedAt: adsActivationIsoTimestampSchema,
  consumedAt: adsActivationIsoTimestampSchema,
  revokedAt: z.null(),
  expiredAt: z.null(),
}).strict()

const adsActivationGrantRevokedDtoSchema = z.object({
  ...adsActivationGrantBaseShape,
  state: z.literal(AdsActivationGrantStates.revoked),
  operationId: z.null(),
  executionStartedAt: z.null(),
  consumedAt: z.null(),
  revokedAt: adsActivationIsoTimestampSchema,
  expiredAt: z.null(),
}).strict()

const adsActivationGrantExpiredDtoSchema = z.object({
  ...adsActivationGrantBaseShape,
  state: z.literal(AdsActivationGrantStates.expired),
  operationId: z.null(),
  executionStartedAt: z.null(),
  consumedAt: z.null(),
  revokedAt: z.null(),
  expiredAt: adsActivationIsoTimestampSchema,
}).strict()

const adsActivationGrantUnknownDtoSchema = z.object({
  ...adsActivationGrantBaseShape,
  state: z.literal(AdsActivationGrantStates.unknown),
  operationId: adsEntityIdSchema,
  executionStartedAt: adsActivationIsoTimestampSchema,
  consumedAt: z.null(),
  revokedAt: z.null(),
  expiredAt: z.null(),
}).strict()

/**
 * Durable approval grant. The approver and executor are always different API
 * keys, so an execution credential can never approve its own activation.
 */
export const adsActivationGrantDtoSchema = z.discriminatedUnion('state', [
  adsActivationGrantApprovedDtoSchema,
  adsActivationGrantExecutingDtoSchema,
  adsActivationGrantConsumedDtoSchema,
  adsActivationGrantRevokedDtoSchema,
  adsActivationGrantExpiredDtoSchema,
  adsActivationGrantUnknownDtoSchema,
]).superRefine((grant, ctx) => {
  if (grant.executorApiKeyId === grant.approverApiKeyId) {
    ctx.addIssue({
      code: 'custom',
      path: ['executorApiKeyId'],
      message: 'The activation executor must use a different API key from the approver',
    })
  }
  if (
    grant.revocationRequestedAt !== null
    && grant.state !== AdsActivationGrantStates.executing
    && grant.state !== AdsActivationGrantStates.unknown
    && grant.state !== AdsActivationGrantStates.consumed
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['revocationRequestedAt'],
      message: 'Only an executing, cancelled, or unresolved activation can carry a cancellation request',
    })
  }
})
export type AdsActivationGrantDto = z.infer<typeof adsActivationGrantDtoSchema>

const adsOperationStepBaseShape = {
  id: adsEntityIdSchema,
  operationId: adsEntityIdSchema,
  ordinal: z.number().int().nonnegative(),
  entityType: adsActivationEntityTypeSchema,
  entityId: adsEntityIdSchema,
  expectedUpdatedAt: z.number().int().nonnegative(),
  createdAt: adsActivationIsoTimestampSchema,
  updatedAt: adsActivationIsoTimestampSchema,
}

const adsOperationStepNoErrorShape = {
  errorCode: z.null(),
  errorMessage: z.null(),
}

const adsOperationStepErrorShape = {
  errorCode: z.string().min(1).max(100),
  errorMessage: z.string().min(1).max(500),
  remediation: z.string().min(1).max(500),
}

const adsOperationStepPendingDtoSchema = z.object({
  ...adsOperationStepBaseShape,
  ...adsOperationStepNoErrorShape,
  state: z.literal(AdsOperationStepStates.pending),
  providerUpdatedAt: z.null(),
  remediation: z.null(),
  startedAt: z.null(),
  finishedAt: z.null(),
}).strict()

const adsOperationStepExecutingDtoSchema = z.object({
  ...adsOperationStepBaseShape,
  ...adsOperationStepNoErrorShape,
  state: z.literal(AdsOperationStepStates.executing),
  providerUpdatedAt: z.null(),
  remediation: z.null(),
  startedAt: adsActivationIsoTimestampSchema,
  finishedAt: z.null(),
}).strict()

const adsOperationStepActiveDtoSchema = z.object({
  ...adsOperationStepBaseShape,
  ...adsOperationStepNoErrorShape,
  state: z.literal(AdsOperationStepStates.active),
  providerUpdatedAt: z.number().int().nonnegative(),
  remediation: z.null(),
  startedAt: adsActivationIsoTimestampSchema,
  finishedAt: adsActivationIsoTimestampSchema,
}).strict()

const adsOperationStepFailedDtoSchema = z.object({
  ...adsOperationStepBaseShape,
  ...adsOperationStepErrorShape,
  state: z.literal(AdsOperationStepStates.failed),
  providerUpdatedAt: z.union([z.number().int().nonnegative(), z.null()]),
  startedAt: adsActivationIsoTimestampSchema,
  finishedAt: adsActivationIsoTimestampSchema,
}).strict()

const adsOperationStepRollbackExecutingDtoSchema = z.object({
  ...adsOperationStepBaseShape,
  ...adsOperationStepNoErrorShape,
  state: z.literal(AdsOperationStepStates.rollback_executing),
  providerUpdatedAt: z.number().int().nonnegative(),
  remediation: z.string().min(1).max(500),
  startedAt: adsActivationIsoTimestampSchema,
  finishedAt: z.null(),
}).strict()

const adsOperationStepRolledBackDtoSchema = z.object({
  ...adsOperationStepBaseShape,
  ...adsOperationStepNoErrorShape,
  state: z.literal(AdsOperationStepStates.rolled_back),
  providerUpdatedAt: z.number().int().nonnegative(),
  remediation: z.string().min(1).max(500),
  startedAt: adsActivationIsoTimestampSchema,
  finishedAt: adsActivationIsoTimestampSchema,
}).strict()

const adsOperationStepRollbackFailedDtoSchema = z.object({
  ...adsOperationStepBaseShape,
  ...adsOperationStepErrorShape,
  state: z.literal(AdsOperationStepStates.rollback_failed),
  providerUpdatedAt: z.number().int().nonnegative(),
  startedAt: adsActivationIsoTimestampSchema,
  finishedAt: adsActivationIsoTimestampSchema,
}).strict()

const adsOperationStepUnknownDtoSchema = z.object({
  ...adsOperationStepBaseShape,
  ...adsOperationStepErrorShape,
  state: z.literal(AdsOperationStepStates.unknown),
  providerUpdatedAt: z.union([z.number().int().nonnegative(), z.null()]),
  startedAt: adsActivationIsoTimestampSchema,
  finishedAt: adsActivationIsoTimestampSchema,
}).strict()

export const adsOperationStepDtoSchema = z.discriminatedUnion('state', [
  adsOperationStepPendingDtoSchema,
  adsOperationStepExecutingDtoSchema,
  adsOperationStepActiveDtoSchema,
  adsOperationStepFailedDtoSchema,
  adsOperationStepRollbackExecutingDtoSchema,
  adsOperationStepRolledBackDtoSchema,
  adsOperationStepRollbackFailedDtoSchema,
  adsOperationStepUnknownDtoSchema,
])
export type AdsOperationStepDto = z.infer<typeof adsOperationStepDtoSchema>

/** Human approval request. The authenticated key becomes the approver. */
export const AdsActivationVersionPolicies = {
  exact: 'exact',
  refreshSemanticallyUnchanged: 'refresh_semantically_unchanged',
} as const

export const adsActivationVersionPolicySchema = z.enum([
  AdsActivationVersionPolicies.exact,
  AdsActivationVersionPolicies.refreshSemanticallyUnchanged,
])
export type AdsActivationVersionPolicy = z.infer<typeof adsActivationVersionPolicySchema>

export const adsActivationGrantCreateRequestSchema = z.object({
  manifest: adsActivationManifestSchema,
  executorApiKeyId: adsEntityIdSchema,
  expiresAt: adsActivationIsoTimestampSchema,
  versionPolicy: adsActivationVersionPolicySchema.default(AdsActivationVersionPolicies.exact),
}).strict()
export type AdsActivationGrantCreateRequest = z.infer<typeof adsActivationGrantCreateRequestSchema>

export const adsActivationGrantResponseSchema = z.object({
  grant: adsActivationGrantDtoSchema,
}).strict()
export type AdsActivationGrantResponse = z.infer<typeof adsActivationGrantResponseSchema>

export const adsActivationGrantRevokeRequestSchema = z.object({}).strict()
export type AdsActivationGrantRevokeRequest = z.infer<typeof adsActivationGrantRevokeRequestSchema>

/** Execution request bound to the exact approved manifest hash and executor key. */
export const adsActivateTreeRequestSchema = z.object({
  operationKey: adsOperationKeySchema,
  grantId: adsEntityIdSchema,
  manifestHash: adsActivationManifestHashSchema,
}).strict()
export type AdsActivateTreeRequest = z.infer<typeof adsActivateTreeRequestSchema>

export const adsActivateTreeResponseSchema = z.object({
  grant: adsActivationGrantDtoSchema,
  operation: adsOperationDtoSchema,
  steps: z.array(adsOperationStepDtoSchema),
}).strict()
export type AdsActivateTreeResponse = z.infer<typeof adsActivateTreeResponseSchema>

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

/**
 * Live-delivery request knobs. Neither field is an identity key: the route
 * never reuses, caches, or consolidates another request's result: its
 * minimum-interval throttle only rejects, so there is no reuse branch a new
 * parameter could silently ride through.
 */
export const adsLiveDeliveryQuerySchema = z.object({
  campaignId: z.string().min(1).max(200).optional(),
  lookbackDays: z.coerce.number().int().min(1).max(30).default(7),
})
export type AdsLiveDeliveryQuery = z.infer<typeof adsLiveDeliveryQuerySchema>

export const adsLiveEntityTypeSchema = z.enum(['campaign', 'ad_group', 'ad'])
export type AdsLiveEntityType = z.infer<typeof adsLiveEntityTypeSchema>
export const AdsLiveEntityTypes = adsLiveEntityTypeSchema.enum

/** Where an entity was observed: on the provider, in the local snapshot, or both. */
export const adsLivePresenceSchema = z.enum(['both', 'live-only', 'stored-only'])
export type AdsLivePresence = z.infer<typeof adsLivePresenceSchema>
export const AdsLivePresences = adsLivePresenceSchema.enum

export const adsLiveDeliveryBasisSchema = z.literal('live-provider-read')
export const AdsLiveDeliveryBases = { liveProviderRead: 'live-provider-read' } as const

/**
 * One metric bucket exactly as the provider returned it. Values are NOT
 * normalized: `spend` stays in the provider's decimal currency units (the
 * insights API returns dollars while budgets/bids are integer micros), and an
 * absent metric stays `null` rather than being coerced to 0. The comparable,
 * micro-normalized view lives in `metricDeltas`.
 */
export const adsLiveMetricRowSchema = z.object({
  date: z.string().nullable(),
  startTime: z.number().nullable(),
  endTime: z.number().nullable(),
  impressions: z.number().nullable(),
  clicks: z.number().nullable(),
  spend: z.number().nullable(),
  conversions: z.number().nullable(),
  ctr: z.number().nullable(),
  cpc: z.number().nullable(),
  cpm: z.number().nullable(),
})
export type AdsLiveMetricRow = z.infer<typeof adsLiveMetricRowSchema>

/** Comparable per-date metric totals. Spend is micros on both sides. */
export const adsLiveMetricValuesSchema = z.object({
  impressions: z.number().int(),
  clicks: z.number().int(),
  spendMicros: z.number().int(),
  conversions: z.number().int(),
})
export type AdsLiveMetricValues = z.infer<typeof adsLiveMetricValuesSchema>

export const adsLiveMetricDeltaSchema = z.object({
  date: z.string(),
  live: adsLiveMetricValuesSchema.nullable(),
  stored: adsLiveMetricValuesSchema.nullable(),
  drifted: z.boolean(),
})
export type AdsLiveMetricDelta = z.infer<typeof adsLiveMetricDeltaSchema>

export const adsLiveFieldDeltaSchema = z.object({
  field: z.string(),
  live: z.string().nullable(),
  stored: z.string().nullable(),
})
export type AdsLiveFieldDelta = z.infer<typeof adsLiveFieldDeltaSchema>

/**
 * The provider's own state for one entity. `status` and `reviewStatus` are the
 * provider's strings verbatim; Canonry does not derive a serving verdict from
 * them. `mode` is campaign-only and null elsewhere.
 */
export const adsLiveEntityStateSchema = z.object({
  name: z.string().nullable(),
  status: z.string(),
  reviewStatus: z.string().nullable(),
  mode: z.string().nullable(),
  updatedAt: z.number().nullable(),
})
export type AdsLiveEntityState = z.infer<typeof adsLiveEntityStateSchema>

export const adsStoredEntityStateSchema = z.object({
  name: z.string(),
  status: z.string(),
  reviewStatus: z.string().nullable(),
  upstreamUpdatedAt: z.number().nullable(),
  syncedAt: z.string(),
})
export type AdsStoredEntityState = z.infer<typeof adsStoredEntityStateSchema>

export const adsLiveEntityComparisonSchema = z.object({
  entityType: adsLiveEntityTypeSchema,
  id: z.string(),
  parentId: z.string().nullable(),
  presence: adsLivePresenceSchema,
  live: adsLiveEntityStateSchema.nullable(),
  stored: adsStoredEntityStateSchema.nullable(),
  fieldDeltas: z.array(adsLiveFieldDeltaSchema),
  /** Provider rows, unaggregated. Null for ads (no per-ad insights surface). */
  liveMetrics: z.array(adsLiveMetricRowSchema).nullable(),
  metricDeltas: z.array(adsLiveMetricDeltaSchema).nullable(),
  drifted: z.boolean(),
})
export type AdsLiveEntityComparison = z.infer<typeof adsLiveEntityComparisonSchema>

/**
 * One failed provider surface. It carries a fixed surface label, the entity the
 * call was for, and the upstream HTTP status only, never the upstream message,
 * body, or code, because those are provider-controlled strings that can echo
 * request material back to the caller.
 */
export const adsLiveReadFailureSchema = z.object({
  surface: z.string(),
  entityId: z.string().nullable(),
  upstreamStatus: z.number().int().nullable(),
})
export type AdsLiveReadFailure = z.infer<typeof adsLiveReadFailureSchema>

/**
 * A live, read-only passthrough of the connected ad account: what the provider
 * says RIGHT NOW, the corresponding local snapshot values, and the per-entity
 * delta between them. It never mutates provider state and never waits for a
 * sync run. The walk is bounded (see `bounds`) because it calls a third-party
 * API on demand.
 */
export const adsLiveDeliveryDtoSchema = z.object({
  basis: adsLiveDeliveryBasisSchema,
  /** Instant the live read was issued; the metrics window is measured back from it. */
  fetchedAt: z.string(),
  adAccountId: z.string(),
  storedSnapshotSyncedAt: z.string().nullable(),
  metricsWindow: z.object({ lookbackDays: z.number().int().positive() }),
  /**
   * Two different units live here, and confusing them understates the cost of
   * this endpoint by two orders of magnitude.
   *
   * A READER CALL is one logical list or insight read. Every list/insight
   * reader call is an auto-paginating walk, so one reader call can issue up to
   * `maxPagesPerReaderCall` upstream HTTP requests before the client gives up.
   * `maxUpstreamHttpRequests` is the honest worst-case ceiling in HTTP
   * requests (`maxReaderCalls * maxPagesPerReaderCall`, about 4000 at the
   * shipped defaults, not 40).
   *
   * `readerCalls` is an observed count of reader calls. There is deliberately
   * no observed HTTP-request count: the pagination happens inside the provider
   * client, below the injected reader seam, so the route cannot see it.
   */
  bounds: z.object({
    maxCampaigns: z.number().int().positive(),
    maxAdGroupsPerCampaign: z.number().int().positive(),
    maxAdsPerAdGroup: z.number().int().positive(),
    /** Budget in logical reader calls, NOT in upstream HTTP requests. */
    maxReaderCalls: z.number().int().positive(),
    /** Reader calls this read actually issued. Observed, not a bound. */
    readerCalls: z.number().int().nonnegative(),
    /** Pages one paginated reader call may fetch before the client gives up. */
    maxPagesPerReaderCall: z.number().int().positive(),
    /** Worst-case upstream HTTP requests. A documented bound, not an observation. */
    maxUpstreamHttpRequests: z.number().int().positive(),
    truncated: z.boolean(),
  }),
  entities: z.array(adsLiveEntityComparisonSchema),
  drift: z.object({
    entitiesCompared: z.number().int().nonnegative(),
    driftedEntities: z.number().int().nonnegative(),
    statusDrifted: z.number().int().nonnegative(),
    metricsDrifted: z.number().int().nonnegative(),
  }),
  errors: z.array(adsLiveReadFailureSchema),
})
export type AdsLiveDeliveryDto = z.infer<typeof adsLiveDeliveryDtoSchema>

/** clicks / impressions; null when impressions is 0 (never divide by zero). */
export function adsCtr(clicks: number, impressions: number): number | null {
  return impressions > 0 ? clicks / impressions : null
}

/** spendMicros / clicks rounded to integer micros; null when clicks is 0. */
export function adsCpcMicros(spendMicros: number, clicks: number): number | null {
  return clicks > 0 ? Math.round(spendMicros / clicks) : null
}
