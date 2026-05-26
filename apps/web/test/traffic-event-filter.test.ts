import { describe, expect, test } from 'vitest'
import { TrafficEventKinds, VerificationStatuses, type TrafficEventEntry } from '@ainyc/canonry-contracts'

import {
  bucketForChartClick,
  bucketKeyFor,
  filterTrafficEvents,
  identityOf,
  pathOf,
  verificationOf,
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
    crawler({ tsHour: '2026-05-07T02:00:00.000Z', botId: 'GPTBot', operator: 'OpenAI', pathNormalized: '/sitemap.xml', status: 200 }),
    crawler({ tsHour: '2026-05-07T03:00:00.000Z', botId: 'anthropic-claudebot', operator: 'Anthropic', pathNormalized: '/robots.txt', status: 404 }),
    aiReferral({ tsHour: '2026-05-08T05:00:00.000Z', product: 'ChatGPT', operator: 'OpenAI', landingPathNormalized: '/blog/post', status: 301 }),
    aiReferral({ tsHour: '2026-05-07T02:00:00.000Z', product: 'Perplexity', operator: 'Perplexity', landingPathNormalized: '/sitemap.xml', status: 500 }),
  ]

  // Default filter shape — keeps each test focused on the field it's
  // exercising instead of repeating the full object literal.
  const defaults = (): import('../src/lib/traffic-event-filter.js').TrafficEventFilters => ({
    selectedBucket: null,
    identity: '',
    operator: '',
    pathQuery: '',
    statusClass: 'all',
    verification: 'all',
  })

  test('returns all events when no filters set', () => {
    const result = filterTrafficEvents(events, defaults(), 'hour')
    expect(result.length).toBe(4)
  })

  test('filters by selected bucket at hour granularity', () => {
    const result = filterTrafficEvents(
      events,
      { ...defaults(), selectedBucket: '2026-05-07T02:00:00.000Z' },
      'hour',
    )
    expect(result.length).toBe(2)
    expect(result.every((e) => e.tsHour === '2026-05-07T02:00:00.000Z')).toBe(true)
  })

  test('filters by identity (covers both crawler.botId and ai-referral.product)', () => {
    const result = filterTrafficEvents(events, { ...defaults(), identity: 'Perplexity' }, 'hour')
    expect(result.length).toBe(1)
    expect(identityOf(result[0]!)).toBe('Perplexity')
  })

  test('filters by operator', () => {
    const result = filterTrafficEvents(events, { ...defaults(), operator: 'OpenAI' }, 'hour')
    expect(result.length).toBe(2)
    expect(result.every((e) => e.operator === 'OpenAI')).toBe(true)
  })

  test('filters path with case-insensitive substring match', () => {
    const result = filterTrafficEvents(events, { ...defaults(), pathQuery: 'SITEMAP' }, 'hour')
    expect(result.length).toBe(2)
    expect(result.every((e) => pathOf(e).includes('/sitemap.xml'))).toBe(true)
  })

  test('trims path query whitespace', () => {
    const result = filterTrafficEvents(events, { ...defaults(), pathQuery: '   ' }, 'hour')
    expect(result.length).toBe(4)
  })

  test('combines all filters with AND semantics', () => {
    const result = filterTrafficEvents(
      events,
      {
        selectedBucket: '2026-05-07T02:00:00.000Z',
        identity: 'GPTBot',
        operator: 'OpenAI',
        pathQuery: 'sitemap',
        statusClass: 'all',
        verification: 'all',
      },
      'hour',
    )
    expect(result.length).toBe(1)
    expect(identityOf(result[0]!)).toBe('GPTBot')
  })

  test('returns empty when conflicting filters match nothing', () => {
    const result = filterTrafficEvents(
      events,
      { ...defaults(), selectedBucket: '2026-05-07T02:00:00.000Z', identity: 'anthropic-claudebot' },
      'hour',
    )
    expect(result).toEqual([])
  })

  test('statusClass filter buckets events by hundreds digit', () => {
    // 2xx — only the GPTBot/sitemap event (status 200) survives.
    const twos = filterTrafficEvents(events, { ...defaults(), statusClass: '2xx' }, 'hour')
    expect(twos.length).toBe(1)
    expect(twos[0]!.status).toBe(200)

    // 3xx — only the ChatGPT/blog event (status 301).
    const threes = filterTrafficEvents(events, { ...defaults(), statusClass: '3xx' }, 'hour')
    expect(threes.length).toBe(1)
    expect(threes[0]!.status).toBe(301)

    // 4xx — only the ClaudeBot/robots event (status 404).
    const fours = filterTrafficEvents(events, { ...defaults(), statusClass: '4xx' }, 'hour')
    expect(fours.length).toBe(1)
    expect(fours[0]!.status).toBe(404)

    // 5xx — only the Perplexity/sitemap event (status 500).
    const fives = filterTrafficEvents(events, { ...defaults(), statusClass: '5xx' }, 'hour')
    expect(fives.length).toBe(1)
    expect(fives[0]!.status).toBe(500)

    // 'all' is the no-op default.
    const all = filterTrafficEvents(events, { ...defaults(), statusClass: 'all' }, 'hour')
    expect(all.length).toBe(4)
  })

  test('statusClass composes with other filters (AND semantics)', () => {
    // Both sitemap.xml events (200 and 500). Adding statusClass='2xx'
    // narrows to just the 200.
    const result = filterTrafficEvents(
      events,
      { ...defaults(), pathQuery: 'sitemap', statusClass: '2xx' },
      'hour',
    )
    expect(result.length).toBe(1)
    expect(result[0]!.status).toBe(200)
  })

  test('verification=all is the no-op default', () => {
    const result = filterTrafficEvents(events, { ...defaults(), verification: 'all' }, 'hour')
    expect(result.length).toBe(4)
  })

  test('verification=verified keeps only events with that claim and excludes ai-referrals', () => {
    // The base set has no `verified` crawler — seed one and confirm only
    // it survives. The ai-referral events lack verificationStatus so they
    // must drop out when a concrete claim is requested.
    const seeded = [
      ...events,
      crawler({ tsHour: '2026-05-07T04:00:00.000Z', verificationStatus: VerificationStatuses.verified, botId: 'OAI-SearchBot' }),
    ]
    const result = filterTrafficEvents(seeded, { ...defaults(), verification: VerificationStatuses.verified }, 'hour')
    expect(result.length).toBe(1)
    expect(result[0]!.kind).toBe(TrafficEventKinds.crawler)
    expect(identityOf(result[0]!)).toBe('OAI-SearchBot')
  })

  test('verification=claimed_unverified passes UA-only crawler matches and excludes ai-referrals', () => {
    const result = filterTrafficEvents(
      events,
      { ...defaults(), verification: VerificationStatuses.claimed_unverified },
      'hour',
    )
    // Both base crawler events are claimed_unverified; both ai-referrals
    // must be excluded.
    expect(result.length).toBe(2)
    expect(result.every((e) => e.kind === TrafficEventKinds.crawler)).toBe(true)
  })

  test('verification composes with other filters (AND semantics)', () => {
    // operator='OpenAI' alone returns 2 events (one crawler verified=false,
    // one ai-referral). Adding verification=claimed_unverified excludes the
    // ai-referral, leaving only the GPTBot crawler.
    const result = filterTrafficEvents(
      events,
      { ...defaults(), operator: 'OpenAI', verification: VerificationStatuses.claimed_unverified },
      'hour',
    )
    expect(result.length).toBe(1)
    expect(identityOf(result[0]!)).toBe('GPTBot')
  })
})

describe('verificationOf', () => {
  test('returns the verification status for crawler events', () => {
    expect(verificationOf(crawler({ verificationStatus: VerificationStatuses.verified }))).toBe(
      VerificationStatuses.verified,
    )
    expect(verificationOf(crawler({ verificationStatus: VerificationStatuses.claimed_unverified }))).toBe(
      VerificationStatuses.claimed_unverified,
    )
  })

  test('returns null for ai-referral events (no verification concept)', () => {
    expect(verificationOf(aiReferral())).toBeNull()
  })
})

describe('bucketForChartClick', () => {
  const chartData = [
    { bucket: '2026-05-07T00:00:00.000Z' },
    { bucket: '2026-05-07T01:00:00.000Z' },
    { bucket: '2026-05-07T02:00:00.000Z' },
  ]

  test('returns the bucket at activeTooltipIndex (real recharts v3 shape — STRING)', () => {
    // Recharts 3.x wraps every numeric tooltip index in String() before storing it
    // (combineActiveTooltipIndex.js: `return String(clampedIndex)`), so the value
    // surfaced via the BarChart.onClick MouseHandlerDataParam is a STRING — even though
    // the TS type advertises `number | TooltipIndex | undefined`. PR #458 tested with
    // a number and missed this in production.
    const state = {
      activeTooltipIndex: '2',
      isTooltipActive: true,
      activeIndex: '2',
      activeLabel: '5/7 02:00',
    }
    expect(bucketForChartClick(state, chartData)).toBe('2026-05-07T02:00:00.000Z')
  })

  test('also accepts a number activeTooltipIndex (matches the TS type)', () => {
    expect(bucketForChartClick({ activeTooltipIndex: 2 }, chartData)).toBe('2026-05-07T02:00:00.000Z')
  })

  test('returns null when state is null/undefined', () => {
    expect(bucketForChartClick(null, chartData)).toBeNull()
    expect(bucketForChartClick(undefined, chartData)).toBeNull()
  })

  test('returns null when activeTooltipIndex is missing or non-numeric', () => {
    expect(bucketForChartClick({}, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: undefined }, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: null }, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: '' }, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: 'foo' }, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: true }, chartData)).toBeNull()
  })

  test('returns null for out-of-range index (number or string)', () => {
    expect(bucketForChartClick({ activeTooltipIndex: -1 }, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: '3' }, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: '99' }, chartData)).toBeNull()
  })

  test('rejects non-integer activeTooltipIndex', () => {
    expect(bucketForChartClick({ activeTooltipIndex: 1.5 }, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: '1.5' }, chartData)).toBeNull()
    expect(bucketForChartClick({ activeTooltipIndex: Number.NaN }, chartData)).toBeNull()
  })

  test('reading activePayload (the v2 shape) returns null — guards against regression', () => {
    // If someone re-introduces the v2 read pattern, this would have been the v2 shape.
    // We deliberately ignore activePayload in v3 and only use activeTooltipIndex.
    const v2Shape = {
      activePayload: [{ payload: { bucket: '2026-05-07T01:00:00.000Z' } }],
    }
    expect(bucketForChartClick(v2Shape, chartData)).toBeNull()
  })
})
