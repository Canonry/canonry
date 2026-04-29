import { z } from 'zod'

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
  sessions: z.number(),
  users: z.number(),
  sourceDimension: ga4SourceDimensionSchema,
})
export type GA4AiReferralDto = z.infer<typeof ga4AiReferralDtoSchema>

export const ga4SocialReferralDtoSchema = z.object({
  source: z.string(),
  medium: z.string(),
  sessions: z.number(),
  users: z.number(),
  /** GA4 default channel group (e.g. 'Organic Social', 'Paid Social') */
  channelGroup: z.string(),
})
export type GA4SocialReferralDto = z.infer<typeof ga4SocialReferralDtoSchema>

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
  /** Deduped AI session total: MAX(sessions) per date+source+medium across attribution dimensions, then summed. */
  aiSessionsDeduped: z.number(),
  /** Deduped AI user total: MAX(users) per date+source+medium across attribution dimensions, then summed. */
  aiUsersDeduped: z.number(),
  socialReferrals: z.array(ga4SocialReferralDtoSchema),
  /** Total social sessions (session-scoped, no cross-dimension dedup needed). */
  socialSessions: z.number(),
  /** Total social users (session-scoped, no cross-dimension dedup needed). */
  socialUsers: z.number(),
  /** Organic sessions as a percentage of total sessions (0–100, rounded). */
  organicSharePct: z.number(),
  /** Deduped AI sessions as a percentage of total sessions (0–100, rounded). */
  aiSharePct: z.number(),
  /** Direct-channel sessions as a percentage of total sessions (0–100, rounded). */
  directSharePct: z.number(),
  /** Social sessions as a percentage of total sessions (0–100, rounded). */
  socialSharePct: z.number(),
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

export interface GaStatusResponse {
  connected: boolean
  propertyId: string | null
  clientEmail: string | null
  authMethod: 'service-account' | 'oauth' | null
  lastSyncedAt: string | null
  createdAt?: string
  updatedAt?: string
}

export interface GaSyncResponse {
  synced: boolean
  rowCount: number
  aiReferralCount: number
  socialReferralCount: number
  days: number
  syncedAt: string
  /** Which data components were synced (present when --only is used) */
  syncedComponents?: string[]
}

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
  ai: GaChannelTrend
  social: GaChannelTrend
  total: GaChannelTrend
  /** AI source with largest absolute session change in 7d vs prev 7d */
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
  aiReferrals: Array<{ source: string; medium: string; sessions: number; users: number; sourceDimension: GA4SourceDimension }>
  /** Deduped AI session total: MAX(sessions) per date+source+medium across attribution dimensions, then summed. */
  aiSessionsDeduped: number
  /** Deduped AI user total: MAX(users) per date+source+medium across attribution dimensions, then summed. */
  aiUsersDeduped: number
  socialReferrals: Array<{ source: string; medium: string; sessions: number; users: number; channelGroup: string }>
  /** Total social sessions (session-scoped via sessionDefaultChannelGroup). */
  socialSessions: number
  /** Total social users (session-scoped via sessionDefaultChannelGroup). */
  socialUsers: number
  /** Organic sessions as a percentage of total sessions (0–100, rounded). */
  organicSharePct: number
  /** Deduped AI sessions as a percentage of total sessions (0–100, rounded). */
  aiSharePct: number
  /** Direct-channel sessions as a percentage of total sessions (0–100, rounded). */
  directSharePct: number
  /** Social sessions as a percentage of total sessions (0–100, rounded). */
  socialSharePct: number
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
  users: z.number(),
})
export type GA4SessionHistoryEntry = z.infer<typeof ga4SessionHistoryEntrySchema>
