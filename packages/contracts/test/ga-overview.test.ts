import { describe, expect, it } from 'vitest'
import {
  formatDurationSeconds,
  formatGaOverviewValue,
  gaOverviewChangeTone,
  gaOverviewComparisonRanges,
  isGaOverviewWindow,
  GA_OVERVIEW_HISTORY_DAYS,
  GA_OVERVIEW_METRICS,
  GA_OVERVIEW_METRIC_ORDER,
  GaOverviewBetter,
  GaOverviewChangeTones,
  gaOverviewValuesSchema,
} from '../src/index.js'

describe('gaOverviewComparisonRanges', () => {
  const now = new Date('2026-10-23T09:00:00Z')

  it('draws each window as GA4 does: complete days ending yesterday, beside the same span before it', () => {
    expect(gaOverviewComparisonRanges('7d', now)).toEqual({
      current: { startDate: '2026-10-16', endDate: '2026-10-22' },
      previous: { startDate: '2026-10-09', endDate: '2026-10-15' },
    })
    expect(gaOverviewComparisonRanges('90d', now)).toEqual({
      current: { startDate: '2026-07-25', endDate: '2026-10-22' },
      previous: { startDate: '2026-04-26', endDate: '2026-07-24' },
    })
  })

  it('keeps the two periods the same length, back to back, inside the stored history', () => {
    for (const window of ['7d', '30d', '90d'] as const) {
      const { current, previous } = gaOverviewComparisonRanges(window, now)
      const days = (start: string, end: string) => (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1
      expect(days(current.startDate, current.endDate)).toBe(Number.parseInt(window, 10))
      expect(days(previous.startDate, previous.endDate)).toBe(Number.parseInt(window, 10))
      expect(days(previous.endDate, current.startDate)).toBe(2)
      // The sync keeps GA_OVERVIEW_HISTORY_DAYS of daily totals before today.
      expect(days(previous.startDate, '2026-10-23') - 1).toBeLessThanOrEqual(GA_OVERVIEW_HISTORY_DAYS)
    }
  })

  it('crosses month and year boundaries on calendar dates', () => {
    expect(gaOverviewComparisonRanges('7d', new Date('2027-01-03T23:30:00Z'))).toEqual({
      current: { startDate: '2026-12-27', endDate: '2027-01-02' },
      previous: { startDate: '2026-12-20', endDate: '2026-12-26' },
    })
  })
})

describe('isGaOverviewWindow', () => {
  it('accepts only the overview windows', () => {
    expect(['7d', '30d', '90d'].every(isGaOverviewWindow)).toBe(true)
    for (const value of ['all', '60d', '', undefined, 30]) expect(isGaOverviewWindow(value)).toBe(false)
  })
})

describe('formatDurationSeconds', () => {
  it('reads like GA4 engagement time', () => {
    expect(formatDurationSeconds(0)).toBe('0s')
    expect(formatDurationSeconds(45.4)).toBe('45s')
    expect(formatDurationSeconds(59.6)).toBe('1m 00s')
    expect(formatDurationSeconds(65)).toBe('1m 05s')
    expect(formatDurationSeconds(3725)).toBe('1h 02m')
  })

  it('never prints a negative or non-finite duration', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatDurationSeconds(value)).toBe('—')
  })
})

describe('formatGaOverviewValue', () => {
  it('prints each figure in its own unit', () => {
    expect(formatGaOverviewValue('sessions', 4528)).toBe('4,528')
    expect(formatGaOverviewValue('sessions', 4528, { compact: true })).toBe('4.5K')
    expect(formatGaOverviewValue('keyEvents', 2.5)).toBe('2.5')
    expect(formatGaOverviewValue('engagementRate', 0.6076)).toBe('60.8%')
    expect(formatGaOverviewValue('bounceRate', 0.3924, { compact: true })).toBe('39.2%')
    expect(formatGaOverviewValue('averageEngagementTimeSeconds', 91.4)).toBe('1m 31s')
  })

  it('prints a figure GA4 never reported as a dash, and a measured zero as zero', () => {
    expect(formatGaOverviewValue('views', null)).toBe('—')
    expect(formatGaOverviewValue('views', 0)).toBe('0')
    expect(formatGaOverviewValue('engagementRate', 0)).toBe('0%')
  })
})

describe('gaOverviewChangeTone', () => {
  it('reads a rise as good news for every figure but bounce rate', () => {
    for (const key of GA_OVERVIEW_METRIC_ORDER) {
      const higherIsBetter = GA_OVERVIEW_METRICS[key].better === GaOverviewBetter.higher
      expect(gaOverviewChangeTone(key, 6.4)).toBe(higherIsBetter ? GaOverviewChangeTones.better : GaOverviewChangeTones.worse)
      expect(gaOverviewChangeTone(key, -6.4)).toBe(higherIsBetter ? GaOverviewChangeTones.worse : GaOverviewChangeTones.better)
    }
    expect(GA_OVERVIEW_METRIC_ORDER.filter(key => GA_OVERVIEW_METRICS[key].better === GaOverviewBetter.lower)).toEqual(['bounceRate'])
  })

  it('has no tone without a change, and a flat one for no change', () => {
    expect(gaOverviewChangeTone('sessions', null)).toBeNull()
    expect(gaOverviewChangeTone('bounceRate', 0)).toBe(GaOverviewChangeTones.flat)
  })
})

describe('overview metric metadata', () => {
  it('describes exactly the figures the API sends, each listed once', () => {
    const keys = Object.keys(gaOverviewValuesSchema.shape).sort()
    expect(Object.keys(GA_OVERVIEW_METRICS).sort()).toEqual(keys)
    expect([...GA_OVERVIEW_METRIC_ORDER].sort()).toEqual(keys)
  })
})
