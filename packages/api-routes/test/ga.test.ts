import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { RunKinds, RunStatuses, RunTriggers, gaAttributionTrendResponseSchema, gaSocialReferralTrendResponseSchema } from '@ainyc/canonry-contracts'
import { createClient, migrate, gaAiReferrals, gaSocialReferrals, gaTrafficSnapshots, gaTrafficSummaries, gaTrafficWindowSummaries, gaDailyTotals, runs } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialStore, Ga4CredentialRecord } from '../src/ga.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  // In-memory credential store for tests
  const credentials: Map<string, Ga4CredentialRecord> = new Map()
  const ga4CredentialStore: Ga4CredentialStore = {
    getConnection: (projectName: string) => credentials.get(projectName),
    upsertConnection: (connection: Ga4CredentialRecord) => {
      credentials.set(connection.projectName, connection)
      return connection
    },
    deleteConnection: (projectName: string) => credentials.delete(projectName),
  }

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ga4CredentialStore })

  return { app, db, tmpDir, credentials }
}

describe('GA4 routes', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let credentials: Map<string, Ga4CredentialRecord>
  let projectId: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    credentials = ctx.credentials
    await app.ready()

    // Seed a project
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/test-project',
      payload: {
        displayName: 'Test Project',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    projectId = JSON.parse(res.payload).id
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('POST /ga/connect rejects missing propertyId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/ga/connect',
      payload: { keyJson: '{}' },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/propertyId/)
  })

  it('POST /ga/connect falls back to OAuth path when no keyJson provided', async () => {
    // No keyJson and no OAuth store configured → server returns 400 with OAuth guidance
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/ga/connect',
      payload: { propertyId: '123456' },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    // Should mention OAuth path, not keyJson requirement
    expect(body.error.message).toMatch(/oauth|google connect/i)
  })

  it('POST /ga/connect rejects invalid JSON in keyJson', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/ga/connect',
      payload: { propertyId: '123456', keyJson: 'not-json' },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/Invalid JSON/)
  })

  it('POST /ga/connect rejects JSON without required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/ga/connect',
      payload: { propertyId: '123456', keyJson: JSON.stringify({ foo: 'bar' }) },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/client_email/)
  })

  it('GET /ga/status returns not connected when no connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/status',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.connected).toBe(false)
    expect(body.propertyId).toBeNull()
  })

  it('GET /ga/status returns connected state when credentials exist', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@project.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/status',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.connected).toBe(true)
    expect(body.propertyId).toBe('999888')
    expect(body.clientEmail).toBe('sa@project.iam.gserviceaccount.com')
    expect(body.lastSyncedAt).toBeNull()

    credentials.delete('test-project')
  })

  it('DELETE /ga/disconnect returns 404 when no connection', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/test-project/ga/disconnect',
    })
    expect(res.statusCode).toBe(404)
  })

  it('DELETE /ga/disconnect removes connection and traffic data', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Insert some traffic data
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-20',
      landingPage: '/test',
      sessions: 10,
      organicSessions: 5,
      users: 8,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSummaries).values({
      id: crypto.randomUUID(),
      projectId,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-20',
      totalSessions: 10,
      totalOrganicSessions: 5,
      totalUsers: 8,
      syncedAt: now,
    }).run()
    db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-20',
      source: 'chatgpt.com',
      medium: 'referral',
      sessions: 4,
      users: 3,
      syncedAt: now,
    }).run()

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/test-project/ga/disconnect',
    })
    expect(res.statusCode).toBe(204)
    expect(credentials.has('test-project')).toBe(false)

    // Traffic data should be deleted too
    expect(db.select().from(gaTrafficSnapshots).all()).toHaveLength(0)
    expect(db.select().from(gaTrafficSummaries).all()).toHaveLength(0)
    expect(db.select().from(gaAiReferrals).all()).toHaveLength(0)
  })

  it('POST /ga/sync writes per-page rows and aggregate summary', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Mock the GA integration functions used by the sync endpoint
    const gaModule = await import('@ainyc/canonry-integration-google-analytics')
    const getAccessTokenSpy = vi.spyOn(gaModule, 'getAccessToken').mockResolvedValue('mock-token')
    const fetchTrafficSpy = vi.spyOn(gaModule, 'fetchTrafficByLandingPage').mockResolvedValue([
      { date: '2026-03-19', landingPage: '/synced-a', sessions: 50, organicSessions: 20, users: 40 },
      { date: '2026-03-20', landingPage: '/synced-b', sessions: 30, organicSessions: 10, users: 25 },
    ])
    const fetchAggregateSpy = vi.spyOn(gaModule, 'fetchAggregateSummary').mockResolvedValue({
      periodStart: '2026-02-19',
      periodEnd: '2026-03-20',
      totalSessions: 80,
      totalOrganicSessions: 30,
      totalUsers: 55,
    })
    const fetchWindowSummarySpy = vi.spyOn(gaModule, 'fetchWindowSummary').mockImplementation(async (_token, _propId, windowKey) => ({
      windowKey,
      periodStart: '2026-02-19',
      periodEnd: '2026-03-20',
      totalSessions: windowKey === '7d' ? 20 : windowKey === '30d' ? 80 : 200,
      totalOrganicSessions: windowKey === '7d' ? 8 : windowKey === '30d' ? 30 : 75,
      totalDirectSessions: windowKey === '7d' ? 4 : windowKey === '30d' ? 16 : 40,
      totalUsers: windowKey === '7d' ? 15 : windowKey === '30d' ? 55 : 140,
    }))
    // Deduplicated per-day users. Deliberately BELOW the landing-page sums
    // (40 / 25) — that gap is the bug this table exists to close.
    const fetchDailyTotalsSpy = vi.spyOn(gaModule, 'fetchDailyTotals').mockResolvedValue([
      { date: '2026-03-19', sessions: 50, users: 33, engagementRate: 0.62, newUsers: 20},
      { date: '2026-03-20', sessions: 30, users: 21, engagementRate: 0.58, newUsers: 12},
    ])
    const fetchAiReferralsSpy = vi.spyOn(gaModule, 'fetchAiReferrals').mockResolvedValue([
      { date: '2026-03-20', source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', channelGroup: 'Referral', landingPage: '/pricing?utm_source=chatgpt.com', sessions: 12, users: 9, sourceDimension: 'session' },
    ])
    const fetchSocialReferralsSpy = vi.spyOn(gaModule, 'fetchSocialReferrals').mockResolvedValue([
      { date: '2026-03-20', source: 'facebook.com', medium: 'social', sessions: 8, users: 6, channelGroup: 'Organic Social' },
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/ga/sync',
      payload: { days: 30 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.synced).toBe(true)
    expect(body.rowCount).toBe(2)
    expect(body.aiReferralCount).toBe(1)
    expect(body.socialReferralCount).toBe(1)

    // Verify per-page rows were written
    const snapshots = db.select().from(gaTrafficSnapshots)
      .where(inArray(gaTrafficSnapshots.landingPage, ['/synced-a', '/synced-b']))
      .all()
    expect(snapshots).toHaveLength(2)

    const gaRuns = db.select().from(runs)
      .where(eq(runs.kind, RunKinds['ga-sync']))
      .all()
    expect(gaRuns).toHaveLength(1)
    expect(gaRuns[0]!.status).toBe(RunStatuses.completed)
    expect(gaRuns[0]!.trigger).toBe(RunTriggers.manual)

    // Verify aggregate summary was written
    const summaries = db.select().from(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, projectId))
      .all()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.totalUsers).toBe(55)
    expect(summaries[0]!.totalSessions).toBe(80)
    expect(summaries[0]!.totalOrganicSessions).toBe(30)

    // Verify per-window summaries were written (one row per 7d/30d/90d).
    // Drives the deduplicated totalUsers headline when a window filter is
    // active in /ga/traffic — summing snapshots overcounts users who land
    // on multiple pages.
    const windowSummaries = db.select().from(gaTrafficWindowSummaries)
      .where(eq(gaTrafficWindowSummaries.projectId, projectId))
      .all()
      .sort((a, b) => a.windowKey.localeCompare(b.windowKey))
    expect(windowSummaries.map((r) => r.windowKey)).toEqual(['30d', '7d', '90d'])
    const byKey = Object.fromEntries(windowSummaries.map((r) => [r.windowKey, r]))
    expect(byKey['7d']!.totalUsers).toBe(15)
    expect(byKey['30d']!.totalUsers).toBe(55)
    expect(byKey['90d']!.totalUsers).toBe(140)
    expect(byKey['30d']!.totalDirectSessions).toBe(16)
    expect(windowSummaries.every((r) => r.syncRunId === gaRuns[0]!.id)).toBe(true)

    // Deduplicated per-day totals persisted. These are the numbers the daily
    // series must report — NOT the landing-page sums (40 / 25), which count a
    // multi-page visitor once per page.
    const dailyTotals = db.select().from(gaDailyTotals)
      .where(eq(gaDailyTotals.projectId, projectId))
      .all()
      .sort((a, b) => a.date.localeCompare(b.date))
    expect(dailyTotals.map((r) => [r.date, r.users])).toEqual([
      ['2026-03-19', 33],
      ['2026-03-20', 21],
    ])
    expect(dailyTotals.every((r) => r.syncRunId === gaRuns[0]!.id)).toBe(true)

    const aiReferrals = db.select().from(gaAiReferrals)
      .where(eq(gaAiReferrals.projectId, projectId))
      .all()
    expect(aiReferrals).toHaveLength(1)
    expect(aiReferrals[0]!.source).toBe('chatgpt.com')
    expect(aiReferrals[0]!.trafficClass).toBe('organic')
    expect(aiReferrals[0]!.landingPage).toBe('/pricing?utm_source=chatgpt.com')
    expect(aiReferrals[0]!.landingPageNormalized).toBe('/pricing')

    const socialRefs = db.select().from(gaSocialReferrals)
      .where(eq(gaSocialReferrals.projectId, projectId))
      .all()
    expect(socialRefs).toHaveLength(1)
    expect(socialRefs[0]!.source).toBe('facebook.com')
    expect(snapshots.every((row) => row.syncRunId === gaRuns[0]!.id)).toBe(true)
    expect(aiReferrals[0]!.syncRunId).toBe(gaRuns[0]!.id)
    expect(socialRefs[0]!.syncRunId).toBe(gaRuns[0]!.id)
    expect(summaries[0]!.syncRunId).toBe(gaRuns[0]!.id)

    // Cleanup
    getAccessTokenSpy.mockRestore()
    fetchTrafficSpy.mockRestore()
    fetchAggregateSpy.mockRestore()
    fetchWindowSummarySpy.mockRestore()
    fetchDailyTotalsSpy.mockRestore()
    fetchAiReferralsSpy.mockRestore()
    fetchSocialReferralsSpy.mockRestore()
    credentials.delete('test-project')
    // Clean up synced data so it doesn't interfere with later tests
    db.delete(gaTrafficSnapshots)
      .where(inArray(gaTrafficSnapshots.landingPage, ['/synced-a', '/synced-b']))
      .run()
    db.delete(gaAiReferrals)
      .where(eq(gaAiReferrals.projectId, projectId))
      .run()
    db.delete(gaSocialReferrals)
      .where(eq(gaSocialReferrals.projectId, projectId))
      .run()
    db.delete(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, projectId))
      .run()
  })

  it('POST /ga/sync clears stale landing-page and AI referral rows when the latest sync is empty', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-15',
      landingPage: '/stale-page',
      sessions: 21,
      organicSessions: 7,
      users: 14,
      syncedAt: now,
    }).run()
    db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-16',
      source: 'chatgpt.com',
      medium: 'referral',
      sessions: 5,
      users: 4,
      syncedAt: now,
    }).run()

    const gaModule = await import('@ainyc/canonry-integration-google-analytics')
    const getAccessTokenSpy = vi.spyOn(gaModule, 'getAccessToken').mockResolvedValue('mock-token')
    const fetchTrafficSpy = vi.spyOn(gaModule, 'fetchTrafficByLandingPage').mockResolvedValue([])
    const fetchAggregateSpy = vi.spyOn(gaModule, 'fetchAggregateSummary').mockResolvedValue({
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      totalSessions: 0,
      totalOrganicSessions: 0,
      totalUsers: 0,
    })
    const fetchWindowSummarySpy = vi.spyOn(gaModule, 'fetchWindowSummary').mockImplementation(async (_t, _p, windowKey) => ({
      windowKey,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      totalSessions: 0,
      totalOrganicSessions: 0,
      totalDirectSessions: 0,
      totalUsers: 0,
    }))
    const fetchDailyTotalsSpy = vi.spyOn(gaModule, 'fetchDailyTotals').mockResolvedValue([])
    const fetchAiReferralsSpy = vi.spyOn(gaModule, 'fetchAiReferrals').mockResolvedValue([])
    const fetchSocialReferralsSpy = vi.spyOn(gaModule, 'fetchSocialReferrals').mockResolvedValue([])

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/ga/sync',
      payload: { days: 30 },
    })

    expect(res.statusCode).toBe(200)
    expect(db.select().from(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.projectId, projectId)).all()).toHaveLength(0)
    expect(db.select().from(gaAiReferrals).where(eq(gaAiReferrals.projectId, projectId)).all()).toHaveLength(0)

    getAccessTokenSpy.mockRestore()
    fetchTrafficSpy.mockRestore()
    fetchAggregateSpy.mockRestore()
    fetchWindowSummarySpy.mockRestore()
    fetchDailyTotalsSpy.mockRestore()
    fetchAiReferralsSpy.mockRestore()
    fetchSocialReferralsSpy.mockRestore()
    credentials.delete('test-project')
    db.delete(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, projectId))
      .run()
    db.delete(gaTrafficWindowSummaries)
      .where(eq(gaTrafficWindowSummaries.projectId, projectId))
      .run()
  })

  it('POST /ga/sync with only=social still refreshes traffic snapshots and summary so share metrics stay valid', async () => {
    // The traffic foundation (gaTrafficSnapshots + gaTrafficSummaries) is the
    // denominator for every share metric. Letting it go stale during a
    // partial sync is what produced the "1.3K social sessions / 0% share"
    // bug, so `only=social` must still refresh the foundation — only
    // `gaAiReferrals` is skipped here.
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const projRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/only-social-foundation',
      payload: {
        displayName: 'Only Social Foundation',
        canonicalDomain: 'only-social.example',
        country: 'US',
        language: 'en',
      },
    })
    const partialProjectId = JSON.parse(projRes.payload).id

    credentials.set('only-social-foundation', {
      projectName: 'only-social-foundation',
      propertyId: '999111',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const gaModule = await import('@ainyc/canonry-integration-google-analytics')
    const getAccessTokenSpy = vi.spyOn(gaModule, 'getAccessToken').mockResolvedValue('mock-token')
    const fetchTrafficSpy = vi.spyOn(gaModule, 'fetchTrafficByLandingPage').mockResolvedValue([
      { date: today, landingPage: '/foundation', sessions: 30000, organicSessions: 12000, directSessions: 5000, users: 22000 },
    ])
    const fetchAggregateSpy = vi.spyOn(gaModule, 'fetchAggregateSummary').mockResolvedValue({
      periodStart: today,
      periodEnd: today,
      totalSessions: 30000,
      totalOrganicSessions: 12000,
      totalUsers: 22000,
    })
    const fetchWindowSummarySpy = vi.spyOn(gaModule, 'fetchWindowSummary').mockImplementation(async (_t, _p, windowKey) => ({
      windowKey,
      periodStart: today,
      periodEnd: today,
      totalSessions: 30000,
      totalOrganicSessions: 12000,
      totalDirectSessions: 5000,
      totalUsers: 22000,
    }))
    const fetchDailyTotalsSpy = vi.spyOn(gaModule, 'fetchDailyTotals').mockResolvedValue([
      { date: today, sessions: 30000, users: 22000, engagementRate: 0.66, newUsers: 14000},
    ])
    const fetchAiReferralsSpy = vi.spyOn(gaModule, 'fetchAiReferrals').mockResolvedValue([])
    const fetchSocialReferralsSpy = vi.spyOn(gaModule, 'fetchSocialReferrals').mockResolvedValue([
      { date: today, source: 'facebook.com', medium: 'referral', sessions: 1273, users: 900, channelGroup: 'Organic Social' },
    ])

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/only-social-foundation/ga/sync',
        payload: { days: 30, only: 'social' },
      })
      expect(res.statusCode).toBe(200)

      // The sync response must reflect the foundation write so callers
      // (CLI `Components:` line, agents reading `syncedComponents`) don't
      // think only social was refreshed.
      const syncBody = JSON.parse(res.payload)
      expect(syncBody.syncedComponents).toEqual(['traffic', 'summary', 'social'])

      // Foundation must be refreshed even though the caller asked for
      // `only=social` — fetchTrafficByLandingPage + fetchAggregateSummary
      // were called and rows landed in both tables.
      expect(fetchTrafficSpy).toHaveBeenCalled()
      expect(fetchAggregateSpy).toHaveBeenCalled()

      const snapshots = db.select().from(gaTrafficSnapshots)
        .where(eq(gaTrafficSnapshots.projectId, partialProjectId))
        .all()
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]!.sessions).toBe(30000)

      const summaries = db.select().from(gaTrafficSummaries)
        .where(eq(gaTrafficSummaries.projectId, partialProjectId))
        .all()
      expect(summaries).toHaveLength(1)
      expect(summaries[0]!.totalSessions).toBe(30000)

      const socialRefs = db.select().from(gaSocialReferrals)
        .where(eq(gaSocialReferrals.projectId, partialProjectId))
        .all()
      expect(socialRefs).toHaveLength(1)
      expect(socialRefs[0]!.sessions).toBe(1273)

      // AI was the channel breakdown the caller asked to skip — and it was.
      expect(fetchAiReferralsSpy).not.toHaveBeenCalled()
      const aiRefs = db.select().from(gaAiReferrals)
        .where(eq(gaAiReferrals.projectId, partialProjectId))
        .all()
      expect(aiRefs).toHaveLength(0)

      // End-to-end: GET /ga/traffic now returns a real share, not 0% or "—".
      const trafficRes = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/only-social-foundation/ga/traffic?window=30d',
      })
      const traffic = JSON.parse(trafficRes.payload)
      // 1273 / 30000 = 4.24%: 4 on the wire, one decimal on display.
      expect(traffic.socialSharePct).toBe(4)
      expect(traffic.socialSharePctDisplay).toBe('4.2%')
    } finally {
      getAccessTokenSpy.mockRestore()
      fetchTrafficSpy.mockRestore()
      fetchAggregateSpy.mockRestore()
      fetchWindowSummarySpy.mockRestore()
      fetchDailyTotalsSpy.mockRestore()
      fetchAiReferralsSpy.mockRestore()
      fetchSocialReferralsSpy.mockRestore()
      credentials.delete('only-social-foundation')
      db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.projectId, partialProjectId)).run()
      db.delete(gaTrafficSummaries).where(eq(gaTrafficSummaries.projectId, partialProjectId)).run()
      db.delete(gaTrafficWindowSummaries).where(eq(gaTrafficWindowSummaries.projectId, partialProjectId)).run()
      db.delete(gaSocialReferrals).where(eq(gaSocialReferrals.projectId, partialProjectId)).run()
    }
  })

  it('POST /ga/sync rejects invalid only parameter', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/ga/sync',
      payload: { only: 'socal' },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/Invalid "only" value/)

    credentials.delete('test-project')
  })

  it('GET /ga/traffic returns error when no connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/traffic',
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/No GA4 connection/)
  })

  it('GET /ga/traffic returns aggregated data', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Insert traffic data
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-19',
      landingPage: '/page-a',
      sessions: 100,
      organicSessions: 50,
      users: 80,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-20',
      landingPage: '/page-a',
      sessions: 200,
      organicSessions: 100,
      users: 150,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-20',
      landingPage: '/page-b',
      sessions: 50,
      organicSessions: 25,
      users: 40,
      syncedAt: now,
    }).run()

    // Seed aggregate summary (true unique counts — what the sync now stores separately)
    db.insert(gaTrafficSummaries).values({
      id: crypto.randomUUID(),
      projectId,
      periodStart: '2026-02-19',
      periodEnd: '2026-03-20',
      totalSessions: 350,
      totalOrganicSessions: 175,
      totalUsers: 270,
      syncedAt: now,
    }).run()
    db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-20',
      source: 'chatgpt.com',
      medium: 'referral',
      landingPage: '/page-a?utm_source=chatgpt.com',
      landingPageNormalized: '/page-a',
      sessions: 17,
      users: 10,
      syncedAt: now,
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/traffic',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.totalSessions).toBe(350)
    expect(body.totalOrganicSessions).toBe(175)
    expect(body.totalUsers).toBe(270)
    expect(body.topPages).toHaveLength(2)
    // page-a has more sessions so should be first
    expect(body.topPages[0].landingPage).toBe('/page-a')
    expect(body.topPages[0].sessions).toBe(300)
    expect(body.topPages[1].landingPage).toBe('/page-b')
    // No `users` on either referral row type — the seeded row carries users: 10
    // and the response must not report it. toEqual is exact, so an extra key
    // fails here.
    expect(body.aiReferrals).toEqual([
      { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', sessions: 17 },
    ])
    expect(body.aiReferralLandingPages).toEqual([
      { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', landingPage: '/page-a', sessions: 17 },
    ])
    expect(body.aiSessionsDeduped).toBe(17)
    expect(body.paidAiSessionsDeduped).toBe(0)
    expect(body.organicAiSessionsDeduped).toBe(17)
    // Only sessionSource-attributed rows seeded, so bySession matches dedup here.
    expect(body.aiSessionsBySession).toBe(17)
    expect(body.paidAiSessionsBySession).toBe(0)
    expect(body.organicAiSessionsBySession).toBe(17)
    expect(body.aiSharePctBySession).toBe(5)
    expect(body.paidAiSharePctBySession).toBe(0)
    expect(body.organicAiSharePctBySession).toBe(5)
    expect(body.socialReferrals).toEqual([])
    expect(body.socialSessions).toBe(0)
    // socialUsers is withdrawn: see the dedicated test below.
    expect(body).not.toHaveProperty('socialUsers')
    expect(body.organicSharePct).toBe(50)
    expect(body.aiSharePct).toBe(5)
    expect(body.socialSharePct).toBe(0)
    // Displays read the unrounded share: 175/350 = 50%, 17/350 = 4.86%
    // (5 on the wire), and the 158 uncovered sessions are 45.14%.
    expect(body.organicSharePctDisplay).toBe('50.0%')
    expect(body.aiSharePctDisplay).toBe('4.9%')
    expect(body.aiSharePctBySessionDisplay).toBe('4.9%')
    expect(body.socialSharePctDisplay).toBe('0%')
    expect(body.directSharePctDisplay).toBe('0%')
    expect(body.otherSessions).toBe(158)
    expect(body.otherSharePct).toBe(45)
    expect(body.otherSharePctDisplay).toBe('45.1%')
    expect(body.lastSyncedAt).toBe(now)
    expect(body.periodStart).toBe('2026-02-19')
    expect(body.periodEnd).toBe('2026-03-20')

    credentials.delete('test-project')
  })

  it('GET /ga/traffic splits tagged ChatGPT ads from organic AI referrals', async () => {
    const now = new Date().toISOString()
    const projectRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/paid-ai-split',
      payload: {
        displayName: 'Paid AI Split',
        canonicalDomain: 'paid-ai.example',
        country: 'US',
        language: 'en',
      },
    })
    const paidProjectId = JSON.parse(projectRes.payload).id as string
    credentials.set('paid-ai-split', {
      projectName: 'paid-ai-split',
      propertyId: '999777',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const paidRowId = crypto.randomUUID()
    const organicRowId = crypto.randomUUID()

    try {
      db.insert(gaTrafficSnapshots).values({
        id: crypto.randomUUID(),
        projectId: paidProjectId,
        date: '2026-03-20',
        landingPage: '/pricing',
        sessions: 100,
        organicSessions: 40,
        directSessions: 20,
        users: 80,
        syncedAt: now,
      }).run()
      db.insert(gaTrafficSummaries).values({
        id: crypto.randomUUID(),
        projectId: paidProjectId,
        periodStart: '2026-02-19',
        periodEnd: '2026-03-20',
        totalSessions: 100,
        totalOrganicSessions: 40,
        totalUsers: 80,
        syncedAt: now,
      }).run()
      db.insert(gaAiReferrals).values([
        {
          id: paidRowId,
          projectId: paidProjectId,
          date: '2026-03-20',
          source: 'chatgpt.com',
          medium: 'cpc',
          trafficClass: 'paid',
          sourceDimension: 'session',
          channelGroup: 'Paid Other',
          landingPage: '/pricing?utm_source=chatgpt&utm_medium=cpc&utm_campaign=openai_ads',
          landingPageNormalized: '/pricing',
          sessions: 30,
          users: 24,
          syncedAt: now,
        },
        {
          id: organicRowId,
          projectId: paidProjectId,
          date: '2026-03-20',
          source: 'chatgpt.com',
          medium: 'referral',
          trafficClass: 'organic',
          sourceDimension: 'session',
          channelGroup: 'Direct',
          landingPage: '/guide?utm_source=chatgpt',
          landingPageNormalized: '/guide',
          sessions: 10,
          users: 8,
          syncedAt: now,
        },
      ]).run()

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/paid-ai-split/ga/traffic',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      expect(body.aiSessionsDeduped).toBe(40)
      expect(body.paidAiSessionsDeduped).toBe(30)
      expect(body.organicAiSessionsDeduped).toBe(10)
      expect(body.aiSessionsBySession).toBe(40)
      expect(body.paidAiSessionsBySession).toBe(30)
      expect(body.organicAiSessionsBySession).toBe(10)
      expect(body.paidAiSharePctBySessionDisplay).toBe('30.0%')

      const byClass = Object.fromEntries(
        body.aiReferrals.map((row: { trafficClass: string; sessions: number }) => [row.trafficClass, row.sessions]),
      )
      expect(byClass.paid).toBe(30)
      expect(byClass.organic).toBe(10)

      expect(body.channelBreakdown).toEqual({
        organic: { sessions: 40, sharePct: 40, sharePctDisplay: '40.0%' },
        social: { sessions: 0, sharePct: 0, sharePctDisplay: '0%' },
        direct: { sessions: 10, sharePct: 10, sharePctDisplay: '10.0%' },
        ai: { sessions: 40, sharePct: 40, sharePctDisplay: '40.0%' },
        other: { sessions: 10, sharePct: 10, sharePctDisplay: '10.0%' },
      })
    } finally {
      credentials.delete('paid-ai-split')
      db.delete(gaAiReferrals).where(inArray(gaAiReferrals.id, [paidRowId, organicRowId])).run()
      db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.projectId, paidProjectId)).run()
      db.delete(gaTrafficSummaries).where(eq(gaTrafficSummaries.projectId, paidProjectId)).run()
    }
  })

  it('GET /ga/traffic does not inflate deduped AI totals when one source is paid under one lens and organic under another', async () => {
    // Same (date, source, medium) carrying a paid row under the 'session' lens
    // and a larger organic row under the 'first_user' lens. These are the same
    // visits seen through overlapping attribution lenses, so the deduped total
    // must stay MAX(20, 30) = 30 — NOT 20 + 30. Keying the dedupe on traffic
    // class would let both survive and double-count.
    const now = new Date().toISOString()
    const projectRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/paid-ai-overlap',
      payload: {
        displayName: 'Paid AI Overlap',
        canonicalDomain: 'paid-ai-overlap.example',
        country: 'US',
        language: 'en',
      },
    })
    const overlapProjectId = JSON.parse(projectRes.payload).id as string
    credentials.set('paid-ai-overlap', {
      projectName: 'paid-ai-overlap',
      propertyId: '999778',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const paidSessionRowId = crypto.randomUUID()
    const organicFirstUserRowId = crypto.randomUUID()

    try {
      db.insert(gaTrafficSummaries).values({
        id: crypto.randomUUID(),
        projectId: overlapProjectId,
        periodStart: '2026-02-19',
        periodEnd: '2026-03-20',
        totalSessions: 100,
        totalOrganicSessions: 40,
        totalUsers: 80,
        syncedAt: now,
      }).run()
      db.insert(gaAiReferrals).values([
        {
          id: paidSessionRowId,
          projectId: overlapProjectId,
          date: '2026-03-20',
          source: 'chatgpt.com',
          medium: 'referral',
          trafficClass: 'paid',
          sourceDimension: 'session',
          channelGroup: 'Referral',
          landingPage: '/pricing?utm_medium=cpc',
          landingPageNormalized: '/pricing',
          sessions: 20,
          users: 15,
          syncedAt: now,
        },
        {
          id: organicFirstUserRowId,
          projectId: overlapProjectId,
          date: '2026-03-20',
          source: 'chatgpt.com',
          medium: 'referral',
          trafficClass: 'organic',
          sourceDimension: 'first_user',
          channelGroup: 'Referral',
          landingPage: '/guide',
          landingPageNormalized: '/guide',
          sessions: 30,
          users: 25,
          syncedAt: now,
        },
      ]).run()

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/paid-ai-overlap/ga/traffic',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // Combined deduped total is the cross-lens MAX, unchanged by the split.
      expect(body.aiSessionsDeduped).toBe(30)
      // The winning (larger) lens is the organic first_user row.
      expect(body.paidAiSessionsDeduped).toBe(0)
      expect(body.organicAiSessionsDeduped).toBe(30)
      // Invariant: the class split always partitions the deduped total.
      expect(body.paidAiSessionsDeduped + body.organicAiSessionsDeduped).toBe(body.aiSessionsDeduped)
      // Session-lens-only totals are disjoint by class, so the paid session row stands.
      expect(body.aiSessionsBySession).toBe(20)
      expect(body.paidAiSessionsBySession).toBe(20)
      expect(body.organicAiSessionsBySession).toBe(0)
    } finally {
      credentials.delete('paid-ai-overlap')
      db.delete(gaAiReferrals).where(inArray(gaAiReferrals.id, [paidSessionRowId, organicFirstUserRowId])).run()
      db.delete(gaTrafficSummaries).where(eq(gaTrafficSummaries.projectId, overlapProjectId)).run()
    }
  })

  it('GET /ga/traffic computes disjoint channel breakdown when AI overlaps native GA4 channels', async () => {
    const now = new Date().toISOString()
    const projectRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/channel-overlap',
      payload: {
        displayName: 'Channel Overlap',
        canonicalDomain: 'overlap.example',
        country: 'US',
        language: 'en',
      },
    })
    const overlapProjectId = JSON.parse(projectRes.payload).id as string
    credentials.set('channel-overlap', {
      projectName: 'channel-overlap',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const aiOrganicId = crypto.randomUUID()
    const aiSocialId = crypto.randomUUID()
    const socialId = crypto.randomUUID()

    try {
      db.insert(gaTrafficSnapshots).values({
        id: crypto.randomUUID(),
        projectId: overlapProjectId,
        date: '2026-03-20',
        landingPage: '/overlap',
        sessions: 100,
        organicSessions: 40,
        directSessions: 20,
        users: 80,
        syncedAt: now,
      }).run()
      db.insert(gaTrafficSummaries).values({
        id: crypto.randomUUID(),
        projectId: overlapProjectId,
        periodStart: '2026-02-19',
        periodEnd: '2026-03-20',
        totalSessions: 100,
        totalOrganicSessions: 40,
        totalUsers: 80,
        syncedAt: now,
      }).run()
      db.insert(gaSocialReferrals).values({
        id: socialId,
        projectId: overlapProjectId,
        date: '2026-03-20',
        source: 'meta.ai',
        medium: 'social',
        channelGroup: 'Organic Social',
        sessions: 15,
        users: 12,
        syncedAt: now,
      }).run()
      db.insert(gaAiReferrals).values([
        {
          id: aiOrganicId,
          projectId: overlapProjectId,
          date: '2026-03-20',
          source: 'gemini.google.com',
          medium: 'organic',
          sourceDimension: 'session',
          channelGroup: 'Organic Search',
          landingPage: '/overlap',
          landingPageNormalized: '/overlap',
          sessions: 10,
          users: 8,
          syncedAt: now,
        },
        {
          id: aiSocialId,
          projectId: overlapProjectId,
          date: '2026-03-20',
          source: 'meta.ai',
          medium: 'social',
          sourceDimension: 'session',
          channelGroup: 'Organic Social',
          landingPage: '/overlap',
          landingPageNormalized: '/overlap',
          sessions: 5,
          users: 4,
          syncedAt: now,
        },
      ]).run()

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/channel-overlap/ga/traffic',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      expect(body.totalOrganicSessions).toBe(40)
      expect(body.socialSessions).toBe(15)
      expect(body.aiSessionsBySession).toBe(15)
      expect(body.channelBreakdown).toEqual({
        organic: { sessions: 30, sharePct: 30, sharePctDisplay: '30.0%' },
        social: { sessions: 10, sharePct: 10, sharePctDisplay: '10.0%' },
        direct: { sessions: 20, sharePct: 20, sharePctDisplay: '20.0%' },
        ai: { sessions: 15, sharePct: 15, sharePctDisplay: '15.0%' },
        other: { sessions: 25, sharePct: 25, sharePctDisplay: '25.0%' },
      })
      expect(body.otherSessions).toBe(25)
      expect(body.otherSharePctDisplay).toBe('25.0%')
      const totalBreakdownSessions = Object.values(body.channelBreakdown as Record<string, { sessions: number }>)
        .reduce((sum, bucket) => sum + bucket.sessions, 0)
      expect(totalBreakdownSessions).toBe(100)
    } finally {
      credentials.delete('channel-overlap')
      db.delete(gaAiReferrals).where(inArray(gaAiReferrals.id, [aiOrganicId, aiSocialId])).run()
      db.delete(gaSocialReferrals).where(eq(gaSocialReferrals.id, socialId)).run()
      db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.projectId, overlapProjectId)).run()
      db.delete(gaTrafficSummaries).where(eq(gaTrafficSummaries.projectId, overlapProjectId)).run()
    }
  })

  it.each([
    // 18 of 6,000 is 0.3%, which Math.round flattens to 0 on the wire.
    { project: 'sub-one-pct', aiSessions: 18, display: '0.3%' },
    // 2 of 6,000 is 0.03%, too small for one decimal, and still never "0%".
    { project: 'sub-tenth-pct', aiSessions: 2, display: '<0.1%' },
  ])('GET /ga/traffic displays $aiSessions AI sessions of 6,000 as $display although the rounded pct is 0', async ({ project, aiSessions, display }) => {
    // Seed a fresh project so we don't pollute the shared row counts.
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const projRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project}`,
      payload: {
        displayName: project,
        canonicalDomain: `${project}.example`,
        country: 'US',
        language: 'en',
      },
    })
    const subProjectId = JSON.parse(projRes.payload).id

    credentials.set(project, {
      projectName: project,
      propertyId: '111222',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const snapshotId = crypto.randomUUID()
    db.insert(gaTrafficSnapshots).values({
      id: snapshotId,
      projectId: subProjectId,
      date: today,
      landingPage: '/sub-one-page',
      sessions: 6000,
      organicSessions: 600,
      directSessions: 1000,
      users: 4500,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSummaries).values({
      id: crypto.randomUUID(),
      projectId: subProjectId,
      periodStart: today,
      periodEnd: today,
      totalSessions: 6000,
      totalOrganicSessions: 600,
      totalUsers: 4500,
      syncedAt: now,
    }).run()
    const aiId = crypto.randomUUID()
    db.insert(gaAiReferrals).values({
      id: aiId,
      projectId: subProjectId,
      date: today,
      source: 'chatgpt.com',
      medium: 'referral',
      landingPage: '/sub-one-page',
      sessions: aiSessions,
      users: aiSessions,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project}/ga/traffic`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.aiSessionsBySession).toBe(aiSessions)
      // The integer pct still rounds to 0, preserved for back-compat...
      expect(body.aiSharePctBySession).toBe(0)
      // ...but the display string surfaces the non-zero share.
      expect(body.aiSharePctBySessionDisplay).toBe(display)
      expect(body.aiSharePctDisplay).toBe(display)
      // Channels with truly zero sessions still render "0%" (no false "<0.1%").
      expect(body.socialSharePctDisplay).toBe('0%')
      // 600 / 6000 = 10%
      expect(body.organicSharePctDisplay).toBe('10.0%')
      expect(body.otherSessions).toBeGreaterThanOrEqual(0)
      expect(typeof body.otherSharePctDisplay).toBe('string')
    } finally {
      db.delete(gaAiReferrals).where(eq(gaAiReferrals.id, aiId)).run()
      db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.id, snapshotId)).run()
      credentials.delete(project)
    }
  })

  it('GET /ga/traffic returns "—" share display when social rows exist but no traffic snapshots/summary do', async () => {
    // Defensive case: if any process inserts social rows without the
    // corresponding traffic foundation (data corruption, manual SQL, a
    // test/seed flow that bypasses the sync endpoint), the share denominator
    // is 0 and a literal "0%" would falsely claim social is 0% of traffic.
    // Surface the data gap honestly with "—" instead. Under the normal sync
    // flow (which always refreshes traffic+summary) this state shouldn't
    // arise.
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const projRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/no-summary',
      payload: {
        displayName: 'No Summary',
        canonicalDomain: 'no-summary.example',
        country: 'US',
        language: 'en',
      },
    })
    const noSummaryProjectId = JSON.parse(projRes.payload).id

    credentials.set('no-summary', {
      projectName: 'no-summary',
      propertyId: '111444',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const socialId = crypto.randomUUID()
    db.insert(gaSocialReferrals).values({
      id: socialId,
      projectId: noSummaryProjectId,
      date: today,
      source: 'facebook.com',
      medium: 'referral',
      channelGroup: 'Organic Social',
      sessions: 1273,
      users: 900,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/no-summary/ga/traffic?window=30d',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.socialSessions).toBe(1273)
      expect(body.socialSharePct).toBe(0)
      // No summary, no snapshots — surface the data gap honestly.
      expect(body.socialSharePctDisplay).toBe('—')
      expect(body.otherSharePctDisplay).toBe('—')
    } finally {
      db.delete(gaSocialReferrals).where(eq(gaSocialReferrals.id, socialId)).run()
      credentials.delete('no-summary')
    }
  })

  it('GET /ga/traffic respects limit parameter and computes totals across all pages', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/traffic?limit=1',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    // Only 1 page returned due to limit
    expect(body.topPages).toHaveLength(1)
    // But totals must reflect ALL pages, not just the limited set
    expect(body.totalSessions).toBe(350)
    expect(body.totalOrganicSessions).toBe(175)
    expect(body.totalUsers).toBe(270)

    credentials.delete('test-project')
  })

  it('GET /ga/traffic filters by window parameter', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // The existing test data has snapshots from 2026-03-19 and 2026-03-20.
    // Query with window=7d — the cutoff will be ~7 days ago from today (2026-04-11),
    // so all the old data from March should be excluded.
    //
    // Derived the same way `windowCutoff` derives it, so this asserts the
    // reported window IS the filter that ran, not a date recomputed here by a
    // second rule that could drift from it.
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 7)
    const sevenDayCutoff = cutoff.toISOString().slice(0, 10)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/traffic?window=7d',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    // No snapshots within last 7 days → totals should be 0
    expect(body.totalSessions).toBe(0)
    expect(body.topPages).toHaveLength(0)
    expect(body.aiReferrals).toEqual([])
    // The window reported is the window MEASURED: the 7d cutoff, open at the
    // top because no endDate was asked for. It used to report the synced range
    // (2026-02-19..2026-03-20) here — dates that do have data — next to totals
    // of 0, which reads as "this period was empty" about a period that was not.
    expect(body.windowStart).toBe(sevenDayCutoff)
    expect(body.windowEnd).toBeNull()
    // Open on one side, so there is no span to state.
    expect(body.windowDays).toBeNull()
    expect(body.periodStart).toBe(body.windowStart)
    expect(body.periodEnd).toBe(body.windowEnd)

    credentials.delete('test-project')
  })

  it('GET /ga/traffic computes every share from the same window as its total', async () => {
    // Regression for the mixed-window share bug. `/ga/sync` replaces the
    // project summary row on every run but only range-replaces the detail
    // tables inside that same period, so a project first synced at 90 days and
    // since synced at 30 keeps 90 days of direct/social/AI rows behind a
    // 30-day total. The unfiltered read used to take the total from the
    // summary and the channel counts from the whole retained table, so
    // `directSharePct` divided 90 days of direct sessions by 30 days of
    // sessions. On real data that turned a 20.6% direct share into 69% and
    // described a mostly-paid business as a direct/social brand.
    const now = new Date().toISOString()
    const projRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/window-share',
      payload: {
        displayName: 'Window Share',
        canonicalDomain: 'window-share.example',
        country: 'US',
        language: 'en',
      },
    })
    const shareProjectId = JSON.parse(projRes.payload).id as string
    credentials.set('window-share', {
      projectName: 'window-share',
      propertyId: '424242',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // The last sync measured 30 days. This is the ONLY period with a stored
    // denominator behind it.
    const WINDOW_30_START = '2026-03-01'
    const WINDOW_30_END = '2026-03-30'
    // Retained from an earlier, wider sync. No total covers these days.
    const TAIL_DATE = '2026-01-15'

    db.insert(gaTrafficSummaries).values({
      id: crypto.randomUUID(),
      projectId: shareProjectId,
      periodStart: WINDOW_30_START,
      periodEnd: WINDOW_30_END,
      totalSessions: 1000,
      totalOrganicSessions: 200,
      totalUsers: 800,
      syncedAt: now,
    }).run()

    // Exact rolling-window summaries GA aggregated itself. Their totals and
    // periods must travel together; neither may narrow an `all` read.
    db.insert(gaTrafficWindowSummaries).values([
      {
        id: crypto.randomUUID(),
        projectId: shareProjectId,
        windowKey: '30d',
        periodStart: WINDOW_30_START,
        periodEnd: WINDOW_30_END,
        totalSessions: 1000,
        totalOrganicSessions: 200,
        totalDirectSessions: 200,
        totalUsers: 800,
        syncedAt: now,
      },
      {
        id: crypto.randomUUID(),
        projectId: shareProjectId,
        windowKey: '90d',
        periodStart: '2026-01-01',
        periodEnd: WINDOW_30_END,
        totalSessions: 3000,
        totalOrganicSessions: 600,
        totalDirectSessions: 700,
        totalUsers: 2400,
        syncedAt: now,
      },
    ]).run()

    const snapshot = (date: string, landingPage: string, sessions: number, directSessions: number) => {
      db.insert(gaTrafficSnapshots).values({
        id: crypto.randomUUID(),
        projectId: shareProjectId,
        date,
        landingPage,
        landingPageNormalized: landingPage,
        sessions,
        organicSessions: 0,
        directSessions,
        users: sessions,
        syncedAt: now,
      }).run()
    }
    // In the 30d window: 200 direct. In the retained tail: 500 more.
    snapshot(WINDOW_30_START, '/in-window', 300, 200)
    snapshot(TAIL_DATE, '/tail', 600, 500)

    const social = (date: string, source: string, sessions: number) => {
      db.insert(gaSocialReferrals).values({
        id: crypto.randomUUID(),
        projectId: shareProjectId,
        date,
        source,
        medium: 'referral',
        channelGroup: 'Organic Social',
        sessions,
        users: sessions,
        syncedAt: now,
      }).run()
    }
    social(WINDOW_30_START, 'instagram.com', 100)
    social(TAIL_DATE, 'instagram.com', 400)

    const ai = (date: string, sessions: number) => {
      db.insert(gaAiReferrals).values({
        id: crypto.randomUUID(),
        projectId: shareProjectId,
        date,
        source: 'chatgpt.com',
        medium: 'referral',
        sourceDimension: 'session',
        channelGroup: 'Referral',
        trafficClass: 'organic',
        landingPage: '/in-window',
        landingPageNormalized: '/in-window',
        sessions,
        users: sessions,
        syncedAt: now,
      }).run()
    }
    ai(WINDOW_30_START, 50)
    ai(TAIL_DATE, 250)

    try {
      // ---- Explicit 30d: the synced 30-day period ----
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/window-share/ga/traffic?window=30d',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      expect(body.windowStart).toBe(WINDOW_30_START)
      expect(body.windowEnd).toBe(WINDOW_30_END)
      expect(body.windowDays).toBe(30)
      expect(body.periodStart).toBe(WINDOW_30_START)
      expect(body.periodEnd).toBe(WINDOW_30_END)

      // Denominator: the 30-day total.
      expect(body.totalSessions).toBe(1000)
      // Numerators: the in-window rows ONLY. The tail is excluded, so these are
      // the exact figures a caller can divide. Pre-fix these read 700 / 500 /
      // 300 — the whole retained table.
      expect(body.totalDirectSessions).toBe(200)
      expect(body.socialSessions).toBe(100)
      expect(body.aiSessionsDeduped).toBe(50)

      // 200/1000 = 20%, 100/1000 = 10%, 50/1000 = 5%. Pre-fix: 70%, 50%, 30%.
      expect(body.directSharePct).toBe(20)
      expect(body.directSharePctDisplay).toBe('20.0%')
      expect(body.socialSharePct).toBe(10)
      expect(body.socialSharePctDisplay).toBe('10.0%')
      expect(body.aiSharePct).toBe(5)
      expect(body.aiSharePctDisplay).toBe('5.0%')

      // The invariant itself, stated once: each share is its own reported
      // numerator over its own reported denominator. A share sourced from a
      // different window fails here even if the constants above were updated
      // to match it.
      expect(body.directSharePct).toBe(Math.round((body.totalDirectSessions / body.totalSessions) * 100))
      expect(body.socialSharePct).toBe(Math.round((body.socialSessions / body.totalSessions) * 100))
      expect(body.aiSharePct).toBe(Math.round((body.aiSessionsDeduped / body.totalSessions) * 100))

      // Top pages come from the same window — the tail page is not in the list
      // whose sessions the shares are read against.
      expect(body.topPages.map((p: { landingPage: string }) => p.landingPage)).toEqual(['/in-window'])

      // ---- 90d: a genuinely different window, genuinely different numbers ----
      const wide = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/window-share/ga/traffic?window=90d',
      })
      expect(wide.statusCode).toBe(200)
      const wideBody = JSON.parse(wide.payload)

      expect(wideBody.windowStart).toBe('2026-01-01')
      expect(wideBody.windowEnd).toBe(WINDOW_30_END)
      expect(wideBody.windowDays).toBe(89)

      expect(wideBody.totalSessions).toBe(3000)
      expect(wideBody.totalDirectSessions).toBe(700)
      // Both dates are inside 90d, so the tail is counted here and only here.
      expect(wideBody.socialSessions).toBe(500)
      expect(wideBody.aiSessionsDeduped).toBe(300)

      // 700/3000 = 23.33 → 23. 500/3000 = 16.67 → 17. 300/3000 = 10. The
      // displays keep the unrounded share's tenth.
      expect(wideBody.directSharePct).toBe(23)
      expect(wideBody.directSharePctDisplay).toBe('23.3%')
      expect(wideBody.socialSharePct).toBe(17)
      expect(wideBody.socialSharePctDisplay).toBe('16.7%')
      expect(wideBody.aiSharePct).toBe(10)

      // The two windows disagree on every figure. That is what makes this
      // fixture able to catch a mix: pairing either window's numerator with the
      // other's denominator lands on none of the numbers asserted above.
      expect(wideBody.totalSessions).not.toBe(body.totalSessions)
      expect(wideBody.totalDirectSessions).not.toBe(body.totalDirectSessions)
      expect(wideBody.directSharePct).not.toBe(body.directSharePct)
      // The specific mix that shipped: 90d direct over the 30d total.
      expect(Math.round((wideBody.totalDirectSessions / body.totalSessions) * 100)).toBe(70)

      // ---- All/omitted: full retained history, never the latest sync window ----
      const all = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/window-share/ga/traffic',
      })
      expect(all.statusCode).toBe(200)
      const allBody = JSON.parse(all.payload)
      expect(allBody.windowStart).toBeNull()
      expect(allBody.windowEnd).toBeNull()
      expect(allBody.windowDays).toBeNull()
      expect(allBody.totalSessions).toBe(900)
      expect(allBody.totalDirectSessions).toBe(700)
      expect(allBody.socialSessions).toBe(500)
      expect(allBody.aiSessionsDeduped).toBe(300)
      expect(allBody.totalUsers).toBeNull()
      expect(allBody.topPages.map((p: { landingPage: string }) => p.landingPage)).toEqual(['/tail', '/in-window'])

      const explicitAll = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/window-share/ga/traffic?window=all',
      })
      expect(explicitAll.statusCode).toBe(200)
      expect(JSON.parse(explicitAll.payload)).toMatchObject({
        totalSessions: allBody.totalSessions,
        totalDirectSessions: allBody.totalDirectSessions,
        socialSessions: allBody.socialSessions,
        aiSessionsDeduped: allBody.aiSessionsDeduped,
        windowStart: null,
        windowEnd: null,
      })

      // Every omitted-window series has the same full-history semantics as
      // /ga/traffic. The retained tail must remain visible on each surface.
      const spanOf = async (path: string) => {
        const r = await app.inject({ method: 'GET', url: `/api/v1/projects/window-share/ga/${path}` })
        expect(r.statusCode).toBe(200)
        const rows = JSON.parse(r.payload) as Array<{ date: string }> | { days?: Array<{ date: string }> }
        const days = Array.isArray(rows) ? rows : (rows.days ?? [])
        const dates = days.map((d) => d.date).sort()
        return dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null
      }
      for (const path of ['session-history', 'social-referral-history', 'ai-referral-daily']) {
        const span = await spanOf(path)
        expect(span, `${path} returned no history`).not.toBeNull()
        expect(span!.first, `${path} dropped the retained tail row`).toBe(TAIL_DATE)
        expect(span!.last).toBe(WINDOW_30_START)
      }
    } finally {
      db.delete(gaAiReferrals).where(eq(gaAiReferrals.projectId, shareProjectId)).run()
      db.delete(gaSocialReferrals).where(eq(gaSocialReferrals.projectId, shareProjectId)).run()
      db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.projectId, shareProjectId)).run()
      db.delete(gaTrafficSummaries).where(eq(gaTrafficSummaries.projectId, shareProjectId)).run()
      db.delete(gaTrafficWindowSummaries).where(eq(gaTrafficWindowSummaries.projectId, shareProjectId)).run()
      credentials.delete('window-share')
    }
  })

  it('GET /ga/traffic uses windowed summary for totalUsers (no per-page SUM overcount)', async () => {
    // Regression for the SUM-across-landing-pages overcount: when a window
    // filter is active, summing gaTrafficSnapshots.users double-counts users
    // who land on more than one page. The fix is to read totalUsers from the
    // per-window summary (no landing-page dimension at sync time).
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const projRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/window-users',
      payload: {
        displayName: 'Window Users',
        canonicalDomain: 'window-users.example',
        country: 'US',
        language: 'en',
      },
    })
    const winProjectId = JSON.parse(projRes.payload).id

    credentials.set('window-users', {
      projectName: 'window-users',
      propertyId: '111222',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Seed five snapshot rows for the same window — summing users across them
    // gives 5,625, the overcounted figure the bug produced.
    const snapshotIds: string[] = []
    for (const [page, users, sessions] of [
      ['/p1', 1500, 1500],
      ['/p2', 1200, 1200],
      ['/p3', 1100, 1100],
      ['/p4', 950, 950],
      ['/p5', 875, 875],
    ] as Array<[string, number, number]>) {
      const id = crypto.randomUUID()
      snapshotIds.push(id)
      db.insert(gaTrafficSnapshots).values({
        id,
        projectId: winProjectId,
        date: today,
        landingPage: page,
        sessions,
        organicSessions: 0,
        directSessions: 0,
        users,
        syncedAt: now,
      }).run()
    }

    // Seed the windowed summary with the deduplicated GA4 totalUsers — this
    // is what the API should return, not the snapshot SUM.
    db.insert(gaTrafficWindowSummaries).values({
      id: crypto.randomUUID(),
      projectId: winProjectId,
      windowKey: '30d',
      periodStart: today,
      periodEnd: today,
      totalSessions: 5625,
      totalOrganicSessions: 0,
      totalDirectSessions: 0,
      totalUsers: 4905,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/window-users/ga/traffic?window=30d',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      // The fix: totalUsers comes from the windowed summary (4905), NOT the
      // snapshot SUM (5625). If this assertion ever flips back to 5625, the
      // overcount bug is back.
      expect(body.totalUsers).toBe(4905)
      expect(body.totalUsers).not.toBe(5625)
      expect(body.totalSessions).toBe(5625)
    } finally {
      db.delete(gaTrafficSnapshots).where(inArray(gaTrafficSnapshots.id, snapshotIds)).run()
      db.delete(gaTrafficWindowSummaries).where(eq(gaTrafficWindowSummaries.projectId, winProjectId)).run()
      credentials.delete('window-users')
    }
  })

  it('GET /ga/traffic falls back to snapshot SUM when no windowed summary exists yet', async () => {
    // Backwards-compatibility path: projects that haven't synced since the
    // windowed-summary table was introduced still get a totals number — just
    // the legacy (overcounted) one. New syncs replace it with the deduplicated
    // value above.
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const projRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/window-fallback',
      payload: {
        displayName: 'Window Fallback',
        canonicalDomain: 'window-fallback.example',
        country: 'US',
        language: 'en',
      },
    })
    const fbProjectId = JSON.parse(projRes.payload).id

    credentials.set('window-fallback', {
      projectName: 'window-fallback',
      propertyId: '222333',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const snapshotId = crypto.randomUUID()
    db.insert(gaTrafficSnapshots).values({
      id: snapshotId,
      projectId: fbProjectId,
      date: today,
      landingPage: '/legacy',
      sessions: 80,
      organicSessions: 30,
      directSessions: 10,
      users: 60,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/window-fallback/ga/traffic?window=30d',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      // No windowed summary row → fall back to SUM (single page here so no
      // overcount risk).
      expect(body.totalUsers).toBe(60)
      expect(body.totalSessions).toBe(80)
    } finally {
      db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.id, snapshotId)).run()
      credentials.delete('window-fallback')
    }
  })

  it('GET /ga/traffic exposes per-page directSessions and totalDirectSessions', async () => {
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Seed two pages with explicit Direct counts at today's date so they
    // fall inside any window filter. Use unique landingPage paths so the
    // shared-DB coverage test downstream isn't polluted.
    const idA = crypto.randomUUID()
    const idB = crypto.randomUUID()
    db.insert(gaTrafficSnapshots).values({
      id: idA,
      projectId,
      date: today,
      landingPage: '/__direct-test-pricing',
      sessions: 60,
      organicSessions: 10,
      directSessions: 40,
      users: 50,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSnapshots).values({
      id: idB,
      projectId,
      date: today,
      landingPage: '/__direct-test-about',
      sessions: 10,
      organicSessions: 8,
      directSessions: 1,
      users: 9,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/ga/traffic?window=7d',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totalDirectSessions).toBe(41)
      const pricing = body.topPages.find(
        (p: { landingPage: string }) => p.landingPage === '/__direct-test-pricing',
      )
      expect(pricing.directSessions).toBe(40)
      const about = body.topPages.find(
        (p: { landingPage: string }) => p.landingPage === '/__direct-test-about',
      )
      expect(about.directSessions).toBe(1)
      // 41 / 70 ≈ 59% ; total here is 60 + 10 = 70
      expect(body.directSharePct).toBe(59)
    } finally {
      db.delete(gaTrafficSnapshots).where(inArray(gaTrafficSnapshots.id, [idA, idB])).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/traffic returns directSessions=0 for legacy rows with null direct_sessions', async () => {
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const id = crypto.randomUUID()
    db.insert(gaTrafficSnapshots).values({
      id,
      projectId,
      date: today,
      landingPage: '/__direct-test-legacy',
      sessions: 10,
      organicSessions: 0,
      // direct_sessions intentionally omitted (legacy row)
      users: 8,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/ga/traffic?window=7d',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totalDirectSessions).toBe(0)
      expect(body.directSharePct).toBe(0)
      const legacy = body.topPages.find(
        (p: { landingPage: string }) => p.landingPage === '/__direct-test-legacy',
      )
      expect(legacy.directSessions).toBe(0)
    } finally {
      db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.id, id)).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/traffic exposes aiSessionsBySession disjoint from firstUserSource overlap', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Seed two AI referral rows on a unique date for the same source/medium:
    // - sessionSource lens reports 6 (current-session referrals)
    // - firstUserSource lens reports 14 (returning users whose lifetime first
    //   source was AI; 6 of these are also in sessionSource, the other 8 are
    //   currently arriving via Direct/Organic/Social and would be double-counted)
    const sessionRowId = crypto.randomUUID()
    const firstUserRowId = crypto.randomUUID()
    // Inside the seeded summary period (2026-02-19..2026-03-20) and distinct
    // from the pre-existing 2026-03-20 row. An unfiltered /ga/traffic measures
    // exactly that period, so a date outside it contributes nothing — which is
    // the point of the window fix, not a limitation of this test.
    const distinctDate = '2026-03-15'
    db.insert(gaAiReferrals).values({
      id: sessionRowId,
      projectId,
      date: distinctDate,
      source: 'claude.ai',
      medium: 'referral',
      sourceDimension: 'session',
      sessions: 6,
      users: 5,
      syncedAt: now,
    }).run()
    db.insert(gaAiReferrals).values({
      id: firstUserRowId,
      projectId,
      date: distinctDate,
      source: 'claude.ai',
      medium: 'referral',
      sourceDimension: 'first_user',
      sessions: 14,
      users: 12,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/ga/traffic',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      // Pre-existing chatgpt.com row contributes 17 to both lenses.
      // claude.ai contributes: dedup MAX(6, 14) = 14, bySession only the 6.
      expect(body.aiSessionsDeduped).toBe(17 + 14)
      expect(body.aiSessionsBySession).toBe(17 + 6)
    } finally {
      db.delete(gaAiReferrals).where(inArray(gaAiReferrals.id, [sessionRowId, firstUserRowId])).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/traffic dedupes aiReferrals + aiReferralLandingPages to the winning attribution dimension', async () => {
    // Regression for the inflated-row-count bug: GA4 emits one row per
    // attribution dimension (session, first_user, manual_utm) and our SQL
    // groups by all three, so the pre-fix response had three rows for what
    // the user perceives as a single source. The fix collapses to the
    // winning dimension per (source, medium) and per (source, medium,
    // landingPage) so the table reflects reality.
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Seed three dimensions for the same (source, medium, landingPage)
    // tuple. session=4 wins for chatgpt.com (>2 first_user, 1 manual_utm).
    const idChatgptSession = crypto.randomUUID()
    const idChatgptFirst = crypto.randomUUID()
    const idChatgptUtm = crypto.randomUUID()
    // Plus a separate (source, medium) where first_user beats session.
    const idClaudeSession = crypto.randomUUID()
    const idClaudeFirst = crypto.randomUUID()
    const seededIds = [idChatgptSession, idChatgptFirst, idChatgptUtm, idClaudeSession, idClaudeFirst]
    // Inside the seeded summary period — see the note on `distinctDate` above.
    const dedupDate = '2026-03-14'
    db.insert(gaAiReferrals).values([
      {
        id: idChatgptSession,
        projectId,
        date: dedupDate,
        source: 'dedup-chatgpt.com',
        medium: 'referral',
        sourceDimension: 'session',
        landingPage: '/dedup-page',
        sessions: 4,
        users: 3,
        syncedAt: now,
      },
      {
        id: idChatgptFirst,
        projectId,
        date: dedupDate,
        source: 'dedup-chatgpt.com',
        medium: 'referral',
        sourceDimension: 'first_user',
        landingPage: '/dedup-page',
        sessions: 2,
        users: 2,
        syncedAt: now,
      },
      {
        id: idChatgptUtm,
        projectId,
        date: dedupDate,
        source: 'dedup-chatgpt.com',
        medium: 'referral',
        sourceDimension: 'manual_utm',
        landingPage: '/dedup-page',
        sessions: 1,
        users: 1,
        syncedAt: now,
      },
      {
        id: idClaudeSession,
        projectId,
        date: dedupDate,
        source: 'dedup-claude.ai',
        medium: 'referral',
        sourceDimension: 'session',
        landingPage: '/dedup-other',
        sessions: 3,
        users: 2,
        syncedAt: now,
      },
      {
        id: idClaudeFirst,
        projectId,
        date: dedupDate,
        source: 'dedup-claude.ai',
        medium: 'referral',
        sourceDimension: 'first_user',
        landingPage: '/dedup-other',
        sessions: 9,
        users: 7,
        syncedAt: now,
      },
    ]).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/ga/traffic',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // Three rows seeded for chatgpt.com → exactly one row in the API
      // response, surfacing the winning dimension.
      const chatgptRows = body.aiReferrals.filter((r: { source: string }) => r.source === 'dedup-chatgpt.com')
      expect(chatgptRows).toHaveLength(1)
      expect(chatgptRows[0]).toMatchObject({
        source: 'dedup-chatgpt.com',
        medium: 'referral',
        sourceDimension: 'session',
        sessions: 4,
      })

      // Two rows seeded for claude.ai → one winning-dimension row.
      const claudeRows = body.aiReferrals.filter((r: { source: string }) => r.source === 'dedup-claude.ai')
      expect(claudeRows).toHaveLength(1)
      expect(claudeRows[0]).toMatchObject({
        source: 'dedup-claude.ai',
        medium: 'referral',
        sourceDimension: 'first_user',
        sessions: 9,
      })

      // Landing-page table dedupes per (source, medium, landingPage).
      const chatgptLanding = body.aiReferralLandingPages.filter(
        (r: { source: string; landingPage: string }) =>
          r.source === 'dedup-chatgpt.com' && r.landingPage === '/dedup-page',
      )
      expect(chatgptLanding).toHaveLength(1)
      expect(chatgptLanding[0]).toMatchObject({
        source: 'dedup-chatgpt.com',
        sourceDimension: 'session',
        sessions: 4,
      })
      const claudeLanding = body.aiReferralLandingPages.filter(
        (r: { source: string; landingPage: string }) =>
          r.source === 'dedup-claude.ai' && r.landingPage === '/dedup-other',
      )
      expect(claudeLanding).toHaveLength(1)
      expect(claudeLanding[0]).toMatchObject({
        source: 'dedup-claude.ai',
        sourceDimension: 'first_user',
        sessions: 9,
      })

      // Output is sorted by sessions descending — the claude.ai winner (9)
      // ranks above the chatgpt.com winner (4).
      const dedupRows = body.aiReferrals.filter((r: { source: string }) => r.source.startsWith('dedup-'))
      expect(dedupRows[0].source).toBe('dedup-claude.ai')
      expect(dedupRows[1].source).toBe('dedup-chatgpt.com')
    } finally {
      db.delete(gaAiReferrals).where(inArray(gaAiReferrals.id, seededIds)).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/traffic reports AI referral sessions only, never a user count', async () => {
    // The eight withdrawn fields (4.135.0). GA reports `totalUsers` as a COUNT
    // DISTINCT at the grain requested, and `ga_ai_referrals` is keyed by
    // (date, source, medium, channelGroup, landingPage, sourceDimension), so
    // every one of these was a sum over rows that each re-counted the same
    // visitor. No un-dimensioned AI-referral fetch exists, so the number could
    // not be corrected — only withdrawn.
    const WITHDRAWN_SUMMARY_FIELDS = [
      'aiUsersDeduped',
      'paidAiUsersDeduped',
      'organicAiUsersDeduped',
      'aiUsersBySession',
      'paidAiUsersBySession',
      'organicAiUsersBySession',
    ] as const

    const now = new Date().toISOString()
    const projectRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/ai-users-withdrawn',
      payload: {
        displayName: 'AI Users Withdrawn',
        canonicalDomain: 'users-withdrawn.example',
        country: 'US',
        language: 'en',
      },
    })
    const withdrawnProjectId = JSON.parse(projectRes.payload).id as string
    credentials.set('ai-users-withdrawn', {
      projectName: 'ai-users-withdrawn',
      propertyId: '444333',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // A fixture that over-counts users on every axis at once: two landing
    // pages, two dates, two attribution lenses, and both traffic classes.
    // Summing the stored `users` column the way the withdrawn fields did gave
    // 20 (paid 6 + organic 14) for traffic one visitor could account for.
    const seeded = [
      { id: crypto.randomUUID(), date: '2026-05-01', medium: 'referral', trafficClass: 'organic' as const, sourceDimension: 'session', landingPage: '/a', sessions: 6, users: 5 },
      { id: crypto.randomUUID(), date: '2026-05-01', medium: 'referral', trafficClass: 'organic' as const, sourceDimension: 'session', landingPage: '/b', sessions: 4, users: 4 },
      { id: crypto.randomUUID(), date: '2026-05-01', medium: 'referral', trafficClass: 'organic' as const, sourceDimension: 'first_user', landingPage: '/a', sessions: 7, users: 6 },
      { id: crypto.randomUUID(), date: '2026-05-02', medium: 'referral', trafficClass: 'organic' as const, sourceDimension: 'session', landingPage: '/a', sessions: 5, users: 5 },
      { id: crypto.randomUUID(), date: '2026-05-02', medium: 'cpc', trafficClass: 'paid' as const, sourceDimension: 'session', landingPage: '/a', sessions: 8, users: 6 },
    ]

    try {
      db.insert(gaTrafficSummaries).values({
        id: crypto.randomUUID(),
        projectId: withdrawnProjectId,
        periodStart: '2026-05-01',
        periodEnd: '2026-05-02',
        totalSessions: 200,
        totalOrganicSessions: 50,
        totalUsers: 150,
        syncedAt: now,
      }).run()
      // A social row, so the per-row assertion below is not vacuous. The
      // stored users column is deliberately populated: the point is that the
      // ROUTE must not publish it, not that the column is empty.
      db.insert(gaSocialReferrals).values({
        id: crypto.randomUUID(),
        projectId: withdrawnProjectId,
        date: '2026-05-01',
        source: 'meta.ai',
        medium: 'social',
        channelGroup: 'Organic Social',
        sessions: 15,
        users: 12,
        syncedAt: now,
      }).run()
      db.insert(gaAiReferrals).values(seeded.map((row) => ({
        id: row.id,
        projectId: withdrawnProjectId,
        date: row.date,
        source: 'chatgpt.com',
        medium: row.medium,
        trafficClass: row.trafficClass,
        sourceDimension: row.sourceDimension,
        landingPage: row.landingPage,
        landingPageNormalized: row.landingPage,
        sessions: row.sessions,
        users: row.users,
        syncedAt: now,
      }))).run()

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/ai-users-withdrawn/ga/traffic',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // ── The withdrawal: none of the eight keys is emitted. ──────────────
      for (const field of WITHDRAWN_SUMMARY_FIELDS) {
        expect(body).not.toHaveProperty(field)
      }
      expect(body.aiReferrals.length).toBeGreaterThan(0)
      expect(body.aiReferralLandingPages.length).toBeGreaterThan(0)
      for (const row of body.aiReferrals) expect(row).not.toHaveProperty('users')
      for (const row of body.aiReferralLandingPages) expect(row).not.toHaveProperty('users')
      // The property-level user count is a different signal: GA deduplicates
      // that one itself against an un-dimensioned aggregate, so it survives.
      expect(body.totalUsers).toBe(150)
      // Social user counts do NOT survive. ga_social_referrals is keyed
      // (date, source, medium, channel group) and its users column is GA's
      // COUNT DISTINCT at that grain, so summing it over a window counts a
      // returning visitor once per day they returned. Same reasoning that
      // withdrew the AI-referral user counts in 4.135.0.
      expect(body).not.toHaveProperty('socialUsers')
      for (const row of body.socialReferrals) expect(row).not.toHaveProperty('users')
      // The loop above is vacuous when socialReferrals is empty, which is how an
      // incomplete withdrawal shipped once: the API stopped emitting the field
      // while the dashboard still called .toLocaleString() on it and the CLI
      // printed "undefined". Assert there is a row to check.
      expect(body.socialReferrals.length).toBeGreaterThan(0)

      // ── The session numbers are unchanged by the withdrawal. ────────────
      // Deduped folds the winner set: (05-01, referral) session lens 6+4=10
      // beats first_user 7; (05-02, referral) session 5; (05-02, cpc) paid 8.
      expect(body.aiSessionsDeduped).toBe(23)
      expect(body.paidAiSessionsDeduped).toBe(8)
      expect(body.organicAiSessionsDeduped).toBe(15)
      expect(body.paidAiSessionsDeduped + body.organicAiSessionsDeduped).toBe(body.aiSessionsDeduped)
      // Session-lens-only view: rows 1, 2, 4, 5 (the first_user row drops out).
      expect(body.aiSessionsBySession).toBe(23)
      expect(body.paidAiSessionsBySession).toBe(8)
      expect(body.organicAiSessionsBySession).toBe(15)
      expect(body.paidAiSessionsBySession + body.organicAiSessionsBySession).toBe(body.aiSessionsBySession)

      // Shares over the 200-session denominator, values and display strings.
      // 23/200 = 11.5% and 15/200 = 7.5% round to 12 and 8 on the wire, while
      // the displays keep the exact tenth.
      expect(body.aiSharePct).toBe(12)
      expect(body.aiSharePctBySession).toBe(12)
      expect(body.paidAiSharePct).toBe(4)
      expect(body.paidAiSharePctBySession).toBe(4)
      expect(body.organicAiSharePct).toBe(8)
      expect(body.organicAiSharePctBySession).toBe(8)
      expect(body.aiSharePctDisplay).toBe('11.5%')
      expect(body.aiSharePctBySessionDisplay).toBe('11.5%')
      expect(body.paidAiSharePctDisplay).toBe('4.0%')
      expect(body.paidAiSharePctBySessionDisplay).toBe('4.0%')
      expect(body.organicAiSharePctDisplay).toBe('7.5%')
      expect(body.organicAiSharePctBySessionDisplay).toBe('7.5%')
      expect(body.channelBreakdown.ai.sessions).toBe(23)

      // Per-row sessions still sum landing pages and dates inside one lens,
      // then keep the winning lens — exactly as before.
      expect(body.aiReferrals).toEqual([
        { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', sessions: 15 },
        { source: 'chatgpt.com', medium: 'cpc', trafficClass: 'paid', sourceDimension: 'session', sessions: 8 },
      ])
      expect(body.aiReferralLandingPages).toEqual(expect.arrayContaining([
        { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', landingPage: '/a', sessions: 11 },
        { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', landingPage: '/b', sessions: 4 },
        { source: 'chatgpt.com', medium: 'cpc', trafficClass: 'paid', sourceDimension: 'session', landingPage: '/a', sessions: 8 },
      ]))
      expect(body.aiReferralLandingPages).toHaveLength(3)
    } finally {
      credentials.delete('ai-users-withdrawn')
      db.delete(gaAiReferrals).where(inArray(gaAiReferrals.id, seeded.map((r) => r.id))).run()
      db.delete(gaTrafficSummaries).where(eq(gaTrafficSummaries.projectId, withdrawnProjectId)).run()
    }
  })

  it('GET /ga/attribution-trend ai channel uses sessionSource only (matches breakdown cell)', async () => {
    const now = new Date().toISOString()
    const daysAgo = (n: number): string => {
      const d = new Date()
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Current 7d window — seed at daysAgo(3).
    // sessionSource lens: 5 sessions; firstUserSource lens: 12 sessions.
    // Cross-dim MAX dedup would yield 12; sessionSource-only filter yields 5.
    const idCurSession = crypto.randomUUID()
    const idCurFirstUser = crypto.randomUUID()
    db.insert(gaAiReferrals).values({
      id: idCurSession,
      projectId,
      date: daysAgo(3),
      source: 'chatgpt.com',
      medium: 'referral',
      sourceDimension: 'session',
      sessions: 5,
      users: 4,
      syncedAt: now,
    }).run()
    db.insert(gaAiReferrals).values({
      id: idCurFirstUser,
      projectId,
      date: daysAgo(3),
      source: 'chatgpt.com',
      medium: 'referral',
      sourceDimension: 'first_user',
      sessions: 12,
      users: 10,
      syncedAt: now,
    }).run()

    // Prev 7d window — seed at daysAgo(10).
    // sessionSource lens: 3 sessions; firstUserSource lens: 8 sessions.
    const idPrevSession = crypto.randomUUID()
    const idPrevFirstUser = crypto.randomUUID()
    db.insert(gaAiReferrals).values({
      id: idPrevSession,
      projectId,
      date: daysAgo(10),
      source: 'chatgpt.com',
      medium: 'referral',
      sourceDimension: 'session',
      sessions: 3,
      users: 2,
      syncedAt: now,
    }).run()
    db.insert(gaAiReferrals).values({
      id: idPrevFirstUser,
      projectId,
      date: daysAgo(10),
      source: 'chatgpt.com',
      medium: 'referral',
      sourceDimension: 'first_user',
      sessions: 8,
      users: 6,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/ga/attribution-trend',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      // sessionSource-only counts, NOT cross-dim MAX (which would be 12 / 8).
      expect(body.ai.sessions7d).toBe(5)
      expect(body.ai.sessionsPrev7d).toBe(3)
      // (5 - 3) / 3 = 67% (rounded)
      expect(body.ai.trend7dPct).toBe(67)
      // aiBiggestMover should also report sessionSource-only counts. A prior
      // base of 3 is below MIN_PCT_BASE, so the session change is what to state.
      expect(body.aiBiggestMover).toEqual({
        source: 'chatgpt.com',
        sessions7d: 5,
        sessionsPrev7d: 3,
        changeSessions: 2,
        changePct: 67,
        changeBasis: 'small-base',
      })
    } finally {
      db.delete(gaAiReferrals).where(inArray(gaAiReferrals.id, [
        idCurSession, idCurFirstUser, idPrevSession, idPrevFirstUser,
      ])).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/attribution-trend exposes direct channel 7d trend', async () => {
    const now = new Date().toISOString()
    const daysAgo = (n: number): string => {
      const d = new Date()
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Current 7d window: daysAgo(7) inclusive → today exclusive. Seed at daysAgo(3).
    // Prev 7d window: daysAgo(14) inclusive → daysAgo(7) exclusive. Seed at daysAgo(10).
    const idCurrent = crypto.randomUUID()
    const idPrev = crypto.randomUUID()
    db.insert(gaTrafficSnapshots).values({
      id: idCurrent,
      projectId,
      date: daysAgo(3),
      landingPage: '/__direct-trend-current',
      sessions: 60,
      organicSessions: 0,
      directSessions: 50,
      users: 50,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSnapshots).values({
      id: idPrev,
      projectId,
      date: daysAgo(10),
      landingPage: '/__direct-trend-prev',
      sessions: 30,
      organicSessions: 0,
      directSessions: 25,
      users: 25,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/ga/attribution-trend',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.direct).toBeDefined()
      expect(body.direct.sessions7d).toBe(50)
      expect(body.direct.sessionsPrev7d).toBe(25)
      // (50 - 25) / 25 = 100%
      expect(body.direct.trend7dPct).toBe(100)
    } finally {
      db.delete(gaTrafficSnapshots).where(inArray(gaTrafficSnapshots.id, [idCurrent, idPrev])).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/social-referral-trend and /ga/attribution-trend call a source with no prior sessions new, never +100%', async () => {
    const now = new Date().toISOString()
    const daysAgo = (n: number): string => {
      const d = new Date()
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // tiktok.com appears this week with 4 sessions and none the week before;
    // facebook.com moves 1 -> 2, a smaller change.
    const rows = [
      { source: 'tiktok.com', date: daysAgo(3), sessions: 4 },
      { source: 'facebook.com', date: daysAgo(3), sessions: 2 },
      { source: 'facebook.com', date: daysAgo(10), sessions: 1 },
    ].map(row => ({ id: crypto.randomUUID(), projectId, medium: 'social', channelGroup: 'Organic Social', users: row.sessions, syncedAt: now, ...row }))
    db.insert(gaSocialReferrals).values(rows).run()

    const expectedMover = {
      source: 'tiktok.com',
      sessions7d: 4,
      sessionsPrev7d: 0,
      changeSessions: 4,
      changePct: null,
      changeBasis: 'new',
    }
    try {
      const socialRes = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/ga/social-referral-trend' })
      expect(socialRes.statusCode).toBe(200)
      // The raw body, not a parsed copy: parsing would strip a stray field.
      const social = JSON.parse(socialRes.payload)
      expect(gaSocialReferralTrendResponseSchema.safeParse(social).success).toBe(true)
      expect(social.biggestMover).toEqual(expectedMover)
      expect(social.socialSessions7d).toBe(6)
      expect(social.socialSessionsPrev7d).toBe(1)

      const attributionRes = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/ga/attribution-trend' })
      expect(attributionRes.statusCode).toBe(200)
      const attribution = JSON.parse(attributionRes.payload)
      expect(gaAttributionTrendResponseSchema.safeParse(attribution).success).toBe(true)
      expect(attribution.socialBiggestMover).toEqual(expectedMover)
      expect(attribution.aiBiggestMover).toBeNull()
    } finally {
      db.delete(gaSocialReferrals).where(inArray(gaSocialReferrals.id, rows.map(row => row.id))).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/attribution-trend reads an AI source that stopped sending sessions as -100%', async () => {
    const now = new Date().toISOString()
    const daysAgo = (n: number): string => {
      const d = new Date()
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // perplexity.ai sent 40 sessions last week and none this week, so it has
    // no row in the current period at all; chatgpt.com moves 3 -> 5.
    const rows = [
      { source: 'perplexity.ai', date: daysAgo(10), sessions: 40 },
      { source: 'chatgpt.com', date: daysAgo(3), sessions: 5 },
      { source: 'chatgpt.com', date: daysAgo(10), sessions: 3 },
    ].map(row => ({ id: crypto.randomUUID(), projectId, medium: 'referral', sourceDimension: 'session', users: row.sessions, syncedAt: now, ...row }))
    db.insert(gaAiReferrals).values(rows).run()

    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/ga/attribution-trend' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(gaAttributionTrendResponseSchema.safeParse(body).success).toBe(true)
      expect(body.aiBiggestMover).toEqual({
        source: 'perplexity.ai',
        sessions7d: 0,
        sessionsPrev7d: 40,
        changeSessions: -40,
        changePct: -100,
        changeBasis: 'percent',
      })
      // (5 - 43) / 43 = -88.4%, rounded to -88.
      expect(body.ai).toMatchObject({ sessions7d: 5, sessionsPrev7d: 43, trend7dPct: -88 })
    } finally {
      db.delete(gaAiReferrals).where(inArray(gaAiReferrals.id, rows.map(row => row.id))).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/coverage returns all pages', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/coverage',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.pages).toHaveLength(2)
    expect(body.pages[0].landingPage).toBe('/page-a')

    credentials.delete('test-project')
  })

  it('GET /ga/coverage collapses click-ID variants via landing_page_normalized', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Three rows that should collapse to a single canonical "/__cov-test-root"
    // page once the COALESCE-on-normalized path is applied. A fourth row
    // (different page) is kept distinct.
    const ids = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ]
    db.insert(gaTrafficSnapshots).values([
      {
        id: ids[0]!,
        projectId,
        date: '2026-03-22',
        landingPage: '/__cov-test-root?fbclid=A',
        landingPageNormalized: '/__cov-test-root',
        sessions: 5,
        organicSessions: 0,
        users: 5,
        syncedAt: now,
      },
      {
        id: ids[1]!,
        projectId,
        date: '2026-03-22',
        landingPage: '/__cov-test-root?fbclid=B',
        landingPageNormalized: '/__cov-test-root',
        sessions: 2,
        organicSessions: 0,
        users: 2,
        syncedAt: now,
      },
      {
        id: ids[2]!,
        projectId,
        date: '2026-03-22',
        landingPage: '/__cov-test-root',
        landingPageNormalized: '/__cov-test-root',
        sessions: 50,
        organicSessions: 10,
        users: 40,
        syncedAt: now,
      },
      {
        id: ids[3]!,
        projectId,
        date: '2026-03-22',
        landingPage: '/__cov-test-other',
        landingPageNormalized: '/__cov-test-other',
        sessions: 4,
        organicSessions: 1,
        users: 4,
        syncedAt: now,
      },
    ]).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/ga/coverage',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      const root = body.pages.find(
        (p: { landingPage: string }) => p.landingPage === '/__cov-test-root',
      )
      expect(root).toBeDefined()
      expect(root.sessions).toBe(57) // 5 + 2 + 50
      // Raw fragment variants must not appear separately
      expect(
        body.pages.some(
          (p: { landingPage: string }) => p.landingPage.includes('fbclid='),
        ),
      ).toBe(false)
    } finally {
      db.delete(gaTrafficSnapshots).where(inArray(gaTrafficSnapshots.id, ids)).run()
      credentials.delete('test-project')
    }
  })

  it('GET /ga/ai-referral-history returns error when no connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/ai-referral-history',
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/No GA4 connection/)
  })

  it('GET /ga/ai-referral-history returns per-date rows', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Insert multi-date AI referral data from two different sources
    db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-17',
      source: 'chatgpt.com',
      medium: 'referral',
      landingPage: '/pricing?utm_source=chatgpt.com',
      landingPageNormalized: '/pricing',
      sessions: 3,
      users: 2,
      syncedAt: now,
    }).run()
    db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-18',
      source: 'perplexity.ai',
      medium: 'referral',
      landingPage: '/guide?utm_source=perplexity.ai',
      landingPageNormalized: '/guide',
      sessions: 7,
      users: 6,
      syncedAt: now,
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/ai-referral-history',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string; source: string; medium: string; landingPage: string; sessions: number; users: number }>
    expect(body.length).toBeGreaterThanOrEqual(2)
    // Should be ordered by date
    const dates = body.map((r) => r.date)
    expect(dates).toEqual([...dates].sort())
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        date: '2026-03-17',
        source: 'chatgpt.com',
        landingPage: '/pricing',
        sessions: 3,
      }),
      expect.objectContaining({
        date: '2026-03-18',
        source: 'perplexity.ai',
        landingPage: '/guide',
        sessions: 7,
      }),
    ]))
    // Should include both sources
    const sources = body.map((r) => r.source)
    expect(sources).toContain('chatgpt.com')
    expect(sources).toContain('perplexity.ai')

    credentials.delete('test-project')
  })

  it('GET /ga/ai-referral-daily returns error when no connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/ai-referral-daily',
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/No GA4 connection/)
  })

  it('GET /ga/ai-referral-daily counts a landing-page-fragmented day at its real total and agrees with /ga/traffic', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    db.delete(gaAiReferrals).where(eq(gaAiReferrals.projectId, projectId)).run()

    // The real stored shape: one row per landing page, each worth exactly one
    // session, repeated across the three overlapping attribution lenses.
    const seed = (date: string, source: string, pages: number, dimensions: string[]) => {
      for (const sourceDimension of dimensions) {
        for (let page = 0; page < pages; page++) {
          db.insert(gaAiReferrals).values({
            id: crypto.randomUUID(),
            projectId,
            date,
            source,
            medium: 'referral',
            sourceDimension,
            channelGroup: 'Referral',
            trafficClass: 'organic',
            landingPage: `/page-${page}?utm_source=${source}`,
            landingPageNormalized: `/page-${page}`,
            sessions: 1,
            users: 1,
            syncedAt: now,
          }).run()
        }
      }
    }

    // Dated inside the seeded summary period (2026-02-19..2026-03-20). Both
    // surfaces measure that period when no window is given, so seeding outside
    // it would compare two empty windows and prove nothing.
    seed('2026-03-06', 'chatgpt', 35, ['session', 'first_user', 'manual_utm'])
    seed('2026-03-05', 'chatgpt', 18, ['session', 'first_user', 'manual_utm'])
    // One date in a single lens, and one source whose lenses disagree.
    seed('2026-03-03', 'chatgpt', 1, ['session'])
    seed('2026-03-02', 'perplexity.ai', 3, ['session'])
    seed('2026-03-02', 'perplexity.ai', 11, ['manual_utm'])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/ai-referral-daily',
    })
    expect(res.statusCode).toBe(200)
    const daily = JSON.parse(res.payload) as {
      days: Array<{ date: string; sessions: number; bySource: Array<{ source: string; sessions: number }> }>
      sources: string[]
      totalSessions: number
    }

    // Sessions only. GA counts users DISTINCT at the grain asked for, and these
    // rows are keyed to the landing page, so no user count here could be true.
    expect(res.payload).not.toMatch(/user/i)

    const byDate = new Map(daily.days.map((d) => [d.date, d]))
    // 35 real sessions, not 1 (one landing page) and not 105 (three lenses summed).
    expect(byDate.get('2026-03-06')!.sessions).toBe(35)
    expect(byDate.get('2026-03-05')!.sessions).toBe(18)
    expect(byDate.get('2026-03-03')!.sessions).toBe(1)
    // The winning lens for the disagreeing source, not the sum and not the loser.
    expect(byDate.get('2026-03-02')!.sessions).toBe(11)
    expect(byDate.get('2026-03-06')!.bySource).toEqual([
      expect.objectContaining({ source: 'chatgpt', sessions: 35 }),
    ])
    expect(daily.days.map((d) => d.date)).toEqual([...daily.days.map((d) => d.date)].sort())

    // The chart series and the summary card must agree for the same window.
    const trafficRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/traffic',
    })
    expect(trafficRes.statusCode).toBe(200)
    const traffic = JSON.parse(trafficRes.payload) as { aiSessionsDeduped: number }
    expect(daily.totalSessions).toBe(traffic.aiSessionsDeduped)
    expect(daily.totalSessions).toBe(65)
    expect(daily.days.reduce((sum, d) => sum + d.sessions, 0)).toBe(daily.totalSessions)

    db.delete(gaAiReferrals).where(eq(gaAiReferrals.projectId, projectId)).run()
    credentials.delete('test-project')
  })

  it('GET /ga/social-referral-history returns error when no connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/social-referral-history',
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/No GA4 connection/)
  })

  it('GET /ga/social-referral-history returns per-date rows', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // Insert multi-date social referral data from two different sources
    db.insert(gaSocialReferrals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-17',
      source: 'facebook.com',
      medium: 'social',
      sessions: 5,
      users: 4,
      syncedAt: now,
    }).run()
    db.insert(gaSocialReferrals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-18',
      source: 'linkedin.com',
      medium: 'social',
      sessions: 3,
      users: 2,
      syncedAt: now,
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/social-referral-history',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string; source: string; medium: string; sessions: number; users: number }>
    expect(body.length).toBeGreaterThanOrEqual(2)
    // Should be ordered by date
    const dates = body.map((r) => r.date)
    expect(dates).toEqual([...dates].sort())
    // Should include both sources
    const sources = body.map((r) => r.source)
    expect(sources).toContain('facebook.com')
    expect(sources).toContain('linkedin.com')

    credentials.delete('test-project')
    db.delete(gaSocialReferrals)
      .where(eq(gaSocialReferrals.projectId, projectId))
      .run()
  })

  it('GET /ga/session-history returns error when no connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/session-history',
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/No GA4 connection/)
  })

  it('GET /ga/session-history returns per-date aggregates', async () => {
    const now = new Date().toISOString()
    credentials.set('test-project', {
      projectName: 'test-project',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    db.delete(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, projectId))
      .run()

    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-17',
      landingPage: '/alpha',
      sessions: 10,
      organicSessions: 4,
      users: 8,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-17',
      landingPage: '/beta',
      sessions: 5,
      organicSessions: 1,
      users: 4,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-18',
      landingPage: '/alpha',
      sessions: 7,
      organicSessions: 3,
      users: 6,
      syncedAt: now,
    }).run()

    // 2026-03-17 has a deduplicated total (9) intentionally LOWER than the
    // landing-page sum (8 + 4 = 12) — one visitor read both pages. 03-18 is
    // left without one so the legacy fallback is exercised in the same series.
    db.insert(gaDailyTotals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-03-17',
      sessions: 15,
      users: 9,
      syncedAt: now,
      createdAt: now,
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/session-history',
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.payload) as Array<{
      date: string
      sessions: number
      organicSessions: number
      users: number
      usersSource: string
    }>
    expect(body).toEqual([
      { date: '2026-03-17', sessions: 15, organicSessions: 5, users: 9, usersSource: 'deduplicated' },
      { date: '2026-03-18', sessions: 7, organicSessions: 3, users: 6, usersSource: 'landing-page-sum' },
    ])

    credentials.delete('test-project')
    db.delete(gaDailyTotals)
      .where(eq(gaDailyTotals.projectId, projectId))
      .run()
    db.delete(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, projectId))
      .run()
  })

  describe('POST /ga/sync reports the window it actually synced', () => {
    // The bug: `--days 500` returned {"days": 500, "synced": true} while
    // writing exactly 90 days, so a caller could not tell truncated history
    // from a property that only had 90 days of data.
    async function syncWithDays(days: number | undefined, projectName: string) {
      const now = new Date().toISOString()
      const today = now.slice(0, 10)

      await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${projectName}`,
        payload: {
          displayName: projectName,
          canonicalDomain: `${projectName}.example`,
          country: 'US',
          language: 'en',
        },
      })

      credentials.set(projectName, {
        projectName,
        propertyId: '424242',
        clientEmail: 'sa@test.iam.gserviceaccount.com',
        privateKey: 'fake-key',
        createdAt: now,
        updatedAt: now,
      })

      const gaModule = await import('@ainyc/canonry-integration-google-analytics')
      const spies = [
        vi.spyOn(gaModule, 'getAccessToken').mockResolvedValue('mock-token'),
        vi.spyOn(gaModule, 'fetchTrafficByLandingPage').mockResolvedValue([]),
        vi.spyOn(gaModule, 'fetchAggregateSummary').mockResolvedValue({
          periodStart: today,
          periodEnd: today,
          totalSessions: 0,
          totalOrganicSessions: 0,
          totalUsers: 0,
        }),
        vi.spyOn(gaModule, 'fetchWindowSummary').mockImplementation(async (_t, _p, windowKey) => ({
          windowKey,
          periodStart: today,
          periodEnd: today,
          totalSessions: 0,
          totalOrganicSessions: 0,
          totalDirectSessions: 0,
          totalUsers: 0,
        })),
        vi.spyOn(gaModule, 'fetchDailyTotals').mockResolvedValue([]),
        vi.spyOn(gaModule, 'fetchAiReferrals').mockResolvedValue([]),
        vi.spyOn(gaModule, 'fetchSocialReferrals').mockResolvedValue([]),
      ]
      // fetchDailyTotals is the fetch that writes `ga_daily_totals` — the
      // table whose 90 rows exposed the bug. Its args are snapshotted BEFORE
      // mockRestore (which clears the call record) so we can assert the
      // CLIENT was handed the bounded window too: a response saying 90 while
      // the fetch was asked for 500 would just move the lie one layer down.
      const dailyTotalsSpy = spies[4]!

      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/projects/${projectName}/ga/sync`,
          payload: days === undefined ? {} : { days },
        })
        expect(res.statusCode).toBe(200)
        return {
          body: JSON.parse(res.payload),
          dailyTotalsArgs: dailyTotalsSpy.mock.calls.map((call) => call[2]),
        }
      } finally {
        for (const spy of spies) spy.mockRestore()
        credentials.delete(projectName)
      }
    }

    it('reports the clamped window, the request, and the clamped flag for --days 500', async () => {
      const { body, dailyTotalsArgs } = await syncWithDays(500, 'ga-clamp-over')

      expect(body.synced).toBe(true)
      expect(body.days).toBe(90)
      expect(body.requestedDays).toBe(500)
      expect(body.clamped).toBe(true)
      // The fetch layer got the bounded window, not the raw request.
      expect(dailyTotalsArgs).toEqual([90])
    })

    it('leaves an in-range window untouched and does not flag a clamp', async () => {
      const { body, dailyTotalsArgs } = await syncWithDays(14, 'ga-clamp-in-range')

      expect(body.days).toBe(14)
      expect(body.requestedDays).toBe(14)
      expect(body.clamped).toBe(false)
      expect(dailyTotalsArgs).toEqual([14])
    })

    it('treats the cap itself as an exact, unclamped window', async () => {
      const { body } = await syncWithDays(90, 'ga-clamp-boundary')

      expect(body.days).toBe(90)
      expect(body.requestedDays).toBe(90)
      expect(body.clamped).toBe(false)
    })

    it('clamps a zero-day request up to the floor and flags it', async () => {
      const { body, dailyTotalsArgs } = await syncWithDays(0, 'ga-clamp-under')

      expect(body.days).toBe(1)
      expect(body.requestedDays).toBe(0)
      expect(body.clamped).toBe(true)
      expect(dailyTotalsArgs).toEqual([1])
    })

    it('defaults an omitted window to 30 days without flagging a clamp', async () => {
      const { body } = await syncWithDays(undefined, 'ga-clamp-default')

      expect(body.days).toBe(30)
      expect(body.requestedDays).toBe(30)
      expect(body.clamped).toBe(false)
    })
  })

  it('POST /ga/connect does not accept keyFile parameter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/ga/connect',
      payload: { propertyId: '123456', keyFile: '/etc/passwd' },
    })
    // keyFile is a CLI-only concept; server ignores it and falls back to OAuth path.
    // With no OAuth store configured, returns 400 with OAuth guidance.
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/oauth|google connect/i)
  })
})
