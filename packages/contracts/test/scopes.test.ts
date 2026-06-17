import { describe, expect, it } from 'vitest'
import { READ_ONLY_SCOPE, WILDCARD_SCOPE, isReadOnlyKey } from '../src/scopes.js'

describe('scope constants', () => {
  it('exposes the canonical tokens', () => {
    expect(READ_ONLY_SCOPE).toBe('read')
    expect(WILDCARD_SCOPE).toBe('*')
  })
})

describe('isReadOnlyKey', () => {
  it('is true for a key minted with exactly the read scope', () => {
    expect(isReadOnlyKey(['read'])).toBe(true)
  })

  it('is false for the wildcard key', () => {
    expect(isReadOnlyKey(['*'])).toBe(false)
  })

  it('is false when read is combined with the wildcard', () => {
    expect(isReadOnlyKey(['read', '*'])).toBe(false)
  })

  it('is false when a named *.write scope is present alongside read', () => {
    expect(isReadOnlyKey(['read', 'keys.write'])).toBe(false)
    expect(isReadOnlyKey(['read', 'settings.write'])).toBe(false)
  })

  it('is false for the bare write scope alongside read', () => {
    expect(isReadOnlyKey(['read', 'write'])).toBe(false)
  })

  it('is false for a write-only scoped key that never opted into read', () => {
    expect(isReadOnlyKey(['keys.write'])).toBe(false)
    expect(isReadOnlyKey(['settings.write'])).toBe(false)
  })

  it('is false for an empty scope set (no explicit read marker)', () => {
    // Additive semantics: read-only is opt-in via the `read` token. An empty
    // or unrecognized scope list is NOT treated as read-only, so existing
    // keys keep their current (ungated-write) behavior.
    expect(isReadOnlyKey([])).toBe(false)
    expect(isReadOnlyKey(['analytics'])).toBe(false)
  })
})
