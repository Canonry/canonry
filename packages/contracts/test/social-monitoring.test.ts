import { describe, expect, it } from 'vitest'
import {
  configSpecSchema,
  projectConfigSchema,
  runKindSchema,
  RunKinds,
  SOCIAL_MENTION_SEARCH_DEFAULT_LIMIT,
  SOCIAL_MENTION_SEARCH_MAX_LIMIT,
  socialMentionResultSchema,
  socialMentionSearchInputSchema,
  socialMonitorPlatformSchema,
  SocialMonitorPlatforms,
  socialPlatformSchema,
} from '../src/index.js'

describe('socialMonitorPlatformSchema', () => {
  it('accepts exactly x, reddit and linkedin', () => {
    expect(socialMonitorPlatformSchema.options).toEqual(['x', 'reddit', 'linkedin'])
    expect(SocialMonitorPlatforms.x).toBe('x')
  })

  it('rejects twitter and referral-only platforms', () => {
    expect(socialMonitorPlatformSchema.safeParse('twitter').success).toBe(false)
    expect(socialMonitorPlatformSchema.safeParse('instagram').success).toBe(false)
    expect(socialMonitorPlatformSchema.safeParse('Reddit').success).toBe(false)
  })

  it('spells every platform the way the GA4 referral grouping does', () => {
    for (const platform of socialMonitorPlatformSchema.options) {
      expect(socialPlatformSchema.safeParse(platform).success).toBe(true)
    }
  })
})

describe('socialMentionSearchInputSchema', () => {
  it('fills the default limit and an empty domain list', () => {
    expect(socialMentionSearchInputSchema.parse({ queries: [' acme '] })).toEqual({
      queries: ['acme'],
      domains: [],
      limit: SOCIAL_MENTION_SEARCH_DEFAULT_LIMIT,
    })
    expect(SOCIAL_MENTION_SEARCH_DEFAULT_LIMIT).toBe(25)
  })

  it('accepts the limit bounds and rejects values outside them', () => {
    expect(socialMentionSearchInputSchema.parse({ queries: ['acme'], limit: 1 }).limit).toBe(1)
    expect(socialMentionSearchInputSchema.parse({ queries: ['acme'], limit: 100 }).limit).toBe(SOCIAL_MENTION_SEARCH_MAX_LIMIT)
    for (const limit of [0, 101, 2.5]) {
      expect(socialMentionSearchInputSchema.safeParse({ queries: ['acme'], limit }).success).toBe(false)
    }
  })

  it('requires at least one non-blank query', () => {
    expect(socialMentionSearchInputSchema.safeParse({ queries: [] }).success).toBe(false)
    expect(socialMentionSearchInputSchema.safeParse({ queries: ['  '] }).success).toBe(false)
  })

  it('keeps a valid since instant and rejects a non-ISO one', () => {
    expect(socialMentionSearchInputSchema.parse({ queries: ['acme'], since: '2026-10-01T00:00:00Z' }).since).toBe('2026-10-01T00:00:00Z')
    expect(socialMentionSearchInputSchema.safeParse({ queries: ['acme'], since: '2026-10-01' }).success).toBe(false)
  })
})

describe('socialMentionResultSchema', () => {
  const mention = {
    platform: 'reddit',
    externalId: 't3_abc123',
    externalUrl: 'https://www.reddit.com/r/seo/comments/abc123/acme/',
    matchedQuery: 'acme',
    authorHandle: 'u/someone',
    authorName: null,
    authorFollowers: null,
    contentTitle: 'Anyone tried Acme?',
    contentText: 'Saw it on https://acme.example/pricing',
    linksDomain: true,
    likes: 42,
    shares: null,
    comments: 0,
    community: 'seo',
    hashtags: [],
    postedAt: '2026-10-30T12:00:00.000Z',
    metadata: { upvoteRatio: 0.97 },
  }

  it('round-trips a normalized post, keeping null engagement distinct from zero', () => {
    const parsed = socialMentionResultSchema.parse(mention)
    expect(parsed).toEqual(mention)
    expect(parsed.shares).toBeNull()
    expect(parsed.comments).toBe(0)
  })

  it('rejects negative counts, a twitter platform and a missing external id', () => {
    expect(socialMentionResultSchema.safeParse({ ...mention, likes: -1 }).success).toBe(false)
    expect(socialMentionResultSchema.safeParse({ ...mention, platform: 'twitter' }).success).toBe(false)
    expect(socialMentionResultSchema.safeParse({ ...mention, externalId: '' }).success).toBe(false)
    const { linksDomain: _omitted, ...withoutLinksDomain } = mention
    expect(socialMentionResultSchema.safeParse(withoutLinksDomain).success).toBe(false)
  })
})

describe('configSpecSchema social fields', () => {
  const baseSpec = { displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en' }

  it('parses an existing spec without the social fields and adds no defaults for them', () => {
    const parsed = configSpecSchema.parse(baseSpec)
    expect('socialPlatforms' in parsed).toBe(false)
    expect('socialConfig' in parsed).toBe(false)
    expect(projectConfigSchema.safeParse({ apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'acme' }, spec: baseSpec }).success).toBe(true)
  })

  it('keeps platforms and per-platform settings', () => {
    const parsed = configSpecSchema.parse({
      ...baseSpec,
      socialPlatforms: ['reddit', 'x'],
      socialConfig: { reddit: { communities: ['seo'], limit: 50 } },
    })
    expect(parsed.socialPlatforms).toEqual(['reddit', 'x'])
    expect(parsed.socialConfig).toEqual({ reddit: { communities: ['seo'], limit: 50 } })
  })

  it('rejects duplicate or unknown platforms', () => {
    expect(configSpecSchema.safeParse({ ...baseSpec, socialPlatforms: ['reddit', 'reddit'] }).success).toBe(false)
    expect(configSpecSchema.safeParse({ ...baseSpec, socialPlatforms: ['twitter'] }).success).toBe(false)
    expect(configSpecSchema.safeParse({ ...baseSpec, socialConfig: { twitter: {} } }).success).toBe(false)
  })

  it('rejects credentials and out-of-range limits in socialConfig', () => {
    expect(configSpecSchema.safeParse({ ...baseSpec, socialConfig: { reddit: { clientSecret: 'secret' } } }).success).toBe(false)
    expect(configSpecSchema.safeParse({ ...baseSpec, socialConfig: { reddit: { limit: 101 } } }).success).toBe(false)
  })
})

describe('social-monitor run kind', () => {
  it('is a run kind with an enum constant', () => {
    expect(runKindSchema.safeParse('social-monitor').success).toBe(true)
    expect(RunKinds['social-monitor']).toBe('social-monitor')
  })
})
