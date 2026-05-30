import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { BingConnectionRecord, BingConnectionStore } from '../src/bing.js'

function createMemoryStore(): BingConnectionStore & { connections: Map<string, BingConnectionRecord> } {
  const connections = new Map<string, BingConnectionRecord>()
  return {
    connections,
    getConnection: (domain) => connections.get(domain.toLowerCase()),
    upsertConnection: (record) => {
      connections.set(record.domain.toLowerCase(), record)
      return record
    },
    updateConnection: (domain, patch) => {
      const existing = connections.get(domain.toLowerCase())
      if (!existing) return undefined
      const next = { ...existing, ...patch }
      connections.set(domain.toLowerCase(), next)
      return next
    },
    deleteConnection: (domain) => connections.delete(domain.toLowerCase()),
  }
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-bing-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'proj-1',
    name: 'acme',
    displayName: 'Acme',
    canonicalDomain: 'acme.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  const store = createMemoryStore()
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    bingConnectionStore: store,
    allowLoopbackWebhooks: true,
  })
  return { app, db, store, tmpDir, dbPath }
}

const VALID_REQUEST = {
  project_slug: 'acme',
  api_key: 'bing-api-key-deadbeef',
  site_url: 'https://acme.com/',
}

let app: FastifyInstance
// `_db` is assigned per-test so the in-memory DB is rebuilt; the body assertions
// route through the `store` decorator, not direct DB queries.
let _db: ReturnType<typeof createClient>
let store: ReturnType<typeof createMemoryStore>
let tmpDir: string

describe('POST /api/v1/cloud/bing/import-key', () => {
  beforeEach(async () => {
    process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP = '1'
    const ctx = buildApp()
    app = ctx.app
    _db = ctx.db
    store = ctx.store
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterEach(async () => {
    delete process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('upserts a Bing connection on happy path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bing/import-key',
      headers: { 'X-Admin-Scope': '1' },
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toEqual({
      imported: true,
      domain: 'acme.com',
      site_url: 'https://acme.com/',
    })

    const stored = store.getConnection('acme.com')
    expect(stored).toBeDefined()
    expect(stored?.apiKey).toBe(VALID_REQUEST.api_key)
    expect(stored?.siteUrl).toBe(VALID_REQUEST.site_url)
  })

  it('rejects request without X-Admin-Scope header with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bing/import-key',
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects unknown project with 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bing/import-key',
      headers: { 'X-Admin-Scope': '1' },
      payload: { ...VALID_REQUEST, project_slug: 'no-such-project' },
    })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('rejects malformed body with 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bing/import-key',
      headers: { 'X-Admin-Scope': '1' },
      payload: { project_slug: 'acme' }, // missing api_key + site_url
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('POST /api/v1/cloud/bing/import-key with flag unset', () => {
  beforeEach(async () => {
    delete process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP
    const ctx = buildApp()
    app = ctx.app
    _db = ctx.db
    store = ctx.store
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 404 when flag is unset, even with admin scope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bing/import-key',
      headers: { 'X-Admin-Scope': '1' },
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(404)
  })
})
