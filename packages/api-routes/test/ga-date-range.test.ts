import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, gaAiReferrals, gaSocialReferrals, gaTrafficSnapshots, gaDailyTotals } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialStore, Ga4CredentialRecord } from '../src/ga.js'

// Calendar-month reporting is the whole point of these routes carrying explicit
// dates: a rolling window anchored to "now" can never name May, so every
// monthly client total had to be hand-filtered out of a wider pull, and a real
// pull lost the 1st and 2nd of a month that way.
const MAY_DATES = Array.from({ length: 31 }, (_, i) => `2026-05-${String(i + 1).padStart(2, '0')}`)
const OUTSIDE_DATES = ['2026-04-28', '2026-04-29', '2026-04-30', '2026-06-01', '2026-06-02']

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-date-range-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const credentials = new Map<string, Ga4CredentialRecord>()
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

describe('GA4 routes: explicit date ranges', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let projectId: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/date-range',
      payload: {
        displayName: 'Date Range',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    projectId = JSON.parse(res.payload).id

    const now = new Date().toISOString()
    ctx.credentials.set('date-range', {
      projectName: 'date-range',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    for (const date of [...OUTSIDE_DATES, ...MAY_DATES]) {
      db.insert(gaTrafficSnapshots).values({
        id: crypto.randomUUID(),
        projectId,
        date,
        landingPage: '/alpha',
        sessions: 10,
        organicSessions: 4,
        directSessions: 2,
        users: 8,
        syncedAt: now,
      }).run()
      db.insert(gaDailyTotals).values({
        id: crypto.randomUUID(),
        projectId,
        date,
        sessions: 10,
        users: 7,
        syncedAt: now,
        createdAt: now,
      }).run()
      db.insert(gaAiReferrals).values({
        id: crypto.randomUUID(),
        projectId,
        date,
        source: 'chatgpt.com',
        medium: 'referral',
        trafficClass: 'organic',
        sourceDimension: 'session',
        channelGroup: 'Referral',
        landingPage: '/alpha',
        sessions: 3,
        users: 3,
        syncedAt: now,
      }).run()
      db.insert(gaSocialReferrals).values({
        id: crypto.randomUUID(),
        projectId,
        date,
        source: 'linkedin.com',
        medium: 'referral',
        channelGroup: 'Organic Social',
        sessions: 2,
        users: 2,
        syncedAt: now,
      }).run()
    }
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GET /ga/session-history returns exactly the requested calendar month', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/session-history?startDate=2026-05-01&endDate=2026-05-31',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string; sessions: number }>
    expect(body).toHaveLength(31)
    expect(body[0]!.date).toBe('2026-05-01')
    expect(body[body.length - 1]!.date).toBe('2026-05-31')
    expect(body.map((r) => r.date)).toEqual(MAY_DATES)
    // The month total is the whole point: 31 days x 10 sessions, and not one
    // session from the April or June rows sitting either side of it.
    expect(body.reduce((sum, r) => sum + r.sessions, 0)).toBe(310)
  })

  it('GET /ga/session-history honours startDate alone as an open-ended lower bound', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/session-history?startDate=2026-06-01',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string }>
    expect(body.map((r) => r.date)).toEqual(['2026-06-01', '2026-06-02'])
  })

  it('GET /ga/session-history honours endDate alone as an open-ended upper bound', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/session-history?endDate=2026-04-30',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string }>
    expect(body.map((r) => r.date)).toEqual(['2026-04-28', '2026-04-29', '2026-04-30'])
  })

  it('GET /ga/session-history lets explicit dates win over a window supplied alongside them', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/session-history?startDate=2026-05-01&endDate=2026-05-31&window=7d',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string }>
    // A rolling 7d window would return nothing at all for these fixture dates,
    // so this also proves the window did not quietly win.
    expect(body).toHaveLength(31)
    expect(body[0]!.date).toBe('2026-05-01')
  })

  it('GET /ga/session-history still returns every row when no filter is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/session-history',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string }>
    expect(body).toHaveLength(MAY_DATES.length + OUTSIDE_DATES.length)
  })

  it('GET /ga/session-history rejects an unrecognised window instead of returning all history', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/session-history?window=60d',
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/60d/)
  })

  it('GET /ga/session-history still honours a valid rolling window', async () => {
    // 30d is anchored to now, and every fixture row is dated 2026, so a correct
    // 30d filter returns nothing. The regression this guards is the opposite:
    // a broken window returning the whole table.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/session-history?window=30d',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string }>
    expect(body).toEqual([])
  })

  it('GET /ga/session-history rejects a malformed date', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/session-history?startDate=05%2F01%2F2026',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR')
  })

  it('GET /ga/ai-referral-history scopes to the requested month', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/ai-referral-history?startDate=2026-05-01&endDate=2026-05-31',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string; sessions: number }>
    expect(body).toHaveLength(31)
    expect(body[0]!.date).toBe('2026-05-01')
    expect(body[body.length - 1]!.date).toBe('2026-05-31')
  })

  it('GET /ga/ai-referral-daily scopes to the requested month', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/ai-referral-daily?startDate=2026-05-01&endDate=2026-05-31',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as { days: Array<{ date: string }>; totalSessions: number }
    expect(body.days).toHaveLength(31)
    expect(body.days[0]!.date).toBe('2026-05-01')
    expect(body.totalSessions).toBe(93)
  })

  it('GET /ga/social-referral-history scopes to the requested month', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/social-referral-history?startDate=2026-05-01&endDate=2026-05-31',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ date: string }>
    expect(body).toHaveLength(31)
    expect(body[0]!.date).toBe('2026-05-01')
    expect(body[body.length - 1]!.date).toBe('2026-05-31')
  })

  it('GET /ga/traffic scopes its totals to the requested month', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/traffic?startDate=2026-05-01&endDate=2026-05-31',
    })
    expect(res.statusCode, res.payload).toBe(200)
    const body = JSON.parse(res.payload) as {
      totalSessions: number
      totalOrganicSessions: number
      totalDirectSessions: number
      aiSessionsDeduped: number
      topPages: Array<{ landingPage: string; sessions: number }>
      periodStart: string | null
      periodEnd: string | null
    }
    expect(body.totalSessions).toBe(310)
    expect(body.totalOrganicSessions).toBe(124)
    expect(body.totalDirectSessions).toBe(62)
    expect(body.aiSessionsDeduped).toBe(93)
    expect(body.topPages).toHaveLength(1)
    expect(body.topPages[0]!.sessions).toBe(310)
    // The reported period must be the range that was actually measured, or the
    // caller cannot tell which month the totals belong to.
    expect(body.periodStart).toBe('2026-05-01')
    expect(body.periodEnd).toBe('2026-05-31')
  })

  it('GET /ga/traffic rejects an unrecognised window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/date-range/ga/traffic?window=60d',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR')
  })
})
