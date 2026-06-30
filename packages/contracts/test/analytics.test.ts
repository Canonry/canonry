import { describe, it, expect } from 'vitest'
import {
  MentionShareNoLocationBucket,
  mentionShareBucketMetricSchema,
  providerMetricSchema,
  timeBucketSchema,
  brandMetricsDtoSchema,
  sourceCategoryCountSchema,
  sourceRankEntrySchema,
  surfaceClassCountSchema,
  rankedSourceListSchema,
  sourceBreakdownDtoSchema,
} from '../src/analytics.js'

const providerMetric = {
  citationRate: 0.5,
  cited: 1,
  total: 2,
  mentionRate: 1,
  mentionedCount: 2,
}

const mentionShareObservationMetric = {
  rate: 0.6,
  projectMentionEvents: 3,
  competitorMentionEvents: 2,
  projectMentionSnapshots: 3,
  competitorMentionSnapshots: 2,
  brandMentionEvents: 5,
  answerObservations: 4,
  totalObservations: 4,
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
  mentionShare: {
    ...mentionShareObservationMetric,
    byProvider: { gemini: mentionShareObservationMetric },
    byLocation: { [MentionShareNoLocationBucket]: mentionShareObservationMetric },
  },
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

describe('mentionShareBucketMetricSchema', () => {
  it('round-trips a bucket-level mention share metric', () => {
    expect(() => mentionShareBucketMetricSchema.parse(bucket.mentionShare)).not.toThrow()
  })

  it('allows null rate when no competitive brand mentions exist', () => {
    const parsed = mentionShareBucketMetricSchema.parse({
      rate: null,
      projectMentionEvents: 0,
      competitorMentionEvents: 0,
      projectMentionSnapshots: 0,
      competitorMentionSnapshots: 0,
      brandMentionEvents: 0,
      answerObservations: 2,
      totalObservations: 2,
      byProvider: {},
      byLocation: {},
    })
    expect(parsed.rate).toBeNull()
    expect(parsed.projectMentionSnapshots).toBe(parsed.projectMentionEvents)
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

const categoryCount = {
  category: 'directory' as const,
  label: 'Directories & review sites',
  count: 6,
  percentage: 0.6,
  topDomains: [{ domain: 'yelp.com', count: 4 }, { domain: 'g2.com', count: 2 }],
}

const rankEntry = {
  domain: 'yelp.com',
  count: 4,
  percentage: 0.4,
  category: 'directory' as const,
  label: 'Yelp',
  surfaceClass: 'ota-aggregator' as const,
}

const surfaceClassCount = {
  surfaceClass: 'ota-aggregator' as const,
  label: 'Aggregators & marketplaces',
  count: 6,
  percentage: 0.6,
  domainCount: 2,
}

const rankedList = {
  totalCitedSlots: 10,
  domainTotal: 3,
  entries: [rankEntry],
  truncatedDomainCount: 2,
  truncatedCitedSlots: 6,
  bySurfaceClass: [surfaceClassCount],
}

describe('sources DTO schemas', () => {
  it('round-trips a category count', () => {
    expect(() => sourceCategoryCountSchema.parse(categoryCount)).not.toThrow()
  })

  it('round-trips a ranked entry carrying its surface class', () => {
    const parsed = sourceRankEntrySchema.parse(rankEntry)
    expect(parsed.surfaceClass).toBe('ota-aggregator')
    expect(parsed.category).toBe('directory')
  })

  it('rejects a ranked entry with an unknown surface class', () => {
    expect(() => sourceRankEntrySchema.parse({ ...rankEntry, surfaceClass: 'partner' })).toThrow()
  })

  it('round-trips a surface-class roll-up', () => {
    expect(() => surfaceClassCountSchema.parse(surfaceClassCount)).not.toThrow()
  })

  it('round-trips a ranked source list with long-tail rollup fields', () => {
    const parsed = rankedSourceListSchema.parse(rankedList)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.truncatedCitedSlots).toBe(6)
    expect(parsed.bySurfaceClass[0]!.surfaceClass).toBe('ota-aggregator')
  })

  it('round-trips a full SourceBreakdownDto with ranked + byProvider + limit', () => {
    const parsed = sourceBreakdownDtoSchema.parse({
      overall: [categoryCount],
      byQuery: { 'best crm': [categoryCount] },
      ranked: rankedList,
      byProvider: { gemini: rankedList, openai: rankedList },
      runId: 'run_1',
      window: 'all',
      limit: 5,
    })
    expect(Object.keys(parsed.byProvider).sort()).toEqual(['gemini', 'openai'])
    expect(parsed.limit).toBe(5)
    expect(parsed.ranked.entries[0]!.domain).toBe('yelp.com')
  })

  it('accepts a null limit (full ranked list)', () => {
    const parsed = sourceBreakdownDtoSchema.parse({
      overall: [],
      byQuery: {},
      ranked: { totalCitedSlots: 0, domainTotal: 0, entries: [], truncatedDomainCount: 0, truncatedCitedSlots: 0, bySurfaceClass: [] },
      byProvider: {},
      runId: '',
      window: 'all',
      limit: null,
    })
    expect(parsed.limit).toBeNull()
  })
})
