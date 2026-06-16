import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backlinkDomains,
  backlinkSummaries,
  ccReleaseSyncs,
  createClient,
  migrate,
  projects,
  runs,
} from '@ainyc/canonry-db'
import { backlinksRoutes, type BacklinksRoutesOptions } from '../src/backlinks.js'
import type { BingConnectionStore } from '../src/bing.js'
import type { BacklinkSource, BacklinkSourcesResponseDto } from '@ainyc/canonry-contracts'

function buildApp(overrides: Partial<BacklinksRoutesOptions> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlinks-routes-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500
    const code = (error as { code?: string }).code
    if (code) {
      return reply.status(statusCode).send({ error: { code, message: error.message } })
    }
    return reply.status(statusCode).send({ error: { message: error.message } })
  })
  const defaults: BacklinksRoutesOptions = {
    getBacklinksStatus: () => ({
      duckdbInstalled: true,
      duckdbVersion: '1.4.4-r.3',
      duckdbSpec: '@duckdb/node-api@1.4.4-r.3',
      pluginDir: '/fake/.canonry/plugins',
    }),
    onInstallBacklinks: async () => ({
      installed: true,
      version: '1.4.4-r.3',
      path: '/fake/.canonry/plugins',
      alreadyPresent: false,
    }),
  }
  app.register(backlinksRoutes, { ...defaults, ...overrides })

  return { app, db, tmpDir }
}

function insertProject(db: ReturnType<typeof createClient>, id: string, name: string, domain: string): void {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: domain,
    country: 'US', language: 'en', providers: '[]',
    createdAt: now, updatedAt: now,
  }).run()
}

// Seeds a summary + its domain rows for one source/window, so the source-aware
// reads have something to isolate. `releaseSyncId` stays null (legal for both
// sources now; only the read paths matter here).
function seedSourceData(
  db: ReturnType<typeof createClient>,
  opts: {
    projectId: string
    source: BacklinkSource
    release: string
    targetDomain?: string
    domains: Array<[string, number]>
    queriedAt?: string
  },
): void {
  const now = opts.queriedAt ?? new Date().toISOString()
  const target = opts.targetDomain ?? 'roots.io'
  const totalHosts = opts.domains.reduce((sum, [, h]) => sum + h, 0)
  db.insert(backlinkSummaries).values({
    id: crypto.randomUUID(), projectId: opts.projectId, releaseSyncId: null,
    source: opts.source, release: opts.release, targetDomain: target,
    totalLinkingDomains: opts.domains.length, totalHosts, top10HostsShare: '1.000000',
    queriedAt: now, createdAt: now,
  }).run()
  for (const [linking, hosts] of opts.domains) {
    db.insert(backlinkDomains).values({
      id: crypto.randomUUID(), projectId: opts.projectId, releaseSyncId: null,
      source: opts.source, release: opts.release, targetDomain: target,
      linkingDomain: linking, numHosts: hosts, createdAt: now,
    }).run()
  }
}

function fakeBingStore(connected: Record<string, { siteUrl?: string }>): BingConnectionStore {
  return {
    getConnection: (domain) =>
      connected[domain]
        ? { domain, apiKey: 'k', siteUrl: connected[domain].siteUrl ?? `https://${domain}/`, createdAt: 'x', updatedAt: 'x' }
        : undefined,
    upsertConnection: (c) => c,
    updateConnection: () => undefined,
    deleteConnection: () => false,
  }
}

describe('Backlinks routes', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    db.delete(backlinkDomains).run()
    db.delete(backlinkSummaries).run()
    db.delete(ccReleaseSyncs).run()
    db.delete(runs).run()
    db.delete(projects).run()
  })

  describe('GET /backlinks/status', () => {
    it('returns the install status from the callback', async () => {
      const res = await app.inject({ method: 'GET', url: '/backlinks/status' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { duckdbInstalled: boolean; duckdbVersion?: string; duckdbSpec: string }
      expect(body.duckdbInstalled).toBe(true)
      expect(body.duckdbVersion).toBe('1.4.4-r.3')
      expect(body.duckdbSpec).toBeTruthy()
    })
  })

  describe('POST /backlinks/install', () => {
    it('calls the install callback and returns the result', async () => {
      const spy = vi.fn(async () => ({
        installed: true, version: '1.4.4-r.3', path: '/tmp/plugins', alreadyPresent: false,
      }))
      const { app: custom } = buildApp({ onInstallBacklinks: spy })
      await custom.ready()
      const res = await custom.inject({ method: 'POST', url: '/backlinks/install' })
      expect(res.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledOnce()
      const body = res.json() as { installed: boolean; alreadyPresent: boolean }
      expect(body.installed).toBe(true)
      expect(body.alreadyPresent).toBe(false)
      await custom.close()
    })
  })

  describe('GET /backlinks/latest-release', () => {
    it('returns the discovered release from the callback', async () => {
      const probe = vi.fn(async () => ({
        release: 'cc-main-2026-jan-feb-mar',
        vertexUrl: 'https://example.test/v.gz',
        edgesUrl: 'https://example.test/e.gz',
        vertexBytes: 4_000_000_000,
        edgesBytes: 13_000_000_000,
        lastModified: 'Wed, 15 Apr 2026 12:00:00 GMT',
      }))
      const { app: custom } = buildApp({ discoverLatestRelease: probe })
      await custom.ready()

      const res = await custom.inject({ method: 'GET', url: '/backlinks/latest-release' })
      expect(res.statusCode).toBe(200)
      expect(probe).toHaveBeenCalledOnce()
      const body = res.json() as { release: string; vertexBytes: number }
      expect(body.release).toBe('cc-main-2026-jan-feb-mar')
      expect(body.vertexBytes).toBe(4_000_000_000)
      await custom.close()
    })

    it('returns null when nothing was discovered', async () => {
      const { app: custom } = buildApp({ discoverLatestRelease: async () => null })
      await custom.ready()
      const res = await custom.inject({ method: 'GET', url: '/backlinks/latest-release' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toBeNull()
      await custom.close()
    })

    it('throws MISSING_DEPENDENCY when discoverLatestRelease is not wired (cloud)', async () => {
      const { app: cloud } = buildApp({
        getBacklinksStatus: undefined,
        discoverLatestRelease: undefined,
      })
      await cloud.ready()
      const res = await cloud.inject({ method: 'GET', url: '/backlinks/latest-release' })
      expect(res.statusCode).toBe(422)
      const body = res.json() as { error: { code: string } }
      expect(body.error.code).toBe('MISSING_DEPENDENCY')
      await cloud.close()
    })
  })

  describe('POST /backlinks/syncs', () => {
    it('rejects an invalid release id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/backlinks/syncs',
        payload: { release: 'not-a-release' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('auto-discovers the release when body.release is omitted', async () => {
      const probe = vi.fn(async () => ({
        release: 'cc-main-2026-jan-feb-mar',
        vertexUrl: 'https://example.test/v.gz',
        edgesUrl: 'https://example.test/e.gz',
        vertexBytes: null,
        edgesBytes: null,
        lastModified: null,
      }))
      const sync = vi.fn()
      const { app: custom } = buildApp({
        discoverLatestRelease: probe,
        onReleaseSyncRequested: sync,
      })
      await custom.ready()

      const res = await custom.inject({ method: 'POST', url: '/backlinks/syncs', payload: {} })
      expect(res.statusCode).toBe(201)
      expect(probe).toHaveBeenCalledOnce()
      const body = res.json() as { release: string; status: string }
      expect(body.release).toBe('cc-main-2026-jan-feb-mar')
      expect(body.status).toBe('queued')
      expect(sync).toHaveBeenCalledWith(expect.any(String), 'cc-main-2026-jan-feb-mar')
      await custom.close()
    })

    it('returns a clear error when auto-discovery fails to find a release', async () => {
      const { app: custom } = buildApp({
        discoverLatestRelease: async () => null,
        onReleaseSyncRequested: vi.fn(),
      })
      await custom.ready()
      const res = await custom.inject({ method: 'POST', url: '/backlinks/syncs', payload: {} })
      expect(res.statusCode).toBe(400)
      const body = res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).toMatch(/auto-discover/i)
      await custom.close()
    })

    it('returns a clear error when no release is provided and auto-discovery is unavailable', async () => {
      const { app: custom } = buildApp({
        discoverLatestRelease: undefined,
        onReleaseSyncRequested: vi.fn(),
      })
      await custom.ready()
      const res = await custom.inject({ method: 'POST', url: '/backlinks/syncs', payload: {} })
      expect(res.statusCode).toBe(400)
      const body = res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).toMatch(/auto-discovery is unavailable/i)
      await custom.close()
    })

    it('rejects when DuckDB is not installed', async () => {
      const { app: custom } = buildApp({
        getBacklinksStatus: () => ({
          duckdbInstalled: false,
          duckdbSpec: '@duckdb/node-api@1.4.4-r.3',
          pluginDir: '/fake',
        }),
      })
      await custom.ready()
      const res = await custom.inject({
        method: 'POST',
        url: '/backlinks/syncs',
        payload: { release: 'cc-main-2026-jan-feb-mar' },
      })
      expect(res.statusCode).toBe(422)
      const body = res.json() as { error: { code: string } }
      expect(body.error.code).toBe('MISSING_DEPENDENCY')
      await custom.close()
    })

    it('creates a queued sync row and fires the callback', async () => {
      const spy = vi.fn()
      const { app: custom, db: customDb } = buildApp({ onReleaseSyncRequested: spy })
      await custom.ready()
      const res = await custom.inject({
        method: 'POST',
        url: '/backlinks/syncs',
        payload: { release: 'cc-main-2026-jan-feb-mar' },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json() as { id: string; release: string; status: string }
      expect(body.release).toBe('cc-main-2026-jan-feb-mar')
      expect(body.status).toBe('queued')
      expect(spy).toHaveBeenCalledWith(body.id, 'cc-main-2026-jan-feb-mar')
      const stored = customDb.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.id, body.id)).get()
      expect(stored?.status).toBe('queued')
      await custom.close()
    })

    it('returns the existing sync when the release is already in-flight (idempotent)', async () => {
      const { app: custom, db: customDb } = buildApp({ onReleaseSyncRequested: vi.fn() })
      await custom.ready()

      const first = await custom.inject({
        method: 'POST',
        url: '/backlinks/syncs',
        payload: { release: 'cc-main-2026-jan-feb-mar' },
      })
      const firstBody = first.json() as { id: string }

      const second = await custom.inject({
        method: 'POST',
        url: '/backlinks/syncs',
        payload: { release: 'cc-main-2026-jan-feb-mar' },
      })
      expect(second.statusCode).toBe(200)
      const secondBody = second.json() as { id: string }
      expect(secondBody.id).toBe(firstBody.id)
      const rows = customDb.select().from(ccReleaseSyncs).all()
      expect(rows).toHaveLength(1)
      await custom.close()
    })
  })

  describe('GET /backlinks/syncs/latest', () => {
    it('returns null when no sync exists', async () => {
      const res = await app.inject({ method: 'GET', url: '/backlinks/syncs/latest' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toBeNull()
    })

    it('returns the most recent sync row', async () => {
      const now = new Date().toISOString()
      db.insert(ccReleaseSyncs).values({
        id: 'old', release: 'cc-main-2025-oct-nov-dec', status: 'ready',
        createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z',
      }).run()
      db.insert(ccReleaseSyncs).values({
        id: 'new', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
        createdAt: now, updatedAt: now,
      }).run()
      const res = await app.inject({ method: 'GET', url: '/backlinks/syncs/latest' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { id: string; release: string }
      expect(body.id).toBe('new')
      expect(body.release).toBe('cc-main-2026-jan-feb-mar')
    })

    it('orders by updatedAt so a re-queued older release wins over an untouched newer one', async () => {
      db.insert(ccReleaseSyncs).values({
        id: 'requeued',
        release: 'cc-main-2025-oct-nov-dec',
        status: 'downloading',
        createdAt: '2025-12-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }).run()
      db.insert(ccReleaseSyncs).values({
        id: 'stale',
        release: 'cc-main-2026-jan-feb-mar',
        status: 'ready',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }).run()
      const res = await app.inject({ method: 'GET', url: '/backlinks/syncs/latest' })
      const body = res.json() as { id: string }
      expect(body.id).toBe('requeued')
    })
  })

  describe('GET /backlinks/syncs', () => {
    it('returns syncs ordered newest first', async () => {
      db.insert(ccReleaseSyncs).values({
        id: 'a', release: 'cc-main-2025-oct-nov-dec', status: 'ready',
        createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z',
      }).run()
      db.insert(ccReleaseSyncs).values({
        id: 'b', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
        createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
      }).run()
      const res = await app.inject({ method: 'GET', url: '/backlinks/syncs' })
      const body = res.json() as Array<{ id: string }>
      expect(body.map((r) => r.id)).toEqual(['b', 'a'])
    })

    it('orders by updatedAt DESC so requeued syncs surface ahead of untouched newer rows', async () => {
      db.insert(ccReleaseSyncs).values({
        id: 'requeued',
        release: 'cc-main-2025-oct-nov-dec',
        status: 'downloading',
        createdAt: '2025-12-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }).run()
      db.insert(ccReleaseSyncs).values({
        id: 'untouched',
        release: 'cc-main-2026-jan-feb-mar',
        status: 'ready',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }).run()
      const res = await app.inject({ method: 'GET', url: '/backlinks/syncs' })
      const body = res.json() as Array<{ id: string }>
      expect(body.map((r) => r.id)).toEqual(['requeued', 'untouched'])
    })
  })

  describe('cloud deployment (no DuckDB callbacks)', () => {
    it('mounts read routes so cached sync history is visible from /backlinks/syncs/latest', async () => {
      const { app: cloud, db: cloudDb } = buildApp({
        getBacklinksStatus: undefined,
        onInstallBacklinks: undefined,
      })
      await cloud.ready()
      const now = new Date().toISOString()
      cloudDb.insert(ccReleaseSyncs).values({
        id: 'seeded',
        release: 'cc-main-2026-jan-feb-mar',
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      }).run()

      const latest = await cloud.inject({ method: 'GET', url: '/backlinks/syncs/latest' })
      expect(latest.statusCode).toBe(200)
      expect((latest.json() as { id: string } | null)?.id).toBe('seeded')

      const list = await cloud.inject({ method: 'GET', url: '/backlinks/syncs' })
      expect(list.statusCode).toBe(200)
      expect((list.json() as Array<{ id: string }>).map((r) => r.id)).toEqual(['seeded'])

      await cloud.close()
    })

    it('action routes throw MISSING_DEPENDENCY instead of 404 when callbacks are missing', async () => {
      const { app: cloud, db: cloudDb } = buildApp({
        getBacklinksStatus: undefined,
        onInstallBacklinks: undefined,
        onReleaseSyncRequested: undefined,
        onBacklinkExtractRequested: undefined,
        onBacklinksPruneCache: undefined,
      })
      await cloud.ready()
      insertProject(cloudDb, 'p1', 'roots', 'roots.io')

      const targets: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: object }> = [
        { method: 'GET', url: '/backlinks/status' },
        { method: 'POST', url: '/backlinks/install' },
        { method: 'POST', url: '/backlinks/syncs', payload: { release: 'cc-main-2026-jan-feb-mar' } },
        { method: 'POST', url: '/projects/roots/backlinks/extract', payload: {} },
        { method: 'DELETE', url: '/backlinks/cache/cc-main-2026-jan-feb-mar' },
      ]
      for (const { method, url, payload } of targets) {
        const res = await cloud.inject({ method, url, payload })
        expect(res.statusCode, `${method} ${url}`).toBe(422)
        const body = res.json() as { error: { code: string } }
        expect(body.error.code, `${method} ${url}`).toBe('MISSING_DEPENDENCY')
      }
      await cloud.close()
    })
  })

  describe('POST /projects/:name/backlinks/extract', () => {
    it('fails with MISSING_DEPENDENCY when DuckDB is not installed', async () => {
      const { app: custom, db: customDb } = buildApp({
        getBacklinksStatus: () => ({
          duckdbInstalled: false,
          duckdbSpec: '@duckdb/node-api@1.4.4-r.3',
          pluginDir: '/fake',
        }),
      })
      await custom.ready()
      insertProject(customDb, 'p1', 'roots', 'roots.io')
      const res = await custom.inject({
        method: 'POST',
        url: '/projects/roots/backlinks/extract',
        payload: {},
      })
      expect(res.statusCode).toBe(422)
      await custom.close()
    })

    it('creates a run and fires onBacklinkExtractRequested', async () => {
      const spy = vi.fn()
      const { app: custom, db: customDb } = buildApp({ onBacklinkExtractRequested: spy })
      await custom.ready()
      insertProject(customDb, 'p1', 'roots', 'roots.io')
      const res = await custom.inject({
        method: 'POST',
        url: '/projects/roots/backlinks/extract',
        payload: { release: 'cc-main-2026-jan-feb-mar' },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json() as { id: string; kind: string; projectId: string }
      expect(body.kind).toBe('backlink-extract')
      expect(body.projectId).toBe('p1')
      expect(spy).toHaveBeenCalledWith(body.id, 'p1', 'cc-main-2026-jan-feb-mar')
      await custom.close()
    })

    it('omits release arg when body.release is undefined', async () => {
      const spy = vi.fn()
      const { app: custom, db: customDb } = buildApp({ onBacklinkExtractRequested: spy })
      await custom.ready()
      insertProject(customDb, 'p1', 'roots', 'roots.io')
      await custom.inject({
        method: 'POST',
        url: '/projects/roots/backlinks/extract',
        payload: {},
      })
      expect(spy).toHaveBeenCalledWith(expect.any(String), 'p1', undefined)
      await custom.close()
    })
  })

  describe('GET /projects/:name/backlinks/summary', () => {
    it('returns null when no summary exists', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/summary' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toBeNull()
    })

    it('returns the latest summary for a project', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const now = new Date().toISOString()
      db.insert(ccReleaseSyncs).values({
        id: 'sync-1', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
        createdAt: now, updatedAt: now,
      }).run()
      db.insert(backlinkSummaries).values({
        id: crypto.randomUUID(), projectId: 'p1',
        releaseSyncId: 'sync-1', release: 'cc-main-2026-jan-feb-mar',
        targetDomain: 'roots.io',
        totalLinkingDomains: 5, totalHosts: 100, top10HostsShare: '0.900000',
        queriedAt: now, createdAt: now,
      }).run()
      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/summary' })
      const body = res.json() as { totalLinkingDomains: number; targetDomain: string }
      expect(body.totalLinkingDomains).toBe(5)
      expect(body.targetDomain).toBe('roots.io')
    })

    it('?excludeCrawlers=1 recomputes totals and exposes excluded counts', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const now = new Date().toISOString()
      db.insert(ccReleaseSyncs).values({
        id: 'sync-1', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
        createdAt: now, updatedAt: now,
      }).run()
      db.insert(backlinkSummaries).values({
        id: crypto.randomUUID(), projectId: 'p1',
        releaseSyncId: 'sync-1', release: 'cc-main-2026-jan-feb-mar',
        targetDomain: 'roots.io',
        // Stored summary covers ALL rows (3 editorial + 2 crawler/proxy = 5)
        totalLinkingDomains: 5, totalHosts: 41_360, top10HostsShare: '0.999900',
        queriedAt: now, createdAt: now,
      }).run()
      const rows: Array<[string, number]> = [
        ['google.com', 41_000],
        ['translate.google.com', 200],
        ['news-publication.example', 100],
        ['industry-blog.example', 50],
        ['developer-mag.example', 10],
      ]
      for (const [domain, hosts] of rows) {
        db.insert(backlinkDomains).values({
          id: crypto.randomUUID(), projectId: 'p1',
          releaseSyncId: 'sync-1', release: 'cc-main-2026-jan-feb-mar',
          targetDomain: 'roots.io', linkingDomain: domain, numHosts: hosts,
          createdAt: now,
        }).run()
      }

      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/summary?excludeCrawlers=1' })
      const body = res.json() as {
        totalLinkingDomains: number
        totalHosts: number
        top10HostsShare: string
        excludedLinkingDomains: number
        excludedHosts: number
      }
      expect(body.totalLinkingDomains).toBe(3)
      expect(body.totalHosts).toBe(160)
      expect(body.excludedLinkingDomains).toBe(2)
      expect(body.excludedHosts).toBe(41_200)
      expect(Number(body.top10HostsShare)).toBeCloseTo(1, 6)
    })

    it('without excludeCrawlers returns the stored summary unchanged', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const now = new Date().toISOString()
      db.insert(ccReleaseSyncs).values({
        id: 'sync-1', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
        createdAt: now, updatedAt: now,
      }).run()
      db.insert(backlinkSummaries).values({
        id: crypto.randomUUID(), projectId: 'p1',
        releaseSyncId: 'sync-1', release: 'cc-main-2026-jan-feb-mar',
        targetDomain: 'roots.io',
        totalLinkingDomains: 5, totalHosts: 41_360, top10HostsShare: '0.999900',
        queriedAt: now, createdAt: now,
      }).run()
      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/summary' })
      const body = res.json() as { totalLinkingDomains: number; excludedLinkingDomains?: number }
      expect(body.totalLinkingDomains).toBe(5)
      expect(body.excludedLinkingDomains).toBeUndefined()
    })
  })

  describe('GET /projects/:name/backlinks/domains', () => {
    it('paginates and returns rows ordered by numHosts DESC', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const now = new Date().toISOString()
      db.insert(ccReleaseSyncs).values({
        id: 'sync-1', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
        createdAt: now, updatedAt: now,
      }).run()
      db.insert(backlinkSummaries).values({
        id: crypto.randomUUID(), projectId: 'p1',
        releaseSyncId: 'sync-1', release: 'cc-main-2026-jan-feb-mar',
        targetDomain: 'roots.io',
        totalLinkingDomains: 3, totalHosts: 60, top10HostsShare: '1.000000',
        queriedAt: now, createdAt: now,
      }).run()
      for (const [linking, hosts] of [['a.com', 10], ['b.com', 30], ['c.com', 20]] as const) {
        db.insert(backlinkDomains).values({
          id: crypto.randomUUID(), projectId: 'p1',
          releaseSyncId: 'sync-1', release: 'cc-main-2026-jan-feb-mar',
          targetDomain: 'roots.io', linkingDomain: linking, numHosts: hosts,
          createdAt: now,
        }).run()
      }

      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/domains?limit=2' })
      const body = res.json() as { total: number; summary: { totalLinkingDomains: number }; rows: Array<{ linkingDomain: string; numHosts: number }> }
      expect(body.total).toBe(3)
      expect(body.summary.totalLinkingDomains).toBe(3)
      expect(body.rows).toHaveLength(2)
      expect(body.rows[0]!.linkingDomain).toBe('b.com')
      expect(body.rows[0]!.numHosts).toBe(30)
      expect(body.rows[1]!.linkingDomain).toBe('c.com')
    })

    it('?excludeCrawlers=1 filters apex + subdomain rows and recomputes totals', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const now = new Date().toISOString()
      db.insert(ccReleaseSyncs).values({
        id: 'sync-1', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
        createdAt: now, updatedAt: now,
      }).run()
      db.insert(backlinkSummaries).values({
        id: crypto.randomUUID(), projectId: 'p1',
        releaseSyncId: 'sync-1', release: 'cc-main-2026-jan-feb-mar',
        targetDomain: 'roots.io',
        totalLinkingDomains: 5, totalHosts: 41_360, top10HostsShare: '0.999900',
        queriedAt: now, createdAt: now,
      }).run()
      const rows: Array<[string, number]> = [
        ['google.com', 41_000],
        ['scholar.google.com', 200],
        ['notgoogle.com', 80],
        ['news-publication.example', 100],
        ['industry-blog.example', 50],
      ]
      for (const [domain, hosts] of rows) {
        db.insert(backlinkDomains).values({
          id: crypto.randomUUID(), projectId: 'p1',
          releaseSyncId: 'sync-1', release: 'cc-main-2026-jan-feb-mar',
          targetDomain: 'roots.io', linkingDomain: domain, numHosts: hosts,
          createdAt: now,
        }).run()
      }

      const res = await app.inject({
        method: 'GET',
        url: '/projects/roots/backlinks/domains?limit=10&excludeCrawlers=1',
      })
      const body = res.json() as {
        total: number
        summary: {
          totalLinkingDomains: number
          totalHosts: number
          excludedLinkingDomains: number
          excludedHosts: number
        }
        rows: Array<{ linkingDomain: string; numHosts: number }>
      }
      expect(body.total).toBe(3)
      expect(body.rows.map((r) => r.linkingDomain)).toEqual([
        'news-publication.example',
        'notgoogle.com',
        'industry-blog.example',
      ])
      expect(body.summary.totalLinkingDomains).toBe(3)
      expect(body.summary.totalHosts).toBe(230)
      expect(body.summary.excludedLinkingDomains).toBe(2)
      expect(body.summary.excludedHosts).toBe(41_200)
    })
  })

  describe('GET /projects/:name/backlinks/history', () => {
    it('returns history entries ordered oldest-first by queriedAt', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const now = new Date().toISOString()
      db.insert(ccReleaseSyncs).values({
        id: 's1', release: 'cc-main-2025-oct-nov-dec', status: 'ready',
        createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z',
      }).run()
      db.insert(ccReleaseSyncs).values({
        id: 's2', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
        createdAt: now, updatedAt: now,
      }).run()
      db.insert(backlinkSummaries).values({
        id: crypto.randomUUID(), projectId: 'p1',
        releaseSyncId: 's1', release: 'cc-main-2025-oct-nov-dec',
        targetDomain: 'roots.io',
        totalLinkingDomains: 3, totalHosts: 30, top10HostsShare: '1.000000',
        queriedAt: '2025-12-01T00:00:00.000Z', createdAt: '2025-12-01T00:00:00.000Z',
      }).run()
      db.insert(backlinkSummaries).values({
        id: crypto.randomUUID(), projectId: 'p1',
        releaseSyncId: 's2', release: 'cc-main-2026-jan-feb-mar',
        targetDomain: 'roots.io',
        totalLinkingDomains: 5, totalHosts: 100, top10HostsShare: '0.800000',
        queriedAt: now, createdAt: now,
      }).run()
      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/history' })
      const body = res.json() as Array<{ release: string; totalLinkingDomains: number }>
      expect(body).toHaveLength(2)
      expect(body[0]!.release).toBe('cc-main-2025-oct-nov-dec')
      expect(body[1]!.release).toBe('cc-main-2026-jan-feb-mar')
    })
  })

  describe('source-aware reads', () => {
    it('summary defaults to commoncrawl and ?source=bing-webmaster returns the bing window', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      seedSourceData(db, { projectId: 'p1', source: 'commoncrawl', release: 'cc-main-2026-jan-feb-mar', domains: [['cc-a.com', 10]] })
      seedSourceData(db, { projectId: 'p1', source: 'bing-webmaster', release: 'bing-2026-06-15', domains: [['bing-a.com', 5], ['bing-b.com', 3]] })

      const cc = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/summary' })
      const ccBody = cc.json() as { source: string; totalLinkingDomains: number; release: string }
      expect(ccBody.source).toBe('commoncrawl')
      expect(ccBody.totalLinkingDomains).toBe(1)
      expect(ccBody.release).toBe('cc-main-2026-jan-feb-mar')

      const bing = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/summary?source=bing-webmaster' })
      const bingBody = bing.json() as { source: string; totalLinkingDomains: number; release: string }
      expect(bingBody.source).toBe('bing-webmaster')
      expect(bingBody.totalLinkingDomains).toBe(2)
      expect(bingBody.release).toBe('bing-2026-06-15')
    })

    it('domains tags rows + response with source and isolates one source from the other', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      seedSourceData(db, { projectId: 'p1', source: 'commoncrawl', release: 'cc-main-2026-jan-feb-mar', domains: [['cc-a.com', 10]] })
      seedSourceData(db, { projectId: 'p1', source: 'bing-webmaster', release: 'bing-2026-06-15', domains: [['bing-a.com', 5]] })

      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/domains?source=bing-webmaster' })
      const body = res.json() as { source: string; total: number; rows: Array<{ linkingDomain: string; source: string }> }
      expect(body.source).toBe('bing-webmaster')
      expect(body.total).toBe(1)
      expect(body.rows).toHaveLength(1)
      expect(body.rows[0]!.linkingDomain).toBe('bing-a.com')
      expect(body.rows[0]!.source).toBe('bing-webmaster')
    })

    it('history filters by source', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      seedSourceData(db, { projectId: 'p1', source: 'commoncrawl', release: 'cc-main-2026-jan-feb-mar', domains: [['cc-a.com', 10]], queriedAt: '2026-03-01T00:00:00.000Z' })
      seedSourceData(db, { projectId: 'p1', source: 'bing-webmaster', release: 'bing-2026-06-14', domains: [['bing-a.com', 5]], queriedAt: '2026-06-14T00:00:00.000Z' })
      seedSourceData(db, { projectId: 'p1', source: 'bing-webmaster', release: 'bing-2026-06-15', domains: [['bing-b.com', 6]], queriedAt: '2026-06-15T00:00:00.000Z' })

      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/history?source=bing-webmaster' })
      const body = res.json() as Array<{ release: string; source: string }>
      expect(body).toHaveLength(2)
      expect(body.every((e) => e.source === 'bing-webmaster')).toBe(true)
      expect(body[0]!.release).toBe('bing-2026-06-14')
      expect(body[1]!.release).toBe('bing-2026-06-15')
    })

    it('rejects an invalid source', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/summary?source=ahrefs' })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('GET /projects/:name/backlinks/sources', () => {
    it('reports neither connected when nothing is set up', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/sources' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as BacklinkSourcesResponseDto
      expect(body.targetDomain).toBe('roots.io')
      expect(body.anyConnected).toBe(false)
      expect(body.anyData).toBe(false)
      expect(body.sources.find((s) => s.source === 'commoncrawl')!.connected).toBe(false)
      expect(body.sources.find((s) => s.source === 'bing-webmaster')!.connected).toBe(false)
    })

    it('reports CC connected only when autoExtract is on AND a ready sync exists', async () => {
      const now = new Date().toISOString()
      db.insert(projects).values({
        id: 'p1', name: 'roots', displayName: 'roots', canonicalDomain: 'roots.io',
        country: 'US', language: 'en', autoExtractBacklinks: true, createdAt: now, updatedAt: now,
      }).run()
      db.insert(ccReleaseSyncs).values({ id: 's1', release: 'cc-main-2026-jan-feb-mar', status: 'ready', createdAt: now, updatedAt: now }).run()
      seedSourceData(db, { projectId: 'p1', source: 'commoncrawl', release: 'cc-main-2026-jan-feb-mar', domains: [['cc-a.com', 10]] })

      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/sources' })
      const body = res.json() as BacklinkSourcesResponseDto
      const cc = body.sources.find((s) => s.source === 'commoncrawl')!
      expect(cc.connected).toBe(true)
      expect(cc.hasData).toBe(true)
      expect(cc.totalLinkingDomains).toBe(1)
      expect(cc.latestRelease).toBe('cc-main-2026-jan-feb-mar')
      expect(body.anyConnected).toBe(true)
    })

    it('CC stays not-connected when autoExtract is on but only a non-ready sync exists', async () => {
      const now = new Date().toISOString()
      db.insert(projects).values({
        id: 'p1', name: 'roots', displayName: 'roots', canonicalDomain: 'roots.io',
        country: 'US', language: 'en', autoExtractBacklinks: true, createdAt: now, updatedAt: now,
      }).run()
      db.insert(ccReleaseSyncs).values({ id: 's1', release: 'cc-main-2026-jan-feb-mar', status: 'downloading', createdAt: now, updatedAt: now }).run()

      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/sources' })
      const body = res.json() as BacklinkSourcesResponseDto
      expect(body.sources.find((s) => s.source === 'commoncrawl')!.connected).toBe(false)
    })

    it('reports Bing connected when the connection store resolves the domain', async () => {
      const { app: custom, db: customDb } = buildApp({ bingConnectionStore: fakeBingStore({ 'roots.io': {} }) })
      await custom.ready()
      insertProject(customDb, 'p1', 'roots', 'roots.io')
      seedSourceData(customDb, { projectId: 'p1', source: 'bing-webmaster', release: 'bing-2026-06-15', domains: [['bing-a.com', 5]] })

      const res = await custom.inject({ method: 'GET', url: '/projects/roots/backlinks/sources' })
      const body = res.json() as BacklinkSourcesResponseDto
      const bing = body.sources.find((s) => s.source === 'bing-webmaster')!
      expect(bing.connected).toBe(true)
      expect(bing.hasData).toBe(true)
      expect(bing.lastSyncedAt).not.toBeNull()
      expect(body.anyConnected).toBe(true)
      await custom.close()
    })

    it('totalLinkingDomains excludes crawler/proxy hosts so the count matches the dashboard view', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      // google.com is a filtered crawler host; only real.com should count.
      seedSourceData(db, {
        projectId: 'p1', source: 'commoncrawl', release: 'cc-main-2026-jan-feb-mar',
        domains: [['google.com', 100], ['scholar.google.com', 50], ['real.com', 5]],
      })

      const res = await app.inject({ method: 'GET', url: '/projects/roots/backlinks/sources' })
      const cc = (res.json() as BacklinkSourcesResponseDto).sources.find((s) => s.source === 'commoncrawl')!
      // Stored summary totalLinkingDomains is 3 (unfiltered), but the surfaced
      // count drops both google hosts → 1, matching the crawler-filtered view.
      expect(cc.totalLinkingDomains).toBe(1)
    })
  })

  describe('POST /projects/:name/backlinks/bing-sync', () => {
    it('422 when the sync callback is not wired (cloud)', async () => {
      insertProject(db, 'p1', 'roots', 'roots.io')
      const res = await app.inject({ method: 'POST', url: '/projects/roots/backlinks/bing-sync' })
      expect(res.statusCode).toBe(422)
      expect((res.json() as { error: { code: string } }).error.code).toBe('MISSING_DEPENDENCY')
    })

    it('400 when no Bing connection exists for the project', async () => {
      const spy = vi.fn()
      const { app: custom, db: customDb } = buildApp({ onBingBacklinkSyncRequested: spy, bingConnectionStore: fakeBingStore({}) })
      await custom.ready()
      insertProject(customDb, 'p1', 'roots', 'roots.io')
      const res = await custom.inject({ method: 'POST', url: '/projects/roots/backlinks/bing-sync' })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
      expect(spy).not.toHaveBeenCalled()
      await custom.close()
    })

    it('creates a run and fires onBingBacklinkSyncRequested when connected', async () => {
      const spy = vi.fn()
      const { app: custom, db: customDb } = buildApp({ onBingBacklinkSyncRequested: spy, bingConnectionStore: fakeBingStore({ 'roots.io': {} }) })
      await custom.ready()
      insertProject(customDb, 'p1', 'roots', 'roots.io')
      const res = await custom.inject({ method: 'POST', url: '/projects/roots/backlinks/bing-sync' })
      expect(res.statusCode).toBe(201)
      const body = res.json() as { id: string; projectId: string; kind: string }
      expect(body.projectId).toBe('p1')
      expect(spy).toHaveBeenCalledWith(body.id, 'p1')
      const stored = customDb.select().from(runs).where(eq(runs.id, body.id)).get()
      expect(stored).toBeDefined()
      await custom.close()
    })
  })

  describe('DELETE /backlinks/cache/:release', () => {
    it('invokes the prune callback', async () => {
      const spy = vi.fn()
      const { app: custom } = buildApp({ onBacklinksPruneCache: spy })
      await custom.ready()
      const res = await custom.inject({
        method: 'DELETE',
        url: '/backlinks/cache/cc-main-2026-jan-feb-mar',
      })
      expect(res.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith('cc-main-2026-jan-feb-mar')
      await custom.close()
    })

    it('rejects invalid release ids', async () => {
      const spy = vi.fn()
      const { app: custom } = buildApp({ onBacklinksPruneCache: spy })
      await custom.ready()
      const res = await custom.inject({
        method: 'DELETE',
        url: '/backlinks/cache/not-valid',
      })
      expect(res.statusCode).toBe(400)
      expect(spy).not.toHaveBeenCalled()
      await custom.close()
    })
  })

  describe('GET /backlinks/releases', () => {
    it('returns data from the listCachedReleases callback', async () => {
      const { app: custom } = buildApp({
        listCachedReleases: () => [
          { release: 'cc-main-2026-jan-feb-mar', syncStatus: 'ready', bytes: 1000, lastUsedAt: '2026-04-01T00:00:00.000Z' },
        ],
      })
      await custom.ready()
      const res = await custom.inject({ method: 'GET', url: '/backlinks/releases' })
      const body = res.json() as Array<{ release: string }>
      expect(body).toHaveLength(1)
      expect(body[0]!.release).toBe('cc-main-2026-jan-feb-mar')
      await custom.close()
    })
  })
})
