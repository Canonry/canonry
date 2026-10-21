import { describe, expect, it } from 'vitest'
import { socialPlatformForReferralSource, socialPlatformLabel } from '../src/social-platform.js'

describe('socialPlatformForReferralSource', () => {
  it('groups the spellings GA4 reports for one platform', () => {
    // Every source below is a shape GA4 really stores for a social session.
    const cases: Array<[string, string]> = [
      ['ig', 'instagram'],
      ['instagram.com', 'instagram'],
      ['l.instagram.com', 'instagram'],
      ['Instagram+Story', 'instagram'],
      ['IGShopping', 'instagram'],
      ['android-app://com.instagram.android', 'instagram'],
      ['facebook', 'facebook'],
      ['m.facebook.com', 'facebook'],
      ['lm.facebook.com', 'facebook'],
      ['FB_Ads', 'facebook'],
      ['Pinterest', 'pinterest'],
      ['uk.pinterest.com', 'pinterest'],
      ['pinterest.co.uk', 'pinterest'],
      ['pin.it', 'pinterest'],
      ['lnkd.in', 'linkedin'],
      ['linkedin.com', 'linkedin'],
      ['t.co', 'x'],
      ['twitter.com', 'x'],
      ['x.com', 'x'],
      ['m.youtube.com', 'youtube'],
      ['out.reddit.com', 'reddit'],
      ['threads.net', 'threads'],
      ['nextdoor.com', 'nextdoor'],
      ['https://www.quora.com/some/answer', 'quora'],
    ]
    for (const [source, platform] of cases) {
      expect(socialPlatformForReferralSource(source), source).toBe(platform)
    }
  })

  it('matches a hostname on a domain boundary only', () => {
    expect(socialPlatformForReferralSource('notfacebook.com')).toBeNull()
    expect(socialPlatformForReferralSource('instagram.com.example.net')).toBeNull()
    // A host never matches on a label inside it, only on its domain.
    expect(socialPlatformForReferralSource('facebook.example.com')).toBeNull()
  })

  it('returns null for sources no platform names and for GA4 placeholders', () => {
    for (const source of ['some-forum.example', 'newsletter', '(not set)', '(direct)', '', '   ', null, undefined]) {
      expect(socialPlatformForReferralSource(source), String(source)).toBeNull()
    }
  })
})

describe('socialPlatformLabel', () => {
  it('names each platform for display', () => {
    expect(socialPlatformLabel('linkedin')).toBe('LinkedIn')
    expect(socialPlatformLabel('youtube')).toBe('YouTube')
    expect(socialPlatformLabel('x')).toBe('X')
  })
})
