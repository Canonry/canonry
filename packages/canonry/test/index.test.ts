import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse, stringify } from 'yaml'
import { eq } from 'drizzle-orm'
import {
  adsActivationGrants,
  apiKeys,
  auditLog,
  createClient,
  migrate,
  projects,
} from '@ainyc/canonry-db'
import { bootstrapCommand } from '../src/commands/bootstrap.js'
import { initCommand } from '../src/commands/init.js'
import { getConfigDir, loadConfig, type CanonryConfig } from '../src/config.js'
import { createServer, isLoopbackBindHost } from '../src/server.js'
import { ApiClient } from '../src/client.js'

const _require = createRequire(import.meta.url)
const { version: PKG_VERSION } = _require('../package.json') as { version: string }

describe('canonry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('loadConfig throws when no config exists', () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('HOME', tmpDir)

    try {
      expect(() => loadConfig()).toThrow(/Config not found/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('getConfigDir honors CANONRY_CONFIG_DIR', () => {
    vi.stubEnv('CANONRY_CONFIG_DIR', '/tmp/canonry-custom')
    expect(getConfigDir()).toBe('/tmp/canonry-custom')
  })

  it('loadConfig rewrites apiUrl port when CANONRY_PORT is set', () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-port-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_PORT', '5000')

    const yaml = `apiUrl: 'http://localhost:4100'\ndatabase: /tmp/test.db\napiKey: cnry_testkey\n`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), yaml)

    try {
      const config = loadConfig()
      expect(config.apiUrl).toBe('http://localhost:5000')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('loadConfig leaves apiUrl unchanged when CANONRY_PORT is not set', () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-port-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_PORT', undefined as unknown as string)

    const yaml = `apiUrl: 'http://localhost:4100'\ndatabase: /tmp/test.db\napiKey: cnry_testkey\n`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), yaml)

    try {
      const config = loadConfig()
      expect(config.apiUrl).toBe('http://localhost:4100')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('loadConfig leaves apiUrl unchanged when apiUrl is malformed and CANONRY_PORT is set', () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-port-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_PORT', '5000')

    const yaml = `apiUrl: 'not-a-valid-url'\ndatabase: /tmp/test.db\napiKey: cnry_testkey\n`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), yaml)

    try {
      const config = loadConfig()
      expect(config.apiUrl).toBe('not-a-valid-url')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('loadConfig incorporates basePath from config into apiUrl', () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-basepath-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'apiUrl: http://localhost:4100\nbasePath: /canonry/\ndatabase: test.db\napiKey: cnry_test')

    try {
      const config = loadConfig()
      expect(config.apiUrl).toBe('http://localhost:4100/canonry')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('loadConfig incorporates CANONRY_BASE_PATH env var into apiUrl', () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-basepath-env-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_BASE_PATH', '/myapp/')
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'apiUrl: http://localhost:4100\ndatabase: test.db\napiKey: cnry_test')

    try {
      const config = loadConfig()
      expect(config.apiUrl).toBe('http://localhost:4100/myapp')
      expect(config.basePath).toBe('/myapp/')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('loadConfig clears basePath when CANONRY_BASE_PATH is empty string', () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-basepath-clear-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_BASE_PATH', '')
    // config.yaml has basePath set, but the empty env var should clear it
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'apiUrl: http://localhost:4100\nbasePath: /canonry/\ndatabase: test.db\napiKey: cnry_test')

    try {
      const config = loadConfig()
      expect(config.basePath).toBeUndefined()
      // apiUrl should NOT include the basePath since it was cleared
      expect(config.apiUrl).toBe('http://localhost:4100')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('loadConfig does not duplicate basePath when apiUrl already includes it', () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-basepath-dup-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'apiUrl: http://localhost:4100/canonry\nbasePath: /canonry/\ndatabase: test.db\napiKey: cnry_test')

    try {
      const config = loadConfig()
      expect(config.apiUrl).toBe('http://localhost:4100/canonry')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand embeds CANONRY_PORT into saved apiUrl', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-init-port-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_PORT', '5555')

    try {
      await initCommand({ force: true, geminiKey: 'test-gemini-key', skipSkills: true })

      vi.stubEnv('CANONRY_PORT', undefined as unknown as string)
      const config = loadConfig()
      expect(config.apiUrl).toBe('http://127.0.0.1:5555')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('bootstrapCommand creates config and reconciles the default API key', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-bootstrap-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key')
    vi.stubEnv('CANONRY_API_KEY', 'cnry_bootstrap_key')
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-client-secret')

    try {
      await bootstrapCommand()

      let config = loadConfig()
      expect(config.database).toBe(path.join(tmpDir, 'data.db'))
      expect(config.apiUrl).toBe('http://127.0.0.1:4100')
      expect(config.apiKey).toBe('cnry_bootstrap_key')
      expect(config.providers?.gemini?.apiKey).toBe('test-gemini-key')
      expect(config.google?.clientId).toBe('google-client-id')
      expect(config.google?.clientSecret).toBe('google-client-secret')

      let db = createClient(config.database)
      let keys = db.select().from(apiKeys).all()
      expect(keys).toHaveLength(1)
      expect(keys[0]?.keyPrefix).toBe('cnry_boot')

      vi.stubEnv('CANONRY_API_KEY', 'cnry_force_key')
      await bootstrapCommand()

      config = loadConfig()
      expect(config.apiKey).toBe('cnry_force_key')

      db = createClient(config.database)
      keys = db.select().from(apiKeys).all()
      expect(keys).toHaveLength(1)
      expect(keys[0]?.keyPrefix).toBe('cnry_forc')

      // Reconciles env changes on restart (no --force needed)
      vi.stubEnv('CANONRY_API_KEY', 'cnry_rotated_key')
      vi.stubEnv('OPENAI_API_KEY', 'test-openai-key')
      await bootstrapCommand()

      config = loadConfig()
      expect(config.apiKey).toBe('cnry_rotated_key')
      expect(config.providers?.openai?.apiKey).toBe('test-openai-key')
      expect(config.providers?.gemini?.apiKey).toBe('test-gemini-key')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('bootstrapCommand rotates a grant-referenced default API key in place', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-bootstrap-key-fk-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key')
    vi.stubEnv('CANONRY_API_KEY', 'cnry_original_key')

    try {
      await bootstrapCommand()

      const config = loadConfig()
      const db = createClient(config.database)
      const defaultKey = db.select().from(apiKeys).all().find(key => key.name === 'default')!
      const now = new Date().toISOString()
      const approverKeyId = crypto.randomUUID()
      db.insert(apiKeys).values({
        id: 'legacy-duplicate-default-key',
        name: 'default',
        keyHash: crypto.createHash('sha256').update('cnry_legacy_duplicate').digest('hex'),
        keyPrefix: 'cnry_lega',
        scopes: ['*'],
        createdAt: now,
      }).run()
      db.insert(projects).values({
        id: 'project-bootstrap-key-fk',
        name: 'bootstrap-key-fk',
        displayName: 'Bootstrap key FK',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        createdAt: now,
        updatedAt: now,
      }).run()
      db.insert(apiKeys).values({
        id: approverKeyId,
        name: 'activation-approver',
        keyHash: crypto.createHash('sha256').update('cnry_activation_approver').digest('hex'),
        keyPrefix: 'cnry_acti',
        scopes: ['ads.approve'],
        projectId: 'project-bootstrap-key-fk',
        createdAt: now,
      }).run()
      db.insert(adsActivationGrants).values({
        id: 'grant-bootstrap-key-fk',
        projectId: 'project-bootstrap-key-fk',
        adAccountId: 'adacct_bootstrap',
        manifestHash: 'a'.repeat(64),
        manifest: {
          campaign: {
            id: 'cmpn_bootstrap',
            expectedUpdatedAt: 1,
            adGroups: [{
              id: 'adgrp_bootstrap',
              expectedUpdatedAt: 2,
              ads: [{ id: 'ad_bootstrap', expectedUpdatedAt: 3 }],
            }],
          },
        },
        executorApiKeyId: defaultKey.id,
        approverApiKeyId: approverKeyId,
        state: 'approved',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      }).run()

      vi.stubEnv('CANONRY_API_KEY', 'cnry_rotated_key')
      await bootstrapCommand()

      const defaultKeys = db.select().from(apiKeys).all().filter(key => key.name === 'default')
      expect(defaultKeys).toHaveLength(2)
      expect(defaultKeys.find(key => key.id === defaultKey.id)).toMatchObject({
        id: defaultKey.id,
        keyPrefix: 'cnry_rota',
        createdAt: defaultKey.createdAt,
        revokedAt: null,
      })
      expect(defaultKeys.find(key => key.id === 'legacy-duplicate-default-key')).toMatchObject({
        revokedAt: expect.any(String),
      })
      expect(db.select().from(adsActivationGrants).all()[0]?.executorApiKeyId).toBe(defaultKey.id)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reruns provider-free without changing custom paths or default-key usage state', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-bootstrap-idempotent-${crypto.randomUUID()}`)
    const configDir = path.join(tmpDir, 'config')
    const databasePath = path.join(tmpDir, 'custom.db')
    vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
    vi.stubEnv('CANONRY_DATABASE_PATH', databasePath)
    vi.stubEnv('CANONRY_API_URL', 'http://127.0.0.1:4999')
    vi.stubEnv('CANONRY_API_KEY', 'cnry_provider_free')
    for (const name of [
      'GEMINI_API_KEY',
      'GEMINI_VERTEX_PROJECT',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'PERPLEXITY_API_KEY',
      'MUSE_API_KEY',
      'LOCAL_BASE_URL',
    ]) {
      vi.stubEnv(name, undefined as unknown as string)
    }
    const output: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((value: unknown) => output.push(String(value)))

    try {
      await bootstrapCommand({ format: 'json' })
      const db = createClient(databasePath)
      const defaultKey = db.select().from(apiKeys).where(eq(apiKeys.name, 'default')).get()!
      const lastUsedAt = '2026-09-01T12:00:00.000Z'
      db.update(apiKeys).set({ lastUsedAt }).where(eq(apiKeys.id, defaultKey.id)).run()

      vi.stubEnv('CANONRY_DATABASE_PATH', undefined as unknown as string)
      vi.stubEnv('CANONRY_API_URL', undefined as unknown as string)
      output.length = 0
      await bootstrapCommand({ format: 'json' })

      expect(JSON.parse(output.at(-1)!)).toMatchObject({
        bootstrapped: true,
        status: 'unchanged',
        changed: false,
        databasePath,
        apiUrl: 'http://127.0.0.1:4999',
        providers: [],
      })
      const { nextSteps } = JSON.parse(output.at(-1)!) as { nextSteps: string[] }
      expect(nextSteps.join(' ')).toContain('GEMINI_API_KEY')
      expect(nextSteps.join(' ')).toContain('canonry settings provider gemini --api-key <key>')
      expect(nextSteps.join(' ')).toContain('never ask for it in chat')
      expect(loadConfig()).toMatchObject({
        database: databasePath,
        apiUrl: 'http://127.0.0.1:4999',
        providers: {},
      })
      expect(db.select().from(apiKeys).where(eq(apiKeys.id, defaultKey.id)).get()?.lastUsedAt).toBe(lastUsedAt)
    } finally {
      log.mockRestore()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('createServer returns a Fastify instance', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    // Insert a test API key
    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        geminiApiKey: 'test-key',
      },
      db,
      logger: false,
    })

    try {
      expect(app).toBeDefined()
      expect(app.listen).toBeTypeOf('function')
      expect(app.inject).toBeTypeOf('function')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('dashboard password setup and login flow protects the web UI', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-session-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const config: CanonryConfig = {
      apiUrl: 'http://localhost:4100',
      database: dbPath,
      apiKey: rawKey,
      geminiApiKey: 'test-key',
    }

    const app = await createServer({ config, db, logger: false })

    try {
      // API routes require auth
      const unauthRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
      })
      expect(unauthRes.statusCode).toBe(401)

      // Session check reports setup is required (no password yet)
      const preSetupSession = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
      })
      expect(preSetupSession.statusCode).toBe(200)
      const preSetup = JSON.parse(preSetupSession.body) as { authenticated: boolean; setupRequired: boolean }
      expect(preSetup.authenticated).toBe(false)
      expect(preSetup.setupRequired).toBe(true)

      // Setup rejects short passwords
      const shortPwRes = await app.inject({
        method: 'POST',
        url: '/api/v1/session/setup',
        payload: { password: 'short' },
      })
      expect(shortPwRes.statusCode).toBe(400)

      // Setup with valid password creates session
      const dashboardPassword = 'my-secure-dashboard-password'
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/session/setup',
        payload: { password: dashboardPassword },
      })
      expect(setupRes.statusCode).toBe(200)
      expect(JSON.parse(setupRes.body)).toEqual({ authenticated: true })

      const setupCookie = setupRes.headers['set-cookie']
      const cookieHeader = (Array.isArray(setupCookie) ? setupCookie[0] : setupCookie)?.split(';')[0]
      expect(cookieHeader).toContain('canonry_session=')

      // Password hash is persisted in config
      expect(config.dashboardPasswordHash).toBeTruthy()

      // Setup endpoint rejects second call (password already set)
      const doubleSetup = await app.inject({
        method: 'POST',
        url: '/api/v1/session/setup',
        payload: { password: 'another-password' },
      })
      expect(doubleSetup.statusCode).toBe(400)

      // Session cookie grants API access
      const authedRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { cookie: cookieHeader! },
      })
      expect(authedRes.statusCode).toBe(200)

      // HTML never contains the raw API key
      const htmlRes = await app.inject({
        method: 'GET',
        url: '/',
      })
      if (htmlRes.statusCode === 200) {
        expect(htmlRes.body).toContain('__CANONRY_CONFIG__')
      }
      expect(htmlRes.body).not.toContain(rawKey)

      // Logout invalidates the session
      const logoutRes = await app.inject({
        method: 'DELETE',
        url: '/api/v1/session',
        headers: { cookie: cookieHeader! },
      })
      expect(logoutRes.statusCode).toBe(204)

      const afterLogoutRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { cookie: cookieHeader! },
      })
      expect(afterLogoutRes.statusCode).toBe(401)

      // Login with password works after setup
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { password: dashboardPassword },
      })
      expect(loginRes.statusCode).toBe(200)
      expect(JSON.parse(loginRes.body)).toEqual({ authenticated: true })

      // Wrong password is rejected
      const badLoginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { password: 'wrong-password' },
      })
      expect(badLoginRes.statusCode).toBe(401)

      // Hash is stored in scrypt format (salted, slow KDF), not raw SHA-256
      expect(config.dashboardPasswordHash).toMatch(/^scrypt\$1\$/)
      // The on-disk format must NOT be a 64-char hex SHA-256 digest
      expect(config.dashboardPasswordHash).not.toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it.each([
    'native-restart', 'live-password-change', 'missing-file',
    'malformed-yaml', 'read-error', 'rename-error',
  ] as const)('dashboard login transparently migrates a legacy unsalted SHA-256 password hash to scrypt [%s]', async boundary => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-pw-migration-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    for (const key of ['CANONRY_PORT', 'CANONRY_BASE_PATH', 'CANONRY_EXTERNAL_MCP']) {
      vi.stubEnv(key, undefined as unknown as string)
    }
    vi.stubEnv('CANONRY_DASHBOARD_REQUIRE_PASSWORD', '1')
    vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
    vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
    vi.stubEnv('CANONRY_SENTIMENT_ENABLED', '0')

    const configPath = path.join(tmpDir, 'config.yaml')
    const dbPath = path.join(tmpDir, 'test.db')
    let db = createClient(dbPath)
    let app: Awaited<ReturnType<typeof createServer>> | undefined
    try {
      migrate(db)
      const startupKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
      const liveKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
      for (const rawKey of [startupKey, liveKey]) {
        db.insert(apiKeys).values({
          id: crypto.randomUUID(),
          name: 'migration-fixture',
          keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
          keyPrefix: rawKey.slice(0, 9),
          scopes: ['*'],
          createdAt: new Date().toISOString(),
        }).run()
      }

      const legacyPassword = 'legacy-password'
      const legacyHash = crypto.createHash('sha256').update(legacyPassword).digest('hex')
      const initial: Parameters<typeof createServer>[0]['config'] = {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: startupKey,
        anonymousId: 'startup-anonymous-id',
        dashboardPasswordHash: legacyHash,
        dashboard: { requirePassword: true },
        agent: { mode: 'disabled' },
        telemetry: false,
        sentiment: { enabled: false, apiKey: 'startup-sentiment-key' },
        providers: { openai: { apiKey: 'startup-openai-key' } },
        google: { clientId: 'startup-google-client', clientSecret: 'startup-google-secret', connections: [] },
      }
      if (boundary !== 'missing-file') {
        fs.writeFileSync(configPath, stringify(initial), { encoding: 'utf8', mode: 0o600 })
      }
      let config = boundary === 'missing-file' ? { ...initial } : loadConfig()
      app = await createServer({ config, db, logger: false })
      await app.ready()

      // A live operator change must survive a login using the startup snapshot.
      // Both stored keys are real native credentials, so restart remains valid.
      const live = {
        ...initial,
        apiKey: liveKey,
        anonymousId: 'live-anonymous-id',
        providers: { openai: { apiKey: 'live-openai-key' } },
        google: { clientId: 'live-google-client', clientSecret: 'live-google-secret', connections: [] },
        sentiment: { enabled: false, apiKey: 'live-sentiment-key' },
      }
      const rotatedPassword = 'rotated-live-password'
      if (boundary === 'live-password-change') {
        live.dashboardPasswordHash = crypto.createHash('sha256').update(rotatedPassword).digest('hex')
      }
      const expectedDisk = boundary === 'missing-file' ? initial : live
      if (boundary === 'malformed-yaml') {
        fs.writeFileSync(configPath, 'dashboardPasswordHash: [\n', 'utf8')
      } else if (boundary !== 'missing-file') {
        fs.writeFileSync(configPath, stringify(live), 'utf8')
      }
      const beforeLogin = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
      let loginPassword = legacyPassword

      const badLogin = await app.inject({
        method: 'POST', url: '/api/v1/session', payload: { password: 'not-the-password' },
      })
      expect(badLogin.statusCode).toBe(401)
      expect(badLogin.json()).toEqual({ error: { code: 'AUTH_INVALID', message: 'Incorrect password' } })
      expect(config.dashboardPasswordHash).toBe(legacyHash)
      if (beforeLogin === null) expect(fs.existsSync(configPath)).toBe(false)
      else expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeLogin)

      if (boundary === 'live-password-change') {
        const staleLogin = await app.inject({
          method: 'POST', url: '/api/v1/session', payload: { password: legacyPassword },
        })
        expect(staleLogin.statusCode).toBe(401)
        expect(staleLogin.json()).toEqual({ error: { code: 'AUTH_INVALID', message: 'Incorrect password' } })
        expect(staleLogin.cookies).toEqual([])
        expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeLogin)
        expect(config.dashboardPasswordHash).toBe(legacyHash)

        // New disk credentials remain usable through the actual reload path.
        await app.close()
        app = undefined
        config = loadConfig()
        expect(config.dashboardPasswordHash).toBe(live.dashboardPasswordHash)
        app = await createServer({ config, db, logger: false })
        await app.ready()
        loginPassword = rotatedPassword
      } else if (['malformed-yaml', 'read-error', 'rename-error'].includes(boundary)) {
        const ioFailure = boundary === 'read-error'
          ? vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw new Error('simulated config read failure') })
          : boundary === 'rename-error'
            ? vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('simulated config rename failure') })
            : undefined
        let failedLogin: typeof badLogin
        try {
          failedLogin = await app.inject({
            method: 'POST', url: '/api/v1/session', payload: { password: legacyPassword },
          })
          if (boundary === 'read-error') expect(ioFailure?.mock.calls[0]).toEqual([configPath, 'utf-8'])
          if (boundary === 'rename-error') expect(ioFailure?.mock.calls[0]?.[1]).toBe(configPath)
        } finally {
          ioFailure?.mockRestore()
        }
        expect(failedLogin.statusCode).toBe(500)
        expect(failedLogin.cookies).toEqual([])
        expect(config.dashboardPasswordHash).toBe(legacyHash)
        expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeLogin)
        expect(fs.readdirSync(tmpDir).filter(name => name.endsWith('.tmp'))).toEqual([])
        // Same-Host retry must recover after the disk/I/O problem is removed.
        if (boundary === 'malformed-yaml') fs.writeFileSync(configPath, stringify(live), 'utf8')
      }

      const goodLogin = await app.inject({
        method: 'POST', url: '/api/v1/session', payload: { password: loginPassword },
      })
      expect(goodLogin.statusCode).toBe(200)
      expect(goodLogin.json()).toEqual({ authenticated: true })
      const persisted = parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
      // First intended pre-fix failure: the real YAML still contains SHA-256.
      expect(persisted.dashboardPasswordHash).toMatch(/^scrypt\$1\$/)
      expect(persisted.dashboardPasswordHash).not.toBe(legacyHash)
      expect(config.dashboardPasswordHash).toBe(persisted.dashboardPasswordHash)
      expect(persisted).toEqual({ ...expectedDisk, dashboardPasswordHash: persisted.dashboardPasswordHash })
      expect(loadConfig().dashboardPasswordHash).toBe(persisted.dashboardPasswordHash)
      const cookie = goodLogin.cookies.find(value => value.name === 'canonry_session')
      expect(cookie).toBeDefined()
      const authorized = await app.inject({
        method: 'GET', url: '/api/v1/projects', headers: { cookie: `canonry_session=${cookie?.value}` },
      })
      expect(authorized.statusCode).toBe(200)
      expect(authorized.json()).toEqual([])

      const migratedBytes = fs.readFileSync(configPath, 'utf8')
      const secondLogin = await app.inject({
        method: 'POST', url: '/api/v1/session', payload: { password: loginPassword },
      })
      expect(secondLogin.statusCode).toBe(200)
      expect(fs.readFileSync(configPath, 'utf8')).toBe(migratedBytes)

      await app.close()
      app = undefined
      db.$client.close()
      db = createClient(dbPath)
      const restartedConfig = loadConfig()
      expect(restartedConfig.apiKey).toBe(expectedDisk.apiKey)
      app = await createServer({ config: restartedConfig, db, logger: false })
      const restartedGood = await app.inject({
        method: 'POST', url: '/api/v1/session', payload: { password: loginPassword },
      })
      expect(restartedGood.statusCode).toBe(200)
      expect(restartedGood.json()).toEqual({ authenticated: true })
      expect(fs.readFileSync(configPath, 'utf8')).toBe(migratedBytes)
      const restartedBad = await app.inject({
        method: 'POST', url: '/api/v1/session', payload: { password: 'not-the-password' },
      })
      expect(restartedBad.statusCode).toBe(401)
      expect(restartedBad.json()).toEqual({ error: { code: 'AUTH_INVALID', message: 'Incorrect password' } })
      expect(fs.readFileSync(configPath, 'utf8')).toBe(migratedBytes)
      if (boundary === 'live-password-change') {
        const oldSecret = await app.inject({
          method: 'POST', url: '/api/v1/session', payload: { password: legacyPassword },
        })
        expect(oldSecret.statusCode).toBe(401)
        expect(oldSecret.cookies).toEqual([])
        expect(fs.readFileSync(configPath, 'utf8')).toBe(migratedBytes)
      }
    } finally {
      await app?.close()
      if (db.$client.open) db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('isLoopbackBindHost classifies bind addresses', () => {
    // Loopback (only the local machine can reach the listener).
    expect(isLoopbackBindHost(undefined)).toBe(true)
    expect(isLoopbackBindHost('')).toBe(true)
    expect(isLoopbackBindHost('127.0.0.1')).toBe(true)
    expect(isLoopbackBindHost('127.5.6.7')).toBe(true)
    expect(isLoopbackBindHost('localhost')).toBe(true)
    expect(isLoopbackBindHost('::1')).toBe(true)
    expect(isLoopbackBindHost('[::1]')).toBe(true)
    // Exposed off-box — bind-all and specific interfaces.
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false)
    expect(isLoopbackBindHost('::')).toBe(false)
    expect(isLoopbackBindHost('192.168.1.10')).toBe(false)
    expect(isLoopbackBindHost('10.0.0.5')).toBe(false)
    expect(isLoopbackBindHost('203.0.113.7')).toBe(false)
  })

  it('API flow: create and get project via inject', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    // Insert a test API key
    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        geminiApiKey: 'test-key',
      },
      db,
      logger: false,
    })

    try {
      // Create project
      const createRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/test-project',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          displayName: 'Test Project',
          canonicalDomain: 'example.com',
          country: 'US',
          language: 'en',
        },
      })

      expect(createRes.statusCode).toBe(201)
      const created = JSON.parse(createRes.body) as { name: string; canonicalDomain: string }
      expect(created.name).toBe('test-project')
      expect(created.canonicalDomain).toBe('example.com')

      // Get project
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project',
        headers: { authorization: `Bearer ${rawKey}` },
      })

      expect(getRes.statusCode).toBe(200)
      const fetched = JSON.parse(getRes.body) as { name: string; canonicalDomain: string }
      expect(fetched.name).toBe('test-project')
      expect(fetched.canonicalDomain).toBe('example.com')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('API flow: update project settings via PUT', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        geminiApiKey: 'test-key',
      },
      db,
      logger: false,
    })

    try {
      // Create project
      const createRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/update-test',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          displayName: 'Original',
          canonicalDomain: 'original.com',
          country: 'US',
          language: 'en',
        },
      })
      expect(createRes.statusCode).toBe(201)

      // Update project with new settings including ownedDomains
      const updateRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/update-test',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          displayName: 'Updated Name',
          canonicalDomain: 'updated.com',
          ownedDomains: ['docs.updated.com', 'blog.updated.com'],
          country: 'GB',
          language: 'en-gb',
        },
      })
      expect(updateRes.statusCode).toBe(200)
      const updated = JSON.parse(updateRes.body) as {
        displayName: string
        canonicalDomain: string
        ownedDomains: string[]
        country: string
        language: string
      }
      expect(updated.displayName).toBe('Updated Name')
      expect(updated.canonicalDomain).toBe('updated.com')
      expect(updated.ownedDomains).toEqual(['docs.updated.com', 'blog.updated.com'])
      expect(updated.country).toBe('GB')
      expect(updated.language).toBe('en-gb')

      // Verify GET returns updated values
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/update-test',
        headers: { authorization: `Bearer ${rawKey}` },
      })
      const fetched = JSON.parse(getRes.body) as {
        displayName: string
        canonicalDomain: string
        ownedDomains: string[]
        country: string
      }
      expect(fetched.displayName).toBe('Updated Name')
      expect(fetched.canonicalDomain).toBe('updated.com')
      expect(fetched.ownedDomains).toEqual(['docs.updated.com', 'blog.updated.com'])
      expect(fetched.country).toBe('GB')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand non-interactive mode creates config from flags', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-init-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)

    try {
      await initCommand({
        force: true,
        geminiKey: 'test-gemini-key',
        openaiKey: 'test-openai-key',
        skipSkills: true,
      })

      const config = loadConfig()
      expect(config.database).toBe(path.join(tmpDir, 'data.db'))
      expect(config.providers?.gemini?.apiKey).toBe('test-gemini-key')
      expect(config.providers?.gemini?.model).toBe('gemini-flash-latest')
      expect(config.providers?.openai?.apiKey).toBe('test-openai-key')
      expect(config.providers?.openai?.model).toBe('gpt-5.4')
      expect(config.providers?.claude).toBeUndefined()
      expect(config.apiKey).toMatch(/^cnry_/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand non-interactive mode reads env vars as fallback', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-init-env-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-env')

    try {
      await initCommand({ force: true, skipSkills: true })

      const config = loadConfig()
      expect(config.providers?.claude?.apiKey).toBe('test-anthropic-env')
      expect(config.providers?.claude?.model).toBe('claude-sonnet-4-6')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand prints concrete next-steps so users do not bounce after install', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-init-nextsteps-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1') // suppress telemetry POST in tests

    const logs: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => logs.push(msg)

    try {
      await initCommand({
        force: true,
        geminiKey: 'test-gemini-key',
        skipSkills: true,
      })

      const output = logs.join('\n')
      // Init is optional provider provisioning; its handoff must still lead
      // with the provider-free Page Health activation path.
      expect(output).toMatch(/Next: canonry serve/)
      expect(output).toMatch(/canonry project create/)
      expect(output).toMatch(/canonry technical-aeo run/)
      expect(output).toMatch(/canonry technical-aeo score/)
      expect(output).toMatch(/AI Visibility is optional/)
      expect(output).not.toMatch(/5 guided steps/)
      expect(output).toMatch(/canonry doctor/)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand --format json includes nextSteps array for agents', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-init-json-nextsteps-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')

    const logs: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => logs.push(msg)

    try {
      await initCommand({
        force: true,
        geminiKey: 'test-gemini-key',
        skipSkills: true,
        format: 'json',
      })

      // Last logged line is the JSON payload.
      const jsonLine = logs.find(l => l.trim().startsWith('{'))
      expect(jsonLine).toBeTruthy()
      const payload = JSON.parse(jsonLine!) as { initialized: boolean; primaryNextStep?: string; nextSteps?: string[] }
      expect(payload.initialized).toBe(true)
      expect(payload.primaryNextStep).toBe('canonry serve')
      expect(Array.isArray(payload.nextSteps)).toBe(true)
      expect(payload.nextSteps!.some(s => s.includes('canonry project create'))).toBe(true)
      expect(payload.nextSteps!.some(s => s.includes('canonry technical-aeo run'))).toBe(true)
      expect(payload.nextSteps!.some(s => s.includes('AI Visibility is optional'))).toBe(true)
      // Off loopback or behind a proxy, setup from this machine needs the root
      // key too, so the guidance names the key rather than a place to stand.
      expect(payload.nextSteps!.some(s => s.includes('root API key (apiKey in config.yaml)'))).toBe(true)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand fires cli.init telemetry with structured post-init setup state', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-init-setup-state-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', undefined as unknown as string)
    vi.stubEnv('DO_NOT_TRACK', undefined as unknown as string)
    vi.stubEnv('CI', undefined as unknown as string)

    const captured: Array<Record<string, unknown>> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) {
        try { captured.push(JSON.parse(init.body as string)) } catch { /* ignore */ }
      }
      return new Response(JSON.stringify({ ok: true }))
    }

    try {
      await initCommand({
        force: true,
        geminiKey: 'test-gemini-key',
        googleClientId: 'gid',
        googleClientSecret: 'gsecret',
        skipSkills: true,
      })

      // Give fire-and-forget telemetry a tick.
      await new Promise(resolve => setTimeout(resolve, 50))

      const initEvent = captured.find(p => p.event === 'cli.init')
      expect(initEvent, 'expected a cli.init telemetry event').toBeTruthy()
      const props = initEvent!.properties as Record<string, unknown>
      expect(props.setup_state).toEqual({
        provider_count: 1,
        has_keywords: false,
        project_count: 0,
        is_first_run: false,
      })
      expect(props.googleConfigured).toBe(true)
      expect(props.agentConfigured).toBe(false)
      // Retained temporarily for existing reports while they migrate.
      expect(props.setupState).toBe('google|provider')
      expect(props.providerCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ApiClient gives clear error when server is not running', async () => {
    const client = new ApiClient('http://localhost:19999', 'cnry_fake_key')
    await expect(() => client.listProjects()).rejects.toThrow('Could not connect to canonry server')
    await expect(() => client.listProjects()).rejects.toThrow('canonry serve')
  })

  it('settings/google persists Google OAuth credentials to local config', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-google-settings-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)

    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
      },
      db,
      logger: false,
    })

    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/google',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
        },
      })

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ configured: true })

      const config = loadConfig()
      expect(config.google?.clientId).toBe('google-client-id')
      expect(config.google?.clientSecret).toBe('google-client-secret')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('settings/providers persists provider model changes to config and audit history', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-provider-settings-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)

    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        providers: {
          openai: {
            apiKey: 'sk-old',
            model: 'gpt-4o',
            quota: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
          },
        },
      },
      db,
      logger: false,
    })

    try {
      const createProjectRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/test-project',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          displayName: 'Test Project',
          canonicalDomain: 'example.com',
          country: 'US',
          language: 'en',
          providers: ['openai'],
        },
      })
      expect(createProjectRes.statusCode).toBe(201)

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/providers/openai',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          apiKey: 'sk-new',
          model: 'gpt-4.1',
        },
      })

      expect(res.statusCode).toBe(200)

      const config = loadConfig()
      expect(config.providers?.openai?.model).toBe('gpt-4.1')

      const historyRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/history',
        headers: { authorization: `Bearer ${rawKey}` },
      })
      expect(historyRes.statusCode).toBe(200)
      const historyEntries = JSON.parse(historyRes.body) as Array<{
        action: string
        entityType: string
        entityId: string | null
        diff: { before: { model: string | null } | null; after: { model: string | null } }
      }>
      const providerHistory = historyEntries.find(entry => entry.action === 'provider.updated' && entry.entityType === 'provider')
      expect(providerHistory).toBeDefined()
      expect(providerHistory!.entityId).toBe('openai')
      expect(providerHistory!.diff.before?.model).toBe('gpt-4o')
      expect(providerHistory!.diff.after.model).toBe('gpt-4.1')

      const entries = db.select().from(auditLog).all().filter(entry => entry.entityType === 'provider' && entry.projectId !== null)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('provider.updated')

      const diff = JSON.parse(entries[0]!.diff ?? 'null') as {
        before: { model: string | null }
        after: { model: string | null }
      }
      expect(diff.before.model).toBe('gpt-4o')
      expect(diff.after.model).toBe('gpt-4.1')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('settings/providers audits a baseUrl (endpoint) change for an API provider', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-provider-baseurl-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)

    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        providers: {
          gemini: {
            apiKey: 'g-key',
            model: 'gemini-2.5-flash',
            quota: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
          },
        },
      },
      db,
      logger: false,
    })

    try {
      const createProjectRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/test-project',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          displayName: 'Test Project',
          canonicalDomain: 'example.com',
          country: 'US',
          language: 'en',
          providers: ['gemini'],
        },
      })
      expect(createProjectRes.statusCode).toBe(201)

      // Repoint ONLY the endpoint (same key, same model). Before the fix this
      // produced no diff — gemini's baseUrl was dropped from the summary — so a
      // silent endpoint redirect left no audit trail.
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/providers/gemini',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          apiKey: 'g-key',
          baseUrl: 'https://proxy.example.com',
        },
      })
      expect(res.statusCode).toBe(200)

      const config = loadConfig()
      expect(config.providers?.gemini?.baseUrl).toBe('https://proxy.example.com')

      const historyRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/history',
        headers: { authorization: `Bearer ${rawKey}` },
      })
      expect(historyRes.statusCode).toBe(200)
      const historyEntries = JSON.parse(historyRes.body) as Array<{
        action: string
        entityType: string
        entityId: string | null
        diff: { before: { baseUrl: string | null } | null; after: { baseUrl: string | null } }
      }>
      const providerHistory = historyEntries.find(
        entry => entry.action === 'provider.updated' && entry.entityType === 'provider',
      )
      // The endpoint repoint MUST be audited.
      expect(providerHistory).toBeDefined()
      expect(providerHistory!.entityId).toBe('gemini')
      expect(providerHistory!.diff.before?.baseUrl ?? null).toBeNull()
      expect(providerHistory!.diff.after.baseUrl).toBe('https://proxy.example.com')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('settings/providers audits a key rotation without recording the key', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-provider-rotate-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)
    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()
    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        providers: {
          gemini: { apiKey: 'g-old-key', model: 'gemini-2.5-flash' },
          // A key read from OPENAI_API_KEY leaves the entry with an endpoint and no key.
          openai: { baseUrl: 'https://proxy.example.com/v1', model: 'gpt-5' },
        },
      },
      db,
      logger: false,
    })

    try {
      // Same model and endpoint: only the key changes, which the settings
      // summary leaves out. Run admission reads this row to let a replaced key
      // run again, so it must exist.
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/providers/gemini',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { apiKey: 'g-new-key' },
      })
      expect(res.statusCode).toBe(200)
      const fromEnv = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/providers/openai',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { apiKey: 'sk-new-key' },
      })
      expect(fromEnv.statusCode).toBe(200)

      const rows = db.select().from(auditLog).all().filter(entry => entry.entityType === 'provider')
      expect(rows.map(row => [row.action, row.entityId]).sort()).toEqual([['provider.updated', 'gemini'], ['provider.updated', 'openai']])
      for (const row of rows) {
        expect(JSON.parse(row.diff ?? 'null')).toMatchObject({ apiKeyRotated: true })
        expect(row.diff).not.toMatch(/g-old-key|g-new-key|sk-new-key/)
      }
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('SPA deep-link serves index.html with <base href> so relative assets resolve', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-spa-base-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: { apiUrl: 'http://localhost:4100', database: dbPath, apiKey: rawKey },
      db,
      logger: false,
    })

    try {
      const deepRes = await app.inject({ method: 'GET', url: '/projects/ainyc' })
      // Test only runs meaningfully when the bundled SPA is present.
      if (deepRes.statusCode !== 200) return
      expect(deepRes.headers['content-type']).toContain('text/html')
      expect(deepRes.body).toContain('<base href="/">')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('SPA with basePath serves <base href> pointing at the basePath', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-spa-base-prefix-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        basePath: '/canonry/',
        database: dbPath,
        apiKey: rawKey,
      },
      db,
      logger: false,
    })

    try {
      const deepRes = await app.inject({ method: 'GET', url: '/canonry/projects/ainyc' })
      if (deepRes.statusCode !== 200) return
      expect(deepRes.headers['content-type']).toContain('text/html')
      expect(deepRes.body).toContain('<base href="/canonry/">')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('health endpoint returns ok and omits commit and instance when the env is unset', async () => {
    vi.stubEnv('CANONRY_COMMIT', undefined)
    vi.stubEnv('CANONRY_INSTANCE', undefined)
    vi.stubEnv('CANONRY_INSTANCE_ROLE', undefined)
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        geminiApiKey: 'test-key',
      },
      db,
      logger: false,
    })

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as {
        status: string
        service: string
        version: string
        commit?: string
        instance?: { name: string; role?: string }
        basePath?: string
      }
      expect(body.status).toBe('ok')
      expect(body.service).toBe('canonry')
      expect(body.version).toBe(PKG_VERSION)
      expect(body.commit).toBeUndefined()
      expect(body.instance).toBeUndefined()
      expect(body.basePath).toBeUndefined()
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('health endpoint reports commit and instance identity from the env', async () => {
    // Unbundled source carries no tsup build stamp, so CANONRY_COMMIT is the
    // path a test can reach; the stamp source is covered in instance-identity.test.ts.
    vi.stubEnv('CANONRY_COMMIT', 'eed745d5c1f0a4b6e2d8c9a7b3f1e0d2c4b6a8f0')
    vi.stubEnv('CANONRY_INSTANCE', 'acme-demo')
    vi.stubEnv('CANONRY_INSTANCE_ROLE', 'client-demo')
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        geminiApiKey: 'test-key',
      },
      db,
      logger: false,
    })

    try {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as {
        status: string
        commit?: string
        instance?: { name: string; role?: string }
      }
      expect(body.status).toBe('ok')
      expect(body.commit).toBe('eed745d5c1f0a4b6e2d8c9a7b3f1e0d2c4b6a8f0')
      expect(body.instance).toEqual({ name: 'acme-demo', role: 'client-demo' })
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('health endpoint includes basePath when configured', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        basePath: '/canonry/',
        database: dbPath,
        apiKey: rawKey,
      },
      db,
      logger: false,
    })

    try {
      // Root /health should include basePath
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { status: string; basePath?: string }
      expect(body.status).toBe('ok')
      expect(body.basePath).toBe('/canonry')

      // basePath-prefixed /health should also work
      const res2 = await app.inject({ method: 'GET', url: '/canonry/health' })
      expect(res2.statusCode).toBe(200)
      const body2 = JSON.parse(res2.body) as { basePath?: string }
      expect(body2.basePath).toBe('/canonry')

      // API routes should be mounted under basePath
      const res3 = await app.inject({
        method: 'GET',
        url: '/canonry/api/v1/projects',
        headers: { Authorization: `Bearer ${rawKey}` },
      })
      expect(res3.statusCode).toBe(200)
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ApiClient auto-discovers basePath from health endpoint', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        basePath: '/canonry/',
        database: dbPath,
        apiKey: rawKey,
      },
      db,
      logger: false,
    })

    try {
      // Start the server on a random port
      const address = await app.listen({ port: 0, host: '127.0.0.1' })

      // Create a client pointing at the server's origin WITHOUT basePath.
      // skipProbe defaults to false, so the client should auto-discover /canonry
      // from the /health endpoint.
      const client = new ApiClient(address, rawKey)
      const projects = await client.listProjects()
      expect(Array.isArray(projects)).toBe(true)
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ApiClient keeps analytics, visibility stats, and bounded Technical AEO reads under /api/v1 for an external base URL', async () => {
    const fakeFetch = vi.fn(async (_request: Request) =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fakeFetch)

    const client = new ApiClient('https://example.test/canonry', 'cnry_test', { skipProbe: true })
    await client.getVisibilityStats('acme')
    await client.getAnalyticsMetrics('acme')
    await client.getAnalyticsGaps('acme')
    await client.getAnalyticsSources('acme')
    await client.getTechnicalAeoScore('acme')
    await client.getTechnicalAeoProgress('acme', 'run-1')
    await client.getTechnicalAeoCrawl('acme', { runId: 'run-1' })
    await client.getSiteHealthSubgraph('acme', { nodeKey: 'page:root', hops: 2, maxNodes: 25, maxEdges: 50 })
    await client.getSiteHealthPath('acme', { fromNodeKey: 'page:root', toUrl: 'https://acme.test/pricing', maxDepth: 8 })
    await client.getSiteHealthChanges('acme', { fromRunId: 'run-1', toRunId: 'run-2', scope: 'pages', change: 'changed', cursor: 'changes-2', limit: 25 })
    await client.getTechnicalAeoCrawlPages('acme', { inventoryEligible: true, limit: 25, cursor: 'page-2' })
    await client.getTechnicalAeoStructure('acme', { parentPath: '/guides', limit: 20 })
    await client.getTechnicalAeoInternalLinks('acme', { followable: false, limit: 20 })
    await client.getTechnicalAeoInternalLinkNeighbors('acme', { nodeKey: 'node-1', limit: 20 })
    await client.getTechnicalAeoDeadLinks('acme', { limit: 20 })

    expect(fakeFetch.mock.calls.map(([request]) => request.url)).toEqual([
      'https://example.test/canonry/api/v1/projects/acme/visibility-stats',
      'https://example.test/canonry/api/v1/projects/acme/analytics/metrics',
      'https://example.test/canonry/api/v1/projects/acme/analytics/gaps',
      'https://example.test/canonry/api/v1/projects/acme/analytics/sources',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/runs/run-1/progress',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/crawl?runId=run-1',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/subgraph?nodeKey=page%3Aroot&hops=2&maxNodes=25&maxEdges=50',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/path?fromNodeKey=page%3Aroot&toUrl=https%3A%2F%2Facme.test%2Fpricing&maxDepth=8',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/changes?fromRunId=run-1&toRunId=run-2&scope=pages&change=changed&cursor=changes-2&limit=25',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/crawl/pages?inventoryEligible=true&cursor=page-2&limit=25',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/structure?parentPath=%2Fguides&limit=20',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/internal-links?followable=false&limit=20',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/internal-links/neighbors?nodeKey=node-1&limit=20',
      'https://example.test/canonry/api/v1/projects/acme/technical-aeo/dead-links?limit=20',
    ])
  })

  it('ApiClient scopes analytics sources to one run and class and sends includeByQuery only when set', async () => {
    const fakeFetch = vi.fn(async (_request: Request) =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fakeFetch)

    const client = new ApiClient('https://example.test/canonry', 'cnry_test', { skipProbe: true })
    await client.getAnalyticsSources('acme', { window: '30d', limit: 10, runId: 'run-1', queryClass: 'non-brand', includeByQuery: false })
    await client.getAnalyticsSources('acme', { includeByQuery: true })
    await client.getAnalyticsSources('acme', { queryClass: 'branded' })

    expect(fakeFetch.mock.calls.map(([request]) => request.url)).toEqual([
      'https://example.test/canonry/api/v1/projects/acme/analytics/sources?window=30d&limit=10&runId=run-1&queryClass=non-brand&includeByQuery=false',
      'https://example.test/canonry/api/v1/projects/acme/analytics/sources?includeByQuery=true',
      'https://example.test/canonry/api/v1/projects/acme/analytics/sources?queryClass=branded',
    ])
  })

  it('ApiClient reports an HTML SPA fallback as a response-format error', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('<!doctype html><html><body>Canonry</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    )
    vi.stubGlobal('fetch', fakeFetch)

    const client = new ApiClient('https://example.test/canonry', 'cnry_test', { skipProbe: true })

    await expect(client.getVisibilityStats('acme')).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE_FORMAT',
      exitCode: 2,
      details: {
        requestUrl: 'https://example.test/canonry/api/v1/projects/acme/visibility-stats',
        contentType: 'text/html; charset=utf-8',
        httpStatus: 200,
      },
    })
  })

  it('openapi endpoint is public and reports the Canonry version', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        geminiApiKey: 'test-key',
      },
      db,
      logger: false,
    })

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/openapi.json',
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as {
        info: { version: string }
        paths: Record<string, Record<string, { security?: unknown[] }>>
      }

      expect(body.info.version).toBe(PKG_VERSION)
      expect(body.paths['/api/v1/projects/{name}']).toBeDefined()
      expect(body.paths['/api/v1/openapi.json']?.get?.security).toEqual([])
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
