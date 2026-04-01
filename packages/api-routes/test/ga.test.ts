import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { createClient, migrate, gaAiReferrals, gaTrafficSnapshots, gaTrafficSummaries } from '@ainyc/canonry-db'
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
      { date: '2026-03-20', source: 'chatgpt.com', medium: 'referral', sessions: 12, users: 9 },
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

    // Verify per-page rows were written
    const snapshots = db.select().from(gaTrafficSnapshots)
      .where(inArray(gaTrafficSnapshots.landingPage, ['/synced-a', '/synced-b']))
      .all()
    expect(snapshots).toHaveLength(2)

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

    // Cleanup
    getAccessTokenSpy.mockRestore()
    fetchTrafficSpy.mockRestore()
    fetchAggregateSpy.mockRestore()
    fetchAiReferralsSpy.mockRestore()
    credentials.delete('test-project')
    // Clean up synced data so it doesn't interfere with later tests
    db.delete(gaTrafficSnapshots)
      .where(inArray(gaTrafficSnapshots.landingPage, ['/synced-a', '/synced-b']))
      .run()
    db.delete(gaAiReferrals)
      .where(eq(gaAiReferrals.projectId, projectId))
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
    credentials.delete('test-project')
    db.delete(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, projectId))
      .run()
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
      { source: 'chatgpt.com', medium: 'referral', sessions: 17, users: 10 },
    ])
    expect(body.lastSyncedAt).toBe(now)

    credentials.delete('test-project')
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
      sessions: 7,
      users: 6,
      syncedAt: now,
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/ga/ai-referral-history',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string; source: string; medium: string; sessions: number; users: number }>
    expect(body.length).toBeGreaterThanOrEqual(2)
    // Should be ordered by date
    const dates = body.map((r) => r.date)
    expect(dates).toEqual([...dates].sort())
    // Should include both sources
    const sources = body.map((r) => r.source)
    expect(sources).toContain('chatgpt.com')
    expect(sources).toContain('perplexity.ai')

    credentials.delete('test-project')
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
