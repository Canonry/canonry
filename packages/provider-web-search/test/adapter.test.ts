/**
 * Unit tests for WebSearchAdapter
 * Uses Node.js built-in test runner (tsx --test)
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSearchAdapter } from '../src/adapter.js'

// ---------------------------------------------------------------------------
// Helpers — minimal fetch mock
// ---------------------------------------------------------------------------

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

let currentFetchMock: FetchMock | null = null

const originalFetch = globalThis.fetch

before(() => {
  // Replace globalThis.fetch with our interceptor
  ;(globalThis as unknown as Record<string, unknown>).fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    if (currentFetchMock) return currentFetchMock(input, init)
    return originalFetch(input, init)
  }
})

after(() => {
  ;(globalThis as unknown as Record<string, unknown>).fetch = originalFetch
})

function mockFetch(status: number, body: unknown): void {
  currentFetchMock = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
}

function clearFetchMock(): void {
  currentFetchMock = null
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('WebSearchAdapter constructor', () => {
  it('throws when apiKey is missing', () => {
    assert.throws(
      () => new WebSearchAdapter({ apiKey: '', backend: 'serper' }),
      /apiKey is required/,
    )
  })

  it('throws when backend is google-cse but cx is missing', () => {
    assert.throws(
      () => new WebSearchAdapter({ apiKey: 'key', backend: 'google-cse' }),
      /cx \(search engine ID\) is required/,
    )
  })

  it('constructs successfully for serper', () => {
    assert.doesNotThrow(() => new WebSearchAdapter({ apiKey: 'key', backend: 'serper' }))
  })

  it('constructs successfully for google-cse with cx', () => {
    assert.doesNotThrow(
      () => new WebSearchAdapter({ apiKey: 'key', backend: 'google-cse', cx: 'engine-id' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Serper backend — siteQuery
// ---------------------------------------------------------------------------

describe('WebSearchAdapter.siteQuery (serper backend)', () => {
  after(clearFetchMock)

  it('returns parsed results for successful response', async () => {
    mockFetch(200, {
      organic: [
        { title: 'Page A', link: 'https://example.com/a' },
        { title: 'Page B', link: 'https://example.com/b' },
      ],
      searchInformation: { totalResults: '1,230' },
    })

    const adapter = new WebSearchAdapter({ apiKey: 'test-key', backend: 'serper' })
    const result = await adapter.siteQuery('example.com', 'test keyword')

    assert.equal(result.domain, 'example.com')
    assert.equal(result.keyword, 'test keyword')
    assert.equal(result.indexedPageCount, 1230, 'should strip commas from totalResults')
    assert.equal(result.topPages.length, 2)
    assert.equal(result.topPages[0].url, 'https://example.com/a')
    assert.equal(result.topPages[0].title, 'Page A')
  })

  it('falls back to topPages.length when totalResults is missing', async () => {
    mockFetch(200, {
      organic: [{ title: 'Only Page', link: 'https://example.com/only' }],
    })

    const adapter = new WebSearchAdapter({ apiKey: 'test-key', backend: 'serper' })
    const result = await adapter.siteQuery('example.com', 'keyword')

    assert.equal(result.indexedPageCount, 1)
  })

  it('handles missing organic field gracefully', async () => {
    mockFetch(200, { searchInformation: { totalResults: '0' } })

    const adapter = new WebSearchAdapter({ apiKey: 'test-key', backend: 'serper' })
    const result = await adapter.siteQuery('example.com', 'keyword')

    assert.equal(result.indexedPageCount, 0)
    assert.deepEqual(result.topPages, [])
  })

  it('throws on non-OK HTTP response', async () => {
    mockFetch(403, { message: 'Forbidden' })

    const adapter = new WebSearchAdapter({ apiKey: 'test-key', backend: 'serper' })
    await assert.rejects(adapter.siteQuery('example.com', 'keyword'), /Serper API error: 403/)
  })

  it('surfaces 429 status code in error message for rate-limit response', async () => {
    mockFetch(429, { message: 'Too Many Requests' })

    const adapter = new WebSearchAdapter({ apiKey: 'test-key', backend: 'serper' })
    await assert.rejects(
      adapter.siteQuery('example.com', 'keyword'),
      /Serper API error: 429/,
      'error message should include the HTTP 429 status code',
    )
  })

  it('surfaces 5xx status code in error message for server error response', async () => {
    mockFetch(500, { message: 'Internal Server Error' })

    const adapter = new WebSearchAdapter({ apiKey: 'test-key', backend: 'serper' })
    await assert.rejects(
      adapter.siteQuery('example.com', 'keyword'),
      /Serper API error: 500/,
      'error message should include the HTTP 500 status code',
    )
  })
})

// ---------------------------------------------------------------------------
// Google CSE backend — siteQuery
// ---------------------------------------------------------------------------

describe('WebSearchAdapter.siteQuery (google-cse backend)', () => {
  after(clearFetchMock)

  it('returns parsed results for successful response', async () => {
    mockFetch(200, {
      items: [
        { title: 'CSE Page A', link: 'https://example.com/a' },
        { title: 'CSE Page B', link: 'https://example.com/b' },
      ],
      searchInformation: { totalResults: '5,678' },
    })

    const adapter = new WebSearchAdapter({
      apiKey: 'test-key',
      backend: 'google-cse',
      cx: 'engine-id',
    })
    const result = await adapter.siteQuery('example.com', 'test keyword')

    assert.equal(result.indexedPageCount, 5678, 'should strip commas from totalResults')
    assert.equal(result.topPages.length, 2)
  })

  it('handles missing items field gracefully', async () => {
    mockFetch(200, { searchInformation: { totalResults: '0' } })

    const adapter = new WebSearchAdapter({
      apiKey: 'test-key',
      backend: 'google-cse',
      cx: 'engine-id',
    })
    const result = await adapter.siteQuery('example.com', 'keyword')

    assert.deepEqual(result.topPages, [])
  })

  it('throws with redacted key on non-OK HTTP response', async () => {
    mockFetch(429, { error: { message: 'quota exceeded' } })

    const adapter = new WebSearchAdapter({
      apiKey: 'my-secret-api-key',
      backend: 'google-cse',
      cx: 'engine-id',
    })
    await assert.rejects(
      adapter.siteQuery('example.com', 'keyword'),
      /key redacted from URL/,
      'error message should not contain the raw API key',
    )
  })

  it('does not include raw API key in thrown error', async () => {
    const secretKey = 'super-secret-key-12345'
    mockFetch(500, {})

    const adapter = new WebSearchAdapter({
      apiKey: secretKey,
      backend: 'google-cse',
      cx: 'engine-id',
    })

    try {
      await adapter.siteQuery('example.com', 'keyword')
      assert.fail('Expected error to be thrown')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      assert.ok(!msg.includes(secretKey), `Error message must not contain the API key: "${msg}"`)
    }
  })
})

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('WebSearchAdapter.validateConfig', () => {
  it('returns ok for valid serper config', () => {
    const adapter = new WebSearchAdapter({ apiKey: 'key', backend: 'serper' })
    const result = adapter.validateConfig()
    assert.equal(result.ok, true)
  })

  it('returns ok for valid google-cse config', () => {
    const adapter = new WebSearchAdapter({ apiKey: 'key', backend: 'google-cse', cx: 'cx-id' })
    const result = adapter.validateConfig()
    assert.equal(result.ok, true)
  })
})
