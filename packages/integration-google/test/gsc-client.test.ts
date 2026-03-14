import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { listSites, fetchSearchAnalytics, inspectUrl } from '../src/gsc-client.js'
import { GSC_API_BASE, URL_INSPECTION_API } from '../src/constants.js'

describe('listSites', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  it('returns parsed site entries', async (t) => {
    const mockResponse = {
      siteEntry: [
        { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
      ],
    }

    globalThis.fetch = async (url: string | URL | Request) => {
      assert.equal(String(url), `${GSC_API_BASE}/sites`)
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }
    t.after(() => { globalThis.fetch = originalFetch })

    const sites = await listSites('test-token')
    assert.equal(sites.length, 2)
    assert.equal(sites[0]!.siteUrl, 'https://example.com/')
    assert.equal(sites[1]!.permissionLevel, 'siteFullUser')
  })

  it('returns empty array when no sites', async (t) => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 })
    t.after(() => { globalThis.fetch = originalFetch })

    const sites = await listSites('test-token')
    assert.deepEqual(sites, [])
  })

  it('throws GoogleApiError on 401', async (t) => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })
    t.after(() => { globalThis.fetch = originalFetch })

    await assert.rejects(
      () => listSites('bad-token'),
      (err: Error) => {
        assert.equal(err.name, 'GoogleApiError')
        assert.ok(err.message.includes('expired or revoked'))
        return true
      },
    )
  })
})

describe('fetchSearchAnalytics', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  it('fetches and returns rows with correct request body', async (t) => {
    const mockRows = [
      { keys: ['query1', 'https://example.com/page1', 'USA', 'DESKTOP', '2024-01-01'], clicks: 10, impressions: 100, ctr: 0.1, position: 5.2 },
      { keys: ['query2', 'https://example.com/page2', 'USA', 'MOBILE', '2024-01-01'], clicks: 5, impressions: 50, ctr: 0.1, position: 8.3 },
    ]

    let capturedBody: unknown
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({ rows: mockRows }), { status: 200 })
    }
    t.after(() => { globalThis.fetch = originalFetch })

    const rows = await fetchSearchAnalytics('token', 'sc-domain:example.com', {
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })

    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.clicks, 10)
    assert.equal(rows[1]!.position, 8.3)

    const body = capturedBody as { startDate: string; endDate: string; dimensions: string[]; rowLimit: number }
    assert.equal(body.startDate, '2024-01-01')
    assert.equal(body.endDate, '2024-01-31')
    assert.ok(body.dimensions.includes('query'))
    assert.equal(body.rowLimit, 25000)
  })

  it('handles pagination across multiple requests', async (t) => {
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
    t.after(() => { globalThis.fetch = originalFetch })

    const rows = await fetchSearchAnalytics('token', 'sc-domain:example.com', {
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })

    assert.equal(callCount, 2)
    assert.equal(rows.length, 25001)
  })

  it('throws on 429 rate limit', async (t) => {
    globalThis.fetch = async () => new Response('Rate limited', { status: 429 })
    t.after(() => { globalThis.fetch = originalFetch })

    await assert.rejects(
      () => fetchSearchAnalytics('token', 'site', { startDate: '2024-01-01', endDate: '2024-01-31' }),
      (err: Error) => {
        assert.ok(err.message.includes('rate limit'))
        return true
      },
    )
  })
})

describe('inspectUrl', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  it('sends correct request and returns inspection result', async (t) => {
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
    t.after(() => { globalThis.fetch = originalFetch })

    const result = await inspectUrl('token', 'https://example.com/page', 'sc-domain:example.com')

    assert.equal(capturedUrl, URL_INSPECTION_API)
    const body = capturedBody as { inspectionUrl: string; siteUrl: string }
    assert.equal(body.inspectionUrl, 'https://example.com/page')
    assert.equal(body.siteUrl, 'sc-domain:example.com')
    assert.equal(result.inspectionResult.indexStatusResult?.verdict, 'PASS')
    assert.equal(result.inspectionResult.indexStatusResult?.indexingState, 'INDEXING_ALLOWED')
    assert.equal(result.inspectionResult.richResultsResult?.detectedItems?.[0]?.richResultType, 'FAQ')
  })
})
