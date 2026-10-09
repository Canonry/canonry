import { z } from 'zod'
import { fraction, percent } from './ratio-unit.js'
import { aiReferralTrafficClassSchema } from './traffic-class.js'

export const ga4ConnectionDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  propertyId: z.string(),
  clientEmail: z.string(),
  connected: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GA4ConnectionDto = z.infer<typeof ga4ConnectionDtoSchema>

export const ga4TrafficSnapshotDtoSchema = z.object({
  date: z.string(),
  landingPage: z.string(),
  sessions: z.number(),
  organicSessions: z.number(),
  users: z.number(),
})
export type GA4TrafficSnapshotDto = z.infer<typeof ga4TrafficSnapshotDtoSchema>

/** Which GA4 dimension produced the AI referral row */
export const ga4SourceDimensionSchema = z.enum(['session', 'first_user', 'manual_utm'])
export type GA4SourceDimension = z.infer<typeof ga4SourceDimensionSchema>

export const ga4AiReferralDtoSchema = z.object({
  source: z.string(),
  medium: z.string(),
  trafficClass: aiReferralTrafficClassSchema,
  sessions: z.number(),
  /**
   * @deprecated Never emitted since 4.135.0. Removed in the next major.
   *
   * GA reports `totalUsers` as a COUNT DISTINCT at the grain requested, and
   * `ga_ai_referrals` is keyed by (date, source, medium, channelGroup,
   * landingPage, sourceDimension), so summing it re-counted the same visitor on
   * every extra day, page and channel they appear in. Unlike GA daily users, no
   * un-dimensioned AI-referral fetch exists to ask Google for the true figure,
   * so the number could not be corrected — only withdrawn. Optional rather than
   * deleted so existing API / `canonry ga traffic --format json` / MCP
   * consumers keep parsing; they now read `undefined` instead of an inflated
   * number. Sessions are unaffected: GA4 attributes exactly one landing page
   * per session, so the landing-page rows partition the day and do sum.
   */
  users: z.number().optional(),
  /**
   * The winning attribution dimension for this (source, medium) tuple — the
   * one with the highest session count. GA4 emits one row per dimension
   * (session, first_user, manual_utm), but they're overlapping lenses on the
   * same visit; only the dominant dimension is surfaced here so the table is
   * not inflated.
   */
  sourceDimension: ga4SourceDimensionSchema,
  /**
   * This row's sessions as a 0..1 share of every `aiReferrals` row's sessions,
   * so the rows' shares add up to 1 (all 0 when the rows carry no sessions).
   * The denominator is the rows' own sum, not `aiSessionsDeduped`: that total
   * keeps the winning lens per day and source, these rows keep one lens per
   * source over the whole window, so it can run higher than the rows add up to.
   */
  share: fraction(),
})
export type GA4AiReferralDto = z.infer<typeof ga4AiReferralDtoSchema>

export const ga4AiReferralLandingPageDtoSchema = z.object({
  source: z.string(),
  medium: z.string(),
  trafficClass: aiReferralTrafficClassSchema,
  /**
   * The winning attribution dimension for this (source, medium, landingPage)
   * tuple — the one with the highest session count.
   */
  sourceDimension: ga4SourceDimensionSchema,
  landingPage: z.string(),
  sessions: z.number(),
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  users: z.number().optional(),
})
export type GA4AiReferralLandingPageDto = z.infer<typeof ga4AiReferralLandingPageDtoSchema>

export const ga4SocialReferralDtoSchema = z.object({
  source: z.string(),
  medium: z.string(),
  sessions: z.number(),
  /**
   * @deprecated Never emitted by `/ga/traffic`. ga_social_referrals stores
   * users as GA's COUNT DISTINCT at (date, source, medium, channel group), so
   * summing it across the window counts a returning visitor once per day.
   * Optional so existing consumers keep parsing.
   */
  users: z.number().optional(),
  /** GA4 default channel group (e.g. 'Organic Social', 'Paid Social') */
  channelGroup: z.string(),
  /**
   * This row's sessions as a 0..1 share of the window's social sessions
   * (`socialSessions`, which is the sum of these rows), so the rows' shares add
   * up to 1 (all 0 when there are no social sessions).
   */
  share: fraction(),
})
export type GA4SocialReferralDto = z.infer<typeof ga4SocialReferralDtoSchema>

export const ga4ChannelBucketDtoSchema = z.object({
  sessions: z.number(),
  sharePct: percent(),
  sharePctDisplay: z.string(),
})
export type GA4ChannelBucketDto = z.infer<typeof ga4ChannelBucketDtoSchema>

export const ga4ChannelBreakdownDtoSchema = z.object({
  organic: ga4ChannelBucketDtoSchema,
  social: ga4ChannelBucketDtoSchema,
  direct: ga4ChannelBucketDtoSchema,
  ai: ga4ChannelBucketDtoSchema,
  other: ga4ChannelBucketDtoSchema,
})
export type GA4ChannelBreakdownDto = z.infer<typeof ga4ChannelBreakdownDtoSchema>

export const ga4TrafficSummaryDtoSchema = z.object({
  totalSessions: z.number(),
  totalOrganicSessions: z.number(),
  /** Direct-channel sessions (sessions with no source — bookmarks, typed URLs, AI-driven traffic with stripped referrer). 0 for legacy rows from before the column was added. */
  totalDirectSessions: z.number(),
  /**
   * Null when the range has no un-dimensioned aggregate behind it.
   *
   * GA counts users as a COUNT DISTINCT at the grain requested, so users cannot
   * be recovered by summing the landing-page dimensioned table. The rolling
   * windows have a precomputed deduplicated row; an explicit calendar range does
   * not, and reports the figure as unavailable rather than as an inflated sum.
   */
  totalUsers: z.number().nullable(),
  topPages: z.array(z.object({
    landingPage: z.string(),
    sessions: z.number(),
    organicSessions: z.number(),
    /** Per-page Direct-channel sessions. 0 for legacy rows. */
    directSessions: z.number(),
    users: z.number(),
    /**
     * Organic search sessions as a 0..1 share of this page's sessions. 0 when
     * the page has no organic sessions; null when organic sessions exist with
     * no session count to divide them by, a share that cannot be known.
     */
    organicShare: fraction().nullable(),
  })),
  aiReferrals: z.array(ga4AiReferralDtoSchema),
  aiReferralLandingPages: z.array(ga4AiReferralLandingPageDtoSchema),
  /** Deduped AI session total: MAX(sessions) per date+source across attribution dimensions, then summed. Cross-cutting: can overlap with Direct/Organic/Social via firstUserSource. */
  aiSessionsDeduped: z.number(),
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  aiUsersDeduped: z.number().optional(),
  /** Deduped AI sessions whose attribution carries paid intent. */
  paidAiSessionsDeduped: z.number(),
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  paidAiUsersDeduped: z.number().optional(),
  /** Deduped AI sessions without paid intent evidence. */
  organicAiSessionsDeduped: z.number(),
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  organicAiUsersDeduped: z.number().optional(),
  /** AI sessions whose CURRENT sessionSource matched an AI engine. Can overlap with raw Organic/Social/Direct totals; `channelBreakdown` removes those overlaps for display. */
  aiSessionsBySession: z.number(),
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  aiUsersBySession: z.number().optional(),
  /** Session-source-only paid AI sessions. */
  paidAiSessionsBySession: z.number(),
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  paidAiUsersBySession: z.number().optional(),
  /** Session-source-only organic/non-paid AI sessions. */
  organicAiSessionsBySession: z.number(),
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  organicAiUsersBySession: z.number().optional(),
  socialReferrals: z.array(ga4SocialReferralDtoSchema),
  /** Total social sessions (session-scoped, no cross-dimension dedup needed). */
  socialSessions: z.number(),
  /** Total social users (session-scoped, no cross-dimension dedup needed). */
  /**
   * @deprecated Never emitted. ga_social_referrals stores users as GA's
   * COUNT DISTINCT at (date, source, medium, channel group), so summing it
   * across the window counts a returning visitor once per day.
   */
  socialUsers: z.number().optional(),
  /** Five disjoint buckets used for the channel breakdown. Known AI session-source matches are removed from their native GA4 bucket before shares are computed. */
  channelBreakdown: ga4ChannelBreakdownDtoSchema,
  /** Organic sessions as a percentage of total sessions (0–100, at wire precision). */
  organicSharePct: percent(),
  /** Deduped AI sessions as a percentage of total sessions (0–100, at wire precision). Cross-cutting: can overlap with Direct/Organic/Social. */
  aiSharePct: percent(),
  /** Session-source-only AI sessions as a percentage of total sessions (0–100, at wire precision). Can overlap with raw Organic/Social/Direct totals. */
  aiSharePctBySession: percent(),
  /** Paid AI sessions as a percentage of total sessions (0–100, at wire precision). */
  paidAiSharePct: percent(),
  /** Session-source paid AI sessions as a percentage of total sessions (0–100, at wire precision). */
  paidAiSharePctBySession: percent(),
  /** Organic/non-paid AI sessions as a percentage of total sessions (0–100, at wire precision). */
  organicAiSharePct: percent(),
  /** Session-source organic/non-paid AI sessions as a percentage of total sessions (0–100, at wire precision). */
  organicAiSharePctBySession: percent(),
  /** Direct-channel sessions as a percentage of total sessions (0–100, at wire precision). */
  directSharePct: percent(),
  /** Social sessions as a percentage of total sessions (0–100, at wire precision). */
  socialSharePct: percent(),
  /** Display string for organicSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  organicSharePctDisplay: z.string(),
  /** Display string for aiSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctDisplay: z.string(),
  /** Display string for aiSharePctBySession: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctBySessionDisplay: z.string(),
  /** Display string for paidAiSharePct. */
  paidAiSharePctDisplay: z.string(),
  /** Display string for paidAiSharePctBySession. */
  paidAiSharePctBySessionDisplay: z.string(),
  /** Display string for organicAiSharePct. */
  organicAiSharePctDisplay: z.string(),
  /** Display string for organicAiSharePctBySession. */
  organicAiSharePctBySessionDisplay: z.string(),
  /** Display string for directSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  directSharePctDisplay: z.string(),
  /** Display string for socialSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  socialSharePctDisplay: z.string(),
  /** Sessions not covered by Organic, Social, Direct, or AI (session) channels — e.g. Referral, Email, Paid Search, Display. Always non-negative; clamped to 0 when the four disjoint channels sum above total (rounding edge). */
  otherSessions: z.number(),
  /** Other sessions as a percentage of total sessions (0–100, at wire precision). */
  otherSharePct: percent(),
  /** Display string for otherSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  otherSharePctDisplay: z.string(),
  lastSyncedAt: z.string().nullable(),
})
export type GA4TrafficSummaryDto = z.infer<typeof ga4TrafficSummaryDtoSchema>

// API response DTOs for GA4 CLI commands

export interface GaConnectResponse {
  connected: boolean
  propertyId: string
  authMethod: 'service-account' | 'oauth'
  clientEmail?: string
}

/**
 * Response shape for `GET /projects/:name/ga/status`. Two branches:
 *  - disconnected: `{connected: false, propertyId/clientEmail/authMethod/lastSyncedAt: null}` (no createdAt/updatedAt)
 *  - connected: same fields populated, plus optional `createdAt`/`updatedAt` from the SA or OAuth connection row
 */
export const ga4StatusDtoSchema = z.object({
  connected: z.boolean(),
  propertyId: z.string().nullable(),
  clientEmail: z.string().nullable(),
  authMethod: z.enum(['service-account', 'oauth']).nullable(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
})
export type GA4StatusDto = z.infer<typeof ga4StatusDtoSchema>
/** Legacy alias retained for callers that still import `GaStatusResponse`. */
export type GaStatusResponse = GA4StatusDto

/**
 * One GA4 property the connected OAuth principal can read.
 *
 * `propertyId` is the numeric id `ga connect --property-id` takes, already
 * stripped of the Admin API's `properties/` prefix.
 */
export const ga4PropertySummaryDtoSchema = z.object({
  propertyId: z.string(),
  displayName: z.string(),
  /** GA4 account that owns the property. Two accounts can hold like-named properties. */
  accountName: z.string(),
})
export type GA4PropertySummaryDto = z.infer<typeof ga4PropertySummaryDtoSchema>

export const ga4PropertiesDtoSchema = z.object({
  properties: z.array(ga4PropertySummaryDtoSchema),
})
export type GA4PropertiesDto = z.infer<typeof ga4PropertiesDtoSchema>

/**
 * The windows GA4's "Google organic search traffic: Landing page + query
 * string" report (Search Console collection) is stored for. Each one is a
 * GA4-computed snapshot ending YESTERDAY in the property's reporting time
 * zone, exactly as GA4's own "Last N days" ranges are, so `28d` is the window
 * GA4's report opens on. Not the rolling `7d | 30d | 90d` of `/ga/traffic`.
 */
export const gaSearchLandingWindowSchema = z.enum(['7d', '28d', '90d'])
export type GaSearchLandingWindow = z.infer<typeof gaSearchLandingWindowSchema>
export const GA_SEARCH_LANDING_WINDOWS: readonly GaSearchLandingWindow[] = gaSearchLandingWindowSchema.options
export const GA_SEARCH_LANDING_WINDOW_DAYS: Readonly<Record<GaSearchLandingWindow, number>> = {
  '7d': 7,
  '28d': 28,
  '90d': 90,
}
export const GA_SEARCH_LANDING_DEFAULT_WINDOW: GaSearchLandingWindow = '28d'
export const GA_SEARCH_LANDING_DEFAULT_LIMIT = 50

/** How surfaces show the empty landing page GA4 can report beside `(not set)`; stored rows keep GA4's raw ''. */
export const GA_SEARCH_LANDING_EMPTY_PAGE_LABEL = '(empty)'

/** The display text for a stored `landingPagePlusQueryString`: GA4's value, or the empty-page label for ''. */
export function gaSearchLandingPageLabel(landingPage: string): string {
  return landingPage === '' ? GA_SEARCH_LANDING_EMPTY_PAGE_LABEL : landingPage
}
export const GA_SEARCH_LANDING_MAX_LIMIT = 1000

/**
 * State of the stored Search Console landing-page snapshot.
 *
 * - `never-synced`: no GA sync has attempted it yet for the GA4 property the
 *   project resolves to now. A stored snapshot of another property reads this
 *   way too, with no Total and no rows, until the next sync replaces it.
 * - `ready`: the last attempt stored a snapshot.
 * - `unavailable`: GA4 refused the Search Console metrics, which is what a
 *   property without a Search Console link is expected to do. The previous
 *   snapshot, if any, is kept and still returned.
 * - `error`: the last attempt failed for another reason (auth, quota, network).
 *   The previous snapshot, if any, is kept and still returned.
 */
export const gaSearchLandingStatusSchema = z.enum(['never-synced', 'ready', 'unavailable', 'error'])
export type GaSearchLandingStatus = z.infer<typeof gaSearchLandingStatusSchema>

/**
 * One row of the report, or its Total. Field names are GA4's own metric names,
 * so they cannot be mistaken for Canonry's Search Console sync (`clicks`,
 * `ctr`, `position`): these figures come from GA4's Search Console link.
 */
export const gaSearchLandingMetricsSchema = z.object({
  organicGoogleSearchClicks: z.number().int().nonnegative(),
  organicGoogleSearchImpressions: z.number().int().nonnegative(),
  /** GA4's own click-through rate (0..1). Null when there were no impressions. */
  organicGoogleSearchClickThroughRate: fraction(z.number().min(0).max(1)).nullable(),
  /** GA4's own average position. Null when there were no impressions. */
  organicGoogleSearchAveragePosition: z.number().nonnegative().nullable(),
  /**
   * GA4's plain `activeUsers` from the same request, which is what GA4's own
   * report shows in this column (verified against the GA4 UI). Not limited to
   * Google organic sessions.
   */
  activeUsers: z.number().int().nonnegative(),
})
export type GaSearchLandingMetrics = z.infer<typeof gaSearchLandingMetricsSchema>

export const gaSearchLandingPageRowSchema = gaSearchLandingMetricsSchema.extend({
  /** GA4's `landingPagePlusQueryString`, exactly as reported (never normalized). */
  landingPage: z.string(),
})
export type GaSearchLandingPageRow = z.infer<typeof gaSearchLandingPageRowSchema>

/**
 * Response of `GET /projects/:name/ga/search-landing-pages`: one stored
 * window of GA4's Search Console landing-page report.
 */
export const gaSearchLandingPagesResponseSchema = z.object({
  source: z.literal('ga4-search-console-link'),
  status: gaSearchLandingStatusSchema,
  /** The last failed attempt's message (Google's own text for `unavailable`). */
  error: z.string().nullable(),
  /** When the stored snapshot was written. Null when none exists. */
  syncedAt: z.string().datetime().nullable(),
  /** When a sync last tried to refresh the snapshot, successful or not. */
  attemptedAt: z.string().datetime().nullable(),
  window: gaSearchLandingWindowSchema,
  /** Inclusive first day of the stored window, in the property's time zone. */
  windowStart: z.iso.date().nullable(),
  /** Inclusive last day of the stored window (yesterday at sync time). */
  windowEnd: z.iso.date().nullable(),
  windowDays: z.number().int().positive().nullable(),
  /** GA4 property reporting time zone the window dates are in. */
  timeZone: z.string().nullable(),
  subjectToThresholding: z.boolean(),
  dataLossFromOtherRow: z.boolean(),
  /** GA4's own TOTAL row for the window. Never a sum of `rows`. Null when no snapshot exists. */
  total: gaSearchLandingMetricsSchema.nullable(),
  /** Rows GA4 reported for the window. Can exceed `totalRows` when `rowsCapped`. */
  reportRowCount: z.number().int().nonnegative().nullable(),
  /** True when GA4 reported more rows than were stored (the per-window row cap). */
  rowsCapped: z.boolean(),
  /** Stored rows for the window, the population `limit` / `offset` page over. */
  totalRows: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** Ordered by clicks, then impressions (both descending), then landing page. */
  rows: z.array(gaSearchLandingPageRowSchema),
})
export type GaSearchLandingPagesResponse = z.infer<typeof gaSearchLandingPagesResponseSchema>

/**
 * Whether a window's GA4 Total carries any Google organic search data (a click
 * or an impression). A window can list pages and still have none: GA4 reports
 * pages with active users and 0 clicks and 0 impressions. The dashboard and
 * the CLI read this, never the row count, to say the window had no Google
 * organic search traffic.
 */
export function gaSearchLandingHasSearchData(total: GaSearchLandingMetrics): boolean {
  return total.organicGoogleSearchClicks > 0 || total.organicGoogleSearchImpressions > 0
}

/** Outcome of the Search Console landing-page component of one GA sync. */
export const gaSearchLandingSyncResultSchema = z.object({
  status: z.enum(['ready', 'unavailable', 'error']),
  /** Windows written by this sync, empty unless `ready`. */
  windows: z.array(z.object({
    window: gaSearchLandingWindowSchema,
    rowCount: z.number().int().nonnegative(),
    reportRowCount: z.number().int().nonnegative(),
    rowsCapped: z.boolean(),
  })),
  /** Landing-page rows written across every window. */
  rowCount: z.number().int().nonnegative(),
  error: z.string().optional(),
})
export type GaSearchLandingSyncResult = z.infer<typeof gaSearchLandingSyncResultSchema>

/**
 * The `only` values `POST /projects/:name/ga/sync` accepts. Each one keeps the
 * foundation (traffic snapshots and summaries) and adds one slice:
 * `traffic` adds none, `ai` the AI referrals, `social` the social referrals,
 * `search-landing` the Search Console landing-page snapshot.
 */
export const gaSyncOnlySchema = z.enum(['traffic', 'ai', 'social', 'search-landing'])
export type GaSyncOnly = z.infer<typeof gaSyncOnlySchema>

/**
 * Response shape for `POST /projects/:name/ga/sync`. `syncedComponents`
 * is present only when the request specified an `only` filter (`'traffic' |
 * 'ai' | 'social' | 'search-landing'`).
 */
export const ga4SyncResponseDtoSchema = z.object({
  synced: z.boolean(),
  rowCount: z.number().int().nonnegative(),
  aiReferralCount: z.number().int().nonnegative(),
  socialReferralCount: z.number().int().nonnegative(),
  /**
   * The window that was ACTUALLY fetched and written, in days — the request's
   * `days` bounded to GA4's supported sync range (1–90). Read this, not
   * `requestedDays`, when reporting or reasoning about coverage: a
   * `--days 500` sync writes 90 days, and this field says 90.
   */
  days: z.number().int().nonnegative(),
  /** The window the caller asked for, before bounding. Equals `days` unless `clamped`. */
  requestedDays: z.number().int().nonnegative(),
  /**
   * True when `requestedDays` fell outside GA4's supported range and `days`
   * differs from it — i.e. the synced history is not the range requested.
   */
  clamped: z.boolean(),
  syncedAt: z.string(),
  measurement: z.object({
    acquisition: z.object({ days: z.number().int().nonnegative(), status: z.enum(['ready', 'error']), rowCount: z.number().int().nonnegative(), error: z.string().optional() }),
    leads: z.object({ days: z.number().int().nonnegative(), status: z.enum(['ready', 'error', 'not-configured']), rowCount: z.number().int().nonnegative(), attributionScope: z.enum(['landing-page', 'channel']).optional(), error: z.string().optional() }),
    /**
     * GA4's Search Console landing-page snapshot. Absent when `only` names
     * another slice, since this sync did not attempt it. Its failure never
     * fails the sync: the previous snapshot is kept.
     */
    searchLandingPages: gaSearchLandingSyncResultSchema.optional(),
  }),
  /**
   * Components that were written this run. Present when `only` is set.
   * Always includes `traffic` and `summary` (the share denominator) plus
   * the requested slice: `ai`, `social` or `search-landing`. `search-landing`
   * fails soft, so it is listed only when its snapshot was stored; a failed
   * or `unavailable` attempt is left out and reported in
   * `measurement.searchLandingPages`.
   */
  syncedComponents: z.array(z.string()).optional(),
})
export type GA4SyncResponseDto = z.infer<typeof ga4SyncResponseDtoSchema>
/** Legacy alias retained for callers that still import `GaSyncResponse`. */
export type GaSyncResponse = GA4SyncResponseDto

/**
 * How a mover's change against the prior 7 days is stated. The server decides
 * it once, so the CLI, MCP and Aero read the same answer.
 *
 * - `new`: the source sent no sessions in the prior 7 days. A change from zero
 *   has no percentage, so `changePct` is null and the source reads as new,
 *   never as "+100%".
 * - `small-base`: the prior 7 days sent fewer than `MIN_PCT_BASE` sessions, a
 *   base too small for a percentage to mean much ("+150%" off 2 sessions), so
 *   state `changeSessions` instead. The same rule the report's count tiles use.
 * - `percent`: the prior base is large enough; state `changePct`.
 */
export const gaMoverChangeBasisSchema = z.enum(['new', 'small-base', 'percent'])
export type GaMoverChangeBasis = z.infer<typeof gaMoverChangeBasisSchema>
export const GaMoverChangeBases = gaMoverChangeBasisSchema.enum

/** The source whose sessions moved the most, in either direction, over the last 7 days against the 7 before. */
export const gaSourceMoverSchema = z.object({
  source: z.string(),
  /** Sessions from this source in the last 7 days. */
  sessions7d: z.number(),
  /** Sessions from this source in the 7 days before that. */
  sessionsPrev7d: z.number(),
  /** Signed session change, `sessions7d - sessionsPrev7d`. The mover is the source whose change is largest in size. */
  changeSessions: z.number(),
  /**
   * Signed whole-percent change against the prior 7 days (`150` = +150%, `-100`
   * = the source stopped sending sessions). Null when the prior 7 days had no
   * sessions (`changeBasis: 'new'`), since a change from zero has no percentage.
   */
  changePct: percent().nullable(),
  changeBasis: gaMoverChangeBasisSchema,
})
export type GaSourceMover = z.infer<typeof gaSourceMoverSchema>

export const gaSocialReferralTrendResponseSchema = z.object({
  socialSessions7d: z.number(),
  socialSessionsPrev7d: z.number(),
  /** Signed whole-percent change of the last 7 days against the 7 before. Null when the prior 7 days had no sessions. */
  trend7dPct: percent().nullable(),
  socialSessions30d: z.number(),
  socialSessionsPrev30d: z.number(),
  /** Signed whole-percent change of the last 30 days against the 30 before. Null when the prior 30 days had no sessions. */
  trend30dPct: percent().nullable(),
  /** Social source with the largest session change in the last 7 days against the 7 before. Null when no source moved. */
  biggestMover: gaSourceMoverSchema.nullable(),
})
export type GaSocialReferralTrendResponse = z.infer<typeof gaSocialReferralTrendResponseSchema>

export const gaChannelTrendSchema = z.object({
  sessions7d: z.number(),
  sessionsPrev7d: z.number(),
  /** Signed whole-percent change of the last 7 days against the 7 before. Null when the prior 7 days had no sessions. */
  trend7dPct: percent().nullable(),
  sessions30d: z.number(),
  sessionsPrev30d: z.number(),
  /** Signed whole-percent change of the last 30 days against the 30 before. Null when the prior 30 days had no sessions. */
  trend30dPct: percent().nullable(),
})
export type GaChannelTrend = z.infer<typeof gaChannelTrendSchema>

export const gaAttributionTrendResponseSchema = z.object({
  organic: gaChannelTrendSchema,
  /** AI session trend, scoped to sessionSource-only matches so it lines up with the disjoint AI cell in the channel breakdown. */
  ai: gaChannelTrendSchema,
  social: gaChannelTrendSchema,
  direct: gaChannelTrendSchema,
  total: gaChannelTrendSchema,
  /** AI source with the largest session change in the last 7 days against the 7 before (sessionSource only). Null when no source moved. */
  aiBiggestMover: gaSourceMoverSchema.nullable(),
  /** Social source with the largest session change in the last 7 days against the 7 before. Null when no source moved. */
  socialBiggestMover: gaSourceMoverSchema.nullable(),
})
export type GaAttributionTrendResponse = z.infer<typeof gaAttributionTrendResponseSchema>

/**
 * Response of `GET /projects/:name/ga/traffic`: the traffic summary plus the
 * one window every figure in it was measured over.
 */
export const gaTrafficResponseSchema = ga4TrafficSummaryDtoSchema.extend({
  /**
   * Inclusive start (YYYY-MM-DD) of the window EVERY figure in this response
   * was measured over — totals, channel counts, top pages, and every share
   * alike. `null` means the window is open on that side (all retained history).
   *
   * Read every share against this window. The share fields divide a channel
   * count by `totalSessions`; both come from these dates and only these dates.
   */
  windowStart: z.string().nullable(),
  /** Inclusive end (YYYY-MM-DD) of the measured window. `null` when open-ended. */
  windowEnd: z.string().nullable(),
  /**
   * Calendar days the measured window covers, counting both ends. `null` when
   * either bound is open — an unknown span is reported as unknown rather than
   * guessed.
   */
  windowDays: z.number().nullable(),
  /** Alias of `windowStart`, retained for callers that predate it. */
  periodStart: z.string().nullable(),
  /** Alias of `windowEnd`, retained for callers that predate it. */
  periodEnd: z.string().nullable(),
})
export type GaTrafficResponse = z.infer<typeof gaTrafficResponseSchema>

export interface GaCoverageResponse {
  pages: Array<{ landingPage: string; sessions: number; organicSessions: number; users: number }>
}

/**
 * One raw AI-referral cell: a single landing page, under a single attribution
 * dimension, on one date.
 *
 * These rows are DETAIL, not totals. A day of traffic from one source is many
 * of them, each commonly worth exactly 1 session, repeated across the three
 * overlapping `sourceDimension` lenses. Collapsing them with MAX undercounts
 * the day to a single page, and summing them across dimensions inflates it
 * roughly threefold. For any per-date or per-source AI session COUNT, read
 * `GET /ga/ai-referral-daily` (`GA4AiReferralDailyDto`), which applies the
 * conservation rule once, server side.
 */
export const ga4AiReferralHistoryEntrySchema = z.object({
  date: z.string(),
  source: z.string(),
  medium: z.string(),
  trafficClass: aiReferralTrafficClassSchema,
  landingPage: z.string(),
  sessions: z.number(),
  users: z.number(),
  /** Which GA4 dimension this row came from: session (sessionSource), first_user (firstUserSource), or manual_utm (utm_source parameter) */
  sourceDimension: ga4SourceDimensionSchema,
})
export type GA4AiReferralHistoryEntry = z.infer<typeof ga4AiReferralHistoryEntrySchema>

export const ga4AiReferralDailySourceSchema = z.object({
  source: z.string(),
  sessions: z.number(),
  paidSessions: z.number(),
  organicSessions: z.number(),
})
export type GA4AiReferralDailySource = z.infer<typeof ga4AiReferralDailySourceSchema>

export const ga4AiReferralDailyEntrySchema = z.object({
  date: z.string(),
  sessions: z.number(),
  paidSessions: z.number(),
  organicSessions: z.number(),
  /** Per-source split of the day. `sessions` is the sum of these. */
  bySource: z.array(ga4AiReferralDailySourceSchema),
})
export type GA4AiReferralDailyEntry = z.infer<typeof ga4AiReferralDailyEntrySchema>

/**
 * Per-date, per-source AI referral sessions for the trend chart.
 *
 * SESSIONS ONLY, deliberately, matching `aiReferralSectionSchema`. Sessions
 * obey the conservation rule for `ga_ai_referrals`: sum across landing pages
 * within ONE attribution dimension, never across dimensions. `totalSessions`
 * is the same quantity the traffic response reports as `aiSessionsDeduped` for
 * the same window, folded from the same winning-dimension set, so the chart
 * and the summary card cannot drift.
 *
 * A `users` count is deliberately absent and must not be added. GA reports
 * `totalUsers` as a COUNT DISTINCT at the grain it was asked for, and
 * `ga_ai_referrals` is keyed by (date, source, medium, channelGroup,
 * landingPage, sourceDimension), so users do not sum at ANY grain this DTO
 * serves: not per date, not per source, not per window. `fetchAiReferrals` is
 * always dimensioned and no un-dimensioned AI-referral fetch exists, so there
 * is nothing true to report. `ga_daily_totals` cannot stand in either, since
 * it is property-level across ALL traffic rather than AI-scoped or per-source.
 */
export const ga4AiReferralDailyDtoSchema = z.object({
  /** Ascending by date. Dates with no AI referrals are absent, not zero-filled. */
  days: z.array(ga4AiReferralDailyEntrySchema),
  /** Sources present in the window, ordered by total sessions descending. */
  sources: z.array(z.string()),
  totalSessions: z.number(),
  totalPaidSessions: z.number(),
  totalOrganicSessions: z.number(),
})
export type GA4AiReferralDailyDto = z.infer<typeof ga4AiReferralDailyDtoSchema>

export const ga4SocialReferralHistoryEntrySchema = z.object({
  date: z.string(),
  source: z.string(),
  medium: z.string(),
  sessions: z.number(),
  users: z.number(),
  /** GA4 default channel group (e.g. 'Organic Social', 'Paid Social') */
  channelGroup: z.string(),
})
export type GA4SocialReferralHistoryEntry = z.infer<typeof ga4SocialReferralHistoryEntrySchema>

export const ga4SessionHistoryEntrySchema = z.object({
  date: z.string(),
  sessions: z.number(),
  organicSessions: z.number(),
  /**
   * Unique visitors for the day. Deduplicated by GA when `usersSource` is
   * `deduplicated`; a landing-page sum (which overcounts multi-page visitors)
   * for days synced before per-day totals were captured.
   */
  users: z.number(),
  /**
   * How `users` was derived. `deduplicated` matches the GA UI's active users;
   * `landing-page-sum` is the legacy overcount kept so historical days still
   * render. Never compare the two across a series without saying which is which.
   */
  usersSource: z.enum(['deduplicated', 'landing-page-sum']),
})
export type GA4SessionHistoryEntry = z.infer<typeof ga4SessionHistoryEntrySchema>
