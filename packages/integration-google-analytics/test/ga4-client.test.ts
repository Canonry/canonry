import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createServiceAccountJwt, fetchTrafficByLandingPage } from '../src/ga4-client.js'
import crypto from 'node:crypto'

describe('createServiceAccountJwt', () => {
  it('produces a three-part JWT string', () => {
    // Generate a test RSA key pair
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })

    const jwt = createServiceAccountJwt(
      'test@test.iam.gserviceaccount.com',
      privateKey,
      'https://www.googleapis.com/auth/analytics.readonly',
    )

    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)

    // Verify header
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString())
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })

    // Verify payload
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
    expect(payload.iss).toBe('test@test.iam.gserviceaccount.com')
    expect(payload.scope).toBe('https://www.googleapis.com/auth/analytics.readonly')
    expect(payload.aud).toBe('https://oauth2.googleapis.com/token')
    expect(payload.exp).toBe(payload.iat + 3600)
  })

  it('signature is verifiable with the corresponding public key', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })

    const jwt = createServiceAccountJwt(
      'test@test.iam.gserviceaccount.com',
      privateKey,
      'https://www.googleapis.com/auth/analytics.readonly',
    )

    const parts = jwt.split('.')
    const signingInput = `${parts[0]}.${parts[1]}`
    const signature = Buffer.from(parts[2]!, 'base64url')

    const verify = crypto.createVerify('RSA-SHA256')
    verify.update(signingInput)
    expect(verify.verify(publicKey, signature)).toBe(true)
  })
})

describe('fetchTrafficByLandingPage', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function mockFetchResponse(body: object, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('paginates through all rows when rowCount exceeds page size', async () => {
    // Simulate a full page of 10,000 rows followed by a partial second page.
    // The GA4 API returns up to `limit` rows per call; if rows.length === limit
    // and offset < rowCount, the client must fetch the next page.
    const PAGE_SIZE = 10000
    const totalRows = PAGE_SIZE + 2

    function makeRow(i: number) {
      return {
        dimensionValues: [{ value: '20260320' }, { value: `/page-${i}` }],
        metricValues: [{ value: String(i) }, { value: String(i) }, { value: String(i) }],
      }
    }

    const page1Rows = Array.from({ length: PAGE_SIZE }, (_, i) => makeRow(i))
    const page2Rows = [makeRow(PAGE_SIZE), makeRow(PAGE_SIZE + 1)]

    const mainRequestBodies: Array<{ offset?: number }> = []

    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('runReport')) {
        const body = JSON.parse(init?.body as string ?? '{}')
        // Organic-pass requests have a dimensionFilter — return empty rows
        if (body.dimensionFilter) return mockFetchResponse({ rows: [], rowCount: 0 })
        mainRequestBodies.push({ offset: body.offset })
        const isPage1 = (body.offset ?? 0) === 0
        return mockFetchResponse({
          rows: isPage1 ? page1Rows : page2Rows,
          rowCount: totalRows,
        })
      }
      return mockFetchResponse({ error: 'unexpected' }, 500)
    })

    const rows = await fetchTrafficByLandingPage('fake-token', '123456', 1)

    // All rows from both pages should be collected
    expect(rows).toHaveLength(totalRows)
    // Two main API calls: offset=0, then offset=10000 (organic pass is separate)
    expect(mainRequestBodies).toHaveLength(2)
    expect(mainRequestBodies[0]!.offset).toBe(0)
    expect(mainRequestBodies[1]!.offset).toBe(PAGE_SIZE)
    // Dates should be converted from YYYYMMDD to YYYY-MM-DD
    expect(rows[0]!.date).toBe('2026-03-20')
  })

  it('stops after one page when all rows fit', async () => {
    const response = {
      rows: [
        { dimensionValues: [{ value: '20260320' }, { value: '/only-page' }], metricValues: [{ value: '100' }, { value: '50' }, { value: '80' }] },
      ],
      rowCount: 1,
    }

    let mainCallCount = 0
    fetchSpy.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? '{}')
      // Organic-pass requests have a dimensionFilter — return empty, don't count as main
      if (body.dimensionFilter) return mockFetchResponse({ rows: [], rowCount: 0 })
      mainCallCount++
      return mockFetchResponse(response)
    })

    const rows = await fetchTrafficByLandingPage('fake-token', '123456', 1)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessions).toBe(100)
    expect(mainCallCount).toBe(1)
  })
})
