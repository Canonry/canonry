import { test, expect } from 'vitest'
import { resolvePreset, validateCron, isValidTimezone, nextRunFromCron } from '../src/schedule-utils.js'

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
