import { describe, it, expect } from 'vitest'
import {
  formatHour,
  buildPreset,
  parsePreset,
  scheduleLabel,
  formatTimeZoneLabel,
  localTimeZoneLabel,
} from '../src/lib/format-helpers.js'

describe('formatHour', () => {
  it('formats midnight', () => {
    expect(formatHour(0)).toBe('12:00 AM')
  })

  it('formats morning hours', () => {
    expect(formatHour(6)).toBe('6:00 AM')
    expect(formatHour(11)).toBe('11:00 AM')
  })

  it('formats noon', () => {
    expect(formatHour(12)).toBe('12:00 PM')
  })

  it('formats afternoon hours', () => {
    expect(formatHour(13)).toBe('1:00 PM')
    expect(formatHour(23)).toBe('11:00 PM')
  })
})

describe('buildPreset', () => {
  it('builds daily preset with hour', () => {
    expect(buildPreset('daily', 9)).toBe('daily@9')
  })

  it('builds twice-daily preset (ignores hour)', () => {
    expect(buildPreset('twice-daily', 6)).toBe('twice-daily')
  })

  it('builds weekly preset with day and hour', () => {
    expect(buildPreset('weekly@mon', 8)).toBe('weekly@mon@8')
  })
})

describe('parsePreset', () => {
  it('parses daily@9', () => {
    expect(parsePreset('daily@9', '')).toEqual({ freq: 'daily', hour: 9, customCron: '' })
  })

  it('parses daily without hour (defaults to 6)', () => {
    expect(parsePreset('daily', '')).toEqual({ freq: 'daily', hour: 6, customCron: '' })
  })

  it('parses twice-daily', () => {
    expect(parsePreset('twice-daily', '')).toEqual({ freq: 'twice-daily', hour: 6, customCron: '' })
  })

  it('parses weekly@mon@10', () => {
    expect(parsePreset('weekly@mon@10', '')).toEqual({ freq: 'weekly@mon', hour: 10, customCron: '' })
  })

  it('parses weekly@fri without hour', () => {
    expect(parsePreset('weekly@fri', '')).toEqual({ freq: 'weekly@fri', hour: 6, customCron: '' })
  })

  it('falls back to custom for null preset', () => {
    expect(parsePreset(null, '0 5 * * *')).toEqual({ freq: 'custom', hour: 6, customCron: '0 5 * * *' })
  })

  it('falls back to custom for unknown preset string', () => {
    expect(parsePreset('bogus', '0 5 * * *')).toEqual({ freq: 'custom', hour: 6, customCron: '0 5 * * *' })
  })
})

describe('scheduleLabel', () => {
  it('returns daily label with formatted hour', () => {
    expect(scheduleLabel('daily@9', '', 'UTC')).toBe('Every day at 9:00 AM · UTC')
  })

  it('returns twice-daily label', () => {
    expect(scheduleLabel('twice-daily', '', 'UTC')).toBe('Twice a day (6am & 6pm) · UTC')
  })

  it('returns weekly label with day name', () => {
    expect(scheduleLabel('weekly@mon@8', '', 'America/New_York')).toBe('Every Monday at 8:00 AM · New York')
  })

  it('returns custom cron when preset is null', () => {
    expect(scheduleLabel(null, '0 5 * * *', 'UTC')).toBe('Custom: 0 5 * * * · UTC')
  })

  it('falls through to raw preset for unrecognized preset', () => {
    expect(scheduleLabel('something-else', '', 'UTC')).toBe('something-else · UTC')
  })
})

describe('formatTimeZoneLabel', () => {
  it('combines zone and abbreviation', () => {
    expect(formatTimeZoneLabel('America/New_York', 'EDT')).toBe('America/New_York · EDT')
  })

  it('falls back to the zone alone when the abbreviation is missing', () => {
    expect(formatTimeZoneLabel('America/New_York', undefined)).toBe('America/New_York')
  })

  it('does not duplicate when the abbreviation equals the zone', () => {
    expect(formatTimeZoneLabel('UTC', 'UTC')).toBe('UTC')
  })
})

describe('localTimeZoneLabel', () => {
  it('resolves a non-empty timezone label from the runtime', () => {
    const label = localTimeZoneLabel()
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
  })
})
