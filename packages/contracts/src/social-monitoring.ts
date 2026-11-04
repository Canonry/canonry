import { z } from 'zod'

/**
 * The platforms Canonry can search for posts about a project (social
 * monitoring, run kind `social-monitor`).
 *
 * Not the same list as `socialPlatformSchema` in `social-platform.ts`: that one
 * groups GA4 social referral sources (traffic that arrived from a platform).
 * This one names the platforms a monitoring adapter queries. The ids that
 * overlap are spelled the same, so X is `x`, never `twitter`.
 */
export const socialMonitorPlatformSchema = z.enum(['x', 'reddit', 'linkedin'])
export type SocialMonitorPlatform = z.infer<typeof socialMonitorPlatformSchema>
export const SocialMonitorPlatforms = socialMonitorPlatformSchema.enum

export const SOCIAL_MENTION_SEARCH_DEFAULT_LIMIT = 25
export const SOCIAL_MENTION_SEARCH_MAX_LIMIT = 100

/**
 * One search an adapter runs against its platform. `queries` are the terms to
 * search for (brand names, keywords); `domains` are the project's domains, used
 * to find posts that link to the site. `limit` caps results per query.
 */
export const socialMentionSearchInputSchema = z.object({
  queries: z.array(z.string().trim().min(1)).min(1),
  domains: z.array(z.string().trim().min(1)).default([]),
  /** Only posts at or after this instant. Absent: the platform's own window. */
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(SOCIAL_MENTION_SEARCH_MAX_LIMIT).default(SOCIAL_MENTION_SEARCH_DEFAULT_LIMIT),
})
export type SocialMentionSearchInput = z.infer<typeof socialMentionSearchInputSchema>
export type SocialMentionSearchInputRequest = z.input<typeof socialMentionSearchInputSchema>

/** A count the platform may not expose: null is unknown, never zero. */
const engagementCountSchema = z.number().int().min(0).nullable()

/**
 * One post an adapter found, normalized across platforms. `(platform,
 * externalId)` identifies it, so a post seen by two runs is stored once.
 */
export const socialMentionResultSchema = z.object({
  platform: socialMonitorPlatformSchema,
  /** The platform's own post id. */
  externalId: z.string().min(1),
  externalUrl: z.string().url(),
  /** The search term from `SocialMentionSearchInput.queries` that found this post. */
  matchedQuery: z.string().min(1),
  authorHandle: z.string().nullable(),
  authorName: z.string().nullable(),
  authorFollowers: engagementCountSchema,
  /** Post title where the platform has one (a Reddit submission); null otherwise. */
  contentTitle: z.string().nullable(),
  contentText: z.string(),
  /** Whether the post links to one of `SocialMentionSearchInput.domains`. */
  linksDomain: z.boolean(),
  likes: engagementCountSchema,
  shares: engagementCountSchema,
  comments: engagementCountSchema,
  /** The community the post was made in (a subreddit on Reddit); null where the platform has none. */
  community: z.string().nullable(),
  hashtags: z.array(z.string()),
  postedAt: z.string().datetime({ offset: true }),
  /** Platform-specific fields that have no column of their own. */
  metadata: z.record(z.string(), z.unknown()),
})
export type SocialMentionResult = z.infer<typeof socialMentionResultSchema>

/**
 * Credentials and endpoint for one platform, read from `~/.canonry/config.yaml`
 * like `ProviderConfig`. Never part of a project config file.
 */
export interface SocialMonitorConfig {
  platform: SocialMonitorPlatform
  /** Bearer token or API key, for platforms that take one. */
  apiKey?: string
  /** OAuth client id, for platforms that use client credentials (Reddit). */
  clientId?: string
  /** OAuth client secret, paired with `clientId`. */
  clientSecret?: string
  /** Override of the platform API base URL. */
  baseUrl?: string
}

export interface SocialMonitorHealthcheckResult {
  ok: boolean
  platform: SocialMonitorPlatform
  message: string
}

export interface SocialMonitorAdapter {
  platform: SocialMonitorPlatform
  /** Human-readable display name (e.g. "Reddit"). */
  displayName: string
  /** Checks the config locally; must not call the platform. */
  validateConfig(config: SocialMonitorConfig): SocialMonitorHealthcheckResult
  healthcheck(config: SocialMonitorConfig): Promise<SocialMonitorHealthcheckResult>
  searchMentions(input: SocialMentionSearchInput, config: SocialMonitorConfig): Promise<SocialMentionResult[]>
}

/**
 * Per-platform search settings in a project config (`spec.socialConfig`).
 * Strict, so a credential pasted here is rejected instead of being kept in a
 * file that may be committed; credentials belong in `config.yaml`.
 */
export const socialMonitorPlatformSettingsSchema = z.object({
  /** Search terms on top of the ones the run derives from the project. */
  searchTerms: z.array(z.string().trim().min(1)).optional(),
  /** Restrict the search to these communities (subreddits on Reddit). */
  communities: z.array(z.string().trim().min(1)).optional(),
  limit: z.number().int().min(1).max(SOCIAL_MENTION_SEARCH_MAX_LIMIT).optional(),
}).strict()
export type SocialMonitorPlatformSettings = z.infer<typeof socialMonitorPlatformSettingsSchema>

export const socialMonitorProjectConfigSchema = z.partialRecord(socialMonitorPlatformSchema, socialMonitorPlatformSettingsSchema)
export type SocialMonitorProjectConfig = z.infer<typeof socialMonitorProjectConfigSchema>

/** The platforms a project monitors (`spec.socialPlatforms`); each at most once. */
export const socialMonitorPlatformListSchema = z.array(socialMonitorPlatformSchema).refine(
  platforms => new Set(platforms).size === platforms.length,
  { message: 'Each social platform may be listed once' },
)
