import { z } from 'zod'

// One GBP location surfaced to canonry — a row in `gbp_locations`. The
// `accountName` / `locationName` fields are the resource names returned by
// Google ("accounts/{n}" / "locations/{n}"); we keep the full form rather
// than stripping the numeric ID because both v1 and v4 endpoints expect
// the full path.
export const gbpLocationDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accountName: z.string(),
  locationName: z.string(),
  displayName: z.string(),
  primaryCategoryDisplayName: z.string().nullable(),
  storefrontAddress: z.string().nullable(),
  websiteUri: z.string().nullable(),
  selected: z.boolean(),
  syncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GbpLocationDto = z.infer<typeof gbpLocationDtoSchema>

export const gbpLocationListResponseSchema = z.object({
  locations: z.array(gbpLocationDtoSchema),
  totalDiscovered: z.number().int().nonnegative(),
  totalSelected: z.number().int().nonnegative(),
})
export type GbpLocationListResponse = z.infer<typeof gbpLocationListResponseSchema>

export const gbpDiscoverRequestSchema = z.object({
  selectAllNew: z.boolean().default(true),
})
export type GbpDiscoverRequest = z.infer<typeof gbpDiscoverRequestSchema>

export const gbpLocationSelectionRequestSchema = z.object({
  selected: z.boolean(),
})
export type GbpLocationSelectionRequest = z.infer<typeof gbpLocationSelectionRequestSchema>

// ----- Phase 2: performance sync (daily metrics + monthly keywords) -----

export const gbpSyncRequestSchema = z.object({
  /** Restrict the sync to specific locations (resource names). Omit = all selected. */
  locationNames: z.array(z.string()).optional(),
  daysOfMetrics: z.number().int().positive().max(540).optional(),
  monthsOfKeywords: z.number().int().positive().max(18).optional(),
})
export type GbpSyncRequest = z.infer<typeof gbpSyncRequestSchema>

export const gbpSyncResponseSchema = z.object({
  runId: z.string(),
  status: z.string(),
})
export type GbpSyncResponse = z.infer<typeof gbpSyncResponseSchema>

export const gbpDailyMetricDtoSchema = z.object({
  locationName: z.string(),
  date: z.string(),
  metric: z.string(),
  value: z.number().int(),
})
export type GbpDailyMetricDto = z.infer<typeof gbpDailyMetricDtoSchema>

export const gbpDailyMetricListResponseSchema = z.object({
  metrics: z.array(gbpDailyMetricDtoSchema),
  total: z.number().int().nonnegative(),
})
export type GbpDailyMetricListResponse = z.infer<typeof gbpDailyMetricListResponseSchema>

export const gbpKeywordImpressionDtoSchema = z.object({
  locationName: z.string(),
  // The Performance API returns one impressions figure per keyword aggregated
  // over the whole requested range — it does NOT break the count down by month.
  // `periodStart`/`periodEnd` (both YYYY-MM, inclusive) record that trailing
  // window so the figure is never mistaken for a single calendar month.
  periodStart: z.string(),
  periodEnd: z.string(),
  keyword: z.string(),
  /** Exact impressions over [periodStart, periodEnd], or null when Google redacted to a threshold. */
  valueCount: z.number().int().nullable(),
  /** Privacy floor, or null when an exact value is available. */
  valueThreshold: z.number().int().nullable(),
})
export type GbpKeywordImpressionDto = z.infer<typeof gbpKeywordImpressionDtoSchema>

export const gbpKeywordImpressionListResponseSchema = z.object({
  keywords: z.array(gbpKeywordImpressionDtoSchema),
  total: z.number().int().nonnegative(),
  /** Share of returned keywords that are privacy-thresholded (0–100, rounded). */
  thresholdedPct: z.number().int().min(0).max(100),
})
export type GbpKeywordImpressionListResponse = z.infer<typeof gbpKeywordImpressionListResponseSchema>

// ----- Phase 2b: place actions, lodging, composite summary -----

export const gbpPlaceActionDtoSchema = z.object({
  locationName: z.string(),
  placeActionLinkName: z.string(),
  placeActionType: z.string(),
  uri: z.string().nullable(),
  isPreferred: z.boolean(),
  providerType: z.string().nullable(),
})
export type GbpPlaceActionDto = z.infer<typeof gbpPlaceActionDtoSchema>

export const gbpPlaceActionListResponseSchema = z.object({
  placeActions: z.array(gbpPlaceActionDtoSchema),
  total: z.number().int().nonnegative(),
})
export type GbpPlaceActionListResponse = z.infer<typeof gbpPlaceActionListResponseSchema>

export const gbpLodgingDtoSchema = z.object({
  locationName: z.string(),
  /** Count of non-empty top-level attribute groups (0 = empty profile / AEO gap). */
  populatedGroupCount: z.number().int().nonnegative(),
  syncedAt: z.string(),
  /** Raw Lodging resource as Google returned it. */
  attributes: z.record(z.string(), z.unknown()),
})
export type GbpLodgingDto = z.infer<typeof gbpLodgingDtoSchema>

export const gbpLodgingListResponseSchema = z.object({
  lodging: z.array(gbpLodgingDtoSchema),
  total: z.number().int().nonnegative(),
})
export type GbpLodgingListResponse = z.infer<typeof gbpLodgingListResponseSchema>

// Composite summary — every field is computed server-side by gbp-summary.ts so
// the dashboard renders without doing math (UI/CLI parity).
export const gbpSummaryDtoSchema = z.object({
  scope: z.object({
    locationName: z.string().nullable(),
    locationCount: z.number().int().nonnegative(),
  }),
  performance: z.object({
    totals: z.record(z.string(), z.number()),
    recent7d: z.record(z.string(), z.number()),
    prior7d: z.record(z.string(), z.number()),
    deltaPct: z.record(z.string(), z.number().nullable()),
  }),
  keywords: z.object({
    total: z.number().int().nonnegative(),
    thresholdedCount: z.number().int().nonnegative(),
    thresholdedPct: z.number().int().min(0).max(100),
  }),
  placeActions: z.object({
    total: z.number().int().nonnegative(),
    hasReservationCta: z.boolean(),
    hasBookingCta: z.boolean(),
    hasDirectMerchantCta: z.boolean(),
  }),
  lodging: z.object({
    lodgingLocationCount: z.number().int().nonnegative(),
    populatedLodgingCount: z.number().int().nonnegative(),
    emptyLodgingCount: z.number().int().nonnegative(),
  }),
})
export type GbpSummaryDto = z.infer<typeof gbpSummaryDtoSchema>
