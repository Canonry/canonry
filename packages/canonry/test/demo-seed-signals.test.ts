import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import {
  adsInsightsDaily,
  backlinkSummaries,
  bingCoverageSnapshots,
  conversionTrackingContracts,
  createClient,
  gaAiReferrals,
  gaDailyTotals,
  gbpLocations,
  gscDailyTotals,
  insights,
  migrate,
  projects,
  siteCrawlFindings,
  siteCrawlGraphNodes,
  siteCrawlSnapshots,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { seedDemoSignals } from '../src/demo/seed-signals.js'
import { createDemoSeedContext } from '../src/demo/types.js'

let tmpDir: string
let db: DatabaseClient
const context = createDemoSeedContext(new Date('2026-09-09T12:00:00.000Z'))

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-demo-signals-'))
  db = createClient(path.join(tmpDir, 'demo.db'))
  migrate(db)
  const now = context.now.toISOString()
  for (const project of [context.simple, context.portfolio]) {
    db.insert(projects).values({
      id: project.id,
      name: project.name,
      displayName: project.displayName,
      canonicalDomain: project.domain,
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
  }
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('seedDemoSignals', () => {
  it('stores broad synthetic signals and serves them through representative read routes', async () => {
    await seedDemoSignals(db, context)

    for (const project of [context.simple, context.portfolio]) {
      const where = eq(gscDailyTotals.projectId, project.id)
      expect(db.select().from(gscDailyTotals).where(where).all()).toHaveLength(14)
      expect(db.select().from(bingCoverageSnapshots).where(eq(bingCoverageSnapshots.projectId, project.id)).all().length).toBeGreaterThan(1)
      expect(db.select().from(gaDailyTotals).where(eq(gaDailyTotals.projectId, project.id)).all()).toHaveLength(14)
      expect(db.select().from(gaAiReferrals).where(eq(gaAiReferrals.projectId, project.id)).all().length).toBeGreaterThan(1)
      expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.projectId, project.id)).get()?.complete).toBe(true)
      expect(db.select().from(siteCrawlGraphNodes).where(eq(siteCrawlGraphNodes.projectId, project.id)).all().length).toBeGreaterThan(2)
      expect(db.select().from(siteCrawlFindings).where(eq(siteCrawlFindings.projectId, project.id)).all().length).toBeGreaterThan(1)
      expect(db.select().from(gbpLocations).where(eq(gbpLocations.projectId, project.id)).all()).toHaveLength(1)
      expect(db.select().from(backlinkSummaries).where(eq(backlinkSummaries.projectId, project.id)).all()).toHaveLength(1)
      expect(db.select().from(adsInsightsDaily).where(eq(adsInsightsDaily.projectId, project.id)).all().length).toBeGreaterThan(2)
      expect(db.select().from(conversionTrackingContracts).where(eq(conversionTrackingContracts.projectId, project.id)).all()).toHaveLength(1)
      const storedInsights = db.select().from(insights).where(eq(insights.projectId, project.id)).all()
      expect(storedInsights.length).toBeGreaterThan(1)
      expect(storedInsights.every((insight) => insight.title.length > 12)).toBe(true)
    }

    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      googleStateSecret: 'test-only-google-state-secret-32b',
      assessConversionTrackingIntegrity: async ({ contract }) => ({ contract, status: 'statically-consistent', findings: [], evaluatedAt: context.now.toISOString() }),
    })
    await app.ready()
    try {
      const gsc = await app.inject({ method: 'GET', url: `/api/v1/projects/${context.simple.name}/google/gsc/performance/daily?window=7d` })
      expect(gsc.statusCode).toBe(200)
      expect(JSON.parse(gsc.payload)).toMatchObject({ totals: { days: 7 } })
      expect(JSON.parse(gsc.payload).totals.clicks).toBeGreaterThan(0)

      const crawl = await app.inject({ method: 'GET', url: `/api/v1/projects/${context.simple.name}/technical-aeo/crawl` })
      expect(crawl.statusCode).toBe(200)
      expect(JSON.parse(crawl.payload)).toMatchObject({ hasCrawlData: true, complete: true, detailsAvailable: true })
      const graph = await app.inject({ method: 'GET', url: `/api/v1/projects/${context.simple.name}/technical-aeo/graph` })
      expect(graph.statusCode).toBe(200)
      expect(JSON.parse(graph.payload).nodes).toHaveLength(4)
      expect(JSON.parse(graph.payload).edges).toHaveLength(4)

      const ads = await app.inject({ method: 'GET', url: `/api/v1/projects/${context.simple.name}/ads/summary` })
      expect(ads.statusCode).toBe(200)
      expect(JSON.parse(ads.payload)).toMatchObject({ connected: true, campaignCount: 1, totals: { conversions: expect.any(Number) } })
      expect(JSON.parse(ads.payload).totals.impressions).toBeGreaterThan(0)
      const contracts = await app.inject({ method: 'GET', url: `/api/v1/projects/${context.simple.name}/conversion-tracking/contracts` })
      expect(contracts.statusCode).toBe(200)
      expect(JSON.parse(contracts.payload)).toMatchObject([{ name: 'Sample lead', eventName: 'generate_lead' }])
      const integrity = await app.inject({ method: 'GET', url: `/api/v1/projects/${context.simple.name}/conversion-tracking/contracts/demo-signals-${context.simple.id}-conversion/integrity` })
      expect(integrity.statusCode).toBe(200)
      expect(JSON.parse(integrity.payload)).toMatchObject({ assessment: { status: 'statically-consistent', contract: { name: 'Sample lead' } } })
    } finally {
      await app.close()
    }
  })
})
