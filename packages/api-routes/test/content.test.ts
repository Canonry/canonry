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
  keywords,
  competitors,
  runs,
  querySnapshots,
  gscSearchData,
  gaTrafficSnapshots,
  gaAiReferrals,
} from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'

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

  const keywordIds = new Map<string, string>()
  for (const def of queryDefs) {
    const id = crypto.randomUUID()
    keywordIds.set(def.key, id)
    db.insert(keywords).values({
      id,
      projectId,
      keyword: def.query,
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
    keywordId: keywordIds.get('q1_create')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: JSON.stringify(['competitor-a.com', 'competitor-b.com', 'competitor-c.com']),
    rawResponse: JSON.stringify({
      groundingSources: [
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
    keywordId: keywordIds.get('q2_refresh')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: JSON.stringify(['competitor-a.com', 'competitor-b.com']),
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
    keywordId: keywordIds.get('q3_expand')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: JSON.stringify(['competitor-b.com']),
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
    keywordId: keywordIds.get('q4_addschema_eligible')!,
    provider: 'gemini',
    citationState: 'cited',
    competitorOverlap: JSON.stringify([]),
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
      db.insert(keywords).values({
        id: kwId,
        projectId,
        keyword: 'full url normalization',
        createdAt: now,
      }).run()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId: latestRunId,
        keywordId: kwId,
        provider: 'gemini',
        citationState: 'not-cited',
        competitorOverlap: JSON.stringify(['competitor-a.com']),
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
      db.insert(keywords).values({
        id: kwId,
        projectId,
        keyword: 'best api gateway',
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
        keywordId: kwId,
        provider: 'gemini',
        citationState: 'cited',
        competitorOverlap: JSON.stringify([]),
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
        keywordId: kwId,
        provider: 'gemini',
        citationState: 'not-cited',
        competitorOverlap: JSON.stringify(['competitor-a.com']),
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
        .select({ id: keywords.id })
        .from(keywords)
        .where(and(eq(keywords.projectId, projectId), eq(keywords.keyword, 'best email marketing software')))
        .get()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId: newRunId,
        keywordId: kwForQuery!.id,
        provider: 'gemini',
        citationState: 'not-cited',
        competitorOverlap: JSON.stringify(['competitor-a.com', 'competitor-b.com']),
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
      db.insert(keywords).values({
        id: kwId,
        projectId,
        keyword: 'observability platform',
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
          keywordId: kwId,
          provider,
          citationState: 'cited',
          competitorOverlap: JSON.stringify([]),
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
})
