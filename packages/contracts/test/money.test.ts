import { describe, test, expect } from 'vitest'
import { dollarsToMicros, microsToDollars, formatMicros } from '../src/money.js'

describe('dollarsToMicros', () => {
  test('converts decimal dollars to integer micros', () => {
    expect(dollarsToMicros(39.28)).toBe(39_280_000)
    expect(dollarsToMicros(1.71)).toBe(1_710_000)
    expect(dollarsToMicros(150)).toBe(150_000_000)
  })

  test('rounds float artifacts to an exact integer', () => {
    // 39.28 * 1e6 === 39280000.000000004 in IEEE-754 — must come back integral
    expect(Number.isInteger(dollarsToMicros(39.28))).toBe(true)
    expect(dollarsToMicros(0.1 + 0.2)).toBe(300_000)
  })

  test('handles zero and sub-cent values', () => {
    expect(dollarsToMicros(0)).toBe(0)
    expect(dollarsToMicros(0.000001)).toBe(1)
  })
})

describe('microsToDollars', () => {
  test('inverts dollarsToMicros', () => {
    expect(microsToDollars(39_280_000)).toBe(39.28)
    expect(microsToDollars(150_000_000)).toBe(150)
    expect(microsToDollars(0)).toBe(0)
  })

  test('round-trips upstream-observed values exactly', () => {
    for (const dollars of [39.28, 1.71, 104.05, 0.57, 2.6]) {
      expect(microsToDollars(dollarsToMicros(dollars))).toBe(dollars)
    }
  })
})

describe('formatMicros', () => {
  test('formats micros as a currency string', () => {
    expect(formatMicros(39_280_000)).toBe('$39.28')
    expect(formatMicros(150_000_000)).toBe('$150.00')
    expect(formatMicros(0)).toBe('$0.00')
  })

  test('respects the currency code', () => {
    expect(formatMicros(2_000_000, 'EUR')).toBe('€2.00')
  })

  test('keeps cents for sub-dollar values', () => {
    expect(formatMicros(570_000)).toBe('$0.57')
  })

  test('shows sub-cent amounts at a fixed precision when asked', () => {
    expect(formatMicros(14_200, 'USD', { fractionDigits: 4 })).toBe('$0.0142')
    expect(formatMicros(53_125, 'USD', { fractionDigits: 4 })).toBe('$0.0531')
    expect(formatMicros(0, 'USD', { fractionDigits: 4 })).toBe('$0.0000')
    expect(formatMicros(12_345_678, 'USD', { fractionDigits: 4 })).toBe('$12.3457')
  })

  test('without the option, a positive amount below the shown precision rounds to zero', () => {
    expect(formatMicros(49, 'USD', { fractionDigits: 4 })).toBe('$0.0000')
    expect(formatMicros(4_999)).toBe('$0.00')
  })

  test('marks a positive amount below the shown precision instead of printing zero', () => {
    const tiny = { fractionDigits: 4, showTinyAsLessThan: true }
    expect(formatMicros(0, 'USD', tiny)).toBe('$0.0000')
    expect(formatMicros(1, 'USD', tiny)).toBe('<$0.0001')
    expect(formatMicros(49, 'USD', tiny)).toBe('<$0.0001')
    // 0.00005 rounds half up to the smallest shown step, so it is shown as is.
    expect(formatMicros(50, 'USD', tiny)).toBe('$0.0001')
    expect(formatMicros(149, 'USD', tiny)).toBe('$0.0001')
    expect(formatMicros(1_635_400, 'USD', tiny)).toBe('$1.6354')
  })

  test('takes the smallest step from the precision in use', () => {
    expect(formatMicros(4_999, 'USD', { showTinyAsLessThan: true })).toBe('<$0.01')
    expect(formatMicros(5_000, 'USD', { showTinyAsLessThan: true })).toBe('$0.01')
    expect(formatMicros(400_000, 'JPY', { showTinyAsLessThan: true })).toBe('<¥1')
  })
})
