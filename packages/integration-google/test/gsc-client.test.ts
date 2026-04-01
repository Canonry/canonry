import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listSites, listSitemaps, fetchSearchAnalytics, inspectUrl, publishUrlNotification, getUrlNotificationStatus } from '../src/gsc-client.js'
import { GSC_API_BASE, URL_INSPECTION_API, INDEXING_API_BASE } from '../src/constants.js'

describe('listSites', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns parsed site entries', async () => {
    const mockResponse = {
      siteEntry: [
        { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
      ],
    }

    globalThis.fetch = async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${GSC_API_BASE}/sites`)
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }

    const sites = await listSites('test-token')
    expect(sites.length).toBe(2)
    expect(sites[0]!.siteUrl).toBe('https://example.com/')
    expect(sites[1]!.permissionLevel).toBe('siteFullUser')
  })

  it('returns empty array when no sites', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 })

    const sites = await listSites('test-token')
    expect(sites).toEqual([])
  })

  it('throws GoogleApiError on 401', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })

    await expect(
      () => listSites('bad-token'),
    ).rejects.toThrow(/expired or revoked/)
    await expect(() => listSites('bad-token')).rejects.toMatchObject({ name: 'GoogleApiError' })
  })
})

describe('listSitemaps', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns parsed sitemaps for a site', async () => {
    const mockResponse = {
      sitemap: [
        { path: 'https://example.com/sitemap.xml', type: 'sitemap', lastDownloaded: '2026-03-15T10:00:00Z' },
        { path: 'https://example.com/sitemap-news.xml', type: 'sitemap', isSitemapsIndex: false },
      ],
    }

    let capturedUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }

    const sitemaps = await listSitemaps('test-token', 'https://example.com/')
    expect(capturedUrl).toContain(`${GSC_API_BASE}/sites/`)
    expect(capturedUrl).toContain('sitemaps')
    expect(sitemaps.length).toBe(2)
    expect(sitemaps[0]!.path).toBe('https://example.com/sitemap.xml')
    expect(sitemaps[1]!.path).toBe('https://example.com/sitemap-news.xml')
  })

  it('returns empty array when no sitemaps', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 })

    const sitemaps = await listSitemaps('test-token', 'https://example.com/')
    expect(sitemaps).toEqual([])
  })

  it('URL-encodes the site URL in the request path', async () => {
    let capturedUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ sitemap: [] }), { status: 200 })
    }

    await listSitemaps('test-token', 'sc-domain:example.com')
    expect(capturedUrl).toContain(encodeURIComponent('sc-domain:example.com'))
  })

  it('throws GoogleApiError on 401', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })
    await expect(() => listSitemaps('bad-token', 'https://example.com/')).rejects.toMatchObject({ name: 'GoogleApiError' })
  })
})

describe('fetchSearchAnalytics', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('fetches and returns rows with correct request body', async () => {
    const mockRows = [
      { keys: ['query1', 'https://example.com/page1', 'USA', 'DESKTOP', '2024-01-01'], clicks: 10, impressions: 100, ctr: 0.1, position: 5.2 },
      { keys: ['query2', 'https://example.com/page2', 'USA', 'MOBILE', '2024-01-01'], clicks: 5, impressions: 50, ctr: 0.1, position: 8.3 },
    ]

    let capturedBody: unknown
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({ rows: mockRows }), { status: 200 })
    }

    const rows = await fetchSearchAnalytics('token', 'sc-domain:example.com', {
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })

    expect(rows.length).toBe(2)
    expect(rows[0]!.clicks).toBe(10)
    expect(rows[1]!.position).toBe(8.3)

    const body = capturedBody as { startDate: string; endDate: string; dimensions: string[]; rowLimit: number }
    expect(body.startDate).toBe('2024-01-01')
    expect(body.endDate).toBe('2024-01-31')
    expect(body.dimensions.includes('query')).toBeTruthy()
    expect(body.rowLimit).toBe(25000)
  })

  it('handles pagination across multiple requests', async () => {
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) {
        // Return exactly 25000 rows to trigger pagination
        const rows = Array.from({ length: 25000 }, (_, i) => ({
          keys: [`q${i}`, `p${i}`, 'US', 'DESKTOP', '2024-01-01'],
          clicks: 1, impressions: 10, ctr: 0.1, position: 5,
        }))
        return new Response(JSON.stringify({ rows }), { status: 200 })
      }
      // Second page: less than 25000, stops pagination
      return new Response(JSON.stringify({ rows: [{ keys: ['last', 'last', 'US', 'DESKTOP', '2024-01-01'], clicks: 1, impressions: 1, ctr: 1, position: 1 }] }), { status: 200 })
    }

    const rows = await fetchSearchAnalytics('token', 'sc-domain:example.com', {
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })

    expect(callCount).toBe(2)
    expect(rows.length).toBe(25001)
  })

  it('throws on 429 rate limit', async () => {
    globalThis.fetch = async () => new Response('Rate limited', { status: 429 })

    await expect(
      () => fetchSearchAnalytics('token', 'site', { startDate: '2024-01-01', endDate: '2024-01-31' }),
    ).rejects.toThrow(/rate limit/)
  })
})

describe('inspectUrl', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends correct request and returns inspection result', async () => {
    const mockResult = {
      inspectionResult: {
        indexStatusResult: {
          verdict: 'PASS',
          coverageState: 'Submitted and indexed',
          indexingState: 'INDEXING_ALLOWED',
          pageFetchState: 'SUCCESSFUL',
          robotsTxtState: 'ALLOWED',
          lastCrawlTime: '2024-01-15T10:00:00Z',
          referringUrls: ['https://example.com/link1'],
        },
        mobileUsabilityResult: {
          verdict: 'PASS',
        },
        richResultsResult: {
          verdict: 'PASS',
          detectedItems: [{ richResultType: 'FAQ', items: [] }],
        },
      },
    }

    let capturedUrl = ''
    let capturedBody: unknown
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify(mockResult), { status: 200 })
    }

    const result = await inspectUrl('token', 'https://example.com/page', 'sc-domain:example.com')

    expect(capturedUrl).toBe(URL_INSPECTION_API)
    const body = capturedBody as { inspectionUrl: string; siteUrl: string }
    expect(body.inspectionUrl).toBe('https://example.com/page')
    expect(body.siteUrl).toBe('sc-domain:example.com')
    expect(result.inspectionResult.indexStatusResult?.verdict).toBe('PASS')
    expect(result.inspectionResult.indexStatusResult?.indexingState).toBe('INDEXING_ALLOWED')
    expect(result.inspectionResult.richResultsResult?.detectedItems?.[0]?.richResultType).toBe('FAQ')
  })
})

describe('publishUrlNotification', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends URL_UPDATED notification and returns metadata', async () => {
    const mockResponse = {
      urlNotificationMetadata: {
        url: 'https://example.com/page',
        latestUpdate: {
          url: 'https://example.com/page',
          type: 'URL_UPDATED',
          notifyTime: '2026-03-17T17:40:00Z',
        },
      },
    }

    let capturedUrl = ''
    let capturedBody: unknown
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }

    const result = await publishUrlNotification('token', 'https://example.com/page')

    expect(capturedUrl).toBe(`${INDEXING_API_BASE}/urlNotifications:publish`)
    const body = capturedBody as { url: string; type: string }
    expect(body.url).toBe('https://example.com/page')
    expect(body.type).toBe('URL_UPDATED')
    expect(result.urlNotificationMetadata.latestUpdate?.notifyTime).toBe('2026-03-17T17:40:00Z')
  })

  it('sends URL_DELETED notification when type is specified', async () => {
    let capturedBody: unknown
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({ urlNotificationMetadata: { url: 'https://example.com/page' } }), { status: 200 })
    }

    await publishUrlNotification('token', 'https://example.com/page', 'URL_DELETED')
    const body = capturedBody as { url: string; type: string }
    expect(body.type).toBe('URL_DELETED')
  })

  it('throws on 429 rate limit', async () => {
    globalThis.fetch = async () => new Response('Rate limited', { status: 429 })

    await expect(
      () => publishUrlNotification('token', 'https://example.com/page'),
    ).rejects.toThrow(/rate limit/)
  })
})

describe('getUrlNotificationStatus', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('fetches notification status for a URL', async () => {
    const mockResponse = {
      urlNotificationMetadata: {
        url: 'https://example.com/page',
        latestUpdate: {
          url: 'https://example.com/page',
          type: 'URL_UPDATED',
          notifyTime: '2026-03-17T17:40:00Z',
        },
      },
    }

    let capturedUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }

    const result = await getUrlNotificationStatus('token', 'https://example.com/page')

    expect(capturedUrl).toBe(`${INDEXING_API_BASE}/urlNotifications/metadata?url=${encodeURIComponent('https://example.com/page')}`)
    expect(result.urlNotificationMetadata.url).toBe('https://example.com/page')
  })
})
