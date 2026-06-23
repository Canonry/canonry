import { describe, expect, it } from 'vitest'
import { smoothedRunDelta, SMOOTHED_RUN_DELTA_MAX_WINDOW } from '../src/smoothed-delta.js'

type Point = { value: number }
const v = (n: number): Point => ({ value: n })

describe('smoothedRunDelta', () => {
  it('returns null when fewer than 2 points', () => {
    expect(smoothedRunDelta<Point>([], p => p.value)).toBeNull()
    expect(smoothedRunDelta<Point>([v(50)], p => p.value)).toBeNull()
  })

  it('falls back to window=1 (point-to-point) with exactly 2 points', () => {
    // Equivalent to the legacy `latest - prior` delta.
    const result = smoothedRunDelta<Point>([v(50), v(60)], p => p.value)
    // deltaPct = round((60-50)/50 * 100) = 20.
    expect(result).toEqual({ current: 60, prior: 50, deltaAbs: 10, deltaPct: 20, window: 1 })
  })

  it('computes deltaPct from the rounded averages; null when prior is zero', () => {
    // Large enough base → a real percentage off the rounded prior average.
    const climbing = smoothedRunDelta<Point>([v(40), v(50), v(60), v(70)], p => p.value)
    // prior = 45, current = 65 → round((65-45)/45 * 100) = round(44.44) = 44.
    expect(climbing?.deltaPct).toBe(44)
    // Prior average of 0 → percentage undefined → null.
    const fromZero = smoothedRunDelta<Point>([v(0), v(0), v(5)], p => p.value)
    expect(fromZero?.prior).toBe(0)
    expect(fromZero?.deltaPct).toBeNull()
  })

  it('keeps window=1 with 3 points (need 4 to fit window=2 without overlap)', () => {
    const result = smoothedRunDelta<Point>([v(50), v(55), v(60)], p => p.value)
    expect(result?.window).toBe(1)
    expect(result?.current).toBe(60)
    expect(result?.prior).toBe(55)
  })

  it('uses window=2 with exactly 4 points', () => {
    const result = smoothedRunDelta<Point>([v(40), v(50), v(60), v(70)], p => p.value)
    expect(result?.window).toBe(2)
    expect(result?.current).toBe(65) // (60 + 70) / 2
    expect(result?.prior).toBe(45)   // (40 + 50) / 2
    expect(result?.deltaAbs).toBe(20)
  })

  it('caps at maxWindow=3 once we have 6+ points', () => {
    const points = [10, 20, 30, 40, 50, 60, 70, 80].map(v)
    const result = smoothedRunDelta<Point>(points, p => p.value)
    expect(result?.window).toBe(3)
    expect(result?.current).toBe(70) // (60 + 70 + 80) / 3
    expect(result?.prior).toBe(40)   // (30 + 40 + 50) / 3
  })

  it('respects a custom maxWindow', () => {
    const points = [10, 20, 30, 40, 50, 60, 70, 80].map(v)
    const result = smoothedRunDelta<Point>(points, p => p.value, 2)
    expect(result?.window).toBe(2)
    expect(result?.current).toBe(75) // (70 + 80) / 2
    expect(result?.prior).toBe(55)   // (50 + 60) / 2
  })

  it('smooths out single-run twitches that point-to-point would over-react to', () => {
    // 20-query basket scenario: one query bounces in and out of cited each run.
    // Point-to-point would show ±5pp every run. Smoothed should be ~0.
    const points = [50, 55, 50, 55, 50, 55, 50].map(v)
    const result = smoothedRunDelta<Point>(points, p => p.value)
    // Last 3: 55, 50, 55 → 53.3 avg
    // Prior 3: 50, 55, 50 → 51.7 avg
    // Delta: 1.6 — well below a 3pp "real movement" threshold.
    expect(Math.abs(result!.deltaAbs)).toBeLessThan(3)
  })

  it('still detects sustained trends — flat → climbing', () => {
    // First 3 runs hold near 50; next 3 climb to 70 — that's a real trend.
    const points = [48, 50, 52, 64, 68, 72].map(v)
    const result = smoothedRunDelta<Point>(points, p => p.value)
    expect(result?.deltaAbs).toBeGreaterThan(15)
  })

  it('rounds current and prior to 1 decimal, leaves deltaAbs raw', () => {
    // Forces a value that doesn't terminate cleanly: 100/3 = 33.333...
    const points = [33, 34, 34, 67, 67, 66].map(v)
    const result = smoothedRunDelta<Point>(points, p => p.value)
    // current = (67 + 67 + 66) / 3 = 66.666... → rounds to 66.7
    expect(result?.current).toBe(66.7)
    // prior = (33 + 34 + 34) / 3 = 33.666... → rounds to 33.7
    expect(result?.prior).toBe(33.7)
    // deltaAbs stays unrounded so caller can apply a precise threshold
    expect(result?.deltaAbs).toBeCloseTo(33, 1)
  })

  it('handles negative deltas (regressions)', () => {
    const points = [80, 75, 70, 50, 45, 40].map(v)
    const result = smoothedRunDelta<Point>(points, p => p.value)
    expect(result?.deltaAbs).toBeLessThan(0)
    expect(result?.current).toBe(45)  // (50 + 45 + 40) / 3
    expect(result?.prior).toBe(75)    // (80 + 75 + 70) / 3
  })

  it('SMOOTHED_RUN_DELTA_MAX_WINDOW constant is 3', () => {
    expect(SMOOTHED_RUN_DELTA_MAX_WINDOW).toBe(3)
  })
})
