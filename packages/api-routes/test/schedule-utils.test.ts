import { afterEach, test, expect, vi } from 'vitest'

afterEach(() => vi.useRealTimers())
import { resolvePreset, validateCron, isValidTimezone, nextRunFromCron, nextRunFromRecurrence, nextRunFromSchedule } from '../src/schedule-utils.js'

// --- resolvePreset ---

test('resolvePreset maps daily to 6am UTC cron', () => {
  expect(resolvePreset('daily')).toBe('0 6 * * *')
})

test('resolvePreset maps weekly to Monday 6am UTC', () => {
  expect(resolvePreset('weekly')).toBe('0 6 * * 1')
})

test('resolvePreset maps twice-daily to 6am and 6pm', () => {
  expect(resolvePreset('twice-daily')).toBe('0 6,18 * * *')
})

test('resolvePreset maps daily@14 to 2pm UTC', () => {
  expect(resolvePreset('daily@14')).toBe('0 14 * * *')
})

test('resolvePreset maps weekly@fri to Friday 6am', () => {
  expect(resolvePreset('weekly@fri')).toBe('0 6 * * 5')
})

test('resolvePreset maps weekly@fri@14 to Friday 2pm', () => {
  expect(resolvePreset('weekly@fri@14')).toBe('0 14 * * 5')
})

test('resolvePreset throws for unknown preset', () => {
  expect(() => resolvePreset('hourly')).toThrow(/Unknown schedule preset/)
})

test('resolvePreset throws for invalid hour', () => {
  expect(() => resolvePreset('daily@25')).toThrow(/Invalid hour/)
})

test('resolvePreset throws for invalid day', () => {
  expect(() => resolvePreset('weekly@xyz')).toThrow(/Invalid day/)
})

// --- validateCron ---

test('validateCron accepts standard 5-field cron', () => {
  expect(validateCron('0 6 * * *')).toBe(true)
  expect(validateCron('*/5 * * * *')).toBe(true)
  expect(validateCron('0 0 1 1 0')).toBe(true)
  expect(validateCron('0 6,18 * * *')).toBe(true)
  expect(validateCron('0 6 * * 1-5')).toBe(true)
})

test('validateCron rejects invalid cron expressions', () => {
  expect(validateCron('invalid')).toBe(false)
  expect(validateCron('* * *')).toBe(false)
  expect(validateCron('60 * * * *')).toBe(false)
  expect(validateCron('* 25 * * *')).toBe(false)
})

// --- isValidTimezone ---

test('isValidTimezone accepts known IANA timezone', () => {
  expect(isValidTimezone('UTC')).toBe(true)
  expect(isValidTimezone('America/New_York')).toBe(true)
  expect(isValidTimezone('Europe/London')).toBe(true)
})

test('isValidTimezone rejects invalid timezone strings', () => {
  expect(isValidTimezone('not/a-zone')).toBe(false)
  expect(isValidTimezone('')).toBe(false)
  expect(isValidTimezone('GMT+25')).toBe(false)
})

// --- nextRunFromCron ---
// Anchor: 2026-06-01T15:33:00Z is a Monday afternoon.

test('nextRunFromCron resolves a weekday cron to the NEXT matching weekday (node-cron getNextRun regression)', () => {
  // node-cron@4's getNextRun() returns 2029-01-01 for `0 6 * * 1` here (the
  // next Jan-1-on-a-Monday). The correct answer is the upcoming Monday 06:00.
  expect(nextRunFromCron('0 6 * * 1', 'UTC', new Date('2026-06-01T15:33:00Z')))
    .toBe('2026-06-08T06:00:00.000Z')
})

test('nextRunFromCron resolves a Sunday cron correctly', () => {
  // node-cron@4 returns 2034-01-01 for `0 6 * * 0`; the correct answer is the
  // upcoming Sunday 06:00.
  expect(nextRunFromCron('0 6 * * 0', 'UTC', new Date('2026-06-01T15:33:00Z')))
    .toBe('2026-06-07T06:00:00.000Z')
})

test('nextRunFromCron resolves a daily cron to tomorrow when today has passed', () => {
  expect(nextRunFromCron('0 6 * * *', 'UTC', new Date('2026-06-01T15:33:00Z')))
    .toBe('2026-06-02T06:00:00.000Z')
})

test('nextRunFromCron returns the same-day slot when it is still ahead', () => {
  // Monday 05:00, cron fires Monday 06:00 — the next run is later today.
  expect(nextRunFromCron('0 6 * * 1', 'UTC', new Date('2026-06-01T05:00:00Z')))
    .toBe('2026-06-01T06:00:00.000Z')
})

test('nextRunFromCron interprets the cron in the supplied timezone', () => {
  // 06:00 America/New_York (EDT, UTC-4) on 2026-06-02 == 10:00 UTC. From
  // 11:33 EDT, today's 06:00 ET has passed, so the next run is tomorrow.
  expect(nextRunFromCron('0 6 * * *', 'America/New_York', new Date('2026-06-01T15:33:00Z')))
    .toBe('2026-06-02T10:00:00.000Z')
})

test('nextRunFromCron returns null for an unparseable expression', () => {
  expect(nextRunFromCron('not a cron', 'UTC', new Date('2026-06-01T15:33:00Z'))).toBeNull()
})

test('nextRunFromCron returns null for an invalid timezone', () => {
  expect(nextRunFromCron('0 6 * * *', 'not/a-zone', new Date('2026-06-01T15:33:00Z'))).toBeNull()
})


// --- calendar recurrence ---

const fortnightlyNewYork = { everyDays: 14, startDate: '2026-09-23', time: '00:00' }

test('nextRunFromRecurrence never fires before its local calendar anchor', () => {
  expect(nextRunFromRecurrence(fortnightlyNewYork, 'America/New_York', new Date('2026-09-20T12:00:00.000Z')))
    .toBe('2026-09-23T04:00:00.000Z')
})

test('nextRunFromRecurrence keeps a fortnightly midnight wall time across DST', () => {
  expect(nextRunFromRecurrence(fortnightlyNewYork, 'America/New_York', new Date('2026-09-23T04:00:00.000Z')))
    .toBe('2026-10-07T04:00:00.000Z')
  expect(nextRunFromRecurrence(fortnightlyNewYork, 'America/New_York', new Date('2026-10-07T04:00:00.000Z')))
    .toBe('2026-10-21T04:00:00.000Z')
  expect(nextRunFromRecurrence(fortnightlyNewYork, 'America/New_York', new Date('2026-10-21T04:00:00.000Z')))
    .toBe('2026-11-04T05:00:00.000Z')
})

test('nextRunFromRecurrence follows calendar ordinals across a year boundary', () => {
  expect(nextRunFromRecurrence({ everyDays: 14, startDate: '2026-12-25', time: '00:00' }, 'America/New_York', new Date('2026-12-25T05:00:00.000Z')))
    .toBe('2027-01-08T05:00:00.000Z')
})

test('nextRunFromSchedule dispatches recurrence rows and retains legacy cron rows', () => {
  expect(nextRunFromSchedule({ cronExpr: '', timezone: 'America/New_York', recurrence: fortnightlyNewYork }, new Date('2026-10-21T04:00:00.000Z')))
    .toBe('2026-11-04T05:00:00.000Z')
  expect(nextRunFromSchedule({ cronExpr: '0 6 * * *', timezone: 'UTC' }, new Date('2026-06-01T15:33:00.000Z')))
    .toBe('2026-06-02T06:00:00.000Z')
})


test('nextRunFromRecurrence chooses the earlier offset for a fall-back wall-clock ambiguity', () => {
  expect(nextRunFromRecurrence({ everyDays: 14, startDate: '2026-11-01', time: '01:30' }, 'America/New_York', new Date('2026-10-30T00:00:00.000Z')))
    .toBe('2026-11-01T05:30:00.000Z')
})


test('nextRunFromRecurrence skips a nonexistent spring-forward wall time without changing its phase', () => {
  expect(nextRunFromRecurrence({ everyDays: 1, startDate: '2026-03-08', time: '02:30' }, 'America/New_York', new Date('2026-03-07T12:00:00.000Z')))
    .toBe('2026-03-09T06:30:00.000Z')
  expect(nextRunFromRecurrence({ everyDays: 14, startDate: '2026-02-22', time: '02:30' }, 'America/New_York', new Date('2026-03-01T00:00:00.000Z')))
    .toBe('2026-03-22T06:30:00.000Z')
})

test('nextRunFromRecurrence preserves years below 100 and rejects invalid bounds', () => {
  expect(nextRunFromRecurrence({ everyDays: 1, startDate: '0099-01-01', time: '00:00' }, 'UTC', new Date('0098-12-31T12:00:00.000Z')))
    .toBe('0099-01-01T00:00:00.000Z')
  expect(nextRunFromRecurrence({ everyDays: 3651, startDate: '2026-09-23', time: '00:00' }, 'UTC', new Date())).toBeNull()
  expect(nextRunFromRecurrence(fortnightlyNewYork, 'America/New_York', new Date('invalid'))).toBeNull()
})


test('nextRunFromRecurrence picks the same fall-back instant regardless of the host clock season', () => {
  const fold = { everyDays: 14, startDate: '2026-11-01', time: '01:30' }
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-15T00:00:00.000Z'))
  expect(nextRunFromRecurrence(fold, 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
  vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'))
  expect(nextRunFromRecurrence(fold, 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
})
