import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  queries,
  competitors,
  runs,
  querySnapshots,
  gscSearchData,
  gaTrafficSnapshots,
  gaAiReferrals,
  domainClassifications,
  recommendationExplanations,
  recommendationBriefs,
} from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'
import type { SynthesizeContentBriefFn } from '../src/content.js'

import { contentRoutes } from '../src/content.js'

interface SeededProject {
  projectId: string
  latestRunId: string
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })
  return { app, db, tmpDir }
}

function seedProject(db: ReturnType<typeof createClient>): SeededProject {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'example',
    displayName: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  const competitorDomains = ['competitor-a.com', 'competitor-b.com', 'competitor-c.com']
  for (const domain of competitorDomains) {
    db.insert(competitors).values({
      id: crypto.randomUUID(),
      projectId,
      domain,
      createdAt: now,
    }).run()
  }

  const queryDefs: Array<{ key: string; query: string; isBlogShape: boolean }> = [
    { key: 'q1_create', query: 'best crm for saas', isBlogShape: true },
    { key: 'q2_refresh', query: 'best email marketing software', isBlogShape: true },
    { key: 'q3_expand', query: 'what is mrr', isBlogShape: true },
    { key: 'q4_addschema_eligible', query: 'saas billing guide', isBlogShape: true },
    { key: 'q5_filtered', query: 'buy crm software', isBlogShape: false },
  ]

  const queryIds = new Map<string, string>()
  for (const def of queryDefs) {
    const id = crypto.randomUUID()
    queryIds.set(def.key, id)
    db.insert(queries).values({
      id,
      projectId,
      query: def.query,
      createdAt: now,
    }).run()
  }

  const latestRunId = crypto.randomUUID()
  db.insert(runs).values({
    id: latestRunId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: now,
  }).run()

  // Q1: 3 competitors cited, our domain absent
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    queryId: queryIds.get('q1_create')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: ['competitor-a.com', 'competitor-b.com', 'competitor-c.com'],
    rawResponse: JSON.stringify({
      groundingSources: [
        // Q1's cited surface is dominated by a non-competitor aggregator
        // (crm-directory.example, 4 of 6 slots) plus two tracked competitors.
        // So the surface is winnable by default (competitors are ownable), and
        // a test can cede it by classifying the aggregator — without the
        // contradiction of labelling a tracked competitor an aggregator.
        { uri: 'https://crm-directory.example/best-crm', title: 'Best CRM Tools' },
        { uri: 'https://crm-directory.example/crm-reviews', title: 'CRM Reviews' },
        { uri: 'https://crm-directory.example/top-crm-2026', title: 'Top CRM 2026' },
        { uri: 'https://crm-directory.example/crm-comparison', title: 'CRM Comparison' },
        { uri: 'https://competitor-a.com/guides/crm', title: 'CRM Guide' },
        { uri: 'https://competitor-b.com/blog/best-crm', title: 'Best CRM' },
      ],
    }),
    createdAt: now,
  }).run()

  // Q2: 2 competitor citations in groundingSources
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    queryId: queryIds.get('q2_refresh')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: ['competitor-a.com', 'competitor-b.com'],
    rawResponse: JSON.stringify({
      groundingSources: [
        { uri: 'https://competitor-a.com/blog/email', title: 'Email Marketing' },
      ],
    }),
    createdAt: now,
  }).run()
  db.insert(gscSearchData).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    query: 'best email marketing software',
    page: '/blog/email-marketing-comparison',
    impressions: 2400,
    clicks: 95,
    ctr: '0.04',
    position: '4',
    createdAt: now,
  }).run()

  // Q3: occasionally cited (we have a page that ranks weak)
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    queryId: queryIds.get('q3_expand')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: ['competitor-b.com'],
    rawResponse: JSON.stringify({ groundingSources: [] }),
    createdAt: now,
  }).run()
  db.insert(gscSearchData).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    query: 'what is mrr',
    page: '/glossary/mrr',
    impressions: 800,
    clicks: 12,
    ctr: '0.015',
    position: '22',
    createdAt: now,
  }).run()

  // Q4: cited in groundingSources (our URL is in there)
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    queryId: queryIds.get('q4_addschema_eligible')!,
    provider: 'gemini',
    citationState: 'cited',
    competitorOverlap: [],
    rawResponse: JSON.stringify({
      groundingSources: [
        { uri: 'https://example.com/blog/saas-billing', title: 'SaaS Billing' },
      ],
    }),
    createdAt: now,
  }).run()
  db.insert(gscSearchData).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    query: 'saas billing guide',
    page: '/blog/saas-billing',
    impressions: 1200,
    clicks: 60,
    ctr: '0.05',
    position: '6',
    createdAt: now,
  }).run()

  // GA4 traffic per page
  for (const [page, sessions] of [
    ['/blog/email-marketing-comparison', 340],
    ['/blog/saas-billing', 580],
    ['/glossary/mrr', 110],
  ] as const) {
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: latestRunId,
      date: '2026-04-01',
      landingPage: page,
      sessions,
      organicSessions: sessions,
      users: sessions,
      syncedAt: now,
    }).run()
  }

  // GA4 AI referrals (project-level)
  db.insert(gaAiReferrals).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    source: 'chat.openai.com',
    medium: 'referral',
    sessions: 142,
    users: 130,
    syncedAt: now,
  }).run()

  return { projectId, latestRunId }
}

describe('content routes', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeEach(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.register(contentRoutes)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('GET /projects/:name/content/targets', () => {
    it('returns 404 when project does not exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/projects/missing/content/targets' })
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.payload).error.code).toBe('NOT_FOUND')
    })

    it('returns the response envelope with targets array and contextMetrics', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.targets).toBeInstanceOf(Array)
      expect(body.contextMetrics).toBeDefined()
      expect(body.contextMetrics.totalAiReferralSessions).toBe(142)
      expect(body.contextMetrics.latestRunId).toBeTruthy()
    })

    it('counts one AI-referral visit once, not once per attribution lens', async () => {
      const { projectId, latestRunId } = seedProject(db)
      // GA4 returns `session`, `first_user` and `manual_utm` as three separate
      // reports over the SAME visits — overlapping lenses, not disjoint
      // traffic. The seeded row above is the `session` lens (schema default);
      // these two describe the same 142 sessions from the other two angles.
      // Summing all three reported ~3x on live data (800 vs 264).
      for (const sourceDimension of ['first_user', 'manual_utm']) {
        db.insert(gaAiReferrals).values({
          id: crypto.randomUUID(),
          projectId,
          syncRunId: latestRunId,
          date: '2026-04-01',
          source: 'chat.openai.com',
          medium: 'referral',
          sourceDimension,
          sessions: 138,
          users: 126,
          syncedAt: new Date().toISOString(),
        }).run()
      }

      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      // 142, not 142 + 138 + 138 = 418.
      expect(body.contextMetrics.totalAiReferralSessions).toBe(142)
    })

    it('classifies Q1 as CREATE (no page) with competitor evidence demand source', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      const q1 = body.targets.find((t: { query: string }) => t.query === 'best crm for saas')
      expect(q1).toBeDefined()
      expect(q1.action).toBe('create')
      expect(q1.demandSource).toBe('competitor-evidence')
      expect(q1.ourBestPage).toBeNull()
      expect(q1.winningCompetitor).not.toBeNull()
    })

    it('classifies Q2 as REFRESH (strong SEO, not cited)', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      const q2 = body.targets.find((t: { query: string }) => t.query === 'best email marketing software')
      expect(q2).toBeDefined()
      expect(q2.action).toBe('refresh')
      expect(q2.ourBestPage.url).toBe('/blog/email-marketing-comparison')
      expect(q2.demandSource).toBe('both')
    })

    it('classifies Q3 as EXPAND (weak SEO, not cited)', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      const q3 = body.targets.find((t: { query: string }) => t.query === 'what is mrr')
      expect(q3).toBeDefined()
      expect(q3.action).toBe('expand')
    })

    it('omits Q4 because it is cited and schema audit unavailable (skip)', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      const q4 = body.targets.find((t: { query: string }) => t.query === 'saas billing guide')
      expect(q4).toBeUndefined()
    })

    it('omits Q5 (filtered out by isBlogShapedQuery)', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      const q5 = body.targets.find((t: { query: string }) => t.query === 'buy crm software')
      expect(q5).toBeUndefined()
    })

    it('respects limit query parameter', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets?limit=1' })
      const body = JSON.parse(res.payload)
      expect(body.targets.length).toBeLessThanOrEqual(1)
    })

    it('rejects invalid limit', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets?limit=-1' })
      expect(res.statusCode).toBe(400)
    })

    it('returns rows sorted by score descending', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      for (let i = 1; i < body.targets.length; i++) {
        expect(body.targets[i].score).toBeLessThanOrEqual(body.targets[i - 1].score)
      }
    })

    it('every target row has scoreBreakdown + drivers + actionConfidence', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      for (const target of body.targets) {
        expect(target.scoreBreakdown).toBeDefined()
        expect(target.drivers).toBeInstanceOf(Array)
        expect(target.actionConfidence).toMatch(/^(high|medium|low)$/)
        expect(target.targetRef).toBeTruthy()
      }
    })
  })

  describe('GET /projects/:name/content/targets winnabilityClass gate', () => {
    function classify(projectId: string, domain: string, competitorType: string) {
      db.insert(domainClassifications).values({
        id: crypto.randomUUID(),
        projectId,
        domain,
        competitorType,
        hits: 5,
        sessionId: 'sess_test',
        updatedAt: new Date().toISOString(),
      }).run()
    }

    it('keeps every target ownable when no cited surface is an aggregator/editorial', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      expect(body.targets.length).toBeGreaterThan(0)
      // Nothing is a ceded surface here: competitor citations resolve to a real
      // ownable verdict via the shared classifier, and a query with no recognized
      // cited surface fails open to ownable. Neither path yields `ceded`.
      for (const t of body.targets) {
        expect(t.winnabilityClass).toBe('ownable')
      }
    })

    it("marks 'best crm for saas' ceded once its cited surface is classified as aggregators", async () => {
      const { projectId } = seedProject(db)
      // Q1's cited surface is crm-directory.example (4 slots) + two tracked
      // competitors (1 each). Classifying the aggregator cedes 4 of 6 slots.
      classify(projectId, 'crm-directory.example', 'ota-aggregator')

      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      const q1 = body.targets.find((t: { query: string }) => t.query === 'best crm for saas')
      expect(q1.winnabilityClass).toBe('ceded')
      expect(q1.winnability).toBeCloseTo(1 - 4 / 6, 5)
    })

    it('?winnability-class=ownable excludes ceded rows; ?winnability-class=ceded returns only ceded', async () => {
      const { projectId } = seedProject(db)
      classify(projectId, 'crm-directory.example', 'ota-aggregator')

      const ownableRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets?winnability-class=ownable' })
      const ownable = JSON.parse(ownableRes.payload).targets
      expect(ownable.every((t: { winnabilityClass: string }) => t.winnabilityClass === 'ownable')).toBe(true)
      expect(ownable.find((t: { query: string }) => t.query === 'best crm for saas')).toBeUndefined()

      const cededRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets?winnability-class=ceded' })
      const ceded = JSON.parse(cededRes.payload).targets
      expect(ceded.length).toBeGreaterThan(0)
      expect(ceded.every((t: { winnabilityClass: string }) => t.winnabilityClass === 'ceded')).toBe(true)
    })

    it('?ownable=true is a convenience alias for winnability-class=ownable', async () => {
      const { projectId } = seedProject(db)
      classify(projectId, 'crm-directory.example', 'ota-aggregator')
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets?ownable=true' })
      const targets = JSON.parse(res.payload).targets
      expect(targets.every((t: { winnabilityClass: string }) => t.winnabilityClass === 'ownable')).toBe(true)
    })

    it('orders ownable rows ahead of ceded rows by default', async () => {
      const { projectId } = seedProject(db)
      classify(projectId, 'crm-directory.example', 'ota-aggregator')
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targets = JSON.parse(res.payload).targets as Array<{ winnabilityClass: string }>
      const firstCeded = targets.findIndex((t) => t.winnabilityClass === 'ceded')
      const lastOwnable = targets.map((t) => t.winnabilityClass).lastIndexOf('ownable')
      if (firstCeded !== -1 && lastOwnable !== -1) {
        expect(firstCeded).toBeGreaterThan(lastOwnable)
      }
    })

    it('rejects an invalid winnability-class value with 400', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets?winnability-class=winnable' })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toContain('winnability-class')
    })

    it('rejects the legacy surface-class filter instead of silently ignoring it', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets?surface-class=ownable' })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toContain('winnability-class')
    })
  })

  describe('GET /projects/:name/content/sources', () => {
    it('returns 404 when project does not exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/projects/missing/content/sources' })
      expect(res.statusCode).toBe(404)
    })

    it('returns response with sources array and latestRunId', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/sources' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.sources).toBeInstanceOf(Array)
      expect(body.latestRunId).toBeTruthy()
    })

    it('marks our domain URLs distinct from competitor URLs', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/sources' })
      const body = JSON.parse(res.payload)
      const q4 = body.sources.find((s: { query: string }) => s.query === 'saas billing guide')
      expect(q4).toBeDefined()
      const ours = q4.groundingSources.filter((g: { isOurDomain: boolean }) => g.isOurDomain)
      expect(ours).toHaveLength(1)
      expect(ours[0].domain).toBe('example.com')
    })
  })

  describe('GET /projects/:name/content/gaps', () => {
    it('returns gap rows for queries with competitor evidence', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/gaps' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.gaps).toBeInstanceOf(Array)
      const q1 = body.gaps.find((g: { query: string }) => g.query === 'best crm for saas')
      expect(q1).toBeDefined()
      expect(q1.competitorCount).toBeGreaterThan(0)
      expect(q1.missRate).toBeGreaterThan(0)
    })

    it('omits queries that have no competitor citations', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/gaps' })
      const body = JSON.parse(res.payload)
      const q4 = body.gaps.find((g: { query: string }) => g.query === 'saas billing guide')
      expect(q4).toBeUndefined()
    })
  })

  describe('regression: filters runs by kind = answer-visibility', () => {
    it('latestRunId points to an AV run even when a newer non-AV run exists', async () => {
      const { latestRunId: avRunId, projectId } = seedProject(db)

      // Insert a newer gsc-sync run; without a kind filter this would shadow
      // the AV run as the "latest" and make snapshot evidence empty.
      const newerSyncRunId = crypto.randomUUID()
      const newer = new Date(Date.now() + 60_000).toISOString()
      db.insert(runs).values({
        id: newerSyncRunId,
        projectId,
        kind: 'gsc-sync',
        status: 'completed',
        trigger: 'manual',
        createdAt: newer,
      }).run()

      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      expect(body.contextMetrics.latestRunId).toBe(avRunId)
      expect(body.targets.length).toBeGreaterThan(0)
    })
  })

  describe('regression: GSC page stored as full URL is normalized to a path', () => {
    it('joins GSC pages stored as full URLs against GA4 traffic and reports organicSessions', async () => {
      const { projectId, latestRunId } = seedProject(db)

      // GSC API returns full URLs for url-prefix properties. Add a query +
      // GA4 row with a matching path; the lookup must succeed.
      const fullUrl = 'https://example.com/blog/full-url-page'
      const path = '/blog/full-url-page'
      const now = new Date().toISOString()
      const kwId = crypto.randomUUID()
      db.insert(queries).values({
        id: kwId,
        projectId,
        query: 'full url normalization',
        createdAt: now,
      }).run()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId: latestRunId,
        queryId: kwId,
        provider: 'gemini',
        citationState: 'not-cited',
        competitorOverlap: ['competitor-a.com'],
        rawResponse: JSON.stringify({ groundingSources: [] }),
        createdAt: now,
      }).run()
      db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId: latestRunId,
        date: '2026-04-01',
        query: 'full url normalization',
        page: fullUrl,
        impressions: 500,
        clicks: 20,
        ctr: '0.04',
        position: '5',
        createdAt: now,
      }).run()
      db.insert(gaTrafficSnapshots).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId: latestRunId,
        date: '2026-04-01',
        landingPage: path,
        sessions: 222,
        organicSessions: 222,
        users: 222,
        syncedAt: now,
      }).run()

      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      const row = body.targets.find((t: { query: string }) => t.query === 'full url normalization')
      expect(row).toBeDefined()
      expect(row.ourBestPage.url).toBe(path)
      expect(row.ourBestPage.organicSessions).toBe(222)
    })
  })

  describe('regression: cited-state reflects the latest run, not the window union', () => {
    it('still surfaces a target when an older run cited us but the latest run misses', async () => {
      // Seed a project from scratch so we control every run + snapshot.
      const projectId = crypto.randomUUID()
      const now = new Date()
      const isoNow = now.toISOString()
      db.insert(projects).values({
        id: projectId,
        name: 'staletest',
        displayName: 'Stale',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        createdAt: isoNow,
        updatedAt: isoNow,
      }).run()
      db.insert(competitors).values({
        id: crypto.randomUUID(),
        projectId,
        domain: 'competitor-a.com',
        createdAt: isoNow,
      }).run()
      const kwId = crypto.randomUUID()
      db.insert(queries).values({
        id: kwId,
        projectId,
        query: 'best api gateway',
        createdAt: isoNow,
      }).run()

      // Older run: cited (we appear in groundingSources).
      const olderRunId = crypto.randomUUID()
      const older = new Date(now.getTime() - 60_000).toISOString()
      db.insert(runs).values({
        id: olderRunId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        createdAt: older,
      }).run()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId: olderRunId,
        queryId: kwId,
        provider: 'gemini',
        citationState: 'cited',
        competitorOverlap: [],
        rawResponse: JSON.stringify({
          groundingSources: [{ uri: 'https://example.com/blog/api-gateway', title: 'Old' }],
        }),
        createdAt: older,
      }).run()

      // Newer run: not cited (only competitors appear).
      const newerRunId = crypto.randomUUID()
      db.insert(runs).values({
        id: newerRunId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        createdAt: isoNow,
      }).run()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId: newerRunId,
        queryId: kwId,
        provider: 'gemini',
        citationState: 'not-cited',
        competitorOverlap: ['competitor-a.com'],
        rawResponse: JSON.stringify({
          groundingSources: [{ uri: 'https://competitor-a.com/api', title: 'Comp' }],
        }),
        createdAt: isoNow,
      }).run()
      db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId: newerRunId,
        date: '2026-04-01',
        query: 'best api gateway',
        page: '/blog/api-gateway',
        impressions: 1500,
        clicks: 30,
        ctr: '0.02',
        position: '6',
        createdAt: isoNow,
      }).run()

      const res = await app.inject({ method: 'GET', url: '/projects/staletest/content/targets' })
      const body = JSON.parse(res.payload)
      const row = body.targets.find((t: { query: string }) => t.query === 'best api gateway')
      // Old behavior would set ourPageInGroundingSources=true (any-window union)
      // and, with empty wpSchemaAudit, classifier returns null → no row.
      // New behavior: latest run misses → REFRESH (position 6, not currently cited).
      expect(row).toBeDefined()
      expect(row.action).toBe('refresh')
    })
  })

  describe('regression: targetRef does not include latestRunId', () => {
    it('produces the same targetRef across two runs with identical query/action/page', async () => {
      const { projectId } = seedProject(db)

      const firstRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const firstBody = JSON.parse(firstRes.payload)
      const firstRow = firstBody.targets.find(
        (t: { query: string }) => t.query === 'best email marketing software',
      )
      expect(firstRow).toBeDefined()
      const firstRef = firstRow.targetRef

      // Insert a fresh AV run with the same evidence shape; should not change targetRef.
      const newRunId = crypto.randomUUID()
      const later = new Date(Date.now() + 90_000).toISOString()
      db.insert(runs).values({
        id: newRunId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        createdAt: later,
      }).run()
      const kwForQuery = db
        .select({ id: queries.id })
        .from(queries)
        .where(and(eq(queries.projectId, projectId), eq(queries.query, 'best email marketing software')))
        .get()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId: newRunId,
        queryId: kwForQuery!.id,
        provider: 'gemini',
        citationState: 'not-cited',
        competitorOverlap: ['competitor-a.com', 'competitor-b.com'],
        rawResponse: JSON.stringify({
          groundingSources: [
            { uri: 'https://competitor-a.com/blog/email', title: 'Email' },
          ],
        }),
        createdAt: later,
      }).run()

      const secondRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const secondBody = JSON.parse(secondRes.payload)
      const secondRow = secondBody.targets.find(
        (t: { query: string }) => t.query === 'best email marketing software',
      )
      expect(secondRow).toBeDefined()
      expect(secondRow.targetRef).toBe(firstRef)
      expect(secondBody.contextMetrics.latestRunId).toBe(newRunId)
    })

    // Regression for the dismiss UX bug: a user marks a recommendation
    // addressed, refreshes, and the recommendation reappears because the
    // orchestrator picked a different "best matching owned page" between
    // runs — which used to flip the targetRef even though the
    // recommendation's intent (query + action) was identical. With
    // `targetPage` removed from the hash input, the ref is now stable
    // across that shift and the dismissal filter applies on subsequent
    // loads.
    it('produces the same targetRef when only the best-page candidate shifts', async () => {
      const { projectId, latestRunId } = seedProject(db)

      const before = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const beforeBody = JSON.parse(before.payload)
      const original = beforeBody.targets.find(
        (t: { query: string }) => t.query === 'best email marketing software',
      )
      expect(original).toBeDefined()

      // Shift the orchestrator's view of "best matching owned page" by
      // inserting a stronger GSC row pointing at a different blog slug
      // for the same query. The action stays 'refresh' (still poor SEO,
      // not cited), so the new recommendation IS conceptually the same;
      // only the inferred targetPage changes.
      db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId: latestRunId,
        date: '2026-04-01',
        query: 'best email marketing software',
        page: 'https://example.com/blog/email-marketing-2026-roundup',
        clicks: 80,
        impressions: 8000,
        ctr: '0.01',
        position: '4.2',
        createdAt: new Date().toISOString(),
      }).onConflictDoNothing().run()

      const after = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const afterBody = JSON.parse(after.payload)
      const updated = afterBody.targets.find(
        (t: { query: string }) => t.query === 'best email marketing software',
      )
      expect(updated).toBeDefined()
      // Same intent (query + action) → same ref, regardless of which page
      // the orchestrator picked as "ourBestPage" this time.
      expect(updated.targetRef).toBe(original.targetRef)
    })
  })

  describe('regression: filters by run status (no queued/failed runs become latest)', () => {
    it('latestRunId points at a completed run even when a queued run is newer', async () => {
      const { latestRunId, projectId } = seedProject(db)
      const queuedRunId = crypto.randomUUID()
      const later = new Date(Date.now() + 120_000).toISOString()
      db.insert(runs).values({
        id: queuedRunId,
        projectId,
        kind: 'answer-visibility',
        status: 'queued',
        trigger: 'manual',
        createdAt: later,
      }).run()

      const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const body = JSON.parse(res.payload)
      expect(body.contextMetrics.latestRunId).toBe(latestRunId)
    })
  })

  describe('regression: own-domain grounding tally preserves citationCount + providers', () => {
    it('aggregates our domain URL across providers the same way it does for competitors', async () => {
      // New project to control snapshot count.
      const projectId = crypto.randomUUID()
      const isoNow = new Date().toISOString()
      db.insert(projects).values({
        id: projectId,
        name: 'tally',
        displayName: 'Tally',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        createdAt: isoNow,
        updatedAt: isoNow,
      }).run()
      db.insert(competitors).values({
        id: crypto.randomUUID(),
        projectId,
        domain: 'competitor-a.com',
        createdAt: isoNow,
      }).run()
      const kwId = crypto.randomUUID()
      db.insert(queries).values({
        id: kwId,
        projectId,
        query: 'observability platform',
        createdAt: isoNow,
      }).run()
      const runId = crypto.randomUUID()
      db.insert(runs).values({
        id: runId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        createdAt: isoNow,
      }).run()

      // Two snapshots — same own URL cited from gemini and openai.
      for (const provider of ['gemini', 'openai']) {
        db.insert(querySnapshots).values({
          id: crypto.randomUUID(),
          runId,
          queryId: kwId,
          provider,
          citationState: 'cited',
          competitorOverlap: [],
          rawResponse: JSON.stringify({
            groundingSources: [
              { uri: 'https://example.com/blog/observability', title: 'Observability' },
            ],
          }),
          createdAt: isoNow,
        }).run()
      }

      const res = await app.inject({ method: 'GET', url: '/projects/tally/content/sources' })
      const body = JSON.parse(res.payload)
      const row = body.sources.find((s: { query: string }) => s.query === 'observability platform')
      expect(row).toBeDefined()
      const ours = row.groundingSources.filter((g: { isOurDomain: boolean }) => g.isOurDomain)
      expect(ours).toHaveLength(1)
      expect(ours[0].citationCount).toBe(2)
      expect(ours[0].providers.sort()).toEqual(['gemini', 'openai'])
    })
  })

  describe('content-target dismissals', () => {
    it('returns empty list when no dismissals exist', async () => {
      seedProject(db)
      const res = await app.inject({ method: 'GET', url: '/projects/example/content/dismissals' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.dismissals).toEqual([])
    })

    it('persists a dismissal and excludes the targetRef from /content/targets', async () => {
      seedProject(db)
      // Pick the first target's stable ref. We use Q1 ("best crm for saas")
      // because seedProject guarantees it surfaces.
      const before = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const q1 = JSON.parse(before.payload).targets.find((t: { query: string }) => t.query === 'best crm for saas')
      expect(q1).toBeDefined()
      const targetRef = q1.targetRef

      const dismissRes = await app.inject({
        method: 'POST',
        url: '/projects/example/content/dismissals',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ targetRef, addressedUrl: 'https://example.com/blog/crm-guide' }),
      })
      expect(dismissRes.statusCode).toBe(200)
      const dismissBody = JSON.parse(dismissRes.payload)
      expect(dismissBody.targetRef).toBe(targetRef)
      expect(dismissBody.addressedUrl).toBe('https://example.com/blog/crm-guide')
      expect(dismissBody.dismissedAt).toBeTruthy()

      // The target should be gone from the /content/targets response.
      const after = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const afterTargets = JSON.parse(after.payload).targets
      expect(afterTargets.find((t: { targetRef: string }) => t.targetRef === targetRef)).toBeUndefined()

      // And the dismissals listing should include it.
      const listRes = await app.inject({ method: 'GET', url: '/projects/example/content/dismissals' })
      const listBody = JSON.parse(listRes.payload)
      expect(listBody.dismissals).toHaveLength(1)
      expect(listBody.dismissals[0].targetRef).toBe(targetRef)
    })

    it('upserts: re-dismissing the same targetRef overwrites fields and refreshes timestamp', async () => {
      seedProject(db)
      const before = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(before.payload).targets[0].targetRef

      const first = await app.inject({
        method: 'POST',
        url: '/projects/example/content/dismissals',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ targetRef, note: 'initial' }),
      })
      expect(first.statusCode).toBe(200)
      const firstBody = JSON.parse(first.payload)
      expect(firstBody.note).toBe('initial')
      expect(firstBody.addressedUrl).toBeNull()

      // Small wait isn't reliable in a sync test; just assert the upsert
      // returns the new fields. The DB unique index guarantees there's
      // still only one row.
      const second = await app.inject({
        method: 'POST',
        url: '/projects/example/content/dismissals',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ targetRef, addressedUrl: 'https://example.com/page', note: 'updated' }),
      })
      expect(second.statusCode).toBe(200)
      const secondBody = JSON.parse(second.payload)
      expect(secondBody.note).toBe('updated')
      expect(secondBody.addressedUrl).toBe('https://example.com/page')

      const listRes = await app.inject({ method: 'GET', url: '/projects/example/content/dismissals' })
      const listBody = JSON.parse(listRes.payload)
      expect(listBody.dismissals).toHaveLength(1)
    })

    it('DELETE un-dismisses and the target reappears in /content/targets', async () => {
      seedProject(db)
      const before = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const beforeTargets = JSON.parse(before.payload).targets
      const targetRef = beforeTargets[0].targetRef
      const initialCount = beforeTargets.length

      await app.inject({
        method: 'POST',
        url: '/projects/example/content/dismissals',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ targetRef }),
      })

      const dismissedListRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      expect(JSON.parse(dismissedListRes.payload).targets.length).toBe(initialCount - 1)

      const undismissRes = await app.inject({
        method: 'DELETE',
        url: `/projects/example/content/dismissals/${targetRef}`,
      })
      expect(undismissRes.statusCode).toBe(204)

      const restored = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const restoredTargets = JSON.parse(restored.payload).targets
      expect(restoredTargets.length).toBe(initialCount)
      expect(restoredTargets.find((t: { targetRef: string }) => t.targetRef === targetRef)).toBeDefined()
    })

    it('DELETE returns 404 when no dismissal exists for that targetRef', async () => {
      seedProject(db)
      const res = await app.inject({
        method: 'DELETE',
        url: '/projects/example/content/dismissals/tgt_does_not_exist',
      })
      expect(res.statusCode).toBe(404)
    })

    it('POST rejects missing targetRef', async () => {
      seedProject(db)
      const res = await app.inject({
        method: 'POST',
        url: '/projects/example/content/dismissals',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ addressedUrl: 'https://example.com' }),
      })
      expect(res.statusCode).toBe(400)
    })

    it('POST rejects malformed URL', async () => {
      seedProject(db)
      const before = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(before.payload).targets[0].targetRef
      const res = await app.inject({
        method: 'POST',
        url: '/projects/example/content/dismissals',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ targetRef, addressedUrl: 'not-a-url' }),
      })
      expect(res.statusCode).toBe(400)
    })

    it('dismissals scoped to one project do not affect another project', async () => {
      seedProject(db)
      // Seed a second project. Reusing seedProject would clash on the
      // project name; create a minimal second project with no inventory so
      // /content/targets returns whatever the orchestrator produces.
      const otherId = crypto.randomUUID()
      const now = new Date().toISOString()
      db.insert(projects).values({
        id: otherId,
        name: 'other',
        displayName: 'Other',
        canonicalDomain: 'other.com',
        country: 'US',
        language: 'en',
        createdAt: now,
        updatedAt: now,
      }).run()

      const exampleTargets = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const exampleRef = JSON.parse(exampleTargets.payload).targets[0].targetRef

      await app.inject({
        method: 'POST',
        url: '/projects/example/content/dismissals',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ targetRef: exampleRef }),
      })

      const otherDismissals = await app.inject({ method: 'GET', url: '/projects/other/content/dismissals' })
      expect(JSON.parse(otherDismissals.payload).dismissals).toEqual([])
    })
  })
})

// ─── Recommendation explanation routes ──────────────────────────────────────
//
// Separate `describe` because these routes require the explainer to be wired
// in via `app.register(contentRoutes, { explainContentRecommendation })`.
// The default registration above has no explainer (mirrors production with
// no LLM provider configured).

describe('content recommendation explanation routes', () => {
  let app: ReturnType<typeof buildApp>['app']
  let db: ReturnType<typeof buildApp>['db']
  let tmpDir: string
  /** Per-test mutable state so each test can swap the explainer behavior. */
  let mockState: {
    callCount: number
    lastInput: unknown
    response: {
      promptVersion: string
      provider: string
      model: string
      responseText: string
      costMillicents: number
    } | (() => never)
  }

  beforeEach(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    mockState = {
      callCount: 0,
      lastInput: null,
      response: {
        promptVersion: 'v1',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        responseText: '- First reason\n- Action\n- Outcome',
        costMillicents: 42,
      },
    }
    await app.register(contentRoutes, {
      explainContentRecommendation: async (input) => {
        mockState.callCount++
        mockState.lastInput = input
        if (typeof mockState.response === 'function') mockState.response()
        return mockState.response as Exclude<typeof mockState.response, () => never>
      },
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('GET /projects/:name/content/recommendations/:targetRef/analysis', () => {
    it('returns 404 when project does not exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/projects/missing/content/recommendations/tgt_x/analysis',
      })
      expect(res.statusCode).toBe(404)
    })

    it('returns 404 when no cached explanation exists', async () => {
      seedProject(db)
      const targetsRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef
      const res = await app.inject({
        method: 'GET',
        url: `/projects/example/content/recommendations/${targetRef}/analysis`,
      })
      expect(res.statusCode).toBe(404)
    })

    it('returns the cached explanation after a successful POST', async () => {
      seedProject(db)
      const targetsRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef

      // Populate the cache.
      await app.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })

      const res = await app.inject({
        method: 'GET',
        url: `/projects/example/content/recommendations/${targetRef}/analysis`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.targetRef).toBe(targetRef)
      expect(body.promptVersion).toBe('v1')
      expect(body.provider).toBe('claude')
      expect(body.model).toBe('claude-sonnet-4-6')
      expect(body.responseText).toBe('- First reason\n- Action\n- Outcome')
      expect(body.costMillicents).toBe(42)
      expect(body.generatedAt).toBeTruthy()
    })
  })

  describe('POST /projects/:name/content/recommendations/:targetRef/analyze', () => {
    it('returns 404 when project does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/projects/missing/content/recommendations/tgt_x/analyze',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })
      expect(res.statusCode).toBe(404)
    })

    it('returns 404 when targetRef does not match any current recommendation', async () => {
      seedProject(db)
      const res = await app.inject({
        method: 'POST',
        url: '/projects/example/content/recommendations/tgt_not_a_real_ref/analyze',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })
      expect(res.statusCode).toBe(404)
      expect(mockState.callCount).toBe(0)
    })

    it('invokes the explainer on first call and persists the response', async () => {
      seedProject(db)
      const targetsRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef

      const res = await app.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })
      expect(res.statusCode).toBe(200)
      expect(mockState.callCount).toBe(1)

      const body = JSON.parse(res.payload)
      expect(body.responseText).toBe('- First reason\n- Action\n- Outcome')
      expect(body.promptVersion).toBe('v1')

      // The input the explainer received carries the full recommendation +
      // project context — the helper relies on these fields.
      const input = mockState.lastInput as {
        projectName: string
        canonicalDomain: string
        recommendation: { targetRef: string; query: string }
      }
      expect(input.projectName).toBe('example')
      expect(input.canonicalDomain).toBe('example.com')
      expect(input.recommendation.targetRef).toBe(targetRef)
      expect(input.recommendation.query).toBeTruthy()
    })

    it('returns the cached row on a second call without invoking the explainer again', async () => {
      seedProject(db)
      const targetsRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef

      const first = await app.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })
      expect(first.statusCode).toBe(200)
      expect(mockState.callCount).toBe(1)

      const second = await app.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })
      expect(second.statusCode).toBe(200)
      // Cache hit — explainer must not have been called a second time.
      expect(mockState.callCount).toBe(1)
      expect(JSON.parse(second.payload).generatedAt).toBe(JSON.parse(first.payload).generatedAt)
    })

    it('forceRefresh bypasses the cache and overwrites the stored explanation', async () => {
      seedProject(db)
      const targetsRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef

      await app.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })
      expect(mockState.callCount).toBe(1)

      // Swap the mock response so we can prove the second call's payload
      // actually got persisted.
      mockState.response = {
        promptVersion: 'v1',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        responseText: '- Refreshed reason',
        costMillicents: 7,
      }

      const second = await app.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ forceRefresh: true }),
      })
      expect(second.statusCode).toBe(200)
      expect(mockState.callCount).toBe(2)
      const body = JSON.parse(second.payload)
      expect(body.provider).toBe('gemini')
      expect(body.responseText).toBe('- Refreshed reason')

      // A subsequent GET should return the refreshed row, not the original.
      const cached = await app.inject({
        method: 'GET',
        url: `/projects/example/content/recommendations/${targetRef}/analysis`,
      })
      expect(JSON.parse(cached.payload).provider).toBe('gemini')
    })

    it('passes through provider + model overrides to the explainer', async () => {
      seedProject(db)
      const targetsRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef

      const res = await app.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ provider: 'openai', model: 'gpt-5-mini' }),
      })
      expect(res.statusCode).toBe(200)
      const input = mockState.lastInput as { providerOverride?: string; modelOverride?: string }
      expect(input.providerOverride).toBe('openai')
      expect(input.modelOverride).toBe('gpt-5-mini')
    })

    it('rejects an invalid body shape with 400', async () => {
      seedProject(db)
      const targetsRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef

      const res = await app.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ forceRefresh: 'yes' }),
      })
      expect(res.statusCode).toBe(400)
      expect(mockState.callCount).toBe(0)
    })
  })

  describe('without an explainer wired in', () => {
    let bareApp: ReturnType<typeof buildApp>['app']
    let bareDb: ReturnType<typeof buildApp>['db']
    let bareTmpDir: string

    beforeEach(async () => {
      const ctx = buildApp()
      bareApp = ctx.app
      bareDb = ctx.db
      bareTmpDir = ctx.tmpDir
      // No `explainContentRecommendation` — production state when no LLM
      // provider is configured.
      await bareApp.register(contentRoutes)
      await bareApp.ready()
    })

    afterEach(async () => {
      await bareApp.close()
      fs.rmSync(bareTmpDir, { recursive: true, force: true })
    })

    it('POST returns PROVIDER_ERROR when no explainer is wired', async () => {
      seedProject(bareDb)
      const targetsRes = await bareApp.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef
      const res = await bareApp.inject({
        method: 'POST',
        url: `/projects/example/content/recommendations/${targetRef}/analyze`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })
      expect(res.statusCode).toBe(502)
      expect(JSON.parse(res.payload).error.code).toBe('PROVIDER_ERROR')
    })

    it('GET still works as a cache-only read when no explainer is wired', async () => {
      seedProject(bareDb)
      const targetsRes = await bareApp.inject({ method: 'GET', url: '/projects/example/content/targets' })
      const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef
      const res = await bareApp.inject({
        method: 'GET',
        url: `/projects/example/content/recommendations/${targetRef}/analysis`,
      })
      // No prior write means 404 — but the route doesn't depend on the
      // explainer for read access.
      expect(res.statusCode).toBe(404)
    })
  })
})

// ─── Content brief routes (Feature B) ────────────────────────────────────────

describe('content brief routes', () => {
  let app: ReturnType<typeof buildApp>['app']
  let db: ReturnType<typeof buildApp>['db']
  let tmpDir: string
  let briefState: { callCount: number; throwError: Error | null }

  const stubSynthesizer: SynthesizeContentBriefFn = async (input) => {
    briefState.callCount++
    if (briefState.throwError) throw briefState.throwError
    return {
      promptVersion: 'v1',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      brief: {
        targetQuery: input.recommendation.query,
        winnabilityClass: input.recommendation.winnabilityClass,
        angle: 'Differentiated first-party angle',
        whyWinnable: 'Cited surface is rivals, not aggregators.',
        schemaHookup: 'FAQPage + Product',
        controllableSurfaceRationale: 'Direct competitors cited — controllable.',
      },
      costMillicents: 88,
    }
  }

  beforeEach(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    briefState = { callCount: 0, throwError: null }
    await app.register(contentRoutes, {
      // Register both so the cache-isolation test can write an explanation too.
      explainContentRecommendation: async () => ({
        promptVersion: 'v1', provider: 'claude', model: 'claude-sonnet-4-6',
        responseText: '- prose explanation', costMillicents: 5,
      }),
      briefContentRecommendation: stubSynthesizer,
      briefPromptVersion: 'v1',
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function classify(projectId: string, domain: string, competitorType: string) {
    db.insert(domainClassifications).values({
      id: crypto.randomUUID(), projectId, domain, competitorType, hits: 5,
      sessionId: 'sess', updatedAt: new Date().toISOString(),
    }).run()
  }

  async function ownableTargetRef(query = 'best crm for saas'): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/projects/example/content/targets?winnability-class=ownable' })
    const targets = JSON.parse(res.payload).targets
    const target = targets.find((t: { query: string }) => t.query === query) ?? targets[0]
    expect(target).toBeDefined()
    return target.targetRef
  }

  it('synthesizes a structured brief for an ownable target', async () => {
    seedProject(db)
    const targetRef = await ownableTargetRef()
    const res = await app.inject({
      method: 'POST',
      url: `/projects/example/content/recommendations/${targetRef}/brief`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.targetRef).toBe(targetRef)
    expect(body.brief.angle).toBe('Differentiated first-party angle')
    expect(body.brief.winnabilityClass).toBe('ownable')
    expect(body.brief.schemaHookup).toBe('FAQPage + Product')
    expect(body.costMillicents).toBe(88)
    expect(briefState.callCount).toBe(1)
  })

  it('rejects a ceded target with 400 and never calls the synthesizer', async () => {
    const { projectId } = seedProject(db)
    classify(projectId, 'crm-directory.example', 'ota-aggregator')
    const cededRes = await app.inject({ method: 'GET', url: '/projects/example/content/targets?winnability-class=ceded' })
    const targetRef = JSON.parse(cededRes.payload).targets[0].targetRef

    const res = await app.inject({
      method: 'POST',
      url: `/projects/example/content/recommendations/${targetRef}/brief`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR')
    expect(briefState.callCount).toBe(0)
  })

  it('returns the cached brief on a second POST without forceRefresh', async () => {
    seedProject(db)
    const targetRef = await ownableTargetRef()
    const url = `/projects/example/content/recommendations/${targetRef}/brief`
    await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{}' })
    await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{}' })
    expect(briefState.callCount).toBe(1) // second call served from cache
  })

  it('re-synthesizes when forceRefresh is true', async () => {
    seedProject(db)
    const targetRef = await ownableTargetRef()
    const url = `/projects/example/content/recommendations/${targetRef}/brief`
    await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{}' })
    await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ forceRefresh: true }) })
    expect(briefState.callCount).toBe(2)
  })

  it('GET brief is a cache-only read: 404 before synthesis, the brief after', async () => {
    seedProject(db)
    const targetRef = await ownableTargetRef()
    const url = `/projects/example/content/recommendations/${targetRef}/brief`
    const before = await app.inject({ method: 'GET', url })
    expect(before.statusCode).toBe(404)
    await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{}' })
    const after = await app.inject({ method: 'GET', url })
    expect(after.statusCode).toBe(200)
    expect(JSON.parse(after.payload).brief.angle).toBe('Differentiated first-party angle')
  })

  it('GET brief revalidates the current recommendation before returning a cached row', async () => {
    const { projectId } = seedProject(db)
    const targetRef = await ownableTargetRef('best crm for saas')
    const url = `/projects/example/content/recommendations/${targetRef}/brief`

    const first = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{}' })
    expect(first.statusCode).toBe(200)
    classify(projectId, 'crm-directory.example', 'ota-aggregator')

    const after = await app.inject({ method: 'GET', url })
    expect(after.statusCode).toBe(400)
    expect(JSON.parse(after.payload).error.code).toBe('VALIDATION_ERROR')
    expect(briefState.callCount).toBe(1)
  })

  it('brief and explanation caches are isolated (dedicated tables, no bleed)', async () => {
    seedProject(db)
    const targetRef = await ownableTargetRef()
    // Write a brief and an explanation for the SAME (project, targetRef).
    await app.inject({ method: 'POST', url: `/projects/example/content/recommendations/${targetRef}/brief`, headers: { 'content-type': 'application/json' }, payload: '{}' })
    await app.inject({ method: 'POST', url: `/projects/example/content/recommendations/${targetRef}/analyze`, headers: { 'content-type': 'application/json' }, payload: '{}' })

    const briefRes = await app.inject({ method: 'GET', url: `/projects/example/content/recommendations/${targetRef}/brief` })
    const analysisRes = await app.inject({ method: 'GET', url: `/projects/example/content/recommendations/${targetRef}/analysis` })
    // GET brief returns the structured brief; GET analysis returns the prose —
    // never each other.
    expect(JSON.parse(briefRes.payload).brief).toBeDefined()
    expect(JSON.parse(briefRes.payload).responseText).toBeUndefined()
    expect(JSON.parse(analysisRes.payload).responseText).toBe('- prose explanation')
    expect(JSON.parse(analysisRes.payload).brief).toBeUndefined()
    // Both rows physically coexist.
    expect(db.select().from(recommendationBriefs).all()).toHaveLength(1)
    expect(db.select().from(recommendationExplanations).all()).toHaveLength(1)
  })

  it('404s when the targetRef matches no current recommendation', async () => {
    seedProject(db)
    const res = await app.inject({
      method: 'POST',
      url: '/projects/example/content/recommendations/tgt_not_real/brief',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET 404s when the targetRef matches no current recommendation', async () => {
    seedProject(db)
    const res = await app.inject({
      method: 'GET',
      url: '/projects/example/content/recommendations/tgt_not_real/brief',
    })
    expect(res.statusCode).toBe(404)
  })

  it('502s when no synthesizer is wired', async () => {
    const ctx = buildApp()
    await ctx.app.register(contentRoutes) // no briefContentRecommendation
    await ctx.app.ready()
    seedProject(ctx.db)
    const targetsRes = await ctx.app.inject({ method: 'GET', url: '/projects/example/content/targets' })
    const targetRef = JSON.parse(targetsRes.payload).targets[0].targetRef
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/projects/example/content/recommendations/${targetRef}/brief`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.payload).error.code).toBe('PROVIDER_ERROR')
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('GET domain-classifications returns the project rows ranked by hits', async () => {
    const { projectId } = seedProject(db)
    classify(projectId, 'booking.com', 'ota-aggregator')
    db.insert(domainClassifications).values({
      id: crypto.randomUUID(), projectId, domain: 'rival.com', competitorType: 'direct-competitor',
      hits: 99, sessionId: 'sess', updatedAt: new Date().toISOString(),
    }).run()

    const res = await app.inject({ method: 'GET', url: '/projects/example/content/domain-classifications' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.classifications).toHaveLength(2)
    expect(body.classifications[0].domain).toBe('rival.com') // highest hits first
    expect(body.classifications[0].competitorType).toBe('direct-competitor')
  })
})
