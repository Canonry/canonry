import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createClient, migrate, oauthClients, oauthTokens, users } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { beforeEach, afterEach, expect, test } from 'vitest'
import { UserStatuses } from '@ainyc/canonry-contracts'

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
let app: ReturnType<typeof Fastify>
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
    resolveUser: () => (signedInUserId ? { id: signedInUserId, name: 'Sam', authVersion: db.select().from(users).where(eq(users.id, signedInUserId)).get()!.authVersion } : null),
    startSession: (id, _expectedAuthVersion) => { signedInUserId = id; return 'session=set' },
    credentials: createCredentialChecker({ db }),
  })
  return userId
}

beforeEach(async () => { await build() })
afterEach(async () => {
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

  const rotated = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refresh } })
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

  const second = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refresh } })
  expect(second.statusCode).toBe(200)
  expect(second.json().refresh_token).not.toBe(refresh)

  const replay = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refresh } })
  expect(replay.statusCode).toBe(400)
})

test('a suspended account cannot exchange an authorization code minted before suspension', async () => {
  const userId = signedInUserId!
  const code = await getCode()
  db.update(users).set({ status: UserStatuses.suspended }).where(eq(users.id, userId)).run()

  const exchange = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  expect(exchange.statusCode).toBe(400)
  expect(exchange.json().error).toBe('invalid_grant')
})

test('an authorization-version change invalidates OAuth access and refresh credentials', async () => {
  const userId = signedInUserId!
  const code = await getCode()
  const exchange = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  expect(exchange.statusCode).toBe(200)
  const { access_token: accessToken, refresh_token: refreshToken } = exchange.json() as {
    access_token: string
    refresh_token: string
  }

  const account = db.select().from(users).where(eq(users.id, userId)).get()!
  db.update(users).set({ authVersion: account.authVersion + 1 }).where(eq(users.id, userId)).run()

  expect(resolveOAuthAccessToken(db, accessToken, `${ISSUER}${RESOURCE_PATH}`)).toBeNull()
  const refresh = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'refresh_token', refresh_token: refreshToken },
  })
  expect(refresh.statusCode).toBe(400)
  expect(refresh.json().error).toBe('invalid_grant')
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


test('a new login cannot reuse consent from an older authorization version', async () => {
  const url = authorizeUrl()
  const page = await app.inject({ method: 'GET', url })
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!
  const account = db.select().from(users).where(eq(users.id, signedInUserId!)).get()!
  db.update(users).set({ authVersion: account.authVersion + 1 }).where(eq(users.id, account.id)).run()
  const response = await app.inject({
    method: 'POST', url: '/oauth/authorize/consent?' + url.split('?')[1],
    headers: FORM_HEADERS, payload: new URLSearchParams({ csrf, approve: 'yes' }).toString(),
  })
  expect(response.statusCode).toBe(400)
  expect(response.headers.location).toBeUndefined()
})
