import { describe, expect, test } from 'vitest'
import {
  deltaPercent,
  deltaTone,
  formatDate,
  formatDateRange,
  formatDeltaCopy,
  formatIsoDate,
  formatNumber,
  formatRatio,
  parseInclusiveEndMs,
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

describe('deltaPercent', () => {
  test('returns null when prior is zero or negative', () => {
    expect(deltaPercent(100, 0)).toBeNull()
    expect(deltaPercent(0, 0)).toBeNull()
    expect(deltaPercent(50, -1)).toBeNull()
  })

  test('rounds to nearest integer percent', () => {
    expect(deltaPercent(150, 100)).toBe(50)
    expect(deltaPercent(50, 100)).toBe(-50)
    expect(deltaPercent(100, 100)).toBe(0)
    expect(deltaPercent(101, 100)).toBe(1)
    expect(deltaPercent(102, 99)).toBe(3) // (102-99)/99 = 0.0303 → 3
  })
})

describe('deltaTone', () => {
  test('null and zero are neutral', () => {
    expect(deltaTone(null)).toBe('neutral')
    expect(deltaTone(0)).toBe('neutral')
  })

  test('positive deltas are positive tone', () => {
    expect(deltaTone(1)).toBe('positive')
    expect(deltaTone(100)).toBe('positive')
  })

  test('negative deltas are negative tone', () => {
    expect(deltaTone(-1)).toBe('negative')
    expect(deltaTone(-100)).toBe('negative')
  })
})

describe('formatDeltaCopy', () => {
  test('null deltaPct with zero prior signals first baseline week', () => {
    expect(formatDeltaCopy({ current: 100, prior: 0, deltaPct: null }, 'crawls'))
      .toBe('First baseline week')
  })

  test('null deltaPct with non-zero prior renders empty (no signal)', () => {
    expect(formatDeltaCopy({ current: 0, prior: 50, deltaPct: null }, 'crawls')).toBe('')
  })

  test('positive delta uses Up phrasing with prior count', () => {
    expect(formatDeltaCopy({ current: 200, prior: 100, deltaPct: 100 }, 'crawls'))
      .toBe('Up 100% vs prior 7 days (100 crawls)')
  })

  test('negative delta uses Down phrasing with absolute value', () => {
    expect(formatDeltaCopy({ current: 50, prior: 100, deltaPct: -50 }, 'arrivals'))
      .toBe('Down 50% vs prior 7 days (100 arrivals)')
  })

  test('zero delta uses Flat phrasing', () => {
    expect(formatDeltaCopy({ current: 100, prior: 100, deltaPct: 0 }, 'hits'))
      .toBe('Flat vs prior 7 days (100 hits)')
  })

  test('windowLabel can be overridden', () => {
    expect(formatDeltaCopy({ current: 200, prior: 100, deltaPct: 100 }, 'hits', 'vs prior 30 days'))
      .toBe('Up 100% vs prior 30 days (100 hits)')
  })
})

describe('parseInclusiveEndMs', () => {
  test('widens a date-only value to the end of that UTC day', () => {
    // Not midnight — the whole day is inclusive, so the bound is 23:59:59.999Z.
    expect(parseInclusiveEndMs('2026-06-30')).toBe(Date.parse('2026-06-30T23:59:59.999Z'))
  })

  test('a run from that afternoon falls within the date-only bound', () => {
    const bound = parseInclusiveEndMs('2026-06-30')!
    expect(Date.parse('2026-06-30T15:30:00.000Z') <= bound).toBe(true)
    // ...and the first instant of the next day does not.
    expect(Date.parse('2026-07-01T00:00:00.000Z') <= bound).toBe(false)
  })

  test('keeps the exact instant for a full date-time', () => {
    expect(parseInclusiveEndMs('2026-06-30T14:00:00.000Z')).toBe(Date.parse('2026-06-30T14:00:00.000Z'))
  })

  test('returns null for an unparseable value', () => {
    expect(parseInclusiveEndMs('not-a-date')).toBeNull()
  })
})
