import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getSites, addSite, getUrlInfo, submitUrl, submitUrlBatch, getKeywordStats, getCrawlStats, getCrawlIssues, getLinkCounts, getUrlLinks } from '../src/bing-client.js'
import { BING_WMT_API_BASE } from '../src/constants.js'

describe('getSites', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns parsed site entries (matches Bing\'s real GetUserSites response shape — IsVerified, not Verified)', async () => {
    // Fixture mirrors a real production response: `IsVerified`, plus the
    // additional fields (`__type`, `AuthenticationCode`, `DnsVerificationCode`)
    // Bing returns that we don't currently model. A prior version of this
    // test asserted on `Verified` (without `Is`), which is a field Bing never
    // populates — that masked the doctor `bing.auth.site-access` false-fail.
    const mockResponse = {
      d: [
        {
          __type: 'Site:#Microsoft.Bing.Webmaster.Api',
          AuthenticationCode: '54561B14450AE9971F4BA160466A8B0F',
          DnsVerificationCode: '08f0f0e100e910875e42a2ba79b2c6c2.example.com',
          IsVerified: true,
          Url: 'https://example.com/',
        },
        {
          __type: 'Site:#Microsoft.Bing.Webmaster.Api',
          AuthenticationCode: '54561B14450AE9971F4BA160466A8B0F',
          DnsVerificationCode: '08f0f0e100e910875e42a2ba79b2c6c2.test.com',
          IsVerified: false,
          Url: 'https://test.com/',
        },
      ],
    }

    globalThis.fetch = async (url: string | URL | Request) => {
      expect(String(url)).toContain(`${BING_WMT_API_BASE}/GetUserSites`)
      expect(String(url)).toContain('apikey=test-key')
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }

    const sites = await getSites('test-key')
    expect(sites.length).toBe(2)
    expect(sites[0]!.Url).toBe('https://example.com/')
    expect(sites[0]!.IsVerified).toBe(true)
    expect(sites[1]!.Url).toBe('https://test.com/')
    expect(sites[1]!.IsVerified).toBe(false)
  })

  it('returns empty array when no sites', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ d: null }), { status: 200 })

    const sites = await getSites('test-key')
    expect(sites).toEqual([])
  })

  it('throws BingApiError on 401', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })

    await expect(() => getSites('bad-key')).rejects.toThrow(/invalid or unauthorized/)
    await expect(() => getSites('bad-key')).rejects.toMatchObject({ name: 'BingApiError' })
  })

  it('throws BingApiError on 429', async () => {
    globalThis.fetch = async () => new Response('Rate limited', { status: 429 })

    await expect(() => getSites('key')).rejects.toThrow(/rate limit/)
  })
})

describe('addSite', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends POST with siteUrl in body', async () => {
    let capturedMethod = ''
    let capturedBody: unknown

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedMethod = init?.method ?? 'GET'
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({ d: null }), { status: 200 })
    }

    await addSite('test-key', 'https://example.com/')

    expect(capturedMethod).toBe('POST')
    const body = capturedBody as { siteUrl: string }
    expect(body.siteUrl).toBe('https://example.com/')
  })

  it('throws BingApiError on 401', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })
    await expect(() => addSite('bad-key', 'https://example.com/')).rejects.toMatchObject({ name: 'BingApiError' })
  })
})

describe('getUrlInfo', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends correct request and returns URL info', async () => {
    const mockResult = {
      d: {
        Url: 'https://example.com/page',
        HttpStatus: 200,
        DocumentSize: 2048,
        AnchorCount: 12,
        DiscoveryDate: '2026-03-10T10:00:00Z',
        IsPage: true,
        LastCrawledDate: '2026-03-15T10:00:00Z',
      },
    }

    let capturedUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify(mockResult), { status: 200 })
    }

    const result = await getUrlInfo('key', 'https://example.com/', 'https://example.com/page')

    expect(capturedUrl).toContain('GetUrlInfo')
    expect(capturedUrl).toContain('siteUrl=')
    expect(capturedUrl).toContain('url=')
    expect(result.Url).toBe('https://example.com/page')
    expect(result.HttpStatus).toBe(200)
    expect(result.DocumentSize).toBe(2048)
    expect(result.AnchorCount).toBe(12)
    expect(result.DiscoveryDate).toBe('2026-03-10T10:00:00Z')
  })
})

describe('submitUrl', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends POST request with correct body', async () => {
    let capturedBody: unknown
    let capturedMethod = ''
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedMethod = init?.method ?? 'GET'
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({ d: null }), { status: 200 })
    }

    await submitUrl('key', 'https://example.com/', 'https://example.com/page')

    expect(capturedMethod).toBe('POST')
    const body = capturedBody as { siteUrl: string; url: string }
    expect(body.siteUrl).toBe('https://example.com/')
    expect(body.url).toBe('https://example.com/page')
  })
})

describe('submitUrlBatch', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('batches URLs in groups of 500', async () => {
    let callCount = 0
    const capturedBatches: string[][] = []

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++
      const body = JSON.parse(String(init?.body ?? '{}')) as { urlList: string[] }
      capturedBatches.push(body.urlList)
      return new Response(JSON.stringify({ d: null }), { status: 200 })
    }

    const urls = Array.from({ length: 750 }, (_, i) => `https://example.com/page${i}`)
    await submitUrlBatch('key', 'https://example.com/', urls)

    expect(callCount).toBe(2)
    expect(capturedBatches[0]!.length).toBe(500)
    expect(capturedBatches[1]!.length).toBe(250)
  })
})

describe('getKeywordStats', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns keyword stats', async () => {
    const mockStats = {
      d: [
        { Query: 'test query', Impressions: 100, Clicks: 10, Ctr: 0.1, AverageClickPosition: 5.2, AverageImpressionPosition: 6.0 },
      ],
    }

    globalThis.fetch = async () => new Response(JSON.stringify(mockStats), { status: 200 })

    const stats = await getKeywordStats('key', 'https://example.com/')
    expect(stats.length).toBe(1)
    expect(stats[0]!.Query).toBe('test query')
    expect(stats[0]!.Clicks).toBe(10)
  })
})

describe('getCrawlStats', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns crawl stats', async () => {
    const mockStats = {
      d: [
        { Date: '2026-03-15', CrawledPages: 50, InIndex: 40, CrawlErrors: 2 },
      ],
    }

    globalThis.fetch = async () => new Response(JSON.stringify(mockStats), { status: 200 })

    const stats = await getCrawlStats('key', 'https://example.com/')
    expect(stats.length).toBe(1)
    expect(stats[0]!.CrawledPages).toBe(50)
    expect(stats[0]!.InIndex).toBe(40)
  })
})

describe('getCrawlIssues', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns crawl issues', async () => {
    const mockIssues = {
      d: [
        { Url: 'https://example.com/broken', HttpCode: 404, Date: '2026-03-15' },
      ],
    }

    globalThis.fetch = async () => new Response(JSON.stringify(mockIssues), { status: 200 })

    const issues = await getCrawlIssues('key', 'https://example.com/')
    expect(issues.length).toBe(1)
    expect(issues[0]!.HttpCode).toBe(404)
  })
})

describe('getLinkCounts', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns parsed link counts (real GetLinkCounts shape: d.Links[].{Url,Count})', async () => {
    // Fixture mirrors the documented Bing `GetLinkCounts` JSON response —
    // the array lives under `d.Links` (NOT `d.Details`, which is GetUrlLinks).
    const mockResponse = {
      d: {
        __type: 'LinkCounts:#Microsoft.Bing.Webmaster.Api',
        Links: [
          { __type: 'LinkCount:#Microsoft.Bing.Webmaster.Api', Count: 14, Url: 'https://example.com/page1.html' },
          { __type: 'LinkCount:#Microsoft.Bing.Webmaster.Api', Count: 3, Url: 'https://example.com/page2.html' },
        ],
        TotalPages: 1,
      },
    }

    let capturedUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }

    const counts = await getLinkCounts('test-key', 'https://example.com/')
    expect(capturedUrl).toContain(`${BING_WMT_API_BASE}/GetLinkCounts`)
    expect(capturedUrl).toContain('siteUrl=')
    expect(capturedUrl).toContain('page=0')
    expect(capturedUrl).toContain('apikey=test-key')
    expect(counts.length).toBe(2)
    expect(counts[0]!.Url).toBe('https://example.com/page1.html')
    expect(counts[0]!.Count).toBe(14)
    expect(counts[1]!.Count).toBe(3)
  })

  it('auto-paginates across TotalPages and flattens the result', async () => {
    const pages = [
      { d: { Links: [{ Url: 'https://example.com/a', Count: 5 }], TotalPages: 3 } },
      { d: { Links: [{ Url: 'https://example.com/b', Count: 4 }], TotalPages: 3 } },
      { d: { Links: [{ Url: 'https://example.com/c', Count: 3 }], TotalPages: 3 } },
    ]
    const seenPages: string[] = []
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = new URL(String(url))
      const page = u.searchParams.get('page') ?? '0'
      seenPages.push(page)
      return new Response(JSON.stringify(pages[Number(page)]), { status: 200 })
    }

    const counts = await getLinkCounts('key', 'https://example.com/')
    expect(seenPages).toEqual(['0', '1', '2'])
    expect(counts.map((c) => c.Url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ])
  })

  it('respects the maxPages cap', async () => {
    let calls = 0
    globalThis.fetch = async (url: string | URL | Request) => {
      calls++
      const u = new URL(String(url))
      const page = Number(u.searchParams.get('page') ?? '0')
      return new Response(JSON.stringify({ d: { Links: [{ Url: `https://example.com/p${page}`, Count: 1 }], TotalPages: 10 } }), { status: 200 })
    }

    const counts = await getLinkCounts('key', 'https://example.com/', { maxPages: 2 })
    expect(calls).toBe(2)
    expect(counts.length).toBe(2)
  })

  it('returns empty array when there are no inbound links (d: null)', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ d: null }), { status: 200 })
    const counts = await getLinkCounts('key', 'https://example.com/')
    expect(counts).toEqual([])
  })

  it('throws BingApiError on 401', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })
    await expect(() => getLinkCounts('bad-key', 'https://example.com/')).rejects.toMatchObject({ name: 'BingApiError' })
  })
})

describe('getUrlLinks', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns inbound links (real GetUrlLinks shape: d.Details[].{Url,AnchorText})', async () => {
    // Fixture mirrors the documented Bing `GetUrlLinks` JSON response — the
    // array lives under `d.Details` and each entry carries the EXTERNAL
    // linking Url plus its AnchorText.
    const mockResponse = {
      d: {
        __type: 'LinkDetails:#Microsoft.Bing.Webmaster.Api',
        Details: [
          { __type: 'LinkDetail:#Microsoft.Bing.Webmaster.Api', AnchorText: 'great tool', Url: 'https://blog.acme.com/post' },
          { __type: 'LinkDetail:#Microsoft.Bing.Webmaster.Api', AnchorText: 'see this', Url: 'https://news.example.org/story' },
        ],
        TotalPages: 1,
      },
    }

    let capturedUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }

    const links = await getUrlLinks('test-key', 'https://example.com/', 'https://example.com/page1.html')
    expect(capturedUrl).toContain(`${BING_WMT_API_BASE}/GetUrlLinks`)
    expect(capturedUrl).toContain('siteUrl=')
    expect(capturedUrl).toContain('link=')
    expect(capturedUrl).toContain('page=0')
    expect(links.length).toBe(2)
    expect(links[0]!.Url).toBe('https://blog.acme.com/post')
    expect(links[0]!.AnchorText).toBe('great tool')
    expect(links[1]!.Url).toBe('https://news.example.org/story')
  })

  it('auto-paginates across TotalPages', async () => {
    const pages = [
      { d: { Details: [{ Url: 'https://a.com/1', AnchorText: 'a' }], TotalPages: 2 } },
      { d: { Details: [{ Url: 'https://b.com/2', AnchorText: 'b' }], TotalPages: 2 } },
    ]
    const seenPages: string[] = []
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = new URL(String(url))
      const page = u.searchParams.get('page') ?? '0'
      seenPages.push(page)
      return new Response(JSON.stringify(pages[Number(page)]), { status: 200 })
    }

    const links = await getUrlLinks('key', 'https://example.com/', 'https://example.com/page1.html')
    expect(seenPages).toEqual(['0', '1'])
    expect(links.map((l) => l.Url)).toEqual(['https://a.com/1', 'https://b.com/2'])
  })

  it('returns empty array when the page has no inbound links (d: null)', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ d: null }), { status: 200 })
    const links = await getUrlLinks('key', 'https://example.com/', 'https://example.com/page1.html')
    expect(links).toEqual([])
  })
})
