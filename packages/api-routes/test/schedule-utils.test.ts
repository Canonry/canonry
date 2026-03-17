import { test, expect } from 'vitest'
import { resolvePreset, validateCron, isValidTimezone } from '../src/schedule-utils.js'

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
