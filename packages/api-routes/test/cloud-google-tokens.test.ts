import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'

/**
 * In-memory `GoogleConnectionStore` matching the interface canonry's
 * real config-backed store implements. Suitable for tests that exercise
 * the cloud import path without writing to disk.
 */
function createMemoryStore(): GoogleConnectionStore & { connections: Map<string, GoogleConnectionRecord> } {
  const connections = new Map<string, GoogleConnectionRecord>()
  const key = (domain: string, type: 'gsc' | 'ga4') => `${domain.toLowerCase()}:${type}`
  return {
    connections,
    listConnections: (domain: string) =>
      [...connections.values()].filter((c) => c.domain.toLowerCase() === domain.toLowerCase()),
    getConnection: (domain: string, type: 'gsc' | 'ga4') => connections.get(key(domain, type)),
    upsertConnection: (record: GoogleConnectionRecord) => {
      connections.set(key(record.domain, record.connectionType), record)
      return record
    },
    updateConnection: (domain, type, patch) => {
      const existing = connections.get(key(domain, type))
      if (!existing) return undefined
      const next = { ...existing, ...patch }
      connections.set(key(domain, type), next)
      return next
    },
    deleteConnection: (domain, type) => connections.delete(key(domain, type)),
  }
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-google-test-'))
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
    googleConnectionStore: store,
    googleStateSecret: 'test-state-secret-deadbeef',
    allowLoopbackWebhooks: true,
  })
  return { app, db, store, tmpDir, dbPath }
}

const VALID_REQUEST = {
  project_slug: 'acme',
  connection_type: 'gsc' as const,
  property_ref: 'sc-domain:acme.com',
  access_token: 'ya29.access-token',
  refresh_token: '1//refresh-token',
  expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  account_email: 'owner@acme.com',
}

let app: FastifyInstance
// `_db` is assigned per-test for symmetry with cloud-bing-key.test.ts; assertions
// route through the `store` decorator, not direct DB queries.
let _db: ReturnType<typeof createClient>
let store: ReturnType<typeof createMemoryStore>
let tmpDir: string

describe('POST /api/v1/cloud/google/import-tokens', () => {
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

  it('upserts a Google connection on happy path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/google/import-tokens',
      headers: { 'X-Admin-Scope': '1' },
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toEqual({
      imported: true,
      domain: 'acme.com',
      connection_type: 'gsc',
      property_ref: 'sc-domain:acme.com',
    })

    const stored = store.getConnection('acme.com', 'gsc')
    expect(stored).toBeDefined()
    expect(stored?.accessToken).toBe(VALID_REQUEST.access_token)
    expect(stored?.refreshToken).toBe(VALID_REQUEST.refresh_token)
    expect(stored?.tokenExpiresAt).toBe(VALID_REQUEST.expiry)
    expect(stored?.propertyId).toBe('sc-domain:acme.com')
    expect(stored?.scopes).toEqual(VALID_REQUEST.scopes)
  })

  it('accepts the exact payload canonry-cloud sends after its OAuth callback (empty property_ref + account_email)', async () => {
    // Fixture parity with canonry-cloud `src/oauth/routes.ts` — the control
    // plane pushes tokens BEFORE the user picks a property, sending
    // `property_ref: ''` and possibly `account_email: ''`. A `.min(1)` on
    // either field made this exercised call 400 and strand tokens silently
    // (the cloud side doesn't check `res.ok`). Empty strings normalize to
    // NULL in the stored connection.
    const cloudPayload = {
      project_slug: 'acme',
      connection_type: 'gsc' as const,
      property_ref: '', // tenant fills in after the user picks the property
      access_token: 'ya29.cloud-access',
      refresh_token: '1//cloud-refresh',
      expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      account_email: '',
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/google/import-tokens',
      headers: { 'X-Admin-Scope': '1' },
      payload: cloudPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({
      imported: true,
      domain: 'acme.com',
      connection_type: 'gsc',
      property_ref: null,
    })

    const stored = store.getConnection('acme.com', 'gsc')
    expect(stored?.propertyId).toBe(null)
    expect(stored?.accessToken).toBe('ya29.cloud-access')
  })

  it('rejects request without X-Admin-Scope header with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/google/import-tokens',
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects unknown project with 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/google/import-tokens',
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
      url: '/api/v1/cloud/google/import-tokens',
      headers: { 'X-Admin-Scope': '1' },
      payload: { project_slug: 'acme', connection_type: 'gsc' }, // missing required tokens
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects invalid connection_type with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/google/import-tokens',
      headers: { 'X-Admin-Scope': '1' },
      payload: { ...VALID_REQUEST, connection_type: 'bing' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/v1/cloud/google/import-tokens with flag unset', () => {
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
      url: '/api/v1/cloud/google/import-tokens',
      headers: { 'X-Admin-Scope': '1' },
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(404)
  })
})
