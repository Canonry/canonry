import { describe, it, expect } from 'vitest'
import {
  MODEL_ATTRIBUTION_EVENT_LIMIT,
  modelIdsEquivalent,
  normalizeModelId,
  mentionShareBucketMetricSchema,
  modelEvidenceStateSchema,
  modelAttributionSchema,
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

const bucket = {
  startDate: '2026-04-01T00:00:00.000Z',
  endDate: '2026-04-08T00:00:00.000Z',
  citationRate: 0.5,
  cited: 2,
  total: 4,
  queryCount: 2,
  mentionRate: 0.75,
  mentionedCount: 3,
  mentionShare: { rate: 0.6, projectMentionSnapshots: 3, competitorMentionSnapshots: 2 },
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

describe('model attribution schemas', () => {
  it('represents known, unknown, and canonical mixed evidence', () => {
    expect(modelEvidenceStateSchema.parse({ status: 'known', model: 'gpt-5.5' })).toEqual({
      status: 'known',
      model: 'gpt-5.5',
    })
    expect(modelEvidenceStateSchema.parse({ status: 'unknown' })).toEqual({ status: 'unknown' })
    expect(modelEvidenceStateSchema.parse({
      status: 'mixed',
      models: ['claude-opus-5', 'claude-sonnet-5'],
      includesUnknown: false,
    })).toEqual({
      status: 'mixed',
      models: ['claude-opus-5', 'claude-sonnet-5'],
      includesUnknown: false,
    })
  })

  it('rejects non-canonical mixed evidence', () => {
    expect(() => modelEvidenceStateSchema.parse({
      status: 'mixed',
      models: ['claude-sonnet-5', 'claude-opus-5'],
      includesUnknown: false,
    })).toThrow()
    expect(() => modelEvidenceStateSchema.parse({
      status: 'mixed',
      models: ['claude-sonnet-5', 'claude-sonnet-5'],
      includesUnknown: false,
    })).toThrow()
  })

  it('round-trips window-scoped observations and first-observed events', () => {
    expect(modelAttributionSchema.parse({
      claude: {
        latestObservation: {
          observedAt: '2026-07-14T12:00:00.000Z',
          state: { status: 'known', model: 'claude-sonnet-5' },
        },
        events: [{
          observedAt: '2026-03-20T12:00:00.000Z',
          bucketStartDate: '2026-03-01T00:00:00.000Z',
          from: { status: 'known', model: 'claude-opus-5' },
          to: { status: 'known', model: 'claude-sonnet-5' },
        }],
      },
    })).toEqual({
      claude: {
        latestObservation: {
          observedAt: '2026-07-14T12:00:00.000Z',
          state: { status: 'known', model: 'claude-sonnet-5' },
        },
        events: [{
          observedAt: '2026-03-20T12:00:00.000Z',
          bucketStartDate: '2026-03-01T00:00:00.000Z',
          from: { status: 'known', model: 'claude-opus-5' },
          to: { status: 'known', model: 'claude-sonnet-5' },
        }],
      },
    })
  })

  it('carries the anchor flag and the pre-truncation event total', () => {
    const parsed = modelAttributionSchema.parse({
      perplexity: {
        latestObservation: {
          observedAt: '2026-07-15T12:00:00.000Z',
          state: { status: 'known', model: 'sonar-pro' },
        },
        events: [{
          observedAt: '2026-07-15T12:00:00.000Z',
          bucketStartDate: '2026-07-15T00:00:00.000Z',
          from: { status: 'known', model: 'sonar' },
          to: { status: 'known', model: 'sonar-pro' },
          fromPreWindowAnchor: true,
        }],
        eventTotal: 84,
      },
    })
    expect(parsed.perplexity!.events[0]!.fromPreWindowAnchor).toBe(true)
    // The total outruns the returned list, so a consumer can report the gap.
    expect(parsed.perplexity!.eventTotal).toBe(84)
    expect(MODEL_ATTRIBUTION_EVENT_LIMIT).toBeGreaterThan(0)
  })

  it('accepts an older server response with neither field', () => {
    const parsed = modelAttributionSchema.parse({
      claude: {
        latestObservation: {
          observedAt: '2026-07-14T12:00:00.000Z',
          state: { status: 'unknown' },
        },
        events: [],
      },
    })
    expect(parsed.claude!.eventTotal).toBeUndefined()
    expect(parsed.claude!.anchorUnavailable).toBeUndefined()
  })

  it('closes the date range on an anchor-derived transition', () => {
    const parsed = modelAttributionSchema.parse({
      perplexity: {
        latestObservation: {
          observedAt: '2026-07-15T12:00:00.000Z',
          state: { status: 'known', model: 'sonar-pro' },
        },
        events: [{
          observedAt: '2026-07-15T12:00:00.000Z',
          bucketStartDate: '2026-07-15T00:00:00.000Z',
          from: { status: 'known', model: 'sonar' },
          to: { status: 'known', model: 'sonar-pro' },
          fromPreWindowAnchor: true,
          anchorObservedAt: '2026-03-17T12:00:00.000Z',
        }],
        eventTotal: 1,
      },
    })
    // Bounded on both sides: the change happened after the anchor sweep and on
    // or before `observedAt`, so it is never presented as an in-window event.
    expect(parsed.perplexity!.events[0]!.anchorObservedAt).toBe('2026-03-17T12:00:00.000Z')
  })

  it('marks a provider whose pre-window history could not be resolved', () => {
    const parsed = modelAttributionSchema.parse({
      gemini: {
        latestObservation: {
          observedAt: '2026-07-15T12:00:00.000Z',
          state: { status: 'known', model: 'gemini-2.5-flash' },
        },
        events: [],
        eventTotal: 0,
        anchorUnavailable: true,
      },
    })
    // An empty event list plus this flag means "we did not look far enough",
    // which a consumer must not render as "no model change".
    expect(parsed.gemini!.anchorUnavailable).toBe(true)
  })
})

describe('mentionShareBucketMetricSchema', () => {
  it('round-trips a bucket-level mention share metric', () => {
    expect(() => mentionShareBucketMetricSchema.parse(bucket.mentionShare)).not.toThrow()
  })

  it('allows null rate when no competitive brand mentions exist', () => {
    const parsed = mentionShareBucketMetricSchema.parse({
      rate: null,
      projectMentionSnapshots: 0,
      competitorMentionSnapshots: 0,
    })
    expect(parsed.rate).toBeNull()
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

describe('normalizeModelId', () => {
  it('strips a dated snapshot suffix — a dated snapshot IS the same model', () => {
    expect(normalizeModelId('gpt-5.4-2026-03-05')).toBe('gpt-5.4')
    expect(normalizeModelId('gpt-4o-2024-08-06')).toBe('gpt-4o')
    // The compact form providers also ship.
    expect(normalizeModelId('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet')
  })

  it('preserves a capability tier — a different model at a different price', () => {
    expect(normalizeModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(normalizeModelId('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(normalizeModelId('gpt-5.6-luna')).toBe('gpt-5.6-luna')
  })

  it('preserves an UNKNOWN suffix rather than silently swallowing it', () => {
    // The rule is derived from the date shape, not an allow-list of tier names,
    // so a tier nobody has seen yet survives and shows up as a real change.
    expect(normalizeModelId('gpt-6-quasar')).toBe('gpt-6-quasar')
    expect(normalizeModelId('gpt-6-2026')).toBe('gpt-6-2026')
    expect(normalizeModelId('gpt-6-v2')).toBe('gpt-6-v2')
    // Date-SHAPED but not a plausible date.
    expect(normalizeModelId('gpt-6-2026-13-45')).toBe('gpt-6-2026-13-45')
    // Never normalize an id away to nothing.
    expect(normalizeModelId('-2026-03-05')).toBe('-2026-03-05')
  })

  it('treats a dated snapshot as equivalent and a tier as different', () => {
    expect(modelIdsEquivalent('gpt-5.4', 'gpt-5.4-2026-03-05')).toBe(true)
    expect(modelIdsEquivalent('gpt-5.6', 'gpt-5.6-sol')).toBe(false)
  })
})
