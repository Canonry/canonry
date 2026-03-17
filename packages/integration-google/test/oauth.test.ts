import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAuthUrl, exchangeCode, refreshAccessToken } from '../src/oauth.js'
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GSC_SCOPE } from '../src/constants.js'

describe('getAuthUrl', () => {
  it('generates a valid Google OAuth URL with required params', () => {
    const url = getAuthUrl('client-id-123', 'http://localhost:4100/callback', [GSC_SCOPE])
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe(GOOGLE_AUTH_URL)
    expect(parsed.searchParams.get('client_id')).toBe('client-id-123')
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:4100/callback')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('scope')).toBe(GSC_SCOPE)
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
  })

  it('includes state parameter when provided', () => {
    const url = getAuthUrl('client-id', 'http://localhost/cb', [GSC_SCOPE], 'my-state')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('state')).toBe('my-state')
  })

  it('omits state parameter when not provided', () => {
    const url = getAuthUrl('client-id', 'http://localhost/cb', [GSC_SCOPE])
    const parsed = new URL(url)
    expect(parsed.searchParams.get('state')).toBe(null)
  })

  it('joins multiple scopes with space', () => {
    const url = getAuthUrl('client-id', 'http://localhost/cb', ['scope1', 'scope2'])
    const parsed = new URL(url)
    expect(parsed.searchParams.get('scope')).toBe('scope1 scope2')
  })
})

describe('exchangeCode', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends correct parameters and returns token response', async () => {
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

    const result = await exchangeCode('cid', 'csecret', 'auth-code', 'http://localhost/cb')

    expect(capturedUrl).toBe(GOOGLE_TOKEN_URL)
    expect(capturedBody.includes('grant_type=authorization_code')).toBeTruthy()
    expect(capturedBody.includes('code=auth-code')).toBeTruthy()
    expect(capturedBody.includes('client_id=cid')).toBeTruthy()
    expect(capturedBody.includes('client_secret=csecret')).toBeTruthy()
    expect(result.access_token).toBe('test-access-token')
    expect(result.refresh_token).toBe('test-refresh-token')
    expect(result.expires_in).toBe(3600)
  })

  it('throws GoogleAuthError on non-OK response', async () => {
    globalThis.fetch = async () => new Response('{"error": "invalid_grant"}', { status: 400 })

    await expect(
      () => exchangeCode('cid', 'csecret', 'bad-code', 'http://localhost/cb'),
    ).rejects.toThrow(/Token exchange failed/)
    await expect(
      () => exchangeCode('cid', 'csecret', 'bad-code', 'http://localhost/cb'),
    ).rejects.toThrow(/400/)
  })
})

describe('refreshAccessToken', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends refresh_token grant type and returns new token', async () => {
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

    const result = await refreshAccessToken('cid', 'csecret', 'my-refresh-token')

    expect(capturedBody.includes('grant_type=refresh_token')).toBeTruthy()
    expect(capturedBody.includes('refresh_token=my-refresh-token')).toBeTruthy()
    expect(result.access_token).toBe('new-access-token')
  })

  it('throws on error response', async () => {
    globalThis.fetch = async () => new Response('{"error": "invalid_grant"}', { status: 401 })

    await expect(
      () => refreshAccessToken('cid', 'csecret', 'expired-token'),
    ).rejects.toThrow(/Token refresh failed/)
  })
})
