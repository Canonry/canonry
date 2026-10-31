import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate } from '@canonry/canonry-db'
import * as gaModule from '@canonry/canonry-integration-google-analytics'
import type { GA4RunReportRequest, GA4RunReportResponse } from '@canonry/canonry-integration-google-analytics'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'
import { dailyTotals, unknownWindowMetrics } from './ga-sync-fixtures.js'

/**
 * GA4's AI Assistant channel from the sync through the headline AI surfaces.
 *
 * The real `fetchAiReferrals` runs against a replay of the live-verified
 * exchange (`integration-google-analytics/test/fixtures`): GA4 answers each
 * pass with the captured rows only when it receives the captured request. The
 * rows include a source GA4 put in the channel that maps to no engine; it is
 * AI traffic and must reach every total under its own source.
 */

type Pass = 'session' | 'first_user' | 'manual_utm'

const fixture = JSON.parse(fs.readFileSync(
  new URL('../../integration-google-analytics/test/fixtures/ga4-ai-referrals-ai-assistant-channel.json', import.meta.url),
  'utf8',
)) as { passes: Record<Pass, { request: GA4RunReportRequest; response: GA4RunReportResponse }> }

const PASS_BY_SOURCE_DIMENSION: Record<string, Pass> = {
  [gaModule.GA4_DIMENSIONS.sessionSource]: 'session',
  [gaModule.GA4_DIMENSIONS.firstUserSource]: 'first_user',
  [gaModule.GA4_DIMENSIONS.sessionManualSource]: 'manual_utm',
}

const NOW = '2026-10-08T12:00:00.000Z'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-ai-channel-'))
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
  return { app, credentials, tmpDir }
}

function replayGa4(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as GA4RunReportRequest
    const captured = fixture.passes[PASS_BY_SOURCE_DIMENSION[body.dimensions[1]!.name]!]
    const { dateRanges: _sent, ...sent } = body
    const { dateRanges: _expected, ...expected } = captured.request
    const matches = isDeepStrictEqual(sent, expected)
    return new Response(
      JSON.stringify(matches ? captured.response : { error: { code: 400, message: 'unexpected request', status: 'INVALID_ARGUMENT' } }),
      { status: matches ? 200 : 400, headers: { 'Content-Type': 'application/json' } },
    )
  })
}

/** Every GA4 fetch except the AI referral passes, which go through `replayGa4`. */
function stubOtherGa4Fetches(): void {
  const period = { periodStart: '2026-09-08', periodEnd: '2026-10-07' }
  vi.spyOn(gaModule, 'getAccessToken').mockResolvedValue('fake-token')
  vi.spyOn(gaModule, 'fetchAggregateSummary').mockResolvedValue({
    ...period, totalSessions: 400, totalOrganicSessions: 150, totalUsers: 280,
  })
  vi.spyOn(gaModule, 'fetchWindowSummary').mockImplementation(async (_t, _p, windowKey) => ({
    windowKey, ...period, totalSessions: 400, totalOrganicSessions: 150, totalDirectSessions: 40, totalUsers: 280,
  }))
  vi.spyOn(gaModule, 'fetchDailyTotals').mockResolvedValue(dailyTotals())
  vi.spyOn(gaModule, 'fetchWindowMetrics').mockImplementation(async (_token, _property, windowKey) => unknownWindowMetrics(windowKey))
  vi.spyOn(gaModule, 'fetchTrafficByLandingPage').mockResolvedValue([])
  vi.spyOn(gaModule, 'fetchAcquisitionByChannel').mockResolvedValue({ startDate: period.periodStart, endDate: period.periodEnd, rows: [] })
}

describe('GA4 AI Assistant channel through the AI referral sync', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(async () => {
    ctx = buildApp()
    await ctx.app.ready()
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/channel',
      payload: { displayName: 'Channel', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    expect(response.statusCode).toBe(201)
    ctx.credentials.set('channel', {
      projectName: 'channel',
      propertyId: '123456',
      clientEmail: 'channel@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('counts each AI visit once, unattributed AI Assistant sources included', async () => {
    stubOtherGa4Fetches()
    replayGa4()

    const sync = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/channel/ga/sync',
      payload: { days: 90, only: 'ai' },
    })
    expect(sync.statusCode).toBe(200)
    // 5 session + 5 first-user + 4 manual UTM rows, stored as GA4 reported them.
    expect(JSON.parse(sync.payload).aiReferralCount).toBe(14)

    const traffic = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/channel/ga/traffic' })
    expect(traffic.statusCode).toBe(200)
    const body = JSON.parse(traffic.payload) as {
      aiSessionsDeduped: number
      aiSessionsBySession: number
      organicAiSessionsDeduped: number
      paidAiSessionsDeduped: number
      aiReferrals: Array<{ source: string; medium: string; trafficClass: string; sourceDimension: string; sessions: number }>
    }
    // chatgpt.com 3 + grok.com 2 + chat.mistral.ai 2 + chat.deepseek.com 1 +
    // perplexity.ai 1. Each visit is reported by up to three lenses; summing
    // the lenses would give 24.
    expect(body.aiSessionsDeduped).toBe(9)
    expect(body.aiSessionsBySession).toBe(9)
    expect(body.organicAiSessionsDeduped).toBe(9)
    expect(body.paidAiSessionsDeduped).toBe(0)
    expect([...body.aiReferrals].sort((a, b) => a.source.localeCompare(b.source)).map(r => [r.source, r.sessions])).toEqual([
      ['chat.deepseek.com', 1],
      ['chat.mistral.ai', 2],
      ['chatgpt.com', 3],
      ['grok.com', 2],
      ['perplexity.ai', 1],
    ])
    // No engine is named for it, and none is invented: the row keeps GA4's source.
    expect(body.aiReferrals.find(r => r.source === 'chat.mistral.ai')).toEqual({
      source: 'chat.mistral.ai',
      medium: 'ai-assistant',
      trafficClass: 'organic',
      sourceDimension: 'session',
      sessions: 2,
      share: expect.any(Number),
    })

    const daily = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/channel/ga/ai-referral-daily' })
    expect(daily.statusCode).toBe(200)
    const series = JSON.parse(daily.payload) as {
      totalSessions: number
      days: Array<{ date: string; sessions: number; bySource: Array<{ source: string; sessions: number }> }>
    }
    expect(series.totalSessions).toBe(9)
    expect(series.days.map(day => [day.date, day.sessions])).toEqual([
      ['2026-10-05', 5],
      ['2026-10-06', 3],
      ['2026-10-07', 1],
    ])
    expect(series.days[1]!.bySource).toContainEqual(expect.objectContaining({ source: 'chat.mistral.ai', sessions: 2 }))
  })
})
