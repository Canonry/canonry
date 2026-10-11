import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

describe('stored-only HTTP guard', () => {
  let app: ReturnType<typeof Fastify>
  let db: DatabaseClient
  let dir: string
  const token = 'cnry_stored_only_root'

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-stored-only-'))
    db = createClient(path.join(dir, 'test.db'))
    migrate(db)
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString() }).run()
    db.insert(projects).values({ id: crypto.randomUUID(), name: 'acme', displayName: 'Acme', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: [], locations: [], defaultLocation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
    app = Fastify()
    await app.register(apiRoutes, { db, googleStateSecret: 'test-only-google-state-secret-32b', getRunnableProviderNames: () => ['openai'] })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses live reads before the provider handler and permits stored reads', async () => {
    const live = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/google/gsc/sitemaps', headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(live.statusCode).toBe(403)
    expect(live.headers['x-canonry-access']).toBe('live')
    expect(live.json().error).toMatchObject({ code: 'STORED_ONLY_REFUSED' })

    const stored = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/competitors', headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(stored.statusCode).toBe(200)
    expect(stored.headers['x-canonry-access']).toBe('stored')
  })

  it('permits a stored semantic preview POST but refuses a live discovery POST', async () => {
    const preview = await app.inject({ method: 'POST', url: '/api/v1/projects/acme/measurement-plan/compile-preview', payload: {}, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(preview.statusCode).not.toBe(403)
    const discovery = await app.inject({ method: 'POST', url: '/api/v1/projects/acme/measurement-discovery', payload: {}, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(discovery.statusCode).toBe(403)
    expect(discovery.json().error.code).toBe('STORED_ONLY_REFUSED')
  })

  it('normalizes a custom route prefix before applying the guard', async () => {
    const custom = Fastify()
    await custom.register(apiRoutes, { db, routePrefix: '/operator/api/v1', googleStateSecret: 'test-only-google-state-secret-32', getRunnableProviderNames: () => ['openai'] })
    await custom.ready()
    try {
      const response = await custom.inject({ method: 'GET', url: '/operator/api/v1/projects/acme/competitors', headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['x-canonry-access']).toBe('stored')
    } finally {
      await custom.close()
    }
  })
})
