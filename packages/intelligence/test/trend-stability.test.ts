import { describe, expect, test } from 'vitest'
import { isTrendBaseline, MIN_TREND_POINTS } from '../src/trend-stability.js'

describe('isTrendBaseline', () => {
  test('returns true when fewer than MIN_TREND_POINTS data points are present', () => {
    expect(isTrendBaseline([])).toBe(true)
    expect(isTrendBaseline([1])).toBe(true)
    expect(isTrendBaseline([1, 2])).toBe(true)
    expect(isTrendBaseline(new Array(MIN_TREND_POINTS - 1).fill(0))).toBe(true)
  })

  test('returns false once at least MIN_TREND_POINTS points are present', () => {
    expect(isTrendBaseline(new Array(MIN_TREND_POINTS).fill(0))).toBe(false)
    expect(isTrendBaseline(new Array(MIN_TREND_POINTS + 5).fill(1))).toBe(false)
  })

  test('MIN_TREND_POINTS is at least 3 — two-point trends are unreliable', () => {
    expect(MIN_TREND_POINTS).toBeGreaterThanOrEqual(3)
  })
})
