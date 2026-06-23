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

export const adsConnectionStatusDtoSchema = z.object({
  connected: z.boolean(),
  adAccountId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  currencyCode: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
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
})
export type AdsCreativeDto = z.infer<typeof adsCreativeDtoSchema>

export const adsAdDtoSchema = z.object({
  id: z.string(),
  adGroupId: z.string(),
  name: z.string(),
  status: z.string(),
  reviewStatus: z.string().nullable().optional(),
  creative: adsCreativeDtoSchema.nullable().optional(),
})
export type AdsAdDto = z.infer<typeof adsAdDtoSchema>

export const adsAdGroupDtoSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  name: z.string(),
  status: z.string(),
  billingEventType: z.string().nullable().optional(),
  maxBidMicros: z.number().int().nullable().optional(),
  /**
   * The targeting primitive: entries are multi-line strings of
   * newline-separated example queries (the live Ads Manager format).
   */
  contextHints: z.array(z.string()).default([]),
  ads: z.array(adsAdDtoSchema).default([]),
})
export type AdsAdGroupDto = z.infer<typeof adsAdGroupDtoSchema>

export const adsCampaignDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  biddingType: z.string().nullable().optional(),
  dailySpendLimitMicros: z.number().int().nullable().optional(),
  lifetimeSpendLimitMicros: z.number().int().nullable().optional(),
  adGroups: z.array(adsAdGroupDtoSchema).default([]),
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

/** clicks / impressions; null when impressions is 0 (never divide by zero). */
export function adsCtr(clicks: number, impressions: number): number | null {
  return impressions > 0 ? clicks / impressions : null
}

/** spendMicros / clicks rounded to integer micros; null when clicks is 0. */
export function adsCpcMicros(spendMicros: number, clicks: number): number | null {
  return clicks > 0 ? Math.round(spendMicros / clicks) : null
}
