import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, runs, siteAuditSnapshots, siteAuditPages } from '@ainyc/canonry-db'

// Mock the audit engine so the executor test is pure (no network).
vi.mock('@ainyc/aeo-audit', () => ({ runSitemapAudit: vi.fn() }))
import { runSitemapAudit } from '@ainyc/aeo-audit'
import { clampSiteAuditLimit, computeFactorAverages, executeSiteAudit, SITE_AUDIT_DEFAULT_PAGE_LIMIT, SITE_AUDIT_MAX_PAGE_LIMIT } from '../src/execute-site-audit.js'

function scoredFactor(id: string, name: string, weight: number, score: number) {
  return { id, name, weight, score, findings: [], recommendations: [] }
}

describe('computeFactorAverages', () => {
  it('averages each factor across successful pages and the pass/partial/fail counts sum to the success-page count', () => {
    const pages = [
      { url: 'a', overallScore: 70, overallGrade: 'C-', status: 'success' as const, factors: [scoredFactor('sd', 'Structured Data', 12, 90), scoredFactor('ai', 'AI Crawler', 4, 80)] },
      { url: 'b', overallScore: 40, overallGrade: 'F', status: 'success' as const, factors: [scoredFactor('sd', 'Structured Data', 12, 50), scoredFactor('ai', 'AI Crawler', 4, 30)] },
      { url: 'c', overallScore: 0, overallGrade: 'F', status: 'error' as const, error: 'TIMEOUT' },
    ]
    const summaries = computeFactorAverages(pages as never)
    // Heaviest factor first.
    expect(summaries.map((s) => s.id)).toEqual(['sd', 'ai'])

    const sd = summaries.find((s) => s.id === 'sd')!
    expect(sd.avgScore).toBe(70)            // (90 + 50) / 2
    expect(sd.status).toBe('pass')          // 70 ≥ 70
    expect(sd.pagesPassing).toBe(1)         // 90
    expect(sd.pagesPartial).toBe(1)         // 50
    expect(sd.pagesFailing).toBe(0)
    expect(sd.pagesPassing + sd.pagesPartial + sd.pagesFailing).toBe(2) // success pages only

    const ai = summaries.find((s) => s.id === 'ai')!
    expect(ai.avgScore).toBe(55)            // (80 + 30) / 2
    expect(ai.status).toBe('partial')       // 40–69
    expect(ai.pagesPassing).toBe(1)         // 80
    expect(ai.pagesFailing).toBe(1)         // 30
  })

  it('rounds averages and excludes error pages from the denominator', () => {
    const pages = [
      { url: 'a', overallScore: 0, overallGrade: 'F', status: 'success' as const, factors: [scoredFactor('x', 'X', 10, 33)] },
      { url: 'b', overallScore: 0, overallGrade: 'F', status: 'success' as const, factors: [scoredFactor('x', 'X', 10, 34)] },
      { url: 'c', overallScore: 0, overallGrade: 'F', status: 'error' as const, error: 'boom' },
    ]
    const [x] = computeFactorAverages(pages as never)
    expect(x!.avgScore).toBe(34)            // round((33 + 34) / 2) = round(33.5) = 34
    expect(x!.pagesPassing + x!.pagesPartial + x!.pagesFailing).toBe(2)
  })

  it('returns [] when there are no successful pages', () => {
    expect(computeFactorAverages([{ url: 'c', overallScore: 0, overallGrade: 'F', status: 'error' as const }] as never)).toEqual([])
  })
})

describe('clampSiteAuditLimit', () => {
  it('defaults when undefined and clamps to [1, max]', () => {
    expect(clampSiteAuditLimit(undefined)).toBe(SITE_AUDIT_DEFAULT_PAGE_LIMIT)
    expect(clampSiteAuditLimit(0)).toBe(1)
    expect(clampSiteAuditLimit(-5)).toBe(1)
    expect(clampSiteAuditLimit(50)).toBe(50)
    expect(clampSiteAuditLimit(99999)).toBe(SITE_AUDIT_MAX_PAGE_LIMIT)
    expect(clampSiteAuditLimit(10.7)).toBe(10)
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
      id: projectId, name: 'p', displayName: 'P', canonicalDomain: 'example.com',
      country: 'US', language: 'en', providers: [], locations: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run()
    vi.mocked(runSitemapAudit).mockReset()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedRun(): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'site-audit', status: 'queued', trigger: 'manual', createdAt: new Date().toISOString() }).run()
    return id
  }

  it('persists a snapshot + pages and marks the run partial when some pages errored', async () => {
    vi.mocked(runSitemapAudit).mockResolvedValue({
      sitemapUrl: 'https://example.com/sitemap.xml',
      auditedAt: new Date().toISOString(),
      pagesDiscovered: 3, pagesAudited: 2, pagesSkipped: 1,
      aggregateScore: 70, aggregateGrade: 'C-',
      pages: [
        { url: 'https://example.com/a', overallScore: 90, overallGrade: 'A-', status: 'success', factors: [scoredFactor('sd', 'Structured Data', 12, 90)] },
        { url: 'https://example.com/b', overallScore: 0, overallGrade: 'F', status: 'error', error: 'TIMEOUT' },
      ],
      crossCuttingIssues: [],
      prioritizedFixes: [],
    } as never)

    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, {})

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('partial')

    const snap = db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()
    expect(snap?.aggregateScore).toBe(70)
    expect(snap?.pagesErrored).toBe(1)
    expect(snap?.factorAverages).toHaveLength(1)

    const pageRows = db.select().from(siteAuditPages).where(eq(siteAuditPages.runId, runId)).all()
    expect(pageRows).toHaveLength(2)
  })

  it('marks the run completed when no pages errored', async () => {
    vi.mocked(runSitemapAudit).mockResolvedValue({
      sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: new Date().toISOString(),
      pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, aggregateScore: 88, aggregateGrade: 'B+',
      pages: [{ url: 'https://example.com/a', overallScore: 88, overallGrade: 'B+', status: 'success', factors: [scoredFactor('sd', 'Structured Data', 12, 88)] }],
      crossCuttingIssues: [], prioritizedFixes: [],
    } as never)

    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, {})
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
  })

  it('computes affectedPct on cross-cutting issues from affectedPages / totalPages', async () => {
    vi.mocked(runSitemapAudit).mockResolvedValue({
      sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: new Date().toISOString(),
      pagesDiscovered: 8, pagesAudited: 8, pagesSkipped: 0, aggregateScore: 55, aggregateGrade: 'F',
      pages: [{ url: 'https://example.com/a', overallScore: 55, overallGrade: 'F', status: 'success', factors: [scoredFactor('sd', 'Structured Data', 12, 55)] }],
      // aeo-audit reports affectedPages/totalPages; canonry derives the share.
      crossCuttingIssues: [{ factorId: 'sd', factorName: 'Structured Data', avgScore: 40, affectedPages: 3, totalPages: 8, topRecommendations: ['Add JSON-LD'] }],
      prioritizedFixes: [],
    } as never)

    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, {})
    const snap = db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()
    expect(snap?.crossCuttingIssues[0]?.affectedPct).toBe(38) // round(3 / 8 * 100) = round(37.5)
  })

  it('clamps affectedPct to 0 when totalPages is 0 (no divide-by-zero)', async () => {
    vi.mocked(runSitemapAudit).mockResolvedValue({
      sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: new Date().toISOString(),
      pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, aggregateScore: 55, aggregateGrade: 'F',
      pages: [{ url: 'https://example.com/a', overallScore: 55, overallGrade: 'F', status: 'success', factors: [scoredFactor('sd', 'Structured Data', 12, 55)] }],
      crossCuttingIssues: [{ factorId: 'sd', factorName: 'Structured Data', avgScore: 40, affectedPages: 0, totalPages: 0, topRecommendations: ['Add JSON-LD'] }],
      prioritizedFixes: [],
    } as never)

    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, {})
    const snap = db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()
    expect(snap?.crossCuttingIssues[0]?.affectedPct).toBe(0) // 0/0 guarded → 0, never NaN/Infinity
  })

  it('fails the run and writes no snapshot when every page errored', async () => {
    vi.mocked(runSitemapAudit).mockResolvedValue({
      sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: new Date().toISOString(),
      pagesDiscovered: 2, pagesAudited: 2, pagesSkipped: 0, aggregateScore: 0, aggregateGrade: 'F',
      pages: [
        { url: 'https://example.com/a', overallScore: 0, overallGrade: 'F', status: 'error', error: 'TIMEOUT' },
        { url: 'https://example.com/b', overallScore: 0, overallGrade: 'F', status: 'error', error: 'UNREACHABLE' },
      ],
      crossCuttingIssues: [], prioritizedFixes: [],
    } as never)

    const runId = seedRun()
    await expect(executeSiteAudit(db, runId, projectId, {})).rejects.toThrow()
    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toBeUndefined()
  })

  it('passes the clamped limit + sitemap override through to runSitemapAudit', async () => {
    vi.mocked(runSitemapAudit).mockResolvedValue({
      sitemapUrl: 'https://example.com/custom.xml', auditedAt: new Date().toISOString(),
      pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, aggregateScore: 50, aggregateGrade: 'F',
      pages: [{ url: 'https://example.com/a', overallScore: 50, overallGrade: 'F', status: 'success', factors: [] }],
      crossCuttingIssues: [], prioritizedFixes: [],
    } as never)

    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { sitemapUrl: 'https://example.com/custom.xml', limit: 99999 })
    expect(vi.mocked(runSitemapAudit)).toHaveBeenCalledWith('https://example.com', { sitemapUrl: 'https://example.com/custom.xml', limit: SITE_AUDIT_MAX_PAGE_LIMIT })
  })
})
