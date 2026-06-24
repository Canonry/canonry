import { describe, expect, test } from 'vitest'
import {
  REPORT_DEFAULT_PERIOD_DAYS,
  REPORT_PERIOD_OPTIONS,
  parseReportPeriodDays,
  reportComparisonWindowDays,
  reportPeriodSchema,
} from '../src/report.js'

describe('REPORT_PERIOD_OPTIONS', () => {
  test('exposes the selectable windows and a 30-day default', () => {
    expect([...REPORT_PERIOD_OPTIONS]).toEqual([7, 14, 30, 90])
    expect(REPORT_DEFAULT_PERIOD_DAYS).toBe(30)
    expect(REPORT_PERIOD_OPTIONS).toContain(REPORT_DEFAULT_PERIOD_DAYS)
  })
})

describe('parseReportPeriodDays', () => {
  test('absent values fall back to the default', () => {
    expect(parseReportPeriodDays(undefined)).toBe(30)
    expect(parseReportPeriodDays(null)).toBe(30)
    expect(parseReportPeriodDays('')).toBe(30)
  })

  test('accepts each valid option as string or number', () => {
    for (const opt of REPORT_PERIOD_OPTIONS) {
      expect(parseReportPeriodDays(String(opt))).toBe(opt)
      expect(parseReportPeriodDays(opt)).toBe(opt)
    }
  })

  test('rejects values outside the allowed set with a validation error', () => {
    for (const bad of ['15', '0', '-7', 'abc', '30.5', 31, 8]) {
      expect(() => parseReportPeriodDays(bad)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      )
    }
  })
})

describe('reportComparisonWindowDays', () => {
  test('is floor(periodDays / 2) for every option', () => {
    expect(reportComparisonWindowDays(7)).toBe(3)
    expect(reportComparisonWindowDays(14)).toBe(7)
    expect(reportComparisonWindowDays(30)).toBe(15)
    expect(reportComparisonWindowDays(90)).toBe(45)
  })

  test('never drops below 1 even on a tiny window', () => {
    expect(reportComparisonWindowDays(1)).toBe(1)
    expect(reportComparisonWindowDays(0)).toBe(1)
  })
})

describe('reportPeriodSchema', () => {
  test('accepts exactly REPORT_PERIOD_OPTIONS — no drift', () => {
    for (const opt of REPORT_PERIOD_OPTIONS) {
      expect(reportPeriodSchema.parse(opt)).toBe(opt)
    }
    for (const bad of [15, 0, 8, 60, 31]) {
      expect(reportPeriodSchema.safeParse(bad).success).toBe(false)
    }
  })
})
