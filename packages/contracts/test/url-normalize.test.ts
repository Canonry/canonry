import { describe, it, expect } from 'vitest'
import { normalizeUrlPath } from '../src/url-normalize.js'

describe('normalizeUrlPath', () => {
  describe('null and empty inputs', () => {
    it('returns null for null', () => {
      expect(normalizeUrlPath(null)).toBe(null)
    })

    it('returns null for undefined', () => {
      expect(normalizeUrlPath(undefined)).toBe(null)
    })

    it('returns null for empty string', () => {
      expect(normalizeUrlPath('')).toBe(null)
    })

    it('returns null for whitespace-only string', () => {
      expect(normalizeUrlPath('   ')).toBe(null)
    })

    it('returns null for the GA4 "(not set)" sentinel', () => {
      expect(normalizeUrlPath('(not set)')).toBe(null)
    })
  })

  describe('root and trivial paths', () => {
    it('preserves the root /', () => {
      expect(normalizeUrlPath('/')).toBe('/')
    })

    it('strips a debug query param on root', () => {
      expect(normalizeUrlPath('/?gtm_latency=1')).toBe('/')
    })

    it('strips a Facebook click ID on root (real azcoatings example)', () => {
      const input =
        '/?fbclid=IwZXh0bgNhZW0CMTEAc3J0YwZhcHBfaWQMMjU2MjgxMDQwNTU4AAEey9S720D1P8KJV5mX2nE1Z9xi23YGZZ-1a10I1V1bIbn7gI1lcPrOWNewfn4_aem_77m07xNOnFPs22S6hX3i_A'
      expect(normalizeUrlPath(input)).toBe('/')
    })

    it('strips both a click ID and utm in one go', () => {
      expect(normalizeUrlPath('/?fbclid=foo&utm_source=newsletter')).toBe('/')
    })
  })

  describe('trailing slash handling', () => {
    it('preserves a non-trailing-slash path', () => {
      expect(normalizeUrlPath('/about')).toBe('/about')
    })

    it('drops the trailing slash on a non-root path', () => {
      expect(normalizeUrlPath('/about/')).toBe('/about')
    })

    it('drops a trailing slash on a deep path', () => {
      expect(normalizeUrlPath('/azcoating-stagin/')).toBe('/azcoating-stagin')
    })

    it('keeps the root / unchanged', () => {
      expect(normalizeUrlPath('/')).toBe('/')
    })
  })

  describe('fragment handling', () => {
    it('strips a fragment after a path', () => {
      expect(normalizeUrlPath('/about/#section')).toBe('/about')
    })

    it('strips a fragment after an empty query string', () => {
      expect(normalizeUrlPath('/about/?#section')).toBe('/about')
    })

    it('strips a fragment after a query string', () => {
      expect(normalizeUrlPath('/page?keep=1#anchor')).toBe('/page?keep=1')
    })
  })

  describe('strip-list policy', () => {
    it('does NOT strip the v= cache-buster (conservative policy)', () => {
      // trailing slash collapses regardless of query; v= survives
      expect(normalizeUrlPath('/michigan/?v=3')).toBe('/michigan?v=3')
    })

    it('strips the click ID but preserves the v= param', () => {
      expect(normalizeUrlPath('/michigan/?fbclid=foo&v=3')).toBe('/michigan?v=3')
    })

    it('strips all utm_* keys', () => {
      expect(
        normalizeUrlPath('/page?utm_source=x&utm_medium=y&utm_campaign=z&keep=ok'),
      ).toBe('/page?keep=ok')
    })

    it('strips Google Analytics linker keys', () => {
      expect(normalizeUrlPath('/page?_ga=2.1.x&_gl=foo&keep=1')).toBe('/page?keep=1')
    })

    it('strips Mailchimp keys', () => {
      expect(normalizeUrlPath('/page?mc_cid=a&mc_eid=b&keep=1')).toBe('/page?keep=1')
    })

    it('strips all duplicate occurrences of a stripped key', () => {
      expect(normalizeUrlPath('/?fbclid=A&fbclid=B')).toBe('/')
    })

    it('strips every documented click-ID flavor', () => {
      const stripped =
        '/page?fbclid=a&gclid=b&msclkid=c&ttclid=d&li_fat_id=e&igshid=f' +
        '&yclid=g&dclid=h&gbraid=i&wbraid=j&keep=ok'
      expect(normalizeUrlPath(stripped)).toBe('/page?keep=ok')
    })
  })

  describe('index file collapsing', () => {
    it('collapses /index.html to /', () => {
      expect(normalizeUrlPath('/index.html')).toBe('/')
    })

    it('collapses /index.php to /', () => {
      expect(normalizeUrlPath('/index.php')).toBe('/')
    })

    it('does NOT collapse /path/index.html (only root index files collapse)', () => {
      expect(normalizeUrlPath('/path/index.html')).toBe('/path/index.html')
    })
  })

  describe('case sensitivity', () => {
    it('preserves case in path segments', () => {
      expect(normalizeUrlPath('/About')).toBe('/About')
    })

    it('preserves case across deep paths', () => {
      expect(normalizeUrlPath('/Michigan/SubPage/')).toBe('/Michigan/SubPage')
    })
  })

  describe('full URL inputs', () => {
    it('extracts pathname from a full URL and strips utm', () => {
      expect(normalizeUrlPath('https://example.com/page?utm_source=x')).toBe('/page')
    })

    it('extracts pathname and strips fragment from a full URL', () => {
      expect(normalizeUrlPath('https://example.com/page#anchor')).toBe('/page')
    })

    it('handles a full URL pointing at root', () => {
      expect(normalizeUrlPath('https://example.com/')).toBe('/')
    })

    it('handles a full URL with no trailing path', () => {
      expect(normalizeUrlPath('https://example.com')).toBe('/')
    })
  })

  describe('query param canonical ordering', () => {
    it('sorts remaining query params alphabetically by key', () => {
      expect(normalizeUrlPath('/page?b=2&a=1')).toBe('/page?a=1&b=2')
    })

    it('preserves multiple values for a non-stripped repeated key', () => {
      const result = normalizeUrlPath('/page?tag=a&tag=b&keep=1')
      // Both tags should survive, alphabetical sort by key keeps insertion
      // order within the same key.
      expect(result).toBe('/page?keep=1&tag=a&tag=b')
    })
  })

  describe('parameters with no value', () => {
    it('preserves a flag-style parameter with no value', () => {
      expect(normalizeUrlPath('/page?flag')).toBe('/page?flag')
    })

    it('strips a stripped key even when valueless', () => {
      expect(normalizeUrlPath('/page?fbclid&keep=1')).toBe('/page?keep=1')
    })
  })
})
