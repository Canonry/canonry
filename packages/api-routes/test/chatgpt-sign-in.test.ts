/**
 * Sign in with ChatGPT, end to end against a fake OpenAI.
 *
 * The fake signs real RS256 ID tokens with a key generated here and serves
 * discovery, signing keys, the token endpoint, revocation and the plan's model
 * list. Every test drives the routes the way a browser does: start, follow
 * the redirect to "OpenAI", come back to the callback with the cookie the
 * start set.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  apiKeys,
  chatgptLoginTransactions,
  chatgptPlanConnections,
  createClient,
  migrate,
  userExternalIdentities,
  userInvitations,
  users,
  type DatabaseClient,
} from '@canonry/canonry-db'
import { CHATGPT_AERO_ERRORS, CHATGPT_ISSUER, LOGIN_FAILED_MESSAGE } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import {
  accountNameForEmail,
  ChatGptAccounts,
  ChatGptPlanError,
  decryptPlanTokens,
  encryptPlanTokens,
  EXTERNAL_SIGN_IN_PASSWORD_HASH,
  parseChatGptTokenKey,
  pickChatGptPlanModel,
  type ChatGptSignInSettings,
} from '../src/chatgpt-accounts.js'
import { CHATGPT_SIGN_IN_COOKIE_NAME, safeReturnTo } from '../src/chatgpt-routes.js'
import { renderSignInPage } from '../src/oauth-pages.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

// The admin account below pays one real scrypt derivation.
vi.setConfig({ testTimeout: 20_000 })

const ROOT_KEY = 'cnry_chatgpt_root'
const CLIENT_ID = 'oaiapp_test_client'
const ORIGIN = 'https://dash.example.com'
const HOST = 'dash.example.com'
const REDIRECT_URI = `${ORIGIN}/api/v1/auth/chatgpt/callback`
const TOKEN_KEY_HEX = 'a'.repeat(64)
const PLAN_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const otherKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function signIdToken(claims: Record<string, unknown>, opts: { kid?: string; key?: crypto.KeyObject; alg?: string } = {}): string {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), opts.key ?? privateKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

interface TokenReply {
  status?: number
  body: Record<string, unknown>
}

/** A stand-in for auth.openai.com and api.openai.com. */
function fakeOpenAi() {
  const state = {
    tokenRequests: [] as Array<{ body: URLSearchParams; authorization: string | null }>,
    revoked: [] as string[],
    revokeStatus: 200,
    tokenReply: null as ((body: URLSearchParams) => TokenReply) | null,
    models: { models: [
      { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
      { slug: 'gpt-internal', display_name: 'Hidden', visibility: 'hide' },
    ] } as unknown,
    modelsStatus: 200,
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
      return json(200, {
        issuer: CHATGPT_ISSUER,
        authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
        token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
        jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
        revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url === 'https://auth.openai.com/.well-known/jwks.json') return json(200, { keys: [JWK] })
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const body = new URLSearchParams(String(init?.body ?? ''))
      const headers = new Headers(init?.headers)
      state.tokenRequests.push({ body, authorization: headers.get('authorization') })
      const reply = state.tokenReply?.(body) ?? { status: 400, body: { error: 'invalid_grant' } }
      return json(reply.status ?? 200, reply.body)
    }
    if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') {
      state.revoked.push(new URLSearchParams(String(init?.body ?? '')).get('token') ?? '')
      return new Response(null, { status: state.revokeStatus })
    }
    if (url === 'https://api.openai.com/v1/models') return json(state.modelsStatus, state.models)
    return json(404, { error: 'unexpected url' })
  })
  return { state, fetch }
}

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let openai: ReturnType<typeof fakeOpenAi>
let settings: ChatGptSignInSettings
let clock: number
let accounts: ChatGptAccounts

function idClaims(nonce: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(clock / 1000)
  return {
    iss: CHATGPT_ISSUER,
    aud: CLIENT_ID,
    sub: 'user-sub-1',
    email: 'Jon.Doe@Cortland.example',
    email_verified: true,
    name: 'Jon Doe',
    nonce,
    iat: now,
    exp: now + 3600,
    ...overrides,
  }
}

function seedRootKey() {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'root',
    keyHash: hashApiKey(ROOT_KEY),
    keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  for (const raw of list) {
    const [pair] = raw.split(';')
    const eq = pair!.indexOf('=')
    if (pair!.slice(0, eq) === name) return decodeURIComponent(pair!.slice(eq + 1))
  }
  return null
}

async function invite(email: string, role: 'admin' | 'viewer' = 'viewer') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/users/invitations',
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    payload: { email, role },
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { id: string; status: string }
}

async function createPasswordAccount(name: string, role: 'admin' | 'viewer') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    payload: { name, password: 'a-long-enough-password', role },
  })
  expect(res.statusCode).toBe(201)
}

async function passwordSession(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { name, password: 'a-long-enough-password' },
  })
  expect(res.statusCode).toBe(200)
  return cookieValue(res.headers['set-cookie'], USER_SESSION_COOKIE_NAME)!
}

async function start(intent: 'login' | 'connect' = 'login', session?: string, returnTo?: string) {
  const query = new URLSearchParams({ intent, ...(returnTo ? { returnTo } : {}) })
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/chatgpt/start?${query}`,
    headers: { host: HOST, ...(session ? { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` } : {}) },
  })
  expect(res.statusCode).toBe(302)
  const location = new URL(String(res.headers.location))
  return {
    res,
    location,
    state: location.searchParams.get('state')!,
    nonce: location.searchParams.get('nonce')!,
    binding: cookieValue(res.headers['set-cookie'], CHATGPT_SIGN_IN_COOKIE_NAME),
  }
}

async function callback(started: Awaited<ReturnType<typeof start>>, opts: {
  claims?: Record<string, unknown>
  scope?: string
  binding?: string | null
  error?: string
  idToken?: string
  session?: string
} = {}) {
  openai.state.tokenReply = () => ({
    body: {
      access_token: 'plan-access-1',
      refresh_token: 'plan-refresh-1',
      id_token: opts.idToken ?? signIdToken(idClaims(started.nonce, opts.claims)),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: opts.scope ?? PLAN_SCOPE,
    },
  })
  const query = new URLSearchParams({ state: started.state, ...(opts.error ? { error: opts.error } : { code: 'auth-code' }) })
  const binding = opts.binding === undefined ? started.binding : opts.binding
  const cookies = [
    ...(binding ? [`${CHATGPT_SIGN_IN_COOKIE_NAME}=${binding}`] : []),
    ...(opts.session ? [`${USER_SESSION_COOKIE_NAME}=${opts.session}`] : []),
  ]
  return app.inject({
    method: 'GET',
    url: `/api/v1/auth/chatgpt/callback?${query}`,
    headers: { host: HOST, ...(cookies.length ? { cookie: cookies.join('; ') } : {}) },
  })
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-sign-in-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedRootKey()
  openai = fakeOpenAi()
  clock = Date.parse('2026-11-11T12:00:00.000Z')
  settings = {
    clientId: CLIENT_ID,
    signIn: true,
    planUsage: true,
    tokenKey: parseChatGptTokenKey(TOKEN_KEY_HEX),
    redirectUri: REDIRECT_URI,
  }
  accounts = new ChatGptAccounts({ db, settings: () => settings, fetch: openai.fetch, now: () => clock })
  app = Fastify()
  await app.register(apiRoutes, { db, chatgptAccounts: accounts, dashboardPath: '/' })
  await app.ready()
  await createPasswordAccount('arber', 'admin')
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('start', () => {
  test('redirects to OpenAI with PKCE, nonce, plan scopes and the registered callback', async () => {
    const started = await start()
    expect(started.location.origin + started.location.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    const params = started.location.searchParams
    expect(params.get('client_id')).toBe(CLIENT_ID)
    expect(params.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(params.get('response_type')).toBe('code')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('scope')).toBe(PLAN_SCOPE)
    expect(params.get('resource')).toBe('https://api.openai.com/v1')
    expect(params.get('prompt')).toBeNull()
    // The binding cookie is HttpOnly, Lax, Secure on https, scoped to these routes.
    const raw = String([started.res.headers['set-cookie']].flat().find(value => String(value).startsWith(CHATGPT_SIGN_IN_COOKIE_NAME)))
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Lax')
    expect(raw).toContain('Path=/api/v1/auth/chatgpt/')
    // Only digests reach the database: neither the state nor the binding secret.
    const row = db.select().from(chatgptLoginTransactions).get()!
    expect(row.stateHash).not.toBe(started.state)
    expect(JSON.stringify(row)).not.toContain(started.binding!.split('.')[0]!)
    // The PKCE challenge is the S256 of the verifier carried in the cookie.
    const verifier = started.binding!.split('.')[1]!
    expect(params.get('code_challenge')).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'))
  })

  test('status reports a required plan only while plan usage is on', async () => {
    settings = { ...settings, requirePlan: true }
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/chatgpt/status' })).json()).toMatchObject({ planRequired: true, account: null })
    settings = { ...settings, planUsage: false }
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/chatgpt/status' })).json()).toMatchObject({ planRequired: false })
  })

  test('identity scopes only when plan usage is off', async () => {
    settings = { ...settings, planUsage: false }
    const started = await start()
    expect(started.location.searchParams.get('scope')).toBe('openid profile email')
    expect(started.location.searchParams.get('resource')).toBeNull()
  })

  test('returns to the dashboard with an error when sign-in is off', async () => {
    settings = { ...settings, signIn: false }
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/chatgpt/start?intent=login' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/?chatgpt_error=disabled')
  })

  test('connect needs a signed-in person and asks for consent again', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/auth/chatgpt/start?intent=connect' })
    expect(anonymous.headers.location).toBe('/?chatgpt_error=expired')
    const session = await passwordSession('arber')
    const started = await start('connect', session)
    expect(started.location.searchParams.get('prompt')).toBe('consent')
  })
})

describe('callback: invitations', () => {
  test('an invited, verified email creates the account, links ChatGPT, stores the plan and signs in', async () => {
    const invitation = await invite('jon.doe@cortland.example')
    const started = await start()
    const res = await callback(started)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    const session = cookieValue(res.headers['set-cookie'], USER_SESSION_COOKIE_NAME)
    expect(session).toBeTruthy()
    // The binding cookie is cleared whatever the outcome.
    expect(cookieValue(res.headers['set-cookie'], CHATGPT_SIGN_IN_COOKIE_NAME)).toBe('')

    const account = db.select().from(users).where(eq(users.name, 'jon.doe')).get()!
    expect(account.role).toBe('viewer')
    expect(account.passwordHash).toBe(EXTERNAL_SIGN_IN_PASSWORD_HASH)
    const identity = db.select().from(userExternalIdentities).where(eq(userExternalIdentities.userId, account.id)).get()!
    expect(identity).toMatchObject({ issuer: CHATGPT_ISSUER, clientId: CLIENT_ID, subject: 'user-sub-1', provider: 'chatgpt' })
    expect(db.select().from(userInvitations).where(eq(userInvitations.id, invitation.id)).get()!.acceptedUserId).toBe(account.id)

    // Plan tokens are stored encrypted, bound to their row.
    const connection = db.select().from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, account.id)).get()!
    expect(connection.tokens).not.toContain('plan-access-1')
    expect(connection.tokens).not.toContain('plan-refresh-1')
    expect(decryptPlanTokens(settings.tokenKey!, connection.id, account.id, connection.tokens)).toEqual({
      accessToken: 'plan-access-1', refreshToken: 'plan-refresh-1',
    })

    // The code exchange used PKCE and the resource, as a public client.
    const exchange = openai.state.tokenRequests[0]!
    expect(exchange.body.get('grant_type')).toBe('authorization_code')
    expect(exchange.body.get('client_id')).toBe(CLIENT_ID)
    expect(exchange.body.get('code_verifier')).toBe(started.binding!.split('.')[1])
    expect(exchange.body.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(exchange.body.get('resource')).toBe('https://api.openai.com/v1')
    expect(exchange.authorization).toBeNull()

    const sessionRes = await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` } })
    expect(sessionRes.json()).toEqual({ authRequired: true, user: { name: 'jon.doe', role: 'viewer' }, signInMethods: { chatgpt: true } })

    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/chatgpt/status', headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` } })
    expect(status.json()).toMatchObject({
      signInEnabled: true,
      planUsageEnabled: true,
      planRequired: false,
      account: { linked: true, email: 'Jon.Doe@Cortland.example', plan: { status: 'connected', modelId: null } },
    })
  })

  test('a second sign-in finds the account by its ChatGPT identity, not its email', async () => {
    await invite('jon.doe@cortland.example')
    await callback(await start())
    // Same subject, different email on the ChatGPT account: still the same person.
    const res = await callback(await start(), { claims: { email: 'renamed@elsewhere.example' } })
    expect(res.headers.location).toBe('/')
    expect(db.select().from(users).all()).toHaveLength(2)
  })

  test('confidential clients authenticate with Basic and send no client_id in the body', async () => {
    settings = { ...settings, clientSecret: 's3cret' }
    await invite('jon.doe@cortland.example')
    await callback(await start())
    const exchange = openai.state.tokenRequests[0]!
    expect(exchange.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:s3cret`).toString('base64')}`)
    expect(exchange.body.get('client_id')).toBeNull()
  })

  test('no invitation, no account', async () => {
    const res = await callback(await start())
    expect(res.headers.location).toBe('/?chatgpt_error=not-invited')
    expect(cookieValue(res.headers['set-cookie'], USER_SESSION_COOKIE_NAME)).toBeNull()
    expect(db.select().from(users).all()).toHaveLength(1)
  })

  test('an unverified email is not matched to an invitation', async () => {
    await invite('jon.doe@cortland.example')
    const res = await callback(await start(), { claims: { email_verified: false } })
    expect(res.headers.location).toBe('/?chatgpt_error=unverified-email')
    expect(db.select().from(users).all()).toHaveLength(1)
  })

  test('revoked and expired invitations admit no one', async () => {
    const revoked = await invite('jon.doe@cortland.example')
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/users/invitations/${revoked.id}`, headers: { authorization: `Bearer ${ROOT_KEY}` } })
    expect(del.statusCode).toBe(200)
    expect((await callback(await start())).headers.location).toBe('/?chatgpt_error=not-invited')

    await invite('jon.doe@cortland.example')
    clock += 15 * 24 * 60 * 60 * 1000
    expect((await callback(await start())).headers.location).toBe('/?chatgpt_error=not-invited')
  })

  test('an invitation is used once', async () => {
    await invite('jon.doe@cortland.example')
    await callback(await start())
    // A different ChatGPT account with the same verified email cannot reuse it.
    const res = await callback(await start(), { claims: { sub: 'someone-else' } })
    expect(res.headers.location).toBe('/?chatgpt_error=not-invited')
  })

  test('the name is made unique when the email local part is taken', async () => {
    await createPasswordAccount('jon.doe', 'viewer')
    await invite('jon.doe@cortland.example')
    await callback(await start())
    expect(db.select().from(users).where(eq(users.name, 'jon.doe-2')).get()?.role).toBe('viewer')
  })

  test('a ChatGPT-only account cannot be used with a password, and looks like an unknown name', async () => {
    await invite('jon.doe@cortland.example')
    await callback(await start())
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { name: 'jon.doe', password: EXTERNAL_SIGN_IN_PASSWORD_HASH },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.message).toBe(LOGIN_FAILED_MESSAGE)
  })
})

describe('callback: refusals', () => {
  test('a callback in another browser is refused without spending the real sign-in', async () => {
    await invite('jon.doe@cortland.example')
    const started = await start()
    expect((await callback(started, { binding: null })).headers.location).toBe('/?chatgpt_error=expired')
    expect(openai.state.tokenRequests).toHaveLength(0)
    // Whoever learned the state could not void it: the browser that started it still finishes.
    expect((await callback(started)).headers.location).toBe('/')
  })

  test('a binding cookie from a different sign-in is refused', async () => {
    await invite('jon.doe@cortland.example')
    const mine = await start()
    const theirs = await start()
    expect((await callback(mine, { binding: theirs.binding })).headers.location).toBe('/?chatgpt_error=expired')
  })

  test('a write the checks could not foresee redirects with failed, not a server error, and revokes the token', async () => {
    await invite('jon.doe@cortland.example')
    const started = await start()
    const real = db.transaction.bind(db)
    let calls = 0
    // The first transaction claims the sign-in; fail the second, the account write.
    vi.spyOn(db, 'transaction').mockImplementation(((fn: Parameters<typeof db.transaction>[0]) => {
      calls += 1
      if (calls === 2) throw new Error('UNIQUE constraint failed: user_external_identities.issuer')
      return real(fn)
    }) as typeof db.transaction)
    const res = await callback(started)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/?chatgpt_error=failed')
    await vi.waitFor(() => expect(openai.state.revoked).toContain('plan-refresh-1'))
  })

  test('a state can be used once', async () => {
    await invite('jon.doe@cortland.example')
    const started = await start()
    expect((await callback(started)).headers.location).toBe('/')
    expect((await callback(started)).headers.location).toBe('/?chatgpt_error=expired')
  })

  test('a sign-in left too long expires', async () => {
    await invite('jon.doe@cortland.example')
    const started = await start()
    clock += 11 * 60 * 1000
    expect((await callback(started)).headers.location).toBe('/?chatgpt_error=expired')
  })

  test('declining at OpenAI', async () => {
    const res = await callback(await start(), { error: 'access_denied' })
    expect(res.headers.location).toBe('/?chatgpt_error=denied')
  })

  test.each([
    ['another nonce', { nonce: 'not-this-sign-in' }],
    ['another audience', { aud: 'oaiapp_someone_else' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['expired', { exp: Math.floor(Date.parse('2026-11-11T10:00:00.000Z') / 1000) }],
    ['no subject', { sub: '' }],
    ['several audiences without azp', { aud: [CLIENT_ID, 'other'] }],
  ])('an ID token with %s is refused', async (_label, claims) => {
    await invite('jon.doe@cortland.example')
    const res = await callback(await start(), { claims })
    expect(res.headers.location).toBe('/?chatgpt_error=failed')
    expect(db.select().from(users).all()).toHaveLength(1)
  })

  test('an ID token signed by another key, or with another algorithm, is refused', async () => {
    await invite('jon.doe@cortland.example')
    let started = await start()
    expect((await callback(started, { idToken: signIdToken(idClaims(started.nonce), { key: otherKeys.privateKey }) })).headers.location)
      .toBe('/?chatgpt_error=failed')
    started = await start()
    expect((await callback(started, { idToken: signIdToken(idClaims(started.nonce), { kid: 'unknown' }) })).headers.location)
      .toBe('/?chatgpt_error=failed')
    started = await start()
    const header = b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))
    const unsigned = `${header}.${b64url(JSON.stringify(idClaims(started.nonce)))}.x`
    expect((await callback(started, { idToken: unsigned })).headers.location).toBe('/?chatgpt_error=failed')
  })

  test('a return path outside the dashboard is ignored', async () => {
    expect(safeReturnTo('https://evil.example/x', '/')).toBeNull()
    expect(safeReturnTo('//evil.example/x', '/')).toBeNull()
    expect(safeReturnTo('/\\evil.example', '/')).toBeNull()
    expect(safeReturnTo('/projects/acme?tab=aero', '/')).toBe('/projects/acme?tab=aero')
    expect(safeReturnTo('/other/', '/canonry/')).toBeNull()
    await invite('jon.doe@cortland.example')
    const res = await callback(await start('login', undefined, 'https://evil.example/'))
    expect(res.headers.location).toBe('/')
  })
})

describe('plan grant', () => {
  test('declining plan usage still signs in, keeps no grant, and revokes the refresh token', async () => {
    await invite('jon.doe@cortland.example')
    const res = await callback(await start(), { scope: 'openid profile email offline_access' })
    expect(res.headers.location).toBe('/')
    expect(db.select().from(chatgptPlanConnections).all()).toHaveLength(0)
    await vi.waitFor(() => expect(openai.state.revoked).toContain('plan-refresh-1'))
  })

  test('an omitted scope list grants nothing', async () => {
    await invite('jon.doe@cortland.example')
    openai.state.tokenReply = null
    const started = await start()
    openai.state.tokenReply = () => ({
      body: {
        access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600,
        id_token: signIdToken(idClaims(started.nonce)),
      },
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/chatgpt/callback?code=c&state=${started.state}`,
      headers: { cookie: `${CHATGPT_SIGN_IN_COOKIE_NAME}=${started.binding}` },
    })
    expect(res.headers.location).toBe('/')
    expect(db.select().from(chatgptPlanConnections).all()).toHaveLength(0)
  })

  test('connect links an existing password account and stores its plan', async () => {
    const session = await passwordSession('arber')
    const started = await start('connect', session, '/settings')
    const res = await callback(started, { claims: { sub: 'arber-sub', email: 'arber@example.com' } })
    expect(res.headers.location).toBe('/settings?chatgpt=connected')
    const admin = db.select().from(users).where(eq(users.name, 'arber')).get()!
    expect(db.select().from(userExternalIdentities).where(eq(userExternalIdentities.userId, admin.id)).get()?.subject).toBe('arber-sub')
    expect(db.select().from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, admin.id)).get()?.status).toBe('connected')
    // The password still works.
    await passwordSession('arber')
  })

  test('a ChatGPT account linked to someone else cannot be connected again', async () => {
    await invite('jon.doe@cortland.example')
    await callback(await start())
    const session = await passwordSession('arber')
    const res = await callback(await start('connect', session))
    expect(res.headers.location).toBe('/?chatgpt_error=already-linked')
  })

  test('disconnect deletes the grant here, revokes it at OpenAI, and keeps the link', async () => {
    await invite('jon.doe@cortland.example')
    const signedIn = await callback(await start())
    const session = cookieValue(signedIn.headers['set-cookie'], USER_SESSION_COOKIE_NAME)!

    const crossSite = await app.inject({
      method: 'POST', url: '/api/v1/auth/chatgpt/disconnect',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}`, origin: 'https://evil.example', host: HOST },
    })
    expect(crossSite.statusCode).toBe(403)
    expect(db.select().from(chatgptPlanConnections).all()).toHaveLength(1)

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/chatgpt/disconnect',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}`, origin: ORIGIN, host: HOST },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ disconnected: true, revoked: true })
    expect(db.select().from(chatgptPlanConnections).all()).toHaveLength(0)
    expect(db.select().from(userExternalIdentities).all()).toHaveLength(1)
    expect(openai.state.revoked).toContain('plan-refresh-1')
  })

  test('models lists only selectable models, and the choice must be one of them', async () => {
    await invite('jon.doe@cortland.example')
    const signedIn = await callback(await start())
    const session = cookieValue(signedIn.headers['set-cookie'], USER_SESSION_COOKIE_NAME)!
    const headers = { cookie: `${USER_SESSION_COOKIE_NAME}=${session}`, origin: ORIGIN, host: HOST }
    const list = await app.inject({ method: 'GET', url: '/api/v1/auth/chatgpt/models', headers })
    // With no choice yet, `selected` is what the next answer uses: the plan's
    // first model, since this harness names no install model.
    expect(list.json()).toEqual({
      models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
      selected: 'gpt-6-luna',
    })
    const hidden = await app.inject({ method: 'PUT', url: '/api/v1/auth/chatgpt/model', headers, payload: { modelId: 'gpt-internal' } })
    expect(hidden.statusCode).toBe(403)
    const chosen = await app.inject({ method: 'PUT', url: '/api/v1/auth/chatgpt/model', headers, payload: { modelId: 'gpt-6.1-sol' } })
    expect(chosen.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/chatgpt/models', headers })).json().selected).toBe('gpt-6.1-sol')
  })

  test('an expiring token is refreshed once for concurrent callers, and the rotation is stored', async () => {
    await invite('jon.doe@cortland.example')
    await callback(await start())
    const account = db.select().from(users).where(eq(users.name, 'jon.doe')).get()!
    clock += 58 * 60 * 1000
    let refreshes = 0
    openai.state.tokenReply = (body) => {
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('plan-refresh-1')
      expect(body.get('scope')).toBeNull()
      refreshes++
      return { body: { access_token: 'plan-access-2', refresh_token: 'plan-refresh-2', token_type: 'Bearer', expires_in: 3600 } }
    }
    const [a, b] = await Promise.all([accounts.planAccess(account.id), accounts.planAccess(account.id)])
    expect(refreshes).toBe(1)
    expect(a.accessToken).toBe('plan-access-2')
    expect(b.accessToken).toBe('plan-access-2')
    const row = db.select().from(chatgptPlanConnections).get()!
    expect(decryptPlanTokens(settings.tokenKey!, row.id, account.id, row.tokens)).toEqual({ accessToken: 'plan-access-2', refreshToken: 'plan-refresh-2' })
  })

  test('a refused refresh asks the person to connect again, and never falls back', async () => {
    await invite('jon.doe@cortland.example')
    await callback(await start())
    const account = db.select().from(users).where(eq(users.name, 'jon.doe')).get()!
    clock += 59 * 60 * 1000
    openai.state.tokenReply = () => ({ status: 400, body: { error: 'refresh_token_reused' } })
    await expect(accounts.planAccess(account.id)).rejects.toMatchObject({ kind: 'reconnect', message: CHATGPT_AERO_ERRORS.reconnect })
    expect(db.select().from(chatgptPlanConnections).get()!.status).toBe('reconnect-required')
  })

  test('OpenAI being unavailable does not end the grant', async () => {
    await invite('jon.doe@cortland.example')
    await callback(await start())
    const account = db.select().from(users).where(eq(users.name, 'jon.doe')).get()!
    clock += 59 * 60 * 1000
    openai.state.tokenReply = () => ({ status: 503, body: {} })
    await expect(accounts.planAccess(account.id)).rejects.toBeInstanceOf(ChatGptPlanError)
    expect(db.select().from(chatgptPlanConnections).get()!.status).toBe('connected')
  })

  test('tokens encrypted for one row do not open on another, or under another key', async () => {
    const key = parseChatGptTokenKey(TOKEN_KEY_HEX)!
    const sealed = encryptPlanTokens(key, 'conn-1', 'user-1', { accessToken: 'a', refreshToken: 'r' })
    expect(decryptPlanTokens(key, 'conn-1', 'user-1', sealed)).toEqual({ accessToken: 'a', refreshToken: 'r' })
    expect(decryptPlanTokens(key, 'conn-2', 'user-1', sealed)).toBeNull()
    expect(decryptPlanTokens(key, 'conn-1', 'user-2', sealed)).toBeNull()
    expect(decryptPlanTokens(parseChatGptTokenKey('b'.repeat(64))!, 'conn-1', 'user-1', sealed)).toBeNull()
  })
})

describe('around the edges', () => {
  test('deleting an account withdraws its plan grant at OpenAI', async () => {
    await invite('jon.doe@cortland.example')
    await callback(await start())
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/users/jon.doe', headers: { authorization: `Bearer ${ROOT_KEY}` } })
    expect(res.statusCode).toBe(200)
    expect(openai.state.revoked).toContain('plan-refresh-1')
    expect(db.select().from(chatgptPlanConnections).all()).toHaveLength(0)
  })

  test('behind a declared proxy each caller has its own sign-in budget', async () => {
    const proxied = Fastify({ trustProxy: true })
    await proxied.register(apiRoutes, { db, chatgptAccounts: accounts, dashboardPath: '/', trustProxyConfigured: true })
    await proxied.ready()
    try {
      const startFrom = (address: string) => proxied.inject({
        method: 'GET', url: '/api/v1/auth/chatgpt/start?intent=login', headers: { 'x-forwarded-for': address },
      })
      for (let i = 0; i < 20; i++) expect((await startFrom('203.0.113.7')).statusCode).toBe(302)
      expect((await startFrom('203.0.113.7')).statusCode).toBe(429)
      // Someone else behind the same proxy is unaffected.
      expect((await startFrom('198.51.100.4')).statusCode).toBe(302)
    } finally {
      await proxied.close()
    }
  })

  test('the MCP consent page offers ChatGPT first, returning to the same request', () => {
    const html = renderSignInPage({
      action: '/oauth/authorize?client_id=c&state=s',
      error: null,
      chatgptUrl: '/api/v1/auth/chatgpt/start?intent=login&returnTo=%2Foauth%2Fauthorize%3Fclient_id%3Dc',
    })
    expect(html).toContain('data-oai-siwc-button href="/api/v1/auth/chatgpt/start?intent=login&amp;returnTo=%2Foauth%2Fauthorize%3Fclient_id%3Dc"')
    expect(html).toContain('<button class="secondary" type="submit">Sign in</button>')
    expect(html).not.toContain('autofocus')
    const plain = renderSignInPage({ action: '/oauth/authorize', error: null })
    expect(plain).not.toContain('Continue with ChatGPT')
    expect(plain).toContain('<button class="primary" type="submit">Sign in</button>')
  })

  test('a long consent URL survives as a return path', () => {
    const consent = `/oauth/authorize?${'x'.repeat(900)}`
    expect(safeReturnTo(consent, '/')).toBe(consent)
    expect(safeReturnTo(`/${'x'.repeat(2100)}`, '/')).toBeNull()
  })
})

describe('invitations', () => {
  test('the first account must be an administrator', async () => {
    db.delete(users).run()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/users/invitations',
      headers: { authorization: `Bearer ${ROOT_KEY}` },
      payload: { email: 'jon@cortland.example', role: 'viewer' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('inviting an address again replaces the pending invitation', async () => {
    const first = await invite('jon@cortland.example', 'viewer')
    const second = await invite('JON@cortland.example', 'admin')
    const list = await app.inject({ method: 'GET', url: '/api/v1/users/invitations', headers: { authorization: `Bearer ${ROOT_KEY}` } })
    const byId = new Map((list.json().invitations as Array<{ id: string; status: string; role: string }>).map(row => [row.id, row]))
    expect(byId.get(first.id)?.status).toBe('revoked')
    expect(byId.get(second.id)).toMatchObject({ status: 'pending', role: 'admin' })
  })

  test('a viewer cannot invite', async () => {
    await createPasswordAccount('viewer1', 'viewer')
    const session = await passwordSession('viewer1')
    const res = await app.inject({
      method: 'POST', url: '/api/v1/users/invitations',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}`, origin: ORIGIN, host: HOST },
      payload: { email: 'x@cortland.example', role: 'viewer' },
    })
    expect(res.statusCode).toBe(403)
  })
})

test('the plan model is the person\'s choice, then the install\'s model, then the plan\'s first', () => {
  const models = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  expect(pickChatGptPlanModel(models, 'b', 'a')).toBe('b')
  expect(pickChatGptPlanModel(models, 'gone', 'b')).toBe('b')
  expect(pickChatGptPlanModel(models, null, 'not-listed')).toBe('a')
  expect(pickChatGptPlanModel([], 'b', 'a')).toBeNull()
})

test('account names come from the email and stay valid', () => {
  const none = () => false
  expect(accountNameForEmail('Jon.Doe@x.com', none)).toBe('jon.doe')
  expect(accountNameForEmail('..weird+tag@x.com', none)).toBe('weird-tag')
  expect(accountNameForEmail('@x.com', none)).toBe('chatgpt-user')
  expect(accountNameForEmail('jon@x.com', name => name === 'jon')).toBe('jon-2')
})
