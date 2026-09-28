import { describe, expect, test } from 'vitest'
import { REPORT_VISIBILITY_COPY, reportVisibilityRate } from '../src/report-visibility.js'

describe('reportVisibilityRate', () => {
  // The frozen population rate is a 0..1 fraction; the label is the shared percent rule.
  test('a measured rate reads as a percent with one decimal, keeping a whole number to one decimal', () => {
    expect(reportVisibilityRate({ numerator: 1, denominator: 3, rate: 1 / 3 })).toBe('33.3%')
    expect(reportVisibilityRate({ numerator: 1, denominator: 2, rate: 0.5 })).toBe('50.0%')
    expect(reportVisibilityRate({ numerator: 10, denominator: 11, rate: 10 / 11 })).toBe('90.9%')
  })

  test('a rate exactly on a half tenth rounds up despite binary float error', () => {
    // 23 of 40 is 0.575, which is 57.49999999999999 once multiplied by 100.
    expect(reportVisibilityRate({ numerator: 23, denominator: 40, rate: 23 / 40 })).toBe('57.5%')
  })

  test('only an exact 0 or 1 reads 0% or 100%, and the edges never round onto them', () => {
    expect(reportVisibilityRate({ numerator: 0, denominator: 4, rate: 0 })).toBe('0%')
    expect(reportVisibilityRate({ numerator: 4, denominator: 4, rate: 1 })).toBe('100%')
    expect(reportVisibilityRate({ numerator: 1, denominator: 2500, rate: 1 / 2500 })).toBe('<0.1%')
    expect(reportVisibilityRate({ numerator: 2499, denominator: 2500, rate: 2499 / 2500 })).toBe('>99.9%')
  })

  test('an unavailable rate reads as not measured, never as 0%', () => {
    expect(reportVisibilityRate({ numerator: null, denominator: null, rate: null, reason: 'no-population' })).toBe(REPORT_VISIBILITY_COPY.notMeasured)
  })
})
