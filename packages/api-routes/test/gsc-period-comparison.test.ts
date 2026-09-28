import { describe, expect, it } from 'vitest'
import {
  computeGscPeriodComparison,
  gscCalendarDates,
  type GscDailyRow,
} from '../src/gsc-period-comparison.js'

/**
 * A day, with position defaulting to null (the shape the route produces for a
 * date that has no property-level row).
 */
function day(
  date: string, clicks: number, impressions: number,
  position: number | null = null, fromPropertyTotals = true,
): GscDailyRow {
  return { date, clicks, impressions, position, fromPropertyTotals }
}


describe('gscCalendarDates', () => {
  it('is inclusive of both ends', () => {
    expect(gscCalendarDates('2026-03-01', '2026-03-04')).toEqual([
      '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04',
    ])
  })

  it('crosses a month and a leap day without dropping one', () => {
    expect(gscCalendarDates('2028-02-27', '2028-03-02')).toEqual([
      '2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02',
    ])
  })

  /**
   * Stepped in UTC on purpose. Stepping a local Date across a spring-forward
   * boundary can repeat or skip a calendar label; these are dates, not instants.
   */
  it('is unaffected by a DST transition in the host zone', () => {
    expect(gscCalendarDates('2026-03-07', '2026-03-10')).toEqual([
      '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10',
    ])
  })

  it('rejects impossible dates instead of normalizing them', () => {
    expect(gscCalendarDates('2026-02-30', '2026-03-05')).toEqual([])
  })

  it('bounds fixture-sized date materialization', () => {
    const dates = gscCalendarDates('0001-01-01', '9999-12-31')
    expect(dates).toHaveLength(800)
    expect(dates[0]).toBe('0001-01-01')
  })
})

describe('computeGscPeriodComparison', () => {
  it('returns null for no data', () => {
    expect(computeGscPeriodComparison([])).toBeNull()
  })

  it('returns null for a single day, which cannot make two periods', () => {
    expect(computeGscPeriodComparison([day('2026-03-01', 5, 100)])).toBeNull()
  })

  it('splits an even span down the middle', () => {
    const result = computeGscPeriodComparison([
      day('2026-03-01', 1, 10), day('2026-03-02', 1, 10),
      day('2026-03-03', 4, 20), day('2026-03-04', 4, 20),
    ])!
    expect(result.days).toBe(2)
    expect(result.prior.startDate).toBe('2026-03-01')
    expect(result.prior.endDate).toBe('2026-03-02')
    expect(result.trailing.startDate).toBe('2026-03-03')
    expect(result.trailing.endDate).toBe('2026-03-04')
    expect(result.prior.clicks).toBe(2)
    expect(result.trailing.clicks).toBe(8)
    // 8 vs 2 = +300%
    expect(result.change.clicks).toBe(3)
  })

  /**
   * Equal-length periods are the point of the comparison, so an odd span drops
   * its OLDEST day rather than handing one side an extra day of accumulation.
   */
  it('drops the oldest day on an odd span so both periods are equal', () => {
    const result = computeGscPeriodComparison([
      day('2026-03-01', 99, 990), // dropped
      day('2026-03-02', 1, 10), day('2026-03-03', 1, 10),
      day('2026-03-04', 2, 20), day('2026-03-05', 2, 20),
    ])!
    expect(result.days).toBe(2)
    expect(result.prior.startDate).toBe('2026-03-02')
    expect(result.prior.clicks).toBe(2)
    expect(result.trailing.clicks).toBe(4)
    expect(result.change.clicks).toBe(1)
  })

  /**
   * The regression this module exists to prevent on the split itself: Search
   * Analytics omits zero-data days, so `daily` is SPARSE. Splitting the ROW
   * ARRAY in half puts a different number of calendar days on each side
   * whenever the property had a quiet stretch.
   */
  it('splits over the CALENDAR, not the row array', () => {
    // 10 calendar days, only 6 rows. A row-array split would cut after the 3rd
    // ROW (2026-03-03), giving a 3-day prior and a 7-day trailing period.
    const rows = [
      day('2026-03-01', 1, 10), day('2026-03-02', 1, 10), day('2026-03-03', 1, 10),
      // 2026-03-04 .. 2026-03-07 produced nothing at all
      day('2026-03-08', 5, 50), day('2026-03-09', 5, 50), day('2026-03-10', 5, 50),
    ]
    const result = computeGscPeriodComparison(rows)!
    expect(result.days).toBe(5)
    expect(result.prior.startDate).toBe('2026-03-01')
    expect(result.prior.endDate).toBe('2026-03-05')
    expect(result.trailing.startDate).toBe('2026-03-06')
    expect(result.trailing.endDate).toBe('2026-03-10')
    // The quiet days count as the zeros they are.
    expect(result.prior.clicks).toBe(3)
    expect(result.trailing.clicks).toBe(15)
    expect(result.change.clicks).toBe(4)
  })

  it('uses authoritative bounds when the requested prior half has no rows', () => {
    const result = computeGscPeriodComparison(
      [day('2026-03-09', 5, 50), day('2026-03-10', 5, 50)],
      { startDate: '2026-03-01', endDate: '2026-03-10' },
    )!

    expect(result.days).toBe(5)
    expect(result.prior).toMatchObject({
      startDate: '2026-03-01', endDate: '2026-03-05', clicks: 0, source: 'empty',
    })
    expect(result.trailing).toMatchObject({
      startDate: '2026-03-06', endDate: '2026-03-10', clicks: 10, source: 'property-daily',
    })
    expect(result.comparable).toBe(true)
    expect(result.change.clicks).toBeNull()
  })

  it('compares a property-daily prior half with a quiet trailing half', () => {
    const result = computeGscPeriodComparison(
      [day('2026-03-01', 5, 50), day('2026-03-02', 5, 50)],
      { startDate: '2026-03-01', endDate: '2026-03-10' },
    )!

    expect(result.prior.source).toBe('property-daily')
    expect(result.trailing.source).toBe('empty')
    expect(result.comparable).toBe(true)
    expect(result.change.clicks).toBe(-1)
    expect(result.change.impressions).toBe(-1)
  })

  it('returns null when an explicit range has no evidence in either half', () => {
    expect(computeGscPeriodComparison([], {
      startDate: '2026-03-01',
      endDate: '2026-03-10',
    })).toBeNull()
  })

  it('splits a multi-millennial range without materializing every day', () => {
    const result = computeGscPeriodComparison(
      [day('9999-12-31', 5, 50)],
      { startDate: '0001-01-01', endDate: '9999-12-31' },
    )!

    expect(result.days).toBeGreaterThan(1_000_000)
    expect(result.trailing.endDate).toBe('9999-12-31')
    expect(result.trailing.clicks).toBe(5)
  })

  it('rejects impossible authoritative bounds instead of normalizing them', () => {
    expect(computeGscPeriodComparison(
      [day('2026-03-02', 5, 50)],
      { startDate: '2026-02-30', endDate: '2026-03-05' },
    )).toBeNull()
  })

  describe('non-additive metrics', () => {
    /**
     * CTR is the period's own clicks/impressions. A mean of the daily ratios
     * would let a 1-impression day count as much as a 1000-impression day, and
     * would not reconcile with the clicks and impressions shown beside it.
     */
    it('computes CTR from period totals, not as a mean of daily ratios', () => {
      const result = computeGscPeriodComparison([
        day('2026-03-01', 1, 1), // daily ctr 100%
        day('2026-03-02', 0, 999), // daily ctr 0%
        day('2026-03-03', 5, 100),
        day('2026-03-04', 5, 100),
      ])!
      // Mean of daily ratios would be 50%. The true period CTR is 1/1000.
      expect(result.prior.ctr).toBeCloseTo(1 / 1000, 10)
      expect(result.trailing.ctr).toBeCloseTo(10 / 200, 10)
      expect(result.prior.ctr).not.toBeCloseTo(0.5, 3)
    })

    it('weights position by impressions, matching the window total', () => {
      const result = computeGscPeriodComparison([
        day('2026-03-01', 0, 1, 1), // rank 1 on a single impression
        day('2026-03-02', 0, 999, 51), // rank 51 on 999
        day('2026-03-03', 0, 100, 10),
        day('2026-03-04', 0, 100, 10),
      ])!
      // Unweighted mean would be 26. Weighted: (1*1 + 51*999)/1000 = 50.95
      expect(result.prior.position).toBeCloseTo((1 * 1 + 51 * 999) / 1000, 10)
      expect(result.prior.position).not.toBeCloseTo(26, 1)
      expect(result.trailing.position).toBeCloseTo(10, 10)
    })

    it('excludes days with no position, and days with no impressions to weight by', () => {
      const result = computeGscPeriodComparison([
        day('2026-03-01', 0, 100, 20),
        day('2026-03-02', 0, 0, 5), // no impressions: no weight
        day('2026-03-03', 0, 100, null), // no property position at all
        day('2026-03-04', 0, 100, 30),
      ])!
      expect(result.prior.position).toBe(20)
      expect(result.trailing.position).toBe(30)
    })

    it('reports a null position when no day in the period carried one', () => {
      const result = computeGscPeriodComparison([
        day('2026-03-01', 1, 10, null), day('2026-03-02', 1, 10, null),
        day('2026-03-03', 1, 10, 12), day('2026-03-04', 1, 10, 12),
      ])!
      expect(result.prior.position).toBeNull()
      expect(result.change.position).toBeNull()
      expect(result.trailing.position).toBe(12)
    })
  })

  describe('baselines that cannot support a percentage', () => {
    /**
     * The whole point of the change: this must be RARE, but when the prior
     * period is genuinely zero there is no percentage to state. Growth from
     * nothing is not "+100%".
     */
    it('returns null rather than inventing a percentage from a zero baseline', () => {
      const result = computeGscPeriodComparison([
        day('2026-03-01', 0, 0), day('2026-03-02', 0, 0),
        day('2026-03-03', 7, 70), day('2026-03-04', 7, 70),
      ])!
      expect(result.change.clicks).toBeNull()
      expect(result.change.impressions).toBeNull()
      expect(result.change.ctr).toBeNull()
      // The figures themselves are still reported so a caller can say "new".
      expect(result.trailing.clicks).toBe(14)
      expect(result.prior.clicks).toBe(0)
    })

    it('reports an exact zero change as 0, not as null', () => {
      const result = computeGscPeriodComparison([
        day('2026-03-01', 3, 30), day('2026-03-02', 3, 30),
        day('2026-03-03', 3, 30), day('2026-03-04', 3, 30),
      ])!
      expect(result.change.clicks).toBe(0)
      expect(result.change.ctr).toBe(0)
    })

    it('reports a decline as a negative ratio', () => {
      const result = computeGscPeriodComparison([
        day('2026-03-01', 10, 100), day('2026-03-02', 10, 100),
        day('2026-03-03', 5, 100), day('2026-03-04', 5, 100),
      ])!
      expect(result.change.clicks).toBe(-0.5)
      expect(result.change.impressions).toBe(0)
      expect(result.change.ctr).toBe(-0.5)
    })
  })

  /**
   * Reproduces the property shape that motivated the change (a small site,
   * 139 days to 2026-08-14). The fitted trend line predicted -13.98 impressions
   * on day one, so the old tile printed nothing for impressions and nothing for
   * CTR, and reported average position as a 45.8% IMPROVEMENT across a window
   * in which the real position got worse.
   */
  it('produces a real figure where the fitted-line baseline produced none', () => {
    const rows: GscDailyRow[] = []
    // Prior 69 days: 14 clicks on 483 impressions, position 22.6.
    gscCalendarDates('2026-03-30', '2026-06-06').forEach((date, i) => {
      rows.push(day(date, i < 14 ? 1 : 0, 7, 22.6))
    })
    // Trailing 69 days: 35 clicks on 2829 impressions, position 24.2.
    gscCalendarDates('2026-06-07', '2026-08-14').forEach((date, i) => {
      rows.push(day(date, i < 35 ? 1 : 0, 41, 24.2))
    })
    const result = computeGscPeriodComparison(rows)!
    expect(result.days).toBe(69)
    expect(result.prior.clicks).toBe(14)
    expect(result.trailing.clicks).toBe(35)
    expect(result.change.impressions).not.toBeNull()
    expect(result.change.impressions!).toBeGreaterThan(4) // > +400%
    // Position rose, which is WORSE. The sign must be positive, and the
    // renderer is what turns that into a downward arrow.
    expect(result.change.position!).toBeGreaterThan(0)
    // CTR fell even though clicks rose, because impressions rose faster.
    // 14/483 = 2.90% -> 35/2829 = 1.24%
    expect(result.prior.ctr!).toBeCloseTo(14 / 483, 10)
    expect(result.trailing.ctr!).toBeCloseTo(35 / 2829, 10)
    expect(result.change.ctr!).toBeLessThan(0)
  })
})

/**
 * The route merges two Search Console sources per date: the un-dimensioned
 * `gsc_daily_totals` table and, for dates it lacks, `SUM(gsc_search_data)`.
 * They are NOT interchangeable — on one real property-month the same period
 * reads 1,142 clicks / 34,916 impressions from the first and 792 / 45,266 from
 * the second, because Google withholds rare queries and fans one impression out
 * across every query x page x country x device row.
 *
 * An install that synced dimensioned data before the property table existed has
 * exactly this shape: an older half from one source, a newer half from the
 * other. Dividing one by the other reports the gap between two counting methods
 * as if the site had changed.
 */
describe('mixed measurement sources', () => {
  const prop = (date: string, c: number, i: number) => day(date, c, i, 10, true)
  const dim = (date: string, c: number, i: number) => day(date, c, i, null, false)

  it('refuses to compare a dimensioned prior against a property-daily trailing', () => {
    const result = computeGscPeriodComparison([
      dim('2026-03-01', 792, 45266), dim('2026-03-02', 792, 45266),
      prop('2026-03-03', 1142, 34916), prop('2026-03-04', 1142, 34916),
    ])!
    expect(result.prior.source).toBe('dimensioned')
    expect(result.trailing.source).toBe('property-daily')
    expect(result.comparable).toBe(false)
    // A flat property would otherwise report clicks +44%, impressions -23%.
    expect(result.change.clicks).toBeNull()
    expect(result.change.impressions).toBeNull()
    expect(result.change.ctr).toBeNull()
    expect(result.change.position).toBeNull()
    // The figures themselves are still reported, so a caller can show levels.
    expect(result.prior.clicks).toBe(1584)
    expect(result.trailing.clicks).toBe(2284)
  })

  it('refuses when a single period is itself half one source and half the other', () => {
    const result = computeGscPeriodComparison([
      dim('2026-03-01', 10, 100), prop('2026-03-02', 10, 100),
      prop('2026-03-03', 10, 100), prop('2026-03-04', 10, 100),
    ])!
    expect(result.prior.source).toBe('mixed')
    expect(result.comparable).toBe(false)
    expect(result.change.clicks).toBeNull()
  })

  /**
   * Both periods are `mixed`, so `prior.source === trailing.source` is TRUE and
   * only the explicit mixed check refuses. Without it, each half is itself a
   * blend of two counting methods and the ratio is meaningless in both
   * directions.
   */
  it('refuses when BOTH periods are internally mixed, despite matching sources', () => {
    const result = computeGscPeriodComparison([
      dim('2026-03-01', 10, 100), prop('2026-03-02', 10, 100),
      dim('2026-03-03', 20, 100), prop('2026-03-04', 20, 100),
    ])!
    expect(result.prior.source).toBe('mixed')
    expect(result.trailing.source).toBe('mixed')
    expect(result.prior.source).toBe(result.trailing.source)
    expect(result.comparable).toBe(false)
    expect(result.change.clicks).toBeNull()
  })

  it('compares normally when both periods share a source', () => {
    const result = computeGscPeriodComparison([
      prop('2026-03-01', 10, 100), prop('2026-03-02', 10, 100),
      prop('2026-03-03', 20, 100), prop('2026-03-04', 20, 100),
    ])!
    expect(result.comparable).toBe(true)
    expect(result.change.clicks).toBe(1)
  })

  it('refuses when BOTH periods are dimensioned, despite matching sources', () => {
    const result = computeGscPeriodComparison([
      dim('2026-03-01', 10, 100), dim('2026-03-02', 10, 100),
      dim('2026-03-03', 20, 100), dim('2026-03-04', 20, 100),
    ])!
    expect(result.prior.source).toBe('dimensioned')
    expect(result.trailing.source).toBe('dimensioned')
    expect(result.comparable).toBe(false)
    expect(result.change.clicks).toBeNull()
  })

  it('refuses dimensioned evidence even when the other half is empty', () => {
    const result = computeGscPeriodComparison(
      [dim('2026-03-01', 10, 100), dim('2026-03-02', 10, 100)],
      { startDate: '2026-03-01', endDate: '2026-03-10' },
    )!
    expect(result.prior.source).toBe('dimensioned')
    expect(result.trailing.source).toBe('empty')
    expect(result.comparable).toBe(false)
    expect(result.change.clicks).toBeNull()
  })
})

/**
 * The `basis` label is the module's whole statement about WHICH two periods it
 * measured. `days` alone cannot say: 45 means "half of a 90-day window" under
 * one basis and "a 45-day window and the 45 days before it" under the other,
 * and a tile printing "vs prior 45d" for the first is what sent a reader here
 * asking why pressing 90d produced 45.
 */
describe('computeGscPeriodComparison basis', () => {
  const march = [
    day('2026-03-01', 10, 100), day('2026-03-02', 10, 100),
    day('2026-03-03', 10, 100), day('2026-03-04', 10, 100),
    day('2026-03-05', 30, 100), day('2026-03-06', 30, 100),
    day('2026-03-07', 30, 100), day('2026-03-08', 30, 100),
  ]

  it('defaults to split-window, so a caller that never opted in is unchanged', () => {
    const result = computeGscPeriodComparison(march)
    expect(result?.basis).toBe('split-window')
    expect(result?.days).toBe(4)
  })

  it('reports the basis the caller passed without inferring it from the span', () => {
    // The module does not decide the basis and must not try: the same eight-day
    // span is a split 8-day window or a doubled 4-day one depending only on
    // what the route asked for.
    const result = computeGscPeriodComparison(march, {
      startDate: '2026-03-01', endDate: '2026-03-08', basis: 'prior-window',
    })
    expect(result?.basis).toBe('prior-window')
  })

  /**
   * The arithmetic the route depends on: hand in twice the selected window and
   * the trailing half lands exactly on that window, the prior half exactly on
   * the period before it. Nothing is dropped, because a doubled span is even.
   */
  it('puts the halves on the selected window and the period before it', () => {
    const result = computeGscPeriodComparison(march, {
      startDate: '2026-03-01', endDate: '2026-03-08', basis: 'prior-window',
    })
    expect(result?.days).toBe(4)
    expect(result?.trailing).toMatchObject({
      startDate: '2026-03-05', endDate: '2026-03-08', clicks: 120,
    })
    expect(result?.prior).toMatchObject({
      startDate: '2026-03-01', endDate: '2026-03-04', clicks: 40,
    })
    expect(result?.change.clicks).toBe(2)
  })

  /**
   * Same rows, same numbers on both sides — the ONLY difference between a
   * doubled span and a window twice as wide is which two periods the reader is
   * told about. That is exactly why the label has to travel with the figure.
   */
  it('produces identical periods for a doubled span and an equally wide split', () => {
    const doubled = computeGscPeriodComparison(march, {
      startDate: '2026-03-01', endDate: '2026-03-08', basis: 'prior-window',
    })
    const split = computeGscPeriodComparison(march, {
      startDate: '2026-03-01', endDate: '2026-03-08',
    })
    expect({ ...doubled, basis: null }).toEqual({ ...split, basis: null })
    expect(doubled?.basis).not.toBe(split?.basis)
  })
})
