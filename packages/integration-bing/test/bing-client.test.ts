import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getSites, addSite, getUrlInfo, submitUrl, submitUrlBatch, getKeywordStats, getCrawlStats, getCrawlIssues } from '../src/bing-client.js'
import { BING_WMT_API_BASE } from '../src/constants.js'

describe('getSites', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns parsed site entries', async () => {
    const mockResponse = {
      d: [
        { Url: 'https://example.com/', Verified: true },
        { Url: 'https://test.com/', Verified: false },
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
    expect(sites[1]!.Verified).toBe(false)
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
