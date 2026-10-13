import { describe, expect, it } from 'vitest'
import { parseWindow, resolveDateRange } from '../src/analytics.js'
import { parseWindowToken } from '../src/time-window.js'
import { parseTrafficAnalyticsPeriod } from '../src/traffic-analytics.js'

describe('shared window grammar through existing parsers', () => {
  it('normalizes bare integers and day tokens without widening the allowed sets', () => {
    expect(parseWindow('30')).toBe('30d')
    expect(parseTrafficAnalyticsPeriod('30d')).toBe(30)
    expect(parseWindow('all')).toBe('all')
    expect(parseWindow('')).toBe('all')
  })
  it.each(['28d', '0d', '-7d', '7D', '1w'])('rejects unsupported metrics token %s with structured alternatives', value => {
    expect(() => parseWindow(value)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', message: `Invalid window "${value}". Must be one of: 7d, 30d, 90d, all.`, details: { field: 'window', value, allowed: ['7d', '30d', '90d', 'all'] } }))
  })
  it('keeps calendar-date validity and ordering independent of rolling labels', () => {
    expect(() => resolveDateRange({ startDate: '2026-02-30' })).toThrow(/calendar date/)
    expect(() => resolveDateRange({ startDate: '2026-10-02', endDate: '2026-10-01' })).toThrow(/on or before/)
    expect(resolveDateRange({ window: '7d', startDate: '2026-09-01', endDate: '2026-09-30' })).toMatchObject({ startDate: '2026-09-01', endDate: '2026-09-30', window: '7d', explicitDates: true })
  })
})

describe('window token grammar', () => {
  it.each([['7d', { days: 7 }], ['28d', { days: 28 }], ['all', 'all'], ['30', { days: 30 }], [90, { days: 90 }]])('parses %s independently of a command allowed set', (value, expected) => {
    expect(parseWindowToken(value as string | number)).toEqual(expected)
  })
  it.each(['', '0d', '-7d', '7D', '1w', ' 7d', '7d ', '1.5', '9007199254740992'])('refuses malformed or unsafe token %s', value => {
    expect(parseWindowToken(value)).toBeNull()
  })
})
