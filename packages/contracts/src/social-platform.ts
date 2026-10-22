import { z } from 'zod'
import { hostMatchesAnyDomain, hostOf } from './url-normalize.js'

/**
 * The social platforms a GA4 social referral source can be grouped under.
 *
 * GA4 reports one platform under many sources: `ig`, `instagram.com`,
 * `l.instagram.com` and a campaign tag such as `Instagram+Story` are all
 * Instagram. Grouping happens here so every surface buckets a source the same
 * way; a source no platform matches keeps its own name and is never dropped.
 */
export const socialPlatformSchema = z.enum([
  'instagram',
  'facebook',
  'pinterest',
  'linkedin',
  'x',
  'youtube',
  'tiktok',
  'reddit',
  'threads',
  'snapchat',
  'nextdoor',
  'quora',
])
export type SocialPlatform = z.infer<typeof socialPlatformSchema>
export const SocialPlatforms = socialPlatformSchema.enum

export interface SocialPlatformDefinition {
  platform: SocialPlatform
  /** Display name for human output. */
  label: string
  /** Hostnames matched exactly or as a parent domain (`www.`, `m.` and `l.` subdomains included). */
  domains: readonly string[]
  /**
   * Words that name the platform in a bare source, app id or campaign tag,
   * matched whole and case-insensitively (`ig`, `FB_Ads`, `Instagram+Story`).
   * A hostname is never matched on these, so `notfacebook.com` stays apart.
   */
  labels: readonly string[]
}

export const SOCIAL_PLATFORM_DEFINITIONS: readonly SocialPlatformDefinition[] = [
  { platform: SocialPlatforms.instagram, label: 'Instagram', domains: ['instagram.com'], labels: ['instagram', 'ig', 'igshopping'] },
  { platform: SocialPlatforms.facebook, label: 'Facebook', domains: ['facebook.com', 'fb.com', 'fb.me', 'messenger.com'], labels: ['facebook', 'fb', 'messenger'] },
  {
    platform: SocialPlatforms.pinterest,
    label: 'Pinterest',
    domains: ['pinterest.com', 'pin.it', 'pinterest.ca', 'pinterest.co.uk', 'pinterest.com.au', 'pinterest.de', 'pinterest.fr', 'pinterest.es', 'pinterest.it', 'pinterest.com.mx'],
    labels: ['pinterest'],
  },
  { platform: SocialPlatforms.linkedin, label: 'LinkedIn', domains: ['linkedin.com', 'lnkd.in'], labels: ['linkedin'] },
  { platform: SocialPlatforms.x, label: 'X', domains: ['x.com', 'twitter.com', 't.co'], labels: ['twitter', 'x'] },
  { platform: SocialPlatforms.youtube, label: 'YouTube', domains: ['youtube.com', 'youtu.be'], labels: ['youtube'] },
  { platform: SocialPlatforms.tiktok, label: 'TikTok', domains: ['tiktok.com'], labels: ['tiktok'] },
  { platform: SocialPlatforms.reddit, label: 'Reddit', domains: ['reddit.com', 'redd.it'], labels: ['reddit'] },
  { platform: SocialPlatforms.threads, label: 'Threads', domains: ['threads.net', 'threads.com'], labels: ['threads'] },
  { platform: SocialPlatforms.snapchat, label: 'Snapchat', domains: ['snapchat.com'], labels: ['snapchat'] },
  { platform: SocialPlatforms.nextdoor, label: 'Nextdoor', domains: ['nextdoor.com'], labels: ['nextdoor'] },
  { platform: SocialPlatforms.quora, label: 'Quora', domains: ['quora.com'], labels: ['quora'] },
]

const PLATFORM_BY_LABEL = new Map<string, SocialPlatform>(
  SOCIAL_PLATFORM_DEFINITIONS.flatMap(definition => (
    definition.labels.map(label => [label, definition.platform] as const)
  )),
)

const LABEL_BY_PLATFORM = new Map<SocialPlatform, string>(
  SOCIAL_PLATFORM_DEFINITIONS.map(definition => [definition.platform, definition.label]),
)

/** A hostname or URL, as opposed to a bare label, app id or campaign tag. */
function looksLikeHost(value: string): boolean {
  return value.includes('.') && !/[\s_+]/.test(value)
}

/**
 * The social platform a GA4 source belongs to, or null when no platform
 * matches it.
 *
 * Accepts what GA4 stores as a social `sessionSource`: a hostname in any case
 * or subdomain (`l.instagram.com`, `m.facebook.com`, `uk.pinterest.com`), a
 * full URL, a bare label (`ig`, `Pinterest`), an app id
 * (`android-app://com.instagram.android`) or a campaign tag (`FB_Ads`,
 * `Instagram+Story`). Hostnames match on a domain boundary only.
 */
export function socialPlatformForReferralSource(source: string | null | undefined): SocialPlatform | null {
  if (source == null) return null
  const value = source.trim().toLowerCase()
  if (!value || value.startsWith('(')) return null
  if (value.includes('://') && !value.startsWith('android-app://') && !value.startsWith('ios-app://')) {
    const host = hostOf(value)
    return host ? SOCIAL_PLATFORM_DEFINITIONS.find(d => hostMatchesAnyDomain(host, d.domains))?.platform ?? null : null
  }
  const bare = value.replace(/^(android|ios)-app:\/\//, '')
  if (looksLikeHost(bare) && !bare.startsWith('com.') && !bare.startsWith('org.')) {
    const host = hostOf(bare)
    return host ? SOCIAL_PLATFORM_DEFINITIONS.find(d => hostMatchesAnyDomain(host, d.domains))?.platform ?? null : null
  }
  for (const word of bare.split(/[^a-z0-9]+/)) {
    const platform = PLATFORM_BY_LABEL.get(word)
    if (platform) return platform
  }
  return null
}

/** Display name for a social platform id (`linkedin` reads `LinkedIn`). */
export function socialPlatformLabel(platform: SocialPlatform): string {
  return LABEL_BY_PLATFORM.get(platform) ?? platform
}
