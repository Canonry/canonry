import { describe, expect, it } from 'vitest'
import { linearTrend, wilsonInterval } from '../src/statistics.js'

describe('wilsonInterval', () => {
  // Fixtures verified against the closed-form Wilson score interval (z=1.96).
  // Representative May/June proportions of the kind the metric reports.
  it('matches the exact 95% interval for the mention-rate proportions', () => {
    expect(wilsonInterval(12, 480)).toEqual({ low: 0.0144, high: 0.0432 })
    expect(wilsonInterval(1, 150)).toEqual({ low: 0.0012, high: 0.0368 })
  })

  it('returns a real upper bound at zero successes (not the degenerate [0,0] Wald gives)', () => {
    // June cited = 0 of 150. A Wald interval would collapse to [0,0] and imply
    // certainty; Wilson keeps the honest "could be as high as 2.5%".
    expect(wilsonInterval(0, 150)).toEqual({ low: 0, high: 0.025 })
  })

  it('returns null over an empty sample (a rate over no data is undefined)', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
    expect(wilsonInterval(5, 0)).toBeNull()
    expect(wilsonInterval(3, -1)).toBeNull()
  })

  it('never leaves [0,1] and never emits negative zero', () => {
    const lo = wilsonInterval(0, 3)!
    expect(lo.low).toBe(0)
    expect(Object.is(lo.low, -0)).toBe(false)
    const hi = wilsonInterval(3, 3)!
    expect(hi.high).toBe(1)
    expect(hi.low).toBeGreaterThan(0)
  })

  it('clamps successes into [0, n] rather than producing a bogus interval', () => {
    // Defensive: a corrupt count above n must not push p above 1.
    expect(wilsonInterval(10, 5)).toEqual(wilsonInterval(5, 5))
  })

  it('brackets the point estimate', () => {
    for (const [s, n] of [[14, 504], [1, 164], [7, 504], [50, 100]] as const) {
      const ci = wilsonInterval(s, n)!
      const p = s / n
      expect(ci.low).toBeLessThanOrEqual(p)
      expect(ci.high).toBeGreaterThanOrEqual(p)
    }
  })
})

describe('linearTrend', () => {
  it('recovers an exact line and reports its endpoints', () => {
    // y = 2x + 1 over indices 0..4.
    const trend = linearTrend([1, 3, 5, 7, 9])
    expect(trend).toEqual({ slope: 2, intercept: 1, r2: 1, start: 1, end: 9, n: 5, startIndex: 0, endIndex: 4 })
  })

  it('fits a falling series with a negative slope', () => {
    // y = -3x + 20 over indices 0..3.
    const trend = linearTrend([20, 17, 14, 11])
    expect(trend).toEqual({ slope: -3, intercept: 20, r2: 1, start: 20, end: 11, n: 4, startIndex: 0, endIndex: 3 })
  })

  it('reports slope per STEP, so the window change is slope * (n - 1)', () => {
    const trend = linearTrend([1, 3, 5, 7, 9])!
    expect(trend.slope).toBe(2)
    expect(trend.end - trend.start).toBeCloseTo(trend.slope * 4, 10)
  })

  it('calls a constant series a perfect flat fit rather than dividing by zero', () => {
    // ssTot is 0 here; r2 must be 1, not NaN.
    expect(linearTrend([5, 5, 5])).toEqual({ slope: 0, intercept: 5, r2: 1, start: 5, end: 5, n: 3, startIndex: 0, endIndex: 2 })
  })

  it('computes the exact least-squares fit for a noisy series', () => {
    // [1, 2, 4]: slope 3/2, intercept 5/6, ssRes 1/6, ssTot 14/3.
    const trend = linearTrend([1, 2, 4])
    expect(trend).toEqual({ slope: 1.5, intercept: 0.833333, r2: 0.9643, start: 0.833333, end: 3.83333, n: 3, startIndex: 0, endIndex: 2 })
  })

  it('keeps the true index of a point across a gap instead of compressing the axis', () => {
    // Observations at x=0 and x=2, so the slope is 2 — NOT the 4 you would get
    // by dropping the hole and treating the points as adjacent.
    const trend = linearTrend([0, null, 4])
    expect(trend).toEqual({ slope: 2, intercept: 0, r2: 1, start: 0, end: 4, n: 2, startIndex: 0, endIndex: 2 })
    expect(linearTrend([0, 4])!.slope).toBe(4)
  })

  it('counts only the observations it used, not the series length', () => {
    expect(linearTrend([1, null, 3, undefined, 5])!.n).toBe(3)
  })

  it('returns null when a line is undefined', () => {
    expect(linearTrend([])).toBeNull()
    expect(linearTrend([7])).toBeNull()
    expect(linearTrend([null, 7, null])).toBeNull()
    expect(linearTrend([null, undefined])).toBeNull()
  })

  it('skips non-finite observations rather than poisoning the fit with NaN', () => {
    expect(linearTrend([1, Number.NaN, 5, Number.POSITIVE_INFINITY, 9])).toEqual({
      slope: 2, intercept: 1, r2: 1, start: 1, end: 9, n: 3, startIndex: 0, endIndex: 4,
    })
  })

  it('reports zero explanatory power on a symmetric series with no linear signal', () => {
    // A V: the fit is the flat mean, so every point is a full residual.
    const trend = linearTrend([10, 0, 0, 10])!
    expect(trend.slope).toBe(0)
    expect(trend.intercept).toBe(5)
    expect(trend.r2).toBe(0)
  })

  it('still trends up when an alternating series ends higher than it started', () => {
    // Guards the tempting-but-wrong reading that "zig-zag" means "flat":
    // this one runs 0 -> 10, and the fit says so.
    expect(linearTrend([0, 10, 0, 10, 0, 10])!.slope).toBeGreaterThan(0)
  })
})

describe('linearTrend precision and extent', () => {
  it('keeps a tiny slope instead of rounding real movement to flat', () => {
    // A CTR climbing 2.00% -> 2.10% over 31 days. Fixed 4-decimal rounding
    // made this slope exactly 0, so every surface reported "flat" for movement
    // that is really there.
    const ctr = Array.from({ length: 31 }, (_, i) => 0.02 + (0.001 * i) / 30)
    const trend = linearTrend(ctr)!
    expect(trend.slope).not.toBe(0)
    expect(trend.slope).toBeCloseTo(0.001 / 30, 9)
  })

  it('reports the index range the fit actually covers', () => {
    // Leading and trailing gaps: the fit spans indices 2..4 only, so a caller
    // must not draw it across 0..5 as though those dates were measured.
    const trend = linearTrend([null, null, 10, 20, 30, null])!
    expect(trend.startIndex).toBe(2)
    expect(trend.endIndex).toBe(4)
    expect(trend.n).toBe(3)
  })

  it('does not compress a calendar gap into a single step', () => {
    // The route feeds one entry per DATE PRESENT, and GSC omits zero-data days.
    // Same observations, real spacing: the slope must not be overstated.
    const compressed = linearTrend([100, 90, 80, 70])!
    const dense = linearTrend([100, 90, 80, null, null, null, null, null, null, 70])!
    expect(compressed.slope).toBe(-10)
    expect(dense.slope).toBeCloseTo(-2.8, 6)
  })
})

describe('calendar index space', () => {
  it('is derived from ONE function, so a fit and a plot cannot disagree', async () => {
    const { calendarDateRange } = await import('../src/formatting.js')
    // 4 dates carry data across a 10-day span.
    const measured = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-10']
    const dense = calendarDateRange(measured[0]!, measured[measured.length - 1]!)
    expect(dense).toHaveLength(10)

    // The fit runs over the dense series...
    const byDate = new Map([['2026-04-01', 100], ['2026-04-02', 90], ['2026-04-03', 80], ['2026-04-10', 70]])
    const trend = linearTrend(dense.map((d) => byDate.get(d) ?? null))!
    expect(trend.endIndex).toBe(9)

    // ...and the plot must use the SAME length, or the drawn line stops short.
    // Against the 4 measured rows it ended at 90 instead of 70.
    const drawn = dense.map((_, i) =>
      trend.start + ((trend.end - trend.start) * (i - trend.startIndex)) / (trend.endIndex - trend.startIndex))
    expect(drawn.at(-1)).toBeCloseTo(trend.end, 6)
  })

  it('returns nothing for a reversed range', async () => {
    const { calendarDateRange } = await import('../src/formatting.js')
    expect(calendarDateRange('2026-04-10', '2026-04-01')).toEqual([])
  })
})
