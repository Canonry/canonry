import { describe, it, expect } from 'vitest'
import {
  providerMetricSchema,
  timeBucketSchema,
  brandMetricsDtoSchema,
} from '../src/analytics.js'

const providerMetric = {
  citationRate: 0.5,
  cited: 1,
  total: 2,
  mentionRate: 1,
  mentionedCount: 2,
}

const bucket = {
  startDate: '2026-04-01T00:00:00.000Z',
  endDate: '2026-04-08T00:00:00.000Z',
  citationRate: 0.5,
  cited: 2,
  total: 4,
  queryCount: 2,
  mentionRate: 0.75,
  mentionedCount: 3,
  byProvider: {
    gemini: providerMetric,
    openai: { citationRate: 0.5, cited: 1, total: 2, mentionRate: 0.5, mentionedCount: 1 },
  },
}

describe('providerMetricSchema', () => {
  it('round-trips a metric', () => {
    expect(() => providerMetricSchema.parse(providerMetric)).not.toThrow()
  })

  it('rejects a missing field', () => {
    const { mentionRate: _mentionRate, ...partial } = providerMetric
    expect(() => providerMetricSchema.parse(partial)).toThrow()
  })
})

describe('timeBucketSchema', () => {
  it('round-trips a bucket carrying per-provider metrics', () => {
    const parsed = timeBucketSchema.parse(bucket)
    expect(Object.keys(parsed.byProvider).sort()).toEqual(['gemini', 'openai'])
    expect(parsed.byProvider.gemini.cited).toBe(1)
  })

  it('requires byProvider (per-provider breakdown is not optional)', () => {
    const { byProvider: _byProvider, ...withoutProviders } = bucket
    expect(() => timeBucketSchema.parse(withoutProviders)).toThrow()
  })
})

describe('brandMetricsDtoSchema', () => {
  it('round-trips a full payload with per-bucket byProvider', () => {
    const dto = {
      window: 'all' as const,
      buckets: [bucket],
      overall: providerMetric,
      byProvider: { gemini: providerMetric },
      trend: 'improving' as const,
      mentionTrend: 'stable' as const,
      queryChanges: [{ date: '2026-04-03', delta: 2, label: '+2 queries' }],
    }
    const parsed = brandMetricsDtoSchema.parse(dto)
    expect(parsed.buckets[0]!.byProvider.gemini.citationRate).toBe(0.5)
    expect(parsed.trend).toBe('improving')
  })

  it('rejects an unknown window', () => {
    expect(() =>
      brandMetricsDtoSchema.parse({
        window: '14d',
        buckets: [],
        overall: providerMetric,
        byProvider: {},
        trend: 'stable',
        mentionTrend: 'stable',
        queryChanges: [],
      }),
    ).toThrow()
  })

  it('rejects an unknown trend direction', () => {
    expect(() =>
      brandMetricsDtoSchema.parse({
        window: 'all',
        buckets: [],
        overall: providerMetric,
        byProvider: {},
        trend: 'up',
        mentionTrend: 'stable',
        queryChanges: [],
      }),
    ).toThrow()
  })
})
