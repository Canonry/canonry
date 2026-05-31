import { describe, it, expect } from 'vitest'
import { normalizeDomain } from '../src/guest-report.js'

/**
 * `normalizeDomain` parses a user-entered domain on the anonymous
 * /guest/report endpoint. It was rewritten to use linear string ops instead
 * of a backtracking regex (CodeQL: polynomial-regex ReDoS). These tests pin
 * both the normalization behavior and the ReDoS-safety.
 */
describe('normalizeDomain', () => {
  it('strips scheme, path, and leading www', () => {
    expect(normalizeDomain('https://www.acme.com/path?q=1#frag')).toBe('acme.com')
    expect(normalizeDomain('http://acme.com')).toBe('acme.com')
    expect(normalizeDomain('www.acme.com')).toBe('acme.com')
    expect(normalizeDomain('acme.com')).toBe('acme.com')
    expect(normalizeDomain('acme.com/foo/bar')).toBe('acme.com')
  })

  it('lowercases and trims', () => {
    expect(normalizeDomain('  Acme.COM  ')).toBe('acme.com')
  })

  it('keeps subdomains and hyphens, drops stray characters', () => {
    expect(normalizeDomain('https://shop.acme-corp.co.uk/')).toBe('shop.acme-corp.co.uk')
  })

  it('rejects empty / too-short / dotless input', () => {
    expect(() => normalizeDomain('')).toThrow()
    expect(() => normalizeDomain('   ')).toThrow()
    expect(() => normalizeDomain('ab')).toThrow()
    expect(() => normalizeDomain('localhost')).toThrow() // no dot
  })

  it('handles a pathological all-slashes input quickly (no ReDoS)', () => {
    // A backtracking regex on this could hang; the linear rewrite returns
    // in well under a frame. We assert both fast completion and the throw.
    const evil = '/'.repeat(200_000)
    const start = Date.now()
    expect(() => normalizeDomain(evil)).toThrow() // everything before the first '/' is empty → invalid
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('handles a long repeated-dot input quickly', () => {
    const evil = `${'a.'.repeat(100_000)}com`
    const start = Date.now()
    // Valid-ish (contains dots) — just assert it returns fast without hanging.
    const out = normalizeDomain(evil)
    expect(Date.now() - start).toBeLessThan(100)
    expect(out.endsWith('com')).toBe(true)
  })
})
