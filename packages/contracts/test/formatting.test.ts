import { describe, expect, test } from 'vitest'
import {
  MIN_PCT_BASE,
  compactDateToIso,
  deltaPercent,
  deltaTone,
  formatAverageDelta,
  formatDate,
  formatZonedTimestamp,
  formatDateRange,
  formatDeltaCopy,
  formatIsoDate,
  formatIsoDateInTimeZone,
  inclusiveDayCount,
  formatNumber,
  formatRatio,
  formatWindowCountDelta,
  isoDateDaysBeforeInTimeZone,
  parseInclusiveEndMs,
  relativeChangeRatio,
  startOfDayHourInTimeZone,
  startOfNextDayHourInTimeZone,
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

describe('formatIsoDateInTimeZone', () => {
  test('a zone east of UTC has already rolled to the next calendar day', () => {
    // 22:00 UTC is 07:00 the NEXT day in Tokyo (UTC+9).
    expect(formatIsoDate('2026-06-10T22:00:00.000Z')).toBe('2026-06-10')
    expect(formatIsoDateInTimeZone('2026-06-10T22:00:00.000Z', 'Asia/Tokyo')).toBe('2026-06-11')
  })

  test('a zone west of UTC is still on the previous calendar day', () => {
    // 02:00 UTC is 19:00 the PREVIOUS day in Denver (UTC-7 in June).
    expect(formatIsoDate('2026-06-11T02:00:00.000Z')).toBe('2026-06-11')
    expect(formatIsoDateInTimeZone('2026-06-11T02:00:00.000Z', 'America/Denver')).toBe('2026-06-10')
  })

  test('UTC matches the plain UTC formatter', () => {
    expect(formatIsoDateInTimeZone('2026-06-10T22:00:00.000Z', 'UTC')).toBe('2026-06-10')
  })

  test('zero-pads single-digit month and day', () => {
    expect(formatIsoDateInTimeZone('2026-01-03T12:00:00.000Z', 'Europe/Berlin')).toBe('2026-01-03')
  })

  test('an unknown zone degrades to the UTC date instead of throwing', () => {
    expect(formatIsoDateInTimeZone('2026-06-10T22:00:00.000Z', 'Not/AZone')).toBe('2026-06-10')
  })

  test('invalid input falls back to the original string', () => {
    expect(formatIsoDateInTimeZone('not-a-date', 'Asia/Tokyo')).toBe('not-a-date')
  })
})

describe('startOfDayHourInTimeZone', () => {
  /**
   * Independent oracle for which local hours a zone really shows on a date, so
   * these tests cannot quietly go vacuous if a zone's rules or the platform's
   * tzdata change. Deliberately brute force (sweep real instants and record
   * what the clock reads) rather than the offset round trip the implementation
   * uses, so the two cannot share a mistake.
   */
  const localHoursShownOn = (isoDate: string, timeZone: string): Set<number> => {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
    const shown = new Set<number>()
    // The whole local day sits inside this UTC span for every real zone offset.
    const fromMs = Date.parse(`${isoDate}T00:00:00.000Z`) - 24 * 60 * 60 * 1_000
    for (let ms = fromMs; ms <= fromMs + 72 * 60 * 60 * 1_000; ms += 5 * 60_000) {
      const parts = format.formatToParts(new Date(ms))
      const value = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((part) => part.type === type)?.value ?? ''
      if (`${value('year')}-${value('month')}-${value('day')}` !== isoDate) continue
      shown.add(Number(value('hour')))
    }
    return shown
  }

  test('a zone with no transition starts its day at hour 00', () => {
    expect(startOfDayHourInTimeZone('2026-06-10', 'America/New_York')).toBe('2026-06-10T00')
    expect(startOfDayHourInTimeZone('2026-06-10', 'Asia/Tokyo')).toBe('2026-06-10T00')
    expect(startOfDayHourInTimeZone('2026-06-10', 'UTC')).toBe('2026-06-10T00')
    expect(startOfDayHourInTimeZone('2026-01-03', 'Europe/Berlin')).toBe('2026-01-03T00')
  })

  test('a spring-forward day whose gap is NOT at midnight still starts at hour 00', () => {
    // America/New_York springs forward at 02:00 local, so midnight is intact
    // and only hour 02 is missing.
    const shown = localHoursShownOn('2026-03-08', 'America/New_York')
    expect(shown.has(0)).toBe(true)
    expect(shown.has(2)).toBe(false)
    expect(startOfDayHourInTimeZone('2026-03-08', 'America/New_York')).toBe('2026-03-08T00')
    // And the fall-back day, where 01:00 happens twice, is equally unaffected.
    expect(startOfDayHourInTimeZone('2026-11-01', 'America/New_York')).toBe('2026-11-01T00')
  })

  test('America/Santiago skips local hour 00 when it springs forward at midnight', () => {
    // Chile moves the clock at 24:00 on the first Saturday of September, so
    // 2026-09-06 runs 01:00, 02:00, ... and never has an hour 00.
    const shown = localHoursShownOn('2026-09-06', 'America/Santiago')
    expect(shown.has(0)).toBe(false)
    expect(shown.has(1)).toBe(true)
    expect(startOfDayHourInTimeZone('2026-09-06', 'America/Santiago')).toBe('2026-09-06T01')
  })

  test('America/Havana skips local hour 00 when it springs forward at midnight', () => {
    const shown = localHoursShownOn('2026-03-08', 'America/Havana')
    expect(shown.has(0)).toBe(false)
    expect(shown.has(1)).toBe(true)
    expect(startOfDayHourInTimeZone('2026-03-08', 'America/Havana')).toBe('2026-03-08T01')
  })

  test('the day before and the day after a midnight gap are untouched', () => {
    expect(startOfDayHourInTimeZone('2026-09-05', 'America/Santiago')).toBe('2026-09-05T00')
    expect(startOfDayHourInTimeZone('2026-09-07', 'America/Santiago')).toBe('2026-09-07T00')
    expect(startOfDayHourInTimeZone('2026-03-07', 'America/Havana')).toBe('2026-03-07T00')
    expect(startOfDayHourInTimeZone('2026-03-09', 'America/Havana')).toBe('2026-03-09T00')
  })

  test('an unknown zone degrades to hour 00 instead of throwing', () => {
    expect(startOfDayHourInTimeZone('2026-09-06', 'Not/AZone')).toBe('2026-09-06T00')
  })

  test('a date that is not YYYY-MM-DD degrades to hour 00', () => {
    expect(startOfDayHourInTimeZone('not-a-date', 'America/Santiago')).toBe('not-a-dateT00')
    expect(startOfDayHourInTimeZone('', 'America/Santiago')).toBe('T00')
  })
})

describe('startOfNextDayHourInTimeZone', () => {
  const DAY_MS = 24 * 60 * 60 * 1_000

  /**
   * What the helper replaces: add a fixed 24 hours to the day's start and read
   * back the local wall clock. Kept as an oracle so each case can state whether
   * the naive step is wrong, and so the ordinary rows prove the fix does not
   * over-correct a day that was always fine.
   */
  const fixedDurationStep = (isoDate: string, timeZone: string): string => {
    const startedAt = Date.parse(`${isoDate}T12:00:00.000Z`)
    return formatIsoDateInTimeZone(new Date(startedAt + DAY_MS).toISOString(), timeZone)
  }

  test('an ordinary day ends at hour 00 of the next calendar date', () => {
    expect(startOfNextDayHourInTimeZone('2026-07-21', 'America/New_York')).toBe('2026-07-22T00')
    expect(startOfNextDayHourInTimeZone('2026-06-10', 'America/Denver')).toBe('2026-06-11T00')
    expect(startOfNextDayHourInTimeZone('2026-06-10', 'Asia/Tokyo')).toBe('2026-06-11T00')
    expect(startOfNextDayHourInTimeZone('2026-06-10', 'UTC')).toBe('2026-06-11T00')
  })

  test('it rolls month and year boundaries as a calendar does', () => {
    expect(startOfNextDayHourInTimeZone('2026-01-31', 'UTC')).toBe('2026-02-01T00')
    expect(startOfNextDayHourInTimeZone('2026-12-31', 'UTC')).toBe('2027-01-01T00')
    // 2028 is a leap year, so February really does have a 29th.
    expect(startOfNextDayHourInTimeZone('2028-02-28', 'UTC')).toBe('2028-02-29T00')
  })

  test('the day a zone springs forward AT midnight ends at the next day hour 01', () => {
    // America/Santiago moves the clock at 24:00 on 2026-09-05, so 2026-09-06
    // has no hour 00 and the edge that closes 09-05 is 09-06 at 01:00. The
    // naive +24h step reads 09-06 as the DATE and would hand back an hour the
    // zone's own calendar never had.
    expect(startOfNextDayHourInTimeZone('2026-09-05', 'America/Santiago')).toBe('2026-09-06T01')
    expect(fixedDurationStep('2026-09-05', 'America/Santiago')).toBe('2026-09-06')
    expect(startOfNextDayHourInTimeZone('2026-03-07', 'America/Havana')).toBe('2026-03-08T01')
  })

  test('a fall-back day is 25 hours long and still ends at the next day hour 00', () => {
    // America/New_York repeats 01:00 on 2026-11-01, so a +24h step from that
    // day's start lands back INSIDE 11-01 and would close the day on itself.
    expect(startOfNextDayHourInTimeZone('2026-11-01', 'America/New_York')).toBe('2026-11-02T00')
    // A spring-forward day (23 hours) at the other end of the same zone.
    expect(startOfNextDayHourInTimeZone('2026-03-08', 'America/New_York')).toBe('2026-03-09T00')
  })

  test('it is the exclusive edge that covers the whole day it closes', () => {
    // The pairing that matters to a range: the day starts where
    // startOfDayHourInTimeZone says and ends where this says, and the second is
    // strictly after the first for both the short and the long local day.
    for (const [date, zone] of [
      ['2026-03-08', 'America/New_York'],
      ['2026-11-01', 'America/New_York'],
      ['2026-09-05', 'America/Santiago'],
      ['2026-06-10', 'America/Denver'],
    ] as const) {
      const since = startOfDayHourInTimeZone(date, zone)
      const until = startOfNextDayHourInTimeZone(date, zone)
      expect(until > since).toBe(true)
      expect(until.slice(0, 10) > date).toBe(true)
    }
  })

  test('an unknown zone degrades to the next date at hour 00 instead of throwing', () => {
    expect(startOfNextDayHourInTimeZone('2026-09-05', 'Not/AZone')).toBe('2026-09-06T00')
  })

  test('a date that is not YYYY-MM-DD degrades without inventing a date', () => {
    expect(startOfNextDayHourInTimeZone('not-a-date', 'America/Santiago')).toBe('not-a-dateT00')
    expect(startOfNextDayHourInTimeZone('', 'America/Santiago')).toBe('T00')
  })
})

describe('isoDateDaysBeforeInTimeZone', () => {
  const DAY_MS = 24 * 60 * 60 * 1_000

  /**
   * What the helper replaces: subtract a fixed number of 24-hour periods from
   * the instant, then read the calendar date in the zone. Kept here so the
   * table can state, per row, whether the naive step is wrong and by how much.
   * A row where the two agree is a control: it proves the fix does not
   * over-correct an ordinary day into a different answer.
   */
  const fixedDurationStep = (iso: string, days: number, timeZone: string): string =>
    formatIsoDateInTimeZone(new Date(Date.parse(iso) - days * DAY_MS).toISOString(), timeZone)

  /**
   * Zones chosen for DIFFERENT transition times, because the defect depends on
   * where the missing / repeated hour sits relative to local midnight:
   * America/New_York moves at 02:00 local, Europe/Berlin at 01:00 UTC (so 02:00
   * / 03:00 local), and America/Santiago moves AT midnight. Asia/Tokyo never
   * transitions at all and is the ordinary-zone control.
   */
  const CASES: Array<{
    what: string
    iso: string
    days: number
    zone: string
    expected: string
    /** What the old fixed-duration arithmetic returns. Equal to `expected` on the controls. */
    naive: string
  }> = [
    {
      what: 'New York, spring forward: stepping back ONTO the 23-hour day',
      iso: '2026-03-09T04:30:00.000Z', // 00:30 on the 9th, local
      days: 1,
      zone: 'America/New_York',
      expected: '2026-03-08',
      naive: '2026-03-07',
    },
    {
      what: 'New York, spring forward: a 7-day window whose span contains the gap',
      iso: '2026-03-12T04:30:00.000Z', // 00:30 on the 12th, local
      days: 7,
      zone: 'America/New_York',
      expected: '2026-03-05',
      naive: '2026-03-04',
    },
    {
      what: 'New York, fall back: stepping back OFF the 25-hour day',
      iso: '2026-11-02T04:30:00.000Z', // 23:30 on the 1st, local
      days: 1,
      zone: 'America/New_York',
      expected: '2026-10-31',
      naive: '2026-11-01',
    },
    {
      what: 'New York, fall back: a 7-day window whose span contains the repeated hour',
      iso: '2026-11-04T04:30:00.000Z', // 23:30 on the 3rd, local
      days: 7,
      zone: 'America/New_York',
      expected: '2026-10-27',
      naive: '2026-10-28',
    },
    {
      what: 'Berlin, spring forward: a zone that transitions on a UTC instant',
      iso: '2026-03-29T22:30:00.000Z', // 00:30 on the 30th, local
      days: 1,
      zone: 'Europe/Berlin',
      expected: '2026-03-29',
      naive: '2026-03-28',
    },
    {
      what: 'Berlin, fall back',
      iso: '2026-10-25T22:30:00.000Z', // 23:30 on the 25th, local
      days: 1,
      zone: 'Europe/Berlin',
      expected: '2026-10-24',
      naive: '2026-10-25',
    },
    {
      what: 'Santiago, spring forward AT midnight: the target day has no hour 00',
      iso: '2026-09-07T03:30:00.000Z', // 00:30 on the 7th, local
      days: 1,
      zone: 'America/Santiago',
      expected: '2026-09-06',
      naive: '2026-09-05',
    },
    {
      what: 'Santiago, fall back AT midnight: the source day is 25 hours long',
      iso: '2026-04-05T03:30:00.000Z', // 23:30 on the 4th, local
      days: 1,
      zone: 'America/Santiago',
      expected: '2026-04-03',
      naive: '2026-04-04',
    },
    // Controls. The fix must leave every one of these exactly where it was.
    {
      what: 'control: the transition day itself, read at midday, is an ordinary step',
      iso: '2026-03-08T16:00:00.000Z',
      days: 1,
      zone: 'America/New_York',
      expected: '2026-03-07',
      naive: '2026-03-07',
    },
    {
      what: 'control: an ordinary date in a transitioning zone',
      iso: '2026-06-10T12:00:00.000Z',
      days: 7,
      zone: 'America/New_York',
      expected: '2026-06-03',
      naive: '2026-06-03',
    },
    {
      what: 'control: an ordinary zone that never transitions',
      iso: '2026-03-09T04:30:00.000Z',
      days: 1,
      zone: 'Asia/Tokyo',
      expected: '2026-03-08',
      naive: '2026-03-08',
    },
    {
      what: 'control: an ordinary zone, multi-day step across the date line difference',
      iso: '2026-06-10T22:00:00.000Z', // already the 11th in Tokyo
      days: 7,
      zone: 'Asia/Tokyo',
      expected: '2026-06-04',
      naive: '2026-06-04',
    },
    {
      what: 'control: UTC itself',
      iso: '2026-06-10T22:00:00.000Z',
      days: 7,
      zone: 'UTC',
      expected: '2026-06-03',
      naive: '2026-06-03',
    },
  ]

  for (const testCase of CASES) {
    test(testCase.what, () => {
      expect(isoDateDaysBeforeInTimeZone(testCase.iso, testCase.days, testCase.zone))
        .toBe(testCase.expected)
      // Pins what the row is FOR: a DST row must disagree with the fixed
      // 24-hour step, and a control must agree with it.
      expect(fixedDurationStep(testCase.iso, testCase.days, testCase.zone)).toBe(testCase.naive)
    })
  }

  test('a zero-day step is the observed local date itself', () => {
    expect(isoDateDaysBeforeInTimeZone('2026-06-10T22:00:00.000Z', 0, 'Asia/Tokyo')).toBe('2026-06-11')
    expect(isoDateDaysBeforeInTimeZone('2026-06-10T22:00:00.000Z', 0, 'America/Denver')).toBe('2026-06-10')
  })

  test('stepping back over a month and a year boundary rolls over correctly', () => {
    expect(isoDateDaysBeforeInTimeZone('2026-01-01T05:30:00.000Z', 1, 'America/New_York')).toBe('2025-12-31')
    expect(isoDateDaysBeforeInTimeZone('2026-03-01T12:00:00.000Z', 1, 'UTC')).toBe('2026-02-28')
    expect(isoDateDaysBeforeInTimeZone('2024-03-01T12:00:00.000Z', 1, 'UTC')).toBe('2024-02-29')
  })

  test('an unknown zone degrades to stepping the UTC date instead of throwing', () => {
    expect(isoDateDaysBeforeInTimeZone('2026-03-09T04:30:00.000Z', 1, 'Not/AZone')).toBe('2026-03-08')
  })

  test('an unusable input or day count comes back unchanged rather than becoming a wrong date', () => {
    expect(isoDateDaysBeforeInTimeZone('not-a-date', 1, 'America/New_York')).toBe('not-a-date')
    expect(isoDateDaysBeforeInTimeZone('2026-03-09T04:30:00.000Z', Number.NaN, 'America/New_York'))
      .toBe('2026-03-09')
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

describe('relativeChangeRatio', () => {
  test('returns the signed unrounded change relative to a positive baseline', () => {
    expect(relativeChangeRatio(150, 100)).toBe(0.5)
    expect(relativeChangeRatio(50, 100)).toBe(-0.5)
    expect(relativeChangeRatio(100.05, 100)).toBeCloseTo(0.0005, 10)
  })

  test('returns null for invalid values or a non-positive baseline', () => {
    expect(relativeChangeRatio(100, 0)).toBeNull()
    expect(relativeChangeRatio(50, -1)).toBeNull()
    expect(relativeChangeRatio(Number.NaN, 100)).toBeNull()
    expect(relativeChangeRatio(100, Number.POSITIVE_INFINITY)).toBeNull()
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

describe('inclusiveDayCount', () => {
  test('counts both ends', () => {
    // A window that names 30 dates contains 30 days. Off by one here and a
    // response labelled "30 days" describes a span it did not measure.
    expect(inclusiveDayCount('2026-03-01', '2026-03-30')).toBe(30)
    expect(inclusiveDayCount('2026-03-01', '2026-03-01')).toBe(1)
    expect(inclusiveDayCount('2026-01-01', '2026-03-30')).toBe(89)
  })

  test('crosses months and years', () => {
    expect(inclusiveDayCount('2026-02-27', '2026-03-02')).toBe(4)
    expect(inclusiveDayCount('2025-12-30', '2026-01-02')).toBe(4)
    // 2024 is a leap year: February contributes 29 days.
    expect(inclusiveDayCount('2024-02-01', '2024-03-01')).toBe(30)
  })

  test('spans a daylight-saving transition without drifting', () => {
    // UTC midnights, so a 23- or 25-hour local day cannot move the count. US
    // DST began 2026-03-08; EU DST began 2026-03-29.
    expect(inclusiveDayCount('2026-03-07', '2026-03-09')).toBe(3)
    expect(inclusiveDayCount('2026-03-28', '2026-03-30')).toBe(3)
  })

  test('returns null for a range that names no window', () => {
    // Inverted and malformed both mean "no window", and a 0 would read as a
    // real, empty one.
    expect(inclusiveDayCount('2026-03-30', '2026-03-01')).toBeNull()
    expect(inclusiveDayCount('2026-3-1', '2026-03-30')).toBeNull()
    expect(inclusiveDayCount('', '2026-03-30')).toBeNull()
    expect(inclusiveDayCount('2026-03-01', 'not-a-date')).toBeNull()
    expect(inclusiveDayCount('2026-02-30', '2026-03-30')).toBeNull()
    expect(inclusiveDayCount('2025-02-01', '2025-02-29')).toBeNull()
  })
})


test('formatZonedTimestamp keeps the configured timezone, including daylight saving', () => {
  expect(formatZonedTimestamp('2026-09-23T04:00:00Z', 'America/New_York')).toBe('Wed, Sep 23, 2026, 12:00 AM EDT')
  expect(formatZonedTimestamp('2026-11-04T05:00:00Z', 'America/New_York')).toBe('Wed, Nov 4, 2026, 12:00 AM EST')
  expect(formatZonedTimestamp('2026-09-23T04:00:00Z', 'invalid')).toBe('Wed, Sep 23, 2026, 4:00 AM UTC')
  expect(formatZonedTimestamp('invalid')).toBeNull()
})
