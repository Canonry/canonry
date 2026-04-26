import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { bingUrlInspections, bingCoverageSnapshots, createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { bingRoutes, __resetBingCrawlIssuesCacheForTest } from '../src/bing.js'
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

  beforeEach(async () => {
    db.delete(bingUrlInspections).run()
    db.delete(bingCoverageSnapshots).run()
    connections.clear()
    __resetBingCrawlIssuesCacheForTest()

    const now = new Date().toISOString()
    connections.set('example.com', {
      domain: 'example.com',
      apiKey: 'test-key',
      siteUrl: 'https://example.com/',
      createdAt: now,
      updatedAt: now,
    })

    // Default: no crawl issues. Individual tests override with mockResolvedValue.
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getCrawlIssues').mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('maps HttpStatus into httpCode and leaves inIndex null when Bing returns no crawl or discovery signals', async () => {
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/page',
      HttpStatus: 200,
      DocumentSize: 0,
      IsPage: true,
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
    expect(rows[0]!.syncRunId).toBeTruthy()

    const inspectRuns = db.select().from(runs)
      .where(eq(runs.kind, RunKinds['bing-inspect']))
      .all()
    expect(inspectRuns).toHaveLength(1)
    expect(inspectRuns[0]!.status).toBe(RunStatuses.completed)
    expect(inspectRuns[0]!.trigger).toBe(RunTriggers.manual)
    expect(rows[0]!.syncRunId).toBe(inspectRuns[0]!.id)
  })

  it('derives indexed=true from positive DocumentSize', async () => {
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

  it('derives indexed=true from LastCrawledDate when DocumentSize=0 and HttpStatus is missing/zero', async () => {
    // Regression for issue #342: Bing's modern GetUrlInfo often returns
    // DocumentSize=0 and an absent or zero HttpStatus for URLs that are clearly
    // indexed in the Bing UI, as long as LastCrawledDate/DiscoveryDate are set.
    const lastCrawledMs = new Date('2026-03-12T17:37:29Z').getTime()
    const discoveryMs = new Date('2026-03-12T07:00:00Z').getTime()
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/indexed-zero-size',
      HttpStatus: 0,
      DocumentSize: 0,
      LastCrawledDate: `/Date(${lastCrawledMs})/`,
      DiscoveryDate: `/Date(${discoveryMs})/`,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/inspect-url',
      payload: { url: 'https://example.com/indexed-zero-size' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      inIndex: boolean | null
      httpCode: number | null
      lastCrawledDate: string | null
    }
    expect(body.httpCode).toBe(0)
    expect(body.inIndex).toBe(true)
    expect(body.lastCrawledDate).toBe('2026-03-12T17:37:29.000Z')
  })

  it('derives indexed=false when a crawled URL returned a 4xx HttpStatus', async () => {
    const lastCrawledMs = new Date('2026-03-20T10:00:00Z').getTime()
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/broken',
      HttpStatus: 404,
      DocumentSize: 0,
      LastCrawledDate: `/Date(${lastCrawledMs})/`,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/inspect-url',
      payload: { url: 'https://example.com/broken' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { inIndex: boolean | null; httpCode: number | null }
    expect(body.httpCode).toBe(404)
    expect(body.inIndex).toBe(false)
  })

  it('derives indexed=false when Bing has discovered a URL but not yet crawled it', async () => {
    const discoveryMs = new Date('2026-03-18T07:00:00Z').getTime()
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/discovered-only',
      HttpStatus: 0,
      DocumentSize: 0,
      DiscoveryDate: `/Date(${discoveryMs})/`,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/inspect-url',
      payload: { url: 'https://example.com/discovered-only' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { inIndex: boolean | null; lastCrawledDate: string | null; discoveryDate: string | null }
    expect(body.inIndex).toBe(false)
    expect(body.lastCrawledDate).toBeNull()
    expect(body.discoveryDate).toBe('2026-03-18T07:00:00.000Z')
  })

  it('demotes an indexed URL to not-indexed when GetCrawlIssues flags a blocking issue', async () => {
    const lastCrawledMs = new Date('2026-03-20T10:00:00Z').getTime()
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/blocked',
      HttpStatus: 200,
      DocumentSize: 2048,
      LastCrawledDate: `/Date(${lastCrawledMs})/`,
    })
    vi.spyOn(bingModule, 'getCrawlIssues').mockResolvedValue([
      { Url: 'https://example.com/blocked', HttpCode: 200, Date: '2026-03-20', IssueType: 'Blocked' },
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/inspect-url',
      payload: { url: 'https://example.com/blocked' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { inIndex: boolean | null }
    expect(body.inIndex).toBe(false)
  })

  it('keeps indexed classification when GetCrawlIssues only flags SEO-only concerns', async () => {
    const lastCrawledMs = new Date('2026-03-20T10:00:00Z').getTime()
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/seo-warn',
      HttpStatus: 200,
      DocumentSize: 2048,
      LastCrawledDate: `/Date(${lastCrawledMs})/`,
    })
    vi.spyOn(bingModule, 'getCrawlIssues').mockResolvedValue([
      { Url: 'https://example.com/seo-warn', HttpCode: 200, Date: '2026-03-20', IssueType: 'SeoIssues' },
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/inspect-url',
      payload: { url: 'https://example.com/seo-warn' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { inIndex: boolean | null }
    expect(body.inIndex).toBe(true)
  })

  it('keeps indexed classification when GetCrawlIssues lookup fails', async () => {
    const lastCrawledMs = new Date('2026-03-20T10:00:00Z').getTime()
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockResolvedValue({
      Url: 'https://example.com/ok',
      HttpStatus: 200,
      DocumentSize: 2048,
      LastCrawledDate: `/Date(${lastCrawledMs})/`,
    })
    vi.spyOn(bingModule, 'getCrawlIssues').mockRejectedValue(new Error('rate limited'))

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/inspect-url',
      payload: { url: 'https://example.com/ok' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { inIndex: boolean | null }
    expect(body.inIndex).toBe(true)
  })

  it('caches GetCrawlIssues across sequential inspections within the TTL', async () => {
    const lastCrawledMs = new Date('2026-03-20T10:00:00Z').getTime()
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async (_apiKey, _siteUrl, url) => ({
      Url: url,
      HttpStatus: 200,
      DocumentSize: 1024,
      LastCrawledDate: `/Date(${lastCrawledMs})/`,
    }))
    const crawlIssuesSpy = vi.spyOn(bingModule, 'getCrawlIssues').mockResolvedValue([])

    await app.inject({ method: 'POST', url: '/projects/test-project/bing/inspect-url', payload: { url: 'https://example.com/a' } })
    await app.inject({ method: 'POST', url: '/projects/test-project/bing/inspect-url', payload: { url: 'https://example.com/b' } })
    await app.inject({ method: 'POST', url: '/projects/test-project/bing/inspect-url', payload: { url: 'https://example.com/c' } })

    expect(crawlIssuesSpy).toHaveBeenCalledTimes(1)
  })

  it('coverage includes unknown rows in total for percentage calculation', async () => {
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
      total: 3,
      indexed: 1,
      notIndexed: 1,
      unknown: 1,
      percentage: 33.3,
    })
    expect(body.indexed.map((row) => row.url)).toEqual(['https://example.com/indexed'])
    expect(body.notIndexed.map((row) => row.url)).toEqual(['https://example.com/not-indexed'])
    expect(body.unknown.map((row) => row.url)).toEqual(['https://example.com/unknown'])
  })

  it('performance normalizes non-finite CTR values to 0', async () => {
    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getKeywordStats').mockResolvedValue([
      { Query: 'normal query', Impressions: 100, Clicks: 5, Ctr: 0.05, AverageClickPosition: 3, AverageImpressionPosition: 3 },
      { Query: 'nan ctr', Impressions: 0, Clicks: 0, Ctr: NaN, AverageClickPosition: 0, AverageImpressionPosition: 0 },
      { Query: 'infinity ctr', Impressions: 0, Clicks: 0, Ctr: Infinity, AverageClickPosition: 0, AverageImpressionPosition: 0 },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/projects/test-project/bing/performance',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ query: string; ctr: number }>
    expect(body).toHaveLength(3)
    expect(body[0]!.ctr).toBe(0.05)
    expect(body[1]!.ctr).toBe(0)
    expect(body[2]!.ctr).toBe(0)
  })

  it('allUnindexed submits URLs with not-indexed or unknown status', async () => {
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
    const submitUrlBatchSpy = vi.spyOn(bingModule, 'submitUrlBatch').mockResolvedValue()

    const res = await app.inject({
      method: 'POST',
      url: '/projects/test-project/bing/request-indexing',
      payload: { allUnindexed: true },
    })

    expect(res.statusCode).toBe(200)
    expect(submitUrlBatchSpy).toHaveBeenCalledTimes(1)
    const submittedUrls = submitUrlBatchSpy.mock.calls[0]![2] as string[]
    expect(submittedUrls).toContain('https://example.com/not-indexed')
    expect(submittedUrls).toContain('https://example.com/unknown')
    expect(submittedUrls).not.toContain('https://example.com/indexed')
  })

  it('coverage endpoint saves a daily snapshot', async () => {
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId,
      projectId,
      kind: RunKinds['bing-inspect'],
      status: RunStatuses.completed,
      trigger: RunTriggers.manual,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    }).run()
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
        syncRunId: runId,
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
        syncRunId: runId,
        createdAt: now,
        documentSize: 0,
        anchorCount: null,
        discoveryDate: null,
      },
    ]).run()

    const res = await app.inject({
      method: 'GET',
      url: '/projects/test-project/bing/coverage',
    })
    expect(res.statusCode).toBe(200)

    const snapshots = db.select().from(bingCoverageSnapshots).all()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.indexed).toBe(1)
    expect(snapshots[0]!.notIndexed).toBe(1)
    expect(snapshots[0]!.unknown).toBe(0)
    expect(snapshots[0]!.date).toBe(new Date().toISOString().split('T')[0])
    expect(snapshots[0]!.syncRunId).toBe(runId)
  })

  it('coverage-history returns snapshots in descending date order', async () => {
    const now = new Date().toISOString()
    db.insert(bingCoverageSnapshots).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-18', indexed: 5, notIndexed: 2, unknown: 1, createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-19', indexed: 6, notIndexed: 1, unknown: 0, createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-20', indexed: 7, notIndexed: 1, unknown: 0, createdAt: now },
    ]).run()

    const res = await app.inject({
      method: 'GET',
      url: '/projects/test-project/bing/coverage/history',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ date: string; indexed: number; notIndexed: number; unknown: number }>
    expect(body).toHaveLength(3)
    expect(body[0]!.date).toBe('2026-03-20')
    expect(body[0]!.indexed).toBe(7)
    expect(body[2]!.date).toBe('2026-03-18')
    expect(body[2]!.indexed).toBe(5)
  })

  it('inspect-sitemap creates a queued run and invokes the callback with the sitemap URL', async () => {
    const callback = vi.fn()

    const inspectApp = Fastify()
    inspectApp.decorate('db', db)
    inspectApp.register(bingRoutes, {
      bingConnectionStore: {
        getConnection: () => connections.get('example.com'),
        upsertConnection: (c) => { connections.set(c.domain, c); return c },
        updateConnection: (d, p) => {
          const e = connections.get(d); if (!e) return undefined
          const n = { ...e, ...p }; connections.set(d, n); return n
        },
        deleteConnection: (d) => connections.delete(d),
      },
      onInspectSitemapRequested: callback,
    })
    await inspectApp.ready()

    try {
      const res = await inspectApp.inject({
        method: 'POST',
        url: '/projects/test-project/bing/inspect-sitemap',
        payload: { sitemapUrl: 'https://example.com/custom-sitemap.xml' },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json() as { id: string; kind: string; status: string }
      expect(body.kind).toBe(RunKinds['bing-inspect-sitemap'])
      expect(body.status).toBe(RunStatuses.queued)

      expect(callback).toHaveBeenCalledTimes(1)
      const [runIdArg, projectIdArg, optsArg] = callback.mock.calls[0]!
      expect(runIdArg).toBe(body.id)
      expect(projectIdArg).toBe(projectId)
      expect(optsArg).toEqual({ sitemapUrl: 'https://example.com/custom-sitemap.xml' })

      const stored = db.select().from(runs).where(eq(runs.id, body.id)).get()
      expect(stored?.kind).toBe(RunKinds['bing-inspect-sitemap'])
      expect(stored?.status).toBe(RunStatuses.queued)
      expect(stored?.trigger).toBe(RunTriggers.manual)
    } finally {
      await inspectApp.close()
    }
  })

  it('inspect-sitemap rejects with 400 when no Bing site is configured', async () => {
    connections.set('example.com', {
      domain: 'example.com',
      apiKey: 'test-key',
      siteUrl: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const inspectApp = Fastify()
    inspectApp.decorate('db', db)
    inspectApp.register(bingRoutes, {
      bingConnectionStore: {
        getConnection: () => connections.get('example.com'),
        upsertConnection: (c) => { connections.set(c.domain, c); return c },
        updateConnection: (d, p) => {
          const e = connections.get(d); if (!e) return undefined
          const n = { ...e, ...p }; connections.set(d, n); return n
        },
        deleteConnection: (d) => connections.delete(d),
      },
      onInspectSitemapRequested: vi.fn(),
    })
    await inspectApp.ready()

    try {
      const res = await inspectApp.inject({
        method: 'POST',
        url: '/projects/test-project/bing/inspect-sitemap',
        payload: {},
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await inspectApp.close()
    }
  })

  it('coverage-history respects limit parameter', async () => {
    const now = new Date().toISOString()
    db.insert(bingCoverageSnapshots).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-18', indexed: 5, notIndexed: 2, unknown: 1, createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-19', indexed: 6, notIndexed: 1, unknown: 0, createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-20', indexed: 7, notIndexed: 1, unknown: 0, createdAt: now },
    ]).run()

    const res = await app.inject({
      method: 'GET',
      url: '/projects/test-project/bing/coverage/history?limit=2',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ date: string }>
    expect(body).toHaveLength(2)
    expect(body[0]!.date).toBe('2026-03-20')
    expect(body[1]!.date).toBe('2026-03-19')
  })
})
