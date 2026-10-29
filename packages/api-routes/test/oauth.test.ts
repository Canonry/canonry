import crypto from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apiKeys, createClient, migrate, oauthClients, oauthGrants, oauthTokens, users } from '@canonry/canonry-db'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'

import { registerOAuthRoutes, resolveOAuthAccessToken } from '../src/oauth.js'
import { createCredentialChecker } from '../src/user-session.js'
import { hashUserPassword } from '../src/user-password.js'

/**
 * OAuth 2.1 for the MCP resource. Most of these are NEGATIVE cases on purpose:
 * an authorization server is defined by what it refuses, and every check below
 * is one an attacker would otherwise walk through.
 */

const ISSUER = 'https://instance.example.com'
const RESOURCE_PATH = '/api/v1/mcp'
const REDIRECT = 'https://client.example.com/callback'
const VERIFIER = 'a'.repeat(64)
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url')

/**
 * A same-origin form post, as a browser makes it. Host and Origin are pinned
 * together because assertCookieWriteOrigin compares them — and a mismatch is
 * exactly the cross-site session-fixation case it exists to refuse, so the
 * tests must model a real browser rather than inject's defaults.
 */
const FORM_HEADERS = {
  'content-type': 'application/x-www-form-urlencoded',
  host: 'canonry.test',
  origin: 'http://canonry.test',
} as const

let db: ReturnType<typeof createClient>
let app: FastifyInstance
let tmpDir: string
let signedInUserId: string | null

const PASSWORD = 'correct-horse'

async function build() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-oauth-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = new Date().toISOString()
  const userId = crypto.randomUUID()
  db.insert(users).values({
    id: userId, name: 'Sam', nameKey: 'sam', passwordHash: await hashUserPassword(PASSWORD), role: 'viewer', createdAt: now,
  }).run()
  signedInUserId = userId

  db.insert(oauthClients).values({
    id: 'client-1', name: 'Test client', secretHash: null, redirectUris: [REDIRECT], createdAt: now,
  }).run()

  app = Fastify()
  registerOAuthRoutes(app, {
    db,
    issuer: ISSUER,
    resourcePaths: [RESOURCE_PATH],
    resolveUser: () => (signedInUserId ? { id: signedInUserId, name: 'Sam' } : null),
    startSession: (id) => { signedInUserId = id; return 'session=set' },
    credentials: createCredentialChecker({ db }),
  })
  return userId
}

beforeEach(async () => { await build() })
afterEach(async () => {
  vi.useRealTimers()
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function authorizeUrl(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...overrides,
  })
  return `/oauth/authorize?${params.toString()}`
}

/**
 * Walk the real flow: the GET renders an approval page, and only an explicit
 * POST carrying the CSRF token mints a code. A session is authentication, not
 * consent, so there is no shortcut here on purpose.
 */
async function approve(overrides: Record<string, string> = {}): Promise<string> {
  const url = authorizeUrl(overrides)
  const page = await app.inject({ method: 'GET', url })
  expect(page.statusCode).toBe(200)
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1]
  expect(csrf, 'consent form should carry a CSRF token').toBeTruthy()
  const query = url.split('?')[1]!
  const res = await app.inject({
    method: 'POST',
    url: `/oauth/authorize/consent?${query}`,
    headers: FORM_HEADERS,
    payload: new URLSearchParams({ csrf: csrf!, approve: 'yes' }).toString(),
  })
  expect(res.statusCode).toBe(302)
  return new URL(res.headers.location as string).searchParams.get('code')!
}

async function getCode(): Promise<string> {
  return approve()
}

test('advertises a registration endpoint, without which a desktop client stalls', async () => {
  // Codex walks discovery correctly and then stops: its UI has no client_id
  // field, so DCR is the only way it can obtain credentials.
  const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
  expect(res.json().registration_endpoint).toBe(`${ISSUER}/oauth/register`)
})

test('serves authorization-server metadata at the path-inserted location too', async () => {
  // Probed BEFORE the bare root form by at least one real client.
  const res = await app.inject({ method: 'GET', url: `/.well-known/oauth-authorization-server${RESOURCE_PATH}` })
  expect(res.statusCode).toBe(200)
  expect(res.json().issuer).toBe(ISSUER)
})

test('registers a client dynamically and that client can complete the flow', async () => {
  const reg = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'Desktop', redirect_uris: ['http://127.0.0.1:0/callback'] },
  })
  expect(reg.statusCode).toBe(201)
  const clientId = reg.json().client_id as string
  // Public client: no secret is ever issued over an open endpoint.
  expect(reg.json().client_secret).toBeUndefined()
  expect(reg.json().token_endpoint_auth_method).toBe('none')

  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId,
    redirect_uri: 'http://127.0.0.1:61234/callback',
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
  })
  const page = await app.inject({ method: 'GET', url: `/oauth/authorize?${params.toString()}` })
  expect(page.statusCode).toBe(200)
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!
  const approved = await app.inject({
    method: 'POST',
    url: `/oauth/authorize/consent?${params.toString()}`,
    headers: FORM_HEADERS,
    payload: new URLSearchParams({ csrf, approve: 'yes' }).toString(),
  })
  expect(new URL(approved.headers.location as string).searchParams.get('code')).toBeTruthy()
})

test('registration refuses a redirect it could not safely send a token to', async () => {
  for (const uri of ['http://evil.example.com/cb', 'ftp://x/cb', 'not-a-url']) {
    const res = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [uri] } })
    expect(res.statusCode, uri).toBe(400)
  }
  const empty = await app.inject({ method: 'POST', url: '/oauth/register', payload: {} })
  expect(empty.statusCode).toBe(400)
})

test('registering alone grants no access at all', async () => {
  // What makes an open registration endpoint safe: it mints an identifier, not
  // authority. Nothing is reachable until a person signs in and approves.
  const reg = await app.inject({
    method: 'POST', url: '/oauth/register',
    payload: { redirect_uris: ['https://client.example.com/cb'] },
  })
  const clientId = reg.json().client_id as string
  const token = await app.inject({
    method: 'POST', url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code: 'made-up', code_verifier: VERIFIER, client_id: clientId, redirect_uri: 'https://client.example.com/cb' },
  })
  expect(token.statusCode).toBe(400)
})

test('publishes protected-resource metadata at the RFC 9728 inserted path', async () => {
  // The well-known segment goes BETWEEN host and path. Serving it under the
  // resource instead is the mistake that makes discovery silently unreachable.
  const res = await app.inject({ method: 'GET', url: `/.well-known/oauth-protected-resource${RESOURCE_PATH}` })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({
    resource: `${ISSUER}${RESOURCE_PATH}`,
    authorization_servers: [ISSUER],
  })
})

test('advertises S256 only, never plain', async () => {
  const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
  expect(res.statusCode).toBe(200)
  expect(res.json().code_challenge_methods_supported).toEqual(['S256'])
})

test('authorize refuses a plain PKCE downgrade', async () => {
  const res = await app.inject({ method: 'GET', url: authorizeUrl({ code_challenge_method: 'plain' }) })
  expect(res.statusCode).toBe(400)
  expect(res.json().error).toBe('invalid_request')
})

test('authorize refuses a missing code_challenge', async () => {
  const params = new URLSearchParams({
    response_type: 'code', client_id: 'client-1', redirect_uri: REDIRECT, code_challenge_method: 'S256',
  })
  const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${params.toString()}` })
  expect(res.statusCode).toBe(400)
})

test('authorize refuses an unregistered redirect_uri', async () => {
  // Exact match only. A prefix rule here is an open redirect.
  const res = await app.inject({ method: 'GET', url: authorizeUrl({ redirect_uri: 'https://client.example.com/callback/../evil' }) })
  expect(res.statusCode).toBe(400)
})

test('a loopback redirect matches on any port, per RFC 8252 s7.3', async () => {
  // A native app binds an ephemeral port at runtime and cannot know it at
  // registration time. Without this no desktop client completes the flow.
  const now = new Date().toISOString()
  db.insert(oauthClients).values({
    id: 'native', name: 'Desktop', secretHash: null,
    redirectUris: ['http://127.0.0.1:0/callback'], createdAt: now,
  }).run()
  const params = new URLSearchParams({
    response_type: 'code', client_id: 'native',
    redirect_uri: 'http://127.0.0.1:54321/callback',
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
  })
  const page = await app.inject({ method: 'GET', url: `/oauth/authorize?${params.toString()}` })
  expect(page.statusCode).toBe(200)
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!
  const res = await app.inject({
    method: 'POST',
    url: `/oauth/authorize/consent?${params.toString()}`,
    headers: FORM_HEADERS,
    payload: new URLSearchParams({ csrf, approve: 'yes' }).toString(),
  })
  expect(new URL(res.headers.location as string).port).toBe('54321')
})

test('the loopback carve-out floats ONLY the port', async () => {
  // Scheme, host and path still match exactly; anything looser is an open
  // redirect wearing a loopback costume.
  const now = new Date().toISOString()
  db.insert(oauthClients).values({
    id: 'native2', name: 'Desktop', secretHash: null,
    redirectUris: ['http://127.0.0.1:0/callback'], createdAt: now,
  }).run()
  for (const bad of [
    'http://127.0.0.1:54321/evil',        // different path
    'https://127.0.0.1:54321/callback',   // different scheme
    'http://evil.example.com/callback',   // not loopback at all
    'http://127.0.0.1.evil.com/callback', // loopback-looking host
  ]) {
    const params = new URLSearchParams({
      response_type: 'code', client_id: 'native2', redirect_uri: bad,
      code_challenge: CHALLENGE, code_challenge_method: 'S256',
    })
    const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${params.toString()}` })
    expect(res.statusCode, bad).toBe(400)
  }
})

test('authorize refuses a resource that is not this server', async () => {
  const res = await app.inject({ method: 'GET', url: authorizeUrl({ resource: 'https://elsewhere.example.com/api/v1/mcp' }) })
  expect(res.statusCode).toBe(400)
  expect(res.json().error).toBe('invalid_target')
})

test('authorize serves its own sign-in rather than redirecting to a route that does not exist', async () => {
  // The obvious design — bounce to /signin?next=… — dead-ends: the dashboard
  // has no such route, never reads `next`, and 404s under a base path. The
  // form posts back to the same URL so the flow resumes inline.
  signedInUserId = null
  const res = await app.inject({ method: 'GET', url: authorizeUrl() })
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  expect(res.body).toContain('<form method="post"')
  expect(res.body).toContain('/oauth/authorize')
})

test('signing in on the consent page completes the authorization', async () => {
  signedInUserId = null
  const url = authorizeUrl()
  const posted = await app.inject({
    method: 'POST',
    url,
    payload: 'name=sam&password=correct-horse',
    headers: FORM_HEADERS,
  })
  // Re-enters the GET flow so every validation runs again rather than being
  // duplicated in the POST handler.
  expect(posted.statusCode).toBe(302)
  expect(posted.headers['set-cookie']).toBeTruthy()
})

test('a wrong password re-renders the form and issues no code', async () => {
  signedInUserId = null
  const res = await app.inject({
    method: 'POST',
    url: authorizeUrl(),
    payload: 'name=sam&password=wrong',
    headers: FORM_HEADERS,
  })
  expect(res.statusCode).toBe(200)
  // Assert on behaviour, not copy: the message comes from the shared checker
  // both sign-in doors use, so pinning its exact wording here would couple this
  // test to the dashboard's copy.
  expect(res.body).toContain('name="password"')
  expect(res.body).toContain('class="err"')
  expect(res.headers['set-cookie']).toBeFalsy()
})

test('an unknown name is indistinguishable from a wrong password', async () => {
  // Otherwise the endpoint is a user-enumeration oracle.
  signedInUserId = null
  const unknown = await app.inject({
    method: 'POST', url: authorizeUrl(), payload: 'name=nobody&password=wrong',
    headers: FORM_HEADERS,
  })
  const wrong = await app.inject({
    method: 'POST', url: authorizeUrl(), payload: 'name=sam&password=wrong',
    headers: FORM_HEADERS,
  })
  expect(unknown.statusCode).toBe(wrong.statusCode)
  expect(unknown.body).toBe(wrong.body)
})

test('the token endpoint accepts form-encoded bodies, as every real client sends', async () => {
  // RFC 6749 s4.1.3. Fastify 415s form bodies without a parser, so a JSON-only
  // token endpoint is unreachable by any standards-compliant client.
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: VERIFIER,
      client_id: 'client-1', redirect_uri: REDIRECT,
    }).toString(),
    headers: FORM_HEADERS,
  })
  expect(res.statusCode).toBe(200)
  expect(res.json().access_token).toBeTruthy()
})

test('a revoked client cannot exchange a code or rotate a refresh token', async () => {
  const code = await getCode()
  const first = await app.inject({
    method: 'POST', url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const refresh = first.json().refresh_token as string

  db.update(oauthClients).set({ revokedAt: new Date().toISOString() }).where(eq(oauthClients.id, 'client-1')).run()

  const rotated = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refresh, client_id: 'client-1' } })
  expect(rotated.statusCode).toBe(400)
  expect(rotated.json().error).toBe('invalid_client')
})

test('a confidential client must present its secret', async () => {
  const secret = 'super-secret'
  db.update(oauthClients)
    .set({ secretHash: crypto.createHash('sha256').update(secret).digest('hex') })
    .where(eq(oauthClients.id, 'client-1')).run()

  const code = await getCode()
  const base = { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT }
  const without = await app.inject({ method: 'POST', url: '/oauth/token', payload: base })
  expect(without.statusCode).toBe(400)
  expect(without.json().error).toBe('invalid_client')

  const code2 = await getCode()
  const withSecret = await app.inject({
    method: 'POST', url: '/oauth/token',
    payload: { ...base, code: code2, client_secret: secret },
  })
  expect(withSecret.statusCode).toBe(200)
})

test('a self-registered client is marked unverified on the consent page', async () => {
  // The name on that page is the trust anchor, and an open registration
  // endpoint lets a client choose its own. A client calling itself "Canonry
  // Dashboard" must not read as first-party.
  const reg = await app.inject({
    method: 'POST', url: '/oauth/register',
    payload: { client_name: 'Canonry Dashboard', redirect_uris: ['https://evil.example.com/cb'] },
  })
  const clientId = reg.json<{ client_id: string }>().client_id
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId,
    redirect_uri: 'https://evil.example.com/cb',
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
  })
  const page = await app.inject({ method: 'GET', url: `/oauth/authorize?${params.toString()}` })
  expect(page.body).toContain('chose its own name')
  expect(page.body).toContain('evil.example.com')
})

test('an operator-registered client carries no unverified warning', async () => {
  const page = await app.inject({ method: 'GET', url: authorizeUrl() })
  expect(page.body).not.toContain('chose its own name')
})

test('registration is rate limited', async () => {
  // Open and unbounded is a free way to fill the table and to farm
  // plausible-looking names for the consent screen.
  let limited = false
  for (let i = 0; i < 15; i++) {
    const res = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { redirect_uris: ['https://client.example.com/cb'] },
    })
    if (res.statusCode === 429) { limited = true; break }
  }
  expect(limited).toBe(true)
})

test('the consent page cannot be framed', async () => {
  // It is the only human gate in the flow. Framed, one decoy click posts
  // approve=yes with the Lax cookie attached and mints a code to an attacker's
  // callback — RFC 6849 s10.13 puts that defence on the authorization server.
  const res = await app.inject({ method: 'GET', url: authorizeUrl() })
  expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(res.headers['x-frame-options']).toBe('DENY')
  expect(res.headers['cache-control']).toBe('no-store')
})

test('a cross-site form post cannot force a session or approve a grant', async () => {
  // The urlencoded parser makes these routes CORS-simple, so no preflight
  // stands between a foreign page and this handler. Origin is the control.
  const foreign = {
    'content-type': 'application/x-www-form-urlencoded',
    host: 'canonry.test',
    origin: 'https://evil.example.com',
  }
  const signIn = await app.inject({
    method: 'POST', url: authorizeUrl(), headers: foreign,
    payload: new URLSearchParams({ name: 'sam', password: PASSWORD }).toString(),
  })
  expect(signIn.statusCode).toBe(403)
  expect(signIn.headers['set-cookie']).toBeFalsy()

  const approve = await app.inject({
    method: 'POST', url: `/oauth/authorize/consent?${authorizeUrl().split('?')[1]}`,
    headers: foreign,
    payload: new URLSearchParams({ csrf: 'anything', approve: 'yes' }).toString(),
  })
  expect(approve.statusCode).toBe(403)
})

test('a signed-in person is ASKED, not auto-granted', async () => {
  // The GET used to mint a code off nothing but a session cookie. With
  // SameSite=Lax and open registration, a link was then enough to hand a third
  // party a token bound to the operator's account.
  const res = await app.inject({ method: 'GET', url: authorizeUrl() })
  expect(res.statusCode).toBe(200)
  expect(res.body).toContain('Allow access?')
  expect(res.body).toContain('name="csrf"')
  expect(res.headers.location).toBeUndefined()
})

test('approving returns a code plus state and iss', async () => {
  const url = authorizeUrl()
  const page = await app.inject({ method: 'GET', url })
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!
  const res = await app.inject({
    method: 'POST',
    url: `/oauth/authorize/consent?${url.split('?')[1]}`,
    headers: FORM_HEADERS,
    payload: new URLSearchParams({ csrf, approve: 'yes' }).toString(),
  })
  const loc = new URL(res.headers.location as string)
  expect(loc.searchParams.get('code')).toBeTruthy()
  expect(loc.searchParams.get('state')).toBe('xyz')
  // RFC 9207: lets the client detect a mix-up attack.
  expect(loc.searchParams.get('iss')).toBe(ISSUER)
})

test('a forged or missing CSRF token approves nothing', async () => {
  const url = authorizeUrl()
  await app.inject({ method: 'GET', url })
  for (const csrf of ['', 'forged', 'x'.repeat(43)]) {
    const res = await app.inject({
      method: 'POST',
      url: `/oauth/authorize/consent?${url.split('?')[1]}`,
      headers: FORM_HEADERS,
      payload: new URLSearchParams({ csrf, approve: 'yes' }).toString(),
    })
    expect(res.statusCode, csrf || '(empty)').toBe(400)
  }
})

test('denying redirects with access_denied and issues no code', async () => {
  const url = authorizeUrl()
  const page = await app.inject({ method: 'GET', url })
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!
  const res = await app.inject({
    method: 'POST',
    url: `/oauth/authorize/consent?${url.split('?')[1]}`,
    headers: FORM_HEADERS,
    payload: new URLSearchParams({ csrf, approve: 'no' }).toString(),
  })
  const loc = new URL(res.headers.location as string)
  expect(loc.searchParams.get('error')).toBe('access_denied')
  expect(loc.searchParams.get('code')).toBeNull()
})

test('token exchanges a code for an access token and a refresh token', async () => {
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.token_type).toBe('Bearer')
  expect(body.access_token).toBeTruthy()
  expect(body.refresh_token).toBeTruthy()

  const resolved = resolveOAuthAccessToken(db, body.access_token, `${ISSUER}${RESOURCE_PATH}`)
  expect(resolved?.userId).toBe(signedInUserId)
})

test('token refuses a wrong PKCE verifier', async () => {
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: 'b'.repeat(64), client_id: 'client-1', redirect_uri: REDIRECT },
  })
  expect(res.statusCode).toBe(400)
  expect(res.json().error).toBe('invalid_grant')
})

test('a code is single use even when the first attempt FAILED', async () => {
  // Burned before any other check, so a wrong verifier cannot be retried
  // against the same code until it is guessed.
  const code = await getCode()
  const payload = { grant_type: 'authorization_code', code, client_id: 'client-1', redirect_uri: REDIRECT }
  const first = await app.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, code_verifier: 'b'.repeat(64) } })
  expect(first.statusCode).toBe(400)
  const second = await app.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, code_verifier: VERIFIER } })
  expect(second.statusCode).toBe(400)
})

test('token refuses a code presented by a different client', async () => {
  const now = new Date().toISOString()
  db.insert(oauthClients).values({ id: 'client-2', name: 'Other', secretHash: null, redirectUris: [REDIRECT], createdAt: now }).run()
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-2', redirect_uri: REDIRECT },
  })
  expect(res.statusCode).toBe(400)
})

test('refresh rotates: the presented token dies with the request that used it', async () => {
  const code = await getCode()
  const first = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const refresh = first.json().refresh_token as string

  const second = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refresh, client_id: 'client-1' } })
  expect(second.statusCode).toBe(200)
  expect(second.json().refresh_token).not.toBe(refresh)

  const replay = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refresh, client_id: 'client-1' } })
  expect(replay.statusCode).toBe(400)
  expect(replay.json().error).toBe('invalid_grant')
  expect(resolveOAuthAccessToken(db, second.json<TokenPair>().access_token, `${ISSUER}${RESOURCE_PATH}`)).toBeNull()
  expect((await refreshGrant(second.json<TokenPair>().refresh_token)).statusCode).toBe(400)
})

test('an access token is not valid for a different resource', async () => {
  // Audience binding. Without it a token minted for one endpoint works on any.
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const token = res.json().access_token as string
  expect(resolveOAuthAccessToken(db, token, `${ISSUER}${RESOURCE_PATH}`)).not.toBeNull()
  expect(resolveOAuthAccessToken(db, token, 'https://elsewhere.example.com/api/v1/mcp')).toBeNull()
})

test('a revoked access token stops resolving', async () => {
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const token = res.json().access_token as string
  const revoke = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token } })
  expect(revoke.statusCode).toBe(200)
  expect(resolveOAuthAccessToken(db, token, `${ISSUER}${RESOURCE_PATH}`)).toBeNull()
})

test('revoke answers 200 for an unknown token rather than acting as an oracle', async () => {
  const res = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: 'not-a-real-token' } })
  expect(res.statusCode).toBe(200)
})

test('tokens are stored as digests, never in plaintext', async () => {
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const token = res.json().access_token as string
  const rows = db.select().from(oauthTokens).all()
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) expect(row.tokenHash).not.toBe(token)
  expect(db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, token)).get()).toBeUndefined()
})


interface TokenPair {
  access_token: string
  refresh_token: string
}

async function issueGrant(): Promise<TokenPair> {
  const code = await getCode()
  const response = await app.inject({ method: 'POST', url: '/oauth/token', payload: {
    grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT,
  } })
  expect(response.statusCode).toBe(200)
  return response.json<TokenPair>()
}

function refreshGrant(token: string, overrides: Record<string, string | undefined> = {}) {
  return app.inject({ method: 'POST', url: '/oauth/token', payload: {
    grant_type: 'refresh_token', refresh_token: token, client_id: 'client-1', ...overrides,
  } })
}

test('refresh requires its explicit client identity without consuming a mismatched request', async () => {
  const tokens = await issueGrant()
  db.insert(oauthClients).values({ id: 'client-2', name: 'Other client', redirectUris: [REDIRECT], createdAt: new Date().toISOString() }).run()
  for (const [clientId, error] of [[undefined, 'invalid_request'], ['client-2', 'invalid_grant']] as const) {
    const response = await refreshGrant(tokens.refresh_token, { client_id: clientId })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe(error)
  }
  expect((await refreshGrant(tokens.refresh_token)).statusCode).toBe(200)
})

test('refresh authenticates the bound confidential client and rejects a different resource', async () => {
  const tokens = await issueGrant()
  db.update(oauthClients).set({ secretHash: crypto.createHash('sha256').update('client-secret').digest('hex') }).where(eq(oauthClients.id, 'client-1')).run()
  for (const secret of [undefined, 'wrong-secret']) {
    const response = await refreshGrant(tokens.refresh_token, { client_secret: secret })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_client')
  }
  const wrongResource = await refreshGrant(tokens.refresh_token, { client_secret: 'client-secret', resource: 'https://other.example/mcp' })
  expect(wrongResource.statusCode).toBe(400)
  expect(wrongResource.json().error).toBe('invalid_target')
  expect((await refreshGrant(tokens.refresh_token, { client_secret: 'client-secret', resource: `${ISSUER}${RESOURCE_PATH}` })).statusCode).toBe(200)
})

test('failed refresh persistence rolls back consumption and both replacement tokens', async () => {
  const tokens = await issueGrant()
  const before = db.select().from(oauthTokens).all().length
  db.$client.exec(`CREATE TRIGGER reject_refresh_insert BEFORE INSERT ON oauth_tokens
    WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`)
  try {
    const failed = await refreshGrant(tokens.refresh_token)
    expect(failed.statusCode).toBe(500)
    expect(db.select().from(oauthTokens).all()).toHaveLength(before)
  } finally {
    db.$client.exec('DROP TRIGGER reject_refresh_insert')
  }
  expect((await refreshGrant(tokens.refresh_token)).statusCode).toBe(200)
})

test.each(['access_token', 'refresh_token'] as const)('revoking a valid %s revokes all generations without touching sibling grants or users', async (tokenKind) => {
  const first = await issueGrant()
  const secondResponse = await refreshGrant(first.refresh_token)
  expect(secondResponse.statusCode).toBe(200)
  const second = secondResponse.json<TokenPair>()
  const thirdResponse = await refreshGrant(second.refresh_token)
  expect(thirdResponse.statusCode).toBe(200)
  const third = thirdResponse.json<TokenPair>()
  const sibling = await issueGrant()
  const originalUser = signedInUserId
  const otherUser = crypto.randomUUID()
  db.insert(users).values({ id: otherUser, name: 'Lee', nameKey: 'lee', passwordHash: 'unused', role: 'viewer', createdAt: new Date().toISOString() }).run()
  signedInUserId = otherUser
  const unrelatedUser = await issueGrant()
  signedInUserId = originalUser

  const revoke = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: tokenKind === 'access_token' ? first.access_token : third.refresh_token, client_id: 'client-1' } })
  expect(revoke.statusCode).toBe(200)
  for (const tokens of [first, second, third]) {
    expect(resolveOAuthAccessToken(db, tokens.access_token, `${ISSUER}${RESOURCE_PATH}`)).toBeNull()
    const denied = await refreshGrant(tokens.refresh_token)
    expect(denied.statusCode).toBe(400)
    expect(denied.json().error).toBe('invalid_grant')
  }
  for (const tokens of [sibling, unrelatedUser]) {
    expect(resolveOAuthAccessToken(db, tokens.access_token, `${ISSUER}${RESOURCE_PATH}`)).not.toBeNull()
    expect((await refreshGrant(tokens.refresh_token)).statusCode).toBe(200)
  }
})

test('revocation authenticates the client before checking token ownership or existence', async () => {
  const tokens = await issueGrant()
  db.update(oauthClients).set({ secretHash: crypto.createHash('sha256').update('client-secret').digest('hex') }).where(eq(oauthClients.id, 'client-1')).run()
  db.insert(oauthClients).values({ id: 'client-2', name: 'Other', redirectUris: [REDIRECT], createdAt: new Date().toISOString() }).run()
  const wrongClient = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: tokens.refresh_token, client_id: 'client-2' } })
  expect(wrongClient.statusCode).toBe(200)
  expect(resolveOAuthAccessToken(db, tokens.access_token, `${ISSUER}${RESOURCE_PATH}`)).not.toBeNull()
  for (const token of [tokens.refresh_token, 'unknown-token']) {
    for (const secret of [undefined, 'wrong-secret']) {
      const response = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token, client_id: 'client-1', client_secret: secret } })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('invalid_client')
    }
  }
  expect(resolveOAuthAccessToken(db, tokens.access_token, `${ISSUER}${RESOURCE_PATH}`)).not.toBeNull()
  const unknown = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: 'unknown-token', client_id: 'client-1', client_secret: 'client-secret' } })
  expect(unknown.statusCode).toBe(200)
  const revoked = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: tokens.refresh_token, client_id: 'client-1', client_secret: 'client-secret' } })
  expect(revoked.statusCode).toBe(200)
  expect(resolveOAuthAccessToken(db, tokens.access_token, `${ISSUER}${RESOURCE_PATH}`)).toBeNull()
})

test('a replay with the wrong client secret or audience cannot revoke the active family', async () => {
  const tokens = await issueGrant()
  db.update(oauthClients).set({ secretHash: crypto.createHash('sha256').update('client-secret').digest('hex') }).where(eq(oauthClients.id, 'client-1')).run()
  const rotated = await refreshGrant(tokens.refresh_token, { client_secret: 'client-secret' })
  expect(rotated.statusCode).toBe(200)
  const active = rotated.json<TokenPair>()
  for (const overrides of [
    { client_id: 'client-2', client_secret: 'client-secret' },
    { client_secret: 'wrong-secret' },
    { client_secret: 'client-secret', resource: 'https://elsewhere.example/mcp' },
  ]) {
    expect((await refreshGrant(tokens.refresh_token, overrides)).statusCode).toBe(400)
    expect(resolveOAuthAccessToken(db, active.access_token, `${ISSUER}${RESOURCE_PATH}`)).not.toBeNull()
  }
  expect((await refreshGrant(active.refresh_token, { client_secret: 'client-secret' })).statusCode).toBe(200)
})


test('independent processes cannot issue two replacements for one refresh token', async () => {
  const children: ChildProcess[] = []
  let requestId = 0
  function startWorker(): Promise<ChildProcess> {
    const child = fork(fileURLToPath(new URL('./fixtures/oauth-token-worker.ts', import.meta.url)), [path.join(tmpDir, 'test.db')], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, CANONRY_CONFIG_DIR: tmpDir, CANONRY_TELEMETRY_DISABLED: '1', CANONRY_DISABLE_UPDATE_CHECK: '1' },
    })
    children.push(child)
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`OAuth worker exited ${code}: ${stderr}`))
      child.once('exit', onExit)
      child.once('error', reject)
      child.once('message', (message: { ready?: boolean }) => {
        child.removeListener('exit', onExit)
        if (!message.ready) reject(new Error('OAuth worker did not become ready'))
        else resolve(child)
      })
    })
  }
  function contend(child: ChildProcess, refreshToken: string, startAt: number): Promise<{ status: number; body: { error?: string; access_token?: string; refresh_token?: string } }> {
    const id = ++requestId
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`OAuth contender exited ${code}`))
      child.once('exit', onExit)
      child.once('message', (message: { id: number; status: number; body: { error?: string; access_token?: string; refresh_token?: string }; failure?: string }) => {
        child.removeListener('exit', onExit)
        if (message.id !== id || message.failure) reject(new Error(message.failure ?? 'Unexpected OAuth response identity'))
        else resolve(message)
      })
      child.send({ id, refreshToken, startAt })
    })
  }
  try {
    const workers = await Promise.all(Array.from({ length: 4 }, () => startWorker()))
    // Repeated independent arrivals exercise scheduler interleavings rather
    // than a same-event-loop Promise.all that serializes synchronous SQL.
    for (let round = 0; round < 12; round++) {
      const tokens = await issueGrant()
      const startAt = Date.now() + 50
      const results = await Promise.all(workers.map(worker => contend(worker, tokens.refresh_token, startAt)))
      expect(results.map(result => result.status).sort(), `round ${round}`).toEqual([200, 400, 400, 400])
      for (const denied of results.filter(result => result.status === 400)) expect(denied.body.error).toBe('invalid_grant')
      // Strict rotation cannot distinguish a racing client from a thief. Any
      // authenticated replay invalidates even the request that won issuance.
      const winner = results.find(result => result.status === 200)!
      expect(winner.body.access_token).toEqual(expect.any(String))
      expect(resolveOAuthAccessToken(db, winner.body.access_token!, `${ISSUER}${RESOURCE_PATH}`)).toBeNull()
      expect((await refreshGrant(winner.body.refresh_token!)).statusCode).toBe(400)
    }
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      child.once('exit', () => resolve())
      child.kill()
    })))
  }
}, 60_000)


test.each(['confidential', 'revoked'] as const)('anonymous revoke cannot identify a %s client token', async (state) => {
  const tokens = await issueGrant()
  db.update(oauthClients).set(state === 'confidential'
    ? { secretHash: crypto.createHash('sha256').update('client-secret').digest('hex') }
    : { revokedAt: new Date().toISOString() }).where(eq(oauthClients.id, 'client-1')).run()
  for (const token of [tokens.access_token, tokens.refresh_token, 'unknown-token']) {
    const response = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({})
  }
  for (const token of db.select().from(oauthTokens).all()) expect(token.revokedAt).toBeNull()
})

test('grant revocation and replay preserve the first revocation and refresh consumption times', async () => {
  const original = await issueGrant()
  const rotated = (await refreshGrant(original.refresh_token)).json<TokenPair>()
  const originalHash = crypto.createHash('sha256').update(original.refresh_token).digest('hex')
  const consumed = db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, originalHash)).get()!
  expect(consumed.revokedAt).not.toBeNull()
  db.insert(apiKeys).values({
    id: 'delegated-key', name: 'Synthetic delegated key', keyHash: 'synthetic-key-hash', keyPrefix: 'cnry_test',
    scopes: ['read'], delegatedUserId: signedInUserId!, delegatedOAuthGrantId: consumed.grantId,
    createdAt: new Date().toISOString(),
  }).run()
  const firstRevokedAt = new Date(Date.now() + 1_000)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(firstRevokedAt)
  const first = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: rotated.refresh_token, client_id: 'client-1' } })
  expect(first.statusCode).toBe(200)
  vi.setSystemTime(new Date(firstRevokedAt.getTime() + 1_000))
  expect((await refreshGrant(original.refresh_token)).statusCode).toBe(400)
  expect((await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: rotated.refresh_token, client_id: 'client-1' } })).statusCode).toBe(200)
  const expected = firstRevokedAt.toISOString()
  expect(db.select().from(oauthGrants).where(eq(oauthGrants.id, consumed.grantId!)).get()?.revokedAt).toBe(expected)
  expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'delegated-key')).get()?.revokedAt).toBe(expected)
  for (const token of db.select().from(oauthTokens).all()) {
    expect(token.revokedAt, token.kind).toBe(token.tokenHash === originalHash ? consumed.revokedAt : expected)
  }
})


test.each(['expired access', 'consumed refresh'] as const)('revoking an %s token leaves its live successors usable', async (state) => {
  const original = await issueGrant()
  const successor = (await refreshGrant(original.refresh_token)).json<TokenPair>()
  const staleToken = state === 'expired access' ? original.access_token : original.refresh_token
  if (state === 'expired access') {
    db.update(oauthTokens).set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(oauthTokens.tokenHash, crypto.createHash('sha256').update(staleToken).digest('hex'))).run()
  }
  const response = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: staleToken, client_id: 'client-1' } })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({})
  expect(resolveOAuthAccessToken(db, successor.access_token, `${ISSUER}${RESOURCE_PATH}`)).not.toBeNull()
  expect((await refreshGrant(successor.refresh_token)).statusCode).toBe(200)
})

test.each(['user', 'client'] as const)('legacy adoption fails closed for a missing %s instead of creating an orphan grant', async (parent) => {
  const tokens = await issueGrant()
  db.$client.pragma('foreign_keys = OFF')
  db.update(oauthTokens).set({ grantId: null }).run()
  if (parent === 'user') db.delete(users).where(eq(users.id, signedInUserId!)).run()
  else db.delete(oauthClients).where(eq(oauthClients.id, 'client-1')).run()
  db.$client.pragma('foreign_keys = ON')
  const before = db.select().from(oauthGrants).all()
  expect(resolveOAuthAccessToken(db, tokens.access_token, `${ISSUER}${RESOURCE_PATH}`)).toBeNull()
  const refresh = await refreshGrant(tokens.refresh_token)
  expect(refresh.statusCode).toBe(400)
  expect(refresh.json().error).toBe(parent === 'client' ? 'invalid_client' : 'invalid_grant')
  const revoke = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: tokens.access_token } })
  expect(revoke.statusCode).toBe(200)
  expect(db.select().from(oauthGrants).all()).toEqual(before)
})
