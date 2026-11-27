import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, runs, siteAuditSnapshots, siteCrawlPages, siteCrawlSnapshots } from '@canonry/canonry-db'

// Tested at the event boundary, like execute-site-audit.test.ts: the engine's
// own suite covers crawling a second host; Canonry owns which hosts it asks
// for, how each page is tagged, and what each site's totals and score are.
vi.mock('@canonry/agent-readiness', () => ({ runSiteCrawl: vi.fn() }))
vi.mock('@canonry/canonry-api-routes', () => ({
  resolvePublicHttpTarget: vi.fn(),
  resolveWebhookTarget: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../src/site-audit-root.js', () => ({ resolveSiteAuditRootUrl: vi.fn() }))
import { runSiteCrawl } from '@canonry/agent-readiness'
import { executeSiteAudit } from '../src/execute-site-audit.js'
import { resolveSiteAuditRootUrl } from '../src/site-audit-root.js'

const NOW = '2026-11-11T00:00:00.000Z'

function page(key: string, url: string, score: number | null, overrides: Record<string, unknown> = {}) {
  return {
    key,
    requestedUrl: url,
    finalUrl: url,
    state: 'html',
    depth: 1,
    provenance: { discoveredFrom: [], sitemapSources: [], root: false },
    statusCode: 200,
    contentType: 'text/html',
    redirectChain: [],
    canonicalUrl: url,
    metaRobots: [],
    xRobots: [],
    path: new URL(url).pathname,
    directory: '/',
    indexability: { state: 'indexable', reasons: [], rulesetVersion: '1.0.0' },
    audit: score === null ? null : {
      url, finalUrl: url, auditedAt: NOW, overallScore: score,
      factors: [{ id: 'sd', name: 'Structured Data', weight: 12, score, findings: [], recommendations: [] }],
      criticalDefects: [],
    },
    error: null,
    metrics: {
      inbound: { totalOccurrences: 0, uniqueEdges: 0 },
      outbound: { totalOccurrences: 0, uniqueEdges: 0 },
      shortestFollowableAnchorDepth: 1,
      linkScoreRaw: 0.5,
      linkScore: 50,
    },
    ...overrides,
  }
}

function summary(rootUrl: string, pages: number) {
  return {
    crawlSchemaVersion: '1.0', engineVersion: '8.2.0', crawlEngineVersion: '1.0.0', urlNormalizationVersion: '1.0.0',
    indexabilityRulesetVersion: '1.0.0', linkScoreAlgorithmVersion: 'pagerank-1.0.0',
    rootUrl, finalRootUrl: rootUrl, startedAt: NOW, completedAt: NOW, complete: true, terminationReason: null,
    pagesDiscovered: pages, pagesFetched: pages, pagesObserved: pages, edgesObserved: 0, bytesRead: 100, fetchesStarted: pages, elapsedMs: 10,
    limits: {
      maxPages: 500, maxEdges: 10_000, maxFetches: 5000, maxDurationMs: 120000, maxBytes: 1000000, maxPageBytes: 100000,
      maxDepth: 10, maxLinksPerPage: 1000, maxQueryVariants: 10, maxSitemapFanout: 1000, maxSitemapUrls: 50000, concurrency: 1,
    },
    auditRollup: { auditedPages: pages, aggregateScore: 0, factors: [] },
  }
}

/** Two hosts: the main site's home page and one page, the locator's home page, a scored page and an image. */
async function emitTwoSites(rootUrl: string, options: { onEvent?: (event: unknown) => Promise<void> | void }) {
  const rows = [
    page('main:root', rootUrl, 90, { depth: 0, provenance: { discoveredFrom: [], sitemapSources: [], root: true } }),
    page('main:about', new URL('/about', rootUrl).href, 70),
    page('loc:root', 'https://apartments.example.com/', 60, { depth: 0, provenance: { discoveredFrom: [], sitemapSources: [], root: true } }),
    page('loc:westshore', 'https://apartments.example.com/westshore', 41),
    // Media is never stored, so it never counts toward a site.
    page('loc:photo', 'https://apartments.example.com/photo.jpg', null, { state: 'non-html', contentType: 'image/jpeg' }),
    // A page that is not indexable still belongs to its site but is not eligible.
    page('loc:private', 'https://apartments.example.com/private', null, {
      indexability: { state: 'not-indexable', reasons: ['noindex'], rulesetVersion: '1.0.0' },
    }),
  ]
  await options.onEvent?.({ type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'pages', rows })
  const endSummary = summary(rootUrl, rows.length)
  await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary-1', checksum: 'summary', summary: endSummary })
  return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
}

describe('Agent Readiness scans of more than one owned site', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-owned-sites-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'p', displayName: 'P', canonicalDomain: 'example.com', ownedDomains: ['apartments.example.com'],
      country: 'US', language: 'en', providers: [], locations: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    vi.mocked(runSiteCrawl).mockReset()
    vi.mocked(resolveSiteAuditRootUrl).mockReset()
    // The main domain redirects to www, as many do; the extra site does not.
    vi.mocked(resolveSiteAuditRootUrl).mockImplementation(async (url) => {
      const requested = new URL(url).href
      const effectiveUrl = requested === 'https://example.com/' ? 'https://www.example.com/' : requested
      return { requestedUrl: requested, effectiveUrl, redirects: [] }
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedRun(): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'site-audit', status: 'queued', trigger: 'manual', createdAt: NOW }).run()
    return id
  }

  it('crawls each extra site from its own root and records every site with its own totals and score', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (url, options) => emitTwoSites(url, options))
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { sites: ['apartments.example.com'] })

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
    expect(runSiteCrawl).toHaveBeenCalledWith('https://www.example.com/', expect.objectContaining({
      additionalRoots: ['https://apartments.example.com/'],
    }))

    // A main-domain row carries no site (as every row of an older scan), even on www.
    const rows = db.select({ nodeKey: siteCrawlPages.nodeKey, site: siteCrawlPages.site, path: siteCrawlPages.path })
      .from(siteCrawlPages).where(eq(siteCrawlPages.runId, runId)).all()
      .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey))
    expect(rows).toEqual([
      { nodeKey: 'loc:private', site: 'apartments.example.com', path: '/private' },
      { nodeKey: 'loc:root', site: 'apartments.example.com', path: '/' },
      { nodeKey: 'loc:westshore', site: 'apartments.example.com', path: '/westshore' },
      { nodeKey: 'main:about', site: null, path: '/about' },
      { nodeKey: 'main:root', site: null, path: '/' },
    ])

    const snapshot = db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()!
    expect(snapshot.sites).toEqual([
      { host: 'example.com', main: true, rootUrl: 'https://www.example.com/', pages: 2, pagesEligible: 2, pagesAudited: 2, aggregateScore: 80, error: null },
      // Rounded mean of 60 and 41, the headline formula on one site's pages.
      { host: 'apartments.example.com', main: false, rootUrl: 'https://apartments.example.com/', pages: 3, pagesEligible: 2, pagesAudited: 2, aggregateScore: 51, error: null },
    ])
    expect(snapshot.effectiveOptions).toMatchObject({ sites: ['apartments.example.com'] })
    // The headline still covers every page: (90 + 70 + 60 + 41) / 4.
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()?.aggregateScore).toBe(65)
  })

  it('records a site it could not reach with the reason, and still scans the main domain', async () => {
    vi.mocked(resolveSiteAuditRootUrl).mockImplementation(async (url) => {
      const requested = new URL(url).href
      if (requested === 'https://apartments.example.com/') throw new Error('Site audit root URL rejected: host resolves to a private address')
      return { requestedUrl: requested, effectiveUrl: requested, redirects: [] }
    })
    vi.mocked(runSiteCrawl).mockImplementation(async (url, options) => emitTwoSites(url, options))
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { sites: ['apartments.example.com'] })

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
    expect(vi.mocked(runSiteCrawl).mock.calls[0]?.[1]).not.toHaveProperty('additionalRoots')
    const sites = db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()!.sites!
    expect(sites[1]).toMatchObject({
      host: 'apartments.example.com',
      rootUrl: null,
      error: 'Site audit root URL rejected: host resolves to a private address',
    })
  })

  it('looks up the extra sites at the same time, not one after another', async () => {
    let inFlight = 0
    let mostInFlight = 0
    vi.mocked(resolveSiteAuditRootUrl).mockImplementation(async (url) => {
      const requested = new URL(url).href
      if (requested === 'https://example.com/') return { requestedUrl: requested, effectiveUrl: requested, redirects: [] }
      inFlight++
      mostInFlight = Math.max(mostInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
      if (requested === 'https://slow.example.com/') throw new Error('Site audit root resolution exceeded its 10000ms deadline')
      return { requestedUrl: requested, effectiveUrl: requested, redirects: [] }
    })
    db.update(projects).set({ ownedDomains: ['apartments.example.com', 'slow.example.com', 'shop.example.com'] }).where(eq(projects.id, projectId)).run()
    vi.mocked(runSiteCrawl).mockImplementation(async (url, options) => emitTwoSites(url, options))
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { sites: ['apartments.example.com', 'slow.example.com', 'shop.example.com'] })

    expect(mostInFlight).toBe(3)
    // In the order asked, the unreachable one recorded with its reason.
    expect(vi.mocked(runSiteCrawl).mock.calls[0]?.[1]).toMatchObject({ additionalRoots: ['https://apartments.example.com/', 'https://shop.example.com/'] })
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()!.sites!.map((site) => [site.host, site.error]))
      .toEqual([
        ['example.com', null],
        ['apartments.example.com', null],
        ['slow.example.com', 'Site audit root resolution exceeded its 10000ms deadline'],
        ['shop.example.com', null],
      ])
  })

  it('asks for no extra root without extra sites, or when the only one is the main domain', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (url, options) => emitTwoSites(url, options))
    for (const sites of [undefined, [], ['example.com']]) {
      vi.mocked(runSiteCrawl).mockClear()
      const runId = seedRun()
      await executeSiteAudit(db, runId, projectId, sites === undefined ? {} : { sites })
      expect(vi.mocked(runSiteCrawl).mock.calls[0]?.[1], JSON.stringify(sites)).not.toHaveProperty('additionalRoots')
      const snapshot = db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()!
      expect(snapshot.sites?.[0]).toMatchObject({ host: 'example.com', main: true })
      expect(snapshot.effectiveOptions).toMatchObject({ sites: [] })
    }
  })
})
