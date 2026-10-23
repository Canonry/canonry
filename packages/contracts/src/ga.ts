import { metricsWindowSchema } from './analytics.js'
import { gaMeasurementComponentStatusSchema } from './measurement.js'

import { WINDOW_SETS } from './time-window.js'
import { z } from 'zod'
import { fraction, percent, RatioUnits } from './ratio-unit.js'
import { formatDurationSeconds, formatNumber, formatPercent, shiftIsoCalendarDate } from './formatting.js'
import { aiReferralTrafficClassSchema } from './traffic-class.js'
import { aiReferralEngineSchema } from './ai-referral-engine.js'
import { socialPlatformSchema } from './social-platform.js'
import { stackedDailySeriesSchema } from './stacked-series.js'

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

/**
 * One social platform's sessions in the window, with the `socialReferrals`
 * rows it groups. A source no platform matches is its own group, so the
 * groups partition `socialSessions`.
 */
export const ga4SocialPlatformDtoSchema = z.object({
  /** Platform id from `socialPlatformForReferralSource`; null for a source no platform matches. */
  platform: socialPlatformSchema.nullable(),
  /** The platform's name, or the raw source when `platform` is null. */
  label: z.string(),
  sessions: z.number(),
  /** Sessions outside GA4's Paid Social channel group. */
  organicSessions: z.number(),
  /** Sessions in GA4's Paid Social channel group. */
  paidSessions: z.number(),
  /** 0..1 share of `socialSessions`; the groups' shares add up to 1. */
  share: fraction(),
  /** The grouped `socialReferrals` rows, sessions descending. */
  sources: z.array(ga4SocialReferralDtoSchema),
})
export type GA4SocialPlatformDto = z.infer<typeof ga4SocialPlatformDtoSchema>

/**
 * One AI engine's referral sessions, with the `aiReferrals` rows it groups.
 * Rows whose source names no engine form one group with `engine: null`: AI
 * traffic that is counted but never assigned to an engine.
 */
export const ga4AiEngineReferralDtoSchema = z.object({
  /** Engine id from `aiEngineForReferralSource`; null for the unattributed group. */
  engine: aiReferralEngineSchema.nullable(),
  /** The engine's name, or `Unattributed AI`. */
  label: z.string(),
  sessions: z.number(),
  organicSessions: z.number(),
  paidSessions: z.number(),
  /** 0..1 share of the `aiReferrals` rows' sessions, the same base as each row's `share`. */
  share: fraction(),
  /** The grouped `aiReferrals` rows, sessions descending. */
  sources: z.array(ga4AiReferralDtoSchema),
})
export type GA4AiEngineReferralDto = z.infer<typeof ga4AiEngineReferralDtoSchema>

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
  /**
   * `aiReferrals` grouped by engine, sessions descending, with the unattributed
   * group last. The groups' sessions add up to the rows' sessions.
   */
  aiEngines: z.array(ga4AiEngineReferralDtoSchema),
  socialReferrals: z.array(ga4SocialReferralDtoSchema),
  /** `socialReferrals` grouped by platform, sessions descending; the groups' sessions add up to `socialSessions`. */
  socialPlatforms: z.array(ga4SocialPlatformDtoSchema),
  /**
   * Daily social sessions by platform over the same window as every other
   * figure here: the five largest platforms, then the rest as `other`.
   */
  socialPlatformDaily: stackedDailySeriesSchema,
  /** Total social sessions (session-scoped, no cross-dimension dedup needed). */
  socialSessions: z.number(),
  /** Social sessions in GA4's Paid Social channel group. */
  paidSocialSessions: z.number(),
  /** `paidSocialSessions` as a 0..1 share of `socialSessions`; 0 with no social sessions. */
  paidSocialShare: fraction(),
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
export const gaSearchLandingWindowSchema = z.enum(WINDOW_SETS.gaSearchLanding)
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
 * The figures of the GA4 overview (`GET /projects/:name/ga/overview`), for a
 * whole window or for one day. Each is GA4's own metric of that name, except
 * `organicSessions` (GA4 `sessions` in the Organic Search channel) and
 * `averageEngagementTimeSeconds` (GA4's `userEngagementDuration / activeUsers`,
 * which is how GA4 defines "Average engagement time").
 *
 * Window figures are GA4's totals for the window, so users are distinct over
 * the whole window and the rates are GA4's own; they are never sums of days.
 * Null means GA4 has not reported the figure for that span (never synced, or
 * synced before the metric was added), never a measured zero.
 */
export const gaOverviewValuesSchema = z.object({
  activeUsers: z.number().int().nonnegative().nullable(),
  newUsers: z.number().int().nonnegative().nullable(),
  totalUsers: z.number().int().nonnegative().nullable(),
  sessions: z.number().int().nonnegative().nullable(),
  organicSessions: z.number().int().nonnegative().nullable(),
  views: z.number().int().nonnegative().nullable(),
  eventCount: z.number().int().nonnegative().nullable(),
  /** GA4 counts a key event once per session when the property says so, so this can be a decimal. */
  keyEvents: z.number().nonnegative().nullable(),
  engagementRate: fraction().nullable(),
  bounceRate: fraction().nullable(),
  averageEngagementTimeSeconds: z.number().nonnegative().nullable(),
})
export type GaOverviewValues = z.infer<typeof gaOverviewValuesSchema>

export const gaOverviewMetricKeySchema = gaOverviewValuesSchema.keyof()
export type GaOverviewMetricKey = z.infer<typeof gaOverviewMetricKeySchema>
export const GaOverviewMetricKeys = gaOverviewMetricKeySchema.enum

/** Signed percent change of each window figure against the previous period, as GA4 shows it. */
export const gaOverviewChangeSchema = z.object({
  activeUsers: percent().nullable(),
  newUsers: percent().nullable(),
  totalUsers: percent().nullable(),
  sessions: percent().nullable(),
  organicSessions: percent().nullable(),
  views: percent().nullable(),
  eventCount: percent().nullable(),
  keyEvents: percent().nullable(),
  engagementRate: percent().nullable(),
  bounceRate: percent().nullable(),
  averageEngagementTimeSeconds: percent().nullable(),
})
export type GaOverviewChange = z.infer<typeof gaOverviewChangeSchema>

/** The overview windows, in days. */
export const GA_OVERVIEW_WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const
export type GaOverviewWindow = keyof typeof GA_OVERVIEW_WINDOW_DAYS
export const GA_OVERVIEW_WINDOWS: readonly GaOverviewWindow[] = WINDOW_SETS.gaOverview

export function isGaOverviewWindow(value: unknown): value is GaOverviewWindow {
  return GA_OVERVIEW_WINDOWS.some((window) => window === value)
}

/**
 * Days of GA4 daily totals a sync keeps: the longest window and the period of
 * the same length before it.
 */
export const GA_OVERVIEW_HISTORY_DAYS = 2 * GA_OVERVIEW_WINDOW_DAYS['90d']

/**
 * A window and the period of the same length just before it, inclusive UTC
 * dates, as GA4 draws them: "Last 30 days" is the 30 complete days ending
 * yesterday (today is still filling), and the previous period is the 30 days
 * before. The sync asks GA4 for exactly these ranges.
 */
export function gaOverviewComparisonRanges(
  window: GaOverviewWindow,
  now: Date = new Date(),
): { current: { startDate: string; endDate: string }; previous: { startDate: string; endDate: string } } {
  const days = GA_OVERVIEW_WINDOW_DAYS[window]
  const today = now.toISOString().slice(0, 10)
  return {
    current: { startDate: shiftIsoCalendarDate(today, -days), endDate: shiftIsoCalendarDate(today, -1) },
    previous: { startDate: shiftIsoCalendarDate(today, -2 * days), endDate: shiftIsoCalendarDate(today, -days - 1) },
  }
}

/** The two periods the overview compares, as stored in `ga_window_metrics.period`. */
export const GaOverviewPeriods = { current: 'current', previous: 'previous' } as const
export type GaOverviewPeriod = typeof GaOverviewPeriods[keyof typeof GaOverviewPeriods]

const gaOverviewPeriodSchema = z.object({
  /** Inclusive. Null when the window has never been synced with the overview metrics. */
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
})

export const gaOverviewDaySchema = z.object({
  date: z.string(),
  /** The day of the previous period in the same position: the window's first day lines up with its first. */
  previousDate: z.string(),
  values: gaOverviewValuesSchema,
  previousValues: gaOverviewValuesSchema,
})
export type GaOverviewDay = z.infer<typeof gaOverviewDaySchema>

export const gaOverviewResponseSchema = z.object({
  window: metricsWindowSchema,
  current: gaOverviewPeriodSchema,
  /** The period just before `current`, of the same length. */
  previous: gaOverviewPeriodSchema,
  totals: gaOverviewValuesSchema,
  previousTotals: gaOverviewValuesSchema,
  /**
   * `deltaPercent(totals[key], previousTotals[key])`: relative for rates too
   * (55% to 60% engagement reads +9.1), as GA4 shows it. Null when either total
   * is missing or the previous one is not positive.
   */
  changePct: gaOverviewChangeSchema,
  /** One entry per day of `current`, oldest first. */
  days: z.array(gaOverviewDaySchema),
  /** When GA4 last reported this window's totals. Null when it never has. */
  syncedAt: z.string().nullable(),
})
export type GaOverviewResponse = z.infer<typeof gaOverviewResponseSchema>

export const GaOverviewUnits = { count: 'count', fraction: 'fraction', seconds: 'seconds' } as const
export type GaOverviewUnit = typeof GaOverviewUnits[keyof typeof GaOverviewUnits]

/** Which direction of change reads as an improvement. */
export const GaOverviewBetter = { higher: 'higher', lower: 'lower' } as const
export type GaOverviewBetter = typeof GaOverviewBetter[keyof typeof GaOverviewBetter]

/**
 * How each overview figure is named and read, shared by the dashboard and the
 * CLI. `better` is the direction GA4 users read as an improvement: a falling
 * bounce rate is good news, so its colour follows `better`, not the sign.
 */
export const GA_OVERVIEW_METRICS: Record<GaOverviewMetricKey, { label: string; unit: GaOverviewUnit; better: GaOverviewBetter }> = {
  activeUsers: { label: 'Users', unit: GaOverviewUnits.count, better: GaOverviewBetter.higher },
  newUsers: { label: 'New users', unit: GaOverviewUnits.count, better: GaOverviewBetter.higher },
  sessions: { label: 'Sessions', unit: GaOverviewUnits.count, better: GaOverviewBetter.higher },
  engagementRate: { label: 'Engagement rate', unit: GaOverviewUnits.fraction, better: GaOverviewBetter.higher },
  averageEngagementTimeSeconds: { label: 'Average engagement time', unit: GaOverviewUnits.seconds, better: GaOverviewBetter.higher },
  views: { label: 'Views', unit: GaOverviewUnits.count, better: GaOverviewBetter.higher },
  bounceRate: { label: 'Bounce rate', unit: GaOverviewUnits.fraction, better: GaOverviewBetter.lower },
  eventCount: { label: 'Event count', unit: GaOverviewUnits.count, better: GaOverviewBetter.higher },
  keyEvents: { label: 'Key events', unit: GaOverviewUnits.count, better: GaOverviewBetter.higher },
  organicSessions: { label: 'Organic sessions', unit: GaOverviewUnits.count, better: GaOverviewBetter.higher },
  totalUsers: { label: 'Total users', unit: GaOverviewUnits.count, better: GaOverviewBetter.higher },
}

/** The order the figures are listed in, GA4's home card order first. */
export const GA_OVERVIEW_METRIC_ORDER: readonly GaOverviewMetricKey[] = [
  'activeUsers',
  'newUsers',
  'sessions',
  'engagementRate',
  'averageEngagementTimeSeconds',
  'views',
  'bounceRate',
  'eventCount',
  'keyEvents',
  'organicSessions',
  'totalUsers',
]

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
  /**
   * The same days by AI engine: the five largest engines (the unattributed
   * group counts as one), then the rest as `other`. Folded from the same
   * winner set as `days`, so each day's values add up to that day's sessions.
   */
  byEngine: stackedDailySeriesSchema,
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


export const gaAcquisitionDimensionSchema = z.enum(['date', 'channelGroup', 'source', 'medium', 'hostName', 'landingPage'])
export type GaAcquisitionDimension = z.infer<typeof gaAcquisitionDimensionSchema>
export const GaAcquisitionDimensions = gaAcquisitionDimensionSchema.enum
export const gaAcquisitionQuerySchema = z.object({
  window: metricsWindowSchema.optional(), startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
  channel: z.string().optional(), source: z.string().optional(), medium: z.string().optional(), hostName: z.string().optional(),
  landingPage: z.string().optional(), pathPrefix: z.string().optional(),
  groupBy: z.string().refine(value => value.split(',').every(key => gaAcquisitionDimensionSchema.safeParse(key.trim()).success), `groupBy must contain: ${gaAcquisitionDimensionSchema.options.join(', ')}`).optional(),
  limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().nonnegative().optional(),
}).strict()
export type GaAcquisitionQuery = z.infer<typeof gaAcquisitionQuerySchema>
export const gaAcquisitionRowSchema = z.object({
  date: z.string().optional(), channelGroup: z.string().optional(), source: z.string().optional(), medium: z.string().optional(),
  hostName: z.string().optional(), landingPage: z.string().optional(), sessions: z.number().int().nonnegative(),
})
export type GaAcquisitionRow = z.infer<typeof gaAcquisitionRowSchema>
export const gaAcquisitionResponseSchema = z.object({
  source: z.literal('ga4-acquisition'), status: gaMeasurementComponentStatusSchema, error: z.string().nullable(), syncedAt: z.string().nullable(),
  scope: z.object({ project: z.string(), attribution: z.literal('project-only'), unavailableDimensions: z.array(z.enum(['property', 'target', 'market'])) }),
  window: z.object({ startDate: z.string().nullable(), endDate: z.string().nullable(), window: metricsWindowSchema }),
  coverage: z.object({ earliestDate: z.string().nullable(), latestDate: z.string().nullable() }),
  filters: z.object({ channel: z.string().nullable(), source: z.string().nullable(), medium: z.string().nullable(), hostName: z.string().nullable(), landingPage: z.string().nullable(), pathPrefix: z.string().nullable() }),
  groupBy: z.array(gaAcquisitionDimensionSchema), channelGroups: z.array(z.string()),
  totalSessions: z.number().int().nonnegative(), totalRows: z.number().int().nonnegative(), limit: z.number().int(), offset: z.number().int(), rows: z.array(gaAcquisitionRowSchema),
})
export type GaAcquisitionResponse = z.infer<typeof gaAcquisitionResponseSchema>

/**
 * One overview figure as the dashboard and the CLI print it: rates as
 * percents, engagement time as `1m 05s`, counts in full or, with `compact`,
 * as `3.4K`. A null figure reads `—`.
 */
export function formatGaOverviewValue(key: GaOverviewMetricKey, value: number | null, options: { compact?: boolean } = {}): string {
  if (value === null) return '—'
  const unit = GA_OVERVIEW_METRICS[key].unit
  if (unit === GaOverviewUnits.fraction) return formatPercent(value, RatioUnits.fraction)
  if (unit === GaOverviewUnits.seconds) return formatDurationSeconds(value)
  if (options.compact) return formatNumber(value)
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

export const GaOverviewChangeTones = { better: 'better', worse: 'worse', flat: 'flat' } as const
export type GaOverviewChangeTone = typeof GaOverviewChangeTones[keyof typeof GaOverviewChangeTones]

/**
 * Whether a change is good news for its figure, from `better`: a rise in
 * sessions and a fall in bounce rate both read `better`. Null with no change
 * to judge.
 */
export function gaOverviewChangeTone(key: GaOverviewMetricKey, changePct: number | null): GaOverviewChangeTone | null {
  if (changePct === null) return null
  if (changePct === 0) return GaOverviewChangeTones.flat
  const rose = changePct > 0
  return (GA_OVERVIEW_METRICS[key].better === GaOverviewBetter.higher) === rose ? GaOverviewChangeTones.better : GaOverviewChangeTones.worse
}
