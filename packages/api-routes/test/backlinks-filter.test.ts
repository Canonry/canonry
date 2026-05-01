import { describe, expect, it } from 'vitest'
import {
  BACKLINK_FILTER_PATTERNS,
  isFilteredBacklinkDomain,
} from '../src/backlinks-filter.js'

describe('isFilteredBacklinkDomain', () => {
  it('hides the apex of a wildcarded pattern', () => {
    expect(isFilteredBacklinkDomain('google.com')).toBe(true)
    expect(isFilteredBacklinkDomain('bing.com')).toBe(true)
    expect(isFilteredBacklinkDomain('archive.org')).toBe(true)
  })

  it('hides arbitrary subdomains of a wildcarded pattern', () => {
    expect(isFilteredBacklinkDomain('translate.google.com')).toBe(true)
    expect(isFilteredBacklinkDomain('scholar.google.com')).toBe(true)
    expect(isFilteredBacklinkDomain('webcache.googleusercontent.com')).toBe(true)
    expect(isFilteredBacklinkDomain('a.b.c.google.com')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isFilteredBacklinkDomain('Google.com')).toBe(true)
    expect(isFilteredBacklinkDomain('GOOGLE.COM')).toBe(true)
    expect(isFilteredBacklinkDomain('Translate.Google.com')).toBe(true)
  })

  it('does not over-match domains that share a suffix without the dot boundary', () => {
    expect(isFilteredBacklinkDomain('notgoogle.com')).toBe(false)
    expect(isFilteredBacklinkDomain('mygoogle.com')).toBe(false)
    expect(isFilteredBacklinkDomain('archive-org.net')).toBe(false)
  })

  it('keeps editorial referring domains', () => {
    expect(isFilteredBacklinkDomain('news-publication.example')).toBe(false)
    expect(isFilteredBacklinkDomain('industry-blog.example')).toBe(false)
    expect(isFilteredBacklinkDomain('foo.test')).toBe(false)
  })

  it('exposes the pattern list for reference', () => {
    // Smoke test that the export exists and is non-empty so consumers can
    // surface the list in docs without re-deriving it.
    expect(BACKLINK_FILTER_PATTERNS.length).toBeGreaterThan(0)
  })
})
