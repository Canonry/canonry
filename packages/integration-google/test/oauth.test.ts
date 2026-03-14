import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getAuthUrl, exchangeCode, refreshAccessToken } from '../src/oauth.js'
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GSC_SCOPE } from '../src/constants.js'

describe('getAuthUrl', () => {
  it('generates a valid Google OAuth URL with required params', () => {
    const url = getAuthUrl('client-id-123', 'http://localhost:4100/callback', [GSC_SCOPE])
    const parsed = new URL(url)
    assert.equal(parsed.origin + parsed.pathname, GOOGLE_AUTH_URL)
    assert.equal(parsed.searchParams.get('client_id'), 'client-id-123')
    assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:4100/callback')
    assert.equal(parsed.searchParams.get('response_type'), 'code')
    assert.equal(parsed.searchParams.get('scope'), GSC_SCOPE)
    assert.equal(parsed.searchParams.get('access_type'), 'offline')
    assert.equal(parsed.searchParams.get('prompt'), 'consent')
  })

  it('includes state parameter when provided', () => {
    const url = getAuthUrl('client-id', 'http://localhost/cb', [GSC_SCOPE], 'my-state')
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('state'), 'my-state')
  })

  it('omits state parameter when not provided', () => {
    const url = getAuthUrl('client-id', 'http://localhost/cb', [GSC_SCOPE])
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('state'), null)
  })

  it('joins multiple scopes with space', () => {
    const url = getAuthUrl('client-id', 'http://localhost/cb', ['scope1', 'scope2'])
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('scope'), 'scope1 scope2')
  })
})

describe('exchangeCode', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  it('sends correct parameters and returns token response', async (t) => {
    const mockTokenResponse = {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: GSC_SCOPE,
    }

    let capturedUrl = ''
    let capturedBody = ''
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = String(init?.body ?? '')
      return new Response(JSON.stringify(mockTokenResponse), { status: 200 })
    }

    t.after(() => { globalThis.fetch = originalFetch })

    const result = await exchangeCode('cid', 'csecret', 'auth-code', 'http://localhost/cb')

    assert.equal(capturedUrl, GOOGLE_TOKEN_URL)
    assert.ok(capturedBody.includes('grant_type=authorization_code'))
    assert.ok(capturedBody.includes('code=auth-code'))
    assert.ok(capturedBody.includes('client_id=cid'))
    assert.ok(capturedBody.includes('client_secret=csecret'))
    assert.equal(result.access_token, 'test-access-token')
    assert.equal(result.refresh_token, 'test-refresh-token')
    assert.equal(result.expires_in, 3600)
  })

  it('throws GoogleAuthError on non-OK response', async (t) => {
    globalThis.fetch = async () => new Response('{"error": "invalid_grant"}', { status: 400 })
    t.after(() => { globalThis.fetch = originalFetch })

    await assert.rejects(
      () => exchangeCode('cid', 'csecret', 'bad-code', 'http://localhost/cb'),
      (err: Error) => {
        assert.ok(err.message.includes('Token exchange failed'))
        assert.ok(err.message.includes('400'))
        return true
      },
    )
  })
})

describe('refreshAccessToken', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  it('sends refresh_token grant type and returns new token', async (t) => {
    const mockResponse = {
      access_token: 'new-access-token',
      expires_in: 3600,
      token_type: 'Bearer',
    }

    let capturedBody = ''
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '')
      return new Response(JSON.stringify(mockResponse), { status: 200 })
    }

    t.after(() => { globalThis.fetch = originalFetch })

    const result = await refreshAccessToken('cid', 'csecret', 'my-refresh-token')

    assert.ok(capturedBody.includes('grant_type=refresh_token'))
    assert.ok(capturedBody.includes('refresh_token=my-refresh-token'))
    assert.equal(result.access_token, 'new-access-token')
  })

  it('throws on error response', async (t) => {
    globalThis.fetch = async () => new Response('{"error": "invalid_grant"}', { status: 401 })
    t.after(() => { globalThis.fetch = originalFetch })

    await assert.rejects(
      () => refreshAccessToken('cid', 'csecret', 'expired-token'),
      (err: Error) => {
        assert.ok(err.message.includes('Token refresh failed'))
        return true
      },
    )
  })
})
