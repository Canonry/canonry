import { describe, it, expect } from 'vitest'
import { compileQueryClassifier } from '@ainyc/canonry-contracts'
import type { BrandMetricsDto, ModelAttribution, ModelEvidenceState, ModelPointerChangeDisclosure } from '@ainyc/canonry-contracts'
import {
  buildMentionShareTrendRows,
  buildSelectedTrendRows,
  buildTrendRows,
  partitionModelAttributionEvents,
  truncatedProviderCounts,
  formatMixedModels,
  formatModelEvidence,
  groupModelAttributionEvents,
  isPerplexityPreset,
  modelChangeRows,
  querySetChanges,
  pointQuerySetShift,
  querySetShift,
  readBasketChanges,
  readModelPointerChanges,
  readBucketModelEvidence,
  readModelAttribution,
  readServedModelAttribution,
  showsChangeFigure,
  substitutedModels,
  sweepBefore,
  formatBucketDateTick,
  formatObservedDay,
  trendToTone,
  whatChangedSummary,
  latestProviderRate,
  metricWindowChange,
  plottedMetricRates,
  CITED_KEY,
  MENTION_SHARE_KEY,
  MENTIONED_KEY,
  normalizeProviderKey,
} from '../src/lib/visibility-trend-helpers.js'
import { observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { AINYC_SWEEP_TIMES, ainycMetrics } from './ainyc-visibility-fixture.js'

function provider(citationRate: number, mentionRate: number) {
  return { citationRate, cited: 0, total: 4, mentionRate, mentionedCount: 0 }
}

function bucket(date: string, byProvider: BrandMetricsDto['buckets'][number]['byProvider'], rates = { citationRate: 0.5, mentionRate: 0.25 }) {
  return {
    startDate: date,
    endDate: date,
    citationRate: rates.citationRate,
    cited: 2,
    total: 4,
    queryCount: 4,
    mentionRate: rates.mentionRate,
    mentionedCount: 1,
    mentionShare: { scope: 'non-brand', rate: 0.6, projectMentionSnapshots: 3, competitorMentionSnapshots: 2 },
    byProvider,
  }
}

function dto(buckets: BrandMetricsDto['buckets']): BrandMetricsDto {
  return {
    window: 'all',
    mentionShareScope: 'non-brand',
    buckets,
    overall: provider(0.5, 0.25),
    byProvider: {},
    trend: 'stable',
    mentionTrend: 'stable',
    queryChanges: [],
  }
}

describe('buildTrendRows — overall mode', () => {
  it('plots the single metric the toggle selects (cited / mentioned), 0-100', () => {
    const d = dto([
      bucket('2026-04-01', { gemini: provider(0.25, 0.1) }, { citationRate: 0.25, mentionRate: 0.1 }),
      bucket('2026-04-08', { gemini: provider(0.5, 0.4) }, { citationRate: 0.5, mentionRate: 0.4 }),
    ])

    const cited = buildTrendRows(d, 'cited', 'overall')
    expect(cited.series).toEqual([CITED_KEY])
    expect(cited.rows.map(r => r[CITED_KEY])).toEqual([25, 50])
    expect(cited.rows[0]![MENTIONED_KEY]).toBeUndefined()

    const mentioned = buildTrendRows(d, 'mentioned', 'overall')
    expect(mentioned.series).toEqual([MENTIONED_KEY])
    expect(mentioned.rows.map(r => r[MENTIONED_KEY])).toEqual([10, 40])
    expect(mentioned.rows[0]![CITED_KEY]).toBeUndefined()
  })

  it('rounds to one decimal place', () => {
    const d = dto([bucket('2026-04-01', { gemini: provider(1 / 3, 0) }, { citationRate: 1 / 3, mentionRate: 0 })])
    expect(buildTrendRows(d, 'cited', 'overall').rows[0]![CITED_KEY]).toBe(33.3)
  })
})

describe('buildTrendRows — byProvider mode', () => {
  it('returns the sorted union of providers across all buckets', () => {
    const d = dto([
      bucket('2026-04-01', { openai: provider(0.5, 0.5), gemini: provider(0.25, 0.25) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5), claude: provider(1, 1) }),
    ])
    expect(buildTrendRows(d, 'cited', 'byProvider').series).toEqual(['claude', 'gemini', 'openai'])
  })

  it('emits null for a provider absent from a bucket (so the line bridges the gap)', () => {
    const d = dto([
      bucket('2026-04-01', { gemini: provider(0.5, 0.5) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5), claude: provider(1, 1) }),
    ])
    const { rows } = buildTrendRows(d, 'cited', 'byProvider')
    expect(rows[0]!.claude).toBeNull()
    expect(rows[0]!.gemini).toBe(50)
    expect(rows[1]!.claude).toBe(100)
    expect(rows[1]!.gemini).toBe(75)
  })

  it('selects the mention rate when metric is mentioned', () => {
    const d = dto([bucket('2026-04-01', { gemini: provider(0.5, 0.2) })])
    expect(buildTrendRows(d, 'mentioned', 'byProvider').rows[0]!.gemini).toBe(20)
  })

  it('degrades to no provider lines when buckets omit byProvider (older backend ≤4.67.0)', () => {
    // A backend that predates the per-bucket breakdown returns buckets with no
    // `byProvider` key. The helper must not throw on Object.keys(undefined).
    const legacy = {
      window: 'all' as const,
      buckets: [
        { startDate: '2026-04-01', endDate: '2026-04-08', citationRate: 0.2, cited: 1, total: 5, queryCount: 5, mentionRate: 0.4, mentionedCount: 2 },
      ],
      overall: provider(0.2, 0.4),
      byProvider: {},
      trend: 'stable' as const,
      mentionTrend: 'stable' as const,
      queryChanges: [],
    } as unknown as BrandMetricsDto

    const res = buildTrendRows(legacy, 'cited', 'byProvider')
    expect(res.series).toEqual([])
    expect(res.hasData).toBe(true)
    expect(res.rows).toEqual([{ date: '2026-04-01' }])
  })
})

describe('buildTrendRows — data flags', () => {
  it('reports no data for empty buckets without throwing', () => {
    const res = buildTrendRows(dto([]), 'cited', 'overall')
    expect(res.rows).toEqual([])
    expect(res.hasData).toBe(false)
    expect(res.singleBucket).toBe(false)
  })

  it('flags a single bucket', () => {
    const res = buildTrendRows(dto([bucket('2026-04-01', { gemini: provider(0.5, 0.5) })]), 'cited', 'overall')
    expect(res.hasData).toBe(true)
    expect(res.singleBucket).toBe(true)
  })
})

describe('model attribution helpers', () => {
  it('normalizes provider keys so trend series can join analytics evidence safely', () => {
    expect(normalizeProviderKey(' Gemini ')).toBe('gemini')
  })

  it('formats known, unknown, and mixed evidence without pretending mixed evidence is a selected model', () => {
    expect(formatModelEvidence({ status: 'known', model: 'gemini-2.5-flash' })).toBe('gemini-2.5-flash')
    expect(formatModelEvidence({ status: 'unknown' })).toBe('Unknown model')
    expect(formatModelEvidence({ status: 'mixed', models: ['gpt-5', 'gpt-5-mini'], includesUnknown: true }))
      .toBe('gpt-5, gpt-5-mini and an unknown model')
    expect(formatModelEvidence({ status: 'mixed', models: ['gpt-5', 'gpt-5-mini'], includesUnknown: false }))
      .toBe('gpt-5, gpt-5-mini')
  })

  it('words a mixed point as a phrase for its Details line', () => {
    expect(formatMixedModels({ status: 'mixed', models: ['a', 'b'], includesUnknown: false })).toBe('a and b')
    expect(formatMixedModels({ status: 'mixed', models: ['a', 'b'], includesUnknown: true })).toBe('a, b and an unknown model')
    expect(formatMixedModels({ status: 'mixed', models: ['a'], includesUnknown: true })).toBe('a and an unknown model')
  })

  it('distinguishes an older analytics payload from an observed unknown model', () => {
    const legacy = bucket('2026-04-01', { gemini: provider(0.25, 0.1) }) as unknown as BrandMetricsDto['buckets'][number]
    expect(readBucketModelEvidence(legacy)).toBeNull()

    const observed = {
      ...legacy,
      modelEvidenceByProvider: { gemini: { status: 'unknown' } satisfies ModelEvidenceState },
    }
    expect(readBucketModelEvidence(observed)).toEqual({ gemini: { status: 'unknown' } })

    const legacyDto = dto([legacy]) as unknown as BrandMetricsDto
    expect(readModelAttribution(legacyDto)).toBeNull()
    const currentDto = { ...legacyDto, modelAttribution: {} satisfies ModelAttribution }
    expect(readModelAttribution(currentDto)).toEqual({})
  })

  it('groups categorical evidence changes by existing trend bucket for chart markers and summaries', () => {
    const events = groupModelAttributionEvents({
      gemini: {
        latestObservation: { observedAt: '2026-04-08T09:00:00.000Z', state: { status: 'known', model: 'gemini-2.5-flash' } },
        events: [{
          observedAt: '2026-04-08T09:00:00.000Z',
          bucketStartDate: '2026-04-08',
          from: { status: 'known', model: 'gemini-2.0-flash' },
          to: { status: 'known', model: 'gemini-2.5-flash' },
        }],
      },
    })

    expect(events).toEqual([{
      bucketStartDate: '2026-04-08',
      events: [{ provider: 'gemini', event: {
        observedAt: '2026-04-08T09:00:00.000Z',
        bucketStartDate: '2026-04-08',
        from: { status: 'known', model: 'gemini-2.0-flash' },
        to: { status: 'known', model: 'gemini-2.5-flash' },
      } }],
    }])
  })
})

describe('buildMentionShareTrendRows', () => {
  it('plots bucket mention share as percentages', () => {
    const d = dto([
      { ...bucket('2026-04-01', { gemini: provider(0.25, 0.1) }), mentionShare: { scope: 'non-brand' as const, rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 } },
      { ...bucket('2026-04-08', { gemini: provider(0.5, 0.4) }), mentionShare: { scope: 'non-brand' as const, rate: 0.75, projectMentionSnapshots: 3, competitorMentionSnapshots: 1 } },
    ])

    const res = buildMentionShareTrendRows(d)
    expect(res.series).toEqual([MENTION_SHARE_KEY])
    expect(res.rows.map(r => r[MENTION_SHARE_KEY])).toEqual([25, 75])
    expect(res.hasData).toBe(true)
  })

  it('emits null when a bucket has no competitive brand mentions', () => {
    const d = dto([
      { ...bucket('2026-04-01', { gemini: provider(0.25, 0.1) }), mentionShare: { scope: 'non-brand' as const, rate: null, projectMentionSnapshots: 0, competitorMentionSnapshots: 0 } },
      { ...bucket('2026-04-08', { gemini: provider(0.5, 0.4) }), mentionShare: { scope: 'non-brand' as const, rate: 0.5, projectMentionSnapshots: 1, competitorMentionSnapshots: 1 } },
    ])

    const res = buildMentionShareTrendRows(d)
    expect(res.rows[0]![MENTION_SHARE_KEY]).toBeNull()
    expect(res.rows[1]![MENTION_SHARE_KEY]).toBe(50)
    expect(res.singleBucket).toBe(true)
  })
})

describe('buildSelectedTrendRows', () => {
  it('delegates mentioned and cited metrics to the presence trend builder', () => {
    const d = dto([
      bucket('2026-04-01', { gemini: provider(0.25, 0.1) }, { citationRate: 0.25, mentionRate: 0.1 }),
    ])

    expect(buildSelectedTrendRows(d, 'mentioned', 'overall')).toEqual(buildTrendRows(d, 'mentioned', 'overall'))
    expect(buildSelectedTrendRows(d, 'cited', 'byProvider')).toEqual(buildTrendRows(d, 'cited', 'byProvider'))
  })

  it('uses mention-share rows regardless of requested series mode', () => {
    const d = dto([
      { ...bucket('2026-04-01', { gemini: provider(0.25, 0.1) }), mentionShare: { scope: 'non-brand' as const, rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 } },
    ])

    expect(buildSelectedTrendRows(d, 'mentionShare', 'byProvider')).toEqual(buildMentionShareTrendRows(d))
  })
})

describe('latestProviderRate', () => {
  it('returns the API rate behind the right end of the line, unrounded', () => {
    const d = dto([
      bucket('2026-04-01', { gemini: provider(0.25, 0.1), openai: provider(0.5, 0.4) }),
      bucket('2026-04-08', { gemini: provider(0.7504, 0.5) }),
    ])
    // gemini is in both buckets → its latest cited rate is bucket 2's. The
    // chart row for that point is rounded to the axis (75); the rate is not.
    expect(buildTrendRows(d, 'cited', 'byProvider').rows[1]!.gemini).toBe(75)
    expect(latestProviderRate(d, 'gemini', 'cited')).toBe(0.7504)
    expect(latestProviderRate(d, 'gemini', 'mentioned')).toBe(0.5)
  })

  it('skips buckets the engine is missing from, so the value matches the visible line end', () => {
    const d = dto([
      bucket('2026-04-01', { openai: provider(0.5, 0.4) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5) }),
    ])
    // openai only has data in bucket 1; its bucket 2 row is null. Latest = 0.5, not null.
    expect(buildTrendRows(d, 'cited', 'byProvider').rows[1]!.openai).toBeNull()
    expect(latestProviderRate(d, 'openai', 'cited')).toBe(0.5)
  })

  it('returns null for an engine that never appears', () => {
    const d = dto([bucket('2026-04-01', { gemini: provider(0.5, 0.5) })])
    expect(latestProviderRate(d, 'claude', 'cited')).toBeNull()
  })

  it('returns null for empty buckets', () => {
    expect(latestProviderRate(dto([]), 'gemini', 'cited')).toBeNull()
  })
})

describe('plottedMetricRates', () => {
  it('returns each bucket overall rate for the selected presence metric, oldest first and unrounded', () => {
    const d = dto([
      bucket('2026-04-01', {}, { citationRate: 0.0004, mentionRate: 0.3333 }),
      bucket('2026-04-08', {}, { citationRate: 0.9996, mentionRate: 0 }),
    ])
    // The chart rows round these to the axis (0 and 100); the rates keep what
    // the API sent, so text can still read <0.1% and >99.9%.
    expect(buildTrendRows(d, 'cited', 'overall').rows.map(row => row[CITED_KEY])).toEqual([0, 100])
    expect(plottedMetricRates(d, 'cited')).toEqual([0.0004, 0.9996])
    expect(plottedMetricRates(d, 'mentioned')).toEqual([0.3333, 0])
  })

  it('returns only the buckets that plot a mention-share point', () => {
    const d = dto([
      { ...bucket('2026-04-01', {}), mentionShare: { scope: 'non-brand' as const, rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 } },
      { ...bucket('2026-04-08', {}), mentionShare: { scope: 'non-brand' as const, rate: null, projectMentionSnapshots: 0, competitorMentionSnapshots: 0 } },
      { ...bucket('2026-04-15', {}), mentionShare: { scope: 'non-brand' as const, rate: 0.6667, projectMentionSnapshots: 2, competitorMentionSnapshots: 1 } },
    ])
    const plotted = buildMentionShareTrendRows(d).rows.filter(row => typeof row[MENTION_SHARE_KEY] === 'number')
    expect(plottedMetricRates(d, 'mentionShare')).toEqual([0.25, 0.6667])
    expect(plotted).toHaveLength(plottedMetricRates(d, 'mentionShare').length)
  })

  it('returns nothing for empty buckets', () => {
    expect(plottedMetricRates(dto([]), 'cited')).toEqual([])
    expect(plottedMetricRates(dto([]), 'mentionShare')).toEqual([])
  })
})

describe('metricWindowChange', () => {
  it('selects the server change for the chosen series and never subtracts the bucket rates', () => {
    const d = {
      ...dto([
        bucket('2026-04-01', {}, { citationRate: 0.25, mentionRate: 0.5 }),
        bucket('2026-04-08', {}, { citationRate: 0.75, mentionRate: 0.5 }),
      ]),
      // Deliberately unlike the buckets' own difference (+0.5 cited).
      windowChange: {
        citationRate: { first: 0.25, latest: 0.75, delta: 0.1234 },
        mentionRate: { first: 0.5, latest: 0.5, delta: 0 },
        mentionShare: null,
      },
    }
    expect(metricWindowChange(d, 'cited')).toEqual({ first: 0.25, latest: 0.75, delta: 0.1234 })
    expect(metricWindowChange(d, 'mentioned')).toEqual({ first: 0.5, latest: 0.5, delta: 0 })
    expect(metricWindowChange(d, 'mentionShare')).toBeNull()
  })

  it('reads no change, never a zero, from a response without the field', () => {
    const d = dto([bucket('2026-04-01', {}), bucket('2026-04-08', {})])
    expect(metricWindowChange(d, 'cited')).toBeNull()
    expect(metricWindowChange(d, 'mentionShare')).toBeNull()
  })
})

describe('trendToTone', () => {
  it('maps direction to tone', () => {
    expect(trendToTone('improving')).toBe('positive')
    expect(trendToTone('declining')).toBe('negative')
    expect(trendToTone('stable')).toBe('neutral')
  })
})

describe('partitionModelAttributionEvents', () => {
  const latestObservation = {
    observedAt: '2026-04-08T09:00:00.000Z',
    state: { status: 'known', model: 'gemini-2.5-flash' },
  } as const

  it('keeps a change inherited from before the window OUT of the plotted buckets', () => {
    // The 7d window is the worst case: every bucket is one day, so an anchored
    // change lands on the very first plotted day and a chart marker there tells
    // the operator the model changed on a date it may not have.
    const partition = partitionModelAttributionEvents({
      gemini: {
        latestObservation,
        events: [{
          observedAt: '2026-04-02T09:00:00.000Z',
          bucketStartDate: '2026-04-02',
          from: { status: 'known', model: 'gemini-2.0-flash' },
          to: { status: 'known', model: 'gemini-2.5-flash' },
          fromPreWindowAnchor: true,
          anchorObservedAt: '2026-03-20T09:00:00.000Z',
        }],
      },
    })

    // Nothing to mark on the chart…
    expect(partition.buckets).toEqual([])
    // …but the change is NOT lost: it is listed with its closed date range.
    expect(partition.beforeWindow).toHaveLength(1)
    expect(partition.beforeWindow[0]!.provider).toBe('gemini')
    expect(partition.beforeWindow[0]!.event.anchorObservedAt).toBe('2026-03-20T09:00:00.000Z')
  })

  it('separates the two kinds when a provider has both', () => {
    const partition = partitionModelAttributionEvents({
      gemini: {
        latestObservation,
        events: [
          {
            observedAt: '2026-04-02T09:00:00.000Z',
            bucketStartDate: '2026-04-02',
            from: { status: 'known', model: 'gemini-2.0-flash' },
            to: { status: 'known', model: 'gemini-2.5-flash' },
            fromPreWindowAnchor: true,
          },
          {
            observedAt: '2026-04-08T09:00:00.000Z',
            bucketStartDate: '2026-04-08',
            from: { status: 'known', model: 'gemini-2.5-flash' },
            to: { status: 'unknown' },
          },
        ],
      },
    })

    expect(partition.buckets.map(bucket => bucket.bucketStartDate)).toEqual(['2026-04-08'])
    expect(partition.beforeWindow.map(row => row.event.observedAt)).toEqual(['2026-04-02T09:00:00.000Z'])
  })

  it('leaves an all-in-window attribution grouped exactly as before', () => {
    const attribution = {
      gemini: {
        latestObservation,
        events: [{
          observedAt: '2026-04-08T09:00:00.000Z',
          bucketStartDate: '2026-04-08',
          from: { status: 'known', model: 'gemini-2.0-flash' },
          to: { status: 'known', model: 'gemini-2.5-flash' },
        }],
      },
    } as const
    expect(partitionModelAttributionEvents(attribution).buckets)
      .toEqual(groupModelAttributionEvents(attribution))
    expect(partitionModelAttributionEvents(attribution).beforeWindow).toEqual([])
  })
})

describe('truncatedProviderCounts', () => {
  it('names only the providers whose own list the server capped', () => {
    const event = {
      observedAt: '2026-04-08T09:00:00.000Z',
      bucketStartDate: '2026-04-08',
      from: { status: 'known', model: 'a' },
      to: { status: 'known', model: 'b' },
    } as const
    const latestObservation = { observedAt: '2026-04-08T09:00:00.000Z', state: { status: 'known', model: 'b' } } as const

    // A pooled "showing 6 of 44" would imply openai and claude are clipped too.
    expect(truncatedProviderCounts({
      gemini: { latestObservation, events: [event, event], eventTotal: 40 },
      openai: { latestObservation, events: [event], eventTotal: 1 },
      claude: { latestObservation, events: [event, event, event] },
    })).toEqual([{ provider: 'gemini', shown: 2, total: 40 }])

    expect(truncatedProviderCounts({})).toEqual([])
  })
})

describe('readModelPointerChanges', () => {
  const metrics = (extra?: Record<string, unknown>) =>
    ({ ...dto([]), ...extra }) as unknown as BrandMetricsDto

  // Partial on purpose: this reader must pass through whatever the server sent,
  // including a response from a build that predates some of these fields.
  const openaiChange = {
    modelIds: ['chat-latest'],
    changeCount: 1,
    unverifiedChangeCount: 0,
    firstChangeDate: '2026-06-24',
    lastChangeDate: '2026-06-24',
  } as unknown as ModelPointerChangeDisclosure

  it('reads nothing from an older API and nothing from a project on fixed model ids', () => {
    expect(readModelPointerChanges(metrics())).toEqual({})
    expect(readModelPointerChanges(metrics({ modelPointerChanges: {} }))).toEqual({})
  })

  it('passes the server disclosures through untouched', () => {
    expect(readModelPointerChanges(metrics({ modelPointerChanges: { openai: openaiChange } })))
      .toEqual({ openai: openaiChange })
  })
})

// ── What changed and the change figure, on ainyc's stored responses ──

const NOW = new Date('2026-09-29T14:00:00.000Z')
const ainyc = (window: 'all' | '7d') => ainycMetrics(window) as unknown as BrandMetricsDto
const classify = (text: string) => compileQueryClassifier(['Canonry'])?.classify(text) ?? null
const known = (model: string) => ({ status: 'known', model }) as const

/**
 * GET /analytics/metrics for a project whose query set went {a, b} (revision
 * 1, Sep 20) to {a, b, c} (revision 2, Sep 28). The Sep 28 sweep was partial:
 * every engine failed on "b", so it stored answers for a and c only. A point's
 * `queryCount` is the queries WITH ANSWERS in it (analytics.ts), 2 and 2 here,
 * while the query set held 2 and then 3.
 */
function partialSweepAfterAdd(): BrandMetricsDto {
  const point = (day: string, revision: number) => ({
    startDate: `2026-09-${day}T00:00:00.000Z`, endDate: `2026-09-${day}T23:59:59.999Z`,
    dataStartDate: `2026-09-${day}T12:00:00.000Z`, dataEndDate: `2026-09-${day}T12:00:00.000Z`, sweepCount: 1,
    citationRate: 0.5, cited: 2, total: 4, queryCount: 2, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: { scope: 'non-brand' as const, rate: null, projectMentionSnapshots: 2, competitorMentionSnapshots: 0 },
    byProvider: { gemini: { citationRate: 0.5, cited: 1, total: 2, mentionRate: 0.5, mentionedCount: 1 }, openai: { citationRate: 0.5, cited: 1, total: 2, mentionRate: 0.5, mentionedCount: 1 } },
    modelEvidenceByProvider: {}, basketRevision: revision,
  })
  return {
    ...dto([point('20', 1), point('28', 2)]),
    windowChange: { citationRate: { first: 0.5, latest: 0.5, delta: 0 }, mentionRate: { first: 0.5, latest: 0.5, delta: 0 }, mentionShare: null },
    basketChanges: [{ revision: 2, at: '2026-09-28T12:00:00.000Z', added: ['c'], removed: [] }],
    referenceBasketRevision: 2,
  } as BrandMetricsDto
}

describe('querySetChanges', () => {
  it('reads ainyc\'s Sep 29 change as recorded, with no query count', () => {
    expect(querySetChanges(ainyc('all'))).toEqual([{
      at: '2026-09-29T09:59:38.415Z',
      added: ['canonry', 'canonry aeo agency', 'canonry reviews'],
      removed: [],
    }])
  })

  it('reads no count from the queries a partial sweep happened to answer', () => {
    // The set went from 2 queries to 3, but each point answered 2. Counting
    // back from the latest point's answered queries would print 1 to 2.
    expect(querySetChanges(partialSweepAfterAdd())).toEqual([{ at: '2026-09-28T12:00:00.000Z', added: ['c'], removed: [] }])
  })

  it('reads no count while the first sweep on the new set has not become a point', () => {
    // A change is recorded when its sweep is queued; a running, failed or
    // cancelled sweep never becomes a point, so the latest point is the old set.
    const metrics = partialSweepAfterAdd()
    expect(querySetChanges({ ...metrics, buckets: metrics.buckets.slice(0, 1) })).toEqual([{ at: '2026-09-28T12:00:00.000Z', added: ['c'], removed: [] }])
  })

  it('lists every recorded change newest first, and none from an older API', () => {
    const metrics = {
      ...ainyc('all'),
      basketChanges: [
        { revision: 2, at: '2026-05-01T00:00:00.000Z', added: ['a'], removed: ['b', 'c'] },
        { revision: 3, at: '2026-09-29T09:59:38.415Z', added: ['x', 'y', 'z'], removed: [] },
      ],
    }
    expect(querySetChanges(metrics).map(change => [change.at, change.added, change.removed])).toEqual([
      ['2026-09-29T09:59:38.415Z', ['x', 'y', 'z'], []],
      ['2026-05-01T00:00:00.000Z', ['a'], ['b', 'c']],
    ])
    expect(readBasketChanges(dto([]))).toEqual([])
  })
})

describe('modelChangeRows', () => {
  it('lists ainyc\'s ten model changes newest first, with the preset\'s served move on its row', () => {
    const metrics = ainyc('all')
    const rows = modelChangeRows(readModelAttribution(metrics)!, readServedModelAttribution(metrics))
    expect(rows.map(row => [row.provider, row.at])).toEqual([
      ['claude', '2026-09-29T09:41:26.139Z'],
      ['gemini', '2026-09-29T09:41:26.139Z'],
      ['openai', '2026-09-29T09:41:26.139Z'],
      ['perplexity', '2026-09-29T09:41:26.139Z'],
      ['gemini', '2026-04-08T00:42:29.051Z'],
      ['gemini', '2026-03-26T23:45:36.350Z'],
      ['claude', '2026-03-20T22:20:16.712Z'],
      ['gemini', '2026-03-15T02:08:10.978Z'],
      ['claude', '2026-03-15T02:02:55.024Z'],
      ['openai', '2026-03-15T02:02:55.024Z'],
    ])
    const perplexity = rows.find(row => row.provider === 'perplexity')!
    expect([perplexity.from, perplexity.to]).toEqual([known('sonar'), known('fast')])
    expect(perplexity.served).toEqual({ from: known('sonar'), to: known('openai/gpt-6-luna') })
    // OpenAI's served series moved too, but only a preset's served model is news.
    expect(rows.filter(row => row.served !== null || row.reroute)).toEqual([perplexity])
    expect(rows.every(row => !row.onOrBefore && row.anchorAt === null)).toBe(true)
  })

  it('adds a preset\'s later re-route, which the configured series never shows', () => {
    const metrics = ainyc('all')
    const served = readServedModelAttribution(metrics)
    const reroute = { observedAt: '2026-10-06T09:00:00.000Z', bucketStartDate: '2026-09-10T00:00:00.000Z', from: known('openai/gpt-6-luna'), to: known('anthropic/claude-sonnet-5') }
    served.perplexity!.events.push(reroute)
    // A fixed model's served-only move is a substitution, shown as its amber row instead.
    served.openai!.events.push({ ...reroute, from: known('chat-latest'), to: known('gpt-6') })
    const rows = modelChangeRows(readModelAttribution(metrics)!, served)
    expect(rows[0]).toMatchObject({ provider: 'perplexity', at: reroute.observedAt, from: reroute.from, to: reroute.to, reroute: true, served: null })
    expect(rows.filter(row => row.reroute)).toHaveLength(1)
  })

  it('marks a change inherited from before the window, with its lower bound', () => {
    const metrics = ainyc('7d')
    const rows = modelChangeRows(readModelAttribution(metrics)!, readServedModelAttribution(metrics))
    expect(rows.map(row => [row.provider, row.onOrBefore, row.anchorAt])).toEqual([
      ['claude', true, '2026-07-14T06:00:00.016Z'],
      ['gemini', true, '2026-07-14T06:00:00.016Z'],
      ['openai', true, '2026-07-14T06:00:00.016Z'],
      ['perplexity', true, '2026-07-14T06:00:00.016Z'],
    ])
  })
})

describe('Perplexity presets (decision 5)', () => {
  it('treats a Perplexity id without "/" as a preset, and nothing else', () => {
    expect(isPerplexityPreset('perplexity', known('fast'))).toBe(true)
    expect(isPerplexityPreset(' Perplexity ', known('sonar'))).toBe(true)
    expect(isPerplexityPreset('perplexity', known('perplexity/sonar'))).toBe(false)
    expect(isPerplexityPreset('perplexity', { status: 'mixed', models: ['fast', 'low'], includesUnknown: false })).toBe(false)
    expect(isPerplexityPreset('openai', known('chat-latest'))).toBe(false)
  })

  it('keeps every substitution but a preset\'s', () => {
    const at = '2026-09-29T09:59:38.415Z'
    expect(substitutedModels({
      perplexity: { observedAt: at, configured: known('fast'), served: known('openai/gpt-6-luna') },
      openai: { observedAt: at, configured: known('gpt-5.6'), served: known('gpt-5.6-sol') },
    }).map(entry => entry.provider)).toEqual(['openai'])
    expect(substitutedModels({
      perplexity: { observedAt: at, configured: known('perplexity/sonar'), served: known('perplexity/sonar-pro') },
    }).map(entry => entry.provider)).toEqual(['perplexity'])
  })
})

describe('whatChangedSummary', () => {
  const rowsOf = (metrics: BrandMetricsDto) => modelChangeRows(readModelAttribution(metrics)!, readServedModelAttribution(metrics))

  it('names what ainyc\'s latest point first measured, on All and on 7 days', () => {
    for (const window of ['all', '7d'] as const) {
      const metrics = ainyc(window)
      expect(whatChangedSummary({ latest: metrics.buckets.at(-1), queryChanges: querySetChanges(metrics), modelRows: rowsOf(metrics), now: NOW }))
        .toBe('Sep 29 · 3 queries added · 4 new models')
    }
  })

  it('names the day of the newest change when the latest point brought nothing new', () => {
    const metrics = ainyc('all')
    const later = { ...metrics.buckets.at(-1)!, startDate: '2026-10-10T00:00:00.000Z', dataStartDate: '2026-10-12T09:00:00.000Z', dataEndDate: '2026-10-12T09:00:00.000Z', sweepCount: 1 }
    expect(whatChangedSummary({ latest: later, queryChanges: querySetChanges(metrics), modelRows: rowsOf(metrics), now: NOW }))
      .toBe('No changes since Sep 29')
  })

  it('counts removals and uses the singular, and is null with nothing to list', () => {
    const latest = ainyc('all').buckets.at(-1)!
    const at = latest.dataEndDate as string
    const row = { provider: 'openai', at, onOrBefore: false, anchorAt: null, from: known('a'), to: known('b'), served: null, reroute: false }
    expect(whatChangedSummary({
      latest,
      queryChanges: [{ at, added: ['x'], removed: ['y'] }] as Parameters<typeof whatChangedSummary>[0]['queryChanges'],
      modelRows: [row] as Parameters<typeof whatChangedSummary>[0]['modelRows'],
      now: NOW,
    })).toBe('Sep 29 · 1 query added · 1 query removed · 1 new model')
    expect(whatChangedSummary({ latest, queryChanges: [], modelRows: [], now: NOW })).toBeNull()
  })
})

describe('sweepBefore', () => {
  it('finds the sweep before ainyc\'s Sep 29 changes, probes already excluded', () => {
    expect(sweepBefore('2026-09-29T09:41:26.139Z', AINYC_SWEEP_TIMES, [])).toBe('2026-07-14T06:00:00.016Z')
  })

  it('falls back to the plotted points\' own sweeps, and is null with nothing earlier', () => {
    expect(sweepBefore('2026-09-29T09:41:26.139Z', [], ainyc('all').buckets)).toBe('2026-07-14T06:00:00.016Z')
    expect(sweepBefore('2026-03-01T00:00:00.000Z', AINYC_SWEEP_TIMES, ainyc('all').buckets)).toBeNull()
  })

  // Daily sweeps pooled into one point, Aug 31 to Sep 29 (30 sweeps).
  const day = (d: number) => new Date(Date.UTC(2026, 7, 31 + d, 6)).toISOString()
  const pooled = { ...bucket('2026-08-31', {}), dataStartDate: day(0), dataEndDate: day(29), sweepCount: 30 }

  it('leaves the date out when a change sits inside a pooled point, older than the recent sweeps', () => {
    // Sep 10's sweep before is Sep 9, which neither list holds; Aug 31 would be false.
    const recent = [day(25), day(26), day(27), day(28), day(29)]
    expect(sweepBefore(day(10), recent, [pooled])).toBeNull()
  })

  it('takes a point boundary only when nothing can sit between it and the change', () => {
    const next = { ...bucket('2026-09-30', {}), dataStartDate: day(30), dataEndDate: day(31), sweepCount: 2 }
    // The change opens its point: the point before ends on the adjacent sweep.
    expect(sweepBefore(day(30), [], [pooled, next])).toBe(day(29))
    // The change closes a two-sweep point: its first sweep is adjacent.
    expect(sweepBefore(day(31), [], [pooled, next])).toBe(day(30))
    // The window's first sweep: only the last sweep before the window is adjacent.
    expect(sweepBefore(day(0), [], [pooled], '2026-08-20T06:00:00.000Z')).toBe('2026-08-20T06:00:00.000Z')
    expect(sweepBefore(day(0), [], [pooled])).toBeNull()
  })
})

describe('day formats', () => {
  it('prints days in en-US whatever the browser locale, like the sweep times', () => {
    const locales: unknown[] = []
    const original = Date.prototype.toLocaleDateString
    Date.prototype.toLocaleDateString = function (this: Date, locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      locales.push(locale)
      return original.call(this, locale, options)
    }
    try {
      const latest = ainyc('all').buckets.at(-1)!
      expect(formatObservedDay(observedInstant('2026-09-29T09:59:00.000Z'), NOW)).toBe('Sep 29')
      expect(formatObservedDay(observedInstant('2025-09-29T09:59:00.000Z'), NOW)).toBe('Sep 29, 2025')
      // Mar 13 in New York, Mar 14 in UTC: the viewer's zone, in en-US.
      expect(formatBucketDateTick(ainyc('all').buckets[0]!)).toMatch(/^Mar 1[34]$/)
      expect(formatBucketDateTick(latest)).toBe('Sep 29')
    } finally {
      Date.prototype.toLocaleDateString = original
    }
    expect(locales.length).toBeGreaterThan(0)
    expect(locales.every(locale => locale === 'en-US')).toBe(true)
  })
})

/**
 * Queries a and b swept Jul 1 (a not cited, b cited). b was then deleted and a
 * swept Jul 5, cited. The server holds every point to the queries tracked now,
 * so both points read a alone: one query, three answers each, 0% then 100%.
 * Captured from the real route (analytics.ts) on these rows.
 */
function removalMetrics(): BrandMetricsDto {
  const point = (day: string, revision: number, rate: 0 | 1) => ({
    startDate: `2026-07-${day}T00:00:00.000Z`, endDate: `2026-07-${day}T23:59:59.999Z`,
    dataStartDate: `2026-07-${day}T09:00:00.000Z`, dataEndDate: `2026-07-${day}T09:00:00.000Z`, sweepCount: 1,
    citationRate: rate, cited: 3 * rate, total: 3, queryCount: 1, mentionRate: rate, mentionedCount: 3 * rate,
    mentionShare: { scope: 'non-brand' as const, rate: null, projectMentionSnapshots: 3 * rate, competitorMentionSnapshots: 0 },
    byProvider: Object.fromEntries(['claude', 'gemini', 'openai'].map(p => [p, { citationRate: rate, cited: rate, total: 1, mentionRate: rate, mentionedCount: rate }])),
    modelEvidenceByProvider: {}, basketRevision: revision,
  })
  return {
    ...dto([point('01', 1, 0), point('05', 2, 1)]),
    windowChange: { citationRate: { first: 0, latest: 1, delta: 1 }, mentionRate: { first: 0, latest: 1, delta: 1 }, mentionShare: null },
    basketChanges: [{ revision: 2, at: '2026-07-05T09:00:00.000Z', added: [], removed: ['query b'] }],
    referenceBasketRevision: 2,
  } as BrandMetricsDto
}

describe('the change figure (decision 3)', () => {
  it('drops ainyc\'s Mentioned and Cited change: 11 queries in the first point, 14 in the latest', () => {
    const metrics = ainyc('all')
    const shift = querySetShift(metrics.buckets, readBasketChanges(metrics))
    expect(shift).toEqual({
      changes: readBasketChanges(metrics),
      keys: ['canonry', 'canonry aeo agency', 'canonry reviews'],
      firstCount: 11,
      latestCount: 14,
    })
    expect(showsChangeFigure(shift, 'mentioned', 'non-brand', classify)).toBe(false)
    expect(showsChangeFigure(shift, 'cited', 'non-brand', classify)).toBe(false)
  })

  it('keeps mention share\'s change when every added query is branded, since it reads non-brand answers only', () => {
    const metrics = ainyc('all')
    const shift = querySetShift(metrics.buckets, readBasketChanges(metrics))
    expect(showsChangeFigure(shift, 'mentionShare', 'non-brand', classify)).toBe(true)
    // Pooled mention share reads branded answers too, and no classifier means no proof.
    expect(showsChangeFigure(shift, 'mentionShare', 'pooled', classify)).toBe(false)
    expect(showsChangeFigure(shift, 'mentionShare', 'non-brand')).toBe(false)
  })

  it('drops mention share\'s change when a non-brand query moved, or the count moved with no record', () => {
    const metrics = ainyc('all')
    const nonBrand = [{ revision: 2, at: '2026-09-29T09:59:38.415Z', added: ['canonry', 'aeo agency brooklyn'], removed: [] }]
    expect(showsChangeFigure(querySetShift(metrics.buckets, nonBrand), 'mentionShare', 'non-brand', classify)).toBe(false)
    const unrecorded = querySetShift(metrics.buckets, [])
    expect(unrecorded).toEqual({ changes: [], keys: [], firstCount: 11, latestCount: 14 })
    expect(showsChangeFigure(unrecorded, 'mentionShare', 'non-brand', classify)).toBe(false)
  })

  it('keeps the change with one point, a held query set, or a change before the first sweep', () => {
    const week = ainyc('7d')
    expect(querySetShift(week.buckets, readBasketChanges(week))).toBeNull()
    expect(showsChangeFigure(null, 'mentioned', 'non-brand', classify)).toBe(true)

    const held = ainyc('all').buckets.slice(0, 4)
    expect(querySetShift(held, [])).toBeNull()
    const atFirstSweep = [{ revision: 2, at: held[0]!.dataStartDate as string, added: ['x'], removed: [] }]
    expect(querySetShift(held, atFirstSweep)).toBeNull()
    const inside = [{ ...atFirstSweep[0]!, at: '2026-05-20T00:00:00.000Z' }]
    expect(querySetShift(held, inside)?.changes).toEqual(inside)
  })

  it('keeps the change after a query is removed: the server restates both points to the retained queries', () => {
    const metrics = removalMetrics()
    expect(metricWindowChange(metrics, 'cited')?.delta).toBe(1)
    const shift = querySetShift(metrics.buckets, readBasketChanges(metrics))
    expect(shift).toBeNull()
    expect(showsChangeFigure(shift, 'cited', 'non-brand', classify)).toBe(true)
    expect(showsChangeFigure(shift, 'mentioned', 'non-brand', classify)).toBe(true)
  })

  it('ignores a query added and removed again inside the window, which no point reads', () => {
    const metrics = removalMetrics()
    const churn = [
      { revision: 2, at: '2026-07-03T09:00:00.000Z', added: ['query c'], removed: [] },
      { revision: 3, at: '2026-07-05T09:00:00.000Z', added: [], removed: ['query c'] },
    ]
    expect(querySetShift(metrics.buckets, churn)).toBeNull()
  })

  it('still drops the change when a query removed in the window is tracked again after the latest point', () => {
    // Tracked now, so the server keeps it, but the Jul 5 point never swept it.
    const metrics = removalMetrics()
    const later = [...readBasketChanges(metrics), { revision: 3, at: '2026-07-06T09:00:00.000Z', added: ['query b'], removed: [] }]
    const shift = querySetShift(metrics.buckets, later)
    expect(shift).toEqual({ changes: [readBasketChanges(metrics)[0]], keys: ['query b'], firstCount: 1, latestCount: 1 })
    expect(showsChangeFigure(shift, 'cited', 'non-brand', classify)).toBe(false)
  })

  it('reads mention share past a removed non-brand query once it is gone from every point', () => {
    const metrics = ainyc('all')
    const swap = [{ revision: 2, at: '2026-09-29T09:59:38.415Z', added: ['canonry'], removed: ['ai seo agency nyc'] }]
    const shift = querySetShift(metrics.buckets, swap)
    expect(shift?.keys).toEqual(['canonry'])
    expect(showsChangeFigure(shift, 'mentionShare', 'non-brand', classify)).toBe(true)
    expect(showsChangeFigure(shift, 'cited', 'non-brand', classify)).toBe(false)
  })

  it('names no removal as the cause when the points differ only in queries answered', () => {
    // One query of the two still tracked went unanswered on Jul 5.
    const metrics = removalMetrics()
    const buckets = [{ ...metrics.buckets[0]!, queryCount: 2 }, metrics.buckets[1]!]
    expect(querySetShift(buckets, readBasketChanges(metrics))).toEqual({ changes: [], keys: [], firstCount: 2, latestCount: 1 })
  })
})

describe('pointQuerySetShift', () => {
  it('finds ainyc\'s Sep 29 point pooling sweeps before and after its branded queries were added', () => {
    const metrics = ainyc('7d')
    const shift = pointQuerySetShift(metrics.buckets[0]!, readBasketChanges(metrics))
    expect(shift?.changes).toEqual(readBasketChanges(metrics))
    expect(shift?.keys).toEqual(['canonry', 'canonry aeo agency', 'canonry reviews'])
    expect(showsChangeFigure(shift, 'mentionShare', 'non-brand', classify)).toBe(true)
    expect(showsChangeFigure(shift, 'mentioned', 'non-brand', classify)).toBe(false)
  })

  it('finds no mix across a removal, since the server restates every sweep in the point', () => {
    const [first, latest] = removalMetrics().buckets
    const pooled = { ...latest!, dataStartDate: first!.dataStartDate, sweepCount: 2 }
    expect(pointQuerySetShift(pooled, readBasketChanges(removalMetrics()))).toBeNull()
  })
})
