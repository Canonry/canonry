import { describe, expect, it, test } from 'vitest'
import { asRecord, jsonValueText } from '../src/record.js'

test('narrows objects without copying and rejects non-object JSON values', () => {
  const object = { type: 'message', content: [] }
  expect(asRecord(object)).toBe(object)
  for (const value of [null, undefined, [], ['message'], 'message', 0, true]) {
    expect(asRecord(value)).toBeNull()
  }
})

describe('jsonValueText', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic

  it.each([
    ['a string, untouched', '  Jordan Lee ', '  Jordan Lee '],
    ['an empty string', '', ''],
    ['a number', 42, '42'],
    ['zero', 0, '0'],
    ['a negative decimal', -1.5, '-1.5'],
    ['false', false, 'false'],
    ['a bigint', 9007199254740993n, '9007199254740993'],
    ['an array, as JSON', ['a', 2], '["a",2]'],
    ['an object, as JSON rather than [object Object]', { email: 'j@example.com' }, '{"email":"j@example.com"}'],
    ['an empty object', {}, '{}'],
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['a symbol', Symbol('s'), ''],
    ['a function', () => 1, ''],
    ['an object JSON cannot write (cycle)', cyclic, ''],
    ['an object holding a bigint', { n: 1n }, ''],
  ])('%s', (_label, value, want) => {
    expect(jsonValueText(value)).toBe(want)
  })
})
