import { describe, it, expect } from 'vitest'
import {
  normalizeFrameOrigin,
  parseOriginList,
  frameAncestorsHeaderValue,
  buildEmbedClientConfig,
  type ResolvedEmbedConfig,
} from '../src/embed.js'

describe('normalizeFrameOrigin', () => {
  it('lowercases scheme + host and strips a trailing slash / path', () => {
    expect(normalizeFrameOrigin('https://App.Example.com/')).toBe('https://app.example.com')
    expect(normalizeFrameOrigin('HTTPS://EXAMPLE.COM')).toBe('https://example.com')
  })

  it('drops default ports (443/80) but preserves an explicit non-default port', () => {
    expect(normalizeFrameOrigin('https://example.com:443')).toBe('https://example.com')
    expect(normalizeFrameOrigin('http://example.com:80')).toBe('http://example.com')
    expect(normalizeFrameOrigin('https://example.com:8443')).toBe('https://example.com:8443')
  })

  it('rejects wildcards, paths, userinfo, bare hosts and non-http(s) schemes', () => {
    expect(normalizeFrameOrigin('*')).toBeNull()
    expect(normalizeFrameOrigin('https://*.example.com')).toBeNull()
    expect(normalizeFrameOrigin('https://example.com/path')).toBeNull()
    expect(normalizeFrameOrigin('https://example.com/?q=1')).toBeNull()
    expect(normalizeFrameOrigin('http://user:pass@example.com')).toBeNull()
    expect(normalizeFrameOrigin('acme.com')).toBeNull()
    expect(normalizeFrameOrigin('ftp://example.com')).toBeNull()
    expect(normalizeFrameOrigin('javascript:alert(1)')).toBeNull()
    expect(normalizeFrameOrigin('')).toBeNull()
    expect(normalizeFrameOrigin('   ')).toBeNull()
  })

  it("passes the literal 'self' token through unchanged", () => {
    expect(normalizeFrameOrigin("'self'")).toBe("'self'")
    expect(normalizeFrameOrigin(" 'self' ")).toBe("'self'")
  })
})

describe('parseOriginList', () => {
  it('splits on comma and whitespace, trims, and drops empties', () => {
    expect(parseOriginList('https://a.com, https://b.com')).toEqual(['https://a.com', 'https://b.com'])
    expect(parseOriginList('https://a.com   https://b.com')).toEqual(['https://a.com', 'https://b.com'])
    expect(parseOriginList('https://a.com,,  ,https://b.com')).toEqual(['https://a.com', 'https://b.com'])
  })

  it('de-dupes while preserving first-seen order', () => {
    expect(parseOriginList('https://a.com, https://a.com, https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('drops junk entries and keeps the valid ones', () => {
    expect(parseOriginList('https://a.com, not-a-url, https://*.evil.com, https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('returns [] for whitespace-only, empty, or undefined input', () => {
    expect(parseOriginList('   ')).toEqual([])
    expect(parseOriginList('')).toEqual([])
    expect(parseOriginList(undefined)).toEqual([])
  })

  it('accepts an array and normalizes each element', () => {
    expect(parseOriginList(['https://A.com/', 'https://b.com', 'bogus'])).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })
})

describe('frameAncestorsHeaderValue', () => {
  it("fails closed to 'none' for an empty list", () => {
    expect(frameAncestorsHeaderValue([])).toBe("frame-ancestors 'none'")
  })

  it('renders a single origin', () => {
    expect(frameAncestorsHeaderValue(['https://a.com'])).toBe('frame-ancestors https://a.com')
  })

  it('space-joins multiple origins in order', () => {
    expect(frameAncestorsHeaderValue(['https://a.com', 'https://b.com'])).toBe(
      'frame-ancestors https://a.com https://b.com',
    )
  })
})

describe('buildEmbedClientConfig', () => {
  const base: ResolvedEmbedConfig = { enabled: false, allowedOrigins: [] }

  it('returns undefined when embed is disabled', () => {
    expect(buildEmbedClientConfig(base)).toBeUndefined()
  })

  it('returns { enabled: true } with optional fields omitted when absent', () => {
    expect(buildEmbedClientConfig({ enabled: true, allowedOrigins: ['https://a.com'] })).toEqual({
      enabled: true,
    })
  })

  it('carries views and theme but NEVER the server-only allowedOrigins', () => {
    const out = buildEmbedClientConfig({
      enabled: true,
      allowedOrigins: ['https://a.com'],
      views: ['overview'],
      theme: { accent: '#fff' },
    })
    expect(out).toEqual({ enabled: true, views: ['overview'], theme: { accent: '#fff' } })
    expect(out).not.toHaveProperty('allowedOrigins')
  })
})
