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
  SiteAuditPageFactorDto,
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

// Two factors whose weights (12 + 4) split the score 75 / 25: a weight is
// relative, and only the recorded share is a percentage.
const FACTORS_B: SiteAuditFactorSummaryDto[] = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, sharePct: 75, avgScore: 80, status: 'pass', pagesPassing: 2, pagesPartial: 0, pagesFailing: 0 },
  { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, sharePct: 25, avgScore: 30, status: 'fail', pagesPassing: 0, pagesPartial: 0, pagesFailing: 2 },
]
const PAGE_FACTORS_B: SiteAuditPageFactorDto[] = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, score: 80, sharePct: 75 },
  { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, score: 80, sharePct: 25 },
]

// Run A was stored before canonry kept the engine's share: its JSON has no
// `sharePct` key at all, exactly as those rows sit in a database today.
const LEGACY_FACTORS_A = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, avgScore: 60, status: 'partial', pagesPassing: 0, pagesPartial: 1, pagesFailing: 0 },
] as unknown as SiteAuditFactorSummaryDto[]
const LEGACY_PAGE_FACTORS_A = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, score: 60 },
] as unknown as SiteAuditPageFactorDto[]

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
    factorAverages: LEGACY_FACTORS_A, crossCuttingIssues: [], prioritizedFixes: [], createdAt: tA,
  }).run()
  db.insert(siteAuditPages).values({
    id: crypto.randomUUID(), projectId, runId: runA, url: 'https://example.com/old',
    overallScore: 60, overallGrade: 'D-', status: 'success', error: null, factors: LEGACY_PAGE_FACTORS_A, createdAt: tA,
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
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/good', overallScore: 80, overallGrade: 'B-', status: 'success', error: null, factors: PAGE_FACTORS_B, createdAt: tB },
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
      inventoryEligible: true, depth: 0, outboundUniqueEdges: 2, outboundOccurrences: 3, linkScoreRaw: 10, linkScoreNormalized: 100,
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
      inventoryEligible: true, depth: 1, inboundUniqueEdges: 1, inboundOccurrences: 2, linkScoreRaw: 4, linkScoreNormalized: 40,
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

  it.each([
    {
      population: 'recorded factor bands', pagesAudited: 100, unavailableFactorIds: [],
      factors: [
        { id: 'scarce-fail', name: 'Scarce failure', weight: 10, avgScore: 95, status: 'fail', pagesPassing: 95, pagesPartial: 0, pagesFailing: 5 },
        { id: 'broad-partial', name: 'Broad partial', weight: 1, avgScore: 65, status: 'partial', pagesPassing: 10, pagesPartial: 90, pagesFailing: 0 },
        { id: 'tie-b', name: 'Tie B', weight: 3, avgScore: 92, status: 'fail', pagesPassing: 92, pagesPartial: 0, pagesFailing: 8 },
        { id: 'all-pass', name: 'All pass', weight: 20, avgScore: 100, status: 'pass', pagesPassing: 100, pagesPartial: 0, pagesFailing: 0 },
        { id: 'tie-a', name: 'Tie A', weight: 2, avgScore: 94, status: 'partial', pagesPassing: 92, pagesPartial: 8, pagesFailing: 0 },
      ] as SiteAuditFactorSummaryDto[],
      expected: [
        { factorId: 'broad-partial', pagesBelowPass: 90, pagesFailing: 0, pagesPartial: 90 },
        { factorId: 'tie-a', pagesBelowPass: 8, pagesFailing: 0, pagesPartial: 8 },
        { factorId: 'tie-b', pagesBelowPass: 8, pagesFailing: 8, pagesPartial: 0 },
        { factorId: 'scarce-fail', pagesBelowPass: 5, pagesFailing: 5, pagesPartial: 0 },
        { factorId: 'all-pass', pagesBelowPass: 0, pagesFailing: 0, pagesPartial: 0 },
      ],
    },
    { population: 'zero audited pages', pagesAudited: 0, factors: [], expected: [], unavailableFactorIds: [] },
    {
      population: 'legacy missing bands', pagesAudited: 100,
      factors: [
        { id: 'missing-partial', name: 'Missing partial count', weight: 10, avgScore: 98, status: 'fail', pagesPassing: 98, pagesFailing: 2 },
        { id: 'missing-failing', name: 'Missing failing count', weight: 2, avgScore: 96, status: 'partial', pagesPassing: 97, pagesPartial: 3 },
      ] as unknown as SiteAuditFactorSummaryDto[],
      expected: [], unavailableFactorIds: ['missing-failing', 'missing-partial'],
    },
  ])('ranks affected-page breadth independently of severity for $population', async ({ population, pagesAudited, factors, expected, unavailableFactorIds }) => {
    ctx.db.update(siteAuditSnapshots).set({ pagesAudited, factorAverages: factors }).where(eq(siteAuditSnapshots.runId, ctx.runB)).run()
    const { body } = await get<SiteAuditScoreDto & { affectedPageRanking?: unknown }>('/api/v1/projects/tech-aeo/technical-aeo')
    expect(body.affectedPageRanking).toEqual({ basis: 'pages-below-pass', scope: 'audited-pages', pagesAudited, items: expected, unavailableFactorIds })
    // This existing array is presentation order, not the new breadth ranking.
    expect(body.factors.map(factor => factor.id)).toEqual(factors.map(factor => factor.id))
    if (population === 'recorded factor bands') {
      expect(body.factors[0]).toMatchObject({ id: 'scarce-fail', status: 'fail' })
      expect(body.factors[1]).toMatchObject({ id: 'broad-partial', status: 'partial' })
    }
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
    expect(body).not.toHaveProperty('affectedPageRanking')
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

describe('audit factor shares on the site audit reads', () => {
  it('corrects a stored partial mean label without combining failing and partial pages', async () => {
    ctx.db.update(siteAuditSnapshots).set({ factorAverages: [{
      id: 'structured-data', name: 'Structured Data', weight: 12, sharePct: 100,
      avgScore: 51, status: 'partial', pagesPassing: 1, pagesPartial: 2, pagesFailing: 1,
    }] }).where(eq(siteAuditSnapshots.runId, ctx.runB)).run()
    const { body } = await get<SiteAuditScoreDto>('/api/v1/projects/tech-aeo/technical-aeo')
    expect(body.factors).toEqual([{
      id: 'structured-data', name: 'Structured Data', weight: 12, sharePct: 100,
      avgScore: 51, status: 'fail', pagesPassing: 1, pagesPartial: 2, pagesFailing: 1,
    }])
  })

  it('returns each factor share of the site score beside its weight', async () => {
    const { body } = await get<SiteAuditScoreDto>('/api/v1/projects/tech-aeo/technical-aeo')
    expect(body.runId).toBe(ctx.runB)
    expect(body.factors.map(({ id, weight, sharePct }) => ({ id, weight, sharePct }))).toEqual([
      { id: 'structured-data', weight: 12, sharePct: 75 },
      { id: 'ai-crawler-access', weight: 4, sharePct: 25 },
    ])
  })

  it('reads a scan stored before shares as not recorded, never as its weight', async () => {
    const { body } = await get<SiteAuditScoreDto>(`/api/v1/projects/tech-aeo/technical-aeo?runId=${ctx.runA}`)
    expect(body.factors).toHaveLength(1)
    // Present and null on the wire, so a reader can tell "not recorded" from an older server.
    expect(body.factors[0]).toHaveProperty('sharePct', null)
    expect(body.factors[0]).toMatchObject({ id: 'structured-data', weight: 12, avgScore: 60 })
  })

  it('returns each page factor share, and null for a page stored before shares', async () => {
    const current = await get<SiteAuditPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/pages?sort=score-desc&limit=1')
    expect(current.body.pages[0]!.url).toBe('https://example.com/good')
    expect(current.body.pages[0]!.factors).toEqual(PAGE_FACTORS_B)

    const legacy = await get<SiteAuditPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/pages?runId=${ctx.runA}`)
    expect(legacy.body.pages[0]!.factors).toEqual([
      { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, score: 60, sharePct: null },
    ])
  })

  it('returns a recorded page share with its evidence, and keeps a complete row stored before shares complete', async () => {
    const attempt = ctx.db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: attempt.id, nodeKey: 'scored',
      url: 'https://example.com/scored', path: '/scored', parentPath: '/', discoverySource: 'link',
      fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: 80,
      auditFields: {
        schemaVersion: '1.0',
        factors: [
          { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, score: 80, sharePct: 75, status: 'pass', applicable: true, findings: [], recommendations: [] },
          { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, score: 80, sharePct: 25, status: 'pass', applicable: true, findings: [], recommendations: [] },
        ],
        criticalDefects: [],
      },
      inventoryEligible: true, depth: 1, createdAt: now, updatedAt: now,
    }).run()

    const scored = await get<SiteCrawlPageAuditDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?nodeKey=scored')
    expect(scored.body).toMatchObject({
      state: 'ready',
      evidenceState: 'complete',
      factors: [{ id: 'structured-data', weight: 12, sharePct: 75 }, { id: 'ai-crawler-access', weight: 4, sharePct: 25 }],
    })

    // The guide row has full evidence but predates the share: still complete, share unknown.
    const guide = await get<SiteCrawlPageAuditDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?nodeKey=guide')
    expect(guide.body).toMatchObject({ state: 'ready', evidenceState: 'complete', factors: [{ id: 'content-depth', weight: 12 }] })
    expect(guide.body.state === 'ready' && guide.body.factors[0]).toHaveProperty('sharePct', null)

    const home = await get<SiteCrawlPageAuditDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages/audit?nodeKey=home')
    expect(home.body).toMatchObject({ state: 'ready', evidenceState: 'scores-only' })
    expect(home.body.state === 'ready' && home.body.factors[0]).toHaveProperty('sharePct', null)
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

  it('makes a newer-day page-capped crawl current while the older complete one stays selectable', async () => {
    const now = new Date(Date.now() + 86_400_000).toISOString()
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
    const historical = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl?runId=${ctx.runB}`)
    const subgraph = await get<SiteHealthSubgraphResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/subgraph')
    const path = await get<SiteHealthPathResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/path?toNodeKey=partial-target')
    const changes = await get<SiteHealthChangesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/changes')
    expect(current.body).toMatchObject({ runId: partialRun, runStatus: 'partial', complete: false, termination: 'max-pages' })
    expect(historical.body).toMatchObject({ runId: ctx.runB, runStatus: 'completed', complete: true })
    // A diff still needs two complete crawls, so the partial one never enters it.
    expect(changes.body).toMatchObject({ state: 'unavailable', reason: 'insufficient-history', toRunId: ctx.runB })
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
        indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 1, linkScoreNormalized: 90,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'beta',
        url: 'https://example.com/beta', path: '/beta', parentPath: '/', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
        indexabilityState: 'indexable', auditState: 'complete', inventoryEligible: true, depth: 1, linkScoreNormalized: 90,
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
      complete: false, termination: null,
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
        inventoryEligible: true, depth: 0, outboundUniqueEdges: 2, outboundOccurrences: 3, linkScoreRaw: 10, linkScoreNormalized: 100,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runA, attemptId, nodeKey: 'guide',
        url: 'https://example.com/guide', finalUrl: 'https://example.com/guide', path: '/guide', parentPath: '/', discoverySource: 'link',
        fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: 42,
        inventoryEligible: true, depth: 1, inboundUniqueEdges: 1, inboundOccurrences: 2, linkScoreRaw: 4, linkScoreNormalized: 40,
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
    // No saved budget and none requested: the full site.
    expect(ctx.db.select().from(siteCrawlRunRequests).where(eq(siteCrawlRunRequests.runId, runId)).get()).toMatchObject({
      effectiveOptions: { maxPages: 50_000, maxEdges: null },
    })
    // The executor must receive no edge budget at all, so the crawl engine
    // derives it from the page count instead of inheriting a flat ceiling.
    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.siteAuditRequested[0]!.opts).toMatchObject({ maxPages: 50_000 })
    expect(ctx.siteAuditRequested[0]!.opts!.maxEdges).toBeUndefined()
  })

  // The saved budget reaches the run through the project write the dashboard
  // and CLI use, not a seeded column, so the whole default path is exercised.
  async function saveBudget(siteAuditMaxPages: number | null): Promise<void> {
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/tech-aeo',
      payload: { displayName: 'Tech AEO', canonicalDomain: 'example.com', country: 'US', language: 'en', siteAuditMaxPages },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().siteAuditMaxPages).toBe(siteAuditMaxPages)
  }

  it('runs a scan that sets no budget with the project\'s saved budget and records it', async () => {
    await saveBudget(2_500)

    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    expect(res.statusCode).toBe(200)
    const runId = (res.json() as { runId: string }).runId
    expect(ctx.db.select().from(siteCrawlRunRequests).where(eq(siteCrawlRunRequests.runId, runId)).get()!.effectiveOptions).toEqual({
      schemaVersion: 2,
      sitemapUrl: null,
      maxPages: 2_500,
      maxEdges: null,
      maxDepth: null,
      checkDeadLinks: false,
    })
    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.siteAuditRequested[0]).toMatchObject({ runId, projectId: ctx.projectId })
    expect(ctx.siteAuditRequested[0]!.opts).toMatchObject({ maxPages: 2_500 })

    // A second scan with no budget is the same request, so it consolidates.
    const again = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    expect((again.json() as { runId: string }).runId).toBe(runId)
    expect(ctx.siteAuditRequested).toHaveLength(1)
  })

  it('lets an explicit maxPages override the saved budget', async () => {
    await saveBudget(2_500)

    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { maxPages: 40 } })
    expect(res.statusCode).toBe(200)
    const runId = (res.json() as { runId: string }).runId
    expect(ctx.db.select().from(siteCrawlRunRequests).where(eq(siteCrawlRunRequests.runId, runId)).get()).toMatchObject({
      effectiveOptions: { maxPages: 40 },
    })
    expect(ctx.siteAuditRequested[0]!.opts).toMatchObject({ maxPages: 40 })
  })

  it('refuses a scan with no budget once the saved budget changed under an active run', async () => {
    // Full site first, then the budget is saved while that scan is still queued.
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    const firstId = (first.json() as { runId: string }).runId
    await saveBudget(2_500)

    const second = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({
      error: {
        code: 'OPERATION_IN_PROGRESS',
        details: {
          activeRunId: firstId,
          activeOptions: { maxPages: 50_000 },
          requestedOptions: { maxPages: 2_500 },
        },
      },
    })
    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.db.select().from(runs).where(eq(runs.projectId, ctx.projectId)).all().filter((run) => run.status === 'queued')).toHaveLength(1)
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

describe('same-date site audit selection', () => {
  function seedScan(createdAt: string, pages: number, complete: boolean, trigger = 'manual', auditedPages = pages): string {
    const runId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runId, projectId: ctx.projectId, kind: 'site-audit',
      status: complete ? 'completed' : 'partial', trigger, createdAt, finishedAt: createdAt,
    }).run()
    // These are retained scan summaries after their detailed page rows expired.
    ctx.db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId,
      rootUrl: 'https://example.com/', requestedRootUrl: 'https://example.com/',
      crawlSchemaVersion: '1.0', engineVersion: 'crawl-test', normalizationVersion: 'url-v1',
      indexabilityVersion: 'index-v1', linkScoreVersion: 'links-v1',
      complete, termination: complete ? 'complete' : 'max-pages', detailsAvailable: false,
      pagesDiscovered: pages, pagesFetched: pages, pagesEligible: auditedPages, createdAt, updatedAt: createdAt,
    }).run()
    ctx.db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId,
      sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: createdAt,
      aggregateScore: 60, pagesDiscovered: pages, pagesAudited: auditedPages,
      pagesSkipped: 0, pagesErrored: 0, factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt,
    }).run()
    return runId
  }

  it.each([
    { complete: true, earlierPages: 2, earlierAudited: 2, laterPages: 4, laterAudited: 4, reason: 'latest-date-complete' },
    { complete: false, earlierPages: 5, earlierAudited: 5, laterPages: 2, laterAudited: 2, reason: 'latest-date-most-pages' },
    { complete: false, earlierPages: 600, earlierAudited: 200, laterPages: 450, laterAudited: 420, reason: 'latest-date-most-pages' },
  ])('prefers $reason on the latest date and exposes the other same-date scan', async ({ complete, earlierPages, earlierAudited, laterPages, laterAudited, reason }) => {
    const date = '2030-04-12'
    seedScan('2030-04-11T18:00:00.000Z', 9, true)
    const preferred = seedScan(`${date}T09:00:00.000Z`, earlierPages, complete, 'manual', earlierAudited)
    const later = seedScan(`${date}T16:00:00.000Z`, laterPages, false, 'manual', laterAudited)
    seedScan(`${date}T19:00:00.000Z`, 9, true, 'probe')

    for (const suffix of ['', '/pages', '/crawl', '/crawl/pages', '/crawl/pages/audit?nodeKey=home']) {
      const { status, body } = await get<{ runId: string; runSelection: SiteAuditScoreDto['runSelection'] }>(
        `/api/v1/projects/tech-aeo/technical-aeo${suffix}`,
      )
      expect(status, suffix).toBe(200)
      expect(body.runId, suffix).toBe(preferred)
      expect(body.runSelection, suffix).toEqual({
        reason, date, sameDateRunCount: 2, ambiguousDate: true, candidatesTruncated: false,
        candidates: [
          { runId: preferred, createdAt: `${date}T09:00:00.000Z`, complete, pages: earlierPages },
          { runId: later, createdAt: `${date}T16:00:00.000Z`, complete: false, pages: laterPages },
        ],
      })
    }
    const scans = (await get<SiteHealthScansResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/runs?limit=1')).body
    expect(scans.preferredRunId).toBe(preferred)
    expect(scans.scans).toHaveLength(1)
    const pinned = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl?runId=${later}`)
    expect(pinned.body).toMatchObject({ runId: later, complete: false, runSelection: { reason: 'explicit-run' } })
  })

  it('keeps the preferred crawl selected when no page was audited, with legacy scores available by run id', async () => {
    const preferred = seedScan('2030-04-12T09:00:00.000Z', 4, false, 'manual', 0)
    ctx.db.delete(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, preferred)).run()
    const score = (await get<SiteAuditScoreDto>('/api/v1/projects/tech-aeo/technical-aeo')).body
    expect(score).toMatchObject({ hasData: false, runId: preferred, runStatus: 'partial', runSelection: { reason: 'latest-date-most-pages' } })
    const pages = (await get<SiteAuditPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/pages')).body
    expect(pages).toMatchObject({ runId: preferred, total: 0, pages: [] })
    expect((await get<SiteAuditScoreDto>(`/api/v1/projects/tech-aeo/technical-aeo?runId=${preferred}`)).body).toMatchObject({ hasData: false, runId: preferred, runSelection: { reason: 'explicit-run' } })
    expect((await get<SiteAuditScoreDto>(`/api/v1/projects/tech-aeo/technical-aeo?runId=${ctx.runA}`)).body).toMatchObject({ hasData: true, runId: ctx.runA })
    expect((await get<SiteHealthScansResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/runs')).body.preferredRunId).toBe(preferred)
    ctx.db.delete(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.projectId, ctx.projectId)).run()
    expect((await get<SiteAuditScoreDto>('/api/v1/projects/tech-aeo/technical-aeo')).body).toMatchObject({ hasData: true, runId: ctx.runB })
    expect((await get<SiteHealthScansResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/runs')).body.preferredRunId).toBe(ctx.runB)
  })

  it('bounds same-date candidates while preserving the total and deterministic ties', async () => {
    const runIds = Array.from({ length: 11 }, () => seedScan('2030-04-12T09:00:00.000Z', 2, false))
    const { body } = await get<SiteCrawlSummaryDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl')
    expect(body.runId).toBe([...runIds].sort().at(-1))
    expect(body.runSelection).toMatchObject({
      sameDateRunCount: 11, ambiguousDate: true, candidatesTruncated: true,
    })
    expect(body.runSelection!.candidates).toHaveLength(10)
  })

  it.each([
    { complete: true, pages: 2, reason: 'requested-date-complete' },
    { complete: false, pages: 5, reason: 'requested-date-most-pages' },
  ])('selects $reason from a historical UTC date rather than the newest scan', async ({ complete, pages, reason }) => {
    const date = '2030-04-10'
    const preferred = seedScan(`${date}T09:00:00.000Z`, pages, complete)
    const later = seedScan(`${date}T16:00:00.000Z`, 3, false)
    seedScan(`${date}T19:00:00.000Z`, 9, true, 'probe')
    seedScan('2030-04-12T09:00:00.000Z', 9, true)
    for (const suffix of ['crawl', 'crawl/pages']) {
      const { status, body } = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?date=${date}`)
      expect(status).toBe(200)
      expect(body).toMatchObject({ runId: preferred, requestedDate: date, runSelection: { reason, date, sameDateRunCount: 2, ambiguousDate: true, candidatesTruncated: false } })
      expect(body.runSelection!.candidates.map(candidate => candidate.runId)).toEqual([preferred, later])
    }
  })

  it('preserves a missing requested date and unavailable inventory rather than returning the latest crawl', async () => {
    for (const suffix of ['crawl', 'crawl/pages']) {
      const { status, body } = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?date=2030-04-10`)
      expect(status).toBe(200)
      expect(body).toMatchObject({ hasCrawlData: false, runId: null, requestedDate: '2030-04-10', inventorySummary: null })
    }
    const runId = seedScan('2030-04-10T09:00:00.000Z', 5, false)
    expect((await get<SiteCrawlSummaryDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl?date=2030-04-10')).body)
      .toMatchObject({ runId, inventorySummary: null, detailsAvailable: false })
  })

  it('offers exact visible scan dates for a missing year without substituting another crawl', async () => {
    ctx.db.delete(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.projectId, ctx.projectId)).run()
    seedScan('2030-04-10T09:00:00.000Z', 2, true)
    seedScan('2030-04-10T16:00:00.000Z', 3, false)
    seedScan('2031-04-10T09:00:00.000Z', 4, true)
    seedScan('2031-04-11T09:00:00.000Z', 5, false)
    seedScan('2032-04-10T09:00:00.000Z', 9, true, 'probe')
    const failed = seedScan('2033-04-10T09:00:00.000Z', 9, true)
    ctx.db.update(runs).set({ status: 'failed' }).where(eq(runs.id, failed)).run()
    const foreignProject = crypto.randomUUID()
    const project = ctx.db.select().from(projects).where(eq(projects.id, ctx.projectId)).get()!
    ctx.db.insert(projects).values({ ...project, id: foreignProject, name: 'other-site' }).run()
    const foreignRun = crypto.randomUUID()
    ctx.db.insert(runs).values({ id: foreignRun, projectId: foreignProject, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: '2040-04-10T09:00:00.000Z' }).run()
    ctx.db.insert(siteCrawlSnapshots).values({ id: crypto.randomUUID(), projectId: foreignProject, runId: foreignRun, rootUrl: 'https://other.example/', createdAt: '2040-04-10T09:00:00.000Z', updatedAt: '2040-04-10T09:00:00.000Z' }).run()
    for (const suffix of ['crawl', 'crawl/pages']) {
      const { body } = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?date=2029-04-10`)
      expect(body).toMatchObject({ hasCrawlData: false, runId: null, requestedDate: '2029-04-10', inventorySummary: null })
      expect(body.availableScanDates).toEqual({
        recentDates: ['2031-04-11', '2031-04-10', '2030-04-10'], totalDates: 3,
        matchingMonthDayDates: ['2031-04-10', '2030-04-10'], matchingMonthDayTotal: 2,
      })
      const otherDay = (await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?date=2029-04-12`)).body
      expect(otherDay.availableScanDates).toEqual({ recentDates: ['2031-04-11', '2031-04-10', '2030-04-10'], totalDates: 3, matchingMonthDayDates: [], matchingMonthDayTotal: 0 })
      const selected = (await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?date=2030-04-10`)).body
      expect(selected.hasCrawlData).toBe(true)
      expect(selected.availableScanDates).toBeUndefined()
    }
  })

  it('bounds date recovery arrays while preserving full distinct totals and an explicit empty state', async () => {
    ctx.db.delete(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.projectId, ctx.projectId)).run()
    for (const suffix of ['crawl', 'crawl/pages']) {
      const { body } = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?date=2029-04-10`)
      expect(body.availableScanDates).toEqual({ recentDates: [], totalDates: 0, matchingMonthDayDates: [], matchingMonthDayTotal: 0 })
    }
    for (let year = 2030; year <= 2041; year++) seedScan(`${year}-04-10T09:00:00.000Z`, 2, true)
    seedScan('2041-04-10T16:00:00.000Z', 3, false)
    seedScan('2041-04-11T09:00:00.000Z', 4, true)
    for (const suffix of ['crawl', 'crawl/pages']) {
      const { body } = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?date=2029-04-10`)
      expect(body.availableScanDates).toEqual({
        recentDates: ['2041-04-11', '2041-04-10', '2040-04-10', '2039-04-10', '2038-04-10', '2037-04-10', '2036-04-10', '2035-04-10', '2034-04-10', '2033-04-10'], totalDates: 13,
        matchingMonthDayDates: ['2041-04-10', '2040-04-10', '2039-04-10', '2038-04-10', '2037-04-10', '2036-04-10', '2035-04-10', '2034-04-10', '2033-04-10', '2032-04-10'], matchingMonthDayTotal: 12,
      })
    }
  })

  it.each(['2030-02-30', '2030-4-10', 'yesterday'])('rejects invalid crawl calendar date %s', async date => {
    for (const suffix of ['crawl', 'crawl/pages']) expect((await get(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?date=${date}`)).status).toBe(400)
  })

  it('rejects conflicting crawl run and date identities', async () => {
    for (const suffix of ['crawl', 'crawl/pages']) expect((await get(`/api/v1/projects/tech-aeo/technical-aeo/${suffix}?runId=${ctx.runB}&date=2030-04-10`)).status).toBe(400)
  })

  it('reports exact exclusion reasons across the selected inventory and filtered pages before paging', async () => {
    const scope = and(eq(siteCrawlPages.runId, ctx.runB), eq(siteCrawlPages.nodeKey, 'guide'))
    ctx.db.update(siteCrawlPages).set({ inventoryEligible: false, indexabilityState: 'unknown', indexabilityReasons: ['canonical-to-other'] }).where(scope).run()
    const original = ctx.db.select().from(siteCrawlPages).where(and(eq(siteCrawlPages.runId, ctx.runB), eq(siteCrawlPages.nodeKey, 'home'))).get()!
    for (const row of [
      { nodeKey: 'canonical', fetchState: 'html', indexabilityState: 'unknown', canonicalNodeKey: 'home' },
      { nodeKey: 'noindex-canonical', fetchState: 'html', indexabilityState: 'noindex', canonicalNodeKey: 'home' },
      { nodeKey: 'blocked-canonical', fetchState: 'html', indexabilityState: 'blocked', canonicalNodeKey: 'home' },
      { nodeKey: 'redirect', fetchState: 'redirect', indexabilityState: 'unknown', canonicalNodeKey: 'home' },
      { nodeKey: 'unknown', fetchState: 'html', indexabilityState: 'unknown', canonicalNodeKey: null },
      { nodeKey: 'error', fetchState: 'fetch-error', indexabilityState: 'unknown', canonicalNodeKey: null },
      { nodeKey: 'resource', fetchState: 'non-html', indexabilityState: 'unknown', canonicalNodeKey: null },
    ]) ctx.db.insert(siteCrawlPages).values({ ...original, ...row, id: crypto.randomUUID(), inventoryEligible: false, url: `https://example.com/${row.nodeKey}`, path: `/${row.nodeKey}`, indexabilityReasons: row.indexabilityState === 'noindex' ? ['meta-robots-noindex'] : row.indexabilityState === 'blocked' ? ['robots-disallow'] : [] }).run()
    const first = (await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?limit=1')).body
    expect(first.pages).toHaveLength(1)
    expect(first.total).toBe(10)
    expect(Object.fromEntries(first.healthReasonCounts!.map(row => [row.healthReason, row.pages]))).toEqual({ 'canonical-to-other': 2, 'fetch-error': 1, indexable: 1, noindex: 2, 'non-html': 1, 'redirect-terminal': 1, 'robots-disallow': 1, unknown: 1 })
    expect(first.healthReasonCounts!.reduce((sum, row) => sum + row.pages, 0)).toBe(10)
    expect(first.inventorySummary).toMatchObject({ scope: 'selected-snapshot', total: 10, eligible: 1, excluded: 9 })
    expect(first.inventorySummary!.excludedReasons.reduce((sum, row) => sum + row.pages, 0)).toBe(9)
    expect(first.inventorySummary!.excludedReasons.find(row => row.healthReason === 'canonical-to-other')).toEqual({ healthReason: 'canonical-to-other', pages: 2, exampleUrl: 'https://example.com/canonical' })
    const filtered = (await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?inventoryEligible=false&limit=1')).body
    expect(filtered.total).toBe(9)
    expect(filtered.healthReasonCounts!.reduce((sum, row) => sum + row.pages, 0)).toBe(9)
    expect(filtered.healthReasonCounts!.some(row => row.healthReason === 'indexable')).toBe(false)
    expect(filtered.inventorySummary).toEqual(first.inventorySummary)
    const noindex = (await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?indexabilityState=noindex')).body
    expect(noindex.healthReasonCounts).toEqual([{ healthReason: 'noindex', pages: 2, exampleUrl: 'https://example.com/gone' }])
    expect(noindex.pages.map(page => page.healthReason)).toEqual(['noindex', 'noindex'])
    const empty = (await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?nodeKey=not-in-this-snapshot')).body
    expect(empty).toMatchObject({ total: 0, healthReasonCounts: [], pages: [], nextCursor: null })
    expect(empty.inventorySummary).toEqual(first.inventorySummary)
    const next = (await get<SiteCrawlPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).body
    expect(next.healthReasonCounts).toEqual(first.healthReasonCounts)
    expect(next.inventorySummary).toEqual(first.inventorySummary)
    expect((await get<SiteCrawlSummaryDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl')).body.inventorySummary).toEqual(first.inventorySummary)
  })

  it('binds new crawl-page cursors to the selected run and filters while accepting legacy offsets', async () => {
    const first = (await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?limit=1')).body
    const encoded = encodeURIComponent(first.nextCursor!)
    expect((await get(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?inventoryEligible=false&cursor=${encoded}`)).status).toBe(400)
    const replacement = seedScan('2030-04-12T09:00:00.000Z', 9, true)
    const previousAttempt = ctx.db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, ctx.runB)).get()!
    const attemptId = crypto.randomUUID()
    ctx.db.insert(siteCrawlAttempts).values({ ...previousAttempt, id: attemptId, runId: replacement }).run()
    ctx.db.update(siteCrawlSnapshots).set({ attemptId, detailsAvailable: true }).where(eq(siteCrawlSnapshots.runId, replacement)).run()
    expect((await get(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?cursor=${encoded}`)).status).toBe(400)
    const legacy = Buffer.from(JSON.stringify({ offset: 1 })).toString('base64url')
    expect((await get<SiteCrawlPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?runId=${ctx.runB}&limit=1&cursor=${legacy}`)).body.pages).toHaveLength(1)
  })

  it('gives terminal redirects a concrete reason distinct from canonical or unknown indexability', async () => {
    ctx.db.update(siteCrawlPages).set({
      fetchState: 'redirect', httpStatus: 301, indexabilityState: 'unknown',
      indexabilityReasons: ['redirect-terminal'], canonicalNodeKey: 'home',
    }).where(and(eq(siteCrawlPages.runId, ctx.runB), eq(siteCrawlPages.nodeKey, 'guide'))).run()
    ctx.db.update(siteCrawlPages).set({ indexabilityState: 'unknown', indexabilityReasons: [] })
      .where(and(eq(siteCrawlPages.runId, ctx.runB), eq(siteCrawlPages.nodeKey, 'home'))).run()
    const { body } = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages')
    expect(body.pages.find(page => page.nodeKey === 'guide')).toMatchObject({
      indexabilityState: 'unknown', healthState: 'redirect', healthReason: 'redirect-terminal',
    })
    expect(body.pages.find(page => page.nodeKey === 'home')).toMatchObject({
      indexabilityState: 'unknown', healthState: 'unchecked', healthReason: 'unknown',
    })
  })
})

describe('crawl reads without a runId use the newest crawl-bearing scan date', () => {
  // The history a site larger than the page budget actually accumulates: every
  // crawl stops at the cap and lands `partial`, and the only `completed` run is
  // an older scorecard-only audit that published no crawl at all. Newer runs
  // that never published a crawl (failed, still running) and a probe must not
  // take the default either.
  const CAPPED = 'capped-site'
  const TARGET_URL = 'https://capped.example/target'

  interface CappedSite {
    projectId: string
    legacyRun: string
    olderPartial: string
    newestPartial: string
    probeRun: string
  }

  function seedCrawl(input: {
    projectId: string
    status: 'completed' | 'partial'
    trigger: 'manual' | 'scheduled' | 'probe'
    createdAt: string
    complete: boolean
    homeScore: number
    targetScore: number
    deadLinkFound?: boolean
  }): string {
    const { projectId, createdAt } = input
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runId, projectId, kind: 'site-audit', status: input.status, trigger: input.trigger, createdAt, finishedAt: createdAt,
    }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId, runId, attemptNumber: 1, state: input.status,
      pagesDiscovered: 3, pagesFetched: 2, pagesEligible: 2, edgesDiscovered: 2,
      startedAt: createdAt, finishedAt: createdAt, createdAt, updatedAt: createdAt,
    }).run()
    ctx.db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId, runId, attemptId,
      requestedRootUrl: 'https://capped.example/', rootUrl: 'https://capped.example/', crawlSchemaVersion: '1.0', engineVersion: 'crawl-test',
      normalizationVersion: 'url-v1', indexabilityVersion: 'index-v1', linkScoreVersion: 'links-v1',
      effectiveOptions: { maxPages: 2, checkDeadLinks: Boolean(input.deadLinkFound) }, pageBudget: 2,
      checkDeadLinks: Boolean(input.deadLinkFound),
      complete: input.complete, termination: input.complete ? 'complete' : 'max-pages', detailsAvailable: true,
      pagesDiscovered: 3, pagesFetched: 2, pagesEligible: 2, edgesDiscovered: 2, findingsCount: input.deadLinkFound ? 1 : 0,
      deadLinkState: input.deadLinkFound ? 'partial' : 'disabled',
      deadLinksChecked: input.deadLinkFound ? 1 : 0, deadLinksFound: input.deadLinkFound ? 1 : 0, deadLinksUnverified: 0,
      createdAt, updatedAt: createdAt,
    }).run()
    // A real crawl derives the node key from the normalized URL, so the same
    // page keeps its key across scans; only the score tells the scans apart.
    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey: 'home',
        url: 'https://capped.example/', finalUrl: 'https://capped.example/', path: '/', parentPath: '/', discoverySource: 'sitemap',
        fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: input.homeScore,
        auditFields: { schemaVersion: '1.0', factors: [], criticalDefects: [] },
        inventoryEligible: true, depth: 0, outboundUniqueEdges: 2, createdAt, updatedAt: createdAt,
      },
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey: 'target',
        url: TARGET_URL, finalUrl: TARGET_URL, path: '/target', parentPath: '/', discoverySource: 'link',
        fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: input.targetScore,
        auditFields: {
          schemaVersion: '1.0',
          factors: [{
            id: 'content-depth', name: 'Content Depth', weight: 12, score: input.targetScore, status: 'partial', applicable: true,
            findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'Low content depth.' }],
            recommendations: ['Expand the page.'],
          }],
          criticalDefects: [],
        },
        inventoryEligible: true, depth: 1, inboundUniqueEdges: 1, createdAt, updatedAt: createdAt,
      },
    ]).run()
    ctx.db.insert(siteCrawlEdges).values([
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: 'home-target',
        sourceNodeKey: 'home', sourceUrl: 'https://capped.example/', targetNodeKey: 'target', targetUrl: TARGET_URL,
        relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: ['Target'], isTemplate: false, createdAt, updatedAt: createdAt,
      },
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: 'home-missing',
        sourceNodeKey: 'home', sourceUrl: 'https://capped.example/', targetNodeKey: null, targetUrl: 'https://capped.example/missing',
        relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: ['Missing'], isTemplate: false, createdAt, updatedAt: createdAt,
      },
    ]).run()
    if (input.deadLinkFound) {
      ctx.db.insert(siteCrawlFindings).values({
        id: crypto.randomUUID(), projectId, runId, attemptId, findingKey: 'dead:missing', findingType: 'dead-link', severity: 'error',
        sourceNodeKey: 'home', sourceUrl: 'https://capped.example/', targetNodeKey: null, targetUrl: 'https://capped.example/missing',
        evidence: { statusCode: 404, reason: 'http-error' }, createdAt, updatedAt: createdAt,
      }).run()
    }
    // A run that audited at least one page also publishes the scorecard.
    ctx.db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId, runId, sitemapUrl: 'https://capped.example/sitemap.xml', auditedAt: createdAt,
      aggregateScore: input.targetScore, aggregateGrade: 'C', pagesDiscovered: 3, pagesAudited: 2, pagesSkipped: 1, pagesErrored: 0,
      factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt,
    }).run()
    return runId
  }

  function seedCappedSite(): CappedSite {
    const base = Date.parse('2026-08-20T12:00:00.000Z')
    const at = (offsetSeconds: number) => new Date(base + offsetSeconds * 1000).toISOString()
    const projectId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: projectId, name: CAPPED, displayName: 'Capped', canonicalDomain: 'capped.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: at(-500), updatedAt: at(-500),
    }).run()

    const legacyRun = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: legacyRun, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: at(-86_400), finishedAt: at(-86_400),
    }).run()
    ctx.db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId, runId: legacyRun, sitemapUrl: 'https://capped.example/sitemap.xml', auditedAt: at(-86_400),
      aggregateScore: 55, aggregateGrade: 'D', pagesDiscovered: 2, pagesAudited: 2, pagesSkipped: 0, pagesErrored: 0,
      factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: at(-86_400),
    }).run()

    const olderPartial = seedCrawl({
      projectId, status: 'partial', trigger: 'scheduled', createdAt: at(-300), complete: false, homeScore: 50, targetScore: 31,
    })
    const newestPartial = seedCrawl({
      projectId, status: 'partial', trigger: 'scheduled', createdAt: at(-200), complete: false, homeScore: 90, targetScore: 77,
      deadLinkFound: true,
    })

    // Newer runs that never published a crawl: one failed, one still running.
    ctx.db.insert(runs).values({
      id: crypto.randomUUID(), projectId, kind: 'site-audit', status: 'failed', trigger: 'scheduled', createdAt: at(-100), finishedAt: at(-100),
    }).run()
    const runningRun = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: runningRun, projectId, kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: at(-50),
    }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: crypto.randomUUID(), projectId, runId: runningRun, attemptNumber: 1, state: 'running',
      pagesDiscovered: 1, pagesFetched: 1, startedAt: at(-50), createdAt: at(-50), updatedAt: at(-50),
    }).run()

    // Newest of all, and complete, but a probe: it must never become current.
    const probeRun = seedCrawl({
      projectId, status: 'completed', trigger: 'probe', createdAt: at(0), complete: true, homeScore: 1, targetScore: 2,
    })

    return { projectId, legacyRun, olderPartial, newestPartial, probeRun }
  }

  it('audits a page from the newest page-capped crawl instead of answering no-crawl', async () => {
    const site = seedCappedSite()
    const { status, body } = await get<SiteCrawlPageAuditDto>(
      `/api/v1/projects/${CAPPED}/technical-aeo/crawl/pages/audit?url=${encodeURIComponent(TARGET_URL)}`,
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({
      state: 'ready',
      project: CAPPED,
      runId: site.newestPartial,
      complete: false,
      termination: 'max-pages',
      nodeKey: 'target',
      url: TARGET_URL,
      auditScore: 77,
      factors: [{ id: 'content-depth', score: 77 }],
    })

    // An explicit run still pins the read to that run.
    const pinned = await get<SiteCrawlPageAuditDto>(
      `/api/v1/projects/${CAPPED}/technical-aeo/crawl/pages/audit?runId=${site.olderPartial}&nodeKey=target`,
    )
    expect(pinned.body).toMatchObject({ state: 'ready', runId: site.olderPartial, auditScore: 31 })
  })

  it('resolves every crawl-scoped read to that same scan', async () => {
    const site = seedCappedSite()
    const base = `/api/v1/projects/${CAPPED}/technical-aeo`

    const crawl = await get<SiteCrawlSummaryDto>(`${base}/crawl`)
    expect(crawl.body).toMatchObject({
      hasCrawlData: true,
      legacyAuditAvailable: true,
      runId: site.newestPartial,
      runStatus: 'partial',
      complete: false,
      termination: 'max-pages',
      counts: { pagesDiscovered: 3, pagesFetched: 2, pagesEligible: 2, edges: 2, findings: 1 },
    })

    const pages = await get<SiteCrawlPagesResponseDto>(`${base}/crawl/pages?sort=path`)
    expect(pages.body).toMatchObject({ hasCrawlData: true, runId: site.newestPartial, complete: false, termination: 'max-pages', total: 2 })
    expect(pages.body.pages.map((page) => [page.nodeKey, page.auditScore])).toEqual([['home', 90], ['target', 77]])

    const graph = await get<SiteCrawlGraphResponseDto>(`${base}/graph`)
    expect(graph.body).toMatchObject({ hasCrawlData: true, runId: site.newestPartial, complete: false, termination: 'max-pages', rootNodeKey: 'home' })

    const subgraph = await get<SiteHealthSubgraphResponseDto>(`${base}/subgraph`)
    expect(subgraph.body).toMatchObject({
      state: 'ready', runId: site.newestPartial, complete: false, termination: 'max-pages', focusNodeKey: 'home',
    })

    const path = await get<SiteHealthPathResponseDto>(`${base}/path?toUrl=${encodeURIComponent(TARGET_URL)}`)
    expect(path.body).toMatchObject({ state: 'found', runId: site.newestPartial, complete: false })

    const structure = await get<SiteCrawlStructureResponseDto>(`${base}/structure`)
    expect(structure.body).toMatchObject({ hasCrawlData: true, runId: site.newestPartial, complete: false, termination: 'max-pages' })
    expect(structure.body.children.map((child) => child.path)).toEqual(['/target'])

    const links = await get<SiteCrawlInternalLinksResponseDto>(`${base}/internal-links`)
    expect(links.body).toMatchObject({ hasCrawlData: true, runId: site.newestPartial, complete: false, termination: 'max-pages', total: 2 })

    const neighbors = await get<SiteCrawlNeighborsResponseDto>(`${base}/internal-links/neighbors?nodeKey=target`)
    expect(neighbors.body).toMatchObject({ hasCrawlData: true, runId: site.newestPartial, complete: false, termination: 'max-pages' })
    expect(neighbors.body.inbound.map((edge) => edge.edgeKey)).toEqual(['home-target'])

    const deadLinks = await get<SiteCrawlDeadLinksResponseDto>(`${base}/dead-links`)
    expect(deadLinks.body).toMatchObject({ runId: site.newestPartial, state: 'partial', checked: 1, found: 1, total: 1 })

    // The scorecard already defaulted to the newest scan that published one;
    // the crawl reads now agree with it, so Aero can pair the two.
    const score = await get<SiteAuditScoreDto>(base)
    expect(score.body).toMatchObject({ hasData: true, runId: site.newestPartial, aggregateScore: 77 })

    for (const runId of [crawl.body.runId, pages.body.runId, graph.body.runId, subgraph.body.runId, path.body.runId]) {
      expect(runId).not.toBe(site.probeRun)
    }
  })

  it('marks an empty neighbor list from a capped crawl as partial, not as a site-wide absence', async () => {
    // An older complete crawl saw `docs -> home`; the newer capped one stopped
    // before reaching `docs`, so it observed no inbound link to home at all.
    const base = Date.parse('2026-08-20T12:00:00.000Z')
    const projectId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: projectId, name: CAPPED, displayName: 'Capped', canonicalDomain: 'capped.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: new Date(base - 500_000).toISOString(),
      updatedAt: new Date(base - 500_000).toISOString(),
    }).run()
    const olderComplete = seedCrawl({
      projectId, status: 'completed', trigger: 'scheduled', createdAt: new Date(base - 86_400_000).toISOString(),
      complete: true, homeScore: 80, targetScore: 70,
    })
    const docsAttempt = ctx.db.select({ attemptId: siteCrawlSnapshots.attemptId }).from(siteCrawlSnapshots)
      .where(eq(siteCrawlSnapshots.runId, olderComplete)).get()!.attemptId!
    const at = new Date(base - 300_000).toISOString()
    ctx.db.insert(siteCrawlEdges).values({
      id: crypto.randomUUID(), projectId, runId: olderComplete, attemptId: docsAttempt, edgeKey: 'docs-home',
      sourceNodeKey: 'docs', sourceUrl: 'https://capped.example/docs', targetNodeKey: 'home', targetUrl: 'https://capped.example/',
      relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
      anchors: ['Home'], isTemplate: false, createdAt: at, updatedAt: at,
    }).run()
    const newerCapped = seedCrawl({
      projectId, status: 'partial', trigger: 'scheduled', createdAt: new Date(base - 100_000).toISOString(),
      complete: false, homeScore: 90, targetScore: 77,
    })

    const current = await get<SiteCrawlNeighborsResponseDto>(`/api/v1/projects/${CAPPED}/technical-aeo/internal-links/neighbors?nodeKey=home`)
    expect(current.body).toMatchObject({
      runId: newerCapped, complete: false, termination: 'max-pages', inbound: [], inboundTruncated: false,
    })

    const pinned = await get<SiteCrawlNeighborsResponseDto>(
      `/api/v1/projects/${CAPPED}/technical-aeo/internal-links/neighbors?runId=${olderComplete}&nodeKey=home`,
    )
    expect(pinned.body).toMatchObject({ runId: olderComplete, complete: true, termination: 'complete' })
    expect(pinned.body.inbound.map((edge) => edge.edgeKey)).toEqual(['docs-home'])
  })

  it('says a page-capped history is not comparable instead of claiming no crawl exists', async () => {
    const site = seedCappedSite()
    const { status, body } = await get<SiteHealthChangesResponseDto>(`/api/v1/projects/${CAPPED}/technical-aeo/changes`)
    expect(status).toBe(200)
    expect(body).toEqual({
      project: CAPPED,
      state: 'unavailable',
      reason: 'partial-not-comparable',
      fromRunId: null,
      toRunId: site.newestPartial,
    })
  })

  it('still answers no-crawl when no scan ever published a crawl', async () => {
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: projectId, name: 'scorecard-only', displayName: 'Scorecard only', canonicalDomain: 'scorecard.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    const runId = crypto.randomUUID()
    ctx.db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now, finishedAt: now }).run()
    ctx.db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId, runId, sitemapUrl: 'https://scorecard.example/sitemap.xml', auditedAt: now,
      aggregateScore: 60, aggregateGrade: 'D-', pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, pagesErrored: 0,
      factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: now,
    }).run()

    const base = '/api/v1/projects/scorecard-only/technical-aeo'
    expect((await get<SiteCrawlPageAuditDto>(`${base}/crawl/pages/audit?nodeKey=home`)).body)
      .toEqual({ state: 'no-crawl', project: 'scorecard-only', runId: null })
    expect((await get<SiteCrawlSummaryDto>(`${base}/crawl`)).body).toMatchObject({ hasCrawlData: false, runId: null })
    for (const read of ['crawl/pages', 'graph', 'structure', 'internal-links', 'internal-links/neighbors?nodeKey=home']) {
      expect((await get<{ hasCrawlData: boolean; complete: boolean; termination: string | null }>(`${base}/${read}`)).body, read)
        .toMatchObject({ hasCrawlData: false, complete: false, termination: null })
    }
    expect((await get<SiteHealthChangesResponseDto>(`${base}/changes`)).body).toMatchObject({
      state: 'unavailable', reason: 'no-crawl', fromRunId: null, toRunId: null,
    })
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
