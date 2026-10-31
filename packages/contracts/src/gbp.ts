import { z } from 'zod'
import { percent } from './ratio-unit.js'

// One GBP account the OAuth user can access. `name` is the resource name
// ("accounts/{n}") used to list that account's locations; the rest are
// descriptive. A user with manager/owner access to several businesses sees
// several accounts here — which is why account selection is per project.
export const gbpAccountDtoSchema = z.object({
  /** Resource name, "accounts/{n}". */
  name: z.string(),
  /** Human-readable account name, or null when Google omits it. */
  accountName: z.string().nullable(),
  /** Account type (PERSONAL, LOCATION_GROUP, ORGANIZATION, …) when present. */
  type: z.string().nullable(),
  /** The OAuth user's role on the account (OWNER, MANAGER, …) when present. */
  role: z.string().nullable(),
})
export type GbpAccountDto = z.infer<typeof gbpAccountDtoSchema>

export const gbpAccountListResponseSchema = z.object({
  accounts: z.array(gbpAccountDtoSchema),
  total: z.number().int().nonnegative(),
})
export type GbpAccountListResponse = z.infer<typeof gbpAccountListResponseSchema>

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
  // Google Maps Place ID + public Maps link (from location metadata; null when
  // the location is not on Maps). `placeId` is the join key to the Places API.
  placeId: z.string().nullable(),
  mapsUri: z.string().nullable(),
  // Owner-authored profile content (Business Information v1 Location resource).
  // These are the entity-anchor + qualifier signals AI answer engines weight:
  // secondary categories, the business description, the service area + hours
  // (stored verbatim as JSON), the primary phone, and the open state.
  additionalCategories: z.array(z.string()),
  description: z.string().nullable(),
  serviceArea: z.record(z.string(), z.unknown()).nullable(),
  regularHours: z.record(z.string(), z.unknown()).nullable(),
  primaryPhone: z.string().nullable(),
  openStatus: z.string().nullable(),
  openingDate: z.string().nullable(),
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
  /**
   * Discover locations under this specific account ("accounts/{n}"). Omit to
   * use the account the project already tracks, falling back to the first
   * account the OAuth user can see on the very first discover.
   */
  accountName: z.string().optional(),
  /**
   * Permit replacing the project's locations when `accountName` names a
   * DIFFERENT account than the one currently tracked. Switching is destructive
   * (it clears the old account's locations + synced data), so it must be opted
   * into explicitly — otherwise a mismatched account is rejected.
   */
  switchAccount: z.boolean().default(false),
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

/**
 * The message a GBP sync fails with when its project selects no location. A
 * GBP connection belongs to the domain, so the data refresh syncs every
 * project on it, and each one without a selected location fails this way by
 * design. The doctor's sync-failure check reads it to leave those runs out.
 */
export const GBP_NO_SELECTED_LOCATIONS_ERROR = 'No selected GBP locations to sync. Discover and select locations first.'

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
  /** Share of returned keywords that are privacy-thresholded (0–100, at wire precision). */
  thresholdedPct: percent(z.number().min(0).max(100)),
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
  /**
   * Count of non-empty top-level groups in the Lodging API response.
   * 0 means the API returned no readable structured groups; it is a
   * verify-the-Hotel-details-panel signal, not proof the hotel has no amenities.
   */
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

// Owner-set Business Profile attributes (any business category) — generic
// amenity / service / accessibility / identity / social-URL tags, captured via
// the Business Information API. Distinct from lodging (hotels only) and from
// the Places rendered listing (public-side). `values` carries BOOL/ENUM
// scalars and REPEATED_ENUM set values, `unsetValues` carries explicit
// REPEATED_ENUM false values, and `uris` carries URL-attribute links.
export const gbpAttributeDtoSchema = z.object({
  name: z.string(),
  valueType: z.string(),
  values: z.array(z.union([z.boolean(), z.string()])),
  unsetValues: z.array(z.string()),
  uris: z.array(z.string()),
})
export type GbpAttributeDto = z.infer<typeof gbpAttributeDtoSchema>

export const gbpAttributesDtoSchema = z.object({
  locationName: z.string(),
  /** Count of owner-set attributes (getAttributes returns only set ones). */
  attributeCount: z.number().int().nonnegative(),
  syncedAt: z.string(),
  attributes: z.array(gbpAttributeDtoSchema),
})
export type GbpAttributesDto = z.infer<typeof gbpAttributesDtoSchema>

export const gbpAttributesListResponseSchema = z.object({
  attributes: z.array(gbpAttributesDtoSchema),
  total: z.number().int().nonnegative(),
})
export type GbpAttributesListResponse = z.infer<typeof gbpAttributesListResponseSchema>

// Places (New) rendered-listing snapshot per location (#648). `amenities` is
// the server-derived cross-reference signal (what the public listing asserts);
// `place` is the raw Place Details resource for full inspection.
export const gbpPlaceDetailsDtoSchema = z.object({
  locationName: z.string(),
  placeId: z.string(),
  /** Field-mask SKU tier the snapshot was fetched at ('atmosphere' | 'pro'). */
  tier: z.string(),
  /** Amenities the public listing advertises, derived from `place`. */
  amenities: z.array(z.string()),
  /** When this listing was last fetched from Places — advances on every fetch, even when the content is unchanged (this is what the refresh-cadence gate reads). */
  syncedAt: z.string(),
  /** Raw Place Details resource as Google returned it. */
  place: z.record(z.string(), z.unknown()),
})
export type GbpPlaceDetailsDto = z.infer<typeof gbpPlaceDetailsDtoSchema>

export const gbpPlaceDetailsListResponseSchema = z.object({
  places: z.array(gbpPlaceDetailsDtoSchema),
  total: z.number().int().nonnegative(),
})
export type GbpPlaceDetailsListResponse = z.infer<typeof gbpPlaceDetailsListResponseSchema>

// Reviews. `gbp` is the Business Profile v4 reviews API: owner access, every
// review, but Google enables it per Cloud project only on request. `places` is
// the public Places listing: at most five reviews chosen by relevance plus the
// overall rating, the fallback for locations without v4 access.
export const gbpReviewOriginSchema = z.enum(['gbp', 'places'])
export type GbpReviewOrigin = z.infer<typeof gbpReviewOriginSchema>

/**
 * Reviews rated this many stars or fewer are negative: the `review.negative`
 * threshold when a project has not set its own `negativeReviewMaxStars`.
 */
export const GBP_NEGATIVE_REVIEW_MAX_STARS = 3

/**
 * A project's own threshold. 5 is excluded: it would make every review
 * "negative", which is a different alert from the one this event promises.
 */
export const gbpNegativeReviewMaxStarsSchema = z.number().int().min(1).max(4)

/** The threshold in force for a project, from its stored setting (null = default). */
export function resolveNegativeReviewMaxStars(setting: number | null | undefined): number {
  return setting ?? GBP_NEGATIVE_REVIEW_MAX_STARS
}

export function isNegativeReviewRating(starRating: number | null, maxStars: number = GBP_NEGATIVE_REVIEW_MAX_STARS): boolean {
  return starRating !== null && starRating >= 1 && starRating <= maxStars
}

/** Business Profile v4 reviews access for a location, as of its last sync. */
export const gbpReviewsAccessSchema = z.enum(['ok', 'unavailable', 'error'])
export type GbpReviewsAccess = z.infer<typeof gbpReviewsAccessSchema>

/**
 * Whether Business Profile reviews cover a location: v4 works there, or it
 * failed transiently where it has worked before. After a transient failure
 * the next sync pages back past the gap, so alerts are delayed, not lost, and
 * switching to the Places fallback would only send the same review twice.
 */
export function businessProfileReviewsCover(access: GbpReviewsAccess | null, v4HasWorked: boolean): boolean {
  return access === 'ok' || (access === 'error' && v4HasWorked)
}

/**
 * Where a review or rating change stands with the review webhooks.
 *
 *   - none: not an alert (a 4-5 star review, or a rating that did not drop)
 *   - baseline: seen on the first sync of its location and origin, recorded without alerting
 *   - stale: negative, but older than the alert window by the time it was seen or delivered
 *   - pending: queued for the next dispatch
 *   - sent: delivered to at least one subscribed webhook
 *   - skipped: no enabled webhook subscribes to the event
 *   - suppressed: a Places signal for a location that Business Profile reviews already cover
 */
export const gbpReviewAlertStateSchema = z.enum(['none', 'baseline', 'stale', 'pending', 'sent', 'skipped', 'suppressed'])
export type GbpReviewAlertState = z.infer<typeof gbpReviewAlertStateSchema>
export const GbpReviewAlertStates = gbpReviewAlertStateSchema.enum

export const gbpReviewDtoSchema = z.object({
  locationName: z.string(),
  origin: gbpReviewOriginSchema,
  /** Provider resource name, stable per origin. */
  reviewName: z.string(),
  /** 1-5, or null when Google reports no rating. */
  starRating: z.number().int().min(1).max(5).nullable(),
  /** At or below the project's negative-review threshold, the one the `review.negative` webhook uses. */
  negative: z.boolean(),
  comment: z.string().nullable(),
  reviewerName: z.string().nullable(),
  createTime: z.string().nullable(),
  /** Last edit by the reviewer (Places: when it was posted). */
  updateTime: z.string(),
  /** Whether the owner has replied. Null for Places, which does not expose replies. */
  replied: z.boolean().nullable(),
  replyComment: z.string().nullable(),
  replyUpdateTime: z.string().nullable(),
  /** Link to the review on Google Maps, when the origin provides one. */
  reviewUri: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  alertState: gbpReviewAlertStateSchema,
  alertStateAt: z.string().nullable(),
})
export type GbpReviewDto = z.infer<typeof gbpReviewDtoSchema>

export const gbpReviewLocationDtoSchema = z.object({
  locationName: z.string(),
  displayName: z.string(),
  /** Business Profile v4 reviews access on the last sync; null before the first check. */
  reviewsAccess: gbpReviewsAccessSchema.nullable(),
  /** Why access is not `ok`, e.g. "SERVICE_DISABLED". */
  reviewsAccessReason: z.string().nullable(),
  reviewsCheckedAt: z.string().nullable(),
  /** Latest average rating Google reported, from whichever origin was observed most recently. */
  rating: z.number().nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  ratingOrigin: gbpReviewOriginSchema.nullable(),
  ratingObservedAt: z.string().nullable(),
})
export type GbpReviewLocationDto = z.infer<typeof gbpReviewLocationDtoSchema>

export const gbpReviewListResponseSchema = z.object({
  /** The project's negative-review threshold in stars: what `negative` and the `negative` filter mean. */
  negativeMaxStars: z.number().int().min(1).max(4),
  locations: z.array(gbpReviewLocationDtoSchema),
  /** Newest update first. */
  reviews: z.array(gbpReviewDtoSchema),
  /** Reviews matching the filters before `limit` applied. */
  total: z.number().int().nonnegative(),
})
export type GbpReviewListResponse = z.infer<typeof gbpReviewListResponseSchema>

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
    // Per-metric % change recent-vs-prior (percent units at wire precision: 12.5
    // is +12.5%), computed over COMPLETE days only (the windows anchor to
    // `freshness.dataThroughDate`, never the lagging tail), so a
    // reporting-lag artifact is never shown as a real delta.
    deltaPct: z.record(z.string(), percent().nullable()),
  }),
  // GBP Performance data lags a few days; the most recent stored days can be
  // not-yet-reported zeros. `freshness` lets every renderer mark the trailing
  // window as pending instead of treating it as a real decline.
  freshness: z.object({
    /** Latest day with reported (non-zero) activity — the last complete day. Null when there's no data. */
    dataThroughDate: z.string().nullable(),
    /** Max stored metric date (>= dataThroughDate when Google has emitted not-yet-final zero rows). Null when there's no data. */
    latestStoredDate: z.string().nullable(),
    /** Calendar days between dataThroughDate and the as-of date — the trailing window still pending/unreported. */
    pendingDays: z.number().int().nonnegative(),
  }),
  // Daily series (most recent ~30 days) for the trend charts. Each day carries
  // every metric present in the window (0 where a metric had no row that day),
  // and a `pending` flag so the lag tail renders distinct, never as zeros.
  timeseries: z.array(z.object({
    date: z.string(),
    pending: z.boolean(),
    metrics: z.record(z.string(), z.number()),
  })),
  keywords: z.object({
    total: z.number().int().nonnegative(),
    thresholdedCount: z.number().int().nonnegative(),
    /** `thresholdedCount / total` as 0–100 at wire precision; 0 when there are no keywords. */
    thresholdedPct: percent(z.number().min(0).max(100)),
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
  // Owner-content completeness over the in-scope locations: how many populate
  // each entity-anchor / qualifier field AI answer engines weight.
  profileCompleteness: z.object({
    locationCount: z.number().int().nonnegative(),
    withSecondaryCategories: z.number().int().nonnegative(),
    secondaryCategoryTotal: z.number().int().nonnegative(),
    withDescription: z.number().int().nonnegative(),
    withServiceArea: z.number().int().nonnegative(),
    withHours: z.number().int().nonnegative(),
    withPrimaryPhone: z.number().int().nonnegative(),
    permanentlyClosed: z.number().int().nonnegative(),
    temporarilyClosed: z.number().int().nonnegative(),
  }),
})
export type GbpSummaryDto = z.infer<typeof gbpSummaryDtoSchema>

// ----- Metric presentation (shared by web + CLI so labels never diverge) -----

// Human-readable label per GBP DailyMetric enum key. Unknown keys fall back to
// `humanizeMetricKey` so a raw `BUSINESS_*` token never reaches a surface.
const GBP_METRIC_LABELS: Record<string, string> = {
  BUSINESS_DIRECTION_REQUESTS: 'Direction requests',
  WEBSITE_CLICKS: 'Website clicks',
  CALL_CLICKS: 'Call clicks',
  BUSINESS_BOOKINGS: 'Bookings',
  BUSINESS_CONVERSATIONS: 'Conversations',
  BUSINESS_FOOD_ORDERS: 'Food orders',
  BUSINESS_FOOD_MENU_CLICKS: 'Food menu clicks',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'Search impressions (desktop)',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'Search impressions (mobile)',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'Maps impressions (desktop)',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'Maps impressions (mobile)',
}

/** Strip the `BUSINESS_` prefix and sentence-case an unknown metric key. */
function humanizeMetricKey(metric: string): string {
  const words = metric.replace(/^BUSINESS_/, '').split('_').filter(Boolean).map((w) => w.toLowerCase())
  if (words.length === 0) return metric
  const joined = words.join(' ')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/** Human-readable label for a GBP metric key. Never returns a raw `BUSINESS_*` token. */
export function formatGbpMetricLabel(metric: string): string {
  return GBP_METRIC_LABELS[metric] ?? humanizeMetricKey(metric)
}

/** The outcome metrics a property owner cares about (the conversion hero). */
export const GBP_CONVERSION_METRICS = [
  'BUSINESS_DIRECTION_REQUESTS',
  'WEBSITE_CLICKS',
  'CALL_CLICKS',
] as const

/** The reach metrics (impressions) — supporting context, not outcomes. */
export const GBP_REACH_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
] as const

export type GbpMetricGroup = 'conversion' | 'reach' | 'other'

/**
 * Classify a metric into the dashboard's two chart groups. `conversion`
 * (directions / website / calls) is the outcome hero; `reach` (impressions)
 * is context; everything else (`bookings`, `conversations`, food ordering)
 * is `other` and only surfaces when it has activity.
 */
export function classifyGbpMetric(metric: string): GbpMetricGroup {
  if ((GBP_CONVERSION_METRICS as readonly string[]).includes(metric)) return 'conversion'
  if ((GBP_REACH_METRICS as readonly string[]).includes(metric)) return 'reach'
  return 'other'
}
