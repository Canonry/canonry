import { describe, it, expect } from 'vitest'
import type { BrandMetricsDto, ModelAttribution, ModelEvidenceState, ModelPointerChangeDisclosure } from '@ainyc/canonry-contracts'
import {
  buildMentionShareTrendRows,
  buildSelectedTrendRows,
  buildTrendRows,
  countModelAttributionEvents,
  partitionModelAttributionEvents,
  truncatedProviderCounts,
  formatModelEvidence,
  groupModelAttributionEvents,
  readModelPointerChanges,
  latestPlottedProviderModelEvidence,
  readBucketModelEvidence,
  readModelAttribution,
  trendToTone,
  formatQueryChangeCaption,
  latestSeriesValue,
  CITED_KEY,
  MENTION_SHARE_KEY,
  MENTIONED_KEY,
  normalizeProviderKey,
} from '../src/lib/visibility-trend-helpers.js'

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
    mentionShare: { rate: 0.6, projectMentionSnapshots: 3, competitorMentionSnapshots: 2 },
    byProvider,
  }
}

function dto(buckets: BrandMetricsDto['buckets']): BrandMetricsDto {
  return {
    window: 'all',
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
      .toBe('Mixed: gpt-5, gpt-5-mini + unknown')
  })

  it('uses the last plotted provider bucket, not detail-view history, for a legend model label', () => {
    const buckets = [
      {
        ...bucket('2026-04-01', { gemini: provider(0.25, 0.1) }),
        modelEvidenceByProvider: { gemini: { status: 'known', model: 'gemini-2.0-flash' } },
      },
      {
        ...bucket('2026-04-08', { gemini: provider(0.75, 0.5) }),
        modelEvidenceByProvider: { gemini: { status: 'mixed', models: ['gemini-2.0-flash', 'gemini-2.5-flash'], includesUnknown: false } },
      },
    ] as BrandMetricsDto['buckets']

    expect(latestPlottedProviderModelEvidence(buckets, ' Gemini ')).toEqual({
      status: 'mixed', models: ['gemini-2.0-flash', 'gemini-2.5-flash'], includesUnknown: false,
    })
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

  it('counts shown vs observed changes so a capped list can say how much it is hiding', () => {
    const event = {
      observedAt: '2026-04-08T09:00:00.000Z',
      bucketStartDate: '2026-04-08',
      from: { status: 'known', model: 'a' },
      to: { status: 'known', model: 'b' },
    } as const
    const latestObservation = { observedAt: '2026-04-08T09:00:00.000Z', state: { status: 'known', model: 'b' } } as const

    // gemini is truncated (2 of 40), openai is complete, and claude predates
    // `eventTotal` entirely — an older server's list IS its whole history.
    expect(countModelAttributionEvents({
      gemini: { latestObservation, events: [event, event], eventTotal: 40 },
      openai: { latestObservation, events: [event], eventTotal: 1 },
      claude: { latestObservation, events: [event, event, event] },
    })).toEqual({ shown: 6, total: 44 })

    expect(countModelAttributionEvents({})).toEqual({ shown: 0, total: 0 })
  })

  it('summed `shown` equals the events the grouped view actually renders', () => {
    // The cap is applied PER PROVIDER server-side, but the UI renders one
    // merged, bucket-grouped list and so reports one summed pair. That is only
    // honest if the sum matches what grouping emits — if grouping ever starts
    // dropping events (an unparsable bucket, a dedupe), `shown` would overstate
    // the visible history and "showing N of M" would lie in the safe-looking
    // direction. Cross-check the two helpers against the same input.
    const eventAt = (observedAt: string, bucketStartDate: string) => ({
      observedAt,
      bucketStartDate,
      from: { status: 'known', model: 'a' },
      to: { status: 'known', model: 'b' },
    } as const)
    const latestObservation = { observedAt: '2026-04-15T09:00:00.000Z', state: { status: 'known', model: 'b' } } as const

    // Two providers, overlapping buckets, one of them truncated.
    const attribution = {
      gemini: {
        latestObservation,
        events: [eventAt('2026-04-08T09:00:00.000Z', '2026-04-08'), eventAt('2026-04-15T09:00:00.000Z', '2026-04-15')],
        eventTotal: 40,
      },
      openai: {
        latestObservation,
        events: [eventAt('2026-04-08T10:00:00.000Z', '2026-04-08')],
        eventTotal: 1,
      },
    }

    const counts = countModelAttributionEvents(attribution)
    const rendered = groupModelAttributionEvents(attribution)
      .reduce((sum, bucket) => sum + bucket.events.length, 0)

    expect(counts.shown).toBe(rendered)
    // …and the truncation is still visible in the summed pair.
    expect(counts).toEqual({ shown: 3, total: 41 })
  })
})

describe('buildMentionShareTrendRows', () => {
  it('plots bucket mention share as percentages', () => {
    const d = dto([
      { ...bucket('2026-04-01', { gemini: provider(0.25, 0.1) }), mentionShare: { rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 } },
      { ...bucket('2026-04-08', { gemini: provider(0.5, 0.4) }), mentionShare: { rate: 0.75, projectMentionSnapshots: 3, competitorMentionSnapshots: 1 } },
    ])

    const res = buildMentionShareTrendRows(d)
    expect(res.series).toEqual([MENTION_SHARE_KEY])
    expect(res.rows.map(r => r[MENTION_SHARE_KEY])).toEqual([25, 75])
    expect(res.hasData).toBe(true)
  })

  it('emits null when a bucket has no competitive brand mentions', () => {
    const d = dto([
      { ...bucket('2026-04-01', { gemini: provider(0.25, 0.1) }), mentionShare: { rate: null, projectMentionSnapshots: 0, competitorMentionSnapshots: 0 } },
      { ...bucket('2026-04-08', { gemini: provider(0.5, 0.4) }), mentionShare: { rate: 0.5, projectMentionSnapshots: 1, competitorMentionSnapshots: 1 } },
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
      { ...bucket('2026-04-01', { gemini: provider(0.25, 0.1) }), mentionShare: { rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 } },
    ])

    expect(buildSelectedTrendRows(d, 'mentionShare', 'byProvider')).toEqual(buildMentionShareTrendRows(d))
  })
})

describe('latestSeriesValue', () => {
  it('returns the most recent plotted value (right end of the line)', () => {
    const d = dto([
      bucket('2026-04-01', { gemini: provider(0.25, 0.1), openai: provider(0.5, 0.4) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5) }),
    ])
    const { rows } = buildTrendRows(d, 'cited', 'byProvider')
    // gemini is in both buckets → its latest cited value is bucket 2 (75).
    expect(latestSeriesValue(rows, 'gemini')).toBe(75)
  })

  it('skips trailing nulls so the value matches the visible line end', () => {
    const d = dto([
      bucket('2026-04-01', { openai: provider(0.5, 0.4) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5) }),
    ])
    const { rows } = buildTrendRows(d, 'cited', 'byProvider')
    // openai only has data in bucket 1; bucket 2 is null. Latest = 50, not null.
    expect(latestSeriesValue(rows, 'openai')).toBe(50)
  })

  it('returns null for a series that never appears', () => {
    const d = dto([bucket('2026-04-01', { gemini: provider(0.5, 0.5) })])
    const { rows } = buildTrendRows(d, 'cited', 'byProvider')
    expect(latestSeriesValue(rows, 'claude')).toBeNull()
  })

  it('returns null for empty rows', () => {
    expect(latestSeriesValue([], 'gemini')).toBeNull()
  })
})

describe('trendToTone', () => {
  it('maps direction to tone', () => {
    expect(trendToTone('improving')).toBe('positive')
    expect(trendToTone('declining')).toBe('negative')
    expect(trendToTone('stable')).toBe('neutral')
  })
})

describe('formatQueryChangeCaption', () => {
  it('returns null when there are no changes', () => {
    expect(formatQueryChangeCaption([])).toBeNull()
  })

  it('formats a single change with a signed delta and MM/DD date', () => {
    expect(formatQueryChangeCaption([{ date: '2026-03-17', delta: 7, label: '+7 kp' }]))
      .toBe('Query set changed: +7 on 03/17')
  })

  it('lists two changes inline (MM/DD)', () => {
    const caption = formatQueryChangeCaption([
      { date: '2026-04-03', delta: 2, label: '+2 kp' },
      { date: '2026-05-01', delta: 3, label: '+3 kp' },
    ])
    expect(caption).toBe('Query set changed: +2 on 04/03, +3 on 05/01')
  })

  it('collapses three or more changes into a count + the most recent', () => {
    const caption = formatQueryChangeCaption([
      { date: '2026-04-03', delta: 2, label: '+2 kp' },
      { date: '2026-05-01', delta: 3, label: '+3 kp' },
      { date: '2026-05-17', delta: 1, label: '+1 kp' },
    ])
    expect(caption).toBe('Query set changed 3 times (latest +1 on 05/17)')
  })

  it('renders a negative delta (queries removed)', () => {
    expect(formatQueryChangeCaption([{ date: '2026-06-02', delta: -4, label: '-4 kp' }]))
      .toBe('Query set changed: -4 on 06/02')
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
