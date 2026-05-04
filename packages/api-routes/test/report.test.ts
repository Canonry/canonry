import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  keywords,
  competitors,
  runs,
  querySnapshots,
  insights,
  gscSearchData,
  gscCoverageSnapshots,
  gaTrafficSnapshots,
  gaTrafficSummaries,
  gaAiReferrals,
  gaSocialReferrals,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ProjectReportDto } from '@ainyc/canonry-contracts'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-report-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

function insertProject(
  db: ReturnType<typeof createClient>,
  name: string,
  overrides: Partial<typeof projects.$inferInsert> = {},
) {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id,
    name,
    displayName: overrides.displayName ?? name,
    canonicalDomain: overrides.canonicalDomain ?? `${name}.example.com`,
    country: 'US',
    language: 'en',
    locations: '[]',
    providers: '["gemini","openai"]',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }).run()
  return id
}

function insertKeyword(db: ReturnType<typeof createClient>, projectId: string, keyword: string) {
  const id = crypto.randomUUID()
  db.insert(keywords).values({
    id,
    projectId,
    keyword,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function insertCompetitor(db: ReturnType<typeof createClient>, projectId: string, domain: string) {
  const id = crypto.randomUUID()
  db.insert(competitors).values({
    id,
    projectId,
    domain,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function insertRun(
  db: ReturnType<typeof createClient>,
  projectId: string,
  overrides: Partial<typeof runs.$inferInsert> = {},
) {
  const id = crypto.randomUUID()
  const finishedAt = overrides.finishedAt ?? new Date().toISOString()
  db.insert(runs).values({
    id,
    projectId,
    kind: overrides.kind ?? 'answer-visibility',
    status: overrides.status ?? 'completed',
    trigger: 'manual',
    startedAt: overrides.startedAt ?? finishedAt,
    finishedAt,
    createdAt: overrides.createdAt ?? finishedAt,
    ...overrides,
  }).run()
  return id
}

function insertSnapshot(
  db: ReturnType<typeof createClient>,
  runId: string,
  keywordId: string,
  overrides: Partial<typeof querySnapshots.$inferInsert> = {},
) {
  const id = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id,
    runId,
    keywordId,
    provider: overrides.provider ?? 'gemini',
    model: overrides.model ?? 'gemini-2.0-flash',
    citationState: overrides.citationState ?? 'cited',
    answerMentioned: overrides.answerMentioned ?? true,
    answerText: overrides.answerText ?? '',
    citedDomains: overrides.citedDomains ?? '[]',
    competitorOverlap: overrides.competitorOverlap ?? '[]',
    recommendedCompetitors: overrides.recommendedCompetitors ?? '[]',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...overrides,
  }).run()
  return id
}

let ctx: ReturnType<typeof buildApp>

beforeEach(() => {
  ctx = buildApp()
})

afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('GET /api/v1/projects/:name/report', () => {
  test('returns 404 when the project does not exist', async () => {
    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/missing/report' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
  })

  test('returns a complete skeleton for an empty project', async () => {
    insertProject(ctx.db, 'empty')
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/empty/report' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body) as ProjectReportDto

    // meta
    expect(body.meta.project.name).toBe('empty')
    expect(body.meta.project.canonicalDomain).toBe('empty.example.com')
    expect(typeof body.meta.generatedAt).toBe('string')

    // executive summary defaults
    expect(body.executiveSummary.citationRate).toBe(0)
    expect(body.executiveSummary.trend).toBe('unknown')
    expect(body.executiveSummary.keywordCount).toBe(0)
    expect(body.executiveSummary.competitorCount).toBe(0)
    expect(body.executiveSummary.providerCount).toBe(0)
    expect(body.executiveSummary.gsc).toBeNull()
    expect(body.executiveSummary.ga).toBeNull()
    expect(Array.isArray(body.executiveSummary.findings)).toBe(true)

    // scorecard
    expect(body.citationScorecard.keywords).toEqual([])
    expect(body.citationScorecard.providers).toEqual([])
    expect(body.citationScorecard.matrix).toEqual([])
    expect(body.citationScorecard.providerRates).toEqual([])

    // landscape
    expect(body.competitorLandscape.competitors).toEqual([])
    expect(body.competitorLandscape.projectCitationCount).toBe(0)

    // origin / sections
    expect(body.aiSourceOrigin.categories).toEqual([])
    expect(body.aiSourceOrigin.topDomains).toEqual([])
    expect(body.gsc).toBeNull()
    expect(body.ga).toBeNull()
    expect(body.socialReferrals).toBeNull()
    expect(body.aiReferrals).toBeNull()
    expect(body.indexingHealth).toBeNull()
    expect(body.citationsTrend).toEqual([])
    expect(body.insights).toEqual([])
    expect(body.recommendedNextSteps).toEqual([])
  })

  test('citation scorecard reflects keyword × provider matrix', async () => {
    const projectId = insertProject(ctx.db, 'scorecard')
    const kwA = insertKeyword(ctx.db, projectId, 'aeo platform')
    const kwB = insertKeyword(ctx.db, projectId, 'answer engine optimization')
    const runId = insertRun(ctx.db, projectId, { createdAt: '2026-04-01T00:00:00Z', finishedAt: '2026-04-01T00:01:00Z' })

    insertSnapshot(ctx.db, runId, kwA, { provider: 'gemini', citationState: 'cited' })
    insertSnapshot(ctx.db, runId, kwA, { provider: 'openai', citationState: 'not-cited' })
    insertSnapshot(ctx.db, runId, kwB, { provider: 'gemini', citationState: 'not-cited' })
    insertSnapshot(ctx.db, runId, kwB, { provider: 'openai', citationState: 'cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/scorecard/report' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.citationScorecard.keywords).toContain('aeo platform')
    expect(body.citationScorecard.keywords).toContain('answer engine optimization')
    expect(body.citationScorecard.providers).toEqual(['gemini', 'openai'])
    expect(body.citationScorecard.matrix.length).toBe(2)
    expect(body.citationScorecard.matrix[0]!.length).toBe(2)

    const ratesByProvider = Object.fromEntries(
      body.citationScorecard.providerRates.map(r => [r.provider, r]),
    )
    expect(ratesByProvider.gemini).toMatchObject({ citedCount: 1, totalCount: 2, citationRate: 50 })
    expect(ratesByProvider.openai).toMatchObject({ citedCount: 1, totalCount: 2, citationRate: 50 })

    expect(body.executiveSummary.citationRate).toBe(50)
    expect(body.executiveSummary.providerCount).toBe(2)
    expect(body.executiveSummary.keywordCount).toBe(2)
  })

  test('competitor landscape counts citations per tracked competitor', async () => {
    const projectId = insertProject(ctx.db, 'landscape')
    const kwA = insertKeyword(ctx.db, projectId, 'k1')
    const kwB = insertKeyword(ctx.db, projectId, 'k2')
    insertCompetitor(ctx.db, projectId, 'rival.com')
    insertCompetitor(ctx.db, projectId, 'other.com')

    const runId = insertRun(ctx.db, projectId)
    insertSnapshot(ctx.db, runId, kwA, {
      provider: 'gemini',
      citationState: 'cited',
      citedDomains: JSON.stringify(['landscape.example.com', 'rival.com']),
      competitorOverlap: JSON.stringify(['rival.com']),
    })
    insertSnapshot(ctx.db, runId, kwB, {
      provider: 'gemini',
      citationState: 'not-cited',
      citedDomains: JSON.stringify(['rival.com', 'other.com']),
      competitorOverlap: JSON.stringify(['rival.com', 'other.com']),
    })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/landscape/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const byDomain = Object.fromEntries(
      body.competitorLandscape.competitors.map(c => [c.domain, c]),
    )
    expect(byDomain.rival).toBeUndefined()
    expect(byDomain['rival.com']!.citationCount).toBe(2)
    expect(byDomain['other.com']!.citationCount).toBe(1)
    expect(byDomain['rival.com']!.citedKeywords.sort()).toEqual(['k1', 'k2'])
    expect(byDomain['other.com']!.citedKeywords).toEqual(['k2'])
    expect(body.competitorLandscape.projectCitationCount).toBe(1)
  })

  test('owned domains and subdomains count toward the project, not as external sources', async () => {
    const projectId = insertProject(ctx.db, 'owned', {
      canonicalDomain: 'example.com',
      ownedDomains: JSON.stringify(['brand.io']),
    })
    const kw = insertKeyword(ctx.db, projectId, 'kw')
    const runId = insertRun(ctx.db, projectId)

    insertSnapshot(ctx.db, runId, kw, {
      provider: 'gemini',
      citationState: 'cited',
      citedDomains: JSON.stringify(['blog.example.com', 'brand.io']),
    })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/owned/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.competitorLandscape.projectCitationCount).toBe(1)
    const externalDomains = body.aiSourceOrigin.topDomains.map(d => d.domain)
    expect(externalDomains).not.toContain('blog.example.com')
    expect(externalDomains).not.toContain('brand.io')
  })

  test('AI source origin tags competitor subdomains as competitors', async () => {
    const projectId = insertProject(ctx.db, 'comp-sub')
    insertCompetitor(ctx.db, projectId, 'rival.com')
    const kw = insertKeyword(ctx.db, projectId, 'kw')
    const runId = insertRun(ctx.db, projectId)
    insertSnapshot(ctx.db, runId, kw, {
      provider: 'gemini',
      citationState: 'cited',
      citedDomains: JSON.stringify(['blog.rival.com']),
    })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/comp-sub/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const blog = body.aiSourceOrigin.topDomains.find(d => d.domain === 'blog.rival.com')
    expect(blog).toBeDefined()
    expect(blog!.isCompetitor).toBe(true)
  })

  test('AI source origin aggregates cited domains across snapshots', async () => {
    const projectId = insertProject(ctx.db, 'origin')
    const kw = insertKeyword(ctx.db, projectId, 'kw')
    const runId = insertRun(ctx.db, projectId)

    insertSnapshot(ctx.db, runId, kw, {
      citedDomains: JSON.stringify(['reddit.com', 'youtube.com', 'wikipedia.org']),
    })
    insertSnapshot(ctx.db, runId, kw, {
      provider: 'openai',
      citedDomains: JSON.stringify(['reddit.com', 'forbes.com']),
    })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/origin/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const cats = Object.fromEntries(
      body.aiSourceOrigin.categories.map(c => [c.category, c.count]),
    )
    expect(cats.forum).toBe(2)
    expect(cats.video).toBe(1)
    expect(cats.reference).toBe(1)
    expect(cats.news).toBe(1)

    const topByDomain = Object.fromEntries(
      body.aiSourceOrigin.topDomains.map(d => [d.domain, d.count]),
    )
    expect(topByDomain['reddit.com']).toBe(2)
    expect(topByDomain['youtube.com']).toBe(1)
  })

  test('GSC section returns top queries, totals, category breakdown', async () => {
    const projectId = insertProject(ctx.db, 'gsc-test')
    const syncRunId = insertRun(ctx.db, projectId, { kind: 'gsc-sync' })
    ctx.db.insert(gscSearchData).values([
      {
        id: crypto.randomUUID(),
        projectId,
        syncRunId,
        date: '2026-04-30',
        query: 'gsc-test brand',
        page: 'https://gsc-test.example.com/',
        clicks: 100,
        impressions: 500,
        ctr: '0.2',
        position: '1.5',
        createdAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        projectId,
        syncRunId,
        date: '2026-04-30',
        query: 'best aeo tool',
        page: 'https://gsc-test.example.com/',
        clicks: 30,
        impressions: 600,
        ctr: '0.05',
        position: '5.5',
        createdAt: new Date().toISOString(),
      },
    ]).run()

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/gsc-test/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.gsc).not.toBeNull()
    expect(body.gsc!.totalClicks).toBe(130)
    expect(body.gsc!.totalImpressions).toBe(1100)
    expect(body.gsc!.topQueries.length).toBe(2)
    expect(body.gsc!.topQueries[0]!.query).toBe('gsc-test brand')

    const brandRow = body.gsc!.categoryBreakdown.find(c => c.category === 'brand')
    expect(brandRow?.clicks).toBe(100)

    expect(body.executiveSummary.gsc).toMatchObject({ clicks: 130, impressions: 1100 })
  })

  test('GA traffic, social referral, AI referral sections aggregate from GA tables', async () => {
    const projectId = insertProject(ctx.db, 'ga-test')
    ctx.db.insert(gaTrafficSummaries).values({
      id: crypto.randomUUID(),
      projectId,
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      totalSessions: 5000,
      totalOrganicSessions: 3000,
      totalUsers: 4000,
      syncedAt: new Date().toISOString(),
    }).run()

    ctx.db.insert(gaTrafficSnapshots).values([
      {
        id: crypto.randomUUID(),
        projectId,
        date: '2026-04-30',
        landingPage: '/',
        sessions: 1000,
        organicSessions: 500,
        users: 800,
        syncedAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        projectId,
        date: '2026-04-30',
        landingPage: '/blog',
        sessions: 300,
        organicSessions: 250,
        users: 200,
        syncedAt: new Date().toISOString(),
      },
    ]).run()

    ctx.db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-04-30',
      source: 'chatgpt.com',
      medium: 'referral',
      sourceDimension: 'session',
      landingPage: '/',
      sessions: 50,
      users: 40,
      syncedAt: new Date().toISOString(),
    }).run()

    ctx.db.insert(gaSocialReferrals).values([
      {
        id: crypto.randomUUID(),
        projectId,
        date: '2026-04-30',
        source: 'linkedin.com',
        medium: 'referral',
        channelGroup: 'Organic Social',
        sessions: 80,
        users: 60,
        syncedAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        projectId,
        date: '2026-04-30',
        source: 'facebook.com',
        medium: 'cpc',
        channelGroup: 'Paid Social',
        sessions: 40,
        users: 30,
        syncedAt: new Date().toISOString(),
      },
    ]).run()

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/ga-test/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.ga).not.toBeNull()
    expect(body.ga!.totalSessions).toBe(5000)
    expect(body.ga!.totalUsers).toBe(4000)
    expect(body.ga!.totalOrganicSessions).toBe(3000)
    expect(body.ga!.topLandingPages.length).toBe(2)
    expect(body.ga!.topLandingPages[0]!.page).toBe('/')

    expect(body.aiReferrals).not.toBeNull()
    expect(body.aiReferrals!.totalSessions).toBe(50)
    expect(body.aiReferrals!.bySource[0]!.source).toBe('chatgpt.com')

    expect(body.socialReferrals).not.toBeNull()
    expect(body.socialReferrals!.totalSessions).toBe(120)
    expect(body.socialReferrals!.organicSessions).toBe(80)
    expect(body.socialReferrals!.paidSessions).toBe(40)
  })

  test('AI referrals dedupe overlapping attribution dimensions per (date, source, medium)', async () => {
    const projectId = insertProject(ctx.db, 'ai-dedupe')
    const baseDate = '2026-04-30'
    ctx.db.insert(gaAiReferrals).values([
      {
        id: crypto.randomUUID(),
        projectId,
        date: baseDate,
        source: 'chatgpt.com',
        medium: 'referral',
        sourceDimension: 'session',
        landingPage: '/',
        sessions: 10,
        users: 8,
        syncedAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        projectId,
        date: baseDate,
        source: 'chatgpt.com',
        medium: 'referral',
        sourceDimension: 'first_user',
        landingPage: '/',
        sessions: 10,
        users: 8,
        syncedAt: new Date().toISOString(),
      },
    ]).run()

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/ai-dedupe/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.aiReferrals).not.toBeNull()
    expect(body.aiReferrals!.totalSessions).toBe(10)
    expect(body.aiReferrals!.totalUsers).toBe(8)
    expect(body.aiReferrals!.bySource[0]!.sessions).toBe(10)
    expect(body.aiReferrals!.trend[0]!.sessions).toBe(10)
    expect(body.aiReferrals!.topLandingPages[0]!.sessions).toBe(10)
  })

  test('indexing health prefers GSC and falls back to Bing', async () => {
    const projectId = insertProject(ctx.db, 'idx-test')
    const syncRunId = insertRun(ctx.db, projectId, { kind: 'gsc-sync' })
    ctx.db.insert(gscCoverageSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId,
      date: '2026-04-30',
      indexed: 80,
      notIndexed: 20,
      reasonBreakdown: '{}',
      createdAt: new Date().toISOString(),
    }).run()

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/idx-test/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.indexingHealth).not.toBeNull()
    expect(body.indexingHealth!.provider).toBe('google')
    expect(body.indexingHealth!.indexed).toBe(80)
    expect(body.indexingHealth!.notIndexed).toBe(20)
    expect(body.indexingHealth!.indexedPct).toBe(80)
  })

  test('citations trend returns one point per completed visibility run', async () => {
    const projectId = insertProject(ctx.db, 'trend')
    const kw = insertKeyword(ctx.db, projectId, 'kw')

    const r1 = insertRun(ctx.db, projectId, { createdAt: '2026-04-01T00:00:00Z', finishedAt: '2026-04-01T00:01:00Z' })
    const r2 = insertRun(ctx.db, projectId, { createdAt: '2026-04-02T00:00:00Z', finishedAt: '2026-04-02T00:01:00Z' })
    insertSnapshot(ctx.db, r1, kw, { citationState: 'not-cited' })
    insertSnapshot(ctx.db, r2, kw, { citationState: 'cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/trend/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.citationsTrend.length).toBe(2)
    expect(body.citationsTrend[0]!.runId).toBe(r1)
    expect(body.citationsTrend[0]!.citationRate).toBe(0)
    expect(body.citationsTrend[1]!.runId).toBe(r2)
    expect(body.citationsTrend[1]!.citationRate).toBe(100)
    // Only 2 points — below MIN_TREND_POINTS, so trend is suppressed.
    expect(body.executiveSummary.trend).toBe('unknown')
  })

  test('executiveSummary.trend resolves once enough runs are collected', async () => {
    const projectId = insertProject(ctx.db, 'trend-resolved')
    const kw = insertKeyword(ctx.db, projectId, 'kw')

    // 4 runs: 0%, 0%, 0%, 100% — last delta is up, sample is large enough.
    for (let i = 0; i < 4; i++) {
      const day = String(i + 1).padStart(2, '0')
      const id = insertRun(ctx.db, projectId, {
        createdAt: `2026-04-${day}T00:00:00Z`,
        finishedAt: `2026-04-${day}T00:01:00Z`,
      })
      insertSnapshot(ctx.db, id, kw, { citationState: i === 3 ? 'cited' : 'not-cited' })
    }

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/trend-resolved/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.citationsTrend.length).toBe(4)
    expect(body.executiveSummary.trend).toBe('up')
  })

  test('findings detail surfaces "Establishing baseline" copy until enough runs exist', async () => {
    const projectId = insertProject(ctx.db, 'trend-baseline')
    const kw = insertKeyword(ctx.db, projectId, 'kw')

    const r1 = insertRun(ctx.db, projectId, { createdAt: '2026-04-01T00:00:00Z', finishedAt: '2026-04-01T00:01:00Z' })
    const r2 = insertRun(ctx.db, projectId, { createdAt: '2026-04-02T00:00:00Z', finishedAt: '2026-04-02T00:01:00Z' })
    insertSnapshot(ctx.db, r1, kw, { citationState: 'not-cited' })
    insertSnapshot(ctx.db, r2, kw, { citationState: 'cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/trend-baseline/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const trendFinding = body.executiveSummary.findings.find(f => f.title.startsWith('Citation rate'))
    expect(trendFinding).toBeDefined()
    expect(trendFinding!.detail).toMatch(/Establishing baseline/i)
    expect(trendFinding!.tone).toBe('neutral')
  })

  test('partial runs power the scorecard but are excluded from the trend line', async () => {
    const projectId = insertProject(ctx.db, 'partial-run')
    const kw = insertKeyword(ctx.db, projectId, 'kw')

    const completedId = insertRun(ctx.db, projectId, {
      status: 'completed',
      createdAt: '2026-04-01T00:00:00Z',
      finishedAt: '2026-04-01T00:01:00Z',
    })
    insertSnapshot(ctx.db, completedId, kw, { citationState: 'not-cited' })

    const partialId = insertRun(ctx.db, projectId, {
      status: 'partial',
      createdAt: '2026-04-02T00:00:00Z',
      finishedAt: '2026-04-02T00:01:00Z',
    })
    insertSnapshot(ctx.db, partialId, kw, { citationState: 'cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/partial-run/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.citationsTrend.length).toBe(1)
    expect(body.citationsTrend[0]!.runId).toBe(completedId)
    expect(body.citationScorecard.keywords).toContain('kw')
    expect(body.executiveSummary.citationRate).toBe(100)
  })

  test('trend stays "unknown" when only one visibility run has completed', async () => {
    const projectId = insertProject(ctx.db, 'single-run')
    const kw = insertKeyword(ctx.db, projectId, 'kw')
    const runId = insertRun(ctx.db, projectId, { createdAt: '2026-04-01T00:00:00Z', finishedAt: '2026-04-01T00:01:00Z' })
    insertSnapshot(ctx.db, runId, kw, { citationState: 'cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/single-run/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.citationsTrend.length).toBe(1)
    expect(body.executiveSummary.trend).toBe('unknown')
    const rateFinding = body.executiveSummary.findings.find(f => f.title.startsWith('Citation rate'))
    expect(rateFinding?.detail).not.toContain('previous run')
  })

  test('insights flow into the report and shape recommended next steps', async () => {
    const projectId = insertProject(ctx.db, 'insights-test')
    const runId = insertRun(ctx.db, projectId)

    ctx.db.insert(insights).values([
      {
        id: 'ins-1',
        projectId,
        runId,
        type: 'regression',
        severity: 'critical',
        title: 'Lost citation on key phrase',
        keyword: 'aeo platform',
        provider: 'gemini',
        recommendation: JSON.stringify({ action: 'review-content', target: '/landing', reason: 'rival outranking' }),
        cause: null,
        dismissed: false,
        createdAt: '2026-04-30T00:00:00Z',
      },
      {
        id: 'ins-2',
        projectId,
        runId,
        type: 'opportunity',
        severity: 'medium',
        title: 'New referring domain',
        keyword: 'kw',
        provider: 'openai',
        recommendation: null,
        cause: null,
        dismissed: false,
        createdAt: '2026-04-30T00:00:00Z',
      },
    ]).run()

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/insights-test/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.insights.length).toBe(2)
    expect(body.insights[0]!.severity).toBe('critical')
    expect(body.insights[0]!.recommendation).toContain('review-content')
    expect(body.insights[0]!.instanceCount).toBe(1)

    expect(body.recommendedNextSteps.length).toBeGreaterThan(0)
    const horizons = body.recommendedNextSteps.map(s => s.horizon)
    expect(horizons).toContain('immediate')
  })

  test('insights are deduped by (keyword, provider, type) with instanceCount surfaced', async () => {
    // A regression that fires across three runs should collapse to one
    // ReportInsight with instanceCount=3, not three separate rows. Without
    // dedup at the API layer, downstream consumers (executive findings,
    // recommended next steps, CLI list views) overcount.
    const projectId = insertProject(ctx.db, 'dedup-insights')
    const r1 = insertRun(ctx.db, projectId, { createdAt: '2026-04-01T00:00:00Z', finishedAt: '2026-04-01T00:01:00Z' })
    const r2 = insertRun(ctx.db, projectId, { createdAt: '2026-04-02T00:00:00Z', finishedAt: '2026-04-02T00:01:00Z' })
    const r3 = insertRun(ctx.db, projectId, { createdAt: '2026-04-03T00:00:00Z', finishedAt: '2026-04-03T00:01:00Z' })

    for (const [runId, createdAt, idSuffix] of [
      [r1, '2026-04-01T00:00:00Z', '1'],
      [r2, '2026-04-02T00:00:00Z', '2'],
      [r3, '2026-04-03T00:00:00Z', '3'],
    ] as const) {
      ctx.db.insert(insights).values({
        id: `ins-dup-${idSuffix}`,
        projectId,
        runId,
        type: 'regression',
        severity: 'critical',
        title: 'Lost citation on aeo platform',
        keyword: 'aeo platform',
        provider: 'gemini',
        recommendation: null,
        cause: null,
        dismissed: false,
        createdAt,
      }).run()
    }

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/dedup-insights/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.insights.length).toBe(1)
    expect(body.insights[0]!.instanceCount).toBe(3)
    // Representative is the most-recent firing.
    expect(body.insights[0]!.id).toBe('ins-dup-3')
    // Recommended next steps should count one critical regression, not three.
    const immediate = body.recommendedNextSteps.find(s => s.horizon === 'immediate')
    expect(immediate?.title).toContain('1 critical regression')
  })

  test('report shape is structurally identical across calls (deterministic)', async () => {
    insertProject(ctx.db, 'stable')
    await ctx.app.ready()

    const res1 = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/stable/report' })
    const res2 = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/stable/report' })

    const body1 = JSON.parse(res1.body) as ProjectReportDto
    const body2 = JSON.parse(res2.body) as ProjectReportDto

    expect(Object.keys(body1).sort()).toEqual(Object.keys(body2).sort())
    expect(Object.keys(body1.executiveSummary).sort()).toEqual(
      Object.keys(body2.executiveSummary).sort(),
    )
  })
})
