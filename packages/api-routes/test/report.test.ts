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
  queries as queriesTable,
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

function insertQuery(db: ReturnType<typeof createClient>, projectId: string, query: string) {
  const id = crypto.randomUUID()
  db.insert(queriesTable).values({
    id,
    projectId,
    query,
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
  queryId: string,
  overrides: Partial<typeof querySnapshots.$inferInsert> = {},
) {
  const id = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id,
    runId,
    queryId,
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
    expect(body.meta.location).toBeNull()
    expect(body.meta.providerLocationHandling).toEqual([])

    // executive summary defaults
    expect(body.executiveSummary.citationRate).toBe(0)
    expect(body.executiveSummary.citedQueryCount).toBe(0)
    expect(body.executiveSummary.totalQueryCount).toBe(0)
    expect(body.executiveSummary.trend).toBe('unknown')
    expect(body.executiveSummary.queryCount).toBe(0)
    expect(body.executiveSummary.competitorCount).toBe(0)
    expect(body.executiveSummary.providerCount).toBe(0)
    expect(body.executiveSummary.gsc).toBeNull()
    expect(body.executiveSummary.ga).toBeNull()
    expect(Array.isArray(body.executiveSummary.findings)).toBe(true)

    // scorecard
    expect(body.citationScorecard.queries).toEqual([])
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

  test('citation scorecard reflects query × provider matrix', async () => {
    const projectId = insertProject(ctx.db, 'scorecard')
    const kwA = insertQuery(ctx.db, projectId, 'aeo platform')
    const kwB = insertQuery(ctx.db, projectId, 'answer engine optimization')
    const runId = insertRun(ctx.db, projectId, { createdAt: '2026-04-01T00:00:00Z', finishedAt: '2026-04-01T00:01:00Z' })

    insertSnapshot(ctx.db, runId, kwA, { provider: 'gemini', citationState: 'cited' })
    insertSnapshot(ctx.db, runId, kwA, { provider: 'openai', citationState: 'not-cited' })
    insertSnapshot(ctx.db, runId, kwB, { provider: 'gemini', citationState: 'not-cited' })
    insertSnapshot(ctx.db, runId, kwB, { provider: 'openai', citationState: 'cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/scorecard/report' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.citationScorecard.queries).toContain('aeo platform')
    expect(body.citationScorecard.queries).toContain('answer engine optimization')
    expect(body.citationScorecard.providers).toEqual(['gemini', 'openai'])
    expect(body.citationScorecard.matrix.length).toBe(2)
    expect(body.citationScorecard.matrix[0]!.length).toBe(2)

    const ratesByProvider = Object.fromEntries(
      body.citationScorecard.providerRates.map(r => [r.provider, r]),
    )
    expect(ratesByProvider.gemini).toMatchObject({ citedCount: 1, totalCount: 2, citationRate: 50 })
    expect(ratesByProvider.openai).toMatchObject({ citedCount: 1, totalCount: 2, citationRate: 50 })

    // Headline citationRate is per-query: both kwA and kwB are cited by ≥1
    // provider in this run, so 2/2 = 100% — not the per-pair 2/4 = 50%. The
    // per-provider rates above stay at 50% because they're scoped to a single
    // provider's denominator and stay meaningful within a run.
    expect(body.executiveSummary.citationRate).toBe(100)
    expect(body.executiveSummary.citedQueryCount).toBe(2)
    expect(body.executiveSummary.totalQueryCount).toBe(2)
    expect(body.executiveSummary.providerCount).toBe(2)
    expect(body.executiveSummary.queryCount).toBe(2)
  })

  test('competitor landscape counts citations per tracked competitor', async () => {
    const projectId = insertProject(ctx.db, 'landscape')
    const kwA = insertQuery(ctx.db, projectId, 'k1')
    const kwB = insertQuery(ctx.db, projectId, 'k2')
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
    expect(byDomain['rival.com']!.citedQueries.sort()).toEqual(['k1', 'k2'])
    expect(byDomain['other.com']!.citedQueries).toEqual(['k2'])
    expect(body.competitorLandscape.projectCitationCount).toBe(1)
  })

  test('owned domains and subdomains count toward the project, not as external sources', async () => {
    const projectId = insertProject(ctx.db, 'owned', {
      canonicalDomain: 'example.com',
      ownedDomains: JSON.stringify(['brand.io']),
    })
    const kw = insertQuery(ctx.db, projectId, 'kw')
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
    const kw = insertQuery(ctx.db, projectId, 'kw')
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
    const kw = insertQuery(ctx.db, projectId, 'kw')
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
    const kw = insertQuery(ctx.db, projectId, 'kw')

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
    const kw = insertQuery(ctx.db, projectId, 'kw')

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
    const kw = insertQuery(ctx.db, projectId, 'kw')

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
    const kw = insertQuery(ctx.db, projectId, 'kw')

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
    expect(body.citationScorecard.queries).toContain('kw')
    expect(body.executiveSummary.citationRate).toBe(100)
  })

  test('trend stays "unknown" when only one visibility run has completed', async () => {
    const projectId = insertProject(ctx.db, 'single-run')
    const kw = insertQuery(ctx.db, projectId, 'kw')
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
        title: 'Lost citation on query',
        query: 'aeo platform',
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
        query: 'kw',
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

  test('insights are deduped by (query, provider, type) with instanceCount surfaced', async () => {
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
        query: 'aeo platform',
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

  test('meta surfaces the latest run location and per-provider location handling', async () => {
    // azcoatings-style: project has two locations configured; a sweep ran
    // against the default (michigan). Report must say which location powered
    // the data and explain how each provider in the run consumed it.
    const projectId = insertProject(ctx.db, 'loc-meta', {
      locations: JSON.stringify([
        { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
        { label: 'florida', city: 'Miami', region: 'Florida', country: 'US' },
      ]),
      defaultLocation: 'michigan',
    })
    const kw = insertQuery(ctx.db, projectId, 'kw')
    const runId = insertRun(ctx.db, projectId, {
      location: 'michigan',
      createdAt: '2026-04-01T00:00:00Z',
      finishedAt: '2026-04-01T00:01:00Z',
    })
    insertSnapshot(ctx.db, runId, kw, { provider: 'gemini', citationState: 'cited' })
    insertSnapshot(ctx.db, runId, kw, { provider: 'openai', citationState: 'not-cited' })
    insertSnapshot(ctx.db, runId, kw, { provider: 'cdp:chatgpt', citationState: 'not-cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/loc-meta/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.meta.location).toEqual({
      label: 'michigan',
      city: 'Detroit',
      region: 'Michigan',
      country: 'US',
      otherConfiguredLabels: ['florida'],
    })
    const byProvider = Object.fromEntries(
      body.meta.providerLocationHandling.map(h => [h.provider, h]),
    )
    expect(byProvider['gemini']?.treatment).toBe('prompt')
    expect(byProvider['openai']?.treatment).toBe('request-param')
    expect(byProvider['cdp:chatgpt']?.treatment).toBe('browser-geo')
  })

  test('meta.location is null when the latest run had no location attached', async () => {
    const projectId = insertProject(ctx.db, 'loc-empty')
    const kw = insertQuery(ctx.db, projectId, 'kw')
    const runId = insertRun(ctx.db, projectId, {
      // no location field set
      createdAt: '2026-04-01T00:00:00Z',
      finishedAt: '2026-04-01T00:01:00Z',
    })
    insertSnapshot(ctx.db, runId, kw, { provider: 'gemini', citationState: 'cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/loc-empty/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.meta.location).toBeNull()
    expect(body.meta.providerLocationHandling).toHaveLength(1)
    expect(body.meta.providerLocationHandling[0]?.provider).toBe('gemini')
  })

  test('headline rate is per-query — partial-provider runs do not inflate the denominator (issue #422)', async () => {
    // Issue #422 reproduction: a gemini-only run that cited 1 of 5 queries
    // (per-pair 1/5 = 20%) was followed by a full 4-provider run where
    // 2 distinct queries got cited (per-pair 3/24 = 13%). The old per-pair
    // headline read this as a decline. Per-query reads it as 1/5 → 2/5 = up.
    const projectId = insertProject(ctx.db, 'issue-422')
    const queryIds: string[] = []
    for (let i = 1; i <= 5; i++) {
      queryIds.push(insertQuery(ctx.db, projectId, `query-${i}`))
    }

    // Establish four prior baseline runs at 0% so the trend chart isn't
    // suppressed by isTrendBaseline (MIN_TREND_POINTS = 4).
    for (let i = 0; i < 4; i++) {
      const day = String(i + 1).padStart(2, '0')
      const baselineId = insertRun(ctx.db, projectId, {
        createdAt: `2026-04-${day}T00:00:00Z`,
        finishedAt: `2026-04-${day}T00:01:00Z`,
      })
      // 4 providers × 5 queries × not-cited
      for (const qid of queryIds) {
        for (const provider of ['gemini', 'openai', 'claude', 'perplexity']) {
          insertSnapshot(ctx.db, baselineId, qid, { provider, citationState: 'not-cited' })
        }
      }
    }

    // Run A: gemini-only, query-1 cited.
    const runA = insertRun(ctx.db, projectId, {
      createdAt: '2026-04-30T00:00:00Z',
      finishedAt: '2026-04-30T00:01:00Z',
    })
    for (const qid of queryIds) {
      insertSnapshot(ctx.db, runA, qid, {
        provider: 'gemini',
        citationState: qid === queryIds[0] ? 'cited' : 'not-cited',
      })
    }

    // Run B: all four providers. query-1 still cited by gemini, query-2
    // newly cited by gemini + claude + openai. Per-pair = 4/20 = 20% but
    // the per-query rate is 2/5 = 40% — a real improvement, not a decline.
    const runB = insertRun(ctx.db, projectId, {
      createdAt: '2026-05-01T00:00:00Z',
      finishedAt: '2026-05-01T00:01:00Z',
    })
    for (const qid of queryIds) {
      for (const provider of ['gemini', 'openai', 'claude', 'perplexity']) {
        const qIdx = queryIds.indexOf(qid)
        let cited = false
        if (qIdx === 0 && provider === 'gemini') cited = true
        if (qIdx === 1 && provider !== 'perplexity') cited = true
        insertSnapshot(ctx.db, runB, qid, { provider, citationState: cited ? 'cited' : 'not-cited' })
      }
    }

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/issue-422/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    // Latest run is run B: 2 of 5 queries cited = 40%.
    expect(body.executiveSummary.citationRate).toBe(40)
    expect(body.executiveSummary.citedQueryCount).toBe(2)
    expect(body.executiveSummary.totalQueryCount).toBe(5)

    // Trend points: 4 baselines (0%) + run A (1/5 = 20%) + run B (2/5 = 40%).
    const trend = body.citationsTrend
    expect(trend.length).toBe(6)
    const last = trend.at(-1)!
    const prev = trend.at(-2)!
    expect(last.runId).toBe(runB)
    expect(last.citationRate).toBe(40)
    expect(last.citedQueryCount).toBe(2)
    expect(last.totalQueryCount).toBe(5)
    expect(prev.runId).toBe(runA)
    expect(prev.citationRate).toBe(20)

    // The whole point of the fix: the trend label reads 'up', not 'down'.
    expect(body.executiveSummary.trend).toBe('up')
  })

  test('trend label tracks the partial-run citation rate when the latest run is partial', async () => {
    // 4 completed runs at a stable 0% rate establish the trend chart, then a
    // partial latest run lifts the headline to 100%. The trend label drives
    // off the user-visible headline rate, so it must read 'up' — not 'flat'
    // computed from two earlier completed points that pre-date the partial.
    const projectId = insertProject(ctx.db, 'partial-trend')
    const kw = insertQuery(ctx.db, projectId, 'kw')

    for (let i = 0; i < 4; i++) {
      const day = String(i + 1).padStart(2, '0')
      const id = insertRun(ctx.db, projectId, {
        status: 'completed',
        createdAt: `2026-04-${day}T00:00:00Z`,
        finishedAt: `2026-04-${day}T00:01:00Z`,
      })
      insertSnapshot(ctx.db, id, kw, { citationState: 'not-cited' })
    }

    const partialId = insertRun(ctx.db, projectId, {
      status: 'partial',
      createdAt: '2026-04-05T00:00:00Z',
      finishedAt: '2026-04-05T00:01:00Z',
    })
    insertSnapshot(ctx.db, partialId, kw, { citationState: 'cited' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/partial-trend/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.citationsTrend.length).toBe(4) // partial excluded
    expect(body.executiveSummary.citationRate).toBe(100) // partial included
    expect(body.executiveSummary.trend).toBe('up') // partial 100% > latest completed 0%
  })

  test('gscButNotTracked excludes brand-matching queries', async () => {
    const projectId = insertProject(ctx.db, 'brand-filter', {
      displayName: 'Acme',
      canonicalDomain: 'acme.com',
    })
    insertQuery(ctx.db, projectId, 'tracked thing') // already tracked
    const syncRunId = insertRun(ctx.db, projectId, { kind: 'gsc-sync' })

    const seedGscRow = (query: string, impressions: number) => {
      ctx.db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId,
        date: '2026-04-01',
        query,
        page: 'https://acme.com/',
        clicks: 1,
        impressions,
        ctr: '0.01',
        position: '5',
        createdAt: new Date().toISOString(),
      }).run()
    }
    seedGscRow('acme reviews', 1000) // brand → must be filtered
    seedGscRow('Acme login', 800) // brand (case-insensitive) → must be filtered
    seedGscRow('aeo platform', 500) // industry → must appear
    seedGscRow('best widget', 400) // industry → must appear

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/brand-filter/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.gsc).not.toBeNull()
    expect(body.gsc!.gscButNotTracked).not.toContain('acme reviews')
    expect(body.gsc!.gscButNotTracked).not.toContain('Acme login')
    expect(body.gsc!.gscButNotTracked).toContain('aeo platform')
    expect(body.gsc!.gscButNotTracked).toContain('best widget')
  })

  test('GSC categorization uses the project displayName for brand tokens', async () => {
    // The categorizer needs to recognize the human-readable brand even when
    // the project slug differs (e.g. slug "acme-co", displayName "Acme Corp").
    const projectId = insertProject(ctx.db, 'brand-displayname', {
      displayName: 'Acme Corp',
      canonicalDomain: 'acme-co.example.com',
    })
    insertQuery(ctx.db, projectId, 'tracked thing')
    const syncRunId = insertRun(ctx.db, projectId, { kind: 'gsc-sync' })

    ctx.db.insert(gscSearchData).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId,
      date: '2026-04-01',
      query: 'acme corp pricing',
      page: 'https://acme-co.example.com/',
      clicks: 100,
      impressions: 2000,
      ctr: '0.05',
      position: '2',
      createdAt: new Date().toISOString(),
    }).run()

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/brand-displayname/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const top = body.gsc!.topQueries.find((q) => q.query === 'acme corp pricing')
    expect(top?.category).toBe('brand')
  })

  test('insight history is capped at the most recent 5 visibility runs', async () => {
    // 6 answer-visibility runs with one regression insight per run (different
    // queries so dedup doesn't collapse them). Only the 5 most-recent should
    // surface; the oldest run's insight must be filtered out.
    const projectId = insertProject(ctx.db, 'insight-cap')

    const runIds: string[] = []
    for (let i = 0; i < 6; i++) {
      const day = String(i + 1).padStart(2, '0')
      const id = insertRun(ctx.db, projectId, {
        status: 'completed',
        createdAt: `2026-04-${day}T00:00:00Z`,
        finishedAt: `2026-04-${day}T00:01:00Z`,
      })
      runIds.push(id)
      ctx.db.insert(insights).values({
        id: `ins-${i}`,
        projectId,
        runId: id,
        type: 'regression',
        severity: 'high',
        title: `Lost citation #${i}`,
        query: `query-${i}`,
        provider: 'gemini',
        recommendation: null,
        cause: null,
        dismissed: false,
        createdAt: `2026-04-${day}T00:02:00Z`,
      }).run()
    }

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/insight-cap/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.insights.length).toBe(5)
    const titles = body.insights.map((i) => i.title)
    expect(titles).not.toContain('Lost citation #0') // oldest dropped
    expect(titles).toContain('Lost citation #5') // newest kept
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

describe('GET /api/v1/projects/:name/report.html', () => {
  test('returns 404 when the project does not exist', async () => {
    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/missing/report.html' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
  })

  test('returns standalone HTML with attachment headers', async () => {
    insertProject(ctx.db, 'html-report', { displayName: 'HTML Report Co.' })
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/html-report/report.html' })
    expect(res.statusCode).toBe(200)

    const contentType = res.headers['content-type']
    expect(typeof contentType).toBe('string')
    expect(String(contentType)).toMatch(/^text\/html/)

    const disposition = res.headers['content-disposition']
    expect(typeof disposition).toBe('string')
    expect(String(disposition)).toMatch(/^attachment;/)
    expect(String(disposition)).toMatch(/canonry-report-html-report-\d{4}-\d{2}-\d{2}\.html/)

    expect(res.body).toMatch(/^<!DOCTYPE html>/)
    expect(res.body).toContain('HTML Report Co.')
    expect(res.body).toContain('<title>')
  })
})
