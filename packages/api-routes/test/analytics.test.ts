import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, projects, queries, runs, querySnapshots, competitors } from '@ainyc/canonry-db'
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

    // Seed: queries
    const q1Id = crypto.randomUUID()
    const q2Id = crypto.randomUUID()
    const q3Id = crypto.randomUUID()
    db.insert(queries).values([
      { id: q1Id, projectId, query: 'best seo tools', createdAt: new Date().toISOString() },
      { id: q2Id, projectId, query: 'aeo monitoring', createdAt: new Date().toISOString() },
      { id: q3Id, projectId, query: 'website analytics', createdAt: new Date().toISOString() },
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
    // q1: cited by gemini (with grounding sources), not cited by openai
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId: q1Id,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'cited',
      answerText: 'Example.com is great...',
      citedDomains: ['example.com'],
      competitorOverlap: [],
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
      queryId: q1Id,
      provider: 'openai',
      model: 'gpt-4o',
      citationState: 'not-cited',
      answerText: 'Here are tools...',
      citedDomains: ['competitor.com'],
      competitorOverlap: ['competitor.com'],
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

    // q2: not cited by either, but competitor cited
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId: q2Id,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'not-cited',
      answerText: 'AEO monitoring is...',
      citedDomains: ['competitor.com'],
      competitorOverlap: ['competitor.com'],
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

    // q3: not cited, no competitor overlap
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId: q3Id,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'not-cited',
      answerText: 'Website analytics are...',
      citedDomains: [],
      competitorOverlap: [],
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

      // Mention rate fields exist
      expect(body.overall.mentionRate).toBeGreaterThanOrEqual(0)
      expect(body.overall.mentionRate).toBeLessThanOrEqual(1)
      expect(body.overall.mentionedCount).toBeGreaterThanOrEqual(0)
      expect(body.mentionTrend).toMatch(/^(improving|declining|stable)$/)

      // kw1/gemini has answerText 'Example.com is great...' and canonicalDomain 'example.com'
      // so it should be resolved as mentioned
      expect(body.overall.mentionedCount).toBeGreaterThan(0)

      // Per-provider mention rate
      expect(body.byProvider.gemini.mentionRate).toBeGreaterThan(0)
      expect(body.byProvider.gemini.mentionedCount).toBeGreaterThan(0)

      // Each bucket has mention fields
      for (const bucket of body.buckets) {
        expect(bucket.mentionRate).toBeGreaterThanOrEqual(0)
        expect(typeof bucket.mentionedCount).toBe('number')
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

    it('carries a per-provider breakdown on every bucket that sums to the bucket totals', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics' })
      const body = JSON.parse(res.payload)
      expect(body.buckets.length).toBeGreaterThan(0)
      for (const bucket of body.buckets) {
        expect(bucket.byProvider).toBeDefined()
        expect(Object.keys(bucket.byProvider).length).toBeGreaterThan(0)

        let sumTotal = 0
        let sumCited = 0
        let sumMentioned = 0
        for (const metric of Object.values(bucket.byProvider) as Array<{
          citationRate: number; mentionRate: number; cited: number; total: number; mentionedCount: number
        }>) {
          // 4dp rounding invariant — same rounding computeProviderMetric applies to `overall`
          expect(metric.citationRate).toBe(Math.round(metric.citationRate * 10000) / 10000)
          expect(metric.mentionRate).toBe(Math.round(metric.mentionRate * 10000) / 10000)
          // a provider can't cite/mention more than its own snapshot total
          expect(metric.cited).toBeLessThanOrEqual(metric.total)
          expect(metric.mentionedCount).toBeLessThanOrEqual(metric.total)
          sumTotal += metric.total
          sumCited += metric.cited
          sumMentioned += metric.mentionedCount
        }
        // disjoint partition: provider slices sum to the bucket aggregate
        expect(sumTotal).toBe(bucket.total)
        expect(sumCited).toBe(bucket.cited)
        expect(sumMentioned).toBe(bucket.mentionedCount)
      }
    })
  })

  describe('GET /projects/:name/analytics/gaps', () => {
    it('classifies queries correctly with consistency', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/gaps' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      expect(body.window).toBe('all')

      // q1 is cited by gemini
      expect(body.cited).toHaveLength(1)
      expect(body.cited[0].query).toBe('best seo tools')
      expect(body.cited[0].providers).toContain('gemini')
      expect(body.cited[0].consistency.citedRuns).toBe(1)
      expect(body.cited[0].consistency.totalRuns).toBe(1)

      // q2 is a gap — not cited but competitor is
      expect(body.gap).toHaveLength(1)
      expect(body.gap[0].query).toBe('aeo monitoring')
      expect(body.gap[0].competitorsCiting).toContain('competitor.com')
      expect(body.gap[0].consistency.citedRuns).toBe(0)
      expect(body.gap[0].consistency.totalRuns).toBe(1)

      // q3 is uncited — nobody cited
      expect(body.uncited).toHaveLength(1)
      expect(body.uncited[0].query).toBe('website analytics')

      expect(body.runId).toBe(runId)
    })

    it('classifies queries by answer-mention alongside citation', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/gaps' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // Answer-mention arrays exist
      expect(body.mentionedQueries).toBeInstanceOf(Array)
      expect(body.mentionGap).toBeInstanceOf(Array)
      expect(body.notMentioned).toBeInstanceOf(Array)

      // q1/gemini answerText='Example.com is great...' with canonicalDomain='example.com'
      // → resolvedMentioned=true → mentionedQueries
      expect(body.mentionedQueries.some((k: { query: string }) => k.query === 'best seo tools')).toBe(true)

      // q2 answerText='AEO monitoring is...' — does NOT mention example.com
      // competitor.com is cited → mentionGap
      expect(body.mentionGap.some((k: { query: string }) => k.query === 'aeo monitoring')).toBe(true)

      // q3 answerText='Website analytics are...' — no mention, no competitor → notMentioned
      expect(body.notMentioned.some((k: { query: string }) => k.query === 'website analytics')).toBe(true)

      // Consistency includes mentionedRuns
      const mentioned = body.mentionedQueries.find((k: { query: string }) => k.query === 'best seo tools')
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

    it('includes per-query breakdown', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/sources' })
      const body = JSON.parse(res.payload)
      expect(body.byQuery).toBeDefined()
      expect(Object.keys(body.byQuery).length).toBeGreaterThan(0)
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
    const infraQId = crypto.randomUUID()
    db.insert(queries).values({ id: infraQId, projectId, query: 'infra-filter-test', createdAt: new Date().toISOString() }).run()
    const infraRunId = crypto.randomUUID()
    db.insert(runs).values({
      id: infraRunId, projectId, kind: 'answer-visibility', status: 'completed',
      trigger: 'manual', location: null, startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), error: null, createdAt: new Date().toISOString(),
    }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId: infraRunId, queryId: infraQId,
      provider: 'gemini', model: 'gemini-2.5-flash', citationState: 'not-cited',
      answerText: 'test', citedDomains: [], competitorOverlap: [], location: null,
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

    const gapQId = crypto.randomUUID()
    db.insert(queries).values({
      id: gapQId,
      projectId: gapProjectId,
      query: 'gap test query',
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
      queryId: gapQId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'cited',
      answerText: 'test',
      citedDomains: ['gapbucket.com'],
      competitorOverlap: [],
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
      queryId: gapQId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'not-cited',
      answerText: 'test',
      citedDomains: [],
      competitorOverlap: [],
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
    it('normalizes buckets to exclude newly added queries', async () => {
      const normProjectId = crypto.randomUUID()
      db.insert(projects).values({
        id: normProjectId, name: 'norm-project', displayName: 'Norm',
        canonicalDomain: 'norm.com', ownedDomains: '[]', country: 'US', language: 'en',
        tags: '[]', labels: '{}', providers: '["gemini"]', locations: '[]',
        defaultLocation: null, configSource: 'api', configRevision: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }).run()

      // Day 1: 2 original queries
      const day1 = new Date()
      day1.setDate(day1.getDate() - 5)
      const day1ISO = day1.toISOString()

      const origQ1 = crypto.randomUUID()
      const origQ2 = crypto.randomUUID()
      db.insert(queries).values([
        { id: origQ1, projectId: normProjectId, query: 'orig query 1', createdAt: day1ISO },
        { id: origQ2, projectId: normProjectId, query: 'orig query 2', createdAt: day1ISO },
      ]).run()

      // Run 1 on day 1
      const run1Id = crypto.randomUUID()
      db.insert(runs).values({
        id: run1Id, projectId: normProjectId, kind: 'answer-visibility', status: 'completed',
        trigger: 'manual', location: null, startedAt: day1ISO, finishedAt: day1ISO,
        error: null, createdAt: day1ISO,
      }).run()
      db.insert(querySnapshots).values([
        { id: crypto.randomUUID(), runId: run1Id, queryId: origQ1, provider: 'gemini', citationState: 'cited', answerText: '', citedDomains: [], competitorOverlap: [], location: null, rawResponse: '{}', createdAt: day1ISO },
        { id: crypto.randomUUID(), runId: run1Id, queryId: origQ2, provider: 'gemini', citationState: 'cited', answerText: '', citedDomains: [], competitorOverlap: [], location: null, rawResponse: '{}', createdAt: day1ISO },
      ]).run()

      // Day 2: add 3 new queries
      const day2 = new Date()
      const day2ISO = day2.toISOString()

      const newQ1 = crypto.randomUUID()
      const newQ2 = crypto.randomUUID()
      const newQ3 = crypto.randomUUID()
      db.insert(queries).values([
        { id: newQ1, projectId: normProjectId, query: 'new query 1', createdAt: day2ISO },
        { id: newQ2, projectId: normProjectId, query: 'new query 2', createdAt: day2ISO },
        { id: newQ3, projectId: normProjectId, query: 'new query 3', createdAt: day2ISO },
      ]).run()

      // Run 2 on day 2: original queries still cited, new ones not
      const run2Id = crypto.randomUUID()
      db.insert(runs).values({
        id: run2Id, projectId: normProjectId, kind: 'answer-visibility', status: 'completed',
        trigger: 'manual', location: null, startedAt: day2ISO, finishedAt: day2ISO,
        error: null, createdAt: day2ISO,
      }).run()
      db.insert(querySnapshots).values([
        { id: crypto.randomUUID(), runId: run2Id, queryId: origQ1, provider: 'gemini', citationState: 'cited', answerText: '', citedDomains: [], competitorOverlap: [], location: null, rawResponse: '{}', createdAt: day2ISO },
        { id: crypto.randomUUID(), runId: run2Id, queryId: origQ2, provider: 'gemini', citationState: 'cited', answerText: '', citedDomains: [], competitorOverlap: [], location: null, rawResponse: '{}', createdAt: day2ISO },
        { id: crypto.randomUUID(), runId: run2Id, queryId: newQ1, provider: 'gemini', citationState: 'not-cited', answerText: '', citedDomains: [], competitorOverlap: [], location: null, rawResponse: '{}', createdAt: day2ISO },
        { id: crypto.randomUUID(), runId: run2Id, queryId: newQ2, provider: 'gemini', citationState: 'not-cited', answerText: '', citedDomains: [], competitorOverlap: [], location: null, rawResponse: '{}', createdAt: day2ISO },
        { id: crypto.randomUUID(), runId: run2Id, queryId: newQ3, provider: 'gemini', citationState: 'not-cited', answerText: '', citedDomains: [], competitorOverlap: [], location: null, rawResponse: '{}', createdAt: day2ISO },
      ]).run()

      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/norm-project/analytics/metrics' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // Second bucket should be normalized to only original queries (100% cited)
      // Without normalization it would be 2/5 = 40%
      const lastBucket = body.buckets[body.buckets.length - 1]
      expect(lastBucket.citationRate).toBe(1) // 2/2 = 100%
      expect(lastBucket.queryCount).toBe(2)
      // Per-provider rides the SAME normalized `usable` set — gemini's bucket
      // slice excludes the 3 newly-added queries too (total 2, not 5).
      expect(lastBucket.byProvider.gemini.total).toBe(2)
      expect(lastBucket.byProvider.gemini.citationRate).toBe(1)
    })

    it('returns queryChanges annotations', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/norm-project/analytics/metrics' })
      const body = JSON.parse(res.payload)

      expect(body.queryChanges).toBeInstanceOf(Array)
      expect(body.queryChanges.length).toBe(1)
      expect(body.queryChanges[0].delta).toBe(3)
      expect(body.queryChanges[0].label).toBe('+3 kp')
    })

    it('returns empty queryChanges when all queries created same day', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics' })
      const body = JSON.parse(res.payload)
      expect(body.queryChanges).toEqual([])
    })

    it('includes queryCount on each bucket', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-site/analytics/metrics' })
      const body = JSON.parse(res.payload)
      for (const bucket of body.buckets) {
        expect(bucket.queryCount).toBeGreaterThan(0)
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
    expect(metricsBody.overall.mentionRate).toBe(0)
    expect(metricsBody.overall.mentionedCount).toBe(0)
    expect(metricsBody.mentionTrend).toBe('stable')

    const gapsRes = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-project/analytics/gaps' })
    expect(gapsRes.statusCode).toBe(200)
    const gapsBody = JSON.parse(gapsRes.payload)
    expect(gapsBody.cited).toEqual([])
    expect(gapsBody.mentionedQueries).toEqual([])
    expect(gapsBody.mentionGap).toEqual([])
    expect(gapsBody.notMentioned).toEqual([])

    const sourcesRes = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-project/analytics/sources' })
    expect(sourcesRes.statusCode).toBe(200)
    expect(JSON.parse(sourcesRes.payload).overall).toEqual([])
  })
})

// Regression suite for #480: multi-location `--all-locations` fan-out used to
// collapse to a single non-deterministic location's run for both gap-analysis
// classification and the source-breakdown's `latestRunId` field.
describe('analytics fan-out (#480)', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    tmpDir = ctx.tmpDir
    const db = ctx.db
    await app.ready()

    const projectId = crypto.randomUUID()
    const queryId = crypto.randomUUID()
    const flLatestId = '00000000-0000-0000-0000-0000000000a1'
    const miLatestId = 'ffffffff-ffff-ffff-ffff-fffffffff0a1'
    const latestCreatedAt = '2026-05-13T17:23:20.060Z'

    db.insert(projects).values({
      id: projectId,
      name: 'fanout-analytics',
      displayName: 'Fan-out Analytics',
      canonicalDomain: 'azcoatings.example',
      country: 'US',
      language: 'en',
      ownedDomains: '[]',
      tags: '[]',
      labels: '{}',
      providers: '["gemini"]',
      locations: JSON.stringify([
        { label: 'florida',  city: 'Orlando', region: 'Florida',  country: 'US' },
        { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
      ]),
      defaultLocation: null,
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: latestCreatedAt,
    }).run()
    db.insert(queries).values({
      id: queryId,
      projectId,
      query: 'polyurea roof coating',
      createdAt: '2026-05-10T00:00:00.000Z',
    }).run()
    db.insert(runs).values([
      { id: flLatestId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'florida',  startedAt: latestCreatedAt, finishedAt: latestCreatedAt, error: null, createdAt: latestCreatedAt },
      { id: miLatestId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'michigan', startedAt: latestCreatedAt, finishedAt: latestCreatedAt, error: null, createdAt: latestCreatedAt },
    ]).run()
    // Florida: cited. Michigan: not cited. Aggregating across the group means
    // the query is "cited" project-wide but the not-cited michigan snapshot
    // should still surface providers in the cited/gap classification logic.
    db.insert(querySnapshots).values([
      { id: crypto.randomUUID(), runId: flLatestId, queryId, provider: 'gemini', model: 'gemini-2.5', citationState: 'cited',     answerMentioned: true,  answerText: 'florida answer', citedDomains: ['azcoatings.example'], competitorOverlap: [], recommendedCompetitors: [], location: 'florida',  rawResponse: '{}', createdAt: latestCreatedAt },
      { id: crypto.randomUUID(), runId: miLatestId, queryId, provider: 'gemini', model: 'gemini-2.5', citationState: 'not-cited', answerMentioned: false, answerText: 'michigan answer', citedDomains: [],                       competitorOverlap: [], recommendedCompetitors: [], location: 'michigan', rawResponse: '{}', createdAt: latestCreatedAt },
    ]).run()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('/analytics/gaps classification spans both fan-out locations', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/fanout-analytics/analytics/gaps' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    // The query has at least one cited provider (florida-gemini); it should
    // appear in `cited` rather than `gap` or `uncited`. Pre-fix, depending on
    // which location's run won the non-deterministic tiebreak, the query
    // could be classified differently across calls.
    const allCited = body.cited.map((q: { query: string }) => q.query)
    expect(allCited).toContain('polyurea roof coating')
  })

  it('/analytics/gaps returns a deterministic representative runId', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/v1/projects/fanout-analytics/analytics/gaps' })
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/projects/fanout-analytics/analytics/gaps' })
    const body1 = JSON.parse(res1.payload)
    const body2 = JSON.parse(res2.payload)
    expect(body1.runId).toBe(body2.runId)
    // The id-DESC tiebreak picks michigan (its id is lexicographically greater).
    expect(body1.runId).toBe('ffffffff-ffff-ffff-ffff-fffffffff0a1')
  })

  it('/analytics/sources returns a deterministic representative runId', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/v1/projects/fanout-analytics/analytics/sources' })
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/projects/fanout-analytics/analytics/sources' })
    const body1 = JSON.parse(res1.payload)
    const body2 = JSON.parse(res2.payload)
    expect(body1.runId).toBe(body2.runId)
    expect(body1.runId).toBe('ffffffff-ffff-ffff-ffff-fffffffff0a1')
  })
})

// #675 — full ranked, per-provider, and classified source rankings. Dedicated
// suite with a deterministic fixture so the calculation invariants (counts sum
// to totals, per-provider reconciliation, surface-class roll-up) can be asserted
// exactly, not just by shape.
describe('GET /projects/:name/analytics/sources — ranked + byProvider + classification', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>

  const iso = new Date().toISOString()

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    await app.ready()

    const projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'rank-site', displayName: 'Rank Site',
      canonicalDomain: 'acme.com', ownedDomains: ['acme.io'],
      country: 'US', language: 'en', tags: [], labels: {},
      providers: ['gemini', 'openai'], locations: [], defaultLocation: null,
      configSource: 'api', configRevision: 1, createdAt: iso, updatedAt: iso,
    }).run()

    // Tracked competitor — drives the direct-competitor surface class.
    db.insert(competitors).values({
      id: crypto.randomUUID(), projectId, domain: 'rival.com', provenance: 'manual', createdAt: iso,
    }).run()

    const qId = crypto.randomUUID()
    db.insert(queries).values({ id: qId, projectId, query: 'best hotels', createdAt: iso }).run()

    const realRunId = crypto.randomUUID()
    db.insert(runs).values({
      id: realRunId, projectId, kind: 'answer-visibility', status: 'completed',
      trigger: 'manual', location: null, startedAt: iso, finishedAt: iso, error: null, createdAt: iso,
    }).run()

    // gemini: 12 cited slots over 11 distinct domains (acme x2), plus 6 'other'
    // long-tail domains to prove the old top-5-per-category cap is gone. Two
    // infra URIs are mixed in and must be filtered out (not counted).
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId: realRunId, queryId: qId, provider: 'gemini',
      model: 'gemini-2.5-flash', citationState: 'cited', answerText: 'acme is great',
      citedDomains: [], competitorOverlap: [], location: null,
      rawResponse: JSON.stringify({
        groundingSources: [
          { uri: 'https://acme.com/a', title: 'Acme' },
          { uri: 'https://acme.com/b', title: 'Acme 2' },
          { uri: 'https://acme.com/c', title: 'Acme 3' },
          { uri: 'https://rival.com/x', title: 'Rival' },
          { uri: 'https://www.booking.com/hotel/y', title: 'Booking' },
          { uri: 'https://www.forbes.com/article', title: 'Forbes' },
          { uri: 'https://reddit.com/r/travel', title: 'Reddit' },
          { uri: 'https://g1.io/p', title: 'g1' },
          { uri: 'https://g2.io/p', title: 'g2' },
          { uri: 'https://g3.io/p', title: 'g3' },
          { uri: 'https://g4.io/p', title: 'g4' },
          { uri: 'https://g5.io/p', title: 'g5' },
          { uri: 'https://g6.io/p', title: 'g6' },
          // infra — filtered, never counted:
          { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/Z', title: 'proxy' },
          { uri: 'https://openai.com/research', title: 'infra' },
        ],
      }),
      createdAt: iso,
    }).run()

    // openai: 4 cited slots over 4 distinct domains. acme + rival overlap with
    // gemini; expedia + oa1.io are openai-only.
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId: realRunId, queryId: qId, provider: 'openai',
      model: 'gpt-4o', citationState: 'cited', answerText: 'hotels',
      citedDomains: [], competitorOverlap: [], location: null,
      rawResponse: JSON.stringify({
        groundingSources: [
          { uri: 'https://rival.com/y', title: 'Rival' },
          { uri: 'https://www.expedia.com/h', title: 'Expedia' },
          { uri: 'https://acme.io/z', title: 'Acme alias' },
          { uri: 'https://oa1.io/p', title: 'oa1' },
        ],
      }),
      createdAt: iso,
    }).run()

    // claude: answered but grounded on nothing usable (empty list). Contributes
    // zero slots/domains — must be OMITTED from byProvider entirely, not surfaced
    // as an empty bucket.
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId: realRunId, queryId: qId, provider: 'claude',
      model: 'claude-sonnet', citationState: 'cited', answerText: 'no sources',
      citedDomains: [], competitorOverlap: [], location: null,
      rawResponse: JSON.stringify({ groundingSources: [] }),
      createdAt: iso,
    }).run()
  })

  afterAll(async () => {
    await app.close()
  })

  // Expected overall (gemini 13 + openai 4 = 17 slots, 14 distinct domains):
  //   own:               acme.com 3 + acme.io 1 = count 4, domainCount 2
  //   direct-competitor: rival.com 2,                       domainCount 1
  //   ota-aggregator:    booking 1 + expedia 1 = count 2,   domainCount 2
  //   editorial-media:   forbes 1,                          domainCount 1
  //   other:             reddit + g1..g6 + oa1 = count 8,   domainCount 8

  it('returns the full ranked list (no per-category top-5 cap) sorted desc with ties broken by domain', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)

    expect(body.limit).toBeNull()
    expect(body.ranked.totalCitedSlots).toBe(17)
    expect(body.ranked.domainTotal).toBe(14)
    expect(body.ranked.entries).toHaveLength(14)
    expect(body.ranked.truncatedDomainCount).toBe(0)
    expect(body.ranked.truncatedCitedSlots).toBe(0)

    // sum of entry counts reconciles to the total cited slots
    const sum = body.ranked.entries.reduce((s: number, e: { count: number }) => s + e.count, 0)
    expect(sum).toBe(17)

    // top two by count, then count-1 ties alphabetically (acme.io is first)
    expect(body.ranked.entries[0]).toMatchObject({ domain: 'acme.com', count: 3, surfaceClass: 'own' })
    expect(body.ranked.entries[1]).toMatchObject({ domain: 'rival.com', count: 2, surfaceClass: 'direct-competitor' })
    expect(body.ranked.entries[2]).toMatchObject({ domain: 'acme.io', count: 1, surfaceClass: 'own' })

    // all 6 long-tail 'other' domains surface (old cap was 5/category)
    const domains = body.ranked.entries.map((e: { domain: string }) => e.domain)
    for (const d of ['g1.io', 'g2.io', 'g3.io', 'g4.io', 'g5.io', 'g6.io']) expect(domains).toContain(d)
  })

  it('tags every ranked domain with category + surface class', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources' })
    const body = JSON.parse(res.payload)
    const byDomain: Record<string, { surfaceClass: string; category: string }> = {}
    for (const e of body.ranked.entries) byDomain[e.domain] = e
    expect(byDomain['acme.io']!.surfaceClass).toBe('own')
    expect(byDomain['rival.com']!.surfaceClass).toBe('direct-competitor')
    expect(byDomain['booking.com']).toMatchObject({ surfaceClass: 'ota-aggregator', category: 'directory' })
    expect(byDomain['expedia.com']!.surfaceClass).toBe('ota-aggregator')
    expect(byDomain['forbes.com']).toMatchObject({ surfaceClass: 'editorial-media', category: 'news' })
    expect(byDomain['reddit.com']).toMatchObject({ surfaceClass: 'other', category: 'forum' })
  })

  it('computes each ranked entry percentage as count / totalCitedSlots (4dp)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources' })
    const body = JSON.parse(res.payload)
    const byDomain: Record<string, { count: number; percentage: number }> = {}
    for (const e of body.ranked.entries) byDomain[e.domain] = e
    // denominator is totalCitedSlots (17), NOT domainTotal — pins numerator,
    // denominator, and the round4 rounding in one assertion.
    expect(byDomain['acme.com']!.percentage).toBe(0.1765) // 3/17 → round4
    expect(byDomain['rival.com']!.percentage).toBe(0.1176) // 2/17
    expect(byDomain['forbes.com']!.percentage).toBe(0.0588) // 1/17
  })

  it('rolls up cited slots by surface class over the FULL scope, summing to the total', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources' })
    const body = JSON.parse(res.payload)
    const roll: Record<string, { count: number; domainCount: number; percentage: number }> = {}
    for (const r of body.ranked.bySurfaceClass) roll[r.surfaceClass] = r

    expect(roll['own']).toMatchObject({ count: 4, domainCount: 2 })
    expect(roll['direct-competitor']).toMatchObject({ count: 2, domainCount: 1 })
    expect(roll['ota-aggregator']).toMatchObject({ count: 2, domainCount: 2 })
    expect(roll['editorial-media']).toMatchObject({ count: 1, domainCount: 1 })
    expect(roll['other']).toMatchObject({ count: 8, domainCount: 8 })

    // exact rollup percentages = class count / totalCitedSlots (17), 4dp
    expect(roll['own']!.percentage).toBe(0.2353) // 4/17
    expect(roll['other']!.percentage).toBe(0.4706) // 8/17

    const countSum = body.ranked.bySurfaceClass.reduce((s: number, r: { count: number }) => s + r.count, 0)
    const domainSum = body.ranked.bySurfaceClass.reduce((s: number, r: { domainCount: number }) => s + r.domainCount, 0)
    const pctSum = body.ranked.bySurfaceClass.reduce((s: number, r: { percentage: number }) => s + r.percentage, 0)
    expect(countSum).toBe(17)
    expect(domainSum).toBe(14)
    // 4dp per-class rounding can leave the sum a hair off 1 (here 0.9999).
    expect(pctSum).toBeCloseTo(1, 2)
  })

  it('excludes AI provider infrastructure domains from the ranked list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources' })
    const body = JSON.parse(res.payload)
    const domains = body.ranked.entries.map((e: { domain: string }) => e.domain)
    expect(domains).not.toContain('vertexaisearch.cloud.google.com')
    expect(domains).not.toContain('openai.com')
  })

  it('honors ?limit=N with an explicit long-tail rollup that preserves totals', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources?limit=3' })
    const body = JSON.parse(res.payload)

    expect(body.limit).toBe(3)
    expect(body.ranked.entries).toHaveLength(3)
    expect(body.ranked.domainTotal).toBe(14)
    expect(body.ranked.truncatedDomainCount).toBe(11) // 14 - 3
    // entries: acme.com(3) + rival.com(2) + acme.io(1) = 6; tail = 17 - 6
    const shown = body.ranked.entries.reduce((s: number, e: { count: number }) => s + e.count, 0)
    expect(shown).toBe(6)
    expect(body.ranked.truncatedCitedSlots).toBe(11)
    expect(shown + body.ranked.truncatedCitedSlots).toBe(body.ranked.totalCitedSlots)

    // the surface-class rollup still spans the full scope, not just the 3 shown
    const countSum = body.ranked.bySurfaceClass.reduce((s: number, r: { count: number }) => s + r.count, 0)
    expect(countSum).toBe(17)
  })

  it('breaks the ranking down by provider; per-provider counts reconcile to overall', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources' })
    const body = JSON.parse(res.payload)

    expect(Object.keys(body.byProvider).sort()).toEqual(['gemini', 'openai'])
    expect(body.byProvider.gemini.totalCitedSlots).toBe(13)
    expect(body.byProvider.gemini.domainTotal).toBe(11)
    expect(body.byProvider.openai.totalCitedSlots).toBe(4)
    expect(body.byProvider.openai.domainTotal).toBe(4)

    const find = (entries: Array<{ domain: string; count: number }>, d: string) =>
      entries.find(e => e.domain === d)?.count ?? 0

    // acme.com cited 3x by gemini; openai cites the acme.io alias instead.
    expect(find(body.byProvider.gemini.entries, 'acme.com')).toBe(3)
    expect(find(body.byProvider.openai.entries, 'acme.io')).toBe(1)
    // rival.com cited once by each provider, twice overall
    expect(find(body.byProvider.gemini.entries, 'rival.com')).toBe(1)
    expect(find(body.byProvider.openai.entries, 'rival.com')).toBe(1)
    expect(find(body.ranked.entries, 'rival.com')).toBe(2)

    // disjointness: a gemini-only domain never leaks into the openai cut
    expect(find(body.byProvider.openai.entries, 'g1.io')).toBe(0)
    expect(find(body.byProvider.gemini.entries, 'expedia.com')).toBe(0)

    // each provider's slots reconcile to the sum of its entry counts
    for (const p of ['gemini', 'openai'] as const) {
      const sum = body.byProvider[p].entries.reduce((s: number, e: { count: number }) => s + e.count, 0)
      expect(sum).toBe(body.byProvider[p].totalCitedSlots)
    }
    // the two providers' slots sum to the overall total
    expect(body.byProvider.gemini.totalCitedSlots + body.byProvider.openai.totalCitedSlots).toBe(body.ranked.totalCitedSlots)
  })

  it('applies the limit to each provider cut too', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources?limit=2' })
    const body = JSON.parse(res.payload)
    expect(body.byProvider.gemini.entries).toHaveLength(2)
    expect(body.byProvider.gemini.truncatedDomainCount).toBe(9) // 11 - 2
    expect(body.byProvider.openai.entries).toHaveLength(2) // openai has exactly 4 distinct
  })

  it('rejects a non-positive limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources?limit=0' })
    expect(res.statusCode).toBe(400)
  })

  it('omits a provider that produced a snapshot but no grounding sources from byProvider', async () => {
    // claude answered (a snapshot exists) but grounded on nothing — it must not
    // appear in byProvider at all (no empty bucket), so the keys stay the two
    // providers that actually cited sources.
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rank-site/analytics/sources' })
    const body = JSON.parse(res.payload)
    expect(Object.keys(body.byProvider).sort()).toEqual(['gemini', 'openai'])
    expect(body.byProvider.claude).toBeUndefined()
  })

  it('returns the full list (no truncation, echoed limit) when limit >= domainTotal', async () => {
    for (const n of [14, 99]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/rank-site/analytics/sources?limit=${n}` })
      const body = JSON.parse(res.payload)
      expect(body.limit).toBe(n) // echoed, not nulled
      expect(body.ranked.entries).toHaveLength(14) // all domains, none dropped
      expect(body.ranked.truncatedDomainCount).toBe(0)
      expect(body.ranked.truncatedCitedSlots).toBe(0)
    }
  })

  it('returns the real runId and an empty ranked list when a run produced only infra grounding', async () => {
    // Distinct from the no-runs case: this project HAS a completed run, but every
    // grounding source is filtered as provider infra. The handler skips the
    // early empty return, exercises the zero-denominator percentage guards, and
    // must still anchor to the real run id (not '').
    const projId = crypto.randomUUID()
    db.insert(projects).values({
      id: projId, name: 'infra-only', displayName: 'Infra Only', canonicalDomain: 'infra.com',
      ownedDomains: [], country: 'US', language: 'en', tags: [], labels: {},
      providers: ['gemini'], locations: [], defaultLocation: null,
      configSource: 'api', configRevision: 1, createdAt: iso, updatedAt: iso,
    }).run()
    const qId2 = crypto.randomUUID()
    db.insert(queries).values({ id: qId2, projectId: projId, query: 'infra q', createdAt: iso }).run()
    const realRun = crypto.randomUUID()
    db.insert(runs).values({
      id: realRun, projectId: projId, kind: 'answer-visibility', status: 'completed',
      trigger: 'manual', location: null, startedAt: iso, finishedAt: iso, error: null, createdAt: iso,
    }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId: realRun, queryId: qId2, provider: 'gemini',
      model: 'gemini-2.5-flash', citationState: 'not-cited', answerText: 'x',
      citedDomains: [], competitorOverlap: [], location: null,
      rawResponse: JSON.stringify({
        groundingSources: [{ uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/Q', title: 'proxy' }],
      }),
      createdAt: iso,
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/infra-only/analytics/sources' })
    const body = JSON.parse(res.payload)
    expect(body.runId).toBe(realRun) // anchored to the real run, not ''
    expect(body.ranked).toMatchObject({ totalCitedSlots: 0, domainTotal: 0, entries: [], truncatedDomainCount: 0, truncatedCitedSlots: 0, bySurfaceClass: [] })
    expect(body.byProvider).toEqual({}) // gemini produced no usable domains → omitted
  })

  it('returns an empty-but-valid shape for a project with no runs', async () => {
    const emptyId = crypto.randomUUID()
    db.insert(projects).values({
      id: emptyId, name: 'empty-rank', displayName: 'Empty', canonicalDomain: 'empty.com',
      ownedDomains: [], country: 'US', language: 'en', tags: [], labels: {},
      providers: ['gemini'], locations: [], defaultLocation: null,
      configSource: 'api', configRevision: 1, createdAt: iso, updatedAt: iso,
    }).run()
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-rank/analytics/sources' })
    const body = JSON.parse(res.payload)
    expect(body.ranked).toMatchObject({ totalCitedSlots: 0, domainTotal: 0, entries: [], truncatedDomainCount: 0, truncatedCitedSlots: 0, bySurfaceClass: [] })
    expect(body.byProvider).toEqual({})
    expect(body.limit).toBeNull()
  })
})
