import { describe, it, expect } from 'vitest'
import { calendarRecurrenceSchema, nextScheduleUpdatedAt, schedulableRunKindSchema, scheduleEnabledAt, scheduleUpsertRequestSchema, SchedulableRunKinds } from '../src/schedule.js'

describe('schedulableRunKindSchema', () => {
  it('accepts all nine public schedulable run kinds', () => {
    const kinds = ['answer-visibility', 'traffic-sync', 'gbp-sync', 'data-refresh', 'backlinks-sync', 'site-audit', 'ads-sync', 'doctor', 'seo-sync']
    expect(schedulableRunKindSchema.options).toEqual(kinds)
    for (const kind of kinds) expect(schedulableRunKindSchema.safeParse(kind).success).toBe(true)
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

describe('scheduleEnabledAt', () => {
  const at = '2026-11-25T12:00:00.000Z'
  it('records when a schedule turns on and keeps it while the schedule stays on', () => {
    expect(scheduleEnabledAt(undefined, true, at)).toBe(at)
    expect(scheduleEnabledAt({ enabled: false, enabledAt: null }, true, at)).toBe(at)
    // Editing an enabled schedule (a new cron, say) does not restart its enabled period.
    expect(scheduleEnabledAt({ enabled: true, enabledAt: '2026-10-25T12:00:00.000Z' }, true, at)).toBe('2026-10-25T12:00:00.000Z')
    // A row from before the column stays unknown, which reads as its creation time.
    expect(scheduleEnabledAt({ enabled: true, enabledAt: null }, true, at)).toBeNull()
  })

  it('holds nothing while the schedule is disabled', () => {
    expect(scheduleEnabledAt(undefined, false, at)).toBeNull()
    expect(scheduleEnabledAt({ enabled: true, enabledAt: '2026-10-25T12:00:00.000Z' }, false, at)).toBeNull()
  })
})
