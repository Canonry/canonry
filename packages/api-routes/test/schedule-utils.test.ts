import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePreset, validateCron, isValidTimezone } from '../src/schedule-utils.js'

// --- resolvePreset ---

test('resolvePreset maps daily to 6am UTC cron', () => {
  assert.equal(resolvePreset('daily'), '0 6 * * *')
})

test('resolvePreset maps weekly to Monday 6am UTC', () => {
  assert.equal(resolvePreset('weekly'), '0 6 * * 1')
})

test('resolvePreset maps twice-daily to 6am and 6pm', () => {
  assert.equal(resolvePreset('twice-daily'), '0 6,18 * * *')
})

test('resolvePreset maps daily@14 to 2pm UTC', () => {
  assert.equal(resolvePreset('daily@14'), '0 14 * * *')
})

test('resolvePreset maps weekly@fri to Friday 6am', () => {
  assert.equal(resolvePreset('weekly@fri'), '0 6 * * 5')
})

test('resolvePreset maps weekly@fri@14 to Friday 2pm', () => {
  assert.equal(resolvePreset('weekly@fri@14'), '0 14 * * 5')
})

test('resolvePreset throws for unknown preset', () => {
  assert.throws(() => resolvePreset('hourly'), /Unknown schedule preset/)
})

test('resolvePreset throws for invalid hour', () => {
  assert.throws(() => resolvePreset('daily@25'), /Invalid hour/)
})

test('resolvePreset throws for invalid day', () => {
  assert.throws(() => resolvePreset('weekly@xyz'), /Invalid day/)
})

// --- validateCron ---

test('validateCron accepts standard 5-field cron', () => {
  assert.equal(validateCron('0 6 * * *'), true)
  assert.equal(validateCron('*/5 * * * *'), true)
  assert.equal(validateCron('0 0 1 1 0'), true)
  assert.equal(validateCron('0 6,18 * * *'), true)
  assert.equal(validateCron('0 6 * * 1-5'), true)
})

test('validateCron rejects invalid cron expressions', () => {
  assert.equal(validateCron('invalid'), false)
  assert.equal(validateCron('* * *'), false)
  assert.equal(validateCron('60 * * * *'), false)
  assert.equal(validateCron('* 25 * * *'), false)
})

// --- isValidTimezone ---

test('isValidTimezone accepts known IANA timezone', () => {
  assert.equal(isValidTimezone('UTC'), true)
  assert.equal(isValidTimezone('America/New_York'), true)
  assert.equal(isValidTimezone('Europe/London'), true)
})

test('isValidTimezone rejects invalid timezone strings', () => {
  assert.equal(isValidTimezone('not/a-zone'), false)
  assert.equal(isValidTimezone(''), false)
  assert.equal(isValidTimezone('GMT+25'), false)
})
