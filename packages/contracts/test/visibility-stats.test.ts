import { describe, expect, it } from 'vitest'
import { calendarMonthBounds } from '../src/visibility-stats.js'

describe('calendarMonthBounds', () => {
  it('expands a month to inclusive UTC bounds', () => {
    expect(calendarMonthBounds('2026-06')).toEqual({
      since: '2026-06-01T00:00:00.000Z',
      until: '2026-06-30T23:59:59.999Z',
    })
  })

  it('handles February in a leap year (29 days)', () => {
    expect(calendarMonthBounds('2024-02')).toEqual({
      since: '2024-02-01T00:00:00.000Z',
      until: '2024-02-29T23:59:59.999Z',
    })
  })

  it('handles February in a non-leap year (28 days)', () => {
    expect(calendarMonthBounds('2026-02').until).toBe('2026-02-28T23:59:59.999Z')
  })

  it('handles December (the exclusive end rolls into the next year)', () => {
    expect(calendarMonthBounds('2026-12')).toEqual({
      since: '2026-12-01T00:00:00.000Z',
      until: '2026-12-31T23:59:59.999Z',
    })
  })

  it('throws RangeError on a malformed or out-of-range month', () => {
    expect(() => calendarMonthBounds('2026-6')).toThrow(/YYYY-MM/)
    expect(() => calendarMonthBounds('June')).toThrow(/YYYY-MM/)
    expect(() => calendarMonthBounds('2026-13')).toThrow(/between 01 and 12/)
    expect(() => calendarMonthBounds('2026-00')).toThrow(/between 01 and 12/)
    expect(() => calendarMonthBounds('2026-6')).toThrow(RangeError)
  })
})
