import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
  buildRunCompletedProps,
  extractRegistrableHost,
  hashDomain,
} from '../src/run-telemetry.js'

describe('extractRegistrableHost', () => {
  it('returns null for empty/whitespace input', () => {
    expect(extractRegistrableHost(null)).toBe(null)
    expect(extractRegistrableHost(undefined)).toBe(null)
    expect(extractRegistrableHost('')).toBe(null)
    expect(extractRegistrableHost('   ')).toBe(null)
  })

  it('strips protocol, port, path, and query', () => {
    expect(extractRegistrableHost('https://example.com:8080/blog/foo?bar=1')).toBe('example.com')
    expect(extractRegistrableHost('http://example.com')).toBe('example.com')
  })

  it('strips a leading www.', () => {
    expect(extractRegistrableHost('https://www.example.com')).toBe('example.com')
    expect(extractRegistrableHost('www.example.com')).toBe('example.com')
  })

  it('lowercases the host', () => {
    expect(extractRegistrableHost('HTTPS://EXAMPLE.COM')).toBe('example.com')
  })

  it('accepts bare hostnames without a scheme', () => {
    expect(extractRegistrableHost('example.com')).toBe('example.com')
    expect(extractRegistrableHost('shop.example.co.uk')).toBe('shop.example.co.uk')
  })

  it('returns null for inputs that cannot be parsed as a host', () => {
    // Plain words have no dot and so don't qualify as a host for ICP buckets.
    expect(extractRegistrableHost('localhost')).toBe(null)
    // Single-component host without a dot — discarded.
    expect(extractRegistrableHost('foo')).toBe(null)
  })
})

describe('hashDomain', () => {
  it('hashes example.com to a known SHA-256 of "example.com"', () => {
    // Pre-computed: SHA256("example.com") = a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947
    expect(hashDomain('example.com')).toBe('a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947')
  })

  it('produces the same hash for equivalent domains regardless of casing/scheme/www', () => {
    const expected = hashDomain('example.com')
    expect(hashDomain('EXAMPLE.COM')).toBe(expected)
    expect(hashDomain('https://www.example.com')).toBe(expected)
    expect(hashDomain('http://example.com:443/page')).toBe(expected)
  })

  it('produces different hashes for different registrable hosts', () => {
    expect(hashDomain('example.com')).not.toBe(hashDomain('example.org'))
    expect(hashDomain('shop.example.com')).not.toBe(hashDomain('example.com'))
  })

  it('returns null when the input cannot be parsed as a host', () => {
    expect(hashDomain(null)).toBe(null)
    expect(hashDomain('')).toBe(null)
    expect(hashDomain('localhost')).toBe(null)
  })

  it('matches a manual SHA-256 of the normalized host', () => {
    const host = 'shop.example.co.uk'
    const expected = crypto.createHash('sha256').update(host).digest('hex')
    expect(hashDomain(host)).toBe(expected)
  })
})

describe('buildRunCompletedProps', () => {
  const baseInput = {
    status: 'completed' as const,
    providerCount: 2,
    providers: ['openai', 'gemini'],
    queryCount: 5,
    startTime: Date.now() - 1000,
  }

  it('always emits the core run shape', () => {
    const props = buildRunCompletedProps(baseInput)
    expect(props.status).toBe('completed')
    expect(props.providerCount).toBe(2)
    expect(props.providers).toEqual(['openai', 'gemini'])
    expect(props.queryCount).toBe(5)
    expect(typeof props.durationMs).toBe('number')
    expect(props.durationMs).toBeGreaterThan(0)
  })

  it('omits trigger/domainHash/phases/location when not provided', () => {
    const props = buildRunCompletedProps(baseInput)
    expect(props.trigger).toBe(undefined)
    expect(props.domainHash).toBe(undefined)
    expect(props.phases).toBe(undefined)
    expect(props.location).toBe(undefined)
  })

  it('plumbs trigger and location through unchanged', () => {
    const props = buildRunCompletedProps({
      ...baseInput,
      trigger: 'scheduled',
      location: 'New York, NY',
    })
    expect(props.trigger).toBe('scheduled')
    expect(props.location).toBe('New York, NY')
  })

  it('hashes a canonical domain to a stable SHA-256 hex string', () => {
    // Each call should produce the same hash for the same input.
    const a = buildRunCompletedProps({ ...baseInput, canonicalDomain: 'example.com' })
    const b = buildRunCompletedProps({ ...baseInput, canonicalDomain: 'EXAMPLE.com' })
    const c = buildRunCompletedProps({ ...baseInput, canonicalDomain: 'https://www.example.com/path' })
    expect(a.domainHash).toBe('a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947')
    expect(b.domainHash).toBe(a.domainHash)
    expect(c.domainHash).toBe(a.domainHash)
  })

  it('omits domainHash when canonical domain is null/undefined/empty', () => {
    expect(buildRunCompletedProps({ ...baseInput, canonicalDomain: null }).domainHash).toBe(undefined)
    expect(buildRunCompletedProps({ ...baseInput, canonicalDomain: undefined }).domainHash).toBe(undefined)
    expect(buildRunCompletedProps({ ...baseInput, canonicalDomain: '' }).domainHash).toBe(undefined)
  })

  it('uses phases.total_ms when phases are provided rather than recomputing', () => {
    const phases = { setup_ms: 12, provider_call_ms: 28000, total_ms: 28100 }
    const props = buildRunCompletedProps({ ...baseInput, phases })
    expect(props.phases).toEqual(phases)
    expect(props.durationMs).toBe(28100)
  })
})
