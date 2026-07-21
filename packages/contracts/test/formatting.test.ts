import { describe, expect, test } from 'vitest'
import {
  MIN_PCT_BASE,
  compactDateToIso,
  deltaPercent,
  deltaTone,
  formatAverageDelta,
  formatDate,
  formatDateRange,
  formatDeltaCopy,
  formatIsoDate,
  formatNumber,
  formatRatio,
  formatWindowCountDelta,
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

describe('formatAverageDelta', () => {
  test('large base renders a signed percentage vs prior', () => {
    expect(formatAverageDelta({ deltaAbs: 4.2, prior: 30, deltaPct: 14 })).toBe('+14% vs prior')
  })

  test('large base with a negative delta keeps the sign from deltaPct', () => {
    expect(formatAverageDelta({ deltaAbs: -6, prior: 50, deltaPct: -12 })).toBe('-12% vs prior')
  })

  test(`base below MIN_PCT_BASE (${MIN_PCT_BASE}) falls back to a rounded raw delta`, () => {
    // The float-parity case: 0.33333333333333304 → 0.3, 3.3333 → 3.3.
    expect(formatAverageDelta({ deltaAbs: 0.33333333333333304, prior: 3.3333, deltaPct: 10 }))
      .toBe('+0.3 vs 3.3')
  })

  test('small-base negative delta omits the plus sign', () => {
    expect(formatAverageDelta({ deltaAbs: -0.5, prior: 2, deltaPct: -20 })).toBe('-0.5 vs 2')
  })

  test('zero prior (deltaPct null) takes the raw branch even though prior < MIN_PCT_BASE', () => {
    expect(formatAverageDelta({ deltaAbs: 0.5, prior: 0, deltaPct: null })).toBe('+0.5 vs 0')
  })

  test('large base but null deltaPct still falls back to the raw branch', () => {
    // prior >= MIN_PCT_BASE but no computable percentage — never render "%".
    expect(formatAverageDelta({ deltaAbs: 5, prior: 40, deltaPct: null })).toBe('+5 vs 40')
  })

  test('zero delta on a small base renders without a sign', () => {
    expect(formatAverageDelta({ deltaAbs: 0, prior: 3.3, deltaPct: 0 })).toBe('0 vs 3.3')
  })
})

describe('formatWindowCountDelta', () => {
  test('large base renders a signed percentage with the window label, no count word', () => {
    expect(formatWindowCountDelta({ deltaAbs: -54, prior: 382, deltaPct: -14 }, 'visits', 'vs prior 14 days'))
      .toBe('-14% vs prior 14 days')
  })

  test('large base positive delta gets a plus sign', () => {
    expect(formatWindowCountDelta({ deltaAbs: 60, prior: 300, deltaPct: 20 }, 'clicks', 'vs prior 14 days'))
      .toBe('+20% vs prior 14 days')
  })

  test(`base below MIN_PCT_BASE (${MIN_PCT_BASE}) falls back to a rounded absolute delta with the count label`, () => {
    expect(formatWindowCountDelta({ deltaAbs: 4, prior: 10, deltaPct: 40 }, 'visits', 'vs prior 14 days'))
      .toBe('+4 visits vs prior 14 days')
  })

  test('small-base negative delta omits the plus sign and rounds', () => {
    expect(formatWindowCountDelta({ deltaAbs: -2.6, prior: 5, deltaPct: -52 }, 'clicks', 'vs prior 14 days'))
      .toBe('-3 clicks vs prior 14 days')
  })

  test('zero prior (deltaPct null) takes the count branch', () => {
    expect(formatWindowCountDelta({ deltaAbs: 7, prior: 0, deltaPct: null }, 'visits', 'vs prior 14 days'))
      .toBe('+7 visits vs prior 14 days')
  })

  test('large base but null deltaPct falls back to the count branch', () => {
    expect(formatWindowCountDelta({ deltaAbs: -10, prior: 100, deltaPct: null }, 'visits', 'vs prior 14 days'))
      .toBe('-10 visits vs prior 14 days')
  })

  test('large count deltas abbreviate via formatNumber', () => {
    expect(formatWindowCountDelta({ deltaAbs: 1500, prior: 20, deltaPct: 7500 }, 'visits', 'vs prior 14 days'))
      .toBe('+1.5K visits vs prior 14 days')
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

describe('compactDateToIso', () => {
  test('converts a GA4 compact date to ISO', () => {
    expect(compactDateToIso('20260720')).toBe('2026-07-20')
  })

  test('leaves an already-ISO date untouched (idempotent)', () => {
    expect(compactDateToIso('2026-07-20')).toBe('2026-07-20')
    expect(compactDateToIso(compactDateToIso('20260720'))).toBe('2026-07-20')
  })

  test('passes through values that are not 8 digits', () => {
    expect(compactDateToIso('')).toBe('')
    expect(compactDateToIso('(other)')).toBe('(other)')
    expect(compactDateToIso('2026072')).toBe('2026072')
    expect(compactDateToIso('2026-7-20')).toBe('2026-7-20')
  })

  test('does not shift the day across timezones', () => {
    // Pure string surgery — no Date construction, so a UTC-negative offset
    // cannot roll the date back to the 19th.
    expect(compactDateToIso('20260101')).toBe('2026-01-01')
    expect(compactDateToIso('20261231')).toBe('2026-12-31')
  })
})
