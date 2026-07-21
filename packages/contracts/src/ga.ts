import { z } from 'zod'
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
  users: z.number(),
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
  users: z.number(),
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
  sharePct: z.number(),
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
  totalUsers: z.number(),
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
  /** Deduped AI session total: MAX(sessions) per date+source+medium across attribution dimensions, then summed. Cross-cutting: can overlap with Direct/Organic/Social via firstUserSource. */
  aiSessionsDeduped: z.number(),
  /** Deduped AI user total: MAX(users) per date+source+medium across attribution dimensions, then summed. */
  aiUsersDeduped: z.number(),
  /** Deduped AI sessions whose attribution carries paid intent. */
  paidAiSessionsDeduped: z.number(),
  /** Deduped users for paid AI sessions. */
  paidAiUsersDeduped: z.number(),
  /** Deduped AI sessions without paid intent evidence. */
  organicAiSessionsDeduped: z.number(),
  /** Deduped users for organic/non-paid AI sessions. */
  organicAiUsersDeduped: z.number(),
  /** AI sessions whose CURRENT sessionSource matched an AI engine. Can overlap with raw Organic/Social/Direct totals; `channelBreakdown` removes those overlaps for display. */
  aiSessionsBySession: z.number(),
  /** AI users whose CURRENT sessionSource matched an AI engine. Can overlap with raw Organic/Social/Direct totals. */
  aiUsersBySession: z.number(),
  /** Session-source-only paid AI sessions. */
  paidAiSessionsBySession: z.number(),
  /** Session-source-only paid AI users. */
  paidAiUsersBySession: z.number(),
  /** Session-source-only organic/non-paid AI sessions. */
  organicAiSessionsBySession: z.number(),
  /** Session-source-only organic/non-paid AI users. */
  organicAiUsersBySession: z.number(),
  socialReferrals: z.array(ga4SocialReferralDtoSchema),
  /** Total social sessions (session-scoped, no cross-dimension dedup needed). */
  socialSessions: z.number(),
  /** Total social users (session-scoped, no cross-dimension dedup needed). */
  socialUsers: z.number(),
  /** Five disjoint buckets used for the channel breakdown. Known AI session-source matches are removed from their native GA4 bucket before shares are computed. */
  channelBreakdown: ga4ChannelBreakdownDtoSchema,
  /** Organic sessions as a percentage of total sessions (0–100, rounded). */
  organicSharePct: z.number(),
  /** Deduped AI sessions as a percentage of total sessions (0–100, rounded). Cross-cutting: can overlap with Direct/Organic/Social. */
  aiSharePct: z.number(),
  /** Session-source-only AI sessions as a percentage of total sessions (0–100, rounded). Can overlap with raw Organic/Social/Direct totals. */
  aiSharePctBySession: z.number(),
  /** Paid AI sessions as a percentage of total sessions (0–100, rounded). */
  paidAiSharePct: z.number(),
  /** Session-source paid AI sessions as a percentage of total sessions (0–100, rounded). */
  paidAiSharePctBySession: z.number(),
  /** Organic/non-paid AI sessions as a percentage of total sessions (0–100, rounded). */
  organicAiSharePct: z.number(),
  /** Session-source organic/non-paid AI sessions as a percentage of total sessions (0–100, rounded). */
  organicAiSharePctBySession: z.number(),
  /** Direct-channel sessions as a percentage of total sessions (0–100, rounded). */
  directSharePct: z.number(),
  /** Social sessions as a percentage of total sessions (0–100, rounded). */
  socialSharePct: z.number(),
  /** Display string for organicSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  organicSharePctDisplay: z.string(),
  /** Display string for aiSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctDisplay: z.string(),
  /** Display string for aiSharePctBySession: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctBySessionDisplay: z.string(),
  /** Display string for paidAiSharePct. */
  paidAiSharePctDisplay: z.string(),
  /** Display string for paidAiSharePctBySession. */
  paidAiSharePctBySessionDisplay: z.string(),
  /** Display string for organicAiSharePct. */
  organicAiSharePctDisplay: z.string(),
  /** Display string for organicAiSharePctBySession. */
  organicAiSharePctBySessionDisplay: z.string(),
  /** Display string for directSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  directSharePctDisplay: z.string(),
  /** Display string for socialSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  socialSharePctDisplay: z.string(),
  /** Sessions not covered by Organic, Social, Direct, or AI (session) channels — e.g. Referral, Email, Paid Search, Display. Always non-negative; clamped to 0 when the four disjoint channels sum above total (rounding edge). */
  otherSessions: z.number(),
  /** Other sessions as a percentage of total sessions (0–100, rounded). */
  otherSharePct: z.number(),
  /** Display string for otherSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
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
 * Response shape for `POST /projects/:name/ga/sync`. `syncedComponents`
 * is present only when the request specified an `only` filter (`'traffic' |
 * 'ai' | 'social'`).
 */
export const ga4SyncResponseDtoSchema = z.object({
  synced: z.boolean(),
  rowCount: z.number().int().nonnegative(),
  aiReferralCount: z.number().int().nonnegative(),
  socialReferralCount: z.number().int().nonnegative(),
  days: z.number().int().nonnegative(),
  syncedAt: z.string(),
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
  totalUsers: number
  topPages: Array<{ landingPage: string; sessions: number; organicSessions: number; directSessions: number; users: number }>
  /** Deduped to the winning attribution dimension (highest sessions) per (source, medium). */
  aiReferrals: Array<{ source: string; medium: string; trafficClass: AiReferralTrafficClass; sessions: number; users: number; sourceDimension: GA4SourceDimension }>
  /** Deduped to the winning attribution dimension (highest sessions) per (source, medium, landingPage). */
  aiReferralLandingPages: Array<{ source: string; medium: string; trafficClass: AiReferralTrafficClass; sourceDimension: GA4SourceDimension; landingPage: string; sessions: number; users: number }>
  /** Deduped AI session total: MAX(sessions) per date+source+medium across attribution dimensions, then summed. Cross-cutting: can overlap with Direct/Organic/Social via firstUserSource. */
  aiSessionsDeduped: number
  /** Deduped AI user total: MAX(users) per date+source+medium across attribution dimensions, then summed. */
  aiUsersDeduped: number
  /** Deduped AI sessions whose attribution carries paid intent. */
  paidAiSessionsDeduped: number
  /** Deduped users for paid AI sessions. */
  paidAiUsersDeduped: number
  /** Deduped AI sessions without paid intent evidence. */
  organicAiSessionsDeduped: number
  /** Deduped users for organic/non-paid AI sessions. */
  organicAiUsersDeduped: number
  /** AI sessions whose CURRENT sessionSource matched an AI engine. Can overlap with raw Organic/Social/Direct totals; `channelBreakdown` removes those overlaps for display. */
  aiSessionsBySession: number
  /** AI users whose CURRENT sessionSource matched an AI engine. Can overlap with raw Organic/Social/Direct totals. */
  aiUsersBySession: number
  /** Session-source-only paid AI sessions. */
  paidAiSessionsBySession: number
  /** Session-source-only paid AI users. */
  paidAiUsersBySession: number
  /** Session-source-only organic/non-paid AI sessions. */
  organicAiSessionsBySession: number
  /** Session-source-only organic/non-paid AI users. */
  organicAiUsersBySession: number
  socialReferrals: Array<{ source: string; medium: string; sessions: number; users: number; channelGroup: string }>
  /** Total social sessions (session-scoped via sessionDefaultChannelGroup). */
  socialSessions: number
  /** Total social users (session-scoped via sessionDefaultChannelGroup). */
  socialUsers: number
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
  /** Display string for organicSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  organicSharePctDisplay: string
  /** Display string for aiSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctDisplay: string
  /** Display string for aiSharePctBySession: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctBySessionDisplay: string
  /** Display string for paidAiSharePct. */
  paidAiSharePctDisplay: string
  /** Display string for paidAiSharePctBySession. */
  paidAiSharePctBySessionDisplay: string
  /** Display string for organicAiSharePct. */
  organicAiSharePctDisplay: string
  /** Display string for organicAiSharePctBySession. */
  organicAiSharePctBySessionDisplay: string
  /** Display string for directSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  directSharePctDisplay: string
  /** Display string for socialSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  socialSharePctDisplay: string
  /** Sessions not covered by Organic, Social, Direct, or AI (session) channels — e.g. Referral, Email, Paid Search, Display. Always non-negative; clamped to 0 when the four disjoint channels sum above total (rounding edge). */
  otherSessions: number
  /** Other sessions as a percentage of total sessions (0–100, rounded). */
  otherSharePct: number
  /** Display string for otherSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  otherSharePctDisplay: string
  lastSyncedAt: string | null
  /** Start of the synced date range (YYYY-MM-DD), null if no data. */
  periodStart: string | null
  /** End of the synced date range (YYYY-MM-DD), null if no data. */
  periodEnd: string | null
}

export interface GaCoverageResponse {
  pages: Array<{ landingPage: string; sessions: number; organicSessions: number; users: number }>
}

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
