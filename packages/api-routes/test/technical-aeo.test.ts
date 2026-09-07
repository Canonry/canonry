import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteAuditSnapshots,
  siteAuditPages,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlFindings,
  siteCrawlGraphEdges,
  siteCrawlGraphLayouts,
  siteCrawlGraphNodes,
  siteCrawlPages,
  siteCrawlRunRequests,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'
import type {
  SiteAuditFactorSummaryDto,
  SiteAuditLivePageHealthDto,
  SiteAuditPagesResponseDto,
  SiteAuditRunProgressDto,
  SiteAuditScoreDto,
  SiteAuditTrendResponseDto,
  SiteCrawlDeadLinksResponseDto,
  SiteCrawlGraphResponseDto,
  SiteCrawlInternalLinksResponseDto,
  SiteCrawlNeighborsResponseDto,
  SiteCrawlPageAuditDto,
  SiteCrawlPagesResponseDto,
  SiteCrawlStructureResponseDto,
  SiteCrawlSummaryDto,
  SiteHealthChangesResponseDto,
  SiteHealthPathResponseDto,
  SiteHealthScansResponseDto,
  SiteHealthSubgraphResponseDto,
} from '@ainyc/canonry-contracts'
import { deriveSiteHealthState, siteHealthStateSchema } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  runA: string
  runB: string
  probeRun: string
  siteAuditRequested: Array<{
    runId: string
    projectId: string
    opts?: {
      sitemapUrl?: string
      limit?: number
      maxPages?: number
      maxEdges?: number
      maxDepth?: number
      checkDeadLinks?: boolean
    }
  }>
}

const FACTORS_B: SiteAuditFactorSummaryDto[] = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, avgScore: 80, status: 'pass', pagesPassing: 2, pagesPartial: 0, pagesFailing: 0 },
  { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, avgScore: 30, status: 'fail', pagesPassing: 0, pagesPartial: 0, pagesFailing: 2 },
]

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tech-aeo-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  const siteAuditRequested: Ctx['siteAuditRequested'] = []
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onSiteAuditRequested: (runId, projectId, opts) => { siteAuditRequested.push({ runId, projectId, opts }) },
  })

  const now = Date.now()
  const tA = new Date(now - 120_000).toISOString()
  const tB = new Date(now - 60_000).toISOString()
  const tProbe = new Date(now).toISOString()

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'tech-aeo',
    displayName: 'Tech AEO',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    locations: [],
    createdAt: tA,
    updatedAt: tA,
  }).run()

  function seedRun(status: string, trigger: string, createdAt: string): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'site-audit', status, trigger, createdAt, finishedAt: createdAt }).run()
    return id
  }

  // Run A — older real audit, score 60.
  const runA = seedRun('completed', 'manual', tA)
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: runA,
    sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: tA,
    aggregateScore: 60, aggregateGrade: 'D-', pagesDiscovered: 2, pagesAudited: 2, pagesSkipped: 0, pagesErrored: 0,
    factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: tA,
  }).run()
  db.insert(siteAuditPages).values({
    id: crypto.randomUUID(), projectId, runId: runA, url: 'https://example.com/old',
    overallScore: 60, overallGrade: 'D-', status: 'success', error: null, factors: [], createdAt: tA,
  }).run()

  // Run B — newer real audit, score 72 (+12 vs A → trend up). This is the surfaceable latest.
  const runB = seedRun('completed', 'manual', tB)
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: runB,
    sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: tB,
    aggregateScore: 72, aggregateGrade: 'C-', pagesDiscovered: 3, pagesAudited: 2, pagesSkipped: 1, pagesErrored: 1,
    factorAverages: FACTORS_B,
    crossCuttingIssues: [{ factorId: 'ai-crawler-access', factorName: 'AI Crawler Access', avgScore: 30, affectedPages: 2, totalPages: 2, affectedPct: 100, topRecommendations: ['Allow GPTBot in robots.txt'] }],
    prioritizedFixes: ['AI Crawler Access (avg F, affects 100% of pages): Allow GPTBot in robots.txt'],
    createdAt: tB,
  }).run()
  db.insert(siteAuditPages).values([
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/good', overallScore: 80, overallGrade: 'B-', status: 'success', error: null, factors: [], createdAt: tB },
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/weak', overallScore: 30, overallGrade: 'F', status: 'success', error: null, factors: [], createdAt: tB },
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/dead', overallScore: 0, overallGrade: 'F', status: 'error', error: 'TIMEOUT', factors: [], createdAt: tB },
  ]).run()

  // New persisted crawl data for run B. It deliberately coexists with the
  // legacy scorecard rows above; callers must never infer it from them.
  const crawlAttemptId = crypto.randomUUID()
  db.insert(siteCrawlAttempts).values({
    id: crawlAttemptId, projectId, runId: runB, attemptNumber: 1, state: 'completed',
    pagesDiscovered: 3, pagesFetched: 3, pagesEligible: 2, edgesDiscovered: 2,
    startedAt: tB, finishedAt: tB, createdAt: tB, updatedAt: tB,
  }).run()
  db.insert(siteCrawlSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId,
    requestedRootUrl: 'https://origin.example.com/', rootUrl: 'https://example.com/', crawlSchemaVersion: '1.0', engineVersion: 'crawl-test',
    normalizationVersion: 'url-v1', indexabilityVersion: 'index-v1', linkScoreVersion: 'links-v1',
    effectiveOptions: { maxPages: 100, checkDeadLinks: true }, checkDeadLinks: true,
    complete: true, termination: 'completed', detailsAvailable: true,
    pagesDiscovered: 3, pagesFetched: 3, pagesEligible: 2, edgesDiscovered: 2, findingsCount: 1,
    deadLinkState: 'complete', deadLinksChecked: 2, deadLinksFound: 1, deadLinksUnverified: 3, createdAt: tB, updatedAt: tB,
  }).run()
  db.insert(siteCrawlPages).values([
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'home',
      url: 'https://example.com/', finalUrl: 'https://example.com/', path: '/', parentPath: '/', discoverySource: 'sitemap',
      fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: 88,
      auditFields: {
        // Pre-evidence crawl shape: scores remain readable, but the detail
        // endpoint must not claim that empty finding arrays are complete.
        factors: [{ id: 'structured-data', name: 'Structured Data', weight: 12, score: 88 }],
      },
      inventoryEligible: true, depth: 0, outboundUniqueEdges: 2, outboundOccurrences: 3, linkScoreRaw: 10, linkScoreNormalized: 1,
      createdAt: tB, updatedAt: tB,
    },
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'guide',
      url: 'https://example.com/guide', finalUrl: 'https://example.com/guide', path: '/guide', parentPath: '/', discoverySource: 'link',
      fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: 42,
      auditFields: {
        schemaVersion: '1.0',
        factors: [{
          id: 'content-depth', name: 'Content Depth', weight: 12, score: 20, status: 'fail', applicable: true,
          findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'Low content depth (120 words).' }],
          recommendations: ['Add more comprehensive copy covering key user questions.'],
        }],
        criticalDefects: [{
          id: 'missing-h1', severity: 'critical', detail: 'No H1 tag found.', recommendation: 'Add one descriptive H1.',
        }],
      },
      inventoryEligible: true, depth: 1, inboundUniqueEdges: 1, inboundOccurrences: 2, linkScoreRaw: 4, linkScoreNormalized: 0.4,
      createdAt: tB, updatedAt: tB,
    },
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'gone',
      url: 'https://example.com/gone', path: '/gone', parentPath: '/', discoverySource: 'link', fetchState: 'html', httpStatus: 404,
      indexabilityState: 'noindex', auditState: 'skipped', inventoryEligible: false, depth: 1, createdAt: tB, updatedAt: tB,
    },
  ]).run()
  db.insert(siteCrawlEdges).values([
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, edgeKey: 'home-guide',
      sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'guide', targetUrl: 'https://example.com/guide',
      relation: 'anchor', internal: true, followable: true, occurrences: 2, followableOccurrences: 2, nofollowOccurrences: 0,
      anchors: ['Guide'], createdAt: tB, updatedAt: tB,
    },
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, edgeKey: 'home-gone',
      sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'gone', targetUrl: 'https://example.com/gone',
      relation: 'anchor', internal: true, followable: false, occurrences: 1, followableOccurrences: 0, nofollowOccurrences: 1,
      anchors: ['Old'], createdAt: tB, updatedAt: tB,
    },
  ]).run()
  db.insert(siteCrawlGraphLayouts).values({
    id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId,
    state: 'ready', layoutVersion: 'site-health-fa2-v1', totalNodes: 3, totalEdges: 2,
    nodeCount: 3, edgeCount: 2, createdAt: tB, updatedAt: tB,
  }).run()
  db.insert(siteCrawlGraphNodes).values([
    { id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'home', sampleRank: 0, x: 0, y: 0, createdAt: tB },
    { id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'guide', sampleRank: 1, x: 0.5, y: 0.25, createdAt: tB },
    { id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'gone', sampleRank: 2, x: -0.4, y: 0.3, createdAt: tB },
  ]).run()
  db.insert(siteCrawlGraphEdges).values([
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId,
      edgeKey: 'home-guide', sampleRank: 0, sourceNodeKey: 'home', targetNodeKey: 'guide',
      followable: true, occurrences: 2, createdAt: tB,
    },
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId,
      edgeKey: 'home-gone', sampleRank: 1, sourceNodeKey: 'home', targetNodeKey: 'gone',
      followable: false, occurrences: 1, createdAt: tB,
    },
  ]).run()
  db.insert(siteCrawlFindings).values({
    id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, findingKey: 'dead:gone', findingType: 'dead-link', severity: 'high',
    // Matches what `executeSiteAudit` actually writes. The old `{ status: 404 }`
    // was an idealized shape no writer produces, which hid the fact that a
    // persisted row's evidence carries `statusCode` and `reason`.
    sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'gone', targetUrl: 'https://example.com/gone', evidence: { statusCode: 404, reason: 'http-error' },
    createdAt: tB, updatedAt: tB,
  }).run()

  // Probe run — newest, intentionally a wildly different score. MUST be excluded.
  const probeRun = seedRun('completed', 'probe', tProbe)
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: probeRun,
    sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: tProbe,
    aggregateScore: 5, aggregateGrade: 'F', pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, pagesErrored: 0,
    factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: tProbe,
  }).run()

  return { app, db, tmpDir, projectId, runA, runB, probeRun, siteAuditRequested }
}

let ctx: Ctx
beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url })
  return { status: res.statusCode, body: res.json() as T }
}

function seedMinimalComparableCrawlForRunA(): void {
  const createdAt = ctx.db.select({ createdAt: runs.createdAt }).from(runs).where(eq(runs.id, ctx.runA)).get()!.createdAt
  const attemptId = crypto.randomUUID()
  ctx.db.insert(siteCrawlAttempts).values({
    id: attemptId, projectId: ctx.projectId, runId: ctx.runA, attemptNumber: 1, state: 'completed',
    pagesDiscovered: 2, pagesFetched: 2, pagesEligible: 2, edgesDiscovered: 0,
    startedAt: createdAt, finishedAt: createdAt, createdAt, updatedAt: createdAt,
  }).run()
  ctx.db.insert(siteCrawlSnapshots).values({
    id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId,
    rootUrl: 'https://example.com/', crawlSchemaVersion: '1.0', engineVersion: 'crawl-test',
    normalizationVersion: 'url-v1', indexabilityVersion: 'index-v1', linkScoreVersion: 'links-v1',
    complete: true, termination: 'completed', detailsAvailable: true,
    pagesDiscovered: 2, pagesFetched: 2, pagesEligible: 2, edgesDiscovered: 0,
    createdAt, updatedAt: createdAt,
  }).run()
  ctx.db.insert(siteCrawlPages).values([
    {
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'home',
      url: 'https://example.com/', path: '/', parentPath: '/', discoverySource: 'sitemap', fetchState: 'html',
      indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 0,
      createdAt, updatedAt: createdAt,
    },
    {
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'old',
      url: 'https://example.com/old', path: '/old', parentPath: '/', discoverySource: 'link', fetchState: 'html',
      indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 1,
      createdAt, updatedAt: createdAt,
    },
  ]).run()
}

describe('GET /technical-aeo (score)', () => {
  it('returns the latest real audit with delta vs the previous run, excluding the newer probe', async () => {
    const { body } = await get<SiteAuditScoreDto>('/api/v1/projects/tech-aeo/technical-aeo')
    expect(body.hasData).toBe(true)
    expect(body.runId).toBe(ctx.runB)          // not the newer probe
    expect(body.aggregateScore).toBe(72)
    expect(body.deltaScore).toBe(12)           // 72 - 60
    expect(body.trend).toBe('up')
    expect(body.previousScore).toBe(60)
    expect(body.pagesErrored).toBe(1)
    expect(body.factors).toHaveLength(2)
    expect(body.prioritizedFixes).toHaveLength(1)
    // The server-computed affected-pages share rides through to the API response verbatim.
    expect(body.crossCuttingIssues).toHaveLength(1)
    expect(body.crossCuttingIssues[0]!.affectedPct).toBe(100)
  })

  it('returns hasData=false for a project that was never audited', async () => {
    ctx.db.insert(projects).values({
      id: crypto.randomUUID(), name: 'fresh', displayName: 'Fresh', canonicalDomain: 'fresh.com',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run()
    const { body } = await get<SiteAuditScoreDto>('/api/v1/projects/fresh/technical-aeo')
    expect(body.hasData).toBe(false)
    expect(body.runId).toBeNull()
    expect(body.aggregateScore).toBe(0)
    expect(body.deltaScore).toBeNull()
    expect(body.factors).toEqual([])
  })

  it('returns a selected historical audit and computes its delta against the audit before it', async () => {
    const { body } = await get<SiteAuditScoreDto>(`/api/v1/projects/tech-aeo/technical-aeo?runId=${ctx.runA}`)
    expect(body.runId).toBe(ctx.runA)
    expect(body.aggregateScore).toBe(60)
    expect(body.deltaScore).toBeNull()
    expect(body.previousScore).toBeNull()
  })

  it('404s a run that is not a surfaceable audit for this project', async () => {
    const { status } = await get(`/api/v1/projects/tech-aeo/technical-aeo?runId=${ctx.probeRun}`)
    expect(status).toBe(404)
  })

  it('404s an unknown project', async () => {
    const { status } = await get('/api/v1/projects/nope/technical-aeo')
    expect(status).toBe(404)
  })
})

describe('GET /technical-aeo/pages', () => {
  it('returns the latest run pages sorted worst-first by default', async () => {
    const { body } = await get<SiteAuditPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/pages')
    expect(body.runId).toBe(ctx.runB)
    expect(body.total).toBe(3)
    expect(body.pages.map((p) => p.overallScore)).toEqual([0, 30, 80]) // score-asc
  })

  it('filters to errored pages', async () => {
    const { body } = await get<SiteAuditPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/pages?status=error')
    expect(body.total).toBe(1)
    expect(body.pages).toHaveLength(1)
    expect(body.pages[0]!.status).toBe('error')
    expect(body.pages[0]!.error).toBe('TIMEOUT')
  })

  it('sorts score-desc and paginates', async () => {
    const { body } = await get<SiteAuditPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/pages?sort=score-desc&limit=1&offset=0')
    expect(body.total).toBe(3)
    expect(body.pages).toHaveLength(1)
    expect(body.pages[0]!.overallScore).toBe(80)
  })

  it('returns pages from a selected historical audit', async () => {
    const { body } = await get<SiteAuditPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/pages?runId=${ctx.runA}`)
    expect(body.runId).toBe(ctx.runA)
    expect(body.total).toBe(1)
    expect(body.pages[0]?.url).toBe('https://example.com/old')
  })
})

describe('GET /technical-aeo/trend', () => {
  it('returns oldest-first points excluding the probe', async () => {
    const { body } = await get<SiteAuditTrendResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/trend')
    expect(body.points.map((p) => p.aggregateScore)).toEqual([60, 72])
    expect(body.points.every((p) => p.runId !== ctx.probeRun)).toBe(true)
  })
})

describe('GET /technical-aeo crawl reads', () => {
  it('returns only the latest real persisted crawl, with separate legacy availability', async () => {
    const { body } = await get<SiteCrawlSummaryDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl')
    expect(body).toMatchObject({
      hasCrawlData: true,
      legacyAuditAvailable: true,
      runId: ctx.runB,
      requestedRootUrl: 'https://origin.example.com/',
      rootUrl: 'https://example.com/',
      complete: true,
      detailsAvailable: true,
      deadLinks: { state: 'complete', checked: 2, found: 1, unverified: 3 },
    })
    expect(body.counts.pagesEligible).toBe(2)
    expect(body.runId).not.toBe(ctx.probeRun)
  })

  it('uses run ID as the stable tie-breaker for equally-timed crawl snapshots', async () => {
    const createdAt = '2099-01-01T00:00:00.000Z'
    const lowRunId = '00000000-0000-4000-8000-000000000001'
    const highRunId = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
    for (const runId of [lowRunId, highRunId]) {
      const attemptId = crypto.randomUUID()
      ctx.db.insert(runs).values({
        id: runId, projectId: ctx.projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt, finishedAt: createdAt,
      }).run()
      ctx.db.insert(siteCrawlAttempts).values({
        id: attemptId, projectId: ctx.projectId, runId, attemptNumber: 1, state: 'completed', createdAt, updatedAt: createdAt,
      }).run()
      ctx.db.insert(siteCrawlSnapshots).values({
        id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId, rootUrl: 'https://example.com/',
        complete: true, detailsAvailable: true, createdAt, updatedAt: createdAt,
      }).run()
    }

    const { body } = await get<SiteCrawlSummaryDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl')
    expect(body.runId).toBe(highRunId)
  })

  it('keeps the last complete graph current when a newer partial crawl exists', async () => {
    const now = new Date(Date.now() + 60_000).toISOString()
    const partialRun = crypto.randomUUID()
    const partialAttempt = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: partialRun, projectId: ctx.projectId, kind: 'site-audit', status: 'partial', trigger: 'manual', createdAt: now, finishedAt: now,
    }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: partialAttempt, projectId: ctx.projectId, runId: partialRun, attemptNumber: 1, state: 'partial', createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: partialRun, attemptId: partialAttempt,
      rootUrl: 'https://example.com/', complete: false, termination: 'max-pages', detailsAvailable: true, createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: partialRun, attemptId: partialAttempt, nodeKey: 'partial-home',
        url: 'https://example.com/', path: '/', parentPath: '/', discoverySource: 'root', fetchState: 'html',
        indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 0, createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: partialRun, attemptId: partialAttempt, nodeKey: 'partial-target',
        url: 'https://example.com/partial-target', path: '/partial-target', parentPath: '/', discoverySource: 'link', fetchState: 'html',
        indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 1, createdAt: now, updatedAt: now,
      },
    ]).run()
    ctx.db.insert(siteCrawlEdges).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: partialRun, attemptId: partialAttempt, edgeKey: 'partial-home-target',
      sourceNodeKey: 'partial-home', sourceUrl: 'https://example.com/', targetNodeKey: 'partial-target', targetUrl: 'https://example.com/partial-target',
      relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
      anchors: ['Partial target'], createdAt: now, updatedAt: now,
    }).run()

    const current = await get<SiteCrawlSummaryDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl')
    const historical = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl?runId=${partialRun}`)
    const subgraph = await get<SiteHealthSubgraphResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/subgraph?runId=${partialRun}`)
    const path = await get<SiteHealthPathResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/path?runId=${partialRun}&toNodeKey=partial-target`)
    expect(current.body.runId).toBe(ctx.runB)
    expect(historical.body.runId).toBe(partialRun)
    expect(historical.body.complete).toBe(false)
    expect(subgraph.body).toMatchObject({
      runId: partialRun,
      state: 'ready',
      complete: false,
      termination: 'max-pages',
      countAccuracy: 'exact',
    })
    expect(path.body).toMatchObject({ runId: partialRun, state: 'found', complete: false, termination: 'max-pages' })
  })

  it('does not turn a legacy-only scorecard into crawl data', async () => {
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: projectId, name: 'legacy-only', displayName: 'Legacy', canonicalDomain: 'legacy.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now, finishedAt: now }).run()
    ctx.db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId, runId, sitemapUrl: 'https://legacy.example/sitemap.xml', auditedAt: now,
      aggregateScore: 60, aggregateGrade: 'D-', pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, pagesErrored: 0,
      factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: now,
    }).run()
    const { body } = await get<SiteCrawlSummaryDto>('/api/v1/projects/legacy-only/technical-aeo/crawl')
    expect(body.hasCrawlData).toBe(false)
    expect(body.legacyAuditAvailable).toBe(true)
    expect(body.deadLinks).toEqual({ state: 'unavailable' })
  })

  it('keeps historical crawl resolution project-scoped', async () => {
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: projectId, name: 'other', displayName: 'Other', canonicalDomain: 'other.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    const { status } = await get(`/api/v1/projects/other/technical-aeo/crawl?runId=${ctx.runB}`)
    expect(status).toBe(404)
  })

  it('reads deterministic bounded positions and edges from the persisted projection', async () => {
    const first = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph?maxNodes=2&maxEdges=1')
    const second = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph?maxNodes=2&maxEdges=1')

    expect(first.body).toMatchObject({
      hasCrawlData: true,
      runId: ctx.runB,
      layout: { state: 'ready', version: 'site-health-fa2-v1' },
      totalNodes: 3,
      totalEdges: 2,
      omittedNodes: 1,
      omittedEdges: 1,
      sampled: true,
    })
    expect(first.body.nodes.map((node) => node.nodeKey)).toEqual(['home', 'guide'])
    expect(first.body.nodes[0]).toMatchObject({ nodeKey: 'home', x: 0, y: 0 })
    expect(first.body.edges.map((edge) => edge.edgeKey)).toEqual(['home-guide'])
    expect(first.body.edges.every((edge) =>
      first.body.nodes.some((node) => node.nodeKey === edge.sourceNodeKey)
      && first.body.nodes.some((node) => node.nodeKey === edge.targetNodeKey),
    )).toBe(true)
    expect(second.body).toEqual(first.body)
  })

  it('uses resolved canonical identity for the shared inventory and graph health state', async () => {
    ctx.db.update(siteCrawlPages).set({
      // The crawler resolved this identity to home. URL text is intentionally
      // not used for the health decision.
      canonicalUrl: 'https://example.com/',
      canonicalNodeKey: 'home',
      fetchState: 'html',
      indexabilityState: 'indexable',
      indexabilityReasons: [],
    }).where(eq(siteCrawlPages.nodeKey, 'guide')).run()

    const pages = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?sort=path')
    const { body } = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph')
    expect(pages.body.pages.find((page) => page.nodeKey === 'guide')?.healthState).toBe('hidden')
    expect(body.nodes.find((node) => node.nodeKey === 'guide')?.healthState).toBe('hidden')
  })

  it('returns exact page audit evidence for one graph node in the selected crawl', async () => {
    const { status, body } = await get<SiteCrawlPageAuditDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?nodeKey=guide',
    )

    expect(status).toBe(200)
    expect(body).toMatchObject({
      state: 'ready',
      project: 'tech-aeo',
      runId: ctx.runB,
      complete: true,
      termination: 'completed',
      nodeKey: 'guide',
      url: 'https://example.com/guide',
      auditState: 'complete',
      auditScore: 42,
      evidenceState: 'complete',
      factors: [{
        id: 'content-depth',
        score: 20,
        status: 'fail',
        applicable: true,
        findings: [{ code: 'content-depth.word-count.low' }],
        recommendations: ['Add more comprehensive copy covering key user questions.'],
      }],
      criticalDefects: [{ id: 'missing-h1', severity: 'critical' }],
    })
  })

  it('distinguishes legacy scores-only evidence from a page that was not audited', async () => {
    const legacy = await get<SiteCrawlPageAuditDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?runId=${ctx.runB}&url=${encodeURIComponent('https://example.com/')}`,
    )
    const notAudited = await get<SiteCrawlPageAuditDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?nodeKey=gone',
    )

    expect(legacy.body).toMatchObject({
      state: 'ready',
      nodeKey: 'home',
      auditScore: 88,
      evidenceState: 'scores-only',
      factors: [{
        id: 'structured-data', score: 88, status: 'pass', applicable: null,
        findings: [], recommendations: [],
      }],
      criticalDefects: [],
    })
    expect(notAudited.body).toMatchObject({
      state: 'not-audited', nodeKey: 'gone', auditScore: null,
      factors: [], criticalDefects: [],
    })
  })

  it('returns explicit page-audit availability states and enforces one selector', async () => {
    const missing = await get<SiteCrawlPageAuditDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?nodeKey=missing',
    )
    expect(missing.body).toMatchObject({ state: 'not-found', runId: ctx.runB, complete: true })

    const noCrawlProjectId = crypto.randomUUID()
    const now = new Date().toISOString()
    ctx.db.insert(projects).values({
      id: noCrawlProjectId, name: 'no-crawl', displayName: 'No crawl', canonicalDomain: 'none.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    const noCrawl = await get<SiteCrawlPageAuditDto>(
      '/api/v1/projects/no-crawl/technical-aeo/crawl/pages/audit?nodeKey=home',
    )
    expect(noCrawl.body).toEqual({ state: 'no-crawl', project: 'no-crawl', runId: null })

    ctx.db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId: null,
      rootUrl: 'https://example.com/', complete: true, termination: 'completed', detailsAvailable: false,
      createdAt: now, updatedAt: now,
    }).run()
    const unavailable = await get<SiteCrawlPageAuditDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?runId=${ctx.runA}&nodeKey=home`,
    )
    expect(unavailable.body).toMatchObject({
      state: 'details-unavailable', runId: ctx.runA, complete: true, termination: 'completed',
    })

    for (const query of ['', '?nodeKey=home&url=https%3A%2F%2Fexample.com%2F']) {
      const invalid = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit${query}`,
      })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json().error.code).toBe('VALIDATION_ERROR')
    }

    for (const query of [
      '?nodeKey=guide&nodeKey=home',
      '?url=https%3A%2F%2Fexample.com%2Fguide&url=https%3A%2F%2Fexample.com%2F',
      `?nodeKey=guide&runId=${ctx.runB}&runId=${ctx.runA}`,
    ]) {
      const repeated = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit${query}`,
      })
      expect(repeated.statusCode).toBe(400)
      expect(repeated.json().error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('does not rebuild or reorder the projection from canonical crawl rows at read time', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'alpha',
        url: 'https://example.com/alpha', path: '/alpha', parentPath: '/', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
        indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 1, linkScoreNormalized: 0.9,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'beta',
        url: 'https://example.com/beta', path: '/beta', parentPath: '/', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
        indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 1, linkScoreNormalized: 0.9,
        createdAt: now, updatedAt: now,
      },
    ]).run()

    const { body } = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph?maxNodes=2&maxEdges=1')
    expect(body.nodes.map((node) => node.nodeKey)).toEqual(['home', 'guide'])
    expect(body.sampled).toBe(true)
  })

  it('caps graph projection query parameters and preserves an empty-state distinction', async () => {
    const capped = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph?maxNodes=999999&maxEdges=999999')
    expect(capped.body.nodes).toHaveLength(3)
    expect(capped.body.edges).toHaveLength(2)

    ctx.db.insert(projects).values({
      id: crypto.randomUUID(), name: 'graph-fresh', displayName: 'Graph fresh', canonicalDomain: 'fresh.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run()
    const empty = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/graph-fresh/technical-aeo/graph')
    expect(empty.body).toEqual({
      project: 'graph-fresh', hasCrawlData: false, runId: null, rootNodeKey: null,
      layout: { state: 'unavailable', version: null, reason: 'no-crawl' },
      // Nothing was classified because nothing was crawled, and saying so
      // beats letting an empty edge list read as "this site has no nav".
      templateDetection: 'unavailable-legacy-scan', linkKind: 'all',
      totalNodes: 0, totalEdges: 0, totalTemplateEdges: 0, totalContentEdges: 0,
      nodes: [], edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
    })
  })

  it('reports a truthful unavailable layout for a crawl snapshot published before graph layouts', async () => {
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: projectId, name: 'graph-legacy', displayName: 'Graph legacy', canonicalDomain: 'legacy.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed', createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId, runId, attemptId, rootUrl: 'https://legacy.example/',
      complete: true, detailsAvailable: true, createdAt: now, updatedAt: now,
    }).run()

    const { body } = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/graph-legacy/technical-aeo/graph')
    expect(body).toMatchObject({
      hasCrawlData: true,
      runId,
      layout: { state: 'unavailable', version: null, reason: 'legacy-snapshot' },
      nodes: [], edges: [], sampled: false,
    })
  })

  it('preserves persisted totals when publish-time layout fails', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.delete(siteCrawlGraphLayouts).where(eq(siteCrawlGraphLayouts.runId, ctx.runB)).run()
    ctx.db.insert(siteCrawlGraphLayouts).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!,
      state: 'unavailable', layoutVersion: null, failureCode: 'layout-timeout',
      totalNodes: 3, totalEdges: 2, nodeCount: 0, edgeCount: 0, createdAt: now, updatedAt: now,
    }).run()

    const { body } = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph')
    expect(body).toMatchObject({
      layout: { state: 'unavailable', version: null, reason: 'layout-failed' },
      totalNodes: 3, totalEdges: 2, omittedNodes: 3, omittedEdges: 2, sampled: true,
      nodes: [], edges: [],
    })
  })

  it('cursor-pages crawl inventory and preserves technical inventory eligibility', async () => {
    const first = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?limit=1&sort=path&inventoryEligible=true')
    expect(first.body.total).toBe(2)
    expect(first.body.pages).toHaveLength(1)
    expect(first.body.pages[0]!.inventoryEligible).toBe(true)
    expect(first.body.nextCursor).toEqual(expect.any(String))
    const second = await get<SiteCrawlPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?limit=1&sort=path&inventoryEligible=true&cursor=${encodeURIComponent(first.body.nextCursor!)}`)
    expect(second.body.pages).toHaveLength(1)
    expect(second.body.nextCursor).toBeNull()
  })

  it('bounds structure, internal links, neighbors, and dead-link output', async () => {
    const structure = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/&limit=1')
    expect(structure.body.children).toHaveLength(1)
    expect(structure.body.nextCursor).toEqual(expect.any(String))

    const links = await get<SiteCrawlInternalLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links?limit=1')
    expect(links.body.edges).toHaveLength(1)
    expect(links.body.nextCursor).toEqual(expect.any(String))

    const neighbors = await get<SiteCrawlNeighborsResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links/neighbors?nodeKey=home&limit=1')
    expect(neighbors.body.outbound).toHaveLength(1)
    expect(neighbors.body.outboundTruncated).toBe(true)

    const dead = await get<SiteCrawlDeadLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/dead-links?limit=1')
    // `unverified` rides alongside `found` and is never folded into it: links
    // the crawler could not fetch are not broken links, and `deadLinks` lists
    // only rows a consumer may render as broken.
    expect(dead.body).toMatchObject({ state: 'complete', total: 1, found: 1, unverified: 3, deadLinks: [{ targetUrl: 'https://example.com/gone' }] })
    if (!('deadLinks' in dead.body)) throw new Error('expected a listed dead-link response')
    expect(dead.body.deadLinks.every((row) => typeof (row.evidence as { statusCode?: unknown }).statusCode === 'number')).toBe(true)
  })

  it('returns a bounded canonical subgraph without presentation coordinates', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'canonical-only',
      url: 'https://example.com/canonical-only', finalUrl: 'https://example.com/canonical-only',
      path: '/canonical-only', parentPath: '/', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
      indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 2,
      createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(siteCrawlEdges).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, edgeKey: 'home-canonical-only',
        sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'canonical-only', targetUrl: 'https://example.com/canonical-only',
        relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: ['Canonical only'], createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, edgeKey: 'guide-canonical-only',
        sourceNodeKey: 'guide', sourceUrl: 'https://example.com/guide', targetNodeKey: 'canonical-only', targetUrl: 'https://example.com/canonical-only',
        relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: ['Canonical only'], createdAt: now, updatedAt: now,
      },
    ]).run()

    const { status, body } = await get<SiteHealthSubgraphResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/subgraph?nodeKey=canonical-only&hops=1&maxNodes=2&maxEdges=1',
    )

    expect(status).toBe(200)
    expect(body).toMatchObject({
      project: 'tech-aeo',
      hasCrawlData: true,
      runId: ctx.runB,
      focusNodeKey: 'canonical-only',
      focusUrl: 'https://example.com/canonical-only',
      hops: 1,
      countAccuracy: 'lower-bound',
      truncated: true,
    })
    expect(body.nodes).toHaveLength(2)
    expect(body.edges).toHaveLength(1)
    expect(body.nodes[0]).toMatchObject({ nodeKey: 'canonical-only', distance: 0, relationToFocus: 'focus', healthState: 'eligible' })
    expect(body.nodes.every((node) => !('x' in node) && !('y' in node))).toBe(true)
    expect(body.edges.every((edge) =>
      body.nodes.some((node) => node.nodeKey === edge.sourceNodeKey)
      && body.nodes.some((node) => node.nodeKey === edge.targetNodeKey),
    )).toBe(true)
  })

  it('marks a hop-bounded subgraph as a lower bound when outermost neighbors link together', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlEdges).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, edgeKey: 'guide-gone',
      sourceNodeKey: 'guide', sourceUrl: 'https://example.com/guide', targetNodeKey: 'gone', targetUrl: 'https://example.com/gone',
      relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
      anchors: ['Related page'], createdAt: now, updatedAt: now,
    }).run()

    const { status, body } = await get<SiteHealthSubgraphResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/subgraph?nodeKey=home&hops=1&maxNodes=3&maxEdges=2',
    )

    expect(status).toBe(200)
    expect(body).toMatchObject({
      countAccuracy: 'lower-bound',
      truncated: true,
      totalEdges: 3,
      omittedEdges: 1,
    })
    expect(body.edges).toHaveLength(2)
    expect(body.edges.map((edge) => edge.edgeKey)).not.toContain('guide-gone')
  })

  it('finds the shortest directed followable path and ignores a direct nofollow edge', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlEdges).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, edgeKey: 'guide-gone',
      sourceNodeKey: 'guide', sourceUrl: 'https://example.com/guide', targetNodeKey: 'gone', targetUrl: 'https://example.com/gone',
      relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
      anchors: ['Next'], createdAt: now, updatedAt: now,
    }).run()

    const found = await get<SiteHealthPathResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/path?fromNodeKey=home&toNodeKey=gone',
    )
    expect(found.status).toBe(200)
    expect(found.body.state).toBe('found')
    expect(found.body.nodes.map((node) => node.nodeKey)).toEqual(['home', 'guide', 'gone'])
    expect(found.body.edges.map((edge) => edge.edgeKey)).toEqual(['home-guide', 'guide-gone'])
    expect(found.body.edges.every((edge) => edge.followable && edge.internal)).toBe(true)

    const reverse = await get<SiteHealthPathResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/path?fromNodeKey=gone&toNodeKey=home',
    )
    expect(reverse.status).toBe(200)
    expect(reverse.body.state).toBe('unreachable')
    expect(reverse.body.nodes).toEqual([])
    expect(reverse.body.edges).toEqual([])
  })

  it('diffs canonical crawl snapshots while ignoring graph layout coordinates', async () => {
    const now = new Date().toISOString()
    const crawlCreatedAt = ctx.db.select({ createdAt: runs.createdAt }).from(runs).where(eq(runs.id, ctx.runA)).get()!.createdAt
    const attemptId = crypto.randomUUID()
    ctx.db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId: ctx.projectId, runId: ctx.runA, attemptNumber: 1, state: 'completed',
      pagesDiscovered: 3, pagesFetched: 3, pagesEligible: 2, edgesDiscovered: 2,
      startedAt: now, finishedAt: now, createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId,
      rootUrl: 'https://example.com/', crawlSchemaVersion: '1.0', engineVersion: 'crawl-test',
      normalizationVersion: 'url-v1', indexabilityVersion: 'index-v1', linkScoreVersion: 'links-v1',
      effectiveOptions: { maxPages: 100, checkDeadLinks: true }, checkDeadLinks: true,
      complete: true, termination: 'completed', detailsAvailable: true,
      pagesDiscovered: 3, pagesFetched: 3, pagesEligible: 2, edgesDiscovered: 2, findingsCount: 0,
      deadLinkState: 'complete', deadLinksChecked: 2, deadLinksFound: 0, createdAt: crawlCreatedAt, updatedAt: crawlCreatedAt,
    }).run()
    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'home',
        url: 'https://example.com/', finalUrl: 'https://example.com/', path: '/', parentPath: '/', discoverySource: 'sitemap',
        fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: 80,
        inventoryEligible: true, depth: 0, outboundUniqueEdges: 2, outboundOccurrences: 3, linkScoreRaw: 10, linkScoreNormalized: 1,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'guide',
        url: 'https://example.com/guide', finalUrl: 'https://example.com/guide', path: '/guide', parentPath: '/', discoverySource: 'link',
        fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: 42,
        inventoryEligible: true, depth: 1, inboundUniqueEdges: 1, inboundOccurrences: 2, linkScoreRaw: 4, linkScoreNormalized: 0.4,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'old',
        url: 'https://example.com/old', finalUrl: 'https://example.com/old', path: '/old', parentPath: '/', discoverySource: 'link',
        fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: 50,
        inventoryEligible: true, depth: 1, inboundUniqueEdges: 1, inboundOccurrences: 1,
        createdAt: now, updatedAt: now,
      },
    ]).run()
    ctx.db.insert(siteCrawlEdges).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, edgeKey: 'home-guide',
        sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'guide', targetUrl: 'https://example.com/guide',
        relation: 'anchor', internal: true, followable: true, occurrences: 2, followableOccurrences: 2, nofollowOccurrences: 0,
        anchors: ['Previous guide label'], createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, edgeKey: 'home-old',
        sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'old', targetUrl: 'https://example.com/old',
        relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: ['Old'], createdAt: now, updatedAt: now,
      },
    ]).run()
    ctx.db.insert(siteCrawlGraphLayouts).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId,
      state: 'ready', layoutVersion: 'site-health-fa2-v1', totalNodes: 3, totalEdges: 2,
      nodeCount: 3, edgeCount: 2, createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(siteCrawlGraphNodes).values([
      { id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'home', sampleRank: 0, x: 99, y: -99, createdAt: now },
      { id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'guide', sampleRank: 1, x: 42, y: 42, createdAt: now },
      { id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'old', sampleRank: 2, x: -42, y: -42, createdAt: now },
    ]).run()

    const { status, body } = await get<SiteHealthChangesResponseDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runA}&toRunId=${ctx.runB}&limit=100`,
    )
    expect(status).toBe(200)
    expect(body.state).toBe('ready')
    if (body.state !== 'ready') return

    expect(body.summary).toEqual({
      pages: { added: 1, removed: 1, changed: 1 },
      links: { added: 1, removed: 1, changed: 1 },
    })
    expect(body.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'page', change: 'added', key: 'gone', before: null }),
      expect.objectContaining({ entity: 'page', change: 'removed', key: 'old', after: null }),
      expect.objectContaining({ entity: 'page', change: 'changed', key: 'home', changedFields: ['auditScore'] }),
      expect.objectContaining({ entity: 'link', change: 'added', key: 'home-gone', before: null }),
      expect.objectContaining({ entity: 'link', change: 'removed', key: 'home-old', after: null }),
      expect.objectContaining({ entity: 'link', change: 'changed', key: 'home-guide', changedFields: ['anchors'] }),
    ]))
    expect(body.changes.flatMap((change) => change.changedFields)).not.toContain('x')
    expect(body.changes.flatMap((change) => change.changedFields)).not.toContain('y')
    expect(body.changes.every((change) =>
      (change.before === null || (!('x' in change.before) && !('y' in change.before)))
      && (change.after === null || (!('x' in change.after) && !('y' in change.after))),
    )).toBe(true)
  })

  it('keyset-pages every Site Health change once across page and link records', async () => {
    seedMinimalComparableCrawlForRunA()
    const records: string[] = []
    let cursor: string | null = null

    for (let page = 0; page < 10; page += 1) {
      const result = await get<SiteHealthChangesResponseDto>(
        `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runA}&toRunId=${ctx.runB}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      expect(result.status).toBe(200)
      expect(result.body.state).toBe('ready')
      if (result.body.state !== 'ready') return
      expect(result.body.filters).toEqual({ scope: 'all', change: 'all' })
      expect(result.body.summaryState).toBe(page === 0 ? 'exact' : 'omitted-on-continuation')
      expect(result.body.total).toBe(page === 0 ? 6 : null)
      expect(result.body.summary === null).toBe(page > 0)
      expect(result.body.changes).toHaveLength(1)
      records.push(`${result.body.changes[0]!.entity}:${result.body.changes[0]!.key}`)
      cursor = result.body.nextCursor
      if (cursor === null) break
    }

    expect(records).toEqual([
      'page:gone',
      'page:guide',
      'page:home',
      'page:old',
      'link:home-gone',
      'link:home-guide',
    ])
    expect(new Set(records).size).toBe(records.length)
    expect(cursor).toBeNull()
  })

  it('omits the comparison summary on cursor pages instead of rerunning its joins', async () => {
    seedMinimalComparableCrawlForRunA()
    const rawAll = vi.spyOn(ctx.db, 'all')
    const first = await get<SiteHealthChangesResponseDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runA}&toRunId=${ctx.runB}&scope=pages&limit=1`,
    )
    expect(first.body.state).toBe('ready')
    if (first.body.state !== 'ready') return
    expect(first.body.nextCursor).toEqual(expect.any(String))
    expect(first.body.nextCursor!.length).toBeLessThanOrEqual(2_048)
    expect(first.body).toMatchObject({
      filters: { scope: 'pages', change: 'all' },
      summaryState: 'exact',
      summary: {
        pages: { added: 2, removed: 1, changed: 1 },
        links: { added: 0, removed: 0, changed: 0 },
      },
      total: 4,
    })
    expect(rawAll).toHaveBeenCalledTimes(4) // two page-summary joins + two page-key queries

    rawAll.mockClear()
    const second = await get<SiteHealthChangesResponseDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runA}&toRunId=${ctx.runB}&scope=pages&limit=1&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    )
    expect(second.body.state).toBe('ready')
    if (second.body.state !== 'ready') return
    expect(second.body.summaryState).toBe('omitted-on-continuation')
    expect(second.body.summary).toBeNull()
    expect(second.body.total).toBeNull()
    expect(rawAll).toHaveBeenCalledTimes(2) // keyset work only; no full-snapshot summary joins
  })

  it('does not run irrelevant record-key scans for scoped change filters', async () => {
    seedMinimalComparableCrawlForRunA()
    const rawAll = vi.spyOn(ctx.db, 'all')
    const result = await get<SiteHealthChangesResponseDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runA}&toRunId=${ctx.runB}&scope=pages&change=added&limit=1`,
    )
    expect(result.body.state).toBe('ready')
    if (result.body.state !== 'ready') return
    expect(result.body.summary).toEqual({
      pages: { added: 2, removed: 0, changed: 0 },
      links: { added: 0, removed: 0, changed: 0 },
    })
    expect(result.body).toMatchObject({
      filters: { scope: 'pages', change: 'added' },
      summaryState: 'exact',
      total: 2,
    })
    expect(result.body.changes).toEqual([
      expect.objectContaining({ entity: 'page', change: 'added', key: 'gone' }),
    ])
    expect(rawAll).toHaveBeenCalledTimes(2) // one added-page summary + one added-page key query
  })

  it('rejects a Site Health changes cursor when its filter context changes', async () => {
    seedMinimalComparableCrawlForRunA()
    const first = await get<SiteHealthChangesResponseDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runA}&toRunId=${ctx.runB}&scope=pages&limit=1`,
    )
    expect(first.body.state).toBe('ready')
    if (first.body.state !== 'ready') return
    expect(first.body.nextCursor).toEqual(expect.any(String))

    const mismatch = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runA}&toRunId=${ctx.runB}&scope=links&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    })
    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Site Health changes cursor does not match this snapshot comparison and filter',
      },
    })
  })

  it('defaults either omitted Site Health changes endpoint to the adjacent complete crawl', async () => {
    seedMinimalComparableCrawlForRunA()
    const onlyTarget = await get<SiteHealthChangesResponseDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/changes?toRunId=${ctx.runB}`,
    )
    const onlyBaseline = await get<SiteHealthChangesResponseDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runA}`,
    )

    for (const result of [onlyTarget, onlyBaseline]) {
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({
        state: 'ready',
        fromRunId: ctx.runA,
        toRunId: ctx.runB,
      })
    }
  })

  it('rejects a changes comparison whose baseline is not earlier than its target', async () => {
    seedMinimalComparableCrawlForRunA()
    const result = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/tech-aeo/technical-aeo/changes?fromRunId=${ctx.runB}&toRunId=${ctx.runA}`,
    })
    expect(result.statusCode).toBe(400)
    expect(result.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'fromRunId must identify a crawl earlier than toRunId',
      },
    })
  })

  it('surfaces synthetic folder levels when no folder landing page exists', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'deep-guide',
      url: 'https://example.com/docs/guides/start', finalUrl: 'https://example.com/docs/guides/start',
      path: '/docs/guides/start', parentPath: '/docs/guides', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
      indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true, depth: 3, createdAt: now, updatedAt: now,
    }).run()

    const root = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/&limit=100')
    expect(root.body.children).toContainEqual(expect.objectContaining({ path: '/docs', url: null, hasPage: false, pageCount: 1 }))
    const docs = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/docs&limit=100')
    expect(docs.body.children).toContainEqual(expect.objectContaining({ path: '/docs/guides', url: null, hasPage: false, pageCount: 1 }))
    const guides = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/docs/guides&limit=100')
    expect(guides.body.children).toContainEqual(expect.objectContaining({
      path: '/docs/guides/start', url: 'https://example.com/docs/guides/start', hasPage: true, pageCount: 1,
    }))
  })

  it('counts legacy fetched rows in historical structure snapshots', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'legacy-fetched',
      url: 'https://example.com/legacy/page', finalUrl: 'https://example.com/legacy/page',
      path: '/legacy/page', parentPath: '/legacy', discoverySource: 'sitemap', fetchState: 'fetched', httpStatus: 200,
      indexabilityState: 'unknown', auditState: 'success', inventoryEligible: true, depth: 2, createdAt: now, updatedAt: now,
    }).run()

    const structure = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/legacy&limit=100')
    expect(structure.body.children).toContainEqual(expect.objectContaining({
      path: '/legacy/page',
      fetchedCount: 1,
    }))
  })

  it('treats a trailing-slash folder landing page as the folder, not its child', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'catalog',
        url: 'https://example.com/catalog/', finalUrl: 'https://example.com/catalog/',
        path: '/catalog/', parentPath: '/', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
        indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true, depth: 1, createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'catalog-item',
        url: 'https://example.com/catalog/items/one', finalUrl: 'https://example.com/catalog/items/one',
        path: '/catalog/items/one', parentPath: '/catalog/items', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
        indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true, depth: 3, createdAt: now, updatedAt: now,
      },
    ]).run()

    const root = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/&limit=100')
    expect(root.body.children).toContainEqual(expect.objectContaining({
      path: '/catalog', url: 'https://example.com/catalog/', hasPage: true, pageCount: 2,
    }))
    const catalog = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/catalog&limit=100')
    expect(catalog.body.children.map((child) => child.path)).toEqual(['/catalog/items'])
  })

  it('treats percent and underscore path characters literally in structure parents', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'underscore-real',
        url: 'https://example.com/literal_underscore/only', path: '/literal_underscore/only', parentPath: '/literal_underscore',
        discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'underscore-wildcard-sibling',
        url: 'https://example.com/literalXunderscore/wrong', path: '/literalXunderscore/wrong', parentPath: '/literalXunderscore',
        discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'percent-real',
        url: 'https://example.com/literal%25percent/only', path: '/literal%25percent/only', parentPath: '/literal%25percent',
        discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'percent-wildcard-sibling',
        url: 'https://example.com/literalZZ25percent/wrong', path: '/literalZZ25percent/wrong', parentPath: '/literalZZ25percent',
        discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true,
        createdAt: now, updatedAt: now,
      },
    ]).run()

    const underscore = await get<SiteCrawlStructureResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=${encodeURIComponent('/literal_underscore')}`)
    expect(underscore.body.children.map((child) => child.path)).toEqual(['/literal_underscore/only'])

    const percent = await get<SiteCrawlStructureResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=${encodeURIComponent('/literal%25percent')}`)
    expect(percent.body.children.map((child) => child.path)).toEqual(['/literal%25percent/only'])
  })
})

describe('POST /technical-aeo/runs', () => {
  it('creates a queued site-audit run and fires the callback', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { limit: 50 } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { runId: string; status: string }
    expect(body.status).toBe('queued')
    const row = ctx.db.select().from(runs).where(eq(runs.id, body.runId)).get()
    expect(row?.kind).toBe('site-audit')
    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.siteAuditRequested[0]!.opts?.limit).toBe(50)
  })

  it('is idempotent — returns the in-flight run instead of starting a second', async () => {
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { limit: 50 } })
    const firstId = (first.json() as { runId: string }).runId
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/tech-aeo/technical-aeo/runs',
      payload: { maxPages: 50, checkDeadLinks: false },
    })
    const secondId = (second.json() as { runId: string }).runId
    expect(secondId).toBe(firstId)
    // Only one callback fired (the second was a no-op dedupe).
    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.db.select().from(siteCrawlRunRequests).where(eq(siteCrawlRunRequests.runId, firstId)).get()).toMatchObject({
      projectId: ctx.projectId,
      effectiveOptions: {
        schemaVersion: 2,
        sitemapUrl: null,
        maxPages: 50,
        maxEdges: null,
        maxDepth: null,
        checkDeadLinks: false,
      },
    })
  })

  it('persists an omitted edge budget as unset and still consolidates two such requests', async () => {
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    const second = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    const runId = (first.json() as { runId: string }).runId

    expect((second.json() as { runId: string }).runId).toBe(runId)
    expect(ctx.db.select().from(siteCrawlRunRequests).where(eq(siteCrawlRunRequests.runId, runId)).get()).toMatchObject({
      effectiveOptions: { maxPages: 1_000, maxEdges: null },
    })
    // The executor must receive no edge budget at all, so the crawl engine
    // derives it from the page count instead of inheriting a flat ceiling.
    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.siteAuditRequested[0]!.opts).toMatchObject({ maxPages: 1_000 })
    expect(ctx.siteAuditRequested[0]!.opts!.maxEdges).toBeUndefined()
  })

  it('treats an explicit 100,000 as a different request from an omitted edge budget', async () => {
    const omitted = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    const omittedId = (omitted.json() as { runId: string }).runId

    const explicit = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { maxEdges: 100_000 },
    })
    expect(explicit.statusCode).toBe(409)
    expect(explicit.json()).toMatchObject({
      error: { code: 'OPERATION_IN_PROGRESS', details: { activeRunId: omittedId } },
    })
    expect(ctx.siteAuditRequested).toHaveLength(1)
  })

  it('refuses to consolidate semantically different crawl requests onto an active run', async () => {
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    const firstId = (first.json() as { runId: string }).runId
    const variants = [
      { sitemapUrl: 'https://example.com/custom-sitemap.xml' },
      { limit: 50 },
      { maxPages: 60 },
      { maxEdges: 500 },
      { maxDepth: 4 },
      { checkDeadLinks: true },
    ]

    for (const payload of variants) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/projects/tech-aeo/technical-aeo/runs',
        payload,
      })
      expect(response.statusCode, JSON.stringify(payload)).toBe(409)
      expect(response.json()).toMatchObject({
        error: {
          code: 'OPERATION_IN_PROGRESS',
          details: { activeRunId: firstId },
        },
      })
    }

    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.db.select().from(runs).where(eq(runs.projectId, ctx.projectId)).all().filter((run) => run.status === 'queued')).toHaveLength(1)
  })

  it('rejects an invalid limit over the cap', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { limit: 99999 } })
    expect(res.statusCode).toBe(400)
  })

  it('accepts additive crawl budgets and defaults dead-link checks off', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs',
      payload: { maxPages: 60, maxEdges: 500, maxDepth: 4 },
    })
    expect(res.statusCode).toBe(200)
    expect(ctx.siteAuditRequested[0]!.opts).toMatchObject({ maxPages: 60, maxEdges: 500, maxDepth: 4, checkDeadLinks: false })
  })

  it('rejects an unavailable executor before a queued run can be persisted', async () => {
    const before = ctx.db.select().from(runs).all().length
    const withoutExecutor = Fastify()
    withoutExecutor.register(apiRoutes, { db: ctx.db, skipAuth: true })
    await withoutExecutor.ready()

    const response = await withoutExecutor.inject({
      method: 'POST',
      url: '/api/v1/projects/tech-aeo/technical-aeo/runs',
      payload: {},
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error: { code: 'MISSING_DEPENDENCY', details: { reason: 'no-site-audit-handler' } },
    })
    expect(ctx.db.select().from(runs).all()).toHaveLength(before)
    await withoutExecutor.close()
  })
})

describe('GET /technical-aeo/runs/:runId/progress', () => {
  it('keeps a legacy terminal audit terminal when no crawl attempt exists', async () => {
    const response = await get<SiteAuditRunProgressDto>(`/api/v1/projects/tech-aeo/technical-aeo/runs/${ctx.runA}/progress`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      runId: ctx.runA,
      status: 'completed',
      phase: 'completed',
      attempt: null,
    })
  })

  it.each([
    ['completed', 'completed'],
    ['partial', 'partial'],
  ] as const)('keeps a legacy %s audit terminal when its persisted crawl has no graph layout', async (status, phase) => {
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runId, projectId: ctx.projectId, kind: 'site-audit', status, trigger: 'manual', createdAt: now, finishedAt: now,
    }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId: ctx.projectId, runId, attemptNumber: 1, state: status,
      startedAt: now, finishedAt: now, createdAt: now, updatedAt: now,
    }).run()

    const response = await get<SiteAuditRunProgressDto>(`/api/v1/projects/tech-aeo/technical-aeo/runs/${runId}/progress`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      runId,
      status,
      phase,
      attempt: { id: attemptId, state: status },
      layout: { state: 'unavailable', layoutVersion: null, failureCode: null, updatedAt: null },
    })
  })

  it('returns raw stored counters for an exact running site-audit without a percentage', async () => {
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runId, projectId: ctx.projectId, kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: now, startedAt: now,
    }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId: ctx.projectId, runId, attemptNumber: 1, state: 'running',
      pagesDiscovered: 48, pagesFetched: 19, pagesEligible: 12, pagesErrored: 2, edgesDiscovered: 97,
      startedAt: now, createdAt: now, updatedAt: now,
    }).run()

    const response = await get<SiteAuditRunProgressDto>(`/api/v1/projects/tech-aeo/technical-aeo/runs/${runId}/progress`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(expect.objectContaining({
      project: 'tech-aeo', runId, status: 'running', phase: 'checking',
      layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    }))
    expect(response.body.attempt).toEqual(expect.objectContaining({
      id: attemptId, state: 'running', pagesDiscovered: 48, pagesFetched: 19,
      pagesEligible: 12, pagesErrored: 2, edgesDiscovered: 97, lastUpdatedAt: now,
    }))
    expect(JSON.stringify(response.body)).not.toContain('percent')
  })

  it('pins terminal map layout state to the exact completed run', async () => {
    const response = await get<SiteAuditRunProgressDto>(`/api/v1/projects/tech-aeo/technical-aeo/runs/${ctx.runB}/progress`)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      runId: ctx.runB,
      status: 'completed',
      phase: 'completed',
      layout: { state: 'ready', layoutVersion: 'site-health-fa2-v1' },
      attempt: { state: 'completed', pagesDiscovered: 3, pagesFetched: 3, pagesEligible: 2, edgesDiscovered: 2 },
    })
  })

  it('does not disclose a probe, non-site-audit, or another project\'s run through the project path', async () => {
    const now = new Date().toISOString()
    const answerRunId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: answerRunId, projectId: ctx.projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: now,
    }).run()

    const otherProjectId = crypto.randomUUID()
    const otherRunId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: otherProjectId, name: 'other-health', displayName: 'Other Health', canonicalDomain: 'other.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(runs).values({
      id: otherRunId, projectId: otherProjectId, kind: 'site-audit', status: 'queued', trigger: 'manual', createdAt: now,
    }).run()

    for (const runId of [ctx.probeRun, answerRunId, otherRunId]) {
      const response = await get(`/api/v1/projects/tech-aeo/technical-aeo/runs/${runId}/progress`)
      expect(response.status, runId).toBe(404)
    }
  })
})

describe('GET /technical-aeo/runs/:runId/page-health-preview', () => {
  it('keeps a queued scan in a truthful waiting state before an attempt exists', async () => {
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runId, projectId: ctx.projectId, kind: 'site-audit', status: 'queued', trigger: 'manual', createdAt: now,
    }).run()

    const response = await get<SiteAuditLivePageHealthDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/runs/${runId}/page-health-preview`,
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      project: 'tech-aeo', runId, status: 'queued', state: 'waiting',
      attemptId: null, pagesAudited: 0, updatedAt: null, examples: [],
    })
  })

  it('returns only bounded, actionable, lowest-score examples from the newest running attempt', async () => {
    const now = new Date().toISOString()
    const oldAt = new Date(Date.now() - 1_000).toISOString()
    const runId = crypto.randomUUID()
    const oldAttemptId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runId, projectId: ctx.projectId, kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: oldAt, startedAt: oldAt,
    }).run()
    ctx.db.insert(siteCrawlAttempts).values([
      {
        id: oldAttemptId, projectId: ctx.projectId, runId, attemptNumber: 1, state: 'failed',
        pagesFetched: 1, startedAt: oldAt, finishedAt: oldAt, createdAt: oldAt, updatedAt: oldAt,
      },
      {
        id: attemptId, projectId: ctx.projectId, runId, attemptNumber: 2, state: 'running',
        pagesFetched: 16, startedAt: now, createdAt: now, updatedAt: now,
      },
    ]).run()

    const actionableFields = (includeCriticalDefect = false) => ({
      schemaVersion: '1.0',
      factors: [
        {
          id: 'content-depth', name: 'Content depth', weight: 12, score: 20,
          status: 'fail', applicable: true, findings: [], recommendations: [],
        },
        {
          id: 'not-applicable', name: 'Not applicable', weight: 4, score: 0,
          status: 'fail', applicable: false, findings: [], recommendations: [],
        },
      ],
      criticalDefects: includeCriticalDefect
        ? [{ id: 'missing-h1', severity: 'critical', detail: 'No H1 tag found.', recommendation: 'Add one H1.' }]
        : [],
    })

    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId: oldAttemptId,
        nodeKey: 'old-attempt', url: 'https://example.com/old-attempt', path: '/old-attempt', parentPath: '/',
        auditState: 'success', auditScore: 1, auditFields: actionableFields(), createdAt: oldAt, updatedAt: oldAt,
      },
      ...Array.from({ length: 14 }, (_, index) => ({
        id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId,
        nodeKey: `fresh-${String(index).padStart(2, '0')}`,
        url: `https://example.com/fresh-${index}`,
        path: `/fresh-${index}`, parentPath: '/',
        auditState: 'success', auditScore: 10 + index,
        auditFields: actionableFields(index === 0), createdAt: now, updatedAt: now,
      })),
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId,
        nodeKey: 'not-applicable', url: 'https://example.com/not-applicable', path: '/not-applicable', parentPath: '/',
        auditState: 'success', auditScore: 1,
        auditFields: {
          schemaVersion: '1.0',
          factors: [{
            id: 'not-applicable', name: 'Not applicable', weight: 4, score: 0,
            status: 'fail', applicable: false, findings: [], recommendations: [],
          }],
          criticalDefects: [],
        },
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId,
        nodeKey: 'malformed', url: 'https://example.com/malformed', path: '/malformed', parentPath: '/',
        auditState: 'success', auditScore: 2, auditFields: { factors: 'not-an-array' }, createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId,
        nodeKey: 'not-a-success', url: 'https://example.com/not-a-success', path: '/not-a-success', parentPath: '/',
        auditState: 'error', auditScore: 0, auditFields: actionableFields(), createdAt: now, updatedAt: now,
      },
    ]).run()

    const response = await get<SiteAuditLivePageHealthDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/runs/${runId}/page-health-preview`,
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      project: 'tech-aeo', runId, status: 'running', state: 'collecting',
      attemptId, pagesAudited: 16, updatedAt: now,
    })
    expect(response.body.examples).toHaveLength(12)
    expect(response.body.examples.map((example) => example.nodeKey)).toEqual(
      Array.from({ length: 12 }, (_, index) => `fresh-${String(index).padStart(2, '0')}`),
    )
    expect(response.body.examples[0]).toMatchObject({ auditScore: 10, checksNeedingAttention: 2 })
    expect(response.body.examples.map((example) => example.nodeKey)).not.toContain('old-attempt')
    expect(JSON.stringify(response.body)).not.toContain('Low content depth')
  })

  it('does not read beyond the bounded candidate window while a scan is running', async () => {
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runId, projectId: ctx.projectId, kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: now, startedAt: now,
    }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId: ctx.projectId, runId, attemptNumber: 1, state: 'running',
      pagesFetched: 49, startedAt: now, createdAt: now, updatedAt: now,
    }).run()
    const passOnly = {
      schemaVersion: '1.0',
      factors: [{ id: 'ok', name: 'OK', weight: 1, score: 100, status: 'pass', applicable: true, findings: [], recommendations: [] }],
      criticalDefects: [],
    }
    const actionable = {
      schemaVersion: '1.0',
      factors: [{ id: 'bad', name: 'Bad', weight: 1, score: 0, status: 'fail', applicable: true, findings: [], recommendations: [] }],
      criticalDefects: [],
    }
    ctx.db.insert(siteCrawlPages).values([
      ...Array.from({ length: 48 }, (_, index) => ({
        id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId,
        nodeKey: `zero-${String(index).padStart(2, '0')}`,
        url: `https://example.com/zero-${index}`, path: `/zero-${index}`, parentPath: '/',
        auditState: 'success', auditScore: index, auditFields: passOnly, createdAt: now, updatedAt: now,
      })),
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId,
        nodeKey: 'outside-window', url: 'https://example.com/outside-window', path: '/outside-window', parentPath: '/',
        auditState: 'success', auditScore: 48, auditFields: actionable, createdAt: now, updatedAt: now,
      },
    ]).run()

    const response = await get<SiteAuditLivePageHealthDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/runs/${runId}/page-health-preview`,
    )

    expect(response.status).toBe(200)
    expect(response.body.pagesAudited).toBe(49)
    expect(response.body.examples).toEqual([])
  })

  it('stays terminal after a run finishes and never presents provisional examples as final results', async () => {
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runId, projectId: ctx.projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now, finishedAt: now,
    }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId: ctx.projectId, runId, attemptNumber: 1, state: 'completed', pagesFetched: 1,
      startedAt: now, finishedAt: now, createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(siteCrawlPages).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId, attemptId,
      nodeKey: 'still-provisional', url: 'https://example.com/still-provisional', path: '/still-provisional', parentPath: '/',
      auditState: 'success', auditScore: 20,
      auditFields: {
        schemaVersion: '1.0',
        factors: [{ id: 'bad', name: 'Bad', weight: 1, score: 0, status: 'fail', applicable: true, findings: [], recommendations: [] }],
        criticalDefects: [],
      },
      createdAt: now, updatedAt: now,
    }).run()

    const response = await get<SiteAuditLivePageHealthDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/runs/${runId}/page-health-preview`,
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      project: 'tech-aeo', runId, status: 'completed', state: 'terminal', attemptId, pagesAudited: 1, updatedAt: now,
      examples: [],
    })
  })

  it('does not disclose a probe, non-site-audit, or another project\'s run through the project path', async () => {
    const now = new Date().toISOString()
    const answerRunId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: answerRunId, projectId: ctx.projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: now,
    }).run()
    const otherProjectId = crypto.randomUUID()
    const otherRunId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: otherProjectId, name: 'other-live-preview', displayName: 'Other', canonicalDomain: 'other.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(runs).values({
      id: otherRunId, projectId: otherProjectId, kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: now,
    }).run()

    for (const runId of [ctx.probeRun, answerRunId, otherRunId]) {
      const response = await get(`/api/v1/projects/tech-aeo/technical-aeo/runs/${runId}/page-health-preview`)
      expect(response.status, runId).toBe(404)
    }
  })
})

// Run A is a real, completed, non-probe site-audit that predates crawl
// persistence. Selecting it in the scan history must read as "this scan kept
// no crawl", never as "this run does not exist".
describe('legacy score-only runs stay honest instead of 404ing', () => {
  it('answers the crawl summary with its no-crawl shape and the legacy pointer', async () => {
    const { status, body } = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl?runId=${ctx.runA}`)
    expect(status).toBe(200)
    expect(body.hasCrawlData).toBe(false)
    expect(body.legacyAuditAvailable).toBe(true)
    expect(body.runId).toBeNull()
    expect(body.counts).toEqual({ pagesDiscovered: 0, pagesFetched: 0, pagesEligible: 0, edges: 0, findings: 0 })
  })

  it('answers the crawl page list with an explicit empty crawl', async () => {
    const { status, body } = await get<SiteCrawlPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?runId=${ctx.runA}`)
    expect(status).toBe(200)
    expect(body.hasCrawlData).toBe(false)
    expect(body.runId).toBeNull()
    expect(body.total).toBe(0)
    expect(body.pages).toEqual([])
  })

  it('answers the graph with an unavailable no-crawl layout', async () => {
    const { status, body } = await get<SiteCrawlGraphResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/graph?runId=${ctx.runA}`)
    expect(status).toBe(200)
    expect(body.hasCrawlData).toBe(false)
    expect(body.rootNodeKey).toBeNull()
    expect(body.layout).toEqual({ state: 'unavailable', version: null, reason: 'no-crawl' })
    expect(body.nodes).toEqual([])
  })

  it('answers every other crawl-scoped read with its own no-crawl state', async () => {
    const structure = await get<SiteCrawlStructureResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/structure?runId=${ctx.runA}`)
    expect(structure.status).toBe(200)
    expect(structure.body.hasCrawlData).toBe(false)

    const links = await get<SiteCrawlInternalLinksResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/internal-links?runId=${ctx.runA}`)
    expect(links.status).toBe(200)
    expect(links.body.hasCrawlData).toBe(false)

    const neighbors = await get<SiteCrawlNeighborsResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/internal-links/neighbors?runId=${ctx.runA}&nodeKey=home`)
    expect(neighbors.status).toBe(200)
    expect(neighbors.body.hasCrawlData).toBe(false)

    const deadLinks = await get<SiteCrawlDeadLinksResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/dead-links?runId=${ctx.runA}`)
    expect(deadLinks.status).toBe(200)
    expect(deadLinks.body.state).toBe('unavailable')

    const subgraph = await get<SiteHealthSubgraphResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/subgraph?runId=${ctx.runA}`)
    expect(subgraph.status).toBe(200)
    expect(subgraph.body.state).toBe('no-crawl')

    const path = await get<SiteHealthPathResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/path?runId=${ctx.runA}&toUrl=${encodeURIComponent('https://example.com/old')}`)
    expect(path.status).toBe(200)
    expect(path.body.state).toBe('no-crawl')

    const audit = await get<SiteCrawlPageAuditDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?runId=${ctx.runA}&nodeKey=home`)
    expect(audit.status).toBe(200)
    expect(audit.body.state).toBe('no-crawl')
  })

  it('still 404s a runId this project never surfaced', async () => {
    const unknown = crypto.randomUUID()
    for (const url of [
      `/api/v1/projects/tech-aeo/technical-aeo/crawl?runId=${unknown}`,
      `/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?runId=${unknown}`,
      `/api/v1/projects/tech-aeo/technical-aeo/graph?runId=${unknown}`,
      `/api/v1/projects/tech-aeo/technical-aeo/structure?runId=${unknown}`,
      `/api/v1/projects/tech-aeo/technical-aeo/internal-links?runId=${unknown}`,
      `/api/v1/projects/tech-aeo/technical-aeo/internal-links/neighbors?runId=${unknown}&nodeKey=home`,
      `/api/v1/projects/tech-aeo/technical-aeo/dead-links?runId=${unknown}`,
      `/api/v1/projects/tech-aeo/technical-aeo/subgraph?runId=${unknown}`,
      `/api/v1/projects/tech-aeo/technical-aeo/path?runId=${unknown}&toUrl=${encodeURIComponent('https://example.com/old')}`,
      `/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?runId=${unknown}&nodeKey=home`,
    ]) {
      expect((await get(url)).status, url).toBe(404)
    }
  })

  it('keeps a probe run unreachable through the crawl reads', async () => {
    expect((await get(`/api/v1/projects/tech-aeo/technical-aeo/crawl?runId=${ctx.probeRun}`)).status).toBe(404)
    expect((await get(`/api/v1/projects/tech-aeo/technical-aeo/graph?runId=${ctx.probeRun}`)).status).toBe(404)
  })
})

describe('GET /technical-aeo/runs (scan history)', () => {
  it('lists non-probe site-audit runs newest first and flags which ones kept a crawl', async () => {
    const { status, body } = await get<SiteHealthScansResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/runs')
    expect(status).toBe(200)
    expect(body.project).toBe('tech-aeo')
    expect(body.scans.map((scan) => scan.runId)).toEqual([ctx.runB, ctx.runA])
    expect(body.scans.map((scan) => scan.hasCrawlData)).toEqual([true, false])
    expect(body.scans.every((scan) => scan.status === 'completed')).toBe(true)
  })

  it('includes a queued rescan that has no crawl yet', async () => {
    const queuedId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: queuedId, projectId: ctx.projectId, kind: 'site-audit', status: 'queued',
      trigger: 'manual', createdAt: new Date().toISOString(),
    }).run()
    const { body } = await get<SiteHealthScansResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/runs')
    expect(body.scans[0]!.runId).toBe(queuedId)
    expect(body.scans[0]!.status).toBe('queued')
    expect(body.scans[0]!.hasCrawlData).toBe(false)
  })

  it('bounds the limit and 404s an unknown project', async () => {
    const capped = await get<SiteHealthScansResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/runs?limit=1')
    expect(capped.body.scans).toHaveLength(1)
    expect(capped.body.scans[0]!.runId).toBe(ctx.runB)
    expect((await get('/api/v1/projects/nope/technical-aeo/runs')).status).toBe(404)
  })
})

describe('graph root identity', () => {
  it('names the crawl root so the home page is findable without guessing', async () => {
    const { body } = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph')
    expect(body.rootNodeKey).toBe('home')
    expect(body.nodes.some((node) => node.nodeKey === body.rootNodeKey)).toBe(true)
  })
})

describe('crawl page health-state filter', () => {
  /**
   * The dashboard's "Hidden pages" chip and every agent read must mean the
   * same thing by "hidden". That only holds if the route filters with the
   * contract's own derivation rather than a SQL lookalike, so this asserts the
   * two agree across the whole crawler vocabulary, not just the happy path.
   */
  const FETCH_STATES = ['discovered', 'robots-blocked', 'html', 'redirect', 'non-html', 'fetch-error']
  const INDEXABILITY_STATES = ['indexable', 'noindex', 'blocked', 'unknown']

  function seedEveryCombination(): Array<typeof siteCrawlPages.$inferSelect> {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.delete(siteCrawlPages).where(eq(siteCrawlPages.runId, ctx.runB)).run()
    const rows = []
    for (const fetchState of FETCH_STATES) {
      for (const indexabilityState of INDEXABILITY_STATES) {
        for (const variant of ['plain', 'canonical-away', 'reason-canonical'] as const) {
          const nodeKey = `${fetchState}:${indexabilityState}:${variant}`
          const indexabilityReasons = variant === 'reason-canonical' ? ['canonical-to-other'] : []
          const canonicalNodeKey = variant === 'canonical-away' ? 'some-other-node' : null
          rows.push({
            id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!,
            nodeKey, url: `https://example.com/${encodeURIComponent(nodeKey)}`, path: `/${nodeKey}`, parentPath: '/',
            discoverySource: 'link', fetchState, indexabilityState,
            indexabilityReasons,
            canonicalNodeKey,
            // Written the way the crawl executor writes it: by the contract.
            healthState: deriveSiteHealthState({
              fetchState, indexabilityState, indexabilityReasons, canonicalNodeKey, nodeKey,
            }),
            auditState: 'complete', inventoryEligible: true, depth: 1, createdAt: now, updatedAt: now,
          })
        }
      }
    }
    ctx.db.insert(siteCrawlPages).values(rows).run()
    return ctx.db.select().from(siteCrawlPages).where(eq(siteCrawlPages.runId, ctx.runB)).all()
  }

  it('persists exactly what deriveSiteHealthState decides for every combination', async () => {
    const seeded = seedEveryCombination()
    expect(seeded.length).toBe(FETCH_STATES.length * INDEXABILITY_STATES.length * 3)

    for (const healthState of siteHealthStateSchema.options) {
      const expected = seeded
        .filter((row) => deriveSiteHealthState(row) === healthState)
        .map((row) => row.nodeKey)
        .sort()
      // The stored column is the contract's answer, not a lookalike.
      expect(seeded.filter((row) => row.healthState === healthState).map((row) => row.nodeKey).sort())
        .toEqual(expected)
      const { status, body } = await get<SiteCrawlPagesResponseDto>(
        `/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=${healthState}&limit=200`,
      )
      expect(status).toBe(200)
      expect(body.pages.map((page) => page.nodeKey).sort(), healthState).toEqual(expected)
      expect(body.total, `${healthState} total`).toBe(expected.length)
      // Every returned row also reports that state in its own DTO field.
      expect(body.pages.every((page) => page.healthState === healthState)).toBe(true)
    }

    // Every page lands in exactly one bucket, so the four filters partition the crawl.
    const totals = await Promise.all(siteHealthStateSchema.options.map(async (state) => (
      (await get<SiteCrawlPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=${state}&limit=200`)).body.total
    )))
    expect(totals.reduce((sum, value) => sum + value, 0)).toBe(seeded.length)
  })

  it('means by "hidden" only what the site actually suppressed', async () => {
    seedEveryCombination()
    const hidden = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=hidden&limit=200')
    const noindexOnly = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?indexabilityState=noindex&limit=200')
    const hiddenKeys = new Set(hidden.body.pages.map((page) => page.nodeKey))

    // Still catches what a raw indexabilityState filter misses: robots.txt and
    // a canonical pointing elsewhere are the site suppressing the page.
    expect(hidden.body.total).toBeGreaterThan(noindexOnly.body.total)
    expect([...hiddenKeys].some((key) => key.startsWith('robots-blocked:'))).toBe(true)
    expect([...hiddenKeys].some((key) => key.endsWith(':canonical-away'))).toBe(true)

    // But the chip must NOT sweep up files and redirects. Flagging
    // llms-full.txt as hidden reads as a defect when it is the opposite.
    expect([...hiddenKeys].some((key) => key.startsWith('non-html:'))).toBe(false)
    expect([...hiddenKeys].some((key) => key.startsWith('redirect:'))).toBe(false)

    const resources = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=resource&limit=200')
    expect(resources.body.pages.every((page) => page.nodeKey.startsWith('non-html:'))).toBe(true)
    expect(resources.body.total).toBeGreaterThan(0)

    const redirects = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=redirect&limit=200')
    expect(redirects.body.pages.every((page) => page.nodeKey.startsWith('redirect:'))).toBe(true)
    expect(redirects.body.total).toBeGreaterThan(0)
  })

  it('pages and refuses an unknown health state', async () => {
    seedEveryCombination()
    const firstPage = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=hidden&limit=2')
    expect(firstPage.body.pages).toHaveLength(2)
    expect(firstPage.body.nextCursor).not.toBeNull()

    const secondPage = await get<SiteCrawlPagesResponseDto>(
      `/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=hidden&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor!)}`,
    )
    expect(secondPage.body.total).toBe(firstPage.body.total)
    expect(secondPage.body.pages.map((page) => page.nodeKey))
      .not.toEqual(firstPage.body.pages.map((page) => page.nodeKey))

    expect((await get('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=indexed')).status).toBe(400)
  })

  it('reports a mixed snapshot as unfilterable to every read, not just some', async () => {
    seedEveryCombination()
    // A snapshot where only SOME rows predate the column. A probe narrowed by
    // the request's own filters would answer `applied` for a populated row and
    // `unavailable-legacy-scan` for the list, disagreeing about one snapshot.
    ctx.db.update(siteCrawlPages).set({ healthState: null })
      .where(eq(siteCrawlPages.nodeKey, 'html:noindex:plain')).run()

    const list = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=hidden&limit=200')
    // A populated row, addressed by key, must give the SAME verdict.
    const single = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=hidden&nodeKey=redirect:indexable:plain&limit=1')

    expect(list.body.healthStateFilter).toBe('unavailable-legacy-scan')
    expect(single.body.healthStateFilter).toBe('unavailable-legacy-scan')
    expect(single.body.pages).toEqual([])
  })

  it('reports that a scan published before the column cannot be filtered', async () => {
    seedEveryCombination()
    // A snapshot from before the derived column existed keeps NULLs. There is
    // no honest answer to a filter over it, so the route says so instead of
    // returning a list that looks filtered.
    ctx.db.update(siteCrawlPages).set({ healthState: null })
      .where(eq(siteCrawlPages.nodeKey, 'html:indexable:plain')).run()

    const filtered = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=hidden&limit=200')
    expect(filtered.status).toBe(200)
    expect(filtered.body.healthStateFilter).toBe('unavailable-legacy-scan')
    expect(filtered.body.pages).toEqual([])
    expect(filtered.body.total).toBe(0)

    // The unfiltered list is unaffected and says no filter was requested.
    const unfiltered = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?limit=200')
    expect(unfiltered.body.healthStateFilter).toBeNull()
    expect(unfiltered.body.total).toBeGreaterThan(0)
  })

  it('serves the real filtered query from the index, with no temp b-tree sort', () => {
    seedEveryCombination()
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    // The exact shape the page list issues: filter on the derived state,
    // ordered by path. If the index does not cover the ORDER BY, SQLite sorts
    // every match in a temp b-tree before LIMIT, on every cursor page.
    const plan = ctx.db.all(sql`
      EXPLAIN QUERY PLAN
      SELECT * FROM site_crawl_pages
      WHERE project_id = ${ctx.projectId}
        AND run_id = ${ctx.runB}
        AND attempt_id = ${snapshot.attemptId}
        AND health_state = 'hidden'
      ORDER BY path ASC, node_key ASC
      LIMIT 100
    `) as Array<{ detail: string }>
    const detail = plan.map((row) => row.detail).join(' | ')

    expect(detail).toContain('idx_site_crawl_pages_health')
    expect(detail).not.toContain('TEMP B-TREE')
    expect(detail).not.toContain('SCAN site_crawl_pages')
  })

  it('answers a filtered read without scanning every page row', async () => {
    seedEveryCombination()
    const applied = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?healthState=hidden&limit=1')
    expect(applied.body.healthStateFilter).toBe('applied')
    expect(applied.body.pages).toHaveLength(1)
    // `total` is a COUNT over the indexed filter, not the length of a
    // materialized list, so limit=1 stays a bounded read.
    expect(applied.body.total).toBeGreaterThan(1)
  })
})

describe('GET /technical-aeo template link reads', () => {
  /** Mark the seeded `home-gone` link as nav chrome and record the state. */
  function classifySeededCrawl(detection: string | null, options?: { templateLinksExcluded?: boolean }): void {
    ctx.db.update(siteCrawlEdges)
      .set({ isTemplate: false, templateRatio: 0.1 })
      .where(eq(siteCrawlEdges.runId, ctx.runB))
      .run()
    if (detection === 'applied') {
      ctx.db.update(siteCrawlEdges)
        .set({ isTemplate: true, templateRatio: 1 })
        .where(and(eq(siteCrawlEdges.runId, ctx.runB), eq(siteCrawlEdges.edgeKey, 'home-gone')))
        .run()
      ctx.db.update(siteCrawlGraphEdges)
        .set({ isTemplate: true })
        .where(and(eq(siteCrawlGraphEdges.runId, ctx.runB), eq(siteCrawlGraphEdges.edgeKey, 'home-gone')))
        .run()
      ctx.db.update(siteCrawlGraphLayouts)
        .set({ totalTemplateEdges: 1, templateLinksExcluded: options?.templateLinksExcluded ?? true })
        .where(eq(siteCrawlGraphLayouts.runId, ctx.runB))
        .run()
    }
    if (detection === null) {
      ctx.db.update(siteCrawlEdges)
        .set({ isTemplate: null, templateRatio: null })
        .where(eq(siteCrawlEdges.runId, ctx.runB))
        .run()
    }
    // The writer's no-rule path resets to (false, NULL) and returns before it
    // measures anything, so a stored ratio under this state is not a row the
    // product can produce.
    if (detection === 'unavailable-too-few-pages') {
      ctx.db.update(siteCrawlEdges)
        .set({ isTemplate: false, templateRatio: null })
        .where(eq(siteCrawlEdges.runId, ctx.runB))
        .run()
    }
    ctx.db.update(siteCrawlSnapshots)
      .set({ templateDetection: detection })
      .where(eq(siteCrawlSnapshots.runId, ctx.runB))
      .run()
  }

  it('publishes template links tagged, so a viewer can draw them without moving a node', async () => {
    classifySeededCrawl('applied')
    const { body } = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph')

    expect(body.templateDetection).toBe('applied')
    expect(body.linkKind).toBe('all')
    expect(body.edges.map((edge) => [edge.edgeKey, edge.isTemplate])).toEqual([
      ['home-guide', false],
      ['home-gone', true],
    ])
    if (body.layout.state !== 'ready') throw new Error('expected a ready layout')
    expect(body.layout.templateLinksExcluded).toBe(true)
    // The total keeps counting every link; the two new numbers split it.
    expect(body.totalEdges).toBe(2)
    expect(body.totalTemplateEdges).toBe(1)
    expect(body.totalContentEdges).toBe(1)
  })

  it('says when a scan\'s positions predate the split instead of implying they do not', async () => {
    classifySeededCrawl('applied', { templateLinksExcluded: false })
    const { body } = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph')

    expect(body.templateDetection).toBe('applied')
    if (body.layout.state !== 'ready') throw new Error('expected a ready layout')
    expect(body.layout.templateLinksExcluded).toBe(false)
  })

  it('narrows every link read on request while keeping the totals honest', async () => {
    classifySeededCrawl('applied')

    const content = await get<SiteCrawlInternalLinksResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links?linkKind=content',
    )
    expect(content.body.linkKind).toBe('content')
    expect(content.body.templateDetection).toBe('applied')
    expect(content.body.total).toBe(1)
    expect(content.body.edges.map((edge) => edge.edgeKey)).toEqual(['home-guide'])
    expect(content.body.edges[0]).toMatchObject({ isTemplate: false, templateRatio: 0.1 })

    const template = await get<SiteCrawlInternalLinksResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links?linkKind=template',
    )
    expect(template.body.edges.map((edge) => edge.edgeKey)).toEqual(['home-gone'])

    const all = await get<SiteCrawlInternalLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links')
    expect(all.body.linkKind).toBe('all')
    expect(all.body.total).toBe(2)

    const neighbors = await get<SiteCrawlNeighborsResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links/neighbors?nodeKey=home&linkKind=content',
    )
    expect(neighbors.body.linkKind).toBe('content')
    expect(neighbors.body.outbound.map((edge) => edge.edgeKey)).toEqual(['home-guide'])

    const graph = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph?linkKind=content')
    expect(graph.body.edges.map((edge) => edge.edgeKey)).toEqual(['home-guide'])
    // Narrowing the payload must not move the counts it is a subset of.
    expect(graph.body.totalEdges).toBe(2)
    expect(graph.body.totalTemplateEdges).toBe(1)
  })

  it('reports why a scan could not be classified rather than answering with an empty list', async () => {
    classifySeededCrawl('unavailable-too-few-pages')
    const small = await get<SiteCrawlInternalLinksResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links?linkKind=template',
    )
    expect(small.body.templateDetection).toBe('unavailable-too-few-pages')
    expect(small.body.edges).toEqual([])

    // A scan whose links were never classified holds NULL, which matches
    // NEITHER kind. The state is what stops that reading as a real zero.
    classifySeededCrawl(null)
    for (const linkKind of ['content', 'template']) {
      const legacy = await get<SiteCrawlInternalLinksResponseDto>(
        `/api/v1/projects/tech-aeo/technical-aeo/internal-links?linkKind=${linkKind}`,
      )
      expect(legacy.body.templateDetection).toBe('unavailable-legacy-scan')
      expect(legacy.body.total).toBe(0)
      expect(legacy.body.edges).toEqual([])
    }
    const legacyAll = await get<SiteCrawlInternalLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links')
    expect(legacyAll.body.total).toBe(2)
    expect(legacyAll.body.edges.every((edge) => edge.isTemplate === null)).toBe(true)

    const graph = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph')
    expect(graph.body.templateDetection).toBe('unavailable-legacy-scan')
  })

  it('says which rule decided each link, so a count can be attributed', async () => {
    // Both links look identical to a reader without this: one `isTemplate`
    // each. Only `templateSource` says whether the answer came from where the
    // link sits in the page or from how many pages repeat it, and the two rules
    // do not measure the same thing.
    classifySeededCrawl('applied-placement-with-ubiquity')
    ctx.db.update(siteCrawlEdges)
      .set({
        placementNavigationOccurrences: 2,
        placementContentOccurrences: 0,
        placementUnknownOccurrences: 0,
      })
      .where(and(eq(siteCrawlEdges.runId, ctx.runB), eq(siteCrawlEdges.edgeKey, 'home-gone')))
      .run()
    ctx.db.update(siteCrawlEdges)
      .set({
        placementNavigationOccurrences: 0,
        placementContentOccurrences: 0,
        placementUnknownOccurrences: 3,
      })
      .where(and(eq(siteCrawlEdges.runId, ctx.runB), eq(siteCrawlEdges.edgeKey, 'home-guide')))
      .run()

    const { body } = await get<SiteCrawlInternalLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links')
    expect(body.templateDetection).toBe('applied-placement-with-ubiquity')
    // `home-guide` carries a stored ratio, which is what makes it attributable
    // to the fallback; without one it would read `unmeasured`, not `ubiquity`.
    expect(body.edges.map((edge) => [edge.edgeKey, edge.templateSource])).toEqual([
      ['home-gone', 'placement'],
      ['home-guide', 'ubiquity'],
    ])
    expect(body.edges.find((edge) => edge.edgeKey === 'home-gone')?.placementOccurrences)
      .toEqual({ navigation: 2, content: 0, unknown: 0 })

    const neighbors = await get<SiteCrawlNeighborsResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links/neighbors?nodeKey=home',
    )
    expect(neighbors.body.outbound.map((edge) => edge.templateSource)).toEqual(['placement', 'ubiquity'])
  })

  it('never reports a link as classified by a rule its own scan did not run', async () => {
    // The scan is the authority. A scan that recorded no placement reports
    // `ubiquity` for every classified link even if a row somehow carries
    // counts, and a scan no rule could touch reports `unclassified` rather than
    // letting an explicit `false` pass for the ubiquity rule's answer.
    classifySeededCrawl('applied')
    ctx.db.update(siteCrawlEdges)
      .set({
        placementNavigationOccurrences: 1,
        placementContentOccurrences: 0,
        placementUnknownOccurrences: 0,
      })
      .where(eq(siteCrawlEdges.runId, ctx.runB))
      .run()
    const ubiquityOnly = await get<SiteCrawlInternalLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links')
    expect(ubiquityOnly.body.edges.every((edge) => edge.templateSource === 'ubiquity')).toBe(true)

    classifySeededCrawl('unavailable-too-few-pages')
    const tooSmall = await get<SiteCrawlInternalLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links')
    expect(tooSmall.body.edges.every((edge) => edge.templateSource === 'unmeasured')).toBe(true)

    classifySeededCrawl(null)
    // A real pre-4.7.0 row: the columns were added by the migration and left
    // NULL, because there was nothing to backfill them from.
    ctx.db.update(siteCrawlEdges)
      .set({
        placementNavigationOccurrences: null,
        placementContentOccurrences: null,
        placementUnknownOccurrences: null,
      })
      .where(eq(siteCrawlEdges.runId, ctx.runB))
      .run()
    const legacy = await get<SiteCrawlInternalLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links')
    expect(legacy.body.edges.every((edge) => edge.templateSource === 'unmeasured')).toBe(true)
    // A legacy scan has no placement to report, and reporting zeros would say
    // the pages declared no landmarks rather than that nobody looked.
    expect(legacy.body.edges.every((edge) => edge.placementOccurrences === null)).toBe(true)
  })

  it('keeps the link filter working under every rule that classified something', async () => {
    for (const detection of ['applied-placement', 'applied-placement-with-ubiquity', 'applied-placement-partial'] as const) {
      classifySeededCrawl('applied')
      ctx.db.update(siteCrawlSnapshots)
        .set({ templateDetection: detection, linkPlacementRulesetVersion: '1.0.0' })
        .where(eq(siteCrawlSnapshots.runId, ctx.runB))
        .run()
      const content = await get<SiteCrawlInternalLinksResponseDto>(
        '/api/v1/projects/tech-aeo/technical-aeo/internal-links?linkKind=content',
      )
      expect(content.body.templateDetection).toBe(detection)
      expect(content.body.edges.map((edge) => edge.edgeKey)).toEqual(['home-guide'])
    }
  })

  it('agrees about what a content link is across every surface of one scan', async () => {
    // The graph read, the link list, and the neighbour read each filter on
    // `is_template` separately. They must return the same set for the same
    // scan: two reads of one crawl disagreeing about which links are content is
    // worse than either answer alone.
    classifySeededCrawl('applied')
    ctx.db.update(siteCrawlSnapshots)
      .set({ templateDetection: 'applied-placement-partial', linkPlacementRulesetVersion: '1.0.0' })
      .where(eq(siteCrawlSnapshots.runId, ctx.runB))
      .run()
    ctx.db.update(siteCrawlEdges)
      .set({
        placementNavigationOccurrences: 0,
        placementContentOccurrences: 0,
        placementUnknownOccurrences: 4,
        templateRatio: null,
      })
      .where(and(eq(siteCrawlEdges.runId, ctx.runB), eq(siteCrawlEdges.edgeKey, 'home-guide')))
      .run()

    const links = await get<SiteCrawlInternalLinksResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links?linkKind=content',
    )
    const neighbors = await get<SiteCrawlNeighborsResponseDto>(
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links/neighbors?nodeKey=home&linkKind=content',
    )
    const graph = await get<SiteCrawlGraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/graph?linkKind=content')

    const contentKeys = ['home-guide']
    expect(links.body.edges.map((edge) => edge.edgeKey)).toEqual(contentKeys)
    expect(neighbors.body.outbound.map((edge) => edge.edgeKey)).toEqual(contentKeys)
    expect(graph.body.edges.map((edge) => edge.edgeKey)).toEqual(contentKeys)

    // And the totals split the same number the payload does: no link is
    // counted in neither bucket, and none in both.
    expect(graph.body.totalTemplateEdges + graph.body.totalContentEdges).toBe(graph.body.totalEdges)
    expect(graph.body.totalContentEdges).toBe(contentKeys.length)
    // A link nothing measured is still a content link, and says so.
    expect(links.body.edges[0]?.templateSource).toBe('unmeasured')
  })

  it('rejects an unknown link kind instead of silently returning everything', async () => {
    for (const url of [
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links?linkKind=nav',
      '/api/v1/projects/tech-aeo/technical-aeo/internal-links/neighbors?nodeKey=home&linkKind=nav',
      '/api/v1/projects/tech-aeo/technical-aeo/graph?linkKind=nav',
    ]) {
      const invalid = await ctx.app.inject({ method: 'GET', url })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json().error.code).toBe('VALIDATION_ERROR')
    }
  })
})
