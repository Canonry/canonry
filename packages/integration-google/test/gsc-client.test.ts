import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { listSites, listSitemaps, submitSitemap, fetchSearchAnalytics, inspectUrl, publishUrlNotification } from '../src/gsc-client.js'
import { GSC_API_BASE } from '../src/constants.js'
import { GoogleApiError } from '../src/types.js'

let originalFetch: typeof globalThis.fetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = originalFetch })

function expectRequest(
  [url, init]: Parameters<typeof globalThis.fetch>,
  expectedUrl: string,
  method: 'GET' | 'POST' | 'PUT',
  token: string,
  body?: Record<string, unknown>,
): void {
  expect(String(url)).toBe(expectedUrl)
  expect(init?.method).toBe(method)
  const headers = new Headers(init?.headers)
  expect(headers.get('authorization')).toBe(`Bearer ${token}`)
  expect(headers.get('content-type')).toBe('application/json')
  if (body == null) expect(init?.body).toBeUndefined()
  else expect(JSON.parse(String(init?.body))).toEqual(body)
}

describe('listSites', () => {
  it('returns parsed site entries', async () => {
    const sites = [
      { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
    ]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ siteEntry: sites }), { status: 200 }))
    globalThis.fetch = fetch

    expect(await listSites('test-token')).toEqual(sites)
    expect(fetch).toHaveBeenCalledTimes(1)
    expectRequest(fetch.mock.calls[0]!, 'https://www.googleapis.com/webmasters/v3/sites', 'GET', 'test-token')
  })

  it('returns empty array when no sites', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 })

    const sites = await listSites('test-token')
    expect(sites).toEqual([])
  })

  it('throws GoogleApiError on 401', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('Unauthorized', { status: 401 }))
    globalThis.fetch = fetch

    const result = listSites('bad-token')
    await expect(result).rejects.toBeInstanceOf(GoogleApiError)
    await expect(result).rejects.toMatchObject({ status: 401, message: 'Access token expired or revoked' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sanitizes the access token from the error details on failure', async () => {
    globalThis.fetch = async () => new Response('Error details containing bad-token', { status: 500 })

    await expect(
      () => listSites('bad-token'),
    ).rejects.toThrow(/GSC API error \(500\): Error details containing \*\*\*/)
  })

  it('throws a typed error for an empty successful response', async () => {
    globalThis.fetch = async () => new Response(null, { status: 204 })
    await expect(() => listSites('test-token')).rejects.toMatchObject({
      name: 'GoogleApiError',
      message: expect.stringMatching(/empty response/),
    })
  })
})

describe('listSitemaps', () => {
  it('returns parsed sitemaps for a site', async () => {
    const sitemaps = [
      { path: 'https://example.com/sitemap.xml', type: 'sitemap', lastDownloaded: '2026-03-15T10:00:00Z' },
      { path: 'https://example.com/sitemap-news.xml', type: 'sitemap', isSitemapsIndex: false },
    ]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ sitemap: sitemaps }), { status: 200 }))
    globalThis.fetch = fetch

    expect(await listSitemaps('test-token', 'https://example.com/')).toEqual(sitemaps)
    expect(fetch).toHaveBeenCalledTimes(1)
    expectRequest(fetch.mock.calls[0]!, 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps', 'GET', 'test-token')
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

  it('passes an encoded sitemapIndex query when listing an index\'s children', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ sitemap: [] }), { status: 200 }))
    globalThis.fetch = fetch
    const sitemapIndex = 'https://example.com/sitemaps/main index.xml'

    expect(await listSitemaps('test-token', 'sc-domain:example.com', sitemapIndex)).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
    expectRequest(fetch.mock.calls[0]!, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps?sitemapIndex=https%3A%2F%2Fexample.com%2Fsitemaps%2Fmain%20index.xml', 'GET', 'test-token')
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get('sitemapIndex')).toBe(sitemapIndex)
  })

  it('accepts a numeric property ID and uses it in the request path', async () => {
    let capturedUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ sitemap: [] }), { status: 200 })
    }

    await listSitemaps('test-token', '364127269')
    expect(capturedUrl).toBe(`${GSC_API_BASE}/sites/364127269/sitemaps`)
  })

  it('throws GoogleApiError on 401', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })
    await expect(() => listSitemaps('bad-token', 'https://example.com/')).rejects.toMatchObject({ name: 'GoogleApiError' })
  })

  it('throws a typed error for an empty successful response', async () => {
    globalThis.fetch = async () => new Response('', { status: 200 })
    await expect(() => listSitemaps('test-token', 'https://example.com/')).rejects.toMatchObject({
      name: 'GoogleApiError',
      message: expect.stringMatching(/empty response/),
    })
  })
})

describe('submitSitemap', () => {
  it('PUTs the encoded property and sitemap URL and accepts an empty 204 response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    globalThis.fetch = fetch

    await expect(submitSitemap('test-token', 'sc-domain:example.com', 'https://example.com/sitemap.xml')).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    expectRequest(fetch.mock.calls[0]!, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml', 'PUT', 'test-token')
  })
})

describe('fetchSearchAnalytics', () => {
  it('fetches and returns rows with correct request body', async () => {
    const rows = [
      { keys: ['query1', 'https://example.com/page1', 'USA', 'DESKTOP', '2024-01-01'], clicks: 10, impressions: 100, ctr: 0.1, position: 5.2 },
      { keys: ['query2', 'https://example.com/page2', 'USA', 'MOBILE', '2024-01-01'], clicks: 5, impressions: 50, ctr: 0.1, position: 8.3 },
    ]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ rows }), { status: 200 }))
    globalThis.fetch = fetch

    expect(await fetchSearchAnalytics('token', 'sc-domain:example.com', {
      startDate: '2024-01-01', endDate: '2024-01-31',
    })).toEqual(rows)
    expect(fetch).toHaveBeenCalledTimes(1)
    expectRequest(fetch.mock.calls[0]!, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query', 'POST', 'token', {
      startDate: '2024-01-01', endDate: '2024-01-31',
      dimensions: ['query', 'page', 'country', 'device', 'date'], rowLimit: 25000, startRow: 0,
    })
  })

  it('handles pagination across multiple requests', async () => {
    const firstPage = Array.from({ length: 25000 }, (_, i) => ({
      keys: [`q${i}`, `p${i}`, 'US', 'DESKTOP', '2024-01-01'],
      clicks: 1, impressions: 10, ctr: 0.1, position: 5,
    }))
    const tail = { keys: ['last', 'last', 'US', 'DESKTOP', '2024-01-01'], clicks: 1, impressions: 1, ctr: 1, position: 1 }
    let callCount = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ rows: callCount++ === 0 ? firstPage : [tail] }), { status: 200 }))
    globalThis.fetch = fetch

    const rows = await fetchSearchAnalytics('token', 'sc-domain:example.com', {
      startDate: '2024-01-01', endDate: '2024-01-31',
    })
    expect(rows).toHaveLength(25001)
    for (const [index, row] of [...firstPage, tail].entries()) {
      expect(rows[index], `row ${index}`).toEqual(row)
    }
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [index, startRow] of [0, 25000].entries()) {
      expectRequest(fetch.mock.calls[index]!, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query', 'POST', 'token', {
        startDate: '2024-01-01', endDate: '2024-01-31',
        dimensions: ['query', 'page', 'country', 'device', 'date'], rowLimit: 25000, startRow,
      })
    }
  })

  it('throws on 429 rate limit', async () => {
    globalThis.fetch = async () => new Response('Rate limited', { status: 429 })

    await expect(
      () => fetchSearchAnalytics('token', 'https://example.com', { startDate: '2024-01-01', endDate: '2024-01-31' }),
    ).rejects.toThrow(/rate limit/)
  })

  it('accepts a numeric property ID and uses it in the request path', async () => {
    let capturedUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    }

    await fetchSearchAnalytics('token', '364127269', { startDate: '2024-01-01', endDate: '2024-01-31' })
    expect(capturedUrl).toBe(`${GSC_API_BASE}/sites/364127269/searchAnalytics/query`)
  })
})

describe('inspectUrl', () => {
  it('sends correct request and returns inspection result', async () => {
    const inspection = {
      inspectionResult: {
        indexStatusResult: {
          verdict: 'PASS', coverageState: 'Submitted and indexed', indexingState: 'INDEXING_ALLOWED',
          pageFetchState: 'SUCCESSFUL', robotsTxtState: 'ALLOWED', lastCrawlTime: '2024-01-15T10:00:00Z',
          referringUrls: ['https://example.com/link1'],
        },
        mobileUsabilityResult: { verdict: 'PASS' },
        richResultsResult: { verdict: 'PASS', detectedItems: [{ richResultType: 'FAQ', items: [] }] },
      },
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(inspection), { status: 200 }))
    globalThis.fetch = fetch

    expect(await inspectUrl('token', 'https://example.com/page', 'sc-domain:example.com')).toEqual(inspection)
    expect(fetch).toHaveBeenCalledTimes(1)
    expectRequest(fetch.mock.calls[0]!, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', 'POST', 'token', {
      inspectionUrl: 'https://example.com/page', siteUrl: 'sc-domain:example.com',
    })
  })

  it('accepts a numeric property ID for siteUrl', async () => {
    let capturedBody: unknown
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } }),
        { status: 200 },
      )
    }

    await inspectUrl('token', 'https://example.com/page', '364127269')
    const body = capturedBody as { inspectionUrl: string; siteUrl: string }
    expect(body.siteUrl).toBe('364127269')
  })
})

describe('publishUrlNotification', () => {
  it('sends URL_UPDATED notification and returns metadata', async () => {
    const metadata = {
      urlNotificationMetadata: {
        url: 'https://example.com/page',
        latestUpdate: { url: 'https://example.com/page', type: 'URL_UPDATED', notifyTime: '2026-03-17T17:40:00Z' },
      },
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(metadata), { status: 200 }))
    globalThis.fetch = fetch

    expect(await publishUrlNotification('token', 'https://example.com/page')).toEqual(metadata)
    expect(fetch).toHaveBeenCalledTimes(1)
    expectRequest(fetch.mock.calls[0]!, 'https://indexing.googleapis.com/v3/urlNotifications:publish', 'POST', 'token', {
      url: 'https://example.com/page', type: 'URL_UPDATED',
    })
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
