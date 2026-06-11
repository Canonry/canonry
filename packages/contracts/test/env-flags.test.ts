import { describe, expect, it } from 'vitest'
import { parseBooleanFlag } from '../src/env-flags.js'

describe('parseBooleanFlag', () => {
  it('accepts the canonical truthy set, case-insensitive and trimmed', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', ' 1 ', '\ttrue\n']) {
      expect(parseBooleanFlag(v), JSON.stringify(v)).toBe(true)
    }
  })

  it('rejects everything else', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', 'enabled', '2', 'yes!', ' ']) {
      expect(parseBooleanFlag(v), JSON.stringify(v)).toBe(false)
    }
  })
})
