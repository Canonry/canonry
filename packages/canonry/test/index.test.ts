import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, auditLog } from '@ainyc/canonry-db'
import { bootstrapCommand } from '../src/commands/bootstrap.js'
import { initCommand } from '../src/commands/init.js'
import { getConfigDir, loadConfig } from '../src/config.js'
import { createServer, isLoopbackBindHost } from '../src/server.js'
import { ApiClient } from '../src/client.js'

const _require = createRequire(import.meta.url)
const { version: PKG_VERSION } = _require('../package.json') as { version: string }

describe('canonry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
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
      expect(config.apiUrl).toBe('http://localhost:5555')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('bootstrapCommand creates config and replaces the default API key on force', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-bootstrap-${crypto.randomUUID()}`)
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key')
    vi.stubEnv('CANONRY_API_KEY', 'cnry_bootstrap_key')
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-client-secret')

    try {
      await bootstrapCommand({ force: true })

      let config = loadConfig()
      expect(config.database).toBe(path.join(tmpDir, 'data.db'))
      expect(config.apiKey).toBe('cnry_bootstrap_key')
      expect(config.providers?.gemini?.apiKey).toBe('test-gemini-key')
      expect(config.google?.clientId).toBe('google-client-id')
      expect(config.google?.clientSecret).toBe('google-client-secret')

      let db = createClient(config.database)
      let keys = db.select().from(apiKeys).all()
      expect(keys).toHaveLength(1)
      expect(keys[0]?.keyPrefix).toBe('cnry_boot')

      vi.stubEnv('CANONRY_API_KEY', 'cnry_force_key')
      await bootstrapCommand({ force: true })

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

    const config = {
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

  it('dashboard login transparently migrates a legacy unsalted SHA-256 password hash to scrypt', async () => {
    // Simulate an install upgraded from a pre-scrypt build by pre-populating
    // config.dashboardPasswordHash with the legacy SHA-256 hex format. The
    // first successful login should accept it (so users aren't locked out)
    // and rewrite the config with a fresh scrypt-format hash.
    const tmpDir = path.join(os.tmpdir(), `canonry-pw-migration-${crypto.randomUUID()}`)
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

    const legacyPassword = 'legacy-password'
    // Legacy storage: raw SHA-256 hex, no salt.
    const legacyHash = crypto.createHash('sha256').update(legacyPassword).digest('hex')
    const config = {
      apiUrl: 'http://localhost:4100',
      database: dbPath,
      apiKey: rawKey,
      geminiApiKey: 'test-key',
      dashboardPasswordHash: legacyHash,
    }
    const app = await createServer({ config, db, logger: false })

    try {
      // Wrong password still rejected on legacy format.
      const badLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { password: 'not-the-password' },
      })
      expect(badLogin.statusCode).toBe(401)
      // Wrong attempt must not rewrite the stored hash.
      expect(config.dashboardPasswordHash).toBe(legacyHash)

      // Correct password is accepted AND triggers rehash.
      const goodLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { password: legacyPassword },
      })
      expect(goodLogin.statusCode).toBe(200)
      expect(config.dashboardPasswordHash).toMatch(/^scrypt\$1\$/)
      expect(config.dashboardPasswordHash).not.toBe(legacyHash)

      // Next login uses the fresh scrypt hash and still works.
      const secondLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { password: legacyPassword },
      })
      expect(secondLogin.statusCode).toBe(200)
    } finally {
      await app.close()
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

  it('first-run /session/setup requires the API key when the server is bound off-box', async () => {
    // A non-loopback bind means an unauthenticated remote first-visitor could
    // otherwise claim a full-access `*` session. Setup must demand the bearer key.
    const tmpDir = path.join(os.tmpdir(), `canonry-setup-gate-${crypto.randomUUID()}`)
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

    const config = {
      apiUrl: 'http://localhost:4100',
      database: dbPath,
      apiKey: rawKey,
      geminiApiKey: 'test-key',
    }
    // Bind to all interfaces — the exposed configuration.
    const app = await createServer({ config, db, logger: false, host: '0.0.0.0' })

    try {
      // Unauthenticated setup is rejected (the pre-auth escalation is closed).
      const unauth = await app.inject({
        method: 'POST',
        url: '/api/v1/session/setup',
        payload: { password: 'a-strong-password' },
      })
      expect(unauth.statusCode).toBe(401)
      // No password was written.
      expect((config as { dashboardPasswordHash?: string }).dashboardPasswordHash).toBeFalsy()

      // An invalid bearer key is still rejected.
      const badKey = await app.inject({
        method: 'POST',
        url: '/api/v1/session/setup',
        headers: { authorization: 'Bearer cnry_not_a_real_key' },
        payload: { password: 'a-strong-password' },
      })
      expect(badKey.statusCode).toBe(401)

      // With the valid bearer key, setup proceeds.
      const ok = await app.inject({
        method: 'POST',
        url: '/api/v1/session/setup',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { password: 'a-strong-password' },
      })
      expect(ok.statusCode).toBe(200)
      expect((config as { dashboardPasswordHash?: string }).dashboardPasswordHash).toBeTruthy()
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
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
      expect(config.providers?.gemini?.model).toBe('gemini-2.5-flash')
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
      // The user must see how to create a project, add a query, and run a sweep.
      // These are the three steps that determine whether init translates into
      // a successful first sweep — too many users today bounce after init
      // because the next move isn't obvious.
      expect(output).toMatch(/canonry project create/)
      expect(output).toMatch(/canonry query add/)
      expect(output).toMatch(/canonry run /)
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
      const payload = JSON.parse(jsonLine!) as { initialized: boolean; nextSteps?: string[] }
      expect(payload.initialized).toBe(true)
      expect(Array.isArray(payload.nextSteps)).toBe(true)
      expect(payload.nextSteps!.some(s => s.includes('canonry project create'))).toBe(true)
      expect(payload.nextSteps!.some(s => s.includes('canonry run'))).toBe(true)
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand fires cli.init telemetry with setupState reflecting configured surfaces', async () => {
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
      // The install funnel uses setupState to slice "configured a provider" cohorts.
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

  it('health endpoint returns ok', async () => {
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
      const body = JSON.parse(res.body) as { status: string; basePath?: string }
      expect(body.status).toBe('ok')
      expect(body.basePath).toBeUndefined()
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
