import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiKeys, auditLog, competitors, createClient, migrate, projects, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

describe('stored-only HTTP guard', () => {
  let app: ReturnType<typeof Fastify>
  let db: DatabaseClient
  let dir: string
  const token = 'cnry_stored_only_root'
  const readToken = 'cnry_stored_only_read'

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-stored-only-'))
    db = createClient(path.join(dir, 'test.db'))
    migrate(db)
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString() }).run()
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'reader', keyHash: hashApiKey(readToken), keyPrefix: readToken.slice(0, 9), scopes: ['read'], createdAt: new Date().toISOString() }).run()
    db.insert(projects).values({ id: crypto.randomUUID(), name: 'acme', displayName: 'Acme', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: [], locations: [], defaultLocation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
    app = Fastify()
    await app.register(apiRoutes, { db, googleStateSecret: 'test-only-google-state-secret-32b', getRunnableProviderNames: () => ['openai'] })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const storedState = () => {
    const stable = <T>(rows: T[]) => rows.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    return {
      projects: stable(db.select().from(projects).all()),
      competitors: stable(db.select().from(competitors).all()),
      runs: stable(db.select().from(runs).all()),
      audit: stable(db.select().from(auditLog).all()),
    }
  }

  it('refuses live reads before the provider handler and permits stored reads', async () => {
    const live = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/google/gsc/sitemaps', headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(live.statusCode).toBe(403)
    expect(live.headers['x-canonry-access']).toBe('live')
    expect(live.json().error).toMatchObject({ code: 'STORED_ONLY_REFUSED' })

    const stored = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/competitors', headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(stored.statusCode).toBe(200)
    expect(stored.headers['x-canonry-access']).toBe('stored')
  })

  it('permits stored semantic previews but refuses a live discovery POST', async () => {
    const before = storedState()
    const competitorPreview = await app.inject({ method: 'POST', url: '/api/v1/projects/acme/competitor-changes/preview', payload: { change: 'add', competitors: ['preview.example'] }, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(competitorPreview.statusCode, competitorPreview.body).toBe(200)
    expect(competitorPreview.headers['x-canonry-access']).toBe('stored')
    const queryPreview = await app.inject({ method: 'POST', url: '/api/v1/projects/acme/queries/replace-preview', payload: { queries: ['alpha'] }, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(queryPreview.statusCode, queryPreview.body).toBe(200)
    expect(queryPreview.headers['x-canonry-access']).toBe('stored')
    const discovery = await app.inject({ method: 'POST', url: '/api/v1/projects/acme/measurement-discovery', payload: {}, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(discovery.statusCode).toBe(403)
    expect(discovery.json().error.code).toBe('STORED_ONLY_REFUSED')
    expect(storedState()).toEqual(before)
  })

  it('refuses provider-backed GETs and callback side effects before handlers', async () => {
    const coverage = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/bing/coverage', headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
    expect(coverage.statusCode).toBe(403)
    expect(coverage.headers['x-canonry-access']).toBe('write')
    const callback = await app.inject({ method: 'GET', url: '/api/v1/google/callback?code=forged&state=forged', headers: { 'x-canonry-stored-only': '1' } })
    expect(callback.statusCode).toBe(403)
    expect(callback.headers['x-canonry-access']).toBe('write')
  })

  it('refuses provider and write routes before provider calls or persistent state changes', async () => {
    const before = storedState()
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider call should be unreachable'))
    try {
      const refused = [
        await app.inject({ method: 'GET', url: '/api/v1/projects/acme/google/gsc/sitemaps', headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } }),
        await app.inject({ method: 'POST', url: '/api/v1/projects/acme/measurement-discovery', payload: {}, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } }),
        await app.inject({ method: 'PUT', url: '/api/v1/projects/acme/competitors', payload: { competitors: ['new.example'], acknowledgeBulkAdd: true }, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } }),
      ]
      for (const response of refused) {
        expect(response.statusCode, response.body).toBe(403)
        expect(response.json().error.code).toBe('STORED_ONLY_REFUSED')
      }
      expect(providerFetch).not.toHaveBeenCalled()
      expect(storedState()).toEqual(before)
    } finally {
      providerFetch.mockRestore()
    }
  })

  it('keeps read-key authorization refusal independent of stored-only mode', async () => {
    const before = storedState()
    const responses = [
      await app.inject({ method: 'POST', url: '/api/v1/projects/acme/competitor-changes/preview', payload: { change: 'add', competitors: ['preview.example'] }, headers: { authorization: `Bearer ${readToken}`, 'x-canonry-stored-only': '1' } }),
      await app.inject({ method: 'POST', url: '/api/v1/projects/acme/queries/replace-preview', payload: { queries: ['alpha'] }, headers: { authorization: `Bearer ${readToken}`, 'x-canonry-stored-only': '1' } }),
    ]
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(403)
      expect(response.json().error.code).toBe('FORBIDDEN')
    }
    expect(storedState()).toEqual(before)
  })

  it('normalizes mounted route prefixes before applying the guard', async () => {
    for (const prefix of ['/custom', '/tenant/api/v1']) {
      const mounted = Fastify()
      await mounted.register(apiRoutes, { db, routePrefix: prefix, googleStateSecret: 'test-only-google-state-secret-32', getRunnableProviderNames: () => ['openai'] })
      await mounted.ready()
      try {
        const base = `${prefix}/projects`
        const storedUrl = `${prefix}/projects/acme/competitors`
        const stored = await mounted.inject({ method: 'GET', url: storedUrl, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
        expect(stored.statusCode, `${prefix} stored`).toBe(200)
        expect(stored.headers['x-canonry-access'], prefix).toBe('stored')
        const live = await mounted.inject({ method: 'GET', url: `${base}/acme/google/gsc/sitemaps`, headers: { authorization: `Bearer ${token}`, 'x-canonry-stored-only': '1' } })
        expect(live.statusCode, `${prefix} live`).toBe(403)
        expect(live.headers['x-canonry-access'], prefix).toBe('live')
      } finally {
        await mounted.close()
      }
    }
  })
})
