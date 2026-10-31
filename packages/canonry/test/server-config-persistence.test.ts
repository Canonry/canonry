import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { apiKeys, createClient, migrate, type DatabaseClient } from '@canonry/canonry-db'
import { getConfigPath, loadConfig, type CanonryConfig } from '../src/config.js'
import { createServer, waitForServerRuntimeStartup } from '../src/server.js'

// A server given a config built in memory (a test or development dashboard)
// must leave the operator's config.yaml alone. Its config writes used to patch
// `getConfigPath()` with the whole in-memory config: first-run password setup
// on a throwaway local dashboard replaced the operator's `apiUrl` and
// `dashboard` block, and every CLI call on the machine then failed.

// The comment and key order survive only while nothing rewrites the file.
const OPERATOR_CONFIG = [
  '# Operator config. A test or development server must never rewrite it.',
  'apiUrl: http://localhost:4100/canonry',
  'basePath: /canonry/',
  'database: /srv/canonry/data.db',
  'apiKey: cnry_operator00000000000000000000000',
  'dashboard:',
  '  showResourceLinks: false',
  '',
].join('\n')

const PASSWORD = 'a-long-enough-password'
const ROOT_KEY_ID = 'key_default'
const FIXTURE_HTML = '<!doctype html><html><head><title>canonry</title></head><body><div id="root"></div></body></html>'

describe('createServer config persistence', () => {
  let root: string
  let operatorConfigPath: string
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  let db: DatabaseClient | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-config-persistence-'))
    const home = path.join(root, 'home')
    // No CANONRY_CONFIG_DIR, so the default config is ~/.canonry/config.yaml.
    vi.stubEnv('HOME', home)
    vi.stubEnv('CANONRY_CONFIG_DIR', undefined)
    vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
    vi.stubEnv('DO_NOT_TRACK', '1')
    // The telemetry setting is an operator-key route.
    vi.stubEnv('CANONRY_OPERATOR_KEY_IDS', ROOT_KEY_ID)
    for (const key of ['CANONRY_BASE_PATH', 'CANONRY_TRUST_PROXY', 'CANONRY_PORT', 'CANONRY_DASHBOARD_REQUIRE_PASSWORD']) {
      vi.stubEnv(key, undefined)
    }
    operatorConfigPath = path.join(home, '.canonry', 'config.yaml')
    fs.mkdirSync(path.dirname(operatorConfigPath), { recursive: true })
    fs.writeFileSync(operatorConfigPath, OPERATOR_CONFIG, { mode: 0o600 })
  })

  afterEach(async () => {
    await app?.close()
    db?.$client.close()
    app = undefined
    db = undefined
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  })

  /**
   * A throwaway local dashboard: scratch database and random root key. Its
   * config is built in memory unless it is handed a `configPath` or read back
   * from a file with `loadConfig` (`loadFrom`).
   */
  async function startDashboard(source: { configPath?: string, loadFrom?: string } = {}) {
    const database = path.join(root, 'scratch.db')
    db = createClient(database)
    migrate(db)
    const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: ROOT_KEY_ID, name: 'default',
      keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
      keyPrefix: apiKey.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
    }).run()
    const assetsDir = path.join(root, 'assets')
    fs.mkdirSync(assetsDir, { recursive: true })
    fs.writeFileSync(path.join(assetsDir, 'index.html'), FIXTURE_HTML)
    let config: CanonryConfig = {
      apiUrl: 'http://127.0.0.1:47700',
      database,
      apiKey,
      dashboard: { showResourceLinks: true },
    }
    if (source.loadFrom) {
      fs.mkdirSync(path.dirname(source.loadFrom), { recursive: true })
      fs.writeFileSync(source.loadFrom, stringify(config))
      config = loadConfig(source.loadFrom)
    }
    app = await createServer({
      config, ...(source.configPath ? { configPath: source.configPath } : {}), db, logger: false, assetsDir,
    })
    // Background work starts once the server is listening.
    await app.listen({ port: 0, host: '127.0.0.1' })
    await waitForServerRuntimeStartup(app)
    return { authorization: `Bearer ${apiKey}` }
  }

  /** The first dashboard visit, password setup and sign-in, then settings writes. */
  async function useDashboard(authorization: string) {
    expect((await app!.inject({ method: 'GET', url: '/' })).statusCode).toBe(200)
    expect((await app!.inject({ method: 'GET', url: '/api/v1/session' })).json()).toMatchObject({ setupRequired: true })
    const setup = await app!.inject({ method: 'POST', url: '/api/v1/session/setup', payload: { password: PASSWORD } })
    expect(setup.json()).toEqual({ authenticated: true })
    const signIn = await app!.inject({ method: 'POST', url: '/api/v1/session', payload: { password: PASSWORD } })
    expect(signIn.json()).toEqual({ authenticated: true })

    const provider = await app!.inject({
      method: 'PUT', url: '/api/v1/settings/providers/openai', headers: { authorization }, payload: { apiKey: 'sk-test-openai' },
    })
    expect(provider.statusCode).toBe(200)
    const google = await app!.inject({
      method: 'PUT', url: '/api/v1/settings/google', headers: { authorization },
      payload: { clientId: 'google-client-id', clientSecret: 'google-client-secret' },
    })
    expect(google.statusCode).toBe(200)
  }

  it('never writes the operator config.yaml for a config built in memory', async () => {
    // The file a server with no config path of its own used to write.
    expect(getConfigPath()).toBe(operatorConfigPath)
    const { authorization } = await startDashboard()
    await useDashboard(authorization)
    expect(fs.readFileSync(operatorConfigPath, 'utf8')).toBe(OPERATOR_CONFIG)

    // The telemetry preference lives in the operator's file, so this server refuses it.
    const telemetry = await app!.inject({
      method: 'PUT', url: '/api/v1/telemetry', headers: { authorization }, payload: { enabled: false },
    })
    expect(telemetry.statusCode).toBe(501)
    expect(fs.readFileSync(operatorConfigPath, 'utf8')).toBe(OPERATOR_CONFIG)

    // The changes still apply to this server, in memory.
    const settings = await app!.inject({ method: 'GET', url: '/api/v1/settings', headers: { authorization } })
    expect(settings.json().providers).toContainEqual(expect.objectContaining({ name: 'openai', configured: true }))
  })

  it('sends dashboard telemetry without saving an install ID in the operator config.yaml', async () => {
    // Telemetry is on, the operator's file has no install ID yet, and a
    // runtime port override is set that must never reach the file.
    for (const key of ['CANONRY_TELEMETRY_DISABLED', 'DO_NOT_TRACK', 'CI', 'CANONRY_ANONYMOUS_ID']) vi.stubEnv(key, undefined)
    vi.stubEnv('CANONRY_PORT', '47700')
    const sent: Array<{ event?: unknown }> = []
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') sent.push(JSON.parse(init.body) as { event?: unknown })
      return new Response('{}')
    })
    const { authorization } = await startDashboard()

    const viewed = await app!.inject({
      method: 'POST', url: '/api/v1/telemetry/ui', headers: { authorization },
      payload: { event: 'ui.page_viewed', eventId: crypto.randomUUID(), uiSessionId: crypto.randomUUID(), page: '/' },
    })
    expect(viewed.json()).toEqual({ accepted: true })
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ event: 'ui.page_viewed' })))
    expect(fs.readFileSync(operatorConfigPath, 'utf8')).toBe(OPERATOR_CONFIG)
  })

  it.each(['configPath', 'loadConfig'] as const)(
    'writes config changes back to the file its config came from (%s) and nowhere else',
    async (source) => {
      const serverConfigPath = path.join(root, 'server', 'config.yaml')
      const { authorization } = await startDashboard(
        source === 'configPath' ? { configPath: serverConfigPath } : { loadFrom: serverConfigPath },
      )
      await useDashboard(authorization)

      expect(fs.readFileSync(operatorConfigPath, 'utf8')).toBe(OPERATOR_CONFIG)
      const saved = parse(fs.readFileSync(serverConfigPath, 'utf8')) as CanonryConfig
      expect(saved).toMatchObject({
        apiUrl: 'http://127.0.0.1:47700',
        dashboard: { showResourceLinks: true },
        providers: { openai: { apiKey: 'sk-test-openai' } },
        google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      })
      expect(saved.dashboardPasswordHash).toMatch(/^scrypt\$/)
    },
  )
})
