import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteAuditSnapshots,
  siteAuditPages,
} from '@ainyc/canonry-db'
import type {
  SiteAuditFactorSummaryDto,
  SiteAuditPagesResponseDto,
  SiteAuditScoreDto,
  SiteAuditTrendResponseDto,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  runA: string
  runB: string
  probeRun: string
  siteAuditRequested: Array<{ runId: string; projectId: string; opts?: { sitemapUrl?: string; limit?: number } }>
}

const FACTORS_B: SiteAuditFactorSummaryDto[] = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, avgScore: 80, avgGrade: 'B-', status: 'pass', pagesPassing: 2, pagesPartial: 0, pagesFailing: 0 },
  { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, avgScore: 30, avgGrade: 'F', status: 'fail', pagesPassing: 0, pagesPartial: 0, pagesFailing: 2 },
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

  // Run B — newer real audit, score 72 (+12 vs A → trend up). This is the surfaceable latest.
  const runB = seedRun('completed', 'manual', tB)
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: runB,
    sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: tB,
    aggregateScore: 72, aggregateGrade: 'C-', pagesDiscovered: 3, pagesAudited: 2, pagesSkipped: 1, pagesErrored: 1,
    factorAverages: FACTORS_B,
    crossCuttingIssues: [{ factorId: 'ai-crawler-access', factorName: 'AI Crawler Access', avgScore: 30, avgGrade: 'F', affectedPages: 2, totalPages: 2, topRecommendations: ['Allow GPTBot in robots.txt'] }],
    prioritizedFixes: ['AI Crawler Access (avg F, affects 100% of pages): Allow GPTBot in robots.txt'],
    createdAt: tB,
  }).run()
  db.insert(siteAuditPages).values([
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/good', overallScore: 80, overallGrade: 'B-', status: 'success', error: null, factors: [], createdAt: tB },
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/weak', overallScore: 30, overallGrade: 'F', status: 'success', error: null, factors: [], createdAt: tB },
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/dead', overallScore: 0, overallGrade: 'F', status: 'error', error: 'TIMEOUT', factors: [], createdAt: tB },
  ]).run()

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
})

describe('GET /technical-aeo/trend', () => {
  it('returns oldest-first points excluding the probe', async () => {
    const { body } = await get<SiteAuditTrendResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/trend')
    expect(body.points.map((p) => p.aggregateScore)).toEqual([60, 72])
    expect(body.points.every((p) => p.runId !== ctx.probeRun)).toBe(true)
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
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    const firstId = (first.json() as { runId: string }).runId
    const second = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    const secondId = (second.json() as { runId: string }).runId
    expect(secondId).toBe(firstId)
    // Only one callback fired (the second was a no-op dedupe).
    expect(ctx.siteAuditRequested).toHaveLength(1)
  })

  it('rejects an invalid limit over the cap', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { limit: 99999 } })
    expect(res.statusCode).toBe(400)
  })
})
