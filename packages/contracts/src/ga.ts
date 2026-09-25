import { z } from 'zod'
import { percent } from './ratio-unit.js'
import type { AiReferralTrafficClass } from './traffic-class.js'
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
  users: z.number(),
  /** GA4 default channel group (e.g. 'Organic Social', 'Paid Social') */
  channelGroup: z.string(),
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
  /** Organic sessions as a percentage of total sessions (0–100, rounded). */
  organicSharePct: percent(),
  /** Deduped AI sessions as a percentage of total sessions (0–100, rounded). Cross-cutting: can overlap with Direct/Organic/Social. */
  aiSharePct: percent(),
  /** Session-source-only AI sessions as a percentage of total sessions (0–100, rounded). Can overlap with raw Organic/Social/Direct totals. */
  aiSharePctBySession: percent(),
  /** Paid AI sessions as a percentage of total sessions (0–100, rounded). */
  paidAiSharePct: percent(),
  /** Session-source paid AI sessions as a percentage of total sessions (0–100, rounded). */
  paidAiSharePctBySession: percent(),
  /** Organic/non-paid AI sessions as a percentage of total sessions (0–100, rounded). */
  organicAiSharePct: percent(),
  /** Session-source organic/non-paid AI sessions as a percentage of total sessions (0–100, rounded). */
  organicAiSharePctBySession: percent(),
  /** Direct-channel sessions as a percentage of total sessions (0–100, rounded). */
  directSharePct: percent(),
  /** Social sessions as a percentage of total sessions (0–100, rounded). */
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
  /** Other sessions as a percentage of total sessions (0–100, rounded). */
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
 * Response shape for `POST /projects/:name/ga/sync`. `syncedComponents`
 * is present only when the request specified an `only` filter (`'traffic' |
 * 'ai' | 'social'`).
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
  }),
  /**
   * Components that were written this run. Present when `only` is set.
   * Always includes `traffic` and `summary` (the share denominator) plus
   * the requested channel breakdown — `ai` and/or `social`.
   */
  syncedComponents: z.array(z.string()).optional(),
})
export type GA4SyncResponseDto = z.infer<typeof ga4SyncResponseDtoSchema>
/** Legacy alias retained for callers that still import `GaSyncResponse`. */
export type GaSyncResponse = GA4SyncResponseDto

export interface GaSocialReferralTrendResponse {
  socialSessions7d: number
  socialSessionsPrev7d: number
  trend7dPct: number | null
  socialSessions30d: number
  socialSessionsPrev30d: number
  trend30dPct: number | null
  biggestMover: { source: string; sessions7d: number; sessionsPrev7d: number; changePct: number } | null
}

export interface GaChannelTrend {
  sessions7d: number
  sessionsPrev7d: number
  trend7dPct: number | null
  sessions30d: number
  sessionsPrev30d: number
  trend30dPct: number | null
}

export interface GaAttributionTrendResponse {
  organic: GaChannelTrend
  /** AI session trend, scoped to sessionSource-only matches so it lines up with the disjoint AI cell in the channel breakdown. */
  ai: GaChannelTrend
  social: GaChannelTrend
  direct: GaChannelTrend
  total: GaChannelTrend
  /** AI source with largest absolute session change in 7d vs prev 7d (sessionSource only). */
  aiBiggestMover: { source: string; sessions7d: number; sessionsPrev7d: number; changePct: number } | null
  /** Social source with largest absolute session change in 7d vs prev 7d */
  socialBiggestMover: { source: string; sessions7d: number; sessionsPrev7d: number; changePct: number } | null
}

export interface GaTrafficResponse {
  totalSessions: number
  totalOrganicSessions: number
  /** Direct-channel sessions (sessions with no source — bookmarks, typed URLs, AI-driven traffic with stripped referrer). 0 for legacy rows from before the column was added. */
  totalDirectSessions: number
  /** Deduplicated users, or null when no stored un-dimensioned aggregate covers the complete selected range. */
  totalUsers: number | null
  topPages: Array<{ landingPage: string; sessions: number; organicSessions: number; directSessions: number; users: number }>
  /** Deduped to the winning attribution dimension (highest sessions) per (source, medium). `users` is deprecated — see `GA4AiReferralDto.users`; never emitted since 4.135.0. */
  aiReferrals: Array<{ source: string; medium: string; trafficClass: AiReferralTrafficClass; sessions: number; users?: number; sourceDimension: GA4SourceDimension }>
  /** Deduped to the winning attribution dimension (highest sessions) per (source, medium, landingPage). `users` is deprecated — see `GA4AiReferralDto.users`; never emitted since 4.135.0. */
  aiReferralLandingPages: Array<{ source: string; medium: string; trafficClass: AiReferralTrafficClass; sourceDimension: GA4SourceDimension; landingPage: string; sessions: number; users?: number }>
  /** Deduped AI session total: MAX(sessions) per date+source across attribution dimensions, then summed. Cross-cutting: can overlap with Direct/Organic/Social via firstUserSource. */
  aiSessionsDeduped: number
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  aiUsersDeduped?: number
  /** Deduped AI sessions whose attribution carries paid intent. */
  paidAiSessionsDeduped: number
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  paidAiUsersDeduped?: number
  /** Deduped AI sessions without paid intent evidence. */
  organicAiSessionsDeduped: number
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  organicAiUsersDeduped?: number
  /** AI sessions whose CURRENT sessionSource matched an AI engine. Can overlap with raw Organic/Social/Direct totals; `channelBreakdown` removes those overlaps for display. */
  aiSessionsBySession: number
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  aiUsersBySession?: number
  /** Session-source-only paid AI sessions. */
  paidAiSessionsBySession: number
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  paidAiUsersBySession?: number
  /** Session-source-only organic/non-paid AI sessions. */
  organicAiSessionsBySession: number
  /** @deprecated See `GA4AiReferralDto.users`. Never emitted since 4.135.0. */
  organicAiUsersBySession?: number
  socialReferrals: Array<{ source: string; medium: string; sessions: number; users?: number; channelGroup: string }>
  /** Total social sessions (session-scoped via sessionDefaultChannelGroup). */
  socialSessions: number
  /**
   * @deprecated Never emitted. ga_social_referrals stores users as GA's COUNT
   * DISTINCT at (date, source, medium, channel group), so summing it across a
   * window counts a returning visitor once per day. Same reasoning that
   * withdrew `GA4AiReferralDto.users` in 4.135.0.
   */
  socialUsers?: number
  /** Five disjoint buckets used for the channel breakdown. Known AI session-source matches are removed from their native GA4 bucket before shares are computed. */
  channelBreakdown: {
    organic: GA4ChannelBucketDto
    social: GA4ChannelBucketDto
    direct: GA4ChannelBucketDto
    ai: GA4ChannelBucketDto
    other: GA4ChannelBucketDto
  }
  /** Organic sessions as a percentage of total sessions (0–100, rounded). */
  organicSharePct: number
  /** Deduped AI sessions as a percentage of total sessions (0–100, rounded). Cross-cutting: can overlap with Direct/Organic/Social. */
  aiSharePct: number
  /** Session-source-only AI sessions as a percentage of total sessions (0–100, rounded). Can overlap with raw Organic/Social/Direct totals. */
  aiSharePctBySession: number
  /** Paid AI sessions as a percentage of total sessions (0–100, rounded). */
  paidAiSharePct: number
  /** Session-source paid AI sessions as a percentage of total sessions (0–100, rounded). */
  paidAiSharePctBySession: number
  /** Organic/non-paid AI sessions as a percentage of total sessions (0–100, rounded). */
  organicAiSharePct: number
  /** Session-source organic/non-paid AI sessions as a percentage of total sessions (0–100, rounded). */
  organicAiSharePctBySession: number
  /** Direct-channel sessions as a percentage of total sessions (0–100, rounded). */
  directSharePct: number
  /** Social sessions as a percentage of total sessions (0–100, rounded). */
  socialSharePct: number
  /** Display string for organicSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  organicSharePctDisplay: string
  /** Display string for aiSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctDisplay: string
  /** Display string for aiSharePctBySession: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctBySessionDisplay: string
  /** Display string for paidAiSharePct. */
  paidAiSharePctDisplay: string
  /** Display string for paidAiSharePctBySession. */
  paidAiSharePctBySessionDisplay: string
  /** Display string for organicAiSharePct. */
  organicAiSharePctDisplay: string
  /** Display string for organicAiSharePctBySession. */
  organicAiSharePctBySessionDisplay: string
  /** Display string for directSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  directSharePctDisplay: string
  /** Display string for socialSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  socialSharePctDisplay: string
  /** Sessions not covered by Organic, Social, Direct, or AI (session) channels — e.g. Referral, Email, Paid Search, Display. Always non-negative; clamped to 0 when the four disjoint channels sum above total (rounding edge). */
  otherSessions: number
  /** Other sessions as a percentage of total sessions (0–100, rounded). */
  otherSharePct: number
  /** Display string for otherSharePct: the unrounded share through formatPercent ('12.5%', '<0.1%' for a non-zero share below one decimal), '0%' with no sessions, or '—' when sessions exist but total is unknown (partial sync). */
  otherSharePctDisplay: string
  lastSyncedAt: string | null
  /**
   * Inclusive start (YYYY-MM-DD) of the window EVERY figure in this response
   * was measured over — totals, channel counts, top pages, and every share
   * alike. `null` means the window is open on that side (all retained history).
   *
   * Read every share against this window. The share fields divide a channel
   * count by `totalSessions`; both come from these dates and only these dates.
   */
  windowStart: string | null
  /** Inclusive end (YYYY-MM-DD) of the measured window. `null` when open-ended. */
  windowEnd: string | null
  /**
   * Calendar days the measured window covers, counting both ends. `null` when
   * either bound is open — an unknown span is reported as unknown rather than
   * guessed.
   */
  windowDays: number | null
  /** Alias of `windowStart`, retained for callers that predate it. */
  periodStart: string | null
  /** Alias of `windowEnd`, retained for callers that predate it. */
  periodEnd: string | null
}

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
