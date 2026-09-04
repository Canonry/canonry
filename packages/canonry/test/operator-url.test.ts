import { describe, expect, it } from 'vitest'

import { operatorHost, operatorHttpUrl } from '../src/operator-url.js'

describe('operator-facing server URLs', () => {
  it('turns the IPv4 wildcard bind into an openable IPv4 loopback URL', () => {
    expect(operatorHost('0.0.0.0')).toBe('127.0.0.1')
    expect(operatorHttpUrl('0.0.0.0', 4100)).toBe('http://127.0.0.1:4100')
  })

  it('preserves an explicit bind host', () => {
    expect(operatorHttpUrl('192.0.2.10', '4110')).toBe('http://192.0.2.10:4110')
  })
})
