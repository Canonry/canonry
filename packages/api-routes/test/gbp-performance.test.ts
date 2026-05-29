import crypto from 'node:crypto'
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, runs, gbpDailyMetrics, gbpKeywordImpressions } from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'
import { googleRoutes } from '../src/google.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-perf-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  let lastSyncCall: { runId: string; projectId: string; opts: unknown } | null = null

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    throw error
  })
  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({ clientId: 'id', clientSecret: 'secret' }),
    googleConnectionStore: {
      listConnections: () => [],
      getConnection: (domain, type) => type === 'gbp'
        ? { domain, connectionType: 'gbp', accessToken: 'tok', refreshToken: 'r', createdAt: 'x', updatedAt: 'x' }
        : undefined,
      upsertConnection: (c) => c,
      updateConnection: () => undefined,
      deleteConnection: () => true,
    },
    googleStateSecret: 'test-secret-32-bytes-long-enough!',
    onGbpSyncRequested: (runId, projectId, opts) => { lastSyncCall = { runId, projectId, opts } },
  })

  function seedProject(name: string, canonicalDomain: string): string {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain, country: 'US', language: 'en',
      ownedDomains: '[]', tags: '[]', labels: '{}', providers: '[]', locations: '[]',
      defaultLocation: null, autoExtractBacklinks: 0, configSource: 'cli', configRevision: 1,
      createdAt: now, updatedAt: now,
    }).run()
    return id
  }

  return { app, db, tmpDir, seedProject, getLastSyncCall: () => lastSyncCall }
}

describe('GBP performance routes (Phase 2)', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(async () => {
    ctx = buildApp()
    await ctx.app.ready()
  })
  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  describe('POST /gbp/sync', () => {
    it('creates a gbp-sync run and fires the callback', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      const res = await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/sync', payload: { daysOfMetrics: 30 } })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { runId: string; status: string }
      expect(body.status).toBe('running')

      const run = ctx.db.select().from(runs).where(eq(runs.id, body.runId)).get()
      expect(run?.kind).toBe('gbp-sync')
      expect(run?.projectId).toBe(projectId)

      const call = ctx.getLastSyncCall()
      expect(call?.runId).toBe(body.runId)
      expect(call?.opts).toMatchObject({ daysOfMetrics: 30 })
    })

  })

  describe('GET /gbp/metrics', () => {
    it('returns stored daily metrics with totals shape', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      for (const [date, metric, value] of [
        ['2026-05-01', 'WEBSITE_CLICKS', 10],
        ['2026-05-02', 'WEBSITE_CLICKS', 5],
        ['2026-05-01', 'CALL_CLICKS', 2],
      ] as const) {
        ctx.db.insert(gbpDailyMetrics).values({
          id: crypto.randomUUID(), projectId, locationName: 'locations/1', date, metric, value, syncRunId: null,
        }).run()
      }
      const res = await ctx.app.inject({ method: 'GET', url: '/projects/hotels/gbp/metrics' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { metrics: unknown[]; total: number }
      expect(body.total).toBe(3)
    })

    it('filters by metric', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.db.insert(gbpDailyMetrics).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', date: '2026-05-01', metric: 'WEBSITE_CLICKS', value: 10, syncRunId: null }).run()
      ctx.db.insert(gbpDailyMetrics).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', date: '2026-05-01', metric: 'CALL_CLICKS', value: 2, syncRunId: null }).run()
      const res = await ctx.app.inject({ method: 'GET', url: '/projects/hotels/gbp/metrics?metric=WEBSITE_CLICKS' })
      const body = res.json() as { metrics: { metric: string }[]; total: number }
      expect(body.total).toBe(1)
      expect(body.metrics[0]!.metric).toBe('WEBSITE_CLICKS')
    })
  })

  describe('GET /gbp/keywords', () => {
    it('computes thresholdedPct and sorts exact values first', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      // 1 exact + 3 thresholded → 75% thresholded.
      const rows = [
        { keyword: 'hotels', valueCount: 10939, valueThreshold: null },
        { keyword: 'a', valueCount: null, valueThreshold: 15 },
        { keyword: 'b', valueCount: null, valueThreshold: 15 },
        { keyword: 'c', valueCount: null, valueThreshold: 15 },
      ]
      for (const r of rows) {
        ctx.db.insert(gbpKeywordImpressions).values({
          id: crypto.randomUUID(), projectId, locationName: 'locations/1', month: '2026-05',
          keyword: r.keyword, valueCount: r.valueCount, valueThreshold: r.valueThreshold, syncRunId: null,
        }).run()
      }
      const res = await ctx.app.inject({ method: 'GET', url: '/projects/hotels/gbp/keywords' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { keywords: { keyword: string; valueCount: number | null }[]; total: number; thresholdedPct: number }
      expect(body.total).toBe(4)
      expect(body.thresholdedPct).toBe(75)
      // Exact-value keyword sorts first.
      expect(body.keywords[0]!.keyword).toBe('hotels')
      expect(body.keywords[0]!.valueCount).toBe(10939)
    })

    it('returns thresholdedPct=0 for an empty project', async () => {
      ctx.seedProject('empty', 'empty.example.com')
      const res = await ctx.app.inject({ method: 'GET', url: '/projects/empty/gbp/keywords' })
      const body = res.json() as { total: number; thresholdedPct: number }
      expect(body.total).toBe(0)
      expect(body.thresholdedPct).toBe(0)
    })
  })
})
