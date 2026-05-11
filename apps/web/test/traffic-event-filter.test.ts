import { describe, expect, test } from 'vitest'
import { TrafficEventKinds, type TrafficEventEntry } from '@ainyc/canonry-contracts'

import {
  bucketKeyFor,
  filterTrafficEvents,
  identityOf,
  pathOf,
} from '../src/lib/traffic-event-filter.js'

function crawler(overrides: Partial<Extract<TrafficEventEntry, { kind: 'crawler' }>> = {}): TrafficEventEntry {
  return {
    kind: TrafficEventKinds.crawler,
    sourceId: 'src-1',
    tsHour: '2026-05-07T02:00:00.000Z',
    botId: 'GPTBot',
    operator: 'OpenAI',
    verificationStatus: 'claimed_unverified',
    pathNormalized: '/sitemap.xml',
    status: 200,
    hits: 1,
    ...overrides,
  }
}

function aiReferral(overrides: Partial<Extract<TrafficEventEntry, { kind: 'ai-referral' }>> = {}): TrafficEventEntry {
  return {
    kind: TrafficEventKinds['ai-referral'],
    sourceId: 'src-1',
    tsHour: '2026-05-07T02:00:00.000Z',
    product: 'ChatGPT',
    operator: 'OpenAI',
    sourceDomain: 'chat.openai.com',
    evidenceType: 'referer',
    landingPathNormalized: '/blog/post',
    status: 200,
    hits: 1,
    ...overrides,
  }
}

describe('identityOf', () => {
  test('returns botId for crawler events', () => {
    expect(identityOf(crawler({ botId: 'anthropic-claudebot' }))).toBe('anthropic-claudebot')
  })

  test('returns product for ai-referral events', () => {
    expect(identityOf(aiReferral({ product: 'Perplexity' }))).toBe('Perplexity')
  })
})

describe('pathOf', () => {
  test('returns pathNormalized for crawler events', () => {
    expect(pathOf(crawler({ pathNormalized: '/robots.txt' }))).toBe('/robots.txt')
  })

  test('returns landingPathNormalized for ai-referral events', () => {
    expect(pathOf(aiReferral({ landingPathNormalized: '/landing' }))).toBe('/landing')
  })
})

describe('bucketKeyFor', () => {
  test('passes through the ISO timestamp at hour granularity', () => {
    expect(bucketKeyFor('2026-05-07T02:00:00.000Z', 'hour')).toBe('2026-05-07T02:00:00.000Z')
  })

  test('reduces to local YYYY-MM-DD at day granularity', () => {
    // Construct a known timestamp; the helper uses local-time getters intentionally
    // so this assertion holds across TZs only when the input local date matches.
    const iso = new Date(2026, 4, 7, 14, 0, 0).toISOString() // May 7, 14:00 local
    expect(bucketKeyFor(iso, 'day')).toBe('2026-05-07')
  })
})

describe('filterTrafficEvents', () => {
  const events: TrafficEventEntry[] = [
    crawler({ tsHour: '2026-05-07T02:00:00.000Z', botId: 'GPTBot', operator: 'OpenAI', pathNormalized: '/sitemap.xml' }),
    crawler({ tsHour: '2026-05-07T03:00:00.000Z', botId: 'anthropic-claudebot', operator: 'Anthropic', pathNormalized: '/robots.txt' }),
    aiReferral({ tsHour: '2026-05-08T05:00:00.000Z', product: 'ChatGPT', operator: 'OpenAI', landingPathNormalized: '/blog/post' }),
    aiReferral({ tsHour: '2026-05-07T02:00:00.000Z', product: 'Perplexity', operator: 'Perplexity', landingPathNormalized: '/sitemap.xml' }),
  ]

  test('returns all events when no filters set', () => {
    const result = filterTrafficEvents(
      events,
      { selectedBucket: null, identity: '', operator: '', pathQuery: '' },
      'hour',
    )
    expect(result.length).toBe(4)
  })

  test('filters by selected bucket at hour granularity', () => {
    const result = filterTrafficEvents(
      events,
      { selectedBucket: '2026-05-07T02:00:00.000Z', identity: '', operator: '', pathQuery: '' },
      'hour',
    )
    expect(result.length).toBe(2)
    expect(result.every((e) => e.tsHour === '2026-05-07T02:00:00.000Z')).toBe(true)
  })

  test('filters by identity (covers both crawler.botId and ai-referral.product)', () => {
    const result = filterTrafficEvents(
      events,
      { selectedBucket: null, identity: 'Perplexity', operator: '', pathQuery: '' },
      'hour',
    )
    expect(result.length).toBe(1)
    expect(identityOf(result[0]!)).toBe('Perplexity')
  })

  test('filters by operator', () => {
    const result = filterTrafficEvents(
      events,
      { selectedBucket: null, identity: '', operator: 'OpenAI', pathQuery: '' },
      'hour',
    )
    expect(result.length).toBe(2)
    expect(result.every((e) => e.operator === 'OpenAI')).toBe(true)
  })

  test('filters path with case-insensitive substring match', () => {
    const result = filterTrafficEvents(
      events,
      { selectedBucket: null, identity: '', operator: '', pathQuery: 'SITEMAP' },
      'hour',
    )
    expect(result.length).toBe(2)
    expect(result.every((e) => pathOf(e).includes('/sitemap.xml'))).toBe(true)
  })

  test('trims path query whitespace', () => {
    const result = filterTrafficEvents(
      events,
      { selectedBucket: null, identity: '', operator: '', pathQuery: '   ' },
      'hour',
    )
    expect(result.length).toBe(4)
  })

  test('combines all filters with AND semantics', () => {
    const result = filterTrafficEvents(
      events,
      { selectedBucket: '2026-05-07T02:00:00.000Z', identity: 'GPTBot', operator: 'OpenAI', pathQuery: 'sitemap' },
      'hour',
    )
    expect(result.length).toBe(1)
    expect(identityOf(result[0]!)).toBe('GPTBot')
  })

  test('returns empty when conflicting filters match nothing', () => {
    const result = filterTrafficEvents(
      events,
      { selectedBucket: '2026-05-07T02:00:00.000Z', identity: 'anthropic-claudebot', operator: '', pathQuery: '' },
      'hour',
    )
    expect(result).toEqual([])
  })
})
