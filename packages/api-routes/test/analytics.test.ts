import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, projects, keywords, runs, querySnapshots } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  return { app, db, tmpDir }
}

describe('analytics routes', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let projectId: string
  let runId: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    // Seed: create project
    projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId,
      name: 'test-site',
      displayName: 'Test Site',
      canonicalDomain: 'example.com',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      tags: '[]',
      labels: '{}',
      providers: '["gemini","openai"]',
      locations: '[]',
      defaultLocation: null,
      configSource: 'api',
      configRevision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()

    // Seed: keywords
    const kw1Id = crypto.randomUUID()
    const kw2Id = crypto.randomUUID()
    const kw3Id = crypto.randomUUID()
    db.insert(keywords).values([
      { id: kw1Id, projectId, keyword: 'best seo tools', createdAt: new Date().toISOString() },
      { id: kw2Id, projectId, keyword: 'aeo monitoring', createdAt: new Date().toISOString() },
      { id: kw3Id, projectId, keyword: 'website analytics', createdAt: new Date().toISOString() },
    ]).run()

    // Seed: run
    runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId,
      projectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      location: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: null,
      createdAt: new Date().toISOString(),
    }).run()

    // Seed: snapshots
    // kw1: cited by gemini (with grounding sources), not cited by openai
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId: kw1Id,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'cited',
      answerText: 'Example.com is great...',
      citedDomains: '["example.com"]',
      competitorOverlap: '[]',
      location: null,
      rawResponse: JSON.stringify({
        model: 'gemini-2.5-flash',
        groundingSources: [
          { uri: 'https://reddit.com/r/seo/comments/abc', title: 'Reddit SEO' },
          { uri: 'https://example.com/tools', title: 'Example Tools' },
          { uri: 'https://www.forbes.com/article/seo', title: 'Forbes SEO Guide' },
        ],
        searchQueries: ['best seo tools'],
      }),
      createdAt: new Date().toISOString(),
    }).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId: kw1Id,
      provider: 'openai',
      model: 'gpt-4o',
      citationState: 'not-cited',
      answerText: 'Here are tools...',
      citedDomains: '["competitor.com"]',
      competitorOverlap: '["competitor.com"]',
      location: null,
      rawResponse: JSON.stringify({
        model: 'gpt-4o',
        groundingSources: [
          { uri: 'https://linkedin.com/posts/seo-tips', title: 'LinkedIn Post' },
          { uri: 'https://competitor.com/guide', title: 'Competitor Guide' },
        ],
        searchQueries: ['best seo tools'],
      }),
      createdAt: new Date().toISOString(),
    }).run()

    // kw2: not cited by either, but competitor cited
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId: kw2Id,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'not-cited',
      answerText: 'AEO monitoring is...',
      citedDomains: '["competitor.com"]',
      competitorOverlap: '["competitor.com"]',
      location: null,
      rawResponse: JSON.stringify({
        model: 'gemini-2.5-flash',
        groundingSources: [
          { uri: 'https://en.wikipedia.org/wiki/SEO', title: 'SEO - Wikipedia' },
        ],
        searchQueries: ['aeo monitoring'],
      }),
      createdAt: new Date().toISOString(),
    }).run()

    // kw3: not cited, no competitor overlap
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId: kw3Id,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'not-cited',
      answerText: 'Website analytics are...',
      citedDomains: '[]',
      competitorOverlap: '[]',
      location: null,
      rawResponse: JSON.stringify({
        model: 'gemini-2.5-flash',
        groundingSources: [
          { uri: 'https://youtube.com/watch?v=analytics', title: 'Analytics Video' },
        ],
        searchQueries: ['website analytics'],
      }),
      createdAt: new Date().toISOString(),
    }).run()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('GET /projects/:name/analytics/metrics', () => {
    it('returns citation rate metrics', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.window).toBe('all')
      expect(body.overall.total).toBeGreaterThan(0)
      expect(body.overall.citationRate).toBeGreaterThanOrEqual(0)
      expect(body.overall.citationRate).toBeLessThanOrEqual(1)
      expect(body.trend).toMatch(/^(improving|declining|stable)$/)
    })

    it('supports window parameter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics?window=7d' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.window).toBe('7d')
    })

    it('returns per-provider breakdown', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics' })
      const body = JSON.parse(res.payload)
      expect(body.byProvider).toBeDefined()
      expect(body.byProvider.gemini).toBeDefined()
      expect(body.byProvider.gemini.total).toBeGreaterThan(0)
    })
  })

  describe('GET /projects/:name/analytics/gaps', () => {
    it('classifies keywords correctly with consistency', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/gaps' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      expect(body.window).toBe('all')

      // kw1 is cited by gemini
      expect(body.cited).toHaveLength(1)
      expect(body.cited[0].keyword).toBe('best seo tools')
      expect(body.cited[0].providers).toContain('gemini')
      expect(body.cited[0].consistency.citedRuns).toBe(1)
      expect(body.cited[0].consistency.totalRuns).toBe(1)

      // kw2 is a gap — not cited but competitor is
      expect(body.gap).toHaveLength(1)
      expect(body.gap[0].keyword).toBe('aeo monitoring')
      expect(body.gap[0].competitorsCiting).toContain('competitor.com')
      expect(body.gap[0].consistency.citedRuns).toBe(0)
      expect(body.gap[0].consistency.totalRuns).toBe(1)

      // kw3 is uncited — nobody cited
      expect(body.uncited).toHaveLength(1)
      expect(body.uncited[0].keyword).toBe('website analytics')

      expect(body.runId).toBe(runId)
    })

    it('supports window parameter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/gaps?window=7d' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.window).toBe('7d')
    })
  })

  describe('GET /projects/:name/analytics/sources', () => {
    it('returns source category breakdown', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/sources' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      expect(body.window).toBe('all')
      expect(body.overall).toBeInstanceOf(Array)
      expect(body.overall.length).toBeGreaterThan(0)

      // Check that categories include forum (reddit), social (linkedin), news (forbes), reference (wikipedia), video (youtube)
      const categories = body.overall.map((c: { category: string }) => c.category)
      expect(categories).toContain('forum')

      // Each category should have percentage summing to ~1
      const totalPct = body.overall.reduce((s: number, c: { percentage: number }) => s + c.percentage, 0)
      expect(totalPct).toBeCloseTo(1, 1)
    })

    it('includes per-keyword breakdown', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/sources' })
      const body = JSON.parse(res.payload)
      expect(body.byKeyword).toBeDefined()
      expect(Object.keys(body.byKeyword).length).toBeGreaterThan(0)
    })

    it('supports window parameter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/sources?window=30d' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.window).toBe('30d')
    })
  })

  it('returns 404 for non-existent project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/nonexistent/analytics/metrics' })
    expect(res.statusCode).toBe(404)
  })

  it('excludes provider infrastructure domains from source breakdown', async () => {
    // Seed a snapshot that mixes real sources with provider infra URIs
    const infraKwId = crypto.randomUUID()
    db.insert(keywords).values({ id: infraKwId, projectId, keyword: 'infra-filter-test', createdAt: new Date().toISOString() }).run()
    const infraRunId = crypto.randomUUID()
    db.insert(runs).values({
      id: infraRunId, projectId, kind: 'answer-visibility', status: 'completed',
      trigger: 'manual', location: null, startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), error: null, createdAt: new Date().toISOString(),
    }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId: infraRunId, keywordId: infraKwId,
      provider: 'gemini', model: 'gemini-2.5-flash', citationState: 'not-cited',
      answerText: 'test', citedDomains: '[]', competitorOverlap: '[]', location: null,
      rawResponse: JSON.stringify({
        groundingSources: [
          { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123', title: 'Vertex proxy' },
          { uri: 'https://openai.com/research/gpt4', title: 'OpenAI research' },
          { uri: 'https://reddit.com/r/real', title: 'Real source' },
        ],
      }),
      createdAt: new Date().toISOString(),
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/sources' })
    const body = JSON.parse(res.payload)
    const allDomains = body.overall.flatMap((c: { topDomains: Array<{ domain: string }> }) => c.topDomains.map(d => d.domain))
    expect(allDomains).not.toContain('vertexaisearch.cloud.google.com')
    expect(allDomains).not.toContain('openai.com')
  })

  it('returns empty data when no runs exist', async () => {
    // Create a project with no runs
    const emptyProjectId = crypto.randomUUID()
    db.insert(projects).values({
      id: emptyProjectId,
      name: 'empty-project',
      displayName: 'Empty',
      canonicalDomain: 'empty.com',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      tags: '[]',
      labels: '{}',
      providers: '["gemini"]',
      locations: '[]',
      defaultLocation: null,
      configSource: 'api',
      configRevision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()

    const metricsRes = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-project/analytics/metrics' })
    expect(metricsRes.statusCode).toBe(200)
    expect(JSON.parse(metricsRes.payload).overall.total).toBe(0)

    const gapsRes = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-project/analytics/gaps' })
    expect(gapsRes.statusCode).toBe(200)
    expect(JSON.parse(gapsRes.payload).cited).toEqual([])

    const sourcesRes = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-project/analytics/sources' })
    expect(sourcesRes.statusCode).toBe(200)
    expect(JSON.parse(sourcesRes.payload).overall).toEqual([])
  })
})
