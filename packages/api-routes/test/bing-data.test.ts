import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunKinds } from '@canonry/canonry-contracts'
import {
  bingCrawlStats,
  bingKeywordDemand,
  bingPageStats,
  bingQueryStats,
  bingSiteSnapshots,
  bingSitemaps,
  bingTrafficDaily,
  createClient,
  migrate,
  projects,
  queries,
  runs,
} from '@canonry/canonry-db'
import { __resetBingThrottleCooldownForTest } from '@canonry/canonry-integration-bing'
import { bingRoutes } from '../src/bing.js'
import type { BingConnectionRecord, BingConnectionStore } from '../src/bing.js'
import { resolveBingWindow } from '../src/bing-data.js'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../integration-bing/test/fixtures')
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

function buildApp(onSyncRequested: (runId: string, projectId: string) => void) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-data-routes-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
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
  app.register(bingRoutes, { bingConnectionStore, onSyncRequested })
  return { app, db, tmpDir, connections }
}

interface BingCall { method: string; url: URL; body: unknown }

function mockBing(responses: Record<string, { status?: number; body: string }>): BingCall[] {
  const calls: BingCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = url.pathname.split('/').pop()!
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined })
    const response = responses[method]
    if (!response) return new Response(`unexpected Bing call ${method}`, { status: 500 })
    return new Response(response.body, { status: response.status ?? 200 })
  }) as typeof globalThis.fetch
  return calls
}

function day(offset: number): string {
  const d = new Date('2026-10-01T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

describe('Bing data routes', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let connections: Map<string, BingConnectionRecord>
  let projectId: string
  let originalFetch: typeof globalThis.fetch
  const onSyncRequested = vi.fn()

  beforeAll(async () => {
    const ctx = buildApp(onSyncRequested)
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    connections = ctx.connections
    await app.ready()
    projectId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: projectId, name: 'test-project', displayName: 'Test Project', canonicalDomain: 'example.com',
      ownedDomains: '[]', country: 'US', language: 'en', tags: '[]', labels: '{}', providers: '[]',
      locations: '[]', defaultLocation: null, configSource: 'cli', configRevision: 1, createdAt: now, updatedAt: now,
    }).run()
  })

  beforeEach(() => {
    originalFetch = globalThis.fetch
    __resetBingThrottleCooldownForTest()
    onSyncRequested.mockReset()
    for (const table of [bingTrafficDaily, bingQueryStats, bingPageStats, bingCrawlStats, bingSitemaps, bingSiteSnapshots, bingKeywordDemand, queries, runs]) {
      db.delete(table).run()
    }
    connections.clear()
    connections.set('example.com', { domain: 'example.com', apiKey: 'test-key', siteUrl: 'https://example.com/', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const get = async (url: string) => app.inject({ method: 'GET', url })

  describe('POST /bing/sync', () => {
    it('queues a bing-sync run and hands it to the executor', async () => {
      const res = await app.inject({ method: 'POST', url: '/projects/test-project/bing/sync' })
      expect(res.statusCode).toBe(200)
      const run = res.json<{ id: string; kind: string; status: string }>()
      expect(run).toMatchObject({ kind: RunKinds['bing-sync'], status: 'queued' })
      expect(onSyncRequested).toHaveBeenCalledWith(run.id, projectId)
    })

    it('refuses without a selected site and writes no run row', async () => {
      connections.set('example.com', { ...connections.get('example.com')!, siteUrl: null })
      const res = await app.inject({ method: 'POST', url: '/projects/test-project/bing/sync' })
      expect(res.statusCode).toBe(400)
      // This bare app has no API error handler, so Fastify's default envelope carries the message.
      expect(res.json<{ message: string }>().message).toMatch(/set-site/)
      expect(db.select().from(runs).all()).toHaveLength(0)
      expect(onSyncRequested).not.toHaveBeenCalled()
    })
  })

  describe('GET /bing/traffic', () => {
    beforeEach(() => {
      db.insert(bingTrafficDaily).values(Array.from({ length: 31 }, (_, i) => ({
        id: crypto.randomUUID(), projectId, date: day(i), clicks: i, impressions: 10 * i, syncRunId: null, syncedAt: '2026-11-03T00:00:00Z',
      }))).run()
    })

    it('defaults to 28 days ending at the newest stored day, with totals', async () => {
      const body = (await get('/projects/test-project/bing/traffic')).json<{ rows: Array<{ date: string }>; totals: { clicks: number; impressions: number; ctr: number }; window: { startDate: string; endDate: string }; latestAvailableDate: string; earliestAvailableDate: string }>()
      expect(body.window).toEqual({ startDate: '2026-10-04', endDate: '2026-10-31' })
      expect(body.rows).toHaveLength(28)
      expect(body.rows[0]!.date).toBe('2026-10-04')
      const expectedClicks = Array.from({ length: 28 }, (_, i) => i + 3).reduce((a, b) => a + b, 0)
      expect(body.totals).toEqual({ clicks: expectedClicks, impressions: expectedClicks * 10, ctr: 0.1 })
      expect(body.latestAvailableDate).toBe('2026-10-31')
      expect(body.earliestAvailableDate).toBe('2026-10-01')
    })

    it('honours explicit bounds and rejects a backwards range', async () => {
      const body = (await get('/projects/test-project/bing/traffic?startDate=2026-10-01&endDate=2026-10-02')).json<{ rows: unknown[]; totals: { clicks: number } }>()
      expect(body.rows).toHaveLength(2)
      expect(body.totals.clicks).toBe(1)
      expect((await get('/projects/test-project/bing/traffic?startDate=2026-10-05&endDate=2026-10-01')).statusCode).toBe(400)
      expect((await get('/projects/test-project/bing/traffic?days=0')).statusCode).toBe(400)
    })
  })

  it('returns an empty traffic read before the first sync', async () => {
    const body = (await get('/projects/test-project/bing/traffic')).json<{ rows: unknown[]; latestAvailableDate: string | null; window: unknown }>()
    expect(body).toMatchObject({ rows: [], latestAvailableDate: null, window: { startDate: null, endDate: null } })
  })

  describe('GET /bing/queries and /bing/pages', () => {
    beforeEach(() => {
      const base = { projectId, avgClickPosition: null, syncRunId: null, syncedAt: '2026-11-03T00:00:00Z' }
      db.insert(bingQueryStats).values([
        { ...base, id: crypto.randomUUID(), date: '2026-10-03', query: 'garage heater', clicks: 1, impressions: 10, avgImpressionPosition: 2 },
        { ...base, id: crypto.randomUUID(), date: '2026-10-10', query: 'garage heater', clicks: 2, impressions: 20, avgImpressionPosition: 4 },
        { ...base, id: crypto.randomUUID(), date: '2026-10-17', query: 'garage heater', clicks: 3, impressions: 30, avgImpressionPosition: 6 },
        { ...base, id: crypto.randomUUID(), date: '2026-10-10', query: 'shop heater', clicks: 5, impressions: 5, avgImpressionPosition: null },
        { ...base, id: crypto.randomUUID(), date: '2026-08-01', query: 'old query', clicks: 50, impressions: 500, avgImpressionPosition: 1 },
      ]).run()
      db.insert(bingPageStats).values([
        { ...base, id: crypto.randomUUID(), date: '2026-10-10', page: 'https://example.com/', clicks: 9, impressions: 90, avgImpressionPosition: 1.5 },
        { ...base, id: crypto.randomUUID(), date: '2026-10-17', page: 'https://example.com/pricing/', clicks: 1, impressions: 40, avgImpressionPosition: 8 },
      ]).run()
    })

    it('sums weekly buckets per query inside the window with impression-weighted position', async () => {
      const body = (await get('/projects/test-project/bing/queries?startDate=2026-10-01&endDate=2026-10-31')).json<{ groupBy: string; rows: Array<Record<string, unknown>>; totalMatching: number; truncated: boolean }>()
      expect(body.groupBy).toBe('query')
      expect(body.totalMatching).toBe(2)
      expect(body.truncated).toBe(false)
      expect(body.rows[0]).toEqual({ query: 'garage heater', clicks: 6, impressions: 60, ctr: 0.1, avgImpressionPosition: 4.67, avgClickPosition: null, weeks: 3 })
      expect(body.rows[1]).toMatchObject({ query: 'shop heater', clicks: 5, avgImpressionPosition: null, weeks: 1 })
    })

    it('groups by week, filters by substring, and pages', async () => {
      const weekly = (await get('/projects/test-project/bing/queries?startDate=2026-10-01&endDate=2026-10-31&groupBy=week')).json<{ weekly: Array<{ date: string; clicks: number; impressions: number }>; rows: unknown[] }>()
      expect(weekly.rows).toEqual([])
      expect(weekly.weekly.map((w) => [w.date, w.clicks, w.impressions])).toEqual([['2026-10-03', 1, 10], ['2026-10-10', 7, 25], ['2026-10-17', 3, 30]])

      const filtered = (await get('/projects/test-project/bing/queries?startDate=2026-10-01&query=shop')).json<{ rows: Array<{ query: string }> }>()
      expect(filtered.rows.map((r) => r.query)).toEqual(['shop heater'])

      const paged = (await get('/projects/test-project/bing/queries?startDate=2026-10-01&endDate=2026-10-31&limit=1')).json<{ rows: unknown[]; truncated: boolean; totalMatching: number }>()
      expect(paged).toMatchObject({ truncated: true, totalMatching: 2 })
      expect(paged.rows).toHaveLength(1)

      expect((await get('/projects/test-project/bing/queries?groupBy=page')).statusCode).toBe(400)
    })

    it('anchors the default window at the newest stored week', async () => {
      const body = (await get('/projects/test-project/bing/queries')).json<{ window: { startDate: string; endDate: string }; rows: Array<{ query: string }> }>()
      expect(body.window).toEqual({ startDate: '2026-09-20', endDate: '2026-10-17' })
      expect(body.rows.map((r) => r.query)).not.toContain('old query')
    })

    it('reads pages the same way', async () => {
      const body = (await get('/projects/test-project/bing/pages?startDate=2026-10-01')).json<{ groupBy: string; rows: Array<{ page: string; clicks: number }> }>()
      expect(body.groupBy).toBe('page')
      expect(body.rows.map((r) => [r.page, r.clicks])).toEqual([['https://example.com/', 9], ['https://example.com/pricing/', 1]])
    })
  })

  it('returns stored crawl stats newest first without storage columns', async () => {
    db.insert(bingCrawlStats).values([
      { id: crypto.randomUUID(), projectId, date: '2026-10-30', crawledPages: 31, inIndex: 26, crawlErrors: 2, inLinks: 5, code2xx: 29, code301: 40, syncedAt: '2026-11-03T00:00:00Z' },
      { id: crypto.randomUUID(), projectId, date: '2026-10-31', crawledPages: 12, inIndex: 26, crawlErrors: 0, syncedAt: '2026-11-03T00:00:00Z' },
    ]).run()
    const body = (await get('/projects/test-project/bing/crawl-stats')).json<{ rows: Array<Record<string, unknown>> }>()
    expect(body.rows.map((r) => r.date)).toEqual(['2026-10-31', '2026-10-30'])
    expect(body.rows[1]).toMatchObject({ crawledPages: 31, code301: 40, inLinks: 5, dnsFailures: 0 })
    expect(body.rows[0]).not.toHaveProperty('id')
    expect(body.rows[0]).not.toHaveProperty('syncRunId')
  })

  it('lists stored sitemaps with top-level submissions first', async () => {
    const base = { projectId, status: 'Success', urlCount: 1, fileSize: 0, compressed: false, submittedAt: null, lastCrawledAt: null, syncRunId: null, syncedAt: '2026-11-03T00:00:00Z' }
    db.insert(bingSitemaps).values([
      { ...base, id: crypto.randomUUID(), url: 'https://example.com/a-child.xml', parentUrl: 'https://example.com/sitemap_index.xml', type: 'Sitemap' },
      { ...base, id: crypto.randomUUID(), url: 'https://example.com/sitemap_index.xml', parentUrl: null, type: 'Sitemap Index' },
    ]).run()
    const body = (await get('/projects/test-project/bing/sitemaps')).json<{ sitemaps: Array<{ url: string }>; syncedAt: string }>()
    expect(body.sitemaps.map((s) => s.url)).toEqual(['https://example.com/sitemap_index.xml', 'https://example.com/a-child.xml'])
    expect(body.syncedAt).toBe('2026-11-03T00:00:00Z')
  })

  it('returns stored site settings, filters by kind, and rejects an unknown kind', async () => {
    db.insert(bingSiteSnapshots).values([
      { id: crypto.randomUUID(), projectId, kind: 'url-submission-quota', status: 'ok', payload: { dailyQuota: 100, monthlyQuota: 2700 }, error: null, syncRunId: null, syncedAt: '2026-11-03T00:00:00Z' },
      { id: crypto.randomUUID(), projectId, kind: 'site-roles', status: 'unauthorized', payload: null, error: 'owner-only', syncRunId: null, syncedAt: '2026-11-03T00:00:00Z' },
    ]).run()
    const all = (await get('/projects/test-project/bing/site')).json<{ snapshots: Array<{ kind: string; status: string; payload: unknown }> }>()
    expect(all.snapshots.map((s) => [s.kind, s.status])).toEqual([['url-submission-quota', 'ok'], ['site-roles', 'unauthorized']])
    const one = (await get('/projects/test-project/bing/site?kind=url-submission-quota')).json<{ snapshots: Array<{ payload: unknown }> }>()
    expect(one.snapshots).toEqual([expect.objectContaining({ payload: { dailyQuota: 100, monthlyQuota: 2700 } })])
    expect((await get('/projects/test-project/bing/site?kind=nope')).statusCode).toBe(400)
  })

  it('lists demand for every tracked query, read or not, and one query history', async () => {
    db.insert(queries).values([
      { id: crypto.randomUUID(), projectId, query: 'garage heater', createdAt: '2026-01-01T00:00:00Z' },
      { id: crypto.randomUUID(), projectId, query: 'never read', createdAt: '2026-01-01T00:00:00Z' },
    ]).run()
    const base = { projectId, query: 'garage heater', country: 'us', language: 'en-US', syncRunId: null, syncedAt: '2026-11-02T00:00:00Z' }
    db.insert(bingKeywordDemand).values([
      { ...base, id: crypto.randomUUID(), date: '2026-10-18', impressions: 100, broadImpressions: 150 },
      { ...base, id: crypto.randomUUID(), date: '2026-10-25', impressions: 120, broadImpressions: 170 },
      // Another market is not mixed in.
      { ...base, id: crypto.randomUUID(), country: 'gb', language: 'en-GB', date: '2026-10-25', impressions: 9, broadImpressions: 9 },
    ]).run()
    const body = (await get('/projects/test-project/bing/keyword-demand?query=garage%20heater')).json<{ market: unknown; rows: Array<Record<string, unknown>>; history: Array<{ date: string }> }>()
    expect(body.market).toEqual({ country: 'us', language: 'en-US' })
    expect(body.rows[0]).toMatchObject({ query: 'garage heater', latestWeek: '2026-10-25', latestImpressions: 120, avgWeeklyImpressions: 110, weeks: 2 })
    expect(body.rows[1]).toMatchObject({ query: 'never read', latestWeek: null, avgWeeklyImpressions: null, weeks: 0 })
    expect(body.history.map((w) => w.date)).toEqual(['2026-10-18', '2026-10-25'])
  })

  describe('live reads', () => {
    it('reads pages for a query from Bing and maps the overloaded Query field', async () => {
      const calls = mockBing({ GetQueryPageStats: { body: fixture('GetQueryPageStats.json') } })
      const res = await get('/projects/test-project/bing/query-pages?query=garage%20heater')
      expect(res.statusCode).toBe(200)
      const body = res.json<{ query: string; rows: Array<{ key: string; date: string; avgClickPosition: number | null }> }>()
      expect(body.query).toBe('garage heater')
      expect(body.rows[0]!.key).toMatch(/^https:\/\/example\.com\//)
      expect(body.rows[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(body.rows[0]!.avgClickPosition).toBeNull()
      expect(calls[0]!.url.searchParams.get('query')).toBe('garage heater')
      expect((await get('/projects/test-project/bing/query-pages')).statusCode).toBe(400)
    })

    it('switches query-history to weekly rows with position when a page is given', async () => {
      mockBing({
        GetQueryTrafficStats: { body: fixture('GetQueryTrafficStats.json') },
        GetQueryPageDetailStats: { body: fixture('GetQueryPageDetailStats.json') },
      })
      const daily = (await get('/projects/test-project/bing/query-history?query=heater')).json<{ granularity: string; rows: Array<{ position: number | null }> }>()
      expect(daily.granularity).toBe('day')
      expect(daily.rows[0]!.position).toBeNull()
      const weekly = (await get('/projects/test-project/bing/query-history?query=heater&page=https%3A%2F%2Fexample.com%2F')).json<{ granularity: string; rows: Array<{ position: number | null; clicks: number }> }>()
      expect(weekly.granularity).toBe('week')
      expect(weekly.rows.some((r) => r.position === 1 && r.clicks === 70)).toBe(true)
    })

    it('researches a keyword with three Bing reads in the project market', async () => {
      const calls = mockBing({
        GetKeyword: { body: fixture('GetKeyword.json') },
        GetKeywordStats: { body: fixture('GetKeywordStats.json') },
        GetRelatedKeywords: { body: fixture('GetRelatedKeywords.json') },
      })
      const body = (await get('/projects/test-project/bing/keywords?keyword=standing%20desk&startDate=2026-09-01&endDate=2026-10-31')).json<{
        market: unknown; window: unknown; volume: unknown; history: Array<{ date: string }>; related: Array<{ impressions: number }>
      }>()
      expect(body.market).toEqual({ country: 'us', language: 'en-US' })
      expect(body.window).toEqual({ startDate: '2026-09-01', endDate: '2026-10-31' })
      expect(body.volume).toEqual({ impressions: 3829, broadImpressions: 6355 })
      expect(body.history.map((w) => w.date)).toEqual([...body.history.map((w) => w.date)].sort())
      expect(body.related.map((r) => r.impressions)).toEqual([...body.related.map((r) => r.impressions)].sort((a, b) => b - a))
      expect(calls.map((c) => c.method)).toEqual(['GetKeyword', 'GetKeywordStats', 'GetRelatedKeywords'])
    })

    it('reads link counts, or the links to one page', async () => {
      const calls = mockBing({ GetLinkCounts: { body: fixture('GetLinkCounts.json') }, GetUrlLinks: { body: fixture('GetUrlLinks.json') } })
      expect((await get('/projects/test-project/bing/links')).json()).toEqual({ url: null, page: 0, totalPages: 0, rows: [] })
      expect((await get('/projects/test-project/bing/links?url=https%3A%2F%2Fexample.com%2F&page=2')).json()).toMatchObject({ url: 'https://example.com/', page: 2 })
      expect(calls.map((c) => c.method)).toEqual(['GetLinkCounts', 'GetUrlLinks'])
    })

    it('reports an owner-only refusal as an upstream error, not a caller error', async () => {
      mockBing({ GetFetchedUrls: { status: 400, body: '{"ErrorCode":14,"Message":"ERROR!!! NotAuthorized"}' } })
      const res = await get('/projects/test-project/bing/fetched-urls')
      expect(res.statusCode).toBe(502)
      expect(res.json<{ code: string; message: string }>()).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringMatching(/owner-only/) })
    })
  })

  describe('request-indexing quota', () => {
    it('submits only what Bing will accept and reports the rest with the reason', async () => {
      const calls = mockBing({
        GetUrlSubmissionQuota: { body: '{"d":{"__type":"UrlSubmissionQuota:#Microsoft.Bing.Webmaster.Api","DailyQuota":1,"MonthlyQuota":5}}' },
        SubmitUrl: { body: '{"d":null}' },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/projects/test-project/bing/request-indexing',
        payload: { urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'] },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ summary: { total: number; succeeded: number; failed: number }; results: Array<{ url: string; status: string; error?: string }>; quota: unknown }>()
      expect(body.quota).toEqual({ dailyQuota: 1, monthlyQuota: 5 })
      expect(body.summary).toEqual({ total: 3, succeeded: 1, failed: 2 })
      expect(body.results.find((r) => r.url === 'https://example.com/a')?.status).toBe('success')
      expect(body.results.find((r) => r.url === 'https://example.com/c')?.error).toMatch(/1 more URL submission/)
      expect(calls.map((c) => c.method)).toEqual(['GetUrlSubmissionQuota', 'SubmitUrl'])
      expect(calls[1]!.body).toEqual({ siteUrl: 'https://example.com/', url: 'https://example.com/a' })
    })

    it('still submits when the quota cannot be read', async () => {
      const calls = mockBing({
        GetUrlSubmissionQuota: { status: 400, body: '{"ErrorCode":2,"Message":"ERROR!!! InvalidParameter"}' },
        SubmitUrlbatch: { body: '{"d":null}' },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/projects/test-project/bing/request-indexing',
        payload: { urls: ['https://example.com/a', 'https://example.com/b'] },
      })
      expect(res.json<{ summary: { succeeded: number }; quota: unknown }>()).toMatchObject({ summary: { succeeded: 2 }, quota: null })
      expect(calls.map((c) => c.method)).toEqual(['GetUrlSubmissionQuota', 'SubmitUrlbatch'])
    })
  })
})

describe('resolveBingWindow', () => {
  it('anchors a span at the newest stored day and lets explicit bounds win', () => {
    expect(resolveBingWindow({}, '2026-10-31')).toEqual({ startDate: '2026-10-04', endDate: '2026-10-31' })
    expect(resolveBingWindow({ days: '7', endDate: '2026-10-10' }, '2026-10-31')).toEqual({ startDate: '2026-10-04', endDate: '2026-10-10' })
    expect(resolveBingWindow({ startDate: '2026-09-01' }, '2026-10-31')).toEqual({ startDate: '2026-09-01', endDate: null })
    expect(resolveBingWindow({}, null)).toEqual({ startDate: null, endDate: null })
    expect(() => resolveBingWindow({ startDate: '2026-13-01' }, null)).toThrow(/YYYY-MM-DD/)
  })
})

