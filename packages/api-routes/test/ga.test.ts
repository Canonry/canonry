import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { createClient, migrate, gaAiReferrals, gaSocialReferrals, gaTrafficSnapshots, gaTrafficSummaries, runs } from '@ainyc/canonry-db'
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
    expect(body.error.message).toMatch(/OAuth|oauth|google connect/i)
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
    const fetchAiReferralsSpy = vi.spyOn(gaModule, 'fetchAiReferrals').mockResolvedValue([
      { date: '2026-03-20', source: 'chatgpt.com', medium: 'referral', landingPage: '/pricing?utm_source=chatgpt.com', sessions: 12, users: 9, sourceDimension: 'session' },
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

    const aiReferrals = db.select().from(gaAiReferrals)
      .where(eq(gaAiReferrals.projectId, projectId))
      .all()
    expect(aiReferrals).toHaveLength(1)
    expect(aiReferrals[0]!.source).toBe('chatgpt.com')
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
    fetchAiReferralsSpy.mockRestore()
    fetchSocialReferralsSpy.mockRestore()
    credentials.delete('test-project')
    db.delete(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, projectId))
      .run()
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
    expect(body.aiReferrals).toEqual([
      { source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 17, users: 10 },
    ])
    expect(body.aiReferralLandingPages).toEqual([
      { source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', landingPage: '/page-a', sessions: 17, users: 10 },
    ])
    expect(body.aiSessionsDeduped).toBe(17)
    expect(body.aiUsersDeduped).toBe(10)
    // Only sessionSource-attributed rows seeded, so bySession matches dedup here.
    expect(body.aiSessionsBySession).toBe(17)
    expect(body.aiUsersBySession).toBe(10)
    expect(body.aiSharePctBySession).toBe(5)
    expect(body.socialReferrals).toEqual([])
    expect(body.socialSessions).toBe(0)
    expect(body.socialUsers).toBe(0)
    expect(body.organicSharePct).toBe(50)
    expect(body.aiSharePct).toBe(5)
    expect(body.socialSharePct).toBe(0)
    expect(body.organicSharePctDisplay).toBe('50%')
    expect(body.aiSharePctDisplay).toBe('5%')
    expect(body.aiSharePctBySessionDisplay).toBe('5%')
    expect(body.socialSharePctDisplay).toBe('0%')
    expect(body.directSharePctDisplay).toBe('0%')
    expect(body.lastSyncedAt).toBe(now)
    expect(body.periodStart).toBe('2026-02-19')
    expect(body.periodEnd).toBe('2026-03-20')

    credentials.delete('test-project')
  })

  it('GET /ga/traffic returns "<1%" display when AI sessions are present but rounded pct is 0', async () => {
    // Seed a fresh project so we don't pollute the shared row counts.
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const projRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/sub-one-pct',
      payload: {
        displayName: 'Sub One Pct',
        canonicalDomain: 'sub-one.example',
        country: 'US',
        language: 'en',
      },
    })
    const subProjectId = JSON.parse(projRes.payload).id

    credentials.set('sub-one-pct', {
      projectName: 'sub-one-pct',
      propertyId: '111222',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    // 6,000 total sessions, 18 AI referrals → 0.3%, which Math.round flattens to 0%.
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
      sessions: 18,
      users: 13,
      syncedAt: now,
    }).run()

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/sub-one-pct/ga/traffic',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.aiSessionsBySession).toBe(18)
      // The integer pct still rounds to 0, preserved for back-compat...
      expect(body.aiSharePctBySession).toBe(0)
      // ...but the display string surfaces the non-zero share as "<1%".
      expect(body.aiSharePctBySessionDisplay).toBe('<1%')
      expect(body.aiSharePctDisplay).toBe('<1%')
      // Channels with truly zero sessions still render "0%" (no false "<1%").
      expect(body.socialSharePctDisplay).toBe('0%')
      // 600 / 6000 = 10%
      expect(body.organicSharePctDisplay).toBe('10%')
    } finally {
      db.delete(gaAiReferrals).where(eq(gaAiReferrals.id, aiId)).run()
      db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.id, snapshotId)).run()
      credentials.delete('sub-one-pct')
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
    // periodEnd still reflects full synced range
    expect(body.periodEnd).toBe('2026-03-20')
    // periodStart is clamped: cutoff (~2026-04-04) > periodEnd, so falls back to summary start
    expect(body.periodStart).toBe('2026-02-19')

    credentials.delete('test-project')
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
    const distinctDate = '2025-12-31'
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
      // aiBiggestMover should also report sessionSource-only counts.
      expect(body.aiBiggestMover).toEqual({
        source: 'chatgpt.com',
        sessions7d: 5,
        sessionsPrev7d: 3,
        changePct: 67,
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
    }>
    expect(body).toEqual([
      { date: '2026-03-17', sessions: 15, organicSessions: 5, users: 12 },
      { date: '2026-03-18', sessions: 7, organicSessions: 3, users: 6 },
    ])

    credentials.delete('test-project')
    db.delete(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, projectId))
      .run()
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
    expect(body.error.message).toMatch(/OAuth|oauth|google connect/i)
  })
})
