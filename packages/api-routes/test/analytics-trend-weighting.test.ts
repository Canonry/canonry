import { test, expect, describe } from 'vitest'
import type { TimeBucket } from '@ainyc/canonry-contracts'
import { computeTrend, pooledRate } from '../src/analytics.js'

/**
 * A rate is not additive across the buckets that produced it. Averaging
 * per-bucket rates unweighted lets a bucket holding 2 snapshots move the
 * improving/declining verdict as much as one holding 200.
 */
function bucket(cited: number, total: number, mentioned = cited): TimeBucket {
  return {
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: '2026-07-02T00:00:00.000Z',
    dataStartDate: '2026-07-01T00:00:00.000Z',
    dataEndDate: '2026-07-01T00:00:00.000Z',
    sweepCount: 1,
    citationRate: total > 0 ? Math.round((cited / total) * 10000) / 10000 : 0,
    cited,
    total,
    queryCount: total,
    mentionRate: total > 0 ? Math.round((mentioned / total) * 10000) / 10000 : 0,
    mentionedCount: mentioned,
    byProvider: {},
    modelEvidenceByProvider: {},
  } as TimeBucket
}

describe('pooledRate', () => {
  test('weights each bucket by the evidence it carries', () => {
    // 1/2 and 99/198 are both 50%, but a plain mean of the RATES would also be
    // 50% here; the discriminating case is below.
    expect(pooledRate([bucket(1, 2), bucket(99, 198)], 'citationRate')).toBe(100 / 200)
  })

  test('a sparse bucket cannot outvote a dense one', () => {
    // Unweighted mean of rates = (1.0 + 0.1) / 2 = 0.55
    // Pooled = (2 + 20) / (2 + 200) = 0.1089…
    const buckets = [bucket(2, 2), bucket(20, 200)]
    expect(pooledRate(buckets, 'citationRate')).toBeCloseTo(22 / 202, 10)
    const unweighted = (buckets[0]!.citationRate + buckets[1]!.citationRate) / 2
    expect(unweighted).toBeCloseTo(0.55, 10)
  })

  test('reads mentionedCount for the mention rate, not cited', () => {
    expect(pooledRate([bucket(0, 10, 7)], 'mentionRate')).toBe(0.7)
    expect(pooledRate([bucket(0, 10, 7)], 'citationRate')).toBe(0)
  })

  test('returns 0 rather than dividing by zero', () => {
    expect(pooledRate([], 'citationRate')).toBe(0)
    expect(pooledRate([bucket(0, 0)], 'citationRate')).toBe(0)
  })

  test('does not compound the per-bucket rounding', () => {
    // 1/3 stores as 0.3333; pooling the raw counts keeps full precision.
    expect(pooledRate([bucket(1, 3), bucket(1, 3)], 'citationRate')).toBe(2 / 6)
  })
})

describe('computeTrend', () => {
  test('a single sparse sweep no longer flips the verdict', () => {
    // First half: 100/200 = 50%. Second half: a dense 96/200 = 48% (a real
    // 2pp dip, inside the 5pp threshold) plus one 2-snapshot sweep at 100%.
    // Unweighted mean of the second half = (0.48 + 1.0)/2 = 0.74 → "improving".
    // Pooled = (96 + 2)/(200 + 2) = 48.5% → correctly "stable".
    const buckets = [bucket(50, 100), bucket(50, 100), bucket(96, 200), bucket(2, 2)]
    expect(computeTrend(buckets, 'citationRate')).toBe('stable')
  })

  test('still reports a real improvement', () => {
    const buckets = [bucket(20, 100), bucket(20, 100), bucket(40, 100), bucket(40, 100)]
    expect(computeTrend(buckets, 'citationRate')).toBe('improving')
  })

  test('still reports a real decline', () => {
    const buckets = [bucket(40, 100), bucket(40, 100), bucket(20, 100), bucket(20, 100)]
    expect(computeTrend(buckets, 'citationRate')).toBe('declining')
  })

  test('holds the 5-percentage-point threshold', () => {
    // Clearly under and clearly over. The exact-5pp boundary is deliberately
    // not asserted: 0.55 - 0.5 is 0.050000000000000044 in IEEE 754, so a
    // `> 0.05` guard trips on it. That float sensitivity predates this change
    // and pinning it would lock in an artifact rather than intended behavior.
    const under = [bucket(50, 100), bucket(54, 100)]
    expect(computeTrend(under, 'citationRate')).toBe('stable')
    const over = [bucket(50, 100), bucket(56, 100)]
    expect(computeTrend(over, 'citationRate')).toBe('improving')
  })

  test('empty buckets are excluded before the split', () => {
    expect(computeTrend([bucket(0, 0), bucket(0, 0)], 'citationRate')).toBe('stable')
  })

  test('fewer than two non-empty buckets is stable, not a verdict', () => {
    expect(computeTrend([bucket(10, 10)], 'citationRate')).toBe('stable')
    expect(computeTrend([], 'citationRate')).toBe('stable')
  })
})
