import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { apiKeys, createClient, dashboardSessions, migrate, users, type DatabaseClient } from '@canonry/canonry-db'
import { type CanonryConfig } from '../src/config.js'
import { createServer, getFirstRunSetupToken } from '../src/server.js'

// The first-run setup token is a one-time link `canonry serve` prints
// (#1176): opening it mints a session without inventing a password. The
// token is single-use, lives only in this process, and is void once a
// password exists — it can never bypass a password that is configured.

const SETUP_TOKEN_URL = '/api/v1/session/setup-token'
const DEFAULT_KEY_ID = 'key_default'
const LAN = { host: '192.168.1.10:4100' }
// What a remote visitor sends through a proxy that forwards the client's Host
// and adds no forwarding header (nginx `proxy_set_header Host $host;` alone).
const LOCAL_LOOKING = { host: 'localhost:4100' }
const TOKEN_KEY_REQUIRED = {
  code: 'AUTH_REQUIRED',
  message: 'Setting up with the first-run token requires a request made directly from this machine to a loopback-bound server that has no external URL, base path, or trusted proxy configured.',
}
const TOKEN_INVALID = {
  code: 'AUTH_INVALID',
  message: 'Invalid or expired setup token',
}
const SERVER_KEY_MISSING = {
  code: 'AUTH_INVALID',
  message: 'Server API key not found — run canonry bootstrap',
}
const NAMED_ACCOUNTS_MESSAGE =
  'This install uses named accounts. Sign in with your name and password.'

interface InjectHeaders { [name: string]: string }

describe('first-run POST /session/setup-token', () => {
  let tmpDir: string
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  let db: DatabaseClient | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-setup-token-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
    vi.stubEnv('CANONRY_DASHBOARD_REQUIRE_PASSWORD', '1')
    vi.stubEnv('DO_NOT_TRACK', '1')
    for (const key of ['CANONRY_BASE_PATH', 'CANONRY_TRUST_PROXY', 'CANONRY_OPERATOR_KEY_IDS', 'CANONRY_EMBED',
      'CANONRY_EMBED_ORIGINS', 'CANONRY_EMBED_VIEWS', 'CANONRY_EMBED_PROJECT_TABS']) {
      vi.stubEnv(key, undefined)
    }
  })

  afterEach(async () => {
    await app?.close()
    db?.$client.close()
    app = undefined
    db = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  async function buildServer(
    host: string,
    configPatch: Partial<CanonryConfig> = {},
    configPath = path.join(tmpDir, 'config.yaml'),
  ) {
    const database = path.join(tmpDir, 'test.db')
    db = createClient(database)
    migrate(db)
    const rootKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: DEFAULT_KEY_ID, name: 'default',
      keyHash: crypto.createHash('sha256').update(rootKey).digest('hex'),
      keyPrefix: rootKey.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
    }).run()
    const config: CanonryConfig = {
      apiUrl: 'http://localhost:4100', database, apiKey: rootKey, telemetry: false, updateCheck: false,
      ...configPatch,
    }
    const server = await createServer({ config, configPath, db, host, logger: false, assetsDir: path.join(tmpDir, 'assets') })
    app = server
    return { app: server, config, rootKey }
  }

  function setupToken(token: string | undefined, headers: InjectHeaders = LOCAL_LOOKING, remoteAddress?: string) {
    return app!.inject({
      method: 'POST', url: SETUP_TOKEN_URL, headers,
      payload: token === undefined ? {} : { token },
      ...(remoteAddress ? { remoteAddress } : {}),
    })
  }

  /** The cookie session from a setup-token mint, resolved to the key it carries. */
  async function sessionKey(response: Awaited<ReturnType<typeof setupToken>>, headers: InjectHeaders) {
    const cookie = response.cookies.find(c => c.name === 'canonry_session')
    expect(cookie).toBeDefined()
    const self = await app!.inject({
      method: 'GET', url: '/api/v1/keys/self', headers: { ...headers, cookie: `canonry_session=${cookie!.value}` },
    })
    expect(self.statusCode).toBe(200)
    return self.json() as { id: string; scopes: string[]; projectId: string | null }
  }

  async function tokenAuditEntries(rootKey: string) {
    const history = await app!.inject({
      method: 'GET', url: '/api/v1/history', headers: { ...LAN, authorization: `Bearer ${rootKey}` },
    })
    expect(history.statusCode).toBe(200)
    return (history.json() as Array<Record<string, unknown>>)
      .filter(entry => entry.action === 'dashboard-session.created')
  }

  async function mintKey(rootKey: string, payload: Record<string, unknown>) {
    const response = await app!.inject({
      method: 'POST', url: '/api/v1/keys', headers: { ...LAN, authorization: `Bearer ${rootKey}` }, payload,
    })
    expect(response.statusCode).toBe(200)
    return response.json() as { id: string; key: string; scopes: string[]; projectId: string | null }
  }

  /** Takes the root key's row away, leaving `apiKey` in config.yaml. */
  async function loseRootKey(state: 'revoked' | 'deleted', rootKey: string) {
    const other = await mintKey(rootKey, { name: 'ci' })
    if (state === 'revoked') {
      const revoke = await app!.inject({
        method: 'POST', url: `/api/v1/keys/${DEFAULT_KEY_ID}/revoke`, headers: { ...LAN, authorization: `Bearer ${other.key}` },
      })
      expect(revoke.statusCode).toBe(200)
    } else {
      db!.delete(apiKeys).where(eq(apiKeys.id, DEFAULT_KEY_ID)).run()
    }
    return other
  }

  function addAccount(name: string, role: 'admin' | 'viewer') {
    db!.insert(users).values({
      id: crypto.randomUUID(),
      name,
      nameKey: name.toLowerCase(),
      // A real digest is irrelevant here: these tests never sign in, they only
      // check that the token way in closes once an account exists.
      passwordHash: 'scrypt$1$AAAA$AAAA',
      role,
      createdAt: new Date().toISOString(),
    }).run()
  }

  function expectRefusedWithoutWrites(
    response: Awaited<ReturnType<typeof setupToken>>,
    error: { code: string; message: string },
    status = 401,
  ) {
    expect(response.statusCode).toBe(status)
    expect(response.json()).toEqual({ error })
    expect(response.cookies).toEqual([])
    expect(db!.select().from(dashboardSessions).all()).toEqual([])
  }

  function token() {
    const value = getFirstRunSetupToken(app!)
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    return value!
  }

  it('mints a session on a direct local request, binds the default key, and writes no password', async () => {
    const { config, rootKey } = await buildServer('127.0.0.1')
    const minted = await setupToken(token())

    expect(minted.statusCode).toBe(200)
    expect(minted.json()).toEqual({ authenticated: true })
    expect(await sessionKey(minted, LOCAL_LOOKING)).toMatchObject({ id: DEFAULT_KEY_ID, scopes: ['*'], projectId: null })
    expect(await tokenAuditEntries(rootKey)).toEqual([expect.objectContaining({
      actor: `api-key:${DEFAULT_KEY_ID}`,
      credentialId: null,
      entityType: 'dashboard-session',
      diff: { authorizedBy: 'setup-token' },
    })])
    // The token signs in without inventing a password: nothing is configured.
    expect(config.dashboardPasswordHash).toBeUndefined()
    expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(false)
  })

  it('spends the token on first use: a second request with it is refused', async () => {
    const { rootKey } = await buildServer('127.0.0.1')
    const value = token()
    expect((await setupToken(value)).statusCode).toBe(200)

    expectRefusedWithoutWrites(await setupToken(value), TOKEN_INVALID)
    expect(await tokenAuditEntries(rootKey)).toHaveLength(1)
  })

  it('refuses a wrong token and leaves the real one usable', async () => {
    const { rootKey } = await buildServer('127.0.0.1')
    const value = token()
    const wrong = `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`

    expectRefusedWithoutWrites(await setupToken(wrong), TOKEN_INVALID)

    const minted = await setupToken(value)
    expect(minted.statusCode).toBe(200)
    expect(await sessionKey(minted, LOCAL_LOOKING)).toMatchObject({ id: DEFAULT_KEY_ID })
    expect(await tokenAuditEntries(rootKey)).toHaveLength(1)
  })

  it.each([
    { name: 'no token field', token: undefined },
    { name: 'an empty token', token: '' },
    { name: 'a whitespace token', token: '   ' },
  ])('refuses $name without spending the real token', async ({ token: presented }) => {
    const { rootKey } = await buildServer('127.0.0.1')
    const value = token()

    expectRefusedWithoutWrites(await setupToken(presented), TOKEN_INVALID)

    expect((await setupToken(value)).statusCode).toBe(200)
    expect(await tokenAuditEntries(rootKey)).toHaveLength(1)
  })

  it('refuses with 400 once a password is configured, and mints no token at startup', async () => {
    const { rootKey } = await buildServer('127.0.0.1', {
      dashboardPasswordHash: 'scrypt$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(getFirstRunSetupToken(app!)).toBeNull()

    expectRefusedWithoutWrites(
      await setupToken('0'.repeat(64)),
      { code: 'VALIDATION_ERROR', message: 'Dashboard password is already configured' },
      400,
    )
    expect(await tokenAuditEntries(rootKey)).toEqual([])
  })

  it.each([
    { name: 'a proxied request', headers: { host: '127.0.0.1:4100', 'x-forwarded-for': '203.0.113.9' } },
    { name: 'a request whose Host is a LAN address', headers: { host: '192.168.1.10:4100' } },
    { name: 'a request from a non-loopback peer', headers: { host: '127.0.0.1:4100' }, remoteAddress: '203.0.113.9' },
  ])('requires the root key when $name', async ({ headers, remoteAddress }) => {
    const { rootKey } = await buildServer('127.0.0.1')

    expectRefusedWithoutWrites(await setupToken(token(), headers, remoteAddress), TOKEN_KEY_REQUIRED)
    expect(await tokenAuditEntries(rootKey)).toEqual([])
  })

  it('requires the root key on an off-box bind, even for a local-looking request', async () => {
    const { rootKey } = await buildServer('0.0.0.0')
    expect(getFirstRunSetupToken(app!)).toBeNull()

    expectRefusedWithoutWrites(await setupToken('0'.repeat(64), LOCAL_LOOKING), TOKEN_KEY_REQUIRED)
    expect(await tokenAuditEntries(rootKey)).toEqual([])
  })

  it('refuses with 403 once named accounts exist', async () => {
    const { rootKey } = await buildServer('127.0.0.1')
    addAccount('operator', 'admin')

    expectRefusedWithoutWrites(
      await setupToken(token()),
      { code: 'FORBIDDEN', message: NAMED_ACCOUNTS_MESSAGE },
      403,
    )
    expect(await tokenAuditEntries(rootKey)).toEqual([])
  })

  it.each(['revoked', 'deleted'] as const)('refuses when the root key is %s, writing nothing', async (state) => {
    const { rootKey } = await buildServer('127.0.0.1')
    await loseRootKey(state, rootKey)

    expectRefusedWithoutWrites(await setupToken(token()), SERVER_KEY_MISSING)
  })

  it('answers already-authenticated when the password is disabled, and mints no token', async () => {
    vi.stubEnv('CANONRY_DASHBOARD_REQUIRE_PASSWORD', '0')
    const { rootKey } = await buildServer('127.0.0.1')
    expect(getFirstRunSetupToken(app!)).toBeNull()

    const response = await setupToken(undefined)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ authenticated: true, setupRequired: false })
    expect(response.cookies).toEqual([])
    expect(await tokenAuditEntries(rootKey)).toEqual([])
  })

  // `inject` fakes the socket; this proves the gate reads a real one.
  it('applies the same rule over a real loopback socket', async () => {
    await buildServer('127.0.0.1')
    const value = token()
    const address = await app!.listen({ port: 0, host: '127.0.0.1' })
    const { port } = new URL(address)
    const post = (headers: InjectHeaders, body: Record<string, unknown>) => new Promise<{ status: number; setCookie: string[] }>((resolve, reject) => {
      const payload = JSON.stringify(body)
      const request = http.request({
        host: '127.0.0.1', port: Number(port), method: 'POST', path: SETUP_TOKEN_URL,
        headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (response) => {
        response.resume()
        response.on('end', () => resolve({ status: response.statusCode ?? 0, setCookie: response.headers['set-cookie'] ?? [] }))
      })
      request.on('error', reject)
      request.end(payload)
    })

    const proxied = await post({ host: `127.0.0.1:${port}`, 'x-forwarded-for': '203.0.113.9' }, { token: value })
    expect(proxied).toEqual({ status: 401, setCookie: [] })

    const direct = await post({ host: `127.0.0.1:${port}` }, { token: value })
    expect(direct.status).toBe(200)
    expect(direct.setCookie).toEqual([expect.stringMatching(/^canonry_session=/)])
  })

  // The token lives only in this process: a restart mints a fresh one, and
  // the spent one stays spent.
  it('mints a fresh token on restart', async () => {
    const { config, rootKey } = await buildServer('127.0.0.1')
    const first = token()
    expect((await setupToken(first)).statusCode).toBe(200)

    await app!.close()
    app = await createServer({
      config, configPath: path.join(tmpDir, 'config.yaml'), db: db!, host: '127.0.0.1', logger: false,
      assetsDir: path.join(tmpDir, 'assets'),
    })
    expect(config.dashboardPasswordHash).toBeUndefined()
    const second = token()
    expect(second).not.toBe(first)
    expect((await setupToken(second)).statusCode).toBe(200)
    expect(await tokenAuditEntries(rootKey)).toHaveLength(2)
  })
})
