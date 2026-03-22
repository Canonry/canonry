import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bingUrlInspections, createClient, migrate, projects } from '@ainyc/canonry-db'
import { bingRoutes } from '../src/bing.js'
import type { BingConnectionRecord, BingConnectionStore } from '../src/bing.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const connections = new Map<string, BingConnectionRecord>()
  const bingConnectionStore: BingConnectionStore = {
    getConnection: (domain) => connections.get(domain),
    upsertConnection: (connection) => {
      connections.set(connection.domain, connection)
      return connection
    },
    updateConnection: (domain, patch) => {
      const existing = connections.get(domain)
      if (!existing) return undefined
      const next = { ...existing, ...patch }
      connections.set(domain, next)
      return next
    },
    deleteConnection: (domain) => connections.delete(domain),
  }

  const app = Fastify()
  app.decorate('db', db)
  app.register(bingRoutes, { bingConnectionStore })

  return { app, db, tmpDir, connections }
}

describe('Bing routes', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let connections: Map<string, BingConnectionRecord>
  let projectId: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    connections = ctx.connections
    await app.ready()

    projectId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: projectId,
      name: 'test-project',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      tags: '[]',
      labels: '{}',
      providers: '[]',
      locations: '[]',
      defaultLocation: null,
      configSource: 'cli',
      configRevision: 1,
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  beforeEach(() => {
    db.delete(bingUrlInspections).run()
    connections.clear()

    const now = new Date().toISOString()
    connections.set('example.com', {
      domain: 'example.com',
      apiKey: 'test-key',
      siteUrl: 'https://example.com/',
      createdAt: now,
      updatedAt: now,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('maps HttpStatus into httpCode and keeps zero-byte DocumentSize as unknown', async () => {
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/page',
      HttpStatus: 200,
      DocumentSize: 0,
      IsPage: true,
      LastCrawledDate: '2026-03-15T10:00:00Z',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/inspect-url',
      payload: { url: 'https://example.com/page' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      url: string
      httpCode: number | null
      inIndex: boolean | null
      documentSize: number | null
    }
    expect(body.url).toBe('https://example.com/page')
    expect(body.httpCode).toBe(200)
    expect(body.inIndex).toBeNull()
    expect(body.documentSize).toBe(0)

    const rows = db.select().from(bingUrlInspections).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.httpCode).toBe(200)
    expect(rows[0]!.inIndex).toBeNull()
  })

  it('derives indexed=true only from positive DocumentSize', async () => {
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/indexed',
      HttpStatus: 200,
      DocumentSize: 4096,
      AnchorCount: 7,
      DiscoveryDate: '2026-03-01T10:00:00Z',
      LastCrawledDate: '2026-03-15T10:00:00Z',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/inspect-url',
      payload: { url: 'https://example.com/indexed' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { inIndex: boolean | null; httpCode: number | null }
    expect(body.httpCode).toBe(200)
    expect(body.inIndex).toBe(true)
  })

  it('coverage excludes unknown rows from the not-indexed bucket', async () => {
    const now = new Date().toISOString()
    db.insert(bingUrlInspections).values([
      {
        id: crypto.randomUUID(),
        projectId,
        url: 'https://example.com/indexed',
        httpCode: 200,
        inIndex: 1,
        lastCrawledDate: '2026-03-15T10:00:00Z',
        inIndexDate: null,
        inspectedAt: '2026-03-20T10:00:00Z',
        createdAt: now,
        documentSize: 2048,
        anchorCount: null,
        discoveryDate: null,
      },
      {
        id: crypto.randomUUID(),
        projectId,
        url: 'https://example.com/not-indexed',
        httpCode: 404,
        inIndex: 0,
        lastCrawledDate: null,
        inIndexDate: null,
        inspectedAt: '2026-03-20T11:00:00Z',
        createdAt: now,
        documentSize: 0,
        anchorCount: null,
        discoveryDate: null,
      },
      {
        id: crypto.randomUUID(),
        projectId,
        url: 'https://example.com/unknown',
        httpCode: 200,
        inIndex: null,
        lastCrawledDate: '2026-03-20T09:00:00Z',
        inIndexDate: null,
        inspectedAt: '2026-03-20T12:00:00Z',
        createdAt: now,
        documentSize: 0,
        anchorCount: 3,
        discoveryDate: '2026-03-18T09:00:00Z',
      },
    ]).run()

    const res = await app.inject({
      method: 'GET',
      url: '/projects/test-project/bing/coverage',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      summary: { total: number; indexed: number; notIndexed: number; unknown: number; percentage: number }
      indexed: Array<{ url: string }>
      notIndexed: Array<{ url: string }>
      unknown: Array<{ url: string }>
    }
    expect(body.summary).toEqual({
      total: 2,
      indexed: 1,
      notIndexed: 1,
      unknown: 1,
      percentage: 50,
    })
    expect(body.indexed.map((row) => row.url)).toEqual(['https://example.com/indexed'])
    expect(body.notIndexed.map((row) => row.url)).toEqual(['https://example.com/not-indexed'])
    expect(body.unknown.map((row) => row.url)).toEqual(['https://example.com/unknown'])
  })

  it('allUnindexed only submits URLs with an explicit not-indexed status', async () => {
    const now = new Date().toISOString()
    db.insert(bingUrlInspections).values([
      {
        id: crypto.randomUUID(),
        projectId,
        url: 'https://example.com/not-indexed',
        httpCode: 404,
        inIndex: 0,
        lastCrawledDate: null,
        inIndexDate: null,
        inspectedAt: '2026-03-20T11:00:00Z',
        createdAt: now,
        documentSize: 0,
        anchorCount: null,
        discoveryDate: null,
      },
      {
        id: crypto.randomUUID(),
        projectId,
        url: 'https://example.com/unknown',
        httpCode: 200,
        inIndex: null,
        lastCrawledDate: '2026-03-20T09:00:00Z',
        inIndexDate: null,
        inspectedAt: '2026-03-20T12:00:00Z',
        createdAt: now,
        documentSize: 0,
        anchorCount: null,
        discoveryDate: null,
      },
    ]).run()

    const bingModule = await import('@ainyc/canonry-integration-bing')
    const submitUrlSpy = vi.spyOn(bingModule, 'submitUrl').mockResolvedValue()

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/request-indexing',
      payload: { allUnindexed: true },
    })

    expect(res.statusCode).toBe(200)
    expect(submitUrlSpy).toHaveBeenCalledTimes(1)
    expect(submitUrlSpy).toHaveBeenCalledWith('test-key', 'https://example.com/', 'https://example.com/not-indexed')
  })
})
