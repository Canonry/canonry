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

    it('returns answer-mention rate metrics alongside citation rate', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // Answer rate fields exist
      expect(body.overall.answerRate).toBeGreaterThanOrEqual(0)
      expect(body.overall.answerRate).toBeLessThanOrEqual(1)
      expect(body.overall.answerMentionedCount).toBeGreaterThanOrEqual(0)
      expect(body.answerTrend).toMatch(/^(improving|declining|stable)$/)

      // kw1/gemini has answerText 'Example.com is great...' and canonicalDomain 'example.com'
      // so it should be resolved as mentioned
      expect(body.overall.answerMentionedCount).toBeGreaterThan(0)

      // Per-provider answer rate
      expect(body.byProvider.gemini.answerRate).toBeGreaterThan(0)
      expect(body.byProvider.gemini.answerMentionedCount).toBeGreaterThan(0)

      // Each bucket has answer fields
      for (const bucket of body.buckets) {
        expect(bucket.answerRate).toBeGreaterThanOrEqual(0)
        expect(typeof bucket.answerMentionedCount).toBe('number')
      }
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

    it('classifies keywords by answer-mention alongside citation', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/gaps' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // Answer-mention arrays exist
      expect(body.mentionedKeywords).toBeInstanceOf(Array)
      expect(body.mentionGap).toBeInstanceOf(Array)
      expect(body.notMentioned).toBeInstanceOf(Array)

      // kw1/gemini answerText='Example.com is great...' with canonicalDomain='example.com'
      // → resolvedMentioned=true → mentionedKeywords
      expect(body.mentionedKeywords.some((k: { keyword: string }) => k.keyword === 'best seo tools')).toBe(true)

      // kw2 answerText='AEO monitoring is...' — does NOT mention example.com
      // competitor.com is cited → mentionGap
      expect(body.mentionGap.some((k: { keyword: string }) => k.keyword === 'aeo monitoring')).toBe(true)

      // kw3 answerText='Website analytics are...' — no mention, no competitor → notMentioned
      expect(body.notMentioned.some((k: { keyword: string }) => k.keyword === 'website analytics')).toBe(true)

      // Consistency includes mentionedRuns
      const mentioned = body.mentionedKeywords.find((k: { keyword: string }) => k.keyword === 'best seo tools')
      expect(mentioned.consistency.mentionedRuns).toBeGreaterThan(0)
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

  it('omits buckets for days with no sweep data', async () => {
    // Create a project with runs on non-consecutive days
    const gapProjectId = crypto.randomUUID()
    db.insert(projects).values({
      id: gapProjectId,
      name: 'gap-bucket-project',
      displayName: 'Gap Bucket',
      canonicalDomain: 'gapbucket.com',
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

    const gapKwId = crypto.randomUUID()
    db.insert(keywords).values({
      id: gapKwId,
      projectId: gapProjectId,
      keyword: 'gap test keyword',
      createdAt: new Date().toISOString(),
    }).run()

    // Run 1: 5 days ago
    const day1 = new Date()
    day1.setDate(day1.getDate() - 5)
    const run1Id = crypto.randomUUID()
    db.insert(runs).values({
      id: run1Id,
      projectId: gapProjectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      location: null,
      startedAt: day1.toISOString(),
      finishedAt: day1.toISOString(),
      error: null,
      createdAt: day1.toISOString(),
    }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: run1Id,
      keywordId: gapKwId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'cited',
      answerText: 'test',
      citedDomains: '["gapbucket.com"]',
      competitorOverlap: '[]',
      location: null,
      rawResponse: '{}',
      createdAt: day1.toISOString(),
    }).run()

    // Run 2: today (skipping days in between)
    const day2 = new Date()
    const run2Id = crypto.randomUUID()
    db.insert(runs).values({
      id: run2Id,
      projectId: gapProjectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      location: null,
      startedAt: day2.toISOString(),
      finishedAt: day2.toISOString(),
      error: null,
      createdAt: day2.toISOString(),
    }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: run2Id,
      keywordId: gapKwId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'not-cited',
      answerText: 'test',
      citedDomains: '[]',
      competitorOverlap: '[]',
      location: null,
      rawResponse: '{}',
      createdAt: day2.toISOString(),
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/gap-bucket-project/analytics/metrics' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)

    // Every bucket should have actual data (total > 0), no empty gap-fill buckets
    for (const bucket of body.buckets) {
      expect(bucket.total).toBeGreaterThan(0)
    }
    // Should have exactly 2 buckets (one per day with data), not 6 (filling every day)
    expect(body.buckets.length).toBe(2)
  })

  describe('citation rate normalization', () => {
    it('normalizes buckets to exclude newly added keywords', async () => {
      const normProjectId = crypto.randomUUID()
      db.insert(projects).values({
        id: normProjectId, name: 'norm-project', displayName: 'Norm',
        canonicalDomain: 'norm.com', ownedDomains: '[]', country: 'US', language: 'en',
        tags: '[]', labels: '{}', providers: '["gemini"]', locations: '[]',
        defaultLocation: null, configSource: 'api', configRevision: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }).run()

      // Day 1: 2 original keywords
      const day1 = new Date()
      day1.setDate(day1.getDate() - 5)
      const day1ISO = day1.toISOString()

      const origKw1 = crypto.randomUUID()
      const origKw2 = crypto.randomUUID()
      db.insert(keywords).values([
        { id: origKw1, projectId: normProjectId, keyword: 'orig keyword 1', createdAt: day1ISO },
        { id: origKw2, projectId: normProjectId, keyword: 'orig keyword 2', createdAt: day1ISO },
      ]).run()

      // Run 1 on day 1
      const run1Id = crypto.randomUUID()
      db.insert(runs).values({
        id: run1Id, projectId: normProjectId, kind: 'answer-visibility', status: 'completed',
        trigger: 'manual', location: null, startedAt: day1ISO, finishedAt: day1ISO,
        error: null, createdAt: day1ISO,
      }).run()
      db.insert(querySnapshots).values([
        { id: crypto.randomUUID(), runId: run1Id, keywordId: origKw1, provider: 'gemini', citationState: 'cited', answerText: '', citedDomains: '[]', competitorOverlap: '[]', location: null, rawResponse: '{}', createdAt: day1ISO },
        { id: crypto.randomUUID(), runId: run1Id, keywordId: origKw2, provider: 'gemini', citationState: 'cited', answerText: '', citedDomains: '[]', competitorOverlap: '[]', location: null, rawResponse: '{}', createdAt: day1ISO },
      ]).run()

      // Day 2: add 3 new keywords
      const day2 = new Date()
      const day2ISO = day2.toISOString()

      const newKw1 = crypto.randomUUID()
      const newKw2 = crypto.randomUUID()
      const newKw3 = crypto.randomUUID()
      db.insert(keywords).values([
        { id: newKw1, projectId: normProjectId, keyword: 'new keyword 1', createdAt: day2ISO },
        { id: newKw2, projectId: normProjectId, keyword: 'new keyword 2', createdAt: day2ISO },
        { id: newKw3, projectId: normProjectId, keyword: 'new keyword 3', createdAt: day2ISO },
      ]).run()

      // Run 2 on day 2: original keywords still cited, new ones not
      const run2Id = crypto.randomUUID()
      db.insert(runs).values({
        id: run2Id, projectId: normProjectId, kind: 'answer-visibility', status: 'completed',
        trigger: 'manual', location: null, startedAt: day2ISO, finishedAt: day2ISO,
        error: null, createdAt: day2ISO,
      }).run()
      db.insert(querySnapshots).values([
        { id: crypto.randomUUID(), runId: run2Id, keywordId: origKw1, provider: 'gemini', citationState: 'cited', answerText: '', citedDomains: '[]', competitorOverlap: '[]', location: null, rawResponse: '{}', createdAt: day2ISO },
        { id: crypto.randomUUID(), runId: run2Id, keywordId: origKw2, provider: 'gemini', citationState: 'cited', answerText: '', citedDomains: '[]', competitorOverlap: '[]', location: null, rawResponse: '{}', createdAt: day2ISO },
        { id: crypto.randomUUID(), runId: run2Id, keywordId: newKw1, provider: 'gemini', citationState: 'not-cited', answerText: '', citedDomains: '[]', competitorOverlap: '[]', location: null, rawResponse: '{}', createdAt: day2ISO },
        { id: crypto.randomUUID(), runId: run2Id, keywordId: newKw2, provider: 'gemini', citationState: 'not-cited', answerText: '', citedDomains: '[]', competitorOverlap: '[]', location: null, rawResponse: '{}', createdAt: day2ISO },
        { id: crypto.randomUUID(), runId: run2Id, keywordId: newKw3, provider: 'gemini', citationState: 'not-cited', answerText: '', citedDomains: '[]', competitorOverlap: '[]', location: null, rawResponse: '{}', createdAt: day2ISO },
      ]).run()

      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/norm-project/analytics/metrics' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // Second bucket should be normalized to only original keywords (100% cited)
      // Without normalization it would be 2/5 = 40%
      const lastBucket = body.buckets[body.buckets.length - 1]
      expect(lastBucket.citationRate).toBe(1) // 2/2 = 100%
      expect(lastBucket.keywordCount).toBe(2)
    })

    it('returns keywordChanges annotations', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/norm-project/analytics/metrics' })
      const body = JSON.parse(res.payload)

      expect(body.keywordChanges).toBeInstanceOf(Array)
      expect(body.keywordChanges.length).toBe(1)
      expect(body.keywordChanges[0].delta).toBe(3)
      expect(body.keywordChanges[0].label).toBe('+3 kp')
    })

    it('returns empty keywordChanges when all keywords created same day', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics' })
      const body = JSON.parse(res.payload)
      expect(body.keywordChanges).toEqual([])
    })

    it('includes keywordCount on each bucket', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics' })
      const body = JSON.parse(res.payload)
      for (const bucket of body.buckets) {
        expect(bucket.keywordCount).toBeGreaterThan(0)
      }
    })
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
    const metricsBody = JSON.parse(metricsRes.payload)
    expect(metricsBody.overall.total).toBe(0)
    expect(metricsBody.overall.answerRate).toBe(0)
    expect(metricsBody.overall.answerMentionedCount).toBe(0)
    expect(metricsBody.answerTrend).toBe('stable')

    const gapsRes = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-project/analytics/gaps' })
    expect(gapsRes.statusCode).toBe(200)
    const gapsBody = JSON.parse(gapsRes.payload)
    expect(gapsBody.cited).toEqual([])
    expect(gapsBody.mentionedKeywords).toEqual([])
    expect(gapsBody.mentionGap).toEqual([])
    expect(gapsBody.notMentioned).toEqual([])

    const sourcesRes = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-project/analytics/sources' })
    expect(sourcesRes.statusCode).toBe(200)
    expect(JSON.parse(sourcesRes.payload).overall).toEqual([])
  })
})
