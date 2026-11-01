import { describe, expect, it } from 'vitest'
import { classifyJourneyEntry, journeyDetailQuerySchema, journeyDeviceLabel, isJourneyWriteMethod, journeyEventMatchesFilter, journeysQuerySchema, type JourneyEntrySignal } from '../src/index.js'

const signal = (overrides: Partial<JourneyEntrySignal>): JourneyEntrySignal => ({
  aiProduct: null,
  aiDomain: null,
  aiPaid: false,
  refererHost: null,
  utmSource: null,
  utmMedium: null,
  adClickId: false,
  clickNetwork: null,
  ...overrides,
})

describe('classifyJourneyEntry', () => {
  it('lets an AI referral win over every other marker', () => {
    expect(classifyJourneyEntry(signal({ aiProduct: 'ChatGPT', aiDomain: 'chatgpt.com', refererHost: 'chatgpt.com', utmSource: 'google', adClickId: true })))
      .toEqual({ entryClass: 'ai', entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false })
    expect(classifyJourneyEntry(signal({ aiProduct: 'ChatGPT', aiDomain: 'chatgpt.com', aiPaid: true })).paid).toBe(true)
  })

  it.each([
    ['www.google.com', 'search', 'Google'],
    ['google.co.uk', 'search', 'Google'],
    ['bing.com', 'search', 'Bing'],
    ['duckduckgo.com', 'search', 'DuckDuckGo'],
    ['m.facebook.com', 'social', 'Facebook'],
    ['l.instagram.com', 'social', 'Instagram'],
    ['t.co', 'social', 'X'],
    ['out.reddit.com', 'social', 'Reddit'],
  ] as const)('classifies referer %s as %s', (host, entryClass, entryName) => {
    expect(classifyJourneyEntry(signal({ refererHost: host }))).toMatchObject({ entryClass, entryName, paid: false })
  })

  it.each([
    ['accounts.google.com'],
    ['mail.google.com'],
    ['docs.google.com'],
    ['mail.yahoo.com'],
    ['mail.yandex.ru'],
    ['blog.naver.com'],
  ])('treats non-search host %s as a referral, not search', host => {
    expect(classifyJourneyEntry(signal({ refererHost: host }))).toMatchObject({ entryClass: 'referral', entryName: host })
  })

  it.each([['google.co.uk'], ['google.com.au'], ['search.yahoo.com'], ['uk.search.yahoo.com'], ['yandex.ru'], ['search.naver.com']])('still treats %s as search', host => {
    expect(classifyJourneyEntry(signal({ refererHost: host })).entryClass).toBe('search')
  })

  it.each([['constructor'], ['__proto__'], ['toString'], ['hasOwnProperty']])('treats utm_source %s as a plain referral name', source => {
    expect(classifyJourneyEntry(signal({ utmSource: source }))).toEqual({ entryClass: 'referral', entryName: source.toLowerCase(), entryHost: null, paid: false })
  })

  it('does not call fbclid paid: platforms add it to unpaid links', () => {
    expect(classifyJourneyEntry(signal({ refererHost: 'l.facebook.com', clickNetwork: 'Facebook' })))
      .toEqual({ entryClass: 'social', entryName: 'Facebook', entryHost: 'l.facebook.com', paid: false })
    expect(classifyJourneyEntry(signal({ clickNetwork: 'Facebook' })))
      .toEqual({ entryClass: 'social', entryName: 'Facebook', entryHost: null, paid: false })
    expect(classifyJourneyEntry(signal({ clickNetwork: 'Facebook', utmMedium: 'paid_social' })))
      .toEqual({ entryClass: 'paid', entryName: 'Facebook', entryHost: null, paid: true })
  })

  it('marks paid traffic from a paid medium or an ad click id', () => {
    expect(classifyJourneyEntry(signal({ refererHost: 'www.google.com', adClickId: true })))
      .toEqual({ entryClass: 'paid', entryName: 'Google', entryHost: 'google.com', paid: true })
    expect(classifyJourneyEntry(signal({ utmSource: 'facebook', utmMedium: 'CPC' })))
      .toEqual({ entryClass: 'paid', entryName: 'Facebook', entryHost: null, paid: true })
  })

  it('falls back to the referer host, then utm_source, then direct', () => {
    expect(classifyJourneyEntry(signal({ refererHost: 'www.example.org' })))
      .toEqual({ entryClass: 'referral', entryName: 'example.org', entryHost: 'example.org', paid: false })
    expect(classifyJourneyEntry(signal({ utmSource: 'google' })))
      .toEqual({ entryClass: 'search', entryName: 'Google', entryHost: null, paid: false })
    expect(classifyJourneyEntry(signal({ utmSource: 'newsletter' })))
      .toEqual({ entryClass: 'referral', entryName: 'newsletter', entryHost: null, paid: false })
    expect(classifyJourneyEntry(signal({})))
      .toEqual({ entryClass: 'direct', entryName: null, entryHost: null, paid: false })
  })
})

describe('journeyDeviceLabel', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', 'Mac · Chrome 155'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1', 'iPhone · iOS 18.7 · Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1', 'iPhone · iOS 18.7 · Chrome 155'],
    // Safari 26+ freezes the OS token; its Version token is the real iOS major.
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1', 'iPhone · iOS 27 · Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1', 'iPhone · iOS 26 · Safari'],
    ['Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1', 'iPad · iOS 26 · Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 'iPhone · iOS 18.5 · Safari'],
    // Third-party iOS browsers report the real OS version.
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1', 'iPhone · iOS 27.0 · Chrome 155'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15', 'iPhone · iOS 27.0 · Firefox 145'],
    ['Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36', 'Android 15 · Chrome 155'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0', 'Windows · Edge 155'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:140.0) Gecko/20100101 Firefox/140.0', 'Mac · Firefox 140'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15', 'Mac · Safari 26.1'],
  ])('shortens %s', (ua, label) => {
    expect(journeyDeviceLabel(ua)).toBe(label)
  })

  it('handles a missing or unrecognized user agent', () => {
    expect(journeyDeviceLabel(null)).toBe('Unknown device')
    expect(journeyDeviceLabel('')).toBe('Unknown device')
    expect(journeyDeviceLabel('x'.repeat(60))).toHaveLength(40)
  })
})

describe('journeysQuerySchema', () => {
  it('accepts timestamps or dates and bounds the page size', () => {
    expect(journeysQuerySchema.safeParse({ since: '2026-10-01', until: '2026-10-24T00:00:00Z', limit: 200 }).success).toBe(true)
    expect(journeysQuerySchema.safeParse({ limit: 201 }).success).toBe(false)
    expect(journeysQuerySchema.safeParse({ since: 'yesterday' }).success).toBe(false)
    expect(journeysQuerySchema.safeParse({ returned: 'yes' }).success).toBe(false)
  })
})

describe('journeyEventMatchesFilter', () => {
  it('keeps every request for all, and pages plus non-GET/HEAD requests for pages', () => {
    const cases: Array<[{ kind: 'page' | 'data'; method: string | null }, boolean]> = [
      [{ kind: 'page', method: 'GET' }, true],
      [{ kind: 'page', method: null }, true],
      [{ kind: 'data', method: 'GET' }, false],
      [{ kind: 'data', method: 'head' }, false],
      [{ kind: 'data', method: null }, false],
      [{ kind: 'data', method: 'POST' }, true],
      [{ kind: 'data', method: 'put' }, true],
      [{ kind: 'data', method: 'DELETE' }, true],
    ]
    for (const [event, expected] of cases) {
      expect(journeyEventMatchesFilter(event, 'pages'), JSON.stringify(event)).toBe(expected)
      expect(journeyEventMatchesFilter(event, 'all')).toBe(true)
    }
  })

  it('treats only methods other than GET and HEAD as writes', () => {
    expect(['POST', 'put', 'PATCH', 'DELETE'].map(isJourneyWriteMethod)).toEqual([true, true, true, true])
    expect(['GET', 'head'].map(isJourneyWriteMethod)).toEqual([false, false])
    expect(isJourneyWriteMethod(null)).toBe(false)
  })

  it('accepts only the two documented filters', () => {
    expect(journeyDetailQuerySchema.safeParse({ events: 'pages' }).success).toBe(true)
    expect(journeyDetailQuerySchema.safeParse({ events: 'everything' }).success).toBe(false)
  })
})
