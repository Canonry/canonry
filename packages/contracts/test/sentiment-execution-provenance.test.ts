import { expect, test } from 'vitest'
import { canonicalMeasurementExecutionIdentityJson, parseStoredMeasurementExecutionIdentity } from '../src/measurement-plan.js'

test('new Advanced executions retain language while historical engine checksums stay readable', () => {
  const old = { schemaVersion: 1, providers: ['openai'], models: { openai: 'gpt-test' }, checksum: 'a'.repeat(64) }
  const withLanguage = { ...old, language: 'en' }
  expect(parseStoredMeasurementExecutionIdentity(old)).toEqual(old)
  expect(parseStoredMeasurementExecutionIdentity(withLanguage)).toEqual(withLanguage)
  const canonical = '{"models":{"openai":"gpt-test"},"providers":["openai"],"schemaVersion":1}'
  expect(canonicalMeasurementExecutionIdentityJson(old)).toBe(canonical)
  expect(canonicalMeasurementExecutionIdentityJson(withLanguage)).toBe(canonical)
})
