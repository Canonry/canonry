import { expect, test } from 'vitest'
import { asRecord } from '../src/record.js'

test('narrows objects without copying and rejects non-object JSON values', () => {
  const object = { type: 'message', content: [] }
  expect(asRecord(object)).toBe(object)
  for (const value of [null, undefined, [], ['message'], 'message', 0, true]) {
    expect(asRecord(value)).toBeNull()
  }
})
