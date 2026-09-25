import { describe, expect, test } from 'vitest'
import { formatPercent, formatSignedPointDelta, windowChangeSchema, type TimeBucket } from '@ainyc/canonry-contracts'
import { computeWindowChange } from '../src/analytics.js'

/** A bucket carrying exact counts, with rates rounded to four decimals as `computeBuckets` stores them. */
function bucket(opts: {
  cited: number
  mentioned: number
  total: number
  shareProject?: number
  shareCompetitor?: number
  /** Null when the bucket had no competitive frame, as the route emits it. */
  shareRate?: number | null
}): TimeBucket {
  const round4 = (ratio: number) => Math.round(ratio * 10000) / 10000
  return {
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: '2026-07-02T00:00:00.000Z',
    dataStartDate: '2026-07-01T00:00:00.000Z',
    dataEndDate: '2026-07-01T00:00:00.000Z',
    sweepCount: 1,
    citationRate: opts.total > 0 ? round4(opts.cited / opts.total) : 0,
    cited: opts.cited,
    total: opts.total,
    queryCount: opts.total,
    mentionRate: opts.total > 0 ? round4(opts.mentioned / opts.total) : 0,
    mentionedCount: opts.mentioned,
    mentionShare: {
      scope: 'non-brand',
      rate: opts.shareRate === undefined ? null : opts.shareRate,
      projectMentionSnapshots: opts.shareProject ?? 0,
      competitorMentionSnapshots: opts.shareCompetitor ?? 0,
    },
    byProvider: {},
    modelEvidenceByProvider: {},
    basketRevision: null,
  }
}

describe('computeWindowChange', () => {
  test('is the latest bucket rate minus the first, per series, with both ends named', () => {
    // Cited 2/10 → 7/20 → 7/20; mentioned 5/10 → 8/20 → 3/20.
    const change = computeWindowChange([
      bucket({ cited: 2, mentioned: 5, total: 10, shareRate: 0.25, shareProject: 1, shareCompetitor: 3 }),
      bucket({ cited: 7, mentioned: 8, total: 20, shareRate: 0.5, shareProject: 2, shareCompetitor: 2 }),
      bucket({ cited: 7, mentioned: 3, total: 20, shareRate: 0.6, shareProject: 3, shareCompetitor: 2 }),
    ])
    expect(change).toEqual({
      // 0.35 - 0.2 is 0.14999999999999997 in floating point; the rates are
      // four-decimal, so the difference is too.
      citationRate: { first: 0.2, latest: 0.35, delta: 0.15 },
      mentionRate: { first: 0.5, latest: 0.15, delta: -0.35 },
      mentionShare: { first: 0.25, latest: 0.6, delta: 0.35 },
    })
    expect(() => windowChangeSchema.parse(change)).not.toThrow()
    // The display both the dashboard head and the CLI print from it.
    expect(formatSignedPointDelta(change.citationRate!.delta)).toBe('+15.0 pts')
    expect(formatSignedPointDelta(change.mentionRate!.delta)).toBe('-35.0 pts')
    expect(formatPercent(change.citationRate!.latest)).toBe('35.0%')
  })

  test('reports an exact zero when the ends agree, whatever happened between them', () => {
    const change = computeWindowChange([
      bucket({ cited: 1, mentioned: 1, total: 4 }),
      bucket({ cited: 4, mentioned: 4, total: 4 }),
      bucket({ cited: 1, mentioned: 1, total: 4 }),
    ])
    expect(change.citationRate).toEqual({ first: 0.25, latest: 0.25, delta: 0 })
    expect(formatSignedPointDelta(change.citationRate!.delta)).toBe('0 pts')
  })

  test('keeps a sliver of change as a real movement, not a rounded zero', () => {
    // 1/3 stores as 0.3333 and 3334/10000 as 0.3334: one hundredth of a point.
    const change = computeWindowChange([
      bucket({ cited: 1, mentioned: 1, total: 3 }),
      bucket({ cited: 3334, mentioned: 3334, total: 10000 }),
    ])
    expect(change.citationRate).toEqual({ first: 0.3333, latest: 0.3334, delta: 0.0001 })
    expect(formatSignedPointDelta(change.citationRate!.delta)).toBe('+<0.1 pts')
  })

  test('is null for a series with fewer than two buckets to compare', () => {
    expect(computeWindowChange([])).toEqual({ citationRate: null, mentionRate: null, mentionShare: null })
    expect(computeWindowChange([bucket({ cited: 1, mentioned: 1, total: 2, shareRate: 0.5 })]))
      .toEqual({ citationRate: null, mentionRate: null, mentionShare: null })
  })

  test('mention share compares only the buckets whose share is defined, as its line plots them', () => {
    const change = computeWindowChange([
      bucket({ cited: 1, mentioned: 1, total: 2, shareRate: null }),
      bucket({ cited: 1, mentioned: 1, total: 2, shareRate: 0.4, shareProject: 2, shareCompetitor: 3 }),
      bucket({ cited: 1, mentioned: 1, total: 2, shareRate: null }),
      bucket({ cited: 1, mentioned: 1, total: 2, shareRate: 0.1, shareProject: 1, shareCompetitor: 9 }),
      bucket({ cited: 1, mentioned: 1, total: 2, shareRate: null }),
    ])
    expect(change.mentionShare).toEqual({ first: 0.4, latest: 0.1, delta: -0.3 })
    // One defined share is still no change, even across five buckets.
    const lone = computeWindowChange([
      bucket({ cited: 1, mentioned: 1, total: 2, shareRate: null }),
      bucket({ cited: 1, mentioned: 1, total: 2, shareRate: 0.4 }),
    ])
    expect(lone.mentionShare).toBeNull()
    expect(lone.citationRate).toEqual({ first: 0.5, latest: 0.5, delta: 0 })
  })

  test('a bucket that measured nothing is not an end of the citation or mention change', () => {
    const change = computeWindowChange([
      bucket({ cited: 0, mentioned: 0, total: 0 }),
      bucket({ cited: 1, mentioned: 2, total: 4 }),
      bucket({ cited: 3, mentioned: 2, total: 4 }),
      bucket({ cited: 0, mentioned: 0, total: 0 }),
    ])
    expect(change.citationRate).toEqual({ first: 0.25, latest: 0.75, delta: 0.5 })
    expect(change.mentionRate).toEqual({ first: 0.5, latest: 0.5, delta: 0 })
  })

  test('spans the full scale, from none to every answer and back', () => {
    const up = computeWindowChange([bucket({ cited: 0, mentioned: 0, total: 5 }), bucket({ cited: 5, mentioned: 5, total: 5 })])
    expect(up.citationRate).toEqual({ first: 0, latest: 1, delta: 1 })
    const down = computeWindowChange([bucket({ cited: 5, mentioned: 5, total: 5 }), bucket({ cited: 0, mentioned: 0, total: 5 })])
    expect(down.mentionRate).toEqual({ first: 1, latest: 0, delta: -1 })
    expect(() => windowChangeSchema.parse(up)).not.toThrow()
    expect(() => windowChangeSchema.parse(down)).not.toThrow()
  })
})
