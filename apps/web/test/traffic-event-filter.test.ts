import { describe, expect, test } from 'vitest'
import { TrafficEventKinds, type TrafficEventEntry } from '@ainyc/canonry-contracts'

import {
  bucketForChartClick,
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
