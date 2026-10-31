import { describe, expect, it } from 'vitest'
import { isTrendBaseline, MIN_TREND_POINTS } from '../src/trend-stability.js'

describe('trend baseline', () => {
  it('requires four observations before showing a trend', () => {
    expect(MIN_TREND_POINTS).toBe(4)
    expect(isTrendBaseline([])).toBe(true)
    expect(isTrendBaseline([1])).toBe(true)
    expect(isTrendBaseline([1, 2, 3])).toBe(true)
    expect(isTrendBaseline([1, 2, 3, 4])).toBe(false)
    expect(isTrendBaseline([1, 2, 3, 4, 5])).toBe(false)
  })
})
