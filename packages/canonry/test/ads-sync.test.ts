import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  runs,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
} from '@ainyc/canonry-db'
import { executeAdsSync } from '../src/ads-sync.js'
import type { CanonryConfig } from '../src/config.js'

const NOW = '2026-06-10T00:00:00.000Z'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ads-sync-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seed(db: ReturnType<typeof createTempDb>) {
  db.insert(projects).values({
    id: 'proj_1', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme-exteriors.example',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(adsConnections).values({
    id: 'conn_1', projectId: 'proj_1', adAccountId: 'adacct_aaa', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'run_1', projectId: 'proj_1', kind: 'ads-sync', status: 'queued', trigger: 'manual', createdAt: NOW,
  }).run()
}

function testConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:3000',
    database: ':memory:',
    apiKey: 'cnry_test',
    openaiAds: {
      connections: [
        { projectName: 'acme', apiKey: 'sk-ads-test', adAccountId: 'adacct_aaa', createdAt: NOW, updatedAt: NOW },
      ],
    },
  }
}

// Response shapes mirror real captured Advertiser API responses (sanitized).
const ACCOUNT = {
  id: 'adacct_aaa', status: 'active', name: 'Acme Exteriors, Inc',
  currency_code: 'USD', timezone: 'America/Denver', url: 'https://acme-exteriors.example/',
}
const CAMPAIGN = {
  id: 'cmpn_bbb', created_at: 1780770653, status: 'active', bidding_type: 'clicks',
  budget: { daily_spend_limit_micros: 150_000_000 }, conversion_event_setting_ids: [],
  description: null, end_time: null, landing_page_configuration: null, mode: null,
  name: 'Homeowners Free Estimate', start_time: 1780770127,
  targeting: { locations: { include: [] } }, updated_at: 1780868842,
}
const AD_GROUP = {
  id: 'adgrp_ddd', created_at: 1780770657, status: 'active',
  bidding_config: { billing_event_type: 'click', max_bid_micros: 2_000_000 },
  context_hints: ['how much does a new deck cost\nmeasure my yard'],
  description: null, name: 'Deck Project Planning', product_set: null, updated_at: 1780864410,
}
const AD = {
  id: 'ad_eee', created_at: 1780770662, status: 'active',
  creative: { type: 'chat_card', title: 'Free Estimate', body: 'b', file_id: 'file_1', target_url: 'https://lp.example/' },
  name: 'HO Deck - Materials', review: { status: 'approved' }, review_status: 'approved', updated_at: 1781139491,
}
const CAMPAIGN_INSIGHTS = [
  { id: 'r1', start_time: 1, end_time: 2, readable_time: '2026-06-09', impressions: 3326, clicks: 40, spend: 90.45 },
  { id: 'r2', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 1736, clicks: 23, spend: 39.28 },
]
const AD_GROUP_INSIGHTS = [
  { id: 'r3', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 64, clicks: 1, spend: 0.57 },
]

function list(data: unknown[]) {
  return { object: 'list', data, first_id: null, last_id: null, has_more: false }
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request) => {
    const u = String(url)
    const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
    if (u.endsWith('/ad_account')) return respond(ACCOUNT)
    if (u.includes('/campaigns/cmpn_bbb/insights')) return respond(list(CAMPAIGN_INSIGHTS))
    if (u.includes('/ad_groups/adgrp_ddd/insights')) return respond(list(AD_GROUP_INSIGHTS))
    if (u.includes('/campaigns')) return respond(list([CAMPAIGN]))
    if (u.includes('/ad_groups?campaign_id=cmpn_bbb')) return respond(list([AD_GROUP]))
    if (u.includes('/ads?ad_group_id=adgrp_ddd')) return respond(list([AD]))
    throw new Error(`unexpected URL in test: ${u}`)
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('executeAdsSync', () => {
  it('snapshots entities, normalizes insights spend to micros, and completes the run', async () => {
    const db = createTempDb()
    seed(db)

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })

    const run = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
    expect(run?.status).toBe('completed')

    const campaign = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()
    expect(campaign?.name).toBe('Homeowners Free Estimate')
    expect(campaign?.dailySpendLimitMicros).toBe(150_000_000)

    const group = db.select().from(adsAdGroups).where(eq(adsAdGroups.id, 'adgrp_ddd')).get()
    expect(group?.campaignId).toBe('cmpn_bbb')
    expect(group?.contextHints).toEqual(['how much does a new deck cost\nmeasure my yard'])
    expect(group?.maxBidMicros).toBe(2_000_000)

    const ad = db.select().from(adsAds).where(eq(adsAds.id, 'ad_eee')).get()
    expect(ad?.adGroupId).toBe('adgrp_ddd')
    expect(ad?.reviewStatus).toBe('approved')

    const insightRows = db.select().from(adsInsightsDaily).all()
    // 2 campaign-level days + 1 ad-group-level day
    expect(insightRows.length).toBe(3)
    const campaignDay = insightRows.find((r) => r.level === 'campaign' && r.date === '2026-06-10')
    // decimal dollars from the API → integer micros in the rollup
    expect(campaignDay?.spendMicros).toBe(39_280_000)
    expect(campaignDay?.impressions).toBe(1736)
    expect(campaignDay?.clicks).toBe(23)
    const groupDay = insightRows.find((r) => r.level === 'ad_group')
    expect(groupDay?.entityId).toBe('adgrp_ddd')
    expect(groupDay?.spendMicros).toBe(570_000)

    const conn = db.select().from(adsConnections).where(eq(adsConnections.projectId, 'proj_1')).get()
    expect(conn?.displayName).toBe('Acme Exteriors, Inc')
    expect(conn?.currencyCode).toBe('USD')
    expect(conn?.status).toBe('active')
    expect(conn?.lastSyncedAt).toBeTruthy()
  })

  it('is idempotent: a re-sync replaces snapshots and upserts insights without duplicating', async () => {
    const db = createTempDb()
    seed(db)

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })
    db.insert(runs).values({
      id: 'run_2', projectId: 'proj_1', kind: 'ads-sync', status: 'queued', trigger: 'manual', createdAt: NOW,
    }).run()
    await executeAdsSync(db, 'run_2', 'proj_1', { config: testConfig() })

    expect(db.select().from(adsCampaigns).all().length).toBe(1)
    expect(db.select().from(adsAdGroups).all().length).toBe(1)
    expect(db.select().from(adsAds).all().length).toBe(1)
    expect(db.select().from(adsInsightsDaily).all().length).toBe(3)
  })

  it('fails the run when no config credential exists for the project', async () => {
    const db = createTempDb()
    seed(db)
    const config = testConfig()
    config.openaiAds = undefined

    await expect(executeAdsSync(db, 'run_1', 'proj_1', { config })).rejects.toThrow(/connect/i)
    const run = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
    expect(run?.status).toBe('failed')
  })

  it('fails the run when no connection row exists', async () => {
    const db = createTempDb()
    seed(db)
    db.delete(adsConnections).where(eq(adsConnections.projectId, 'proj_1')).run()

    await expect(executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })).rejects.toThrow(/connect/i)
    const run = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
    expect(run?.status).toBe('failed')
  })
})
