import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { apiKeys, createClient, migrate, type DatabaseClient } from '@canonry/canonry-db'
import { getConfigPath, type CanonryConfig } from '../src/config.js'
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
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** A throwaway local dashboard: scratch database, random root key, config built in memory. */
  async function startDashboard(configPath?: string) {
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
    const config: CanonryConfig = {
      apiUrl: 'http://127.0.0.1:47700',
      database,
      apiKey,
      dashboard: { showResourceLinks: true },
    }
    app = await createServer({ config, ...(configPath ? { configPath } : {}), db, logger: false, assetsDir })
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

  it('writes config changes to its own configPath and nowhere else', async () => {
    const serverConfigPath = path.join(root, 'server', 'config.yaml')
    const { authorization } = await startDashboard(serverConfigPath)
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
  })
})
