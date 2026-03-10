import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

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
})
