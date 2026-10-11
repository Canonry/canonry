import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

describe('mounted operation access headers', () => {
  let app: ReturnType<typeof Fastify>
  let db: DatabaseClient
  let dir: string
  const token = 'cnry_access_header_root'

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-access-header-'))
    db = createClient(path.join(dir, 'test.db'))
    migrate(db)
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString() }).run()
    db.insert(projects).values({ id: crypto.randomUUID(), name: 'acme', displayName: 'Acme', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: [], locations: [], defaultLocation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
    app = Fastify()
    await app.register(apiRoutes, { db, routePrefix: '/custom', googleStateSecret: 'test-only-google-state-secret-32', getRunnableProviderNames: () => ['openai'] })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('canonicalizes a custom mounted prefix for stored and live headers', async () => {
    const stored = await app.inject({ method: 'GET', url: '/custom/projects/acme/competitors', headers: { authorization: `Bearer ${token}` } })
    expect(stored.statusCode).toBe(200)
    expect(stored.headers['x-canonry-access']).toBe('stored')

    const live = await app.inject({ method: 'GET', url: '/custom/projects/acme/google/gsc/sitemaps', headers: { authorization: `Bearer ${token}` } })
    expect(live.headers['x-canonry-access']).toBe('live')
  })

  it('canonicalizes a tenant api prefix for stored and live headers', async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-access-header-'))
    db = createClient(path.join(dir, 'test.db'))
    migrate(db)
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString() }).run()
    db.insert(projects).values({ id: crypto.randomUUID(), name: 'acme', displayName: 'Acme', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: [], locations: [], defaultLocation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
    app = Fastify()
    await app.register(apiRoutes, { db, routePrefix: '/tenant/api/v1', googleStateSecret: 'test-only-google-state-secret-32', getRunnableProviderNames: () => ['openai'] })
    await app.ready()

    const stored = await app.inject({ method: 'GET', url: '/tenant/api/v1/projects/acme/competitors', headers: { authorization: `Bearer ${token}` } })
    expect(stored.statusCode).toBe(200)
    expect(stored.headers['x-canonry-access']).toBe('stored')

    const live = await app.inject({ method: 'GET', url: '/tenant/api/v1/projects/acme/google/gsc/sitemaps', headers: { authorization: `Bearer ${token}` } })
    expect(live.headers['x-canonry-access']).toBe('live')
  })
})
