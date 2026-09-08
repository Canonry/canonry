import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteAuditPages,
  siteAuditSnapshots,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlEventReceipts,
  siteCrawlGraphEdges,
  siteCrawlGraphLayouts,
  siteCrawlGraphNodes,
  siteCrawlPages,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'

// The executor is intentionally tested at the event boundary.  The audit
// engine has its own HTTP/BFS suite; Canonry owns receipt, graph, and publish
// semantics.
vi.mock('@canonry/aeo-audit', () => ({ runSiteCrawl: vi.fn() }))
vi.mock('@ainyc/canonry-api-routes', () => ({
  resolvePublicHttpTarget: vi.fn(),
  resolveWebhookTarget: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../src/site-audit-root.js', () => ({
  resolveSiteAuditRootUrl: vi.fn(async (url: string) => {
    const normalizedUrl = new URL(url).href
    return { requestedUrl: normalizedUrl, effectiveUrl: normalizedUrl, redirects: [] }
  }),
}))
import { runSiteCrawl } from '@canonry/aeo-audit'
import { isNonPageMedia,
  clampSiteAuditEdgeLimit,
  clampSiteAuditLimit,
  computeFactorAverages,
  executeSiteAudit,
  SITE_AUDIT_DEFAULT_PAGE_LIMIT,
  SITE_AUDIT_MAX_EDGE_LIMIT,
  SITE_AUDIT_MAX_PAGE_LIMIT,
} from '../src/execute-site-audit.js'
import { resolveSiteAuditRootUrl } from '../src/site-audit-root.js'
import { SITE_CRAWL_GRAPH_LAYOUT_VERSION } from '../src/site-crawl-graph-layout.js'
import { deriveSiteHealthState } from '@ainyc/canonry-contracts'

const NOW = '2026-08-08T00:00:00.000Z'

function scoredFactor(id: string, name: string, weight: number, score: number) {
  return {
    id, name, weight, score,
    findings: [{ type: 'info', code: `${id}.test-evidence`, message: `${name} evidence.` }],
    recommendations: [`Improve ${name}.`],
  }
}

function page(key: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    requestedUrl: url,
    finalUrl: url,
    state: 'html',
    depth: key === 'page:root' ? 0 : 1,
    provenance: { discoveredFrom: [], sitemapSources: [], root: key === 'page:root' },
    statusCode: 200,
    contentType: 'text/html',
    redirectChain: [],
    canonicalUrl: url,
    metaRobots: [],
    xRobots: [],
    path: new URL(url).pathname,
    directory: '/',
    indexability: { state: 'indexable', reasons: [], rulesetVersion: '1.0.0' },
    audit: {
      url,
      finalUrl: url,
      auditedAt: NOW,
      overallScore: 88,
      factors: [scoredFactor('sd', 'Structured Data', 12, 88)],
      criticalDefects: [{
        id: 'missing-meta-description',
        severity: 'warning',
        detail: 'No meta description found.',
        recommendation: 'Add a concise meta description.',
      }],
    },
    error: null,
    metrics: {
      inbound: { totalOccurrences: 0, uniqueEdges: 0 },
      outbound: { totalOccurrences: 0, uniqueEdges: 0 },
      shortestFollowableAnchorDepth: key === 'page:root' ? 0 : 1,
      linkScoreRaw: 0.5,
      linkScore: 100,
    },
    ...overrides,
  }
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    crawlSchemaVersion: '1.0',
    engineVersion: '4.5.0',
    crawlEngineVersion: '1.0.0',
    urlNormalizationVersion: '1.0.0',
    indexabilityRulesetVersion: '1.0.0',
    linkScoreAlgorithmVersion: 'pagerank-1.0.0',
    rootUrl: 'https://example.com/',
    finalRootUrl: 'https://example.com/',
    startedAt: NOW,
    completedAt: NOW,
    complete: true,
    terminationReason: null,
    pagesDiscovered: 2,
    pagesFetched: 2,
    pagesObserved: 2,
    edgesObserved: 1,
    bytesRead: 100,
    fetchesStarted: 2,
    elapsedMs: 10,
    limits: {
      maxPages: 500,
      maxEdges: 10_000,
      maxFetches: 5000,
      maxDurationMs: 120000,
      maxBytes: 1000000,
      maxPageBytes: 100000,
      maxDepth: 10,
      maxLinksPerPage: 1000,
      maxQueryVariants: 10,
      maxSitemapFanout: 1000,
      maxSitemapUrls: 50000,
      concurrency: 1,
    },
    auditRollup: { auditedPages: 2, aggregateScore: 88, factors: [{ id: 'sd', name: 'Structured Data', count: 2, averageScore: 88 }] },
    ...overrides,
  }
}

async function emitCompleteGraph(
  options: { onEvent?: (event: unknown) => Promise<void> | void },
  complete = true,
  rootUrl = 'https://example.com/',
) {
  const childUrl = new URL('/a', rootUrl).href
  await options.onEvent?.({
    type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'pages-checksum',
    rows: [page('page:root', rootUrl), page('page:a', childUrl)],
  })
  await options.onEvent?.({
    type: 'edges', sequence: 2, batchId: 'edges-1', checksum: 'edges-checksum',
    rows: [{
      key: 'edge:root-a', from: rootUrl, to: childUrl, type: 'anchor', classification: 'internal',
      totalOccurrences: 2, followableOccurrences: 2, nofollowOccurrences: 0, anchorSummaries: [{ text: 'A', occurrences: 2 }],
    }],
  })
  await options.onEvent?.({
    type: 'metrics', sequence: 3, batchId: 'metrics-1', checksum: 'metrics-checksum',
    rows: [
      { key: 'page:root', metrics: page('page:root', rootUrl).metrics },
      { key: 'page:a', metrics: page('page:a', childUrl).metrics },
    ],
  })
  const endSummary = summary({
    rootUrl,
    finalRootUrl: rootUrl,
    ...(complete ? {} : { complete: false, terminationReason: 'max-pages' }),
  })
  await options.onEvent?.({ type: 'summary', sequence: 4, batchId: 'summary-1', checksum: complete ? 'summary-ok' : 'summary-partial', summary: endSummary })
  return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
}

describe('computeFactorAverages', () => {
  it('averages successful audit reports and preserves per-band counts', () => {
    const pages = [
      { audit: { factors: [scoredFactor('sd', 'Structured Data', 12, 90)] } },
      { audit: { factors: [scoredFactor('sd', 'Structured Data', 12, 50)] } },
      { audit: null },
    ]
    const [sd] = computeFactorAverages(pages as never)
    expect(sd).toMatchObject({ id: 'sd', avgScore: 70, pagesPassing: 1, pagesPartial: 1, pagesFailing: 0 })
  })
})

describe('clampSiteAuditLimit', () => {
  it('defaults and clamps page budget', () => {
    expect(clampSiteAuditLimit(undefined)).toBe(SITE_AUDIT_DEFAULT_PAGE_LIMIT)
    expect(clampSiteAuditLimit(0)).toBe(1)
    expect(clampSiteAuditLimit(99999)).toBe(SITE_AUDIT_MAX_PAGE_LIMIT)
  })

  it('leaves an unset edge budget unset so the engine derives it from the page count', () => {
    // Passing the flat default here would cap BELOW the engine's derivation
    // (pages x 50, floored at 100,000) for any crawl over 2,000 pages,
    // quietly recreating the ceiling the 7.1.0 engine removed.
    expect(clampSiteAuditEdgeLimit(undefined)).toBeUndefined()
    expect(clampSiteAuditEdgeLimit(Number.NaN)).toBeUndefined()
    expect(clampSiteAuditEdgeLimit(0)).toBe(1)
    expect(clampSiteAuditEdgeLimit(400_000)).toBe(400_000)
    expect(clampSiteAuditEdgeLimit(99_999_999)).toBe(SITE_AUDIT_MAX_EDGE_LIMIT)
  })
})

describe('executeSiteAudit', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-exec-site-audit-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'p', displayName: 'P', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: [], locations: [],
      createdAt: NOW, updatedAt: NOW,
    }).run()
    vi.mocked(runSiteCrawl).mockReset()
    vi.mocked(resolveSiteAuditRootUrl).mockReset()
    vi.mocked(resolveSiteAuditRootUrl).mockImplementation(async (url) => {
      const normalizedUrl = new URL(url).href
      return { requestedUrl: normalizedUrl, effectiveUrl: normalizedUrl, redirects: [] }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedRun(): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'site-audit', status: 'queued', trigger: 'manual', createdAt: NOW }).run()
    return id
  }

  it('persists checkpoint batches, publishes a complete immutable graph, and keeps legacy audit reads populated', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (url, options) => emitCompleteGraph(options, true, url))
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { maxPages: 500, maxEdges: 10_000 })

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
    const attempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()
    expect(attempt).toMatchObject({ state: 'completed', lastEventSequence: 4 })
    expect(db.select().from(siteCrawlEventReceipts).where(eq(siteCrawlEventReceipts.attemptId, attempt!.id)).all()).toHaveLength(4)
    const crawlPages = db.select().from(siteCrawlPages).where(eq(siteCrawlPages.attemptId, attempt!.id)).all()
    expect(crawlPages).toHaveLength(2)
    expect(crawlPages.find((page) => page.nodeKey === 'page:root')?.auditFields).toEqual({
      schemaVersion: '1.0',
      factors: [{
        id: 'sd',
        name: 'Structured Data',
        weight: 12,
        score: 88,
        status: 'pass',
        applicable: null,
        findings: [{ type: 'info', code: 'sd.test-evidence', message: 'Structured Data evidence.' }],
        recommendations: ['Improve Structured Data.'],
      }],
      criticalDefects: [{
        id: 'missing-meta-description',
        severity: 'warning',
        detail: 'No meta description found.',
        recommendation: 'Add a concise meta description.',
      }],
    })
    expect(db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.attemptId, attempt!.id)).get()).toMatchObject({ occurrences: 2, followable: true })
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toMatchObject({ complete: true, detailsAvailable: true })
    expect(db.select().from(siteCrawlGraphLayouts).where(eq(siteCrawlGraphLayouts.runId, runId)).get()).toMatchObject({
      state: 'ready', layoutVersion: SITE_CRAWL_GRAPH_LAYOUT_VERSION, totalNodes: 2, totalEdges: 1, nodeCount: 2, edgeCount: 1,
    })
    const graphNodes = db.select().from(siteCrawlGraphNodes).where(eq(siteCrawlGraphNodes.runId, runId)).all()
    expect(graphNodes).toHaveLength(2)
    expect(graphNodes.find((node) => node.nodeKey === 'page:root')).toMatchObject({ x: 0, y: 0, sampleRank: 0 })
    expect(db.select().from(siteCrawlGraphEdges).where(eq(siteCrawlGraphEdges.runId, runId)).get()).toMatchObject({
      edgeKey: 'edge:root-a', sourceNodeKey: 'page:root', targetNodeKey: 'page:a', sampleRank: 0,
    })
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toMatchObject({ aggregateScore: 88 })
    expect(db.select().from(siteAuditPages).where(eq(siteAuditPages.runId, runId)).all()).toHaveLength(2)
  })

  it('persists the crawler placement report, and the ruleset version that produced it', async () => {
    // Placement is the evidence behind every nav-vs-content decision, so it is
    // stored per link rather than collapsed into the decision. The ruleset
    // version on the snapshot is what a read uses to know the scan HAD
    // placement at all, which is unanswerable from links alone on a scan with
    // no links.
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'pages-checksum',
        rows: [page('page:root', 'https://example.com/'), page('page:a', 'https://example.com/a')],
      })
      await options.onEvent?.({
        type: 'edges', sequence: 2, batchId: 'edges-1', checksum: 'edges-checksum',
        rows: [{
          key: 'edge:root-a', from: 'https://example.com/', to: 'https://example.com/a',
          type: 'anchor', classification: 'internal',
          totalOccurrences: 3, followableOccurrences: 3, nofollowOccurrences: 0,
          anchorSummaries: [{ text: 'A', occurrences: 3 }],
          placementOccurrences: { navigation: 2, content: 1, unknown: 0 },
        }],
      })
      const endSummary = summary({ edgesObserved: 1, linkPlacementRulesetVersion: '1.0.0' })
      await options.onEvent?.({ type: 'summary', sequence: 3, batchId: 'summary-1', checksum: 'summary-ok', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, {})

    const attempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()
    expect(db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.attemptId, attempt!.id)).get()).toMatchObject({
      placementNavigationOccurrences: 2,
      placementContentOccurrences: 1,
      placementUnknownOccurrences: 0,
      // One content occurrence makes the whole link editorial, whatever the
      // two nav repeats on the same row say.
      isTemplate: false,
      // The fallback rule never ran, so none of its evidence is invented.
      templateRatio: null,
    })
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toMatchObject({
      linkPlacementRulesetVersion: '1.0.0',
      templateDetection: 'applied-placement',
    })
  })

  it('records a crawl with no placement report as classified by the weaker rule', async () => {
    // A pre-4.7.0 engine image emits no placement. Nothing may be invented for
    // it: the columns stay NULL and the scan says out loud that ubiquity, not
    // the page layout, produced its split.
    vi.mocked(runSiteCrawl).mockImplementation(async (url, options) => emitCompleteGraph(options, true, url))
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, {})

    const attempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()
    expect(db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.attemptId, attempt!.id)).get()).toMatchObject({
      placementNavigationOccurrences: null,
      placementContentOccurrences: null,
      placementUnknownOccurrences: null,
    })
    // Two fetched pages is below the ubiquity floor, so this scan could not be
    // classified by either rule, and it reports exactly that.
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toMatchObject({
      linkPlacementRulesetVersion: null,
      templateDetection: 'unavailable-too-few-pages',
    })
  })

  it('never stores a self-link, so edges agree with the page metrics', async () => {
    // A page linking to itself is not a link to or from another page, and the
    // engine already excludes it from that page's metrics. Storing it made a
    // self-loop appear in BOTH neighbour lists, so the page read one link
    // higher in each direction than its own tiles.
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'pages-checksum',
        rows: [page('page:root', 'https://example.com/'), page('page:a', 'https://example.com/a')],
      })
      await options.onEvent?.({
        type: 'edges', sequence: 2, batchId: 'edges-1', checksum: 'edges-checksum',
        rows: [
          {
            key: 'edge:root-a', from: 'https://example.com/', to: 'https://example.com/a',
            type: 'anchor', classification: 'internal',
            totalOccurrences: 2, followableOccurrences: 2, nofollowOccurrences: 0,
            anchorSummaries: [{ text: 'A', occurrences: 2 }],
          },
          {
            // The self-link, with no anchor text, exactly as observed.
            key: 'edge:a-a', from: 'https://example.com/a', to: 'https://example.com/a',
            type: 'anchor', classification: 'internal',
            totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
            anchorSummaries: [],
          },
        ],
      })
      await options.onEvent?.({
        type: 'metrics', sequence: 3, batchId: 'metrics-1', checksum: 'metrics-checksum',
        rows: [
          { key: 'page:root', metrics: page('page:root', 'https://example.com/').metrics },
          { key: 'page:a', metrics: page('page:a', 'https://example.com/a').metrics },
        ],
      })
      const endSummary = summary()
      await options.onEvent?.({ type: 'summary', sequence: 4, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)

    const edges = db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.runId, runId)).all()
    expect(edges.map((edge) => edge.edgeKey)).toEqual(['edge:root-a'])
    expect(edges.every((edge) => edge.sourceUrl !== edge.targetUrl)).toBe(true)
    // The published graph sample cannot contain one either, so the map is
    // never asked to draw a loop from a node to itself.
    expect(db.select().from(siteCrawlGraphEdges).where(eq(siteCrawlGraphEdges.runId, runId)).all()
      .every((edge) => edge.sourceNodeKey !== edge.targetNodeKey)).toBe(true)

    // The page metrics the engine reported are untouched: importance and depth
    // never counted the self-link, and dropping it changes neither.
    const pageA = db.select().from(siteCrawlPages).where(eq(siteCrawlPages.nodeKey, 'page:a')).get()!
    expect(pageA.depth).toBe(page('page:a', 'https://example.com/a').metrics.shortestFollowableAnchorDepth)
    expect(pageA.linkScoreNormalized).toBe(page('page:a', 'https://example.com/a').metrics.linkScore)
  })

  it('hands the validated effective root to the crawl engine', async () => {
    vi.mocked(resolveSiteAuditRootUrl).mockResolvedValue({
      requestedUrl: 'https://example.com/',
      effectiveUrl: 'https://www.example.com/',
      redirects: [{ status: 301, from: 'https://example.com/', to: 'https://www.example.com/' }],
    })
    vi.mocked(runSiteCrawl).mockImplementation(async (url, options) => emitCompleteGraph(options, true, url))
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    expect(resolveSiteAuditRootUrl).toHaveBeenCalledWith('https://example.com', expect.objectContaining({
      resolveTarget: expect.any(Function),
    }))
    expect(runSiteCrawl).toHaveBeenCalledWith('https://www.example.com/', expect.any(Object))
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toMatchObject({
      requestedRootUrl: 'https://example.com/',
      rootUrl: 'https://www.example.com/',
    })
  })

  it('publishes the crawl when ForceAtlas2 times out and records layout unavailability', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => emitCompleteGraph(options))
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { graphLayoutTimeoutMs: 1 })

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toBeDefined()
    expect(db.select().from(siteCrawlGraphLayouts).where(eq(siteCrawlGraphLayouts.runId, runId)).get()).toMatchObject({
      state: 'unavailable', layoutVersion: null, failureCode: 'layout-timeout',
      totalNodes: 2, totalEdges: 1, nodeCount: 0, edgeCount: 0,
    })
    expect(db.select().from(siteCrawlGraphNodes).where(eq(siteCrawlGraphNodes.runId, runId)).all()).toEqual([])
  })

  it('publishes an unavailable marker when ready-layout persistence fails', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const result = await emitCompleteGraph(options)
      vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
        throw new Error('forced graph persistence failure')
      })
      return result
    })
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
    expect(db.select().from(siteCrawlGraphLayouts).where(eq(siteCrawlGraphLayouts.runId, runId)).get()).toMatchObject({
      state: 'unavailable', failureCode: 'layout-error', totalNodes: 2, totalEdges: 1, nodeCount: 0, edgeCount: 0,
    })
    expect(db.select().from(siteCrawlGraphNodes).where(eq(siteCrawlGraphNodes.runId, runId)).all()).toEqual([])
    expect(db.select().from(siteCrawlGraphEdges).where(eq(siteCrawlGraphEdges.runId, runId)).all()).toEqual([])
  })

  it('centers the terminal home page when the crawl root redirects from apex to www', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const finalRootUrl = 'https://www.example.com/'
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'redirected-root-pages', checksum: 'redirected-root-pages',
        rows: [
          page('page:redirect-root', 'https://example.com/', {
            finalUrl: finalRootUrl,
            state: 'redirect',
            depth: 0,
            audit: null,
            indexability: { state: 'redirect', reasons: ['redirect'], rulesetVersion: '1.0.0' },
          }),
          page('page:www-root', finalRootUrl, {
            depth: 0,
            provenance: { discoveredFrom: ['https://example.com/'], sitemapSources: [], root: true },
          }),
        ],
      })
      const endSummary = summary({
        finalRootUrl,
        pagesDiscovered: 2,
        pagesFetched: 2,
        pagesObserved: 2,
        edgesObserved: 0,
        auditRollup: { auditedPages: 1, aggregateScore: 88, factors: [] },
      })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'redirected-root-summary', checksum: 'redirected-root-summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    expect(db.select().from(siteCrawlGraphNodes).where(and(
      eq(siteCrawlGraphNodes.runId, runId),
      eq(siteCrawlGraphNodes.nodeKey, 'page:www-root'),
    )).get()).toMatchObject({ sampleRank: 0, x: 0, y: 0 })
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toMatchObject({
      requestedRootUrl: 'https://example.com/',
      rootUrl: 'https://www.example.com/',
    })
  })

  it('keeps technically indexable HTML in inventory when factor analysis fails', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const rows = [
        page('page:root', 'https://example.com/'),
        page('page:analysis-failed', 'https://example.com/analysis-failed', { audit: null }),
      ]
      await options.onEvent?.({ type: 'pages', sequence: 1, batchId: 'pages', checksum: 'pages', rows })
      const endSummary = summary({ auditRollup: { auditedPages: 1, aggregateScore: 88, factors: [] } })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)
    const row = db.select().from(siteCrawlPages).where(eq(siteCrawlPages.nodeKey, 'page:analysis-failed')).get()
    expect(row).toMatchObject({ inventoryEligible: true, auditState: 'not-applicable' })
  })

  it('keeps legacy scorecard rows to audited pages and genuine fetch failures', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const audited = page('page:root', 'https://example.com/')
      const fetchError = page('page:fetch-error', 'https://example.com/unreachable', {
        state: 'fetch-error', statusCode: null, audit: null, error: 'timeout',
        indexability: { state: 'unknown', reasons: ['fetch-error'], rulesetVersion: '1.0.0' },
      })
      const robotsBlocked = page('page:robots', 'https://example.com/private', {
        state: 'robots-blocked', statusCode: null, audit: null, error: null,
        indexability: { state: 'blocked', reasons: ['robots-blocked'], rulesetVersion: '1.0.0' },
      })
      const redirect = page('page:redirect', 'https://example.com/old', {
        state: 'redirect', finalUrl: 'https://example.com/new', audit: null, error: null,
        indexability: { state: 'redirect', reasons: ['redirect'], rulesetVersion: '1.0.0' },
      })
      const nonHtml = page('page:pdf', 'https://example.com/brochure.pdf', {
        state: 'non-html', contentType: 'application/pdf', audit: null, error: null,
        indexability: { state: 'non-html', reasons: ['non-html'], rulesetVersion: '1.0.0' },
      })
      const discovered = page('page:depth', 'https://example.com/deep', {
        state: 'discovered', statusCode: null, audit: null, error: null,
        indexability: { state: 'unknown', reasons: ['max-depth'], rulesetVersion: '1.0.0' },
      })
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'legacy-row-semantics', checksum: 'legacy-row-semantics',
        rows: [audited, fetchError, robotsBlocked, redirect, nonHtml, discovered],
      })
      const endSummary = summary({
        pagesDiscovered: 6,
        pagesFetched: 4,
        pagesObserved: 6,
        auditRollup: { auditedPages: 1, aggregateScore: 88, factors: [] },
      })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toMatchObject({
      pagesAudited: 1,
      pagesErrored: 1,
    })
    expect(db.select({ url: siteAuditPages.url, status: siteAuditPages.status, overallScore: siteAuditPages.overallScore, error: siteAuditPages.error })
      .from(siteAuditPages)
      .where(eq(siteAuditPages.runId, runId))
      .all()
      .sort((a, b) => a.url.localeCompare(b.url)))
      .toEqual([
        { url: 'https://example.com/', status: 'success', overallScore: 88, error: null },
        { url: 'https://example.com/unreachable', status: 'error', overallScore: 0, error: 'timeout' },
      ])
  })

  it('backfills an inbound edge node key when its target page arrives later', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'root', checksum: 'root', rows: [page('page:root', 'https://example.com/')],
      })
      await options.onEvent?.({
        type: 'edges', sequence: 2, batchId: 'edge', checksum: 'edge', rows: [{
          key: 'edge:root-a', from: 'https://example.com/', to: 'https://example.com/a', type: 'anchor', classification: 'internal',
          totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [{ text: 'A', occurrences: 1 }],
        }],
      })
      await options.onEvent?.({
        type: 'pages', sequence: 3, batchId: 'target', checksum: 'target', rows: [page('page:a', 'https://example.com/a')],
      })
      const endSummary = summary()
      await options.onEvent?.({ type: 'summary', sequence: 4, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)
    expect(db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.edgeKey, 'edge:root-a')).get()?.targetNodeKey).toBe('page:a')
  })

  it('prefers the terminal HTML node and rebinds references after a redirect alias arrives first', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const newUrl = 'https://example.com/new'
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'pages-initial', checksum: 'pages-initial', rows: [
          page('page:root', 'https://example.com/', { canonicalUrl: newUrl }),
          page('page:old', 'https://example.com/old', {
            finalUrl: newUrl,
            state: 'redirect',
            canonicalUrl: null,
            audit: null,
            indexability: { state: 'redirect', reasons: ['redirect'], rulesetVersion: '1.0.0' },
          }),
        ],
      })
      await options.onEvent?.({
        type: 'edges', sequence: 2, batchId: 'edges-to-new', checksum: 'edges-to-new', rows: [{
          key: 'edge:root-new', from: 'https://example.com/', to: newUrl, type: 'anchor', classification: 'internal',
          totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [{ text: 'New', occurrences: 1 }],
        }],
      })
      await options.onEvent?.({
        type: 'pages', sequence: 3, batchId: 'page-final', checksum: 'page-final', rows: [page('page:new', newUrl)],
      })
      const endSummary = summary()
      await options.onEvent?.({ type: 'summary', sequence: 4, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)

    expect(db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.edgeKey, 'edge:root-new')).get()?.targetNodeKey).toBe('page:new')
    const root = db.select().from(siteCrawlPages).where(eq(siteCrawlPages.nodeKey, 'page:root')).get()!
    expect(root.canonicalNodeKey).toBe('page:new')
    // Canonical identity resolves after the row is first written, and it flips
    // the derived state. The persisted column must follow, not keep the answer
    // insert time could see.
    expect(root.healthState).toBe('hidden')
    expect(root.healthState).toBe(deriveSiteHealthState(root))
  })

  it('persists the derived health state the contract decides for every page', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => emitCompleteGraph(options))
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)

    const pages = db.select().from(siteCrawlPages).where(eq(siteCrawlPages.runId, runId)).all()
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) {
      // Written once, here, by the same function the map and the API filter
      // read, so no consumer has to recompute it and none can drift.
      expect(page.healthState, page.nodeKey).toBe(deriveSiteHealthState(page))
      expect(page.healthState).not.toBeNull()
    }
  })

  it('counts only attempted internal anchor targets for opted-in dead-link checks', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const anchorTarget = page('page:anchor', 'https://example.com/anchor')
      const canonicalTarget = page('page:canonical', 'https://example.com/canonical')
      const redirectTarget = page('page:redirect', 'https://example.com/redirect', {
        state: 'redirect', audit: null,
        indexability: { state: 'redirect', reasons: ['redirect'], rulesetVersion: '1.0.0' },
      })
      const undiscoveredTarget = page('page:discovered', 'https://example.com/discovered', {
        state: 'discovered', audit: null,
        indexability: { state: 'unknown', reasons: [], rulesetVersion: '1.0.0' },
      })
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'pages', checksum: 'pages',
        rows: [page('page:root', 'https://example.com/'), anchorTarget, canonicalTarget, redirectTarget, undiscoveredTarget],
      })
      await options.onEvent?.({
        type: 'edges', sequence: 2, batchId: 'edges', checksum: 'edges', rows: [
          { key: 'anchor', from: 'https://example.com/', to: anchorTarget.requestedUrl, type: 'anchor', classification: 'internal', totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [] },
          { key: 'canonical', from: 'https://example.com/', to: canonicalTarget.requestedUrl, type: 'canonical', classification: 'internal', totalOccurrences: 1, followableOccurrences: 0, nofollowOccurrences: 0, anchorSummaries: [] },
          { key: 'redirect', from: 'https://example.com/', to: redirectTarget.requestedUrl, type: 'redirect', classification: 'internal', totalOccurrences: 1, followableOccurrences: 0, nofollowOccurrences: 0, anchorSummaries: [] },
          { key: 'unfetched-anchor', from: 'https://example.com/', to: undiscoveredTarget.requestedUrl, type: 'anchor', classification: 'internal', totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [] },
        ],
      })
      const endSummary = summary({ pagesDiscovered: 5, pagesFetched: 4, pagesObserved: 5, edgesObserved: 4, auditRollup: { auditedPages: 3, aggregateScore: 88, factors: [] } })
      await options.onEvent?.({ type: 'summary', sequence: 3, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'complete', findings: [], unverified: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { checkDeadLinks: true })

    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()?.deadLinksChecked).toBe(1)
  })

  it('keeps a partial snapshot inspectable without replacing the last complete graph', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => emitCompleteGraph(options, true))
    const goodRun = seedRun()
    await executeSiteAudit(db, goodRun, projectId)

    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => emitCompleteGraph(options, false))
    const partialRun = seedRun()
    await executeSiteAudit(db, partialRun, projectId)

    expect(db.select().from(runs).where(eq(runs.id, partialRun)).get()?.status).toBe('partial')
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, partialRun)).get()).toMatchObject({
      complete: false,
      termination: 'max-pages',
      detailsAvailable: true,
    })
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, goodRun)).get()).toBeDefined()
    expect(db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, partialRun)).get()?.state).toBe('partial')
  })

  it('keeps image observations out of the persisted graph, but keeps a PDF', async () => {
    // Guards the WIRING. A unit test of isNonPageMedia still passes with the
    // filter removed from registerPageNode, which is the state that shipped
    // 1,518 JPEGs into a real graph.
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const root = 'https://example.com/'
      const image = page('page:image', 'https://example.com/assets/images/hero.jpg', {
        state: 'non-html', contentType: 'image/jpeg', audit: null,
      })
      const pdf = page('page:pdf', 'https://example.com/brochure.pdf', {
        state: 'non-html', contentType: 'application/pdf', audit: null,
      })
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'pages-1',
        rows: [page('page:root', root), image, pdf],
      })
      const endSummary = summary({ rootUrl: root, finalRootUrl: root })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary-1', checksum: 'summary-ok', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)

    const urls = db.select({ url: siteCrawlPages.url }).from(siteCrawlPages)
      .where(eq(siteCrawlPages.runId, runId)).all().map(row => row.url)
    expect(urls.some(url => url.endsWith('/hero.jpg'))).toBe(false)
    expect(urls.some(url => url.endsWith('/brochure.pdf'))).toBe(true)
    expect(urls.some(url => url === 'https://example.com/')).toBe(true)
  })

  it('publishes a zero-audit terminated crawl as an inspectable partial graph', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const failedPage = page('page:failed', 'https://example.com/unreachable', {
        state: 'fetch-error', statusCode: null, audit: null, error: 'timeout',
        indexability: { state: 'unknown', reasons: ['fetch-error'], rulesetVersion: '1.0.0' },
      })
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'failed-page', checksum: 'failed-page', rows: [failedPage],
      })
      const endSummary = summary({
        complete: false,
        terminationReason: 'max-duration',
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        edgesObserved: 0,
        auditRollup: { auditedPages: 0, aggregateScore: null, factors: [] },
      })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'partial', findings: [], unverified: [] } }
    })
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    const attempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()!
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('partial')
    expect(attempt.state).toBe('partial')
    expect(db.select().from(siteCrawlEventReceipts).where(eq(siteCrawlEventReceipts.attemptId, attempt.id)).all()).toHaveLength(2)
    expect(db.select().from(siteCrawlPages).where(eq(siteCrawlPages.attemptId, attempt.id)).all()).toHaveLength(1)
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toMatchObject({
      complete: false,
      termination: 'max-duration',
      detailsAvailable: true,
      pagesErrored: 1,
    })
    // A zero-audit traversal has no scorecard; only its historical crawl graph
    // is published, so it cannot create a deceptive latest score of zero.
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toBeUndefined()
    expect(db.select().from(siteAuditPages).where(eq(siteAuditPages.runId, runId)).all()).toEqual([])
  })

  it('names an off-host root redirect when a complete crawl produces no audits', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const redirectedRoot = page('page:root', 'https://example.com/', {
        finalUrl: 'https://other.example/', state: 'redirect', audit: null,
        indexability: { state: 'redirect', reasons: ['redirect'], rulesetVersion: '1.0.0' },
      })
      await options.onEvent?.({ type: 'pages', sequence: 1, batchId: 'off-host-root', checksum: 'off-host-root', rows: [redirectedRoot] })
      const endSummary = summary({
        finalRootUrl: 'https://other.example/',
        terminationReason: 'root-host-redirect',
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        edgesObserved: 0,
        auditRollup: { auditedPages: 0, aggregateScore: null, factors: [] },
      })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()

    await expect(executeSiteAudit(db, runId, projectId)).rejects.toThrow(
      'root URL redirected off-host from example.com to other.example (https://other.example/)',
    )
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({ status: 'failed' })
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toBeUndefined()
  })

  it('keeps fetchedAt null for robots-blocked page inserts and upserts', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const robotsPage = (key: string, url: string) => page(key, url, {
        state: 'robots-blocked', statusCode: null, audit: null, error: null,
        indexability: { state: 'blocked', reasons: ['robots-blocked'], rulesetVersion: '1.0.0' },
      })
      const inserted = robotsPage('page:robots-insert', 'https://example.com/robots-insert')
      const upserted = robotsPage('page:robots-upsert', 'https://example.com/robots-upsert')
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'robots-pages', checksum: 'robots-pages', rows: [inserted, upserted],
      })
      await options.onEvent?.({
        type: 'pages', sequence: 2, batchId: 'robots-upsert', checksum: 'robots-upsert', rows: [upserted],
      })
      const endSummary = summary({
        complete: false,
        terminationReason: 'max-depth',
        pagesDiscovered: 2,
        pagesFetched: 0,
        pagesObserved: 2,
        edgesObserved: 0,
        auditRollup: { auditedPages: 0, aggregateScore: null, factors: [] },
      })
      await options.onEvent?.({ type: 'summary', sequence: 3, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'partial', findings: [], unverified: [] } }
    })
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    const rows = db.select().from(siteCrawlPages).where(eq(siteCrawlPages.runId, runId)).all()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.fetchedAt)).toEqual([null, null])
  })

  it('preserves the first fetchedAt timestamp when a fetched page is upserted', async () => {
    vi.useFakeTimers()
    const firstFetchedAt = new Date('2026-08-08T01:00:00.000Z')
    const updatedAt = new Date('2026-08-08T02:00:00.000Z')
    vi.setSystemTime(firstFetchedAt)
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const fetched = page('page:root', 'https://example.com/')
      await options.onEvent?.({ type: 'pages', sequence: 1, batchId: 'fetched-first', checksum: 'fetched-first', rows: [fetched] })
      vi.setSystemTime(updatedAt)
      await options.onEvent?.({ type: 'pages', sequence: 2, batchId: 'fetched-update', checksum: 'fetched-update', rows: [fetched] })
      const endSummary = summary({ pagesDiscovered: 1, pagesFetched: 1, pagesObserved: 1, edgesObserved: 0, auditRollup: { auditedPages: 1, aggregateScore: 88, factors: [] } })
      await options.onEvent?.({ type: 'summary', sequence: 3, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    expect(db.select().from(siteCrawlPages).where(eq(siteCrawlPages.nodeKey, 'page:root')).get()).toMatchObject({
      fetchedAt: firstFetchedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    })
  })

  it('replays matching event receipts without duplicating graph rows and rejects a mismatched replay', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const event = { type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'same', rows: [page('page:root', 'https://example.com/')] }
      await options.onEvent?.(event)
      await options.onEvent?.(event)
      await expect(options.onEvent?.({ ...event, checksum: 'different' })).rejects.toThrow(/checksum/i)
      const endSummary = summary({ pagesDiscovered: 1, pagesFetched: 1, pagesObserved: 1, edgesObserved: 0, auditRollup: { auditedPages: 1, aggregateScore: 88, factors: [] } })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [], unverified: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)
    const attempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()!
    expect(db.select().from(siteCrawlPages).where(eq(siteCrawlPages.attemptId, attempt.id)).all()).toHaveLength(1)
    expect(db.select().from(siteCrawlEventReceipts).where(eq(siteCrawlEventReceipts.attemptId, attempt.id)).all()).toHaveLength(2)
  })

  it('keeps a cancelled run cancelled when the engine rejects with its abort signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Cancelled by user'))
    vi.mocked(runSiteCrawl).mockImplementation(async () => { throw controller.signal.reason })
    const runId = seedRun()
    await expect(executeSiteAudit(db, runId, projectId, { signal: controller.signal })).rejects.toThrow('Cancelled by user')
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('cancelled')
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toBeUndefined()
  })

  it('keeps a typed AbortError cancelled without relying on its message text', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async () => { throw new DOMException('operation stopped', 'AbortError') })
    const runId = seedRun()

    await expect(executeSiteAudit(db, runId, projectId)).rejects.toThrow('operation stopped')

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({ status: 'cancelled' })
  })

  it('fails an unrelated engine error after the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Cancelled by user'))
    vi.mocked(runSiteCrawl).mockImplementation(async () => { throw new Error('provider connection failed') })
    const runId = seedRun()

    await expect(executeSiteAudit(db, runId, projectId, { signal: controller.signal })).rejects.toThrow('provider connection failed')

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({
      status: 'failed',
      error: 'provider connection failed',
    })
    expect(db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()).toMatchObject({
      state: 'failed',
      error: 'provider connection failed',
    })
  })

  it('does not publish audit snapshots when cancellation wins after the crawl completes', async () => {
    const runId = seedRun()
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const result = await emitCompleteGraph(options)
      db.update(runs).set({ status: 'cancelled', finishedAt: NOW }).where(eq(runs.id, runId)).run()
      return result
    })

    await expect(executeSiteAudit(db, runId, projectId)).rejects.toThrow(/cancelled before publication/i)
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('cancelled')
    expect(db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()?.state).toBe('cancelled')
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toBeUndefined()
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toBeUndefined()
    expect(db.select().from(siteCrawlGraphLayouts).where(eq(siteCrawlGraphLayouts.runId, runId)).all()).toEqual([])
    expect(db.select().from(siteCrawlGraphNodes).where(eq(siteCrawlGraphNodes.runId, runId)).all()).toEqual([])
    expect(db.select().from(siteCrawlGraphEdges).where(eq(siteCrawlGraphEdges.runId, runId)).all()).toEqual([])
  })

  it('keeps the typed cancellation error when graph cleanup loses its storage write', async () => {
    const runId = seedRun()
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const result = await emitCompleteGraph(options)
      db.update(runs).set({ status: 'cancelled', finishedAt: NOW }).where(eq(runs.id, runId)).run()
      return result
    })
    vi.spyOn(db, 'delete').mockImplementationOnce(() => {
      throw new Error('graph cleanup storage failed')
    })

    await expect(executeSiteAudit(db, runId, projectId)).rejects.toThrow(/cancelled before publication/i)
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('cancelled')
  })

  it('honors a signal-only cancellation that arrives after the crawl returns', async () => {
    const controller = new AbortController()
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const result = await emitCompleteGraph(options)
      controller.abort(new Error('cancelled after crawl'))
      return result
    })
    const runId = seedRun()

    await expect(executeSiteAudit(db, runId, projectId, { signal: controller.signal })).rejects.toThrow('cancelled after crawl')

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('cancelled')
    expect(db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()?.state).toBe('cancelled')
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).all()).toEqual([])
    expect(db.select().from(siteCrawlGraphLayouts).where(eq(siteCrawlGraphLayouts.runId, runId)).all()).toEqual([])
  })
})

describe('isNonPageMedia', () => {
  const at = (requestedUrl: string, contentType: string | null = null) => ({ requestedUrl, contentType })

  it('excludes the image tree that flooded a real crawl', () => {
    // 1,518 of these came from one /assets/images/ directory: 13% of the nodes.
    expect(isNonPageMedia(at('https://example.com/assets/images/004-Model-LR.jpg'))).toBe(true)
    expect(isNonPageMedia(at('https://example.com/assets/images/006_dsc01166-new_993.JPG'))).toBe(true)
  })

  it('keeps a PDF and a text file, which an answer engine can read', () => {
    expect(isNonPageMedia(at('https://example.com/brochure.pdf'))).toBe(false)
    expect(isNonPageMedia(at('https://example.com/robots.txt'))).toBe(false)
  })

  it('keeps ordinary pages, including deep and trailing-slash paths', () => {
    expect(isNonPageMedia(at('https://example.com/'))).toBe(false)
    expect(isNonPageMedia(at('https://example.com/apartments/atlanta-metro/dunwoody-apts/'))).toBe(false)
  })

  it('catches an extensionless media URL by content type', () => {
    expect(isNonPageMedia(at('https://cdn.example.com/media/12345', 'image/webp'))).toBe(true)
    expect(isNonPageMedia(at('https://example.com/video/9', 'video/mp4; codecs=avc1'))).toBe(true)
  })

  it('does not let a query value masquerade as an extension', () => {
    // The PATH decides. A page tagged with an image-looking param is a page.
    expect(isNonPageMedia(at('https://example.com/gallery?utm_content=hero.png'))).toBe(false)
  })

  it('still excludes media that carries a query string', () => {
    expect(isNonPageMedia(at('https://example.com/assets/images/hero.jpg?v=2'))).toBe(true)
  })

  it('falls back to the raw string when the URL will not parse', () => {
    expect(isNonPageMedia(at('not-a-url/logo.svg'))).toBe(true)
    expect(isNonPageMedia(at('not-a-url/page'))).toBe(false)
  })
})
