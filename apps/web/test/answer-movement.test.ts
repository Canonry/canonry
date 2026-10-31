import { describe, expect, it } from 'vitest'
import { coverageTone } from '../src/lib/answer-movement.js'
import { formatSweepInstant } from '../src/lib/format-helpers.js'

describe('coverageTone', () => {
  it('reads 70% and up positive and anything less caution, never negative', () => {
    expect(coverageTone(7, 10)).toBe('positive')
    expect(coverageTone(69, 100)).toBe('caution')
    expect(coverageTone(4, 10)).toBe('caution')
    // A non-brand 4 of 11 is amber, and so is 0.
    expect(coverageTone(4, 11)).toBe('caution')
    expect(coverageTone(0, 11)).toBe('caution')
    expect(coverageTone(0, 0)).toBe('neutral')
  })
})

describe('formatSweepInstant', () => {
  const at = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month - 1, day, hour, minute).toISOString()
  const now = new Date(2026, 8, 29, 12, 0)
  // Some ICU builds put a narrow no-break space before AM/PM.
  const format = (...args: Parameters<typeof formatSweepInstant>) => formatSweepInstant(...args).replace(/\u202f/g, ' ')

  it('shows only the time when the sentence already names the day', () => {
    expect(format(at(2026, 9, 29, 5, 41), at(2026, 9, 29, 5, 59), now)).toBe('5:41 AM')
  })

  it('names the day otherwise, and the year only outside the current one', () => {
    expect(format(at(2026, 7, 14, 2, 0), at(2026, 9, 29, 5, 59), now)).toBe('Jul 14, 2:00 AM')
    expect(format(at(2025, 9, 29, 5, 59), null, now)).toBe('Sep 29, 2025, 5:59 AM')
  })
})
