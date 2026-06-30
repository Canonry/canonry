import { describe, it, expect } from 'vitest'
import {
  normalizeFrameOrigin,
  parseOriginList,
  frameAncestorsHeaderValue,
  buildEmbedClientConfig,
  embedClientConfigForRequest,
  normalizeIdTokens,
  serializeForInlineScript,
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

  it('carries views, projectTabs and theme but NEVER the server-only allowedOrigins', () => {
    const out = buildEmbedClientConfig({
      enabled: true,
      allowedOrigins: ['https://a.com'],
      views: ['overview'],
      projectTabs: ['overview', 'technical-aeo'],
      theme: { accent: '#fff' },
    })
    expect(out).toEqual({
      enabled: true,
      views: ['overview'],
      projectTabs: ['overview', 'technical-aeo'],
      theme: { accent: '#fff' },
    })
    expect(out).not.toHaveProperty('allowedOrigins')
  })

  it('omits projectTabs when the allowlist is empty (= all tabs)', () => {
    expect(buildEmbedClientConfig({ enabled: true, allowedOrigins: [], projectTabs: [] })).toEqual({ enabled: true })
  })
})

describe('normalizeIdTokens', () => {
  it('lowercases + de-dupes, preserving first-seen order', () => {
    expect(normalizeIdTokens(['Overview', 'TECHNICAL-AEO', 'overview', 'report'])).toEqual([
      'overview',
      'technical-aeo',
      'report',
    ])
  })

  it('returns undefined for an empty list (= all, never an empty allowlist)', () => {
    expect(normalizeIdTokens([])).toBeUndefined()
  })
})

describe('embedClientConfigForRequest', () => {
  const enabled: ResolvedEmbedConfig = {
    enabled: true,
    allowedOrigins: ['https://a.com'],
    projectTabs: ['overview', 'technical-aeo', 'report'],
  }

  it('returns undefined when embed is disabled (the header is ignored)', () => {
    expect(embedClientConfigForRequest({ enabled: false, allowedOrigins: [] }, 'overview')).toBeUndefined()
  })

  it('keeps the boot-wide projectTabs when no override header is present', () => {
    expect(embedClientConfigForRequest(enabled, undefined)).toEqual({
      enabled: true,
      projectTabs: ['overview', 'technical-aeo', 'report'],
    })
  })

  it('REPLACES projectTabs with the per-request override (CSV string), normalized', () => {
    expect(embedClientConfigForRequest(enabled, 'Overview, technical-aeo')).toEqual({
      enabled: true,
      projectTabs: ['overview', 'technical-aeo'],
    })
  })

  it('accepts the override as a string[] (Fastify multi-value header)', () => {
    expect(embedClientConfigForRequest(enabled, ['overview', 'local'])).toEqual({
      enabled: true,
      projectTabs: ['overview', 'local'],
    })
  })

  it('an empty / whitespace override falls back to the boot-wide projectTabs', () => {
    expect(embedClientConfigForRequest(enabled, '   ')).toEqual({
      enabled: true,
      projectTabs: ['overview', 'technical-aeo', 'report'],
    })
  })

  it('can override even when the boot config had no projectTabs', () => {
    const noTabs: ResolvedEmbedConfig = { enabled: true, allowedOrigins: [] }
    expect(embedClientConfigForRequest(noTabs, 'overview,technical-aeo')).toEqual({
      enabled: true,
      projectTabs: ['overview', 'technical-aeo'],
    })
  })
})

describe('serializeForInlineScript', () => {
  it('escapes < > & so a </script> in a value cannot break out of the inline script', () => {
    const out = serializeForInlineScript({ embed: { projectTabs: ['</script><img src=x onerror=alert(1)>'] } })
    expect(out).not.toContain('</script>')
    expect(out).not.toContain('<img')
    expect(out).toContain('\\u003c/script\\u003e')
    // still valid JSON that parses back to the original value
    expect(JSON.parse(out)).toEqual({ embed: { projectTabs: ['</script><img src=x onerror=alert(1)>'] } })
  })

  it('escapes the JS line separators U+2028 / U+2029', () => {
    const out = serializeForInlineScript({ a: '\u2028\u2029' })
    expect(out).toContain('\\u2028')
    expect(out).toContain('\\u2029')
    expect(JSON.parse(out)).toEqual({ a: '\u2028\u2029' })
  })

  it('leaves ordinary config byte-identical to JSON.stringify (no < > & present)', () => {
    const cfg = { basePath: '/canonry', embed: { enabled: true, projectTabs: ['overview', 'technical-aeo'] } }
    expect(serializeForInlineScript(cfg)).toBe(JSON.stringify(cfg))
  })
})
