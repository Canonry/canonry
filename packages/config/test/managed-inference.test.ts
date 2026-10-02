import { expect, it } from 'vitest'
import { resolveManagedInferenceKey } from '../src/index.js'

it('leaves personal inference disabled until a host provides a valid tenant key', () => {
  expect(resolveManagedInferenceKey({})).toBeUndefined()
  expect(resolveManagedInferenceKey({ CANONRY_MANAGED_INFERENCE_KEY: ' ' })).toBeUndefined()
  expect(resolveManagedInferenceKey({ CANONRY_MANAGED_INFERENCE_KEY: ` ${'AB'.repeat(32)} ` })).toBe('AB'.repeat(32))
})

it.each(['secret-invalid-key', 'ab'.repeat(31), 'ab'.repeat(33), 'gh'.repeat(32)])('rejects malformed host trust keys without reflecting them', value => {
  expect(() => resolveManagedInferenceKey({ CANONRY_MANAGED_INFERENCE_KEY: value })).toThrow('must be a 64-character hexadecimal key')
  try {
    resolveManagedInferenceKey({ CANONRY_MANAGED_INFERENCE_KEY: value })
  } catch (error) {
    expect(String(error)).not.toContain(value)
  }
})
