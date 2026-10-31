/**
 * The shared dashboard password and named accounts cannot both be a way in.
 *
 * The shared password mints a session bound to the install's root key — full
 * access to everything. Left live alongside named accounts, one shared secret
 * would hand every holder the authority the roles were created to separate.
 * So the moment the first account exists, those routes step aside and say why.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, describe } from 'vitest'
import { eq } from 'drizzle-orm'
import { apiKeys, createClient, migrate, oauthClients, users, userSessions, type DatabaseClient } from '@canonry/canonry-db'
import { createUserSession, hashUserPassword, USER_SESSION_COOKIE_NAME } from '@canonry/canonry-api-routes'
import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { handoffTarget } from './oauth-handoff.js'

let tmpDir: string
let db: DatabaseClient
let app: Awaited<ReturnType<typeof createServer>>
let rawKey: string

async function bootServer(publicUrl?: string, options: { basePath?: string; assetsDir?: string; mcpGateway?: CanonryConfig['mcpGateway'] } = {}) {
  return createServer({
    config: {
      apiUrl: 'http://localhost:4100',
      database: path.join(tmpDir, 'test.db'),
      apiKey: rawKey,
      geminiApiKey: 'test-key',
      ...(publicUrl ? { publicUrl } : {}),
      ...(options.basePath ? { basePath: options.basePath } : {}),
      ...(options.mcpGateway ? { mcpGateway: options.mcpGateway } : {}),
    },
    db,
    logger: false,
    ...(options.assetsDir ? { assetsDir: options.assetsDir } : {}),
  })
}

/**
 * The Origin a browser sends with a form POST, per the Fetch standard's
 * "serializing a request origin": under `no-referrer` it is `null`, even when
 * the page posts to itself.
 */
function browserFormOrigin(referrerPolicy: unknown, pageOrigin: string, actionOrigin: string): string {
  const policy = String(referrerPolicy ?? '').split(',').map(token => token.trim()).filter(Boolean).at(-1)
    ?? 'strict-origin-when-cross-origin'
  switch (policy) {
    case 'no-referrer':
      return 'null'
    case 'same-origin':
      return pageOrigin === actionOrigin ? pageOrigin : 'null'
    case 'no-referrer-when-downgrade':
    case 'strict-origin':
    case 'strict-origin-when-cross-origin':
      return pageOrigin.startsWith('https:') && !actionOrigin.startsWith('https:') ? 'null' : pageOrigin
    default:
      return pageOrigin
  }
}

function addAccount(name: string, role: 'admin' | 'viewer') {
  db.insert(users).values({
    id: crypto.randomUUID(),
    name,
    nameKey: name.toLowerCase(),
    // A real digest is irrelevant here: these tests never sign in, they only
    // check that the OLD way in closes once an account exists.
    passwordHash: 'scrypt$1$AAAA$AAAA',
    role,
    createdAt: new Date().toISOString(),
  }).run()
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-named-accounts-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'root',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()
  app = await bootServer()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('shared dashboard password alongside named accounts', () => {
  it('still works exactly as before while there are no accounts', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/session' })
    expect(JSON.parse(before.body)).toEqual({ authenticated: false, setupRequired: true })

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'a-perfectly-fine-shared-password' },
    })
    expect(setup.statusCode).toBe(200)
    expect(JSON.parse(setup.body)).toEqual({ authenticated: true })
  })

  it('steps aside once the first account exists, and says what to do instead', async () => {
    addAccount('owner', 'admin')

    const status = await app.inject({ method: 'GET', url: '/api/v1/session' })
    expect(JSON.parse(status.body)).toEqual({ authenticated: false, setupRequired: false })

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'a-perfectly-fine-shared-password' },
    })
    expect(setup.statusCode).toBe(403)
    expect(JSON.parse(setup.body).error.message).toBe(
      'This install uses named accounts. Sign in with your name and password.',
    )

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { password: 'a-perfectly-fine-shared-password' },
    })
    expect(login.statusCode).toBe(403)
  })

  it('reports the new sign-in state on the account-aware route', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/auth/session' })
    expect(JSON.parse(before.body)).toEqual({ authRequired: false, user: null })

    addAccount('owner', 'admin')

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/session' })
    expect(JSON.parse(after.body)).toEqual({ authRequired: true, user: null })
  })

  it('leaves the API key working throughout', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(before.statusCode).toBe(200)

    addAccount('owner', 'admin')

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(after.statusCode).toBe(200)
  })
})

describe('the sign-in cookie on a real server', () => {
  it('is marked Secure when a proxy in front of it terminated TLS', async () => {
    // The config flag sees no https public URL on this fixture, which is
    // exactly the deployment shape that must NOT end up with an insecure
    // cookie: a plain-http bind behind a TLS-terminating proxy.
    db.insert(users).values({
      id: crypto.randomUUID(),
      name: 'owner',
      nameKey: 'owner',
      passwordHash: await hashUserPassword('a-long-enough-admin-password'),
      role: 'admin',
      createdAt: new Date().toISOString(),
    }).run()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-proto': 'https', origin: 'http://localhost:4100', host: 'localhost:4100' },
      payload: { name: 'owner', password: 'a-long-enough-admin-password' },
    })

    expect(res.statusCode).toBe(200)
    expect(String(res.headers['set-cookie'])).toContain('Secure')
  })

  it.each(['GET', 'POST'] as const)('renews the browser cookie when %s OAuth consent renews the session', async (method) => {
    await app.close()
    app = await bootServer('https://canonry.test')
    const password = 'a-long-enough-admin-password'
    const userId = crypto.randomUUID()
    db.insert(users).values({
      id: userId,
      name: 'owner',
      nameKey: 'owner',
      passwordHash: await hashUserPassword(password),
      role: 'admin',
      createdAt: new Date().toISOString(),
    }).run()
    const login = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { name: 'owner', password },
    })
    expect(login.statusCode).toBe(200)
    const cookie = String(login.headers['set-cookie']).split(';')[0]!
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    db.insert(oauthClients).values({
      id: 'desktop', name: 'Desktop', redirectUris: ['https://client.example/callback'],
      createdAt: new Date().toISOString(),
    }).run()
    const query = new URLSearchParams({
      response_type: 'code', client_id: 'desktop', redirect_uri: 'https://client.example/callback',
      code_challenge: crypto.createHash('sha256').update('a'.repeat(64)).digest('base64url'),
      code_challenge_method: 'S256', scope: 'read',
    }).toString()
    const headers = { cookie, host: 'canonry.test', origin: 'https://canonry.test', 'x-forwarded-proto': 'https' }
    let csrf: string | undefined
    if (method === 'POST') {
      const page = await app.inject({ method: 'GET', url: `/oauth/authorize?${query}`, headers })
      expect(page.statusCode).toBe(200)
      csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1]
      expect(csrf).toBeTruthy()
    }
    const nearlyDone = new Date(Date.now() + 60_000).toISOString()
    db.update(userSessions).set({ expiresAt: nearlyDone }).where(eq(userSessions.tokenHash, tokenHash)).run()

    const response = await app.inject(method === 'GET'
      ? { method, url: `/oauth/authorize?${query}`, headers }
      : {
          method, url: `/oauth/authorize/consent?${query}`,
          headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams({ csrf: csrf!, approve: 'yes' }).toString(),
        })

    expect(response.statusCode).toBe(200)
    expect(String(response.headers['set-cookie'])).toContain(`${USER_SESSION_COOKIE_NAME}=${token}`)
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Max-Age=43200', 'Secure']) {
      expect(String(response.headers['set-cookie'])).toContain(attribute)
    }
    expect(Date.parse(db.select().from(userSessions).where(eq(userSessions.tokenHash, tokenHash)).get()!.expiresAt))
      .toBeGreaterThan(Date.parse(nearlyDone))
  })
})

describe('OAuth sign-in from a browser', () => {
  const browser = { host: 'canonry.test', 'x-forwarded-proto': 'https' }

  function authorizeQuery(clientId: string, redirectUri: string, state: string): string {
    return new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      code_challenge: crypto.createHash('sha256').update('a'.repeat(64)).digest('base64url'),
      code_challenge_method: 'S256', scope: 'read', state,
    }).toString()
  }

  /** Registers a desktop client and returns an authorize query for it. */
  function registeredClientQuery(state: string): string {
    db.insert(oauthClients).values({
      id: 'desktop', name: 'Desktop', redirectUris: ['https://client.example/callback'],
      createdAt: new Date().toISOString(),
    }).run()
    return authorizeQuery('desktop', 'https://client.example/callback', state)
  }

  it('signs in and approves with the Origin a browser sends from the gate pages', async () => {
    // 2026-10-29: the gate pages were served with no-referrer, so browsers posted
    // their forms with `Origin: null` and the server refused the first real sign-in.
    await app.close()
    app = await bootServer('https://canonry.test')
    const password = 'a-long-enough-admin-password'
    db.insert(users).values({
      id: crypto.randomUUID(), name: 'owner', nameKey: 'owner',
      passwordHash: await hashUserPassword(password), role: 'admin', createdAt: new Date().toISOString(),
    }).run()
    const query = registeredClientQuery('browser-state')
    const site = 'https://canonry.test'
    const submit = (page: { headers: Record<string, unknown>; body: string }, fields: Record<string, string>, cookie?: string) => {
      const action = /<form method="post" action="([^"]+)"/.exec(page.body)?.[1]?.replaceAll('&amp;', '&')
      if (!action) throw new Error('The gate page has no form to submit')
      return app.inject({
        method: 'POST', url: action,
        headers: {
          ...browser, ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded',
          origin: browserFormOrigin(page.headers['referrer-policy'], site, new URL(action, site).origin),
        },
        payload: new URLSearchParams(fields).toString(),
      })
    }

    const signInPage = await app.inject({ method: 'GET', url: `/oauth/authorize?${query}`, headers: browser })
    expect(signInPage.statusCode).toBe(200)
    const signedIn = await submit(signInPage, { name: 'owner', password })
    expect(signedIn.statusCode).toBe(302)
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!

    const consentPage = await app.inject({ method: 'GET', url: `/oauth/authorize?${query}`, headers: { ...browser, cookie } })
    expect(consentPage.statusCode).toBe(200)
    const csrf = /name="csrf" value="([^"]+)"/.exec(consentPage.body)?.[1]
    if (!csrf) throw new Error('The consent page has no CSRF value')
    const approved = await submit(consentPage, { csrf, approve: 'yes' }, cookie)
    expect(approved.statusCode).toBe(200)
    const callback = handoffTarget(approved.body)
    expect(`${callback.origin}${callback.pathname}`).toBe('https://client.example/callback')
    expect(callback.searchParams.get('code')).toMatch(/\S/)
    expect(callback.searchParams.get('state')).toBe('browser-state')
  })

  it('asks for consent without calling the gateway client named in config unverified', async () => {
    // Onboarding registers the gateway through open registration, then the
    // operator names that client in config and restarts the instance.
    await app.close()
    app = await bootServer('https://canonry.test')
    const callback = 'https://gateway.example/upstream/callback'
    const registered = await app.inject({
      method: 'POST', url: '/oauth/register', headers: browser,
      payload: { client_name: 'Canonry MCP gateway', redirect_uris: [callback] },
    })
    expect(registered.statusCode).toBe(201)
    const clientId = registered.json<{ client_id: string }>().client_id
    await app.close()
    app = await bootServer('https://canonry.test', { mcpGateway: { url: 'https://gateway.example/mcp', clientId } })
    const userId = crypto.randomUUID()
    db.insert(users).values({
      id: userId, name: 'owner', nameKey: 'owner', passwordHash: 'scrypt$1$AAAA$AAAA', role: 'admin',
      createdAt: new Date().toISOString(),
    }).run()
    const cookie = `${USER_SESSION_COOKIE_NAME}=${createUserSession(db, userId)}`

    const page = await app.inject({ method: 'GET', url: `/oauth/authorize?${authorizeQuery(clientId, callback, 'gateway')}`, headers: { ...browser, cookie } })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('<strong>Canonry MCP gateway</strong> wants to access Canonry')
    expect(page.body).toMatch(/name="csrf" value="[^"]+"/)
    expect(page.body).not.toContain('chose its own name')
  })

  it.each(['/', '/canonry/'])('loads the dashboard font from the page origin under %s', async basePath => {
    // Besides inline styles, the gate pages allow one resource: the dashboard's
    // own Geist file. Its URL must be one this server serves under the base
    // path, and the page's policy must let a browser fetch it.
    const assetsDir = path.join(tmpDir, 'dashboard')
    fs.mkdirSync(path.join(assetsDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>Canonry</title>')
    const font = Buffer.concat([Buffer.from('wOF2'), crypto.randomBytes(64)])
    fs.writeFileSync(path.join(assetsDir, 'assets', 'geist-latin-wght-normal-Ab1_c-D2.woff2'), font)
    await app.close()
    app = await bootServer(`https://canonry.test${basePath}`, { basePath, assetsDir })
    const query = registeredClientQuery('font')

    const page = await app.inject({ method: 'GET', url: `${basePath}oauth/authorize?${query}`, headers: browser })
    expect(page.statusCode).toBe(200)
    expect(String(page.headers['content-security-policy']).split(';').map(part => part.trim())).toContain("font-src 'self'")
    const fontUrl = /src: url\('([^']+)'\) format\('woff2'\)/.exec(page.body)?.[1]
    expect(fontUrl).toBe(`${basePath}assets/geist-latin-wght-normal-Ab1_c-D2.woff2`)
    const served = await app.inject({ method: 'GET', url: fontUrl!, headers: browser })
    expect(served.statusCode).toBe(200)
    expect(served.rawPayload.equals(font)).toBe(true)
  })
})
