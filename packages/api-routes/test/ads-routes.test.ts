import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { AppError } from '@ainyc/canonry-contracts'
import {
  createClient,
  migrate,
  projects,
  runs,
  auditLog,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
} from '@ainyc/canonry-db'
import { adsRoutes } from '../src/ads.js'
import type { AdsConnectionConfigEntryLike, VerifiedAdsAccount } from '../src/ads.js'

const NOW = '2026-06-10T00:00:00.000Z'

const VERIFIED: VerifiedAdsAccount = {
  id: 'adacct_aaa',
  name: 'Acme Exteriors, Inc',
  status: 'active',
  currencyCode: 'USD',
  timezone: 'America/Denver',
}

function buildApp(overrides: { verifyShouldFail?: boolean } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-routes-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const configConnections: AdsConnectionConfigEntryLike[] = []
  const syncRequests: Array<{ runId: string; projectId: string }> = []

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })

  void app.register(adsRoutes, {
    adsCredentialStore: {
      getConnection: (projectName) => configConnections.find((c) => c.projectName === projectName),
      upsertConnection: (entry) => {
        const idx = configConnections.findIndex((c) => c.projectName === entry.projectName)
        if (idx === -1) configConnections.push(entry)
        else configConnections[idx] = entry
        return entry
      },
      removeConnection: (projectName) => {
        const idx = configConnections.findIndex((c) => c.projectName === projectName)
        if (idx === -1) return false
        configConnections.splice(idx, 1)
        return true
      },
    },
    verifyAdsAccount: async (apiKey) => {
      if (overrides.verifyShouldFail || apiKey === 'bad-key') {
        throw new Error('OpenAI Ads API key is invalid or unauthorized')
      }
      return VERIFIED
    },
    onAdsSyncRequested: (runId, projectId) => {
      syncRequests.push({ runId, projectId })
    },
  })

  function seedProject(name = 'acme'): string {
    const id = crypto.randomUUID()
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: `${name}.example`,
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
    }).run()
    return id
  }

  function seedConnection(projectId: string) {
    db.insert(adsConnections).values({
      id: crypto.randomUUID(), projectId, adAccountId: 'adacct_aaa',
      displayName: 'Acme Exteriors, Inc', currencyCode: 'USD', timezone: 'America/Denver',
      status: 'active', lastSyncedAt: NOW, createdAt: NOW, updatedAt: NOW,
    }).run()
  }

  function seedSnapshots(projectId: string) {
    db.insert(adsCampaigns).values({
      id: 'cmpn_bbb', projectId, name: 'Homeowners Free Estimate', status: 'active',
      biddingType: 'clicks', dailySpendLimitMicros: 150_000_000, syncedAt: NOW,
    }).run()
    db.insert(adsAdGroups).values({
      id: 'adgrp_ddd', projectId, campaignId: 'cmpn_bbb', name: 'Deck Project Planning',
      status: 'active', billingEventType: 'click', maxBidMicros: 2_000_000,
      contextHints: ['how much does a new deck cost', 'measure my yard'], syncedAt: NOW,
    }).run()
    db.insert(adsAds).values({
      id: 'ad_eee', projectId, adGroupId: 'adgrp_ddd', name: 'HO Deck - Materials',
      status: 'active', reviewStatus: 'approved',
      creative: { type: 'chat_card', title: 'Free Estimate', body: 'b', target_url: 'https://lp.example/x' },
      syncedAt: NOW,
    }).run()
  }

  function seedInsights(projectId: string) {
    const rows = [
      { level: 'campaign', entityId: 'cmpn_bbb', date: '2026-06-09', impressions: 3326, clicks: 40, spendMicros: 90_450_000 },
      { level: 'campaign', entityId: 'cmpn_bbb', date: '2026-06-10', impressions: 1736, clicks: 23, spendMicros: 39_280_000 },
      // subdivision of the campaign rows — must NOT be double-counted in summary totals
      { level: 'ad_group', entityId: 'adgrp_ddd', date: '2026-06-10', impressions: 64, clicks: 1, spendMicros: 570_000 },
      // zero-denominator edge: no clicks
      { level: 'campaign', entityId: 'cmpn_bbb', date: '2026-06-08', impressions: 100, clicks: 0, spendMicros: 0 },
    ]
    for (const row of rows) {
      db.insert(adsInsightsDaily).values({ id: crypto.randomUUID(), projectId, syncRunId: null, ...row }).run()
    }
  }

  return { app, db, tmpDir, configConnections, syncRequests, seedProject, seedConnection, seedSnapshots, seedInsights }
}

describe('ads routes', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(async () => {
    ctx = buildApp()
    await ctx.app.ready()
  })

  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('POST /ads/connect verifies the key, stores the credential in config, and writes the row + audit', async () => {
    const projectId = ctx.seedProject()
    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-good' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.connected).toBe(true)
    expect(body.adAccountId).toBe('adacct_aaa')
    expect(body.currencyCode).toBe('USD')

    // credential landed in the config store, NOT the DB
    expect(ctx.configConnections.length).toBe(1)
    expect(ctx.configConnections[0]!.apiKey).toBe('sk-good')
    const row = ctx.db.select().from(adsConnections).where(eq(adsConnections.projectId, projectId)).get()
    expect(row?.displayName).toBe('Acme Exteriors, Inc')

    const audit = ctx.db.select().from(auditLog).all()
    expect(audit.some((entry) => entry.action === 'ads.connected')).toBe(true)
  })

  it('POST /ads/connect rejects an upstream-invalid key with a 400', async () => {
    ctx.seedProject()
    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'bad-key' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('rejected the key')
    expect(ctx.configConnections.length).toBe(0)
  })

  it('POST /ads/connect is idempotent: reconnecting updates instead of duplicating', async () => {
    const projectId = ctx.seedProject()
    await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-1' } })
    await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-2' } })

    expect(ctx.configConnections.length).toBe(1)
    expect(ctx.configConnections[0]!.apiKey).toBe('sk-2')
    const rows = ctx.db.select().from(adsConnections).where(eq(adsConnections.projectId, projectId)).all()
    expect(rows.length).toBe(1)
  })

  it('GET /ads/status reports not-connected and connected states', async () => {
    const projectId = ctx.seedProject()
    let res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/status' })
    expect(JSON.parse(res.body).connected).toBe(false)

    ctx.seedConnection(projectId)
    res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/status' })
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.connected).toBe(true)
    expect(body.lastSyncedAt).toBe(NOW)
  })

  it('POST /ads/sync requires a connection, creates the run row, and fires the host callback', async () => {
    const projectId = ctx.seedProject()
    let res = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/sync' })
    expect(res.statusCode).toBe(400)

    ctx.seedConnection(projectId)
    res = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/sync' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { runId: string; status: string }
    expect(body.status).toBe('queued')

    const run = ctx.db.select().from(runs).where(eq(runs.id, body.runId)).get()
    expect(run?.kind).toBe('ads-sync')
    expect(run?.trigger).toBe('manual')
    expect(ctx.syncRequests).toEqual([{ runId: body.runId, projectId }])
  })

  it('GET /ads/campaigns nests ad groups and ads, mapping creative target_url → targetUrl', async () => {
    const projectId = ctx.seedProject()
    ctx.seedSnapshots(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/campaigns' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { campaigns: Array<Record<string, unknown>> }
    expect(body.campaigns.length).toBe(1)
    const campaign = body.campaigns[0]!
    expect(campaign.dailySpendLimitMicros).toBe(150_000_000)
    expect(campaign.adGroups.length).toBe(1)
    expect(campaign.adGroups[0].contextHints).toEqual(['how much does a new deck cost', 'measure my yard'])
    expect(campaign.adGroups[0].ads[0].creative.targetUrl).toBe('https://lp.example/x')
  })

  it('GET /ads/insights derives ctr and cpcMicros exactly, with nulls for zero denominators', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedInsights(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/insights?level=campaign' })
    const body = JSON.parse(res.body) as { rows: Array<Record<string, unknown>> }
    expect(body.rows.length).toBe(3)
    // ordered by date ascending
    expect(body.rows.map((r) => r.date)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10'])

    const june10 = body.rows.find((r) => r.date === '2026-06-10')!
    // $39.28 / 23 clicks = 1_707_826 micros; 23/1736 ctr
    expect(june10.cpcMicros).toBe(1_707_826)
    expect(june10.ctr).toBeCloseTo(23 / 1736, 8)

    const june08 = body.rows.find((r) => r.date === '2026-06-08')!
    expect(june08.ctr).toBe(0)
    expect(june08.cpcMicros).toBeNull()

    // currency travels with the rollup so the CLI can render the right symbol
    expect((JSON.parse(res.body) as { currencyCode?: string }).currencyCode).toBe('USD')
  })

  it('GET /ads/insights rejects invalid and unsupported levels and filters by entity', async () => {
    const projectId = ctx.seedProject()
    ctx.seedInsights(projectId)

    const bad = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/insights?level=nonsense' })
    expect(bad.statusCode).toBe(400)

    // account/ad levels are not produced by the sync — rejected, not silently empty
    for (const level of ['account', 'ad']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/projects/acme/ads/insights?level=${level}` })
      expect(res.statusCode).toBe(400)
    }

    const filtered = await ctx.app.inject({
      method: 'GET', url: '/projects/acme/ads/insights?level=ad_group&entityId=adgrp_ddd',
    })
    const body = JSON.parse(filtered.body) as { rows: Array<Record<string, unknown>> }
    expect(body.rows.length).toBe(1)
    expect(body.rows[0]!.spendMicros).toBe(570_000)
  })

  it('GET /ads/summary sums CAMPAIGN-level rollups only (no double counting) with window bounds', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedSnapshots(projectId)
    ctx.seedInsights(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/summary' })
    const body = JSON.parse(res.body) as {
      connected: boolean
      campaignCount: number
      adGroupCount: number
      adCount: number
      totals: { impressions: number; clicks: number; spendMicros: number; ctr: number | null; cpcMicros: number | null }
      window: { from: string | null; to: string | null }
    }
    expect(body.connected).toBe(true)
    expect(body.campaignCount).toBe(1)
    expect(body.adGroupCount).toBe(1)
    expect(body.adCount).toBe(1)
    // campaign rows only: 3326+1736+100 impressions, 40+23+0 clicks — the
    // ad_group row (64 impressions) is a subdivision and must be excluded
    expect(body.totals.impressions).toBe(5162)
    expect(body.totals.clicks).toBe(63)
    expect(body.totals.spendMicros).toBe(129_730_000)
    expect(body.totals.ctr).toBeCloseTo(63 / 5162, 8)
    expect(body.totals.cpcMicros).toBe(Math.round(129_730_000 / 63))
    expect(body.window).toEqual({ from: '2026-06-08', to: '2026-06-10' })
  })

  it('DELETE /ads/connection removes the row + credential and is idempotent', async () => {
    const projectId = ctx.seedProject()
    await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-good' } })

    let res = await ctx.app.inject({ method: 'DELETE', url: '/projects/acme/ads/connection' })
    expect(JSON.parse(res.body).disconnected).toBe(true)
    expect(ctx.configConnections.length).toBe(0)
    expect(ctx.db.select().from(adsConnections).where(eq(adsConnections.projectId, projectId)).all().length).toBe(0)

    res = await ctx.app.inject({ method: 'DELETE', url: '/projects/acme/ads/connection' })
    expect(JSON.parse(res.body).disconnected).toBe(false)
  })

  it('404s for an unknown project', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/projects/nope/ads/status' })
    expect(res.statusCode).toBe(404)
  })
})
