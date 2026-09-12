import { expect, it } from 'vitest'
import { resolveOperatorApiKeyIds } from '../src/index.js'

it('defaults to no operators and parses an explicit deduplicated host allowlist', () => {
  expect(resolveOperatorApiKeyIds({})).toEqual([])
  expect(resolveOperatorApiKeyIds({ CANONRY_OPERATOR_KEY_IDS: ' ' })).toEqual([])
  expect(resolveOperatorApiKeyIds({ CANONRY_OPERATOR_KEY_IDS: 'key_first, second-id, key_first' })).toEqual(['key_first', 'second-id'])
})

it.each(['*', 'key_1,', ',key_1', 'key 1', 'key\n1', 'a'.repeat(257), Array.from({ length: 101 }, (_, i) => `key_${i}`).join(',')])('rejects malformed or unbounded operator configuration', value => {
  expect(() => resolveOperatorApiKeyIds({ CANONRY_OPERATOR_KEY_IDS: value })).toThrow()
})
