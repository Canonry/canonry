import crypto from 'node:crypto'
import type { CustomFetch } from 'openid-client'
import { describe, expect, test, vi } from 'vitest'
import { createGoogleOidcClient, GOOGLE_ISSUER } from '../src/google-sign-in-client.js'

const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyId = crypto.randomUUID()

function fixture(overrides: Record<string, unknown> = {}, wrongSignature = false) {
  const clientId = crypto.randomUUID()
  const clientSecret = crypto.randomBytes(24).toString('hex')
  const state = crypto.randomBytes(32).toString('base64url')
  const nonce = crypto.randomBytes(32).toString('base64url')
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const redirectUri = 'https://dashboard.example.test/nested/api/v1/auth/google/callback'
  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set('code', crypto.randomUUID())
  callbackUrl.searchParams.set('state', state)
  const subject = crypto.randomUUID()
  const email = `${crypto.randomUUID()}@example.test`
  const now = Math.floor(Date.now() / 1000)
  const claims = { iss: GOOGLE_ISSUER, sub: subject, aud: clientId, iat: now, exp: now + 600,
    nonce, email, email_verified: true, hd: 'example.test', name: crypto.randomUUID(), ...overrides }
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: keyId })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signed = `${header}.${body}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signed), wrongSignature ? otherKey.privateKey : signingKey.privateKey).toString('base64url')
  const fetcher = vi.fn<CustomFetch>(async (input, init) => {
    const url = String(input)
    if (url.includes('/certs')) {
      return Response.json({ keys: [{ ...signingKey.publicKey.export({ format: 'jwk' }), kid: keyId, alg: 'RS256', use: 'sig' }] })
    }
    const params = new URLSearchParams(String(init?.body))
    expect(params.get('code_verifier')).toBe(codeVerifier)
    expect(params.get('redirect_uri')).toBe(redirectUri)
    expect(params.get('client_id')).toBe(clientId)
    return Response.json({ access_token: crypto.randomUUID(), token_type: 'Bearer', expires_in: 600, id_token: `${signed}.${signature}` })
  })
  const client = createGoogleOidcClient({ clientId, clientSecret }, fetcher)
  return { client, fetcher, clientId, state, nonce, codeVerifier, redirectUri, callbackUrl, subject, email }
}

describe('Google OIDC login adapter', () => {
  test('requests minimal identity scopes with nonce, state and S256 PKCE', async () => {
    const f = fixture()
    const url = new URL(await f.client.authorizationUrl(f))
    expect(url.origin).toBe(GOOGLE_ISSUER)
    expect(new Set(url.searchParams.get('scope')?.split(' '))).toEqual(new Set(['openid', 'email', 'profile']))
    expect(url.searchParams.get('state')).toBe(f.state)
    expect(url.searchParams.get('nonce')).toBe(f.nonce)
    expect(url.searchParams.get('redirect_uri')).toBe(f.redirectUri)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(crypto.createHash('sha256').update(f.codeVerifier).digest('base64url'))
  })

  test('verifies a signed identity and returns no provider bearer tokens', async () => {
    const f = fixture()
    const identity = await f.client.authenticate(f)
    expect(identity).toMatchObject({ issuer: GOOGLE_ISSUER, subject: f.subject, email: f.email, emailVerified: true })
    expect(Object.keys(identity).sort()).toEqual(['email', 'emailVerified', 'hostedDomain', 'issuer', 'name', 'subject'].sort())
    expect(f.fetcher).toHaveBeenCalledTimes(2)
  })

  test.each([
    { iss: 'https://other.example.test' },
    { aud: crypto.randomUUID() },
    { exp: 1 },
    { nonce: crypto.randomUUID() },
    { sub: '' },
  ])('rejects invalid token claims: %j', async overrides => {
    const f = fixture(overrides)
    await expect(f.client.authenticate(f)).rejects.toThrow()
  })

  test('rejects a valid-looking token signed by a different key', async () => {
    const f = fixture({}, true)
    await expect(f.client.authenticate(f)).rejects.toThrow()
  })

  test('rejects state mismatch before exchanging a code', async () => {
    const f = fixture()
    f.callbackUrl.searchParams.set('state', crypto.randomUUID())
    await expect(f.client.authenticate(f)).rejects.toThrow()
    expect(f.fetcher).not.toHaveBeenCalled()
  })
})
