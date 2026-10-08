import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { parse } from 'yaml'
import { apiKeys, createClient, dashboardSessions, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

// The first dashboard password is a standing credential for the install's
// default `*` key: every password sign-in binds to that key. Setting it is
// therefore root, and only the root key itself, or a request made directly on
// this machine, may do it.

const SETUP_URL = '/api/v1/session/setup'
const PASSWORD = 'operator-chosen-password'
const DEFAULT_KEY_ID = 'key_default'
const PUBLIC_HOST = 'canonry.example.com'
const LAN = { host: '192.168.1.10:4100' }
// What a remote visitor sends through a proxy that forwards the client's Host
// and adds no forwarding header (nginx `proxy_set_header Host $host;` alone).
const LOCAL_LOOKING = { host: 'localhost:4100' }
const ROOT_KEY_REQUIRED = {
  code: 'AUTH_REQUIRED',
  message: 'Setting the dashboard password requires the root API key (apiKey in config.yaml), unless the request comes directly from this machine to a loopback-bound server that has no external URL or trusted proxy configured.',
}
const SERVER_KEY_MISSING = {
  code: 'AUTH_INVALID',
  message: 'Server API key not found — run canonry bootstrap',
}

interface InjectHeaders { [name: string]: string }
interface SetupRequestCase { name: string; headers: InjectHeaders; remoteAddress?: string }
interface ConfiguredAccessCase { name: string; configPatch?: Partial<CanonryConfig>; trustProxy?: string }

describe('first-run POST /session/setup authority', () => {
  let tmpDir: string
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  let db: DatabaseClient | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-setup-authority-'))
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

  async function buildServer(host: string, configPatch: Partial<CanonryConfig> = {}) {
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
    const server = await createServer({ config, db, host, logger: false, assetsDir: path.join(tmpDir, 'assets') })
    app = server
    return { app: server, config, rootKey }
  }

  function setup(headers: InjectHeaders, remoteAddress?: string) {
    return app!.inject({
      method: 'POST', url: SETUP_URL, headers, payload: { password: PASSWORD },
      ...(remoteAddress ? { remoteAddress } : {}),
    })
  }

  async function mintKey(rootKey: string, payload: Record<string, unknown>) {
    const response = await app!.inject({
      method: 'POST', url: '/api/v1/keys', headers: { ...LAN, authorization: `Bearer ${rootKey}` }, payload,
    })
    expect(response.statusCode).toBe(200)
    return response.json() as { id: string; key: string; scopes: string[]; projectId: string | null }
  }

  async function createProject(rootKey: string) {
    const response = await app!.inject({
      method: 'PUT', url: '/api/v1/projects/acme', headers: { ...LAN, authorization: `Bearer ${rootKey}` },
      payload: { displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en' },
    })
    expect(response.statusCode).toBe(201)
    return (response.json() as { id: string }).id
  }

  function expectRefusedWithoutWrites(
    response: Awaited<ReturnType<typeof setup>>,
    config: CanonryConfig,
    error: { code: string; message: string },
  ) {
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error })
    expect(response.cookies).toEqual([])
    expect(config.dashboardPasswordHash).toBeUndefined()
    expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(false)
    expect(db!.select().from(dashboardSessions).all()).toEqual([])
  }

  /** The cookie session from a setup or sign-in, resolved to the key it carries. */
  async function sessionKey(response: Awaited<ReturnType<typeof setup>>, headers: InjectHeaders) {
    const cookie = response.cookies.find(c => c.name === 'canonry_session')
    expect(cookie).toBeDefined()
    const self = await app!.inject({
      method: 'GET', url: '/api/v1/keys/self', headers: { ...headers, cookie: `canonry_session=${cookie!.value}` },
    })
    expect(self.statusCode).toBe(200)
    return self.json() as { id: string; scopes: string[]; projectId: string | null }
  }

  async function setupAuditEntries(rootKey: string) {
    const history = await app!.inject({
      method: 'GET', url: '/api/v1/history', headers: { ...LAN, authorization: `Bearer ${rootKey}` },
    })
    expect(history.statusCode).toBe(200)
    return (history.json() as Array<Record<string, unknown>>)
      .filter(entry => entry.action === 'dashboard-password.created')
  }

  describe('on an off-box bind', () => {
    it.each([
      { name: 'a read-only key', mint: () => ({ name: 'agent', scopes: ['read'] }) },
      { name: 'a project key limited to read', mint: (projectId: string) => ({ name: 'client-read', scopes: ['read'], projectId }) },
      // Minted with no scopes, a project key is stored as `*` plus its project,
      // so a check on `scopes.includes('*')` alone would let it through.
      { name: 'a project key with every scope', mint: (projectId: string) => ({ name: 'client', projectId }) },
      { name: 'a second full-instance key', mint: () => ({ name: 'ci' }) },
    ])('refuses $name, writes nothing, and leaves setup open for the operator', async ({ mint }) => {
      const { config, rootKey } = await buildServer('0.0.0.0')
      const projectId = await createProject(rootKey)
      const narrow = await mintKey(rootKey, mint(projectId))
      expect(narrow.id).not.toBe(DEFAULT_KEY_ID)

      const refused = await setup({ ...LAN, authorization: `Bearer ${narrow.key}` })
      expectRefusedWithoutWrites(refused, config, ROOT_KEY_REQUIRED)

      const accepted = await setup({ ...LAN, authorization: `Bearer ${rootKey}` })
      expect(accepted.statusCode).toBe(200)
      expect(await sessionKey(accepted, LAN)).toMatchObject({ id: DEFAULT_KEY_ID, scopes: ['*'], projectId: null })
    })

    it.each([
      { name: 'no Authorization header', authorization: () => undefined },
      { name: 'an unknown key', authorization: () => `Bearer cnry_${crypto.randomBytes(16).toString('hex')}` },
      { name: 'a bare scheme', authorization: () => 'Bearer' },
      { name: 'an empty token', authorization: () => 'Bearer ' },
      { name: 'the root key without a scheme', authorization: (key: string) => key },
      { name: 'the root key under Basic', authorization: (key: string) => `Basic ${key}` },
      { name: 'a lowercase scheme', authorization: (key: string) => `bearer ${key}` },
      { name: 'a doubled separator', authorization: (key: string) => `Bearer  ${key}` },
      { name: 'a trailing extra token', authorization: (key: string) => `Bearer ${key} ${key}` },
    ])('refuses $name', async ({ authorization }) => {
      const { config, rootKey } = await buildServer('0.0.0.0')
      const value = authorization(rootKey)
      const refused = await setup({ ...LAN, ...(value === undefined ? {} : { authorization: value }) })
      expectRefusedWithoutWrites(refused, config, ROOT_KEY_REQUIRED)
    })

    // Only the bind refuses these: each request is direct and local in every
    // way the request checks can see. A same-host proxy or a `--network host`
    // container sends a remote visitor's request exactly like this.
    it.each<SetupRequestCase & { bind: string }>([
      { name: 'localhost', bind: '0.0.0.0', headers: LOCAL_LOOKING },
      { name: '127.0.0.1', bind: '0.0.0.0', headers: { host: '127.0.0.1:4100' } },
      { name: 'IPv6 loopback', bind: '::', headers: { host: '[::1]:4100' }, remoteAddress: '::1' },
    ])('requires the root key for a direct request to $name on a $bind bind', async ({ bind, headers, remoteAddress }) => {
      const { config, rootKey } = await buildServer(bind)

      expectRefusedWithoutWrites(await setup(headers, remoteAddress), config, ROOT_KEY_REQUIRED)

      const accepted = await setup({ ...headers, authorization: `Bearer ${rootKey}` }, remoteAddress)
      expect(accepted.statusCode).toBe(200)
      expect(await sessionKey(accepted, headers)).toMatchObject({ id: DEFAULT_KEY_ID })
    })

    it('accepts the root key and binds the password to it', async () => {
      const { config, rootKey } = await buildServer('0.0.0.0')
      const root = { ...LAN, authorization: `Bearer ${rootKey}` }

      const accepted = await setup({ ...root, 'user-agent': 'setup-client/1.0' })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.json()).toEqual({ authenticated: true })
      expect(await sessionKey(accepted, LAN)).toMatchObject({ id: DEFAULT_KEY_ID, scopes: ['*'], projectId: null })
      const onDisk = parse(fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8')) as CanonryConfig
      expect(onDisk.dashboardPasswordHash).toMatch(/^scrypt\$1\$/)
      expect(config.dashboardPasswordHash).toBe(onDisk.dashboardPasswordHash)
      expect(await setupAuditEntries(rootKey)).toEqual([expect.objectContaining({
        projectId: null,
        actor: `api-key:${DEFAULT_KEY_ID}`,
        credentialId: DEFAULT_KEY_ID,
        userAgent: 'setup-client/1.0',
        entityType: 'dashboard-password',
        entityId: null,
        diff: { authorizedBy: 'root-api-key' },
      })])

      // Setup is one-time; the auth gate still answers first for a keyless caller.
      const again = await setup(root)
      expect(again.statusCode).toBe(400)
      expect(again.json().error.message).toBe('Dashboard password is already configured')
      expect((await setup(LAN)).statusCode).toBe(401)

      // The password now signs in to the same default key.
      const signIn = await app!.inject({ method: 'POST', url: '/api/v1/session', headers: LAN, payload: { password: PASSWORD } })
      expect(signIn.statusCode).toBe(200)
      expect(await sessionKey(signIn, LAN)).toMatchObject({ id: DEFAULT_KEY_ID })
    })

    // No key can pass while the root key has no live row, so a caller who
    // presents one, such as the revoked key still in config.yaml, is told to
    // rerun bootstrap rather than that the key is wrong.
    it.each(['revoked', 'deleted'] as const)('refuses every key with the bootstrap error when the root key is %s, writing nothing', async (state) => {
      const { config, rootKey } = await buildServer('0.0.0.0')
      const other = await mintKey(rootKey, { name: 'ci' })
      if (state === 'revoked') {
        const revoke = await app!.inject({
          method: 'POST', url: `/api/v1/keys/${DEFAULT_KEY_ID}/revoke`, headers: { ...LAN, authorization: `Bearer ${other.key}` },
        })
        expect(revoke.statusCode).toBe(200)
      } else {
        db!.delete(apiKeys).where(eq(apiKeys.id, DEFAULT_KEY_ID)).run()
      }

      for (const key of [rootKey, other.key]) {
        const refused = await setup({ ...LAN, authorization: `Bearer ${key}` })
        expectRefusedWithoutWrites(refused, config, SERVER_KEY_MISSING)
      }
      expectRefusedWithoutWrites(await setup(LAN), config, ROOT_KEY_REQUIRED)
    })

    // The audit row, the session, and config.yaml are written together: a
    // failure in any of them leaves no password behind, so a retry can finish.
    it('writes nothing when the audit row cannot be written, and a retry succeeds', async () => {
      const { config, rootKey } = await buildServer('0.0.0.0')
      const root = { ...LAN, authorization: `Bearer ${rootKey}` }
      db!.$client.exec(`CREATE TEMP TRIGGER refuse_audit BEFORE INSERT ON main.audit_log
        BEGIN SELECT RAISE(ABORT, 'audit log unavailable'); END`)

      const failed = await setup(root)
      expect(failed.statusCode).toBe(500)
      expect(failed.cookies).toEqual([])
      expect(config.dashboardPasswordHash).toBeUndefined()
      expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(false)
      expect(db!.select().from(dashboardSessions).all()).toEqual([])

      db!.$client.exec('DROP TRIGGER temp.refuse_audit')
      const retried = await setup(root)
      expect(retried.statusCode).toBe(200)
      expect(await sessionKey(retried, LAN)).toMatchObject({ id: DEFAULT_KEY_ID })
      expect(await setupAuditEntries(rootKey)).toHaveLength(1)
    })

    it('writes nothing when config.yaml cannot be saved, and a retry succeeds', async () => {
      const { config, rootKey } = await buildServer('0.0.0.0')
      const root = { ...LAN, authorization: `Bearer ${rootKey}` }
      // A config directory under a regular file cannot be created.
      const blocker = path.join(tmpDir, 'blocker')
      fs.writeFileSync(blocker, '')
      vi.stubEnv('CANONRY_CONFIG_DIR', path.join(blocker, 'config'))

      const failed = await setup(root)
      expect(failed.statusCode).toBe(500)
      expect(failed.cookies).toEqual([])
      expect(config.dashboardPasswordHash).toBeUndefined()
      expect(db!.select().from(dashboardSessions).all()).toEqual([])

      vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
      expect(await setupAuditEntries(rootKey)).toEqual([])
      const retried = await setup(root)
      expect(retried.statusCode).toBe(200)
      expect(await sessionKey(retried, LAN)).toMatchObject({ id: DEFAULT_KEY_ID })
      expect(await setupAuditEntries(rootKey)).toHaveLength(1)
      expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(true)
    })
  })

  describe('on a loopback bind', () => {
    // Each case changes one thing about an otherwise direct local request, on a
    // server whose config names no other way in.
    it.each<SetupRequestCase>([
      { name: 'Host is a LAN address', headers: { host: '192.168.1.10:4100' } },
      { name: 'X-Forwarded-For is present', headers: { host: '127.0.0.1:4100', 'x-forwarded-for': '203.0.113.9' } },
      // A trusted proxy would turn this into a loopback `request.ip`; the header alone refuses it.
      { name: 'X-Forwarded-For names a loopback client', headers: { host: '127.0.0.1:4100', 'x-forwarded-for': '127.0.0.1' } },
      { name: 'Forwarded is present', headers: { host: '127.0.0.1:4100', forwarded: 'for=203.0.113.9;proto=https' } },
      { name: 'X-Forwarded-Host is present', headers: { ...LOCAL_LOOKING, 'x-forwarded-host': PUBLIC_HOST } },
      { name: 'X-Forwarded-Proto is present', headers: { ...LOCAL_LOOKING, 'x-forwarded-proto': 'https' } },
      { name: 'X-Forwarded-Port is present', headers: { ...LOCAL_LOOKING, 'x-forwarded-port': '443' } },
      { name: 'X-Forwarded-Server is present', headers: { ...LOCAL_LOOKING, 'x-forwarded-server': PUBLIC_HOST } },
      { name: 'X-Real-IP is present', headers: { ...LOCAL_LOOKING, 'x-real-ip': '203.0.113.9' } },
      { name: 'Via is present', headers: { ...LOCAL_LOOKING, via: '1.1 edge-proxy' } },
      { name: 'CF-Connecting-IP is present', headers: { ...LOCAL_LOOKING, 'cf-connecting-ip': '203.0.113.9' } },
      { name: 'True-Client-IP is present', headers: { ...LOCAL_LOOKING, 'true-client-ip': '203.0.113.9' } },
      { name: 'the socket peer is not loopback', headers: { host: '127.0.0.1:4100' }, remoteAddress: '203.0.113.9' },
    ])('requires the root key when $name', async ({ headers, remoteAddress }) => {
      const { config, rootKey } = await buildServer('127.0.0.1')

      const refused = await setup(headers, remoteAddress)
      expectRefusedWithoutWrites(refused, config, ROOT_KEY_REQUIRED)

      // The operator finishes setup through the same path with the root key.
      const accepted = await setup({ ...headers, authorization: `Bearer ${rootKey}` }, remoteAddress)
      expect(accepted.statusCode).toBe(200)
      expect(await sessionKey(accepted, headers)).toMatchObject({ id: DEFAULT_KEY_ID })
    })

    // Host is whatever the client sent, and a proxy or TCP forwarder that adds
    // no forwarding header delivers a remote visitor's `Host: localhost` over
    // loopback. Config that names another way in therefore turns keyless setup
    // off, for requests that look local too.
    it.each<ConfiguredAccessCase>([
      { name: 'publicUrl names an external host', configPatch: { publicUrl: `https://${PUBLIC_HOST}` } },
      { name: 'publicUrl names an external sub-path', configPatch: { publicUrl: `https://${PUBLIC_HOST}/canonry/` } },
      { name: 'apiUrl names an external host', configPatch: { apiUrl: `https://${PUBLIC_HOST}` } },
      { name: 'publicUrl names a LAN address', configPatch: { publicUrl: 'http://192.168.1.10:4100' } },
      { name: 'publicUrl cannot be parsed', configPatch: { publicUrl: 'canonry example' } },
      { name: 'CANONRY_TRUST_PROXY trusts every hop', trustProxy: 'true' },
      { name: 'CANONRY_TRUST_PROXY trusts one hop', trustProxy: '1' },
      { name: 'CANONRY_TRUST_PROXY trusts an address', trustProxy: '127.0.0.1' },
    ])('requires the root key for a local-looking request when $name', async ({ configPatch, trustProxy }) => {
      if (trustProxy) vi.stubEnv('CANONRY_TRUST_PROXY', trustProxy)
      const { config, rootKey } = await buildServer('127.0.0.1', configPatch)

      for (const headers of [LOCAL_LOOKING, { host: '127.0.0.1:4100' }]) {
        expectRefusedWithoutWrites(await setup(headers), config, ROOT_KEY_REQUIRED)
      }

      const accepted = await setup({ ...LOCAL_LOOKING, authorization: `Bearer ${rootKey}` })
      expect(accepted.statusCode).toBe(200)
      expect(await sessionKey(accepted, LOCAL_LOOKING)).toMatchObject({ id: DEFAULT_KEY_ID })
    })

    it.each<SetupRequestCase & ConfiguredAccessCase>([
      { name: '127.0.0.1', headers: { host: '127.0.0.1:4100' } },
      { name: 'localhost', headers: LOCAL_LOOKING },
      { name: 'IPv6 loopback', headers: { host: '[::1]:4100' }, remoteAddress: '::1' },
      { name: 'an IPv4-mapped loopback peer', headers: LOCAL_LOOKING, remoteAddress: '::ffff:127.0.0.1' },
      // Loopback URLs and a disabled proxy setting name no other way in.
      {
        name: 'localhost with loopback apiUrl and publicUrl',
        headers: LOCAL_LOOKING,
        configPatch: { apiUrl: 'http://127.0.0.1:4100', publicUrl: 'http://localhost:4100/canonry/' },
      },
      { name: 'localhost with CANONRY_TRUST_PROXY=false', headers: LOCAL_LOOKING, trustProxy: 'false' },
    ])('lets a direct request to $name set the password without a key', async ({ headers, remoteAddress, configPatch, trustProxy }) => {
      if (trustProxy) vi.stubEnv('CANONRY_TRUST_PROXY', trustProxy)
      const { config, rootKey } = await buildServer('127.0.0.1', configPatch)

      const accepted = await setup(headers, remoteAddress)
      expect(accepted.statusCode).toBe(200)
      expect(accepted.json()).toEqual({ authenticated: true })
      expect(config.dashboardPasswordHash).toMatch(/^scrypt\$1\$/)
      expect(await sessionKey(accepted, headers)).toMatchObject({ id: DEFAULT_KEY_ID, scopes: ['*'], projectId: null })
      expect(await setupAuditEntries(rootKey)).toEqual([expect.objectContaining({
        actor: `api-key:${DEFAULT_KEY_ID}`,
        credentialId: null,
        diff: { authorizedBy: 'local-request' },
      })])
    })

    // `inject` fakes the socket; this proves the gate reads a real one.
    it('applies the same rule over a real loopback socket', async () => {
      const { config } = await buildServer('127.0.0.1')
      const address = await app!.listen({ port: 0, host: '127.0.0.1' })
      const { port } = new URL(address)
      const post = (headers: InjectHeaders) => new Promise<{ status: number; setCookie: string[] }>((resolve, reject) => {
        const body = JSON.stringify({ password: PASSWORD })
        const request = http.request({
          host: '127.0.0.1', port: Number(port), method: 'POST', path: SETUP_URL,
          headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (response) => {
          response.resume()
          response.on('end', () => resolve({ status: response.statusCode ?? 0, setCookie: response.headers['set-cookie'] ?? [] }))
        })
        request.on('error', reject)
        request.end(body)
      })

      const proxied = await post({ host: `127.0.0.1:${port}`, 'x-forwarded-for': '203.0.113.9' })
      expect(proxied).toEqual({ status: 401, setCookie: [] })
      expect(config.dashboardPasswordHash).toBeUndefined()

      const direct = await post({ host: `127.0.0.1:${port}` })
      expect(direct.status).toBe(200)
      expect(direct.setCookie).toEqual([expect.stringMatching(/^canonry_session=/)])
      expect(config.dashboardPasswordHash).toMatch(/^scrypt\$1\$/)
    })

    it.each(['revoked', 'deleted'] as const)('refuses a direct request when the root key is %s, writing nothing', async (state) => {
      const { config, rootKey } = await buildServer('127.0.0.1')
      if (state === 'revoked') {
        const other = await mintKey(rootKey, { name: 'ci' })
        const revoke = await app!.inject({
          method: 'POST', url: `/api/v1/keys/${DEFAULT_KEY_ID}/revoke`, headers: { ...LAN, authorization: `Bearer ${other.key}` },
        })
        expect(revoke.statusCode).toBe(200)
      } else {
        db!.delete(apiKeys).where(eq(apiKeys.id, DEFAULT_KEY_ID)).run()
      }

      const refused = await setup({ host: '127.0.0.1:4100' })
      expectRefusedWithoutWrites(refused, config, SERVER_KEY_MISSING)
    })
  })
})
