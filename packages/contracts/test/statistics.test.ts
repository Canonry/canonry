import { describe, expect, it } from 'vitest'
import { wilsonInterval } from '../src/statistics.js'

describe('wilsonInterval', () => {
  // Fixtures verified against the closed-form Wilson score interval (z=1.96).
  // These are the real May/June DemandIQ proportions the metric will report.
  it('matches the exact 95% interval for the mention-rate proportions', () => {
    expect(wilsonInterval(14, 504)).toEqual({ low: 0.0166, high: 0.0461 })
    expect(wilsonInterval(1, 164)).toEqual({ low: 0.0011, high: 0.0337 })
  })

  it('returns a real upper bound at zero successes (not the degenerate [0,0] Wald gives)', () => {
    // June cited = 0 of 164. A Wald interval would collapse to [0,0] and imply
    // certainty; Wilson keeps the honest "could be as high as 2.3%".
    expect(wilsonInterval(0, 164)).toEqual({ low: 0, high: 0.0229 })
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
