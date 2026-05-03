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
  gscSearchData,
  gaTrafficSnapshots,
  gaAiReferrals,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type {
  ContentGapRowDto,
  ContentSourceRowDto,
  ContentTargetRowDto,
  ProjectReportDto,
} from '@ainyc/canonry-contracts'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-report-content-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

function insertProject(db: ReturnType<typeof createClient>, name: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: `${name}.example.com`,
    country: 'US',
    language: 'en',
    locations: '[]',
    providers: '["gemini"]',
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

interface SeededRich {
  projectId: string
  latestRunId: string
}

/**
 * Seed a project that produces non-empty content opportunities, gaps, and
 * grounding sources — mirrors the shape used by content.test.ts so the
 * report endpoint and content endpoints query the same underlying data.
 */
function seedRichProject(db: ReturnType<typeof createClient>): SeededRich {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'rich',
    displayName: 'Rich',
    canonicalDomain: 'rich.example.com',
    country: 'US',
    language: 'en',
    locations: '[]',
    providers: '["gemini"]',
    createdAt: now,
    updatedAt: now,
  }).run()

  for (const domain of ['rival-a.com', 'rival-b.com']) {
    db.insert(competitors).values({
      id: crypto.randomUUID(),
      projectId,
      domain,
      createdAt: now,
    }).run()
  }

  // Two blog-shaped tracked keywords. Both fail isBlogShapedQuery? Verify:
  // - "best aeo platform" — no transactional / navigational tokens, passes
  // - "instant roofing estimate tool" — passes
  const kwIds = new Map<string, string>()
  for (const q of ['best aeo platform', 'instant roofing estimate tool']) {
    const id = crypto.randomUUID()
    kwIds.set(q, id)
    db.insert(keywords).values({ id, projectId, keyword: q, createdAt: now }).run()
  }

  const latestRunId = crypto.randomUUID()
  db.insert(runs).values({
    id: latestRunId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: now,
    finishedAt: now,
  }).run()

  // KW1: competitors cited, we are not — produces a CREATE opportunity + GAP
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    keywordId: kwIds.get('best aeo platform')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: JSON.stringify(['rival-a.com', 'rival-b.com']),
    rawResponse: JSON.stringify({
      groundingSources: [
        { uri: 'https://rival-a.com/best-aeo', title: 'Best AEO' },
        { uri: 'https://rival-b.com/aeo-guide', title: 'AEO Guide' },
      ],
    }),
    createdAt: now,
  }).run()

  // KW2: we have a GSC ranking, competitors also cited — produces REFRESH
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    keywordId: kwIds.get('instant roofing estimate tool')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: JSON.stringify(['rival-a.com']),
    rawResponse: JSON.stringify({
      groundingSources: [
        { uri: 'https://rival-a.com/roofing-estimate', title: 'Roofing Estimate' },
      ],
    }),
    createdAt: now,
  }).run()
  db.insert(gscSearchData).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    query: 'instant roofing estimate tool',
    page: '/roofing/estimate',
    impressions: 1500,
    clicks: 60,
    ctr: '0.04',
    position: '5',
    createdAt: now,
  }).run()

  db.insert(gaTrafficSnapshots).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    landingPage: '/roofing/estimate',
    sessions: 200,
    organicSessions: 200,
    users: 180,
    syncedAt: now,
  }).run()

  db.insert(gaAiReferrals).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    source: 'chatgpt.com',
    medium: 'referral',
    sessions: 25,
    users: 22,
    syncedAt: now,
  }).run()

  return { projectId, latestRunId }
}

let ctx: ReturnType<typeof buildApp>

beforeEach(() => {
  ctx = buildApp()
})

afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('GET /api/v1/projects/:name/report — content intelligence wiring', () => {
  test('empty project returns empty content arrays (not undefined)', async () => {
    insertProject(ctx.db, 'empty')
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/empty/report' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.contentOpportunities).toEqual([])
    expect(body.contentGaps).toEqual([])
    expect(body.groundingSources).toEqual([])
  })

  test('seeded project surfaces contentOpportunities equal to /content/targets', async () => {
    seedRichProject(ctx.db)
    await ctx.app.ready()

    const reportRes = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/rich/report' })
    const targetsRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/rich/content/targets?include-in-progress=true',
    })

    const report = JSON.parse(reportRes.body) as ProjectReportDto
    const targets = JSON.parse(targetsRes.body) as { targets: ContentTargetRowDto[] }

    expect(report.contentOpportunities.length).toBeGreaterThan(0)
    expect(report.contentOpportunities).toEqual(targets.targets)
  })

  test('seeded project surfaces contentGaps equal to /content/gaps', async () => {
    seedRichProject(ctx.db)
    await ctx.app.ready()

    const reportRes = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/rich/report' })
    const gapsRes = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/rich/content/gaps' })

    const report = JSON.parse(reportRes.body) as ProjectReportDto
    const gaps = JSON.parse(gapsRes.body) as { gaps: ContentGapRowDto[] }

    expect(report.contentGaps).toEqual(gaps.gaps)
  })

  test('seeded project surfaces groundingSources equal to /content/sources', async () => {
    seedRichProject(ctx.db)
    await ctx.app.ready()

    const reportRes = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/rich/report' })
    const sourcesRes = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/rich/content/sources' })

    const report = JSON.parse(reportRes.body) as ProjectReportDto
    const sources = JSON.parse(sourcesRes.body) as { sources: ContentSourceRowDto[] }

    expect(report.groundingSources).toEqual(sources.sources)
  })

  test('recommendedNextSteps auto-populates from contentOpportunities when insights yield none', async () => {
    seedRichProject(ctx.db)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/rich/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    // No insights are seeded — buildRecommendedNextSteps would normally return [].
    // The new auto-fill must take over and emit at least one step derived from
    // the top-scored opportunity.
    expect(body.contentOpportunities.length).toBeGreaterThan(0)
    expect(body.recommendedNextSteps.length).toBeGreaterThan(0)

    const top = body.contentOpportunities[0]!
    const firstStep = body.recommendedNextSteps[0]!
    expect(firstStep.title.toLowerCase()).toContain(top.query.toLowerCase())
    expect(firstStep.horizon).toBe('immediate')
  })
})
