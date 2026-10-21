import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, gaAiReferrals, gaSocialReferrals, gaTrafficSummaries, migrate } from '@canonry/canonry-db'
import { ga4AiReferralDailyDtoSchema, gaTrafficResponseSchema } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'

/**
 * Engine and platform groups on `/ga/traffic` and `/ga/ai-referral-daily`,
 * read from rows stored the way a GA4 sync writes them.
 */

const NOW = '2026-10-21T12:00:00.000Z'
const PERIOD = { periodStart: '2026-10-01', periodEnd: '2026-10-07' }

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-groups-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const credentials = new Map<string, Ga4CredentialRecord>()
  const ga4CredentialStore: Ga4CredentialStore = {
    getConnection: projectName => credentials.get(projectName),
    upsertConnection: (connection) => {
      credentials.set(connection.projectName, connection)
      return connection
    },
    deleteConnection: projectName => credentials.delete(projectName),
  }
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ga4CredentialStore })
  return { app, db, credentials, tmpDir }
}

type Ctx = ReturnType<typeof buildApp> & { projectId: string }

function social(ctx: Ctx, date: string, source: string, medium: string, channelGroup: string, sessions: number) {
  ctx.db.insert(gaSocialReferrals).values({
    id: crypto.randomUUID(), projectId: ctx.projectId, date, source, medium, channelGroup, sessions, users: sessions, syncedAt: NOW,
  }).run()
}

function ai(ctx: Ctx, date: string, source: string, medium: string, trafficClass: 'organic' | 'paid', sessions: number, sourceDimension = 'session') {
  ctx.db.insert(gaAiReferrals).values({
    id: crypto.randomUUID(), projectId: ctx.projectId, date, source, medium, trafficClass, sourceDimension,
    channelGroup: 'AI Assistant', landingPage: '/', landingPageNormalized: '/', sessions, users: sessions, syncedAt: NOW,
  }).run()
}

describe('GA4 referral groups', () => {
  let ctx: Ctx

  beforeEach(async () => {
    const base = buildApp()
    await base.app.ready()
    const res = await base.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/groups',
      payload: { displayName: 'Groups', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    expect(res.statusCode).toBe(201)
    ctx = { ...base, projectId: (JSON.parse(res.body) as { id: string }).id }
    ctx.credentials.set('groups', {
      projectName: 'groups', propertyId: '123456', clientEmail: 'groups@test.iam.gserviceaccount.com', privateKey: 'fake-key', createdAt: NOW, updatedAt: NOW,
    })
    ctx.db.insert(gaTrafficSummaries).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, ...PERIOD, totalSessions: 1000, totalOrganicSessions: 400, totalUsers: 800, syncedAt: NOW,
    }).run()
  })

  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  async function traffic() {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/groups/ga/traffic' })
    expect(res.statusCode).toBe(200)
    return gaTrafficResponseSchema.parse(JSON.parse(res.body))
  }

  it('groups social sources by platform, partitioning the social total', async () => {
    social(ctx, '2026-10-01', 'ig', 'social', 'Organic Social', 40)
    social(ctx, '2026-10-02', 'ig', 'social', 'Organic Social', 7)
    social(ctx, '2026-10-01', 'l.instagram.com', 'referral', 'Organic Social', 19)
    social(ctx, '2026-10-03', 'Instagram+Story', 'social', 'Organic Social', 4)
    social(ctx, '2026-10-02', 'ig', 'paidsocial', 'Paid Social', 6)
    social(ctx, '2026-10-01', 'Pinterest', 'PaidSocial', 'Paid Social', 30)
    social(ctx, '2026-10-02', 'pinterest.com', 'referral', 'Organic Social', 10)
    // No platform names it: its own group under its own name, never dropped.
    social(ctx, '2026-10-03', 'forum.example', 'referral', 'Organic Social', 3)

    const body = await traffic()

    expect(body.socialSessions).toBe(119)
    expect(body.socialPlatforms.map(g => [g.platform, g.label, g.sessions, g.organicSessions, g.paidSessions, g.sources.length])).toEqual([
      ['instagram', 'Instagram', 76, 70, 6, 4],
      ['pinterest', 'Pinterest', 40, 10, 30, 2],
      [null, 'forum.example', 3, 3, 0, 1],
    ])
    // The groups partition the total: every row lands in exactly one group.
    expect(body.socialPlatforms.reduce((sum, g) => sum + g.sessions, 0)).toBe(body.socialSessions)
    expect(body.socialPlatforms.flatMap(g => g.sources).length).toBe(body.socialReferrals.length)
    expect(body.socialPlatforms.reduce((sum, g) => sum + g.share, 0)).toBeCloseTo(1, 10)
    expect(body.socialPlatforms[0]!.share).toBeCloseTo(76 / 119, 10)
    // Raw rows keep their own share of all social sessions.
    expect(body.socialPlatforms[0]!.sources[0]).toMatchObject({ source: 'ig', medium: 'social', sessions: 47 })
    expect(body.socialPlatforms[0]!.sources[0]!.share).toBeCloseTo(47 / 119, 10)

    expect(body.paidSocialSessions).toBe(36)
    expect(body.paidSocialShare).toBeCloseTo(36 / 119, 10)
  })

  it('charts social by platform with a value for every series on every day', async () => {
    social(ctx, '2026-10-01', 'ig', 'social', 'Organic Social', 5)
    social(ctx, '2026-10-02', 'facebook', 'paid', 'Paid Social', 4)
    social(ctx, '2026-10-02', 'linkedin.com', 'referral', 'Organic Social', 3)
    social(ctx, '2026-10-03', 'reddit.com', 'referral', 'Organic Social', 2)
    social(ctx, '2026-10-03', 'youtube.com', 'referral', 'Organic Social', 2)
    social(ctx, '2026-10-03', 't.co', 'referral', 'Organic Social', 1)
    social(ctx, '2026-10-03', 'nextdoor.com', 'referral', 'Organic Social', 1)

    const { socialPlatformDaily: daily, socialSessions } = await traffic()

    // Five platforms keep their series; the other two fold into one.
    expect(daily.series.map(s => s.key)).toEqual(['instagram', 'facebook', 'linkedin', 'reddit', 'youtube', 'other'])
    expect(daily.otherCount).toBe(2)
    expect(daily.days.map(d => d.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    for (const day of daily.days) {
      expect(Object.keys(day.values).sort()).toEqual(daily.series.map(s => s.key).sort())
      expect(Object.values(day.values).reduce((sum, v) => sum + v, 0)).toBe(day.sessions)
    }
    expect(daily.days[0]!.values).toEqual({ instagram: 5, facebook: 0, linkedin: 0, reddit: 0, youtube: 0, other: 0 })
    expect(daily.days.reduce((sum, d) => sum + d.sessions, 0)).toBe(socialSessions)
  })

  it('groups AI sources by engine and keeps unattributed AI as its own, last group', async () => {
    ai(ctx, '2026-10-01', 'chatgpt.com', 'ai-assistant', 'organic', 12)
    ai(ctx, '2026-10-02', 'chatgpt', 'cpc', 'paid', 4)
    ai(ctx, '2026-10-02', 'perplexity.ai', 'ai-assistant', 'organic', 3)
    // GA4 filed it under AI Assistant; no engine matches it.
    ai(ctx, '2026-10-03', 'assistant.example', 'ai-assistant', 'organic', 20)

    const body = await traffic()

    expect(body.aiEngines.map(g => [g.engine, g.label, g.sessions, g.organicSessions, g.paidSessions, g.sources.map(s => s.source)])).toEqual([
      ['chatgpt', 'ChatGPT', 16, 12, 4, ['chatgpt.com', 'chatgpt']],
      ['perplexity', 'Perplexity', 3, 3, 0, ['perplexity.ai']],
      [null, 'Unattributed AI', 20, 20, 0, ['assistant.example']],
    ])
    const rowsTotal = body.aiReferrals.reduce((sum, r) => sum + r.sessions, 0)
    expect(body.aiEngines.reduce((sum, g) => sum + g.sessions, 0)).toBe(rowsTotal)
    expect(body.aiEngines.reduce((sum, g) => sum + g.share, 0)).toBeCloseTo(1, 10)
    expect(body.aiSessionsDeduped).toBe(39)
  })

  it('splits the AI daily series by engine from the same winners as the day totals', async () => {
    // One visit seen by two lenses: the series must count it once, as the totals do.
    ai(ctx, '2026-10-01', 'chatgpt.com', 'ai-assistant', 'organic', 5, 'session')
    ai(ctx, '2026-10-01', 'chatgpt.com', '(not set)', 'organic', 5, 'manual_utm')
    ai(ctx, '2026-10-02', 'assistant.example', 'ai-assistant', 'organic', 2)
    ai(ctx, '2026-10-02', 'claude.ai', 'ai-assistant', 'organic', 1)

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/groups/ga/ai-referral-daily' })
    expect(res.statusCode).toBe(200)
    const body = ga4AiReferralDailyDtoSchema.parse(JSON.parse(res.body))

    expect(body.totalSessions).toBe(8)
    expect(body.byEngine.series).toEqual([
      { key: 'chatgpt', label: 'ChatGPT', sessions: 5 },
      { key: 'unattributed', label: 'Unattributed AI', sessions: 2 },
      { key: 'claude', label: 'Claude', sessions: 1 },
    ])
    expect(body.byEngine.days.map(d => [d.date, d.sessions, d.values])).toEqual([
      ['2026-10-01', 5, { chatgpt: 5, unattributed: 0, claude: 0 }],
      ['2026-10-02', 3, { chatgpt: 0, unattributed: 2, claude: 1 }],
    ])
    expect(body.byEngine.days.map(d => d.sessions)).toEqual(body.days.map(d => d.sessions))
  })
})
