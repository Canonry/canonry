import { describe, it, expect } from 'vitest'
import {
  absolutizeProjectUrl,
  brandLabelFromDomain,
  describeLandingPage,
  extractDomainsFromText,
  hostMatchesDomain,
  hostOf,
  normalizeUrlPath,
  registrableDomain,
  safeLinkHref,
  textContainsDomain,
} from '../src/url-normalize.js'

describe('hostOf', () => {
  it('extracts the host from a full URL, www-stripped and lowercased', () => {
    expect(hostOf('https://www.Example.com/blog/post?x=1')).toBe('example.com')
    expect(hostOf('http://News.EXAMPLE.org/a')).toBe('news.example.org')
  })

  it('accepts bare hostnames', () => {
    expect(hostOf('Example.com')).toBe('example.com')
    expect(hostOf('www.sub.example.com')).toBe('sub.example.com')
  })

  it('returns null for empty or unparseable input', () => {
    expect(hostOf(null)).toBe(null)
    expect(hostOf(undefined)).toBe(null)
    expect(hostOf('')).toBe(null)
    expect(hostOf('   ')).toBe(null)
    expect(hostOf('not a url')).toBe(null)
  })
})

describe('domain identity', () => {
  it('uses the Public Suffix List for registrable domains', () => {
    expect(registrableDomain('https://news.bbc.co.uk/story')).toBe('bbc.co.uk')
    expect(brandLabelFromDomain('https://news.bbc.co.uk/story')).toBe('bbc')
  })

  it('treats private-suffix tenants as separate domains', () => {
    expect(registrableDomain('docs.canonry.github.io')).toBe('canonry.github.io')
    expect(brandLabelFromDomain('docs.canonry.github.io')).toBe('canonry')
  })

  it('matches only the same host or a real subdomain', () => {
    expect(hostMatchesDomain('https://docs.example.com/x', 'example.com')).toBe(true)
    expect(hostMatchesDomain('notexample.com', 'example.com')).toBe(false)
    expect(hostMatchesDomain('example.com.evil.test', 'example.com')).toBe(false)
  })
})

describe('domains in prose', () => {
  it('extracts full and bare domains without a hand-maintained TLD regex', () => {
    expect(extractDomainsFromText(
      'See example.com, https://docs.example.co.uk/path, and tenant.vercel.app.',
    )).toEqual(['example.com', 'docs.example.co.uk', 'tenant.vercel.app'])
  })

  it('does not treat email addresses or lookalike domains as a match', () => {
    expect(extractDomainsFromText('Email hello@example.com for help.')).toEqual([])
    expect(textContainsDomain('Use notexample.com instead.', 'example.com')).toBe(false)
  })

  it('recognizes an explicitly written domain or subdomain', () => {
    expect(textContainsDomain('Read https://docs.example.com/start.', 'example.com')).toBe(true)
  })
})

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

    it('strips a Facebook click ID on root (long real-world-shaped value)', () => {
      const input =
        '/?fbclid=IwY2xjawSyntheticExampleClickIdv8iXGhBK8VYQNpKFzf9Hq5as1avpNMRSoDLZah3mGqWKAum6o0oS1BWF5Cbe_aem_lK6tKx62Ur3ZU-gepvfpTN'
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
      expect(normalizeUrlPath('/acme-staging/')).toBe('/acme-staging')
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
    it('strips the v= cache-buster and versioning noise', () => {
      // trailing slash collapses regardless of query; v= now stripped
      expect(normalizeUrlPath('/service-area/?v=3')).toBe('/service-area')
    })

    it('strips the click ID and the v= param', () => {
      expect(normalizeUrlPath('/service-area/?fbclid=foo&v=3')).toBe('/service-area')
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
      expect(normalizeUrlPath('/Service-Area/SubPage/')).toBe('/Service-Area/SubPage')
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

  describe('malformed artifacts', () => {
    it('strips common trailing garbage from GA/referrals', () => {
      expect(normalizeUrlPath('/aeo-methodology)')).toBe('/aeo-methodology')
      expect(normalizeUrlPath('/)&nbsp;open')).toBe('/')
      expect(normalizeUrlPath('/path.&nbsp;')).toBe('/path')
      expect(normalizeUrlPath('/path...')).toBe('/path')
    })

    it('strips CMS and versioning noise (WordPress-style examples)', () => {
      expect(normalizeUrlPath('/roof-coatings?preview=true&preview_id=1234&preview_nonce=abc')).toBe('/roof-coatings')
      expect(normalizeUrlPath('/service-area?v=3')).toBe('/service-area')
      expect(normalizeUrlPath('/path?ver=1.2.3')).toBe('/path')
    })
  })
})

describe('absolutizeProjectUrl', () => {
  it('prefixes path-only URLs with https://<canonicalDomain>', () => {
    expect(absolutizeProjectUrl('/blog/foo', 'example.com')).toBe('https://example.com/blog/foo')
  })

  it('preserves the query string when prefixing a path', () => {
    expect(absolutizeProjectUrl('/p?q=1', 'example.com')).toBe('https://example.com/p?q=1')
  })

  it('returns absolute https URLs unchanged', () => {
    expect(absolutizeProjectUrl('https://other.com/x', 'example.com')).toBe('https://other.com/x')
  })

  it('returns absolute http URLs unchanged', () => {
    expect(absolutizeProjectUrl('http://other.com/x', 'example.com')).toBe('http://other.com/x')
  })

  it('upgrades protocol-relative URLs to https', () => {
    expect(absolutizeProjectUrl('//cdn.example.com/x', 'example.com')).toBe('https://cdn.example.com/x')
  })

  it('strips an http(s) prefix and trailing slash from the canonical domain', () => {
    expect(absolutizeProjectUrl('/x', 'https://example.com/')).toBe('https://example.com/x')
    expect(absolutizeProjectUrl('/x', 'http://example.com')).toBe('https://example.com/x')
  })

  it('returns empty string for null, undefined, or whitespace input', () => {
    expect(absolutizeProjectUrl(null, 'example.com')).toBe('')
    expect(absolutizeProjectUrl(undefined, 'example.com')).toBe('')
    expect(absolutizeProjectUrl('   ', 'example.com')).toBe('')
  })

  it('treats bare slugs (no leading slash) as paths under the canonical host', () => {
    expect(absolutizeProjectUrl('blog/foo', 'example.com')).toBe('https://example.com/blog/foo')
  })

  it('returns the original input when canonicalDomain is empty', () => {
    expect(absolutizeProjectUrl('/blog/foo', '')).toBe('/blog/foo')
  })
})

describe('safeLinkHref', () => {
  it('keeps http(s), mailto, and slash-prefixed links as written, trimmed and unescaped', () => {
    expect(safeLinkHref('https://rival.com/post?a=1&b=2')).toBe('https://rival.com/post?a=1&b=2')
    expect(safeLinkHref('  HTTP://example.com/x  ')).toBe('HTTP://example.com/x')
    expect(safeLinkHref('mailto:hello@example.com')).toBe('mailto:hello@example.com')
    expect(safeLinkHref('/blog/foo')).toBe('/blog/foo')
    expect(safeLinkHref('//cdn.example.com/x')).toBe('//cdn.example.com/x')
  })

  it('turns executable schemes, bare paths, and empty values into #', () => {
    for (const value of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>alert(2)</script>', 'vbscript:msgbox', 'blog/foo', '', '   ', null, undefined]) {
      expect(safeLinkHref(value), String(value)).toBe('#')
    }
  })
})

describe('describeLandingPage', () => {
  it('returns the path alone when there is no query string', () => {
    expect(describeLandingPage('/blog/foo')).toEqual({ path: '/blog/foo', querySummary: null, raw: '/blog/foo' })
    expect(describeLandingPage('(not set)')).toEqual({ path: '(not set)', querySummary: null, raw: '(not set)' })
  })

  it('shows / for an empty path, with or without a query', () => {
    expect(describeLandingPage('')).toEqual({ path: '/', querySummary: null, raw: '' })
    expect(describeLandingPage('?gclid=1')).toEqual({ path: '/', querySummary: 'Google Ad · 1 param', raw: '?gclid=1' })
  })

  it('treats a query with no parameters as no query', () => {
    expect(describeLandingPage('/x?')).toEqual({ path: '/x', querySummary: null, raw: '/x?' })
    expect(describeLandingPage('/x?&')).toEqual({ path: '/x', querySummary: null, raw: '/x?&' })
  })

  it('names the ad click id or campaign tags behind a query, with the parameter count', () => {
    const cases: Array<[string, string]> = [
      ['/pricing?gclid=abc&utm_source=x', 'Google Ad · 2 params'],
      ['/solar?fbclid=abc&h_ad_id=123', 'Facebook Ad · 2 params'],
      ['/x?gbraid=abc', 'Google Ad · 1 param'],
      ['/x?wbraid=abc', 'Google Ad · 1 param'],
      ['/x?msclkid=abc', 'Microsoft Ad · 1 param'],
      ['/x?ttclid=abc', 'TikTok Ad · 1 param'],
      ['/x?li_fat_id=abc', 'LinkedIn Ad · 1 param'],
      ['/x?twclid=abc', 'X / Twitter Ad · 1 param'],
      ['/x?epik=abc', 'Pinterest Ad · 1 param'],
      ['/roofing?adgroupid=1&hsa_acc=2&hsa_cam=3&hsa_grp=4&hsa_ad=5&hsa_kw=roof&hsa_mt=e&hsa_net=adwords&hsa_ver=3', 'Search Ad · 9 params'],
      ['/x?utm_source=newsletter&utm_medium=email&utm_campaign=may', 'newsletter / email · 3 params'],
      ['/x?utm_source=newsletter', 'Source: newsletter · 1 param'],
      ['/x?utm_medium=email', 'Medium: email · 1 param'],
      ['/x?foo=1&bar=2', '2 tracking params'],
      ['/x?foo=1', '1 tracking param'],
    ]
    for (const [raw, querySummary] of cases) {
      expect(describeLandingPage(raw), raw).toEqual({ path: raw.slice(0, raw.indexOf('?')), querySummary, raw })
    }
  })
})
