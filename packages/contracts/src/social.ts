import { z } from 'zod'

/** Known social platform identifiers */
export const SOCIAL_PLATFORM_NAMES = ['reddit'] as const
export const socialPlatformNameSchema = z.enum(SOCIAL_PLATFORM_NAMES)
export type SocialPlatformName = z.infer<typeof socialPlatformNameSchema>

export const socialQuotaPolicySchema = z.object({
  maxRequestsPerMinute: z.number().int().positive(),
  maxRequestsPerDay: z.number().int().positive(),
})
export type SocialQuotaPolicy = z.infer<typeof socialQuotaPolicySchema>

/** A single social mention returned by an adapter */
export interface SocialMention {
  /** Platform that produced this mention */
  platform: SocialPlatformName
  /** Unique identifier on the source platform (used for deduplication) */
  externalId: string
  /** URL to the original post / comment */
  url: string
  /** Author handle or username */
  author: string
  /** Post or comment body */
  content: string
  /** Post title (for Reddit posts; empty for comments) */
  title?: string
  /** ISO-8601 timestamp of the original post */
  postedAt: string
  /** Raw JSON from the platform API (for debugging / future enrichment) */
  raw?: Record<string, unknown>
}

/** Input passed to every platform adapter */
export interface SocialSearchInput {
  /** Project keywords to search for */
  keywords: string[]
  /** Canonical and owned domains of the project */
  domains: string[]
}

export interface SocialPlatformAdapter {
  name: SocialPlatformName
  searchMentions(input: SocialSearchInput, quotaPolicy: SocialQuotaPolicy): Promise<SocialMention[]>
}

/** DTO returned by the API for a social mention */
export const socialMentionDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  platform: socialPlatformNameSchema,
  externalId: z.string(),
  url: z.string(),
  author: z.string(),
  title: z.string().nullable().optional(),
  content: z.string(),
  postedAt: z.string(),
  createdAt: z.string(),
})
export type SocialMentionDto = z.infer<typeof socialMentionDtoSchema>
