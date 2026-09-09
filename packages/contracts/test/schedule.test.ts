import { describe, it, expect } from 'vitest'
import { calendarRecurrenceSchema, nextScheduleUpdatedAt, schedulableRunKindSchema, scheduleUpsertRequestSchema, SchedulableRunKinds } from '../src/schedule.js'

describe('schedulableRunKindSchema', () => {
  it('accepts answer-visibility, traffic-sync, gbp-sync, data-refresh, backlinks-sync, and ads-sync', () => {
    expect(schedulableRunKindSchema.safeParse('answer-visibility').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('traffic-sync').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('gbp-sync').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('data-refresh').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('backlinks-sync').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('ads-sync').success).toBe(true)
  })

  it('rejects non-schedulable run kinds', () => {
    // gsc-sync is a real RunKind but is not user-schedulable.
    expect(schedulableRunKindSchema.safeParse('gsc-sync').success).toBe(false)
    expect(schedulableRunKindSchema.safeParse('inspect-sitemap').success).toBe(false)
    expect(schedulableRunKindSchema.safeParse('backlink-extract').success).toBe(false)
    expect(schedulableRunKindSchema.safeParse('nonsense').success).toBe(false)
  })

  it('exposes gbp-sync, backlinks-sync, and ads-sync enum constants', () => {
    expect(SchedulableRunKinds['gbp-sync']).toBe('gbp-sync')
    expect(SchedulableRunKinds['backlinks-sync']).toBe('backlinks-sync')
    expect(SchedulableRunKinds['ads-sync']).toBe('ads-sync')
  })
})

describe('scheduleUpsertRequestSchema', () => {
  it('accepts exact and create-only guards and rejects malformed timestamps', () => {
    expect(scheduleUpsertRequestSchema.safeParse({ preset: 'daily', expectedUpdatedAt: '2026-09-02T12:00:00.000Z' }).success).toBe(true)
    expect(scheduleUpsertRequestSchema.safeParse({ preset: 'daily', expectedUpdatedAt: null }).success).toBe(true)
    expect(scheduleUpsertRequestSchema.safeParse({ preset: 'daily', expectedUpdatedAt: 'yesterday' }).success).toBe(false)
  })
})

describe('nextScheduleUpdatedAt', () => {
  const current = '2026-09-05T12:00:00.000Z'
  const currentMs = Date.parse(current)

  it('uses wall time when creating a schedule or advancing past the current version', () => {
    expect(nextScheduleUpdatedAt(undefined, currentMs)).toBe(current)
    expect(nextScheduleUpdatedAt(current, currentMs + 10)).toBe('2026-09-05T12:00:00.010Z')
  })

  it('advances the version on equal ticks and clock rollback', () => {
    expect(nextScheduleUpdatedAt(current, currentMs)).toBe('2026-09-05T12:00:00.001Z')
    expect(nextScheduleUpdatedAt(current, currentMs - 60_000)).toBe('2026-09-05T12:00:00.001Z')
  })
})


describe('calendar recurrence', () => {
  const recurrence = { everyDays: 14, startDate: '2026-09-23', time: '00:00' }

  it('accepts an anchored calendar schedule and rejects mixed timing modes', () => {
    expect(scheduleUpsertRequestSchema.parse({ recurrence, timezone: 'America/New_York' }).recurrence).toEqual(recurrence)
    for (const payload of [{}, { preset: '' }, { cron: '' }, { recurrence, cron: '0 0 * * *' }, { recurrence, preset: 'daily' }]) {
      expect(scheduleUpsertRequestSchema.safeParse(payload).success).toBe(false)
    }
  })

  it.each([
    { everyDays: 0 }, { everyDays: 1.5 }, { everyDays: 3651 },
    { startDate: '2026-02-29' }, { startDate: '2026-04-31' },
    { startDate: '09/23/2026' }, { time: '24:00' }, { time: '0:00' }, { unknown: true },
  ])('rejects invalid calendar input %j', (invalid) => {
    expect(calendarRecurrenceSchema.safeParse({ ...recurrence, ...invalid }).success).toBe(false)
  })

  it('accepts a leap day in a leap year', () => {
    expect(calendarRecurrenceSchema.safeParse({ ...recurrence, startDate: '2028-02-29' }).success).toBe(true)
  })
})
