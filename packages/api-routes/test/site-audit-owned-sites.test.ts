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
  siteCrawlAttempts,
  siteCrawlPages,
  siteCrawlRunRequests,
  siteCrawlSnapshots,
} from '@canonry/canonry-db'
import type {
  ProjectDto,
  SiteAuditIssuePagesResponseDto,
  SiteAuditIssuesResponseDto,
  SiteAuditScoreDto,
  SiteCrawlPagesResponseDto,
  SiteCrawlSiteDto,
  SiteCrawlStructureResponseDto,
  SiteCrawlSummaryDto,
} from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'

// A project whose property pages live on a second host it owns. The scan
// covered both; every read can be limited to one site, and a site the scan
// did not cover is an error that names the ones it did.

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  requested: Array<{ runId: string; opts?: { sites?: string[]; maxPages?: number } }>
}

const SITES: SiteCrawlSiteDto[] = [
  { host: 'example.com', main: true, rootUrl: 'https://www.example.com/', pages: 3, pagesEligible: 3, pagesAudited: 3, aggregateScore: 80, error: null },
  { host: 'apartments.example.com', main: false, rootUrl: 'https://apartments.example.com/', pages: 3, pagesEligible: 3, pagesAudited: 3, aggregateScore: 50, error: null },
]

function namesAnotherEntity(question: string) {
  return {
    schemaVersion: '1.0',
    factors: [],
    criticalDefects: [{
      id: 'names-another-entity', severity: 'critical',
      detail: 'The FAQ names Westshore, another Property.',
      recommendation: 'Name only this Property in its FAQ, title and H1.',
      evidence: [{ field: 'faq-answer', question, entityKey: 'westshore', entityName: 'Westshore', snippet: 'Residents of Westshore ride free.' }],
    }],
  }
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-owned-sites-api-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  const requested: Ctx['requested'] = []
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onSiteAuditRequested: (runId, _projectId, opts) => { requested.push({ runId, opts }) },
  })
  const now = new Date(Date.now() - 60_000).toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'portfolio', displayName: 'Portfolio', canonicalDomain: 'example.com',
    ownedDomains: ['apartments.example.com', 'https://www.example.org/'],
    country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
  }).run()
  return { app, db, tmpDir, projectId, requested }
}

/** One published scan. `sites` null is a scan made before scans recorded their sites. */
function seedScan(ctx: Ctx, options: { sites: SiteCrawlSiteDto[] | null; createdAt?: string; aggregateScore?: number; detailsAvailable?: boolean }): string {
  const { db, projectId } = ctx
  const createdAt = options.createdAt ?? new Date(Date.now() - 30_000).toISOString()
  const runId = crypto.randomUUID()
  db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt, finishedAt: createdAt }).run()
  const attemptId = crypto.randomUUID()
  db.insert(siteCrawlAttempts).values({
    id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed', startedAt: createdAt, finishedAt: createdAt, createdAt, updatedAt: createdAt,
  }).run()
  db.insert(siteCrawlSnapshots).values({
    id: crypto.randomUUID(), projectId, runId, attemptId, requestedRootUrl: 'https://example.com/', rootUrl: 'https://www.example.com/',
    complete: true, termination: 'complete', detailsAvailable: options.detailsAvailable ?? true, pagesDiscovered: 6, pagesFetched: 6, pagesEligible: 6,
    sites: options.sites, createdAt, updatedAt: createdAt,
  }).run()
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId, sitemapUrl: 'https://www.example.com/sitemap.xml', auditedAt: createdAt,
    aggregateScore: options.aggregateScore ?? 65, pagesDiscovered: 6, pagesAudited: 6, pagesSkipped: 0, pagesErrored: 0,
    factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt,
  }).run()
  const extra = options.sites ? 'apartments.example.com' : null
  const row = (nodeKey: string, url: string, site: string | null, pagePath: string, parentPath: string, score: number, auditFields: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey, url, site, path: pagePath, parentPath,
    fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', healthState: 'eligible', auditState: 'success', auditScore: score,
    auditFields, inventoryEligible: true, depth: 1, createdAt, updatedAt: createdAt,
  })
  db.insert(siteCrawlPages).values([
    row('main:root', 'https://www.example.com/', null, '/', '/', 90),
    row('main:about', 'https://www.example.com/about', null, '/about', '/', 80),
    row('main:news', 'https://www.example.com/news/first', null, '/news/first', '/news', 70, namesAnotherEntity('Is there parking?')),
    // A scan that recorded no sites never crawled another host; these rows
    // exist only in the two-site scan.
    ...(extra ? [
      row('loc:root', 'https://apartments.example.com/', extra, '/', '/', 60),
      row('loc:ridge', 'https://apartments.example.com/ridge/', extra, '/ridge/', '/', 41, namesAnotherEntity('Is there a shuttle?')),
      row('loc:ridge-floor', 'https://apartments.example.com/ridge/floor-plans', extra, '/ridge/floor-plans', '/ridge', 49),
    ] : []),
  ]).run()
  return runId
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

async function patchProject(payload: Record<string, unknown>) {
  const res = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/projects/portfolio', payload })
  return { status: res.statusCode, body: res.json() as ProjectDto & { error?: { message: string } } }
}

describe('saved sites (siteAuditDomains)', () => {
  it('stores owned domains as bare hosts, drops the main domain, and refuses a domain the project does not own', async () => {
    const saved = await patchProject({ siteAuditDomains: ['https://Apartments.Example.com/', 'www.example.com', 'example.org'] })
    expect(saved.status).toBe(200)
    expect(saved.body.siteAuditDomains).toEqual(['apartments.example.com', 'example.org'])

    const refused = await patchProject({ siteAuditDomains: ['apartments.example.com', 'rival.com', 'not a domain'] })
    expect(refused.status).toBe(400)
    expect(refused.body.error?.message).toBe('Rejected siteAuditDomains: "not a domain" is not a domain. rival.com is not one of this project\'s owned domains; add it under owned domains first.')
    expect((await get<ProjectDto>('/api/v1/projects/portfolio')).body.siteAuditDomains).toEqual(['apartments.example.com', 'example.org'])

    // Adding the domain to owned domains in the same write is enough.
    expect((await patchProject({ ownedDomains: ['apartments.example.com', 'example.org', 'rival.com'], siteAuditDomains: ['rival.com'] })).body.siteAuditDomains)
      .toEqual(['rival.com'])
  })

  it('drops a saved site when the project stops owning it, and exports and re-applies the list', async () => {
    await patchProject({ siteAuditDomains: ['apartments.example.com', 'example.org'] })
    const narrowed = await patchProject({ ownedDomains: ['apartments.example.com'] })
    expect(narrowed.body.siteAuditDomains).toEqual(['apartments.example.com'])

    const exported = await get<{ spec: Record<string, unknown> }>('/api/v1/projects/portfolio/export')
    expect(exported.body.spec.siteAuditDomains).toEqual(['apartments.example.com'])

    // An apply that omits it keeps the stored list; one that names it sets it.
    const spec = { ...exported.body.spec }
    delete spec.siteAuditDomains
    const kept = await ctx.app.inject({ method: 'POST', url: '/api/v1/apply', payload: { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'portfolio' }, spec } })
    expect(kept.statusCode).toBe(200)
    expect((kept.json() as ProjectDto).siteAuditDomains).toEqual(['apartments.example.com'])
    const cleared = await ctx.app.inject({ method: 'POST', url: '/api/v1/apply', payload: { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'portfolio' }, spec: { ...spec, siteAuditDomains: [] } } })
    expect((cleared.json() as ProjectDto).siteAuditDomains).toEqual([])
    const refused = await ctx.app.inject({ method: 'POST', url: '/api/v1/apply', payload: { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'portfolio' }, spec: { ...spec, siteAuditDomains: ['rival.com'] } } })
    expect(refused.statusCode).toBe(400)
  })
})

describe('POST /agent-readiness/runs with sites', () => {
  async function run(payload: Record<string, unknown>) {
    return ctx.app.inject({ method: 'POST', url: '/api/v1/projects/portfolio/agent-readiness/runs', payload })
  }
  const effectiveOptions = (runId: string) => ctx.db.select().from(siteCrawlRunRequests).where(eq(siteCrawlRunRequests.runId, runId)).get()!.effectiveOptions

  it('scans the saved sites by default, the named ones when given, and the main domain only for []', async () => {
    await patchProject({ siteAuditDomains: ['apartments.example.com'] })
    const saved = await run({})
    expect(saved.statusCode).toBe(200)
    const savedRun = (saved.json() as { runId: string }).runId
    expect(effectiveOptions(savedRun).sites).toEqual(['apartments.example.com'])
    expect(ctx.requested.at(-1)?.opts?.sites).toEqual(['apartments.example.com'])
    // Same sites, same scan: the in-flight run is returned. Other sites are refused while it runs.
    expect((await run({ sites: ['example.com', 'apartments.example.com'] })).json()).toMatchObject({ runId: savedRun })
    expect((await run({ sites: [] })).statusCode).toBe(409)

    ctx.db.update(runs).set({ status: 'completed' }).where(eq(runs.id, savedRun)).run()
    const mainOnly = await run({ sites: [] })
    expect(effectiveOptions((mainOnly.json() as { runId: string }).runId).sites).toEqual([])
  })

  it('refuses more than 20 sites besides the main domain', async () => {
    const owned = Array.from({ length: 21 }, (_, index) => `site${index}.example.com`)
    await patchProject({ ownedDomains: owned })
    const res = await run({ sites: owned })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { message: string } }).error.message)
      .toBe('A scan covers at most 20 sites besides the main domain; sites names 21.')
    // Naming the main domain as well is allowed: it is always scanned.
    expect((await run({ sites: ['example.com', ...owned.slice(0, 20)] })).statusCode).toBe(200)
  })

  it('refuses a site that is not one of the project\'s owned domains', async () => {
    const res = await run({ sites: ['rival.com'] })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { message: string } }).error.message)
      .toBe('Rejected sites: rival.com is not one of this project\'s owned domains; add it under owned domains first.')
    expect(ctx.requested).toHaveLength(0)
  })
})

describe('reads of a scan that covered two sites', () => {
  it('reports each site on the summary and each site\'s score beside the headline', async () => {
    seedScan(ctx, { sites: SITES })
    const crawl = await get<SiteCrawlSummaryDto>('/api/v1/projects/portfolio/agent-readiness/crawl')
    expect(crawl.body.sites).toEqual(SITES)
    const score = await get<SiteAuditScoreDto>('/api/v1/projects/portfolio/agent-readiness')
    expect(score.body.aggregateScore).toBe(65)
    expect(score.body.sites).toEqual([
      { host: 'example.com', main: true, aggregateScore: 80, pagesAudited: 3 },
      { host: 'apartments.example.com', main: false, aggregateScore: 50, pagesAudited: 3 },
    ])
  })

  it('limits pages to one site, names each page\'s site, and refuses a site the scan did not cover', async () => {
    seedScan(ctx, { sites: SITES })
    const all = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/portfolio/agent-readiness/crawl/pages')
    expect(all.body.total).toBe(6)
    expect(all.body.site).toBeNull()
    expect(new Set(all.body.pages.map((page) => page.site))).toEqual(new Set(['example.com', 'apartments.example.com']))

    const locator = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/portfolio/agent-readiness/crawl/pages?site=apartments.example.com&sort=path')
    expect(locator.body.site).toBe('apartments.example.com')
    expect(locator.body.pages.map((page) => [page.site, page.path])).toEqual([
      ['apartments.example.com', '/'], ['apartments.example.com', '/ridge/'], ['apartments.example.com', '/ridge/floor-plans'],
    ])
    // Any form of the main domain reads the main site's rows.
    const main = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/portfolio/agent-readiness/crawl/pages?site=https://www.example.com/')
    expect(main.body.site).toBe('example.com')
    expect(main.body.pages.map((page) => page.nodeKey).sort()).toEqual(['main:about', 'main:news', 'main:root'])

    // A cursor belongs to its site filter.
    const firstPage = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/portfolio/agent-readiness/crawl/pages?site=apartments.example.com&limit=1')
    expect(firstPage.body.nextCursor).not.toBeNull()
    expect((await get(`/api/v1/projects/portfolio/agent-readiness/crawl/pages?limit=1&cursor=${firstPage.body.nextCursor}`)).status).toBe(400)

    const other = await get<{ error: { message: string } }>('/api/v1/projects/portfolio/agent-readiness/crawl/pages?site=example.org')
    expect(other.status).toBe(400)
    expect(other.body.error.message).toBe('This scan did not cover example.org. It covered example.com, apartments.example.com.')
  })

  it('lists one site\'s folders at a time, the main domain by default', async () => {
    seedScan(ctx, { sites: SITES })
    const main = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/portfolio/agent-readiness/structure')
    expect(main.body.site).toBe('example.com')
    expect(main.body.children.map((child) => [child.path, child.pageCount])).toEqual([['/about', 1], ['/news', 1]])
    const locator = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/portfolio/agent-readiness/structure?site=apartments.example.com')
    expect(locator.body.site).toBe('apartments.example.com')
    expect(locator.body.children.map((child) => [child.path, child.pageCount])).toEqual([['/ridge', 2]])
  })

  it('limits issues and their pages to one site', async () => {
    seedScan(ctx, { sites: SITES })
    const issueId = (await get<SiteAuditIssuesResponseDto>('/api/v1/projects/portfolio/agent-readiness/issues')).body
      .issues.find((issue) => issue.code === 'names-another-entity')!.id
    const all = await get<SiteAuditIssuePagesResponseDto>(`/api/v1/projects/portfolio/agent-readiness/issues/${issueId}/pages`)
    expect(all.body.pages.map((page) => page.url)).toEqual(['https://apartments.example.com/ridge/', 'https://www.example.com/news/first'])

    const locator = await get<SiteAuditIssuesResponseDto>('/api/v1/projects/portfolio/agent-readiness/issues?site=apartments.example.com')
    expect(locator.body.site).toBe('apartments.example.com')
    expect(locator.body.coverage.auditedPages).toBe(3)
    expect(locator.body.issues.find((issue) => issue.code === 'names-another-entity')?.affectedPages).toBe(1)
    const pages = await get<SiteAuditIssuePagesResponseDto>(`/api/v1/projects/portfolio/agent-readiness/issues/${issueId}/pages?site=apartments.example.com`)
    expect(pages.body.pages.map((page) => page.url)).toEqual(['https://apartments.example.com/ridge/'])
    expect((await get(`/api/v1/projects/portfolio/agent-readiness/issues?site=example.org`)).status).toBe(400)
  })
})

describe('the score change between scans', () => {
  const MAIN_ONLY: SiteCrawlSiteDto[] = [SITES[0]!]
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

  it('is not claimed when the previous scan scored other sites', async () => {
    seedScan(ctx, { sites: MAIN_ONLY, aggregateScore: 80, createdAt: minutesAgo(30) })
    seedScan(ctx, { sites: SITES, aggregateScore: 65, createdAt: minutesAgo(10) })
    const score = (await get<SiteAuditScoreDto>('/api/v1/projects/portfolio/agent-readiness')).body
    expect(score).toMatchObject({ aggregateScore: 65, previousScore: 80, deltaScore: null, trend: null, deltaUnavailableReason: 'sites-changed' })
  })

  it('is claimed between scans of the same sites, including a scan from before sites were recorded', async () => {
    // Before this change a scan recorded no sites: it scored the main domain only.
    seedScan(ctx, { sites: null, aggregateScore: 70, createdAt: minutesAgo(30) })
    seedScan(ctx, { sites: MAIN_ONLY, aggregateScore: 75, createdAt: minutesAgo(10) })
    const score = (await get<SiteAuditScoreDto>('/api/v1/projects/portfolio/agent-readiness')).body
    expect(score).toMatchObject({ aggregateScore: 75, previousScore: 70, deltaScore: 5, trend: 'up' })
    expect(score).not.toHaveProperty('deltaUnavailableReason')
  })

  it('is not claimed when a site could not be reached this time', async () => {
    seedScan(ctx, { sites: SITES, aggregateScore: 65, createdAt: minutesAgo(30) })
    const unreached = { ...SITES[1]!, rootUrl: null, pages: 0, pagesEligible: 0, pagesAudited: 0, aggregateScore: null, error: 'Site audit root URL rejected' }
    seedScan(ctx, { sites: [SITES[0]!, unreached], aggregateScore: 80, createdAt: minutesAgo(10) })
    expect((await get<SiteAuditScoreDto>('/api/v1/projects/portfolio/agent-readiness')).body)
      .toMatchObject({ deltaScore: null, deltaUnavailableReason: 'sites-changed' })
  })
})

describe('reads of a scan without page details', () => {
  it('still refuses a site the scan did not cover', async () => {
    seedScan(ctx, { sites: SITES, detailsAvailable: false })
    const other = await get<{ error: { message: string } }>('/api/v1/projects/portfolio/agent-readiness/crawl/pages?site=example.org')
    expect(other.status).toBe(400)
    expect(other.body.error.message).toBe('This scan did not cover example.org. It covered example.com, apartments.example.com.')
    const covered = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/portfolio/agent-readiness/crawl/pages?site=apartments.example.com')
    expect(covered.body).toMatchObject({ total: 0, site: 'apartments.example.com', inventorySummary: null })
  })
})

describe('reads of a scan made before scans recorded their sites', () => {
  it('reads as the main domain alone: no sites list, and the main domain is the only site filter', async () => {
    seedScan(ctx, { sites: null })
    const crawl = await get<SiteCrawlSummaryDto>('/api/v1/projects/portfolio/agent-readiness/crawl')
    expect(crawl.body).not.toHaveProperty('sites')
    expect((await get<SiteAuditScoreDto>('/api/v1/projects/portfolio/agent-readiness')).body).not.toHaveProperty('sites')

    const main = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/portfolio/agent-readiness/crawl/pages?site=example.com')
    expect(main.body.total).toBe(3)
    expect(main.body.pages.every((page) => page.site === 'example.com')).toBe(true)
    expect((await get<SiteCrawlStructureResponseDto>('/api/v1/projects/portfolio/agent-readiness/structure')).body.site).toBe('example.com')
    expect((await get('/api/v1/projects/portfolio/agent-readiness/crawl/pages?site=apartments.example.com')).status).toBe(400)
  })
})
