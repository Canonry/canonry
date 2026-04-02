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

export const ga4TrafficSummaryDtoSchema = z.object({
  totalSessions: z.number(),
  totalOrganicSessions: z.number(),
  totalUsers: z.number(),
  topPages: z.array(z.object({
    landingPage: z.string(),
    sessions: z.number(),
    organicSessions: z.number(),
    users: z.number(),
  })),
  aiReferrals: z.array(ga4AiReferralDtoSchema),
  /** Deduped AI session total: MAX(sessions) per date+source+medium across attribution dimensions, then summed. */
  aiSessionsDeduped: z.number(),
  /** Deduped AI user total: MAX(users) per date+source+medium across attribution dimensions, then summed. */
  aiUsersDeduped: z.number(),
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
  days: number
  syncedAt: string
}

export interface GaTrafficResponse {
  totalSessions: number
  totalOrganicSessions: number
  totalUsers: number
  topPages: Array<{ landingPage: string; sessions: number; organicSessions: number; users: number }>
  aiReferrals: Array<{ source: string; medium: string; sessions: number; users: number; sourceDimension: GA4SourceDimension }>
  /** Deduped AI session total: MAX(sessions) per date+source+medium across attribution dimensions, then summed. */
  aiSessionsDeduped: number
  /** Deduped AI user total: MAX(users) per date+source+medium across attribution dimensions, then summed. */
  aiUsersDeduped: number
  lastSyncedAt: string | null
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

export const ga4SessionHistoryEntrySchema = z.object({
  date: z.string(),
  sessions: z.number(),
  organicSessions: z.number(),
  users: z.number(),
})
export type GA4SessionHistoryEntry = z.infer<typeof ga4SessionHistoryEntrySchema>
