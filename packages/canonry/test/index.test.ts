import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, auditLog } from '@ainyc/canonry-db'
import { bootstrapCommand } from '../src/commands/bootstrap.js'
import { initCommand } from '../src/commands/init.js'
import { getConfigDir, loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'

const _require = createRequire(import.meta.url)
const { version: PKG_VERSION } = _require('../package.json') as { version: string }

function restoreEnvVar(name: string, originalValue: string | undefined) {
  if (originalValue === undefined) {
    delete process.env[name]
    return
  }

  process.env[name] = originalValue
}

describe('canonry', () => {
  it('loadConfig throws when no config exists', () => {
    // Override HOME to a temp dir so config won't be found
    const originalHome = process.env.HOME
    const tmpDir = path.join(os.tmpdir(), `canonry-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    process.env.HOME = tmpDir

    try {
      assert.throws(() => loadConfig(), {
        message: /Config not found/,
      })
    } finally {
      process.env.HOME = originalHome
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('getConfigDir honors CANONRY_CONFIG_DIR', () => {
    const originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = '/tmp/canonry-custom'

    try {
      assert.equal(getConfigDir(), '/tmp/canonry-custom')
    } finally {
      restoreEnvVar('CANONRY_CONFIG_DIR', originalConfigDir)
    }
  })

  it('bootstrapCommand creates config and replaces the default API key on force', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-bootstrap-${crypto.randomUUID()}`)
    const originalConfigDir = process.env.CANONRY_CONFIG_DIR
    const originalGeminiApiKey = process.env.GEMINI_API_KEY
    const originalOpenaiApiKey = process.env.OPENAI_API_KEY
    const originalCanonryApiKey = process.env.CANONRY_API_KEY
    const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID
    const originalGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET

    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    process.env.CANONRY_API_KEY = 'cnry_bootstrap_key'
    process.env.GOOGLE_CLIENT_ID = 'google-client-id'
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret'

    try {
      await bootstrapCommand({ force: true })

      let config = loadConfig()
      assert.equal(config.database, path.join(tmpDir, 'data.db'))
      assert.equal(config.apiKey, 'cnry_bootstrap_key')
      assert.equal(config.providers?.gemini?.apiKey, 'test-gemini-key')
      assert.equal(config.google?.clientId, 'google-client-id')
      assert.equal(config.google?.clientSecret, 'google-client-secret')

      let db = createClient(config.database)
      let keys = db.select().from(apiKeys).all()
      assert.equal(keys.length, 1)
      assert.equal(keys[0]?.keyPrefix, 'cnry_boot')

      process.env.CANONRY_API_KEY = 'cnry_force_key'
      await bootstrapCommand({ force: true })

      config = loadConfig()
      assert.equal(config.apiKey, 'cnry_force_key')

      db = createClient(config.database)
      keys = db.select().from(apiKeys).all()
      assert.equal(keys.length, 1)
      assert.equal(keys[0]?.keyPrefix, 'cnry_forc')

      // Reconciles env changes on restart (no --force needed)
      process.env.CANONRY_API_KEY = 'cnry_rotated_key'
      process.env.OPENAI_API_KEY = 'test-openai-key'
      await bootstrapCommand()

      config = loadConfig()
      assert.equal(config.apiKey, 'cnry_rotated_key')
      assert.equal(config.providers?.openai?.apiKey, 'test-openai-key')
      assert.equal(config.providers?.gemini?.apiKey, 'test-gemini-key')
    } finally {
      restoreEnvVar('CANONRY_CONFIG_DIR', originalConfigDir)
      restoreEnvVar('GEMINI_API_KEY', originalGeminiApiKey)
      restoreEnvVar('OPENAI_API_KEY', originalOpenaiApiKey)
      restoreEnvVar('CANONRY_API_KEY', originalCanonryApiKey)
      restoreEnvVar('GOOGLE_CLIENT_ID', originalGoogleClientId)
      restoreEnvVar('GOOGLE_CLIENT_SECRET', originalGoogleClientSecret)
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
      scopes: '["*"]',
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
      assert.ok(app)
      assert.ok(typeof app.listen === 'function')
      assert.ok(typeof app.inject === 'function')
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
      scopes: '["*"]',
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

      assert.equal(createRes.statusCode, 201)
      const created = JSON.parse(createRes.body) as { name: string; canonicalDomain: string }
      assert.equal(created.name, 'test-project')
      assert.equal(created.canonicalDomain, 'example.com')

      // Get project
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project',
        headers: { authorization: `Bearer ${rawKey}` },
      })

      assert.equal(getRes.statusCode, 200)
      const fetched = JSON.parse(getRes.body) as { name: string; canonicalDomain: string }
      assert.equal(fetched.name, 'test-project')
      assert.equal(fetched.canonicalDomain, 'example.com')
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
      scopes: '["*"]',
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
      assert.equal(createRes.statusCode, 201)

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
      assert.equal(updateRes.statusCode, 200)
      const updated = JSON.parse(updateRes.body) as {
        displayName: string
        canonicalDomain: string
        ownedDomains: string[]
        country: string
        language: string
      }
      assert.equal(updated.displayName, 'Updated Name')
      assert.equal(updated.canonicalDomain, 'updated.com')
      assert.deepEqual(updated.ownedDomains, ['docs.updated.com', 'blog.updated.com'])
      assert.equal(updated.country, 'GB')
      assert.equal(updated.language, 'en-gb')

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
      assert.equal(fetched.displayName, 'Updated Name')
      assert.equal(fetched.canonicalDomain, 'updated.com')
      assert.deepEqual(fetched.ownedDomains, ['docs.updated.com', 'blog.updated.com'])
      assert.equal(fetched.country, 'GB')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand non-interactive mode creates config from flags', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-init-${crypto.randomUUID()}`)
    const originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    try {
      await initCommand({
        force: true,
        geminiKey: 'test-gemini-key',
        openaiKey: 'test-openai-key',
      })

      const config = loadConfig()
      assert.equal(config.database, path.join(tmpDir, 'data.db'))
      assert.equal(config.providers?.gemini?.apiKey, 'test-gemini-key')
      assert.equal(config.providers?.gemini?.model, 'gemini-3-flash')
      assert.equal(config.providers?.openai?.apiKey, 'test-openai-key')
      assert.equal(config.providers?.openai?.model, 'gpt-5.4')
      assert.equal(config.providers?.claude, undefined)
      assert.ok(config.apiKey.startsWith('cnry_'))
    } finally {
      restoreEnvVar('CANONRY_CONFIG_DIR', originalConfigDir)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('initCommand non-interactive mode reads env vars as fallback', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-init-env-${crypto.randomUUID()}`)
    const originalConfigDir = process.env.CANONRY_CONFIG_DIR
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-env'

    try {
      await initCommand({ force: true })

      const config = loadConfig()
      assert.equal(config.providers?.claude?.apiKey, 'test-anthropic-env')
      assert.equal(config.providers?.claude?.model, 'claude-sonnet-4-6')
    } finally {
      restoreEnvVar('CANONRY_CONFIG_DIR', originalConfigDir)
      restoreEnvVar('ANTHROPIC_API_KEY', originalAnthropicKey)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ApiClient gives clear error when server is not running', async () => {
    const client = new ApiClient('http://localhost:19999', 'cnry_fake_key')
    await assert.rejects(
      () => client.listProjects(),
      (err: Error) => {
        assert.ok(err.message.includes('Could not connect to canonry server'))
        assert.ok(err.message.includes('canonry serve'))
        return true
      },
    )
  })

  it('settings/google persists Google OAuth credentials to local config', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-google-settings-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    const originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

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
      scopes: '["*"]',
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

      assert.equal(res.statusCode, 200)
      assert.deepEqual(JSON.parse(res.body), { configured: true })

      const config = loadConfig()
      assert.equal(config.google?.clientId, 'google-client-id')
      assert.equal(config.google?.clientSecret, 'google-client-secret')
    } finally {
      await app.close()
      restoreEnvVar('CANONRY_CONFIG_DIR', originalConfigDir)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('settings/providers persists provider model changes to config and audit history', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-provider-settings-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    const originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

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
      scopes: '["*"]',
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
      assert.equal(createProjectRes.statusCode, 201)

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/providers/openai',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          apiKey: 'sk-new',
          model: 'gpt-4.1',
        },
      })

      assert.equal(res.statusCode, 200)

      const config = loadConfig()
      assert.equal(config.providers?.openai?.model, 'gpt-4.1')

      const historyRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/history',
        headers: { authorization: `Bearer ${rawKey}` },
      })
      assert.equal(historyRes.statusCode, 200)
      const historyEntries = JSON.parse(historyRes.body) as Array<{
        action: string
        entityType: string
        entityId: string | null
        diff: { before: { model: string | null } | null; after: { model: string | null } }
      }>
      const providerHistory = historyEntries.find(entry => entry.action === 'provider.updated' && entry.entityType === 'provider')
      assert.ok(providerHistory)
      assert.equal(providerHistory!.entityId, 'openai')
      assert.equal(providerHistory!.diff.before?.model, 'gpt-4o')
      assert.equal(providerHistory!.diff.after.model, 'gpt-4.1')

      const entries = db.select().from(auditLog).all().filter(entry => entry.entityType === 'provider' && entry.projectId !== null)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.action, 'provider.updated')

      const diff = JSON.parse(entries[0]!.diff ?? 'null') as {
        before: { model: string | null }
        after: { model: string | null }
      }
      assert.equal(diff.before.model, 'gpt-4o')
      assert.equal(diff.after.model, 'gpt-4.1')
    } finally {
      await app.close()
      restoreEnvVar('CANONRY_CONFIG_DIR', originalConfigDir)
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
      scopes: '["*"]',
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
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body) as { status: string }
      assert.equal(body.status, 'ok')
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
      scopes: '["*"]',
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

      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body) as {
        info: { version: string }
        paths: Record<string, Record<string, { security?: unknown[] }>>
      }

      assert.equal(body.info.version, PKG_VERSION)
      assert.ok(body.paths['/api/v1/projects/{name}'])
      assert.deepEqual(body.paths['/api/v1/openapi.json']?.get?.security, [])
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
