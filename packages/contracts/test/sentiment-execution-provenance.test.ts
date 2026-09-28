import { expect, test } from 'vitest'
import { canonicalMeasurementExecutionIdentityJson, parseStoredMeasurementExecutionIdentity } from '../src/measurement-plan.js'

test('new Advanced executions retain language while historical engine checksums stay readable', () => {
  const old = { schemaVersion: 1, providers: ['openai'], models: { openai: 'gpt-test' }, checksum: 'a'.repeat(64) }
  expect(parseStoredMeasurementExecutionIdentity(old)).toEqual(old)
  expect(parseStoredMeasurementExecutionIdentity({ ...old, language: 'en' })).toEqual({ ...old, language: 'en' })
  expect(canonicalMeasurementExecutionIdentityJson(old)).toBe(canonicalMeasurementExecutionIdentityJson({ ...old }))
})
