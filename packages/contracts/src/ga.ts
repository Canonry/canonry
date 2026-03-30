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

export const ga4AiReferralDtoSchema = z.object({
  source: z.string(),
  medium: z.string(),
  sessions: z.number(),
  users: z.number(),
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
  lastSyncedAt: z.string().nullable(),
})
export type GA4TrafficSummaryDto = z.infer<typeof ga4TrafficSummaryDtoSchema>
