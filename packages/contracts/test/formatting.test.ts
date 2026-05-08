import { describe, expect, test } from 'vitest'
import {
  formatDate,
  formatDateRange,
  formatIsoDate,
  formatNumber,
  formatRatio,
} from '../src/formatting.js'

describe('formatRatio', () => {
  test('zero and non-finite values render as 0%', () => {
    expect(formatRatio(0)).toBe('0%')
    expect(formatRatio(Number.NaN)).toBe('0%')
    expect(formatRatio(Number.POSITIVE_INFINITY)).toBe('0%')
  })

  test('fractions render as percent with one decimal', () => {
    expect(formatRatio(0.5)).toBe('50.0%')
    expect(formatRatio(0.123)).toBe('12.3%')
    expect(formatRatio(1)).toBe('100.0%')
  })
})

describe('formatNumber', () => {
  test('non-finite values render as em dash', () => {
    expect(formatNumber(Number.NaN)).toBe('—')
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('—')
  })

  test('values under 1K use locale grouping', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(999)).toBe('999')
  })

  test('values 1K–1M abbreviate with K suffix', () => {
    expect(formatNumber(1000)).toBe('1.0K')
    expect(formatNumber(12500)).toBe('12.5K')
  })

  test('values >= 1M abbreviate with M suffix', () => {
    expect(formatNumber(1_000_000)).toBe('1.0M')
    expect(formatNumber(2_400_000)).toBe('2.4M')
  })
})

describe('formatDate', () => {
  test('empty string renders as em dash', () => {
    expect(formatDate('')).toBe('—')
  })

  test('YYYY-MM-DD strings format in UTC (no timezone drift)', () => {
    expect(formatDate('2026-05-08')).toBe('May 8, 2026')
  })

  test('full ISO timestamps format using local convention', () => {
    expect(formatDate('2026-05-08T12:00:00.000Z')).toMatch(/May (7|8), 2026/)
  })

  test('invalid input falls back to original string', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date')
  })
})

describe('formatIsoDate', () => {
  test('empty string renders as em dash', () => {
    expect(formatIsoDate('')).toBe('—')
  })

  test('full ISO timestamp returns YYYY-MM-DD in UTC', () => {
    expect(formatIsoDate('2026-05-08T12:00:00.000Z')).toBe('2026-05-08')
  })

  test('YYYY-MM-DD round-trips', () => {
    expect(formatIsoDate('2026-05-08')).toBe('2026-05-08')
  })

  test('zero-pads single-digit month and day', () => {
    expect(formatIsoDate('2026-01-03T00:00:00Z')).toBe('2026-01-03')
  })

  test('invalid input falls back to original string', () => {
    expect(formatIsoDate('not-a-date')).toBe('not-a-date')
  })
})

describe('formatDateRange', () => {
  test('empty start and end produce empty string', () => {
    expect(formatDateRange('', '')).toBe('')
  })

  test('start and end produce arrow-joined range', () => {
    expect(formatDateRange('2026-05-01', '2026-05-08')).toBe('May 1, 2026 → May 8, 2026')
  })

  test('only one side falls through to a single formatted date', () => {
    expect(formatDateRange('2026-05-01', '')).toBe('May 1, 2026')
    expect(formatDateRange('', '2026-05-08')).toBe('May 8, 2026')
  })
})
