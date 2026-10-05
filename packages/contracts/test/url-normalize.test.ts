import { describe, it, expect } from 'vitest'
import {
  brandLabelFromDomain,
  competitorLabelFromDomain,
  extractDomainsFromText,
  hostMatchesDomain,
  hostOf,
  normalizeUrlPath,
  registrableDomain,
  textContainsDomain,
  URL_PATH_NORMALIZATION_VERSION,
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

  it('labels a stored competitor by its brand label, else by the stored domain', () => {
    expect(competitorLabelFromDomain('rivalhomes.example')).toBe('rivalhomes')
    expect(competitorLabelFromDomain('news.bbc.co.uk')).toBe('bbc')
    expect(competitorLabelFromDomain('localhost')).toBe('localhost')
    expect(competitorLabelFromDomain('10.0.0.1')).toBe('10.0.0.1')
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

describe('URL_PATH_NORMALIZATION_VERSION', () => {
  // Stored GA paths keep the normalization that wrote them, and startup only
  // repairs them again when this version increases. A change to any output
  // below needs a version bump: record the new outputs under the new version
  // and leave earlier versions' rows unchanged.
  const NORMALIZED_PATHS_BY_VERSION: Record<number, ReadonlyArray<readonly [string, string | null]>> = {
    1: [
      ['', null],
      ['   ', null],
      ['/', '/'],
      ['(not set)', null],
      ['/index.html', '/'],
      ['/index.php', '/'],
      ['/about/', '/about'],
      ['/Blog/Post/', '/Blog/Post'],
      ['/docs//', '/docs'],
      ['/pricing?utm_source=chatgpt&utm_medium=referral', '/pricing'],
      ['/?fbclid=A', '/'],
      ['/?gclid=B&msclkid=C', '/'],
      ['/search?q=shoes&page=2', '/search?page=2&q=shoes'],
      ['/search?page=2&q=shoes', '/search?page=2&q=shoes'],
      ['/landing?ref&b=2&a=1', '/landing?a=1&b=2&ref'],
      ['/guide#section-2', '/guide'],
      ['/guide/?utm_campaign=x#top', '/guide'],
      ['https://www.example.com/Store/?b=2&a=1&utm_content=y', '/Store?a=1&b=2'],
      ['https://example.com', '/'],
      ['/blog/post).', '/blog/post'],
      ['/) open', '/'],
      ['/features&nbsp;page', '/features'],
      ['  /contact  ', '/contact'],
      ['http://[bad', null],
    ],
  }

  it('pins normalizeUrlPath output to the stored-path repair version', () => {
    const golden = NORMALIZED_PATHS_BY_VERSION[URL_PATH_NORMALIZATION_VERSION]
    expect(golden, `record normalizeUrlPath outputs for version ${URL_PATH_NORMALIZATION_VERSION}`).toBeDefined()
    expect(
      golden!.map(([input]) => [input, normalizeUrlPath(input)]),
      'normalizeUrlPath output changed: bump URL_PATH_NORMALIZATION_VERSION so startup repairs stored GA paths',
    ).toEqual(golden)
  })
})
