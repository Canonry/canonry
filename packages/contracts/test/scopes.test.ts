import { describe, expect, it } from 'vitest'
import {
  ADS_ACTIVATE_SCOPE,
  ADS_APPROVE_SCOPE,
  ADS_WRITE_SCOPE,
  ANALYTICS_READ_CAPABILITY,
  DASHBOARD_READ_CAPABILITY,
  FULL_READ_CAPABILITY,
  GOOGLE_MARKETING_LIVE_READ_SCOPE,
  GOOGLE_MARKETING_WRITE_SCOPE,
  READ_ONLY_SCOPE,
  WILDCARD_SCOPE,
  SEO_RUN_SCOPE,
  SEO_WRITE_SCOPE,
  isReadOnlyKey,
  restrictedWriteScopes,
  intersectScopes,
  capabilitiesForScopes,
} from '../src/scopes.js'

describe('scope constants', () => {
  it('exposes the canonical tokens', () => {
    expect(READ_ONLY_SCOPE).toBe('read')
    expect(WILDCARD_SCOPE).toBe('*')
    expect(ADS_WRITE_SCOPE).toBe('ads.write')
    expect(ADS_APPROVE_SCOPE).toBe('ads.approve')
    expect(ADS_ACTIVATE_SCOPE).toBe('ads.activate')
    expect(GOOGLE_MARKETING_LIVE_READ_SCOPE).toBe('google-marketing.read-live')
    expect(GOOGLE_MARKETING_WRITE_SCOPE).toBe('google-marketing.write')
  })
})

describe('isReadOnlyKey', () => {
  it.each([SEO_RUN_SCOPE, SEO_WRITE_SCOPE])('keeps %s restricted to its authorized SEO routes', scope => {
    expect(isReadOnlyKey(['read', scope])).toBe(false)
    expect(restrictedWriteScopes(['read', scope])).toEqual([scope])
    expect(restrictedWriteScopes([scope, 'research.run'])).toEqual([scope, 'research.run'])
    expect(intersectScopes(['read'], ['read', scope])).toEqual(['read'])
    expect(intersectScopes(['read', scope], ['read', 'settings.write'])).toEqual(['read'])
  })
  it.each(['logs.read', 'users.read', 'custom.read'])('treats the named read scope %s as read-only by default', scope => {
    expect(isReadOnlyKey([scope])).toBe(true)
    expect(isReadOnlyKey([scope, 'read'])).toBe(true)
    expect(isReadOnlyKey([scope, '*'])).toBe(false)
    expect(isReadOnlyKey([scope, 'settings.write'])).toBe(false)
    expect(isReadOnlyKey([scope, 'research.run'])).toBe(false)
    expect(restrictedWriteScopes([scope, 'research.run'])).toEqual(['research.run'])
  })

  it('distinguishes bounded research from both read-only and broad write authority', () => {
    expect(isReadOnlyKey(['read', 'research.run'])).toBe(false)
    expect(restrictedWriteScopes(['read', 'research.run'])).toEqual(['research.run'])
    expect(restrictedWriteScopes(['research.run'])).toEqual(['research.run'])
    expect(restrictedWriteScopes(['read', 'research.run', 'ads.write'])).toEqual(['research.run', 'ads.write'])
    expect(restrictedWriteScopes(['*', 'research.run'])).toBeNull()
    expect(intersectScopes(['read', 'research.run'], ['read'])).toEqual(['read'])
    expect(intersectScopes(['read'], ['read', 'research.run'])).toEqual(['read'])
    expect(intersectScopes(['*'], ['read', 'research.run'])).toEqual(['read', 'research.run'])
    expect(intersectScopes(['read'], ['research.run'])).toEqual(['read'])
  })
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
    expect(isReadOnlyKey(['read', GOOGLE_MARKETING_WRITE_SCOPE])).toBe(false)
  })

  it('is false when an approval or activation scope is present alongside read', () => {
    expect(isReadOnlyKey(['read', ADS_APPROVE_SCOPE])).toBe(false)
    expect(isReadOnlyKey(['read', ADS_ACTIVATE_SCOPE])).toBe(false)
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

describe('capabilitiesForScopes (#817)', () => {
  it('exposes the capability tokens', () => {
    expect(DASHBOARD_READ_CAPABILITY).toBe('dashboard.read')
    expect(ANALYTICS_READ_CAPABILITY).toBe('analytics.read')
    expect(FULL_READ_CAPABILITY).toBe('full.read')
  })

  it('maps the wildcard and legacy read to every capability', () => {
    expect([...capabilitiesForScopes(['*'])].sort()).toEqual(['analytics.read', 'dashboard.read', 'full.read'])
    expect([...capabilitiesForScopes(['read'])].sort()).toEqual(['analytics.read', 'dashboard.read', 'full.read'])
    expect([...capabilitiesForScopes(['read', 'keys.write'])].sort()).toEqual(['analytics.read', 'dashboard.read', 'full.read'])
  })

  it('maps embed to the dashboard bundle only', () => {
    expect([...capabilitiesForScopes(['embed'])]).toEqual(['dashboard.read'])
  })

  it('nests explicit bundles: a broader bundle includes the narrower ones', () => {
    expect([...capabilitiesForScopes(['dashboard.read'])]).toEqual(['dashboard.read'])
    expect([...capabilitiesForScopes(['analytics.read'])].sort()).toEqual(['analytics.read', 'dashboard.read'])
    expect([...capabilitiesForScopes(['full.read'])].sort()).toEqual(['analytics.read', 'dashboard.read', 'full.read'])
  })

  it('grants no capability to unrelated read scopes', () => {
    expect([...capabilitiesForScopes(['users.read'])]).toEqual([])
    expect([...capabilitiesForScopes(['google-marketing.read-live'])]).toEqual([])
    expect([...capabilitiesForScopes([])]).toEqual([])
  })

  it('keeps a capability-only key read-only', () => {
    expect(isReadOnlyKey(['dashboard.read'])).toBe(true)
    expect(isReadOnlyKey(['full.read'])).toBe(true)
    expect(isReadOnlyKey(['dashboard.read', 'settings.write'])).toBe(false)
  })
}))
