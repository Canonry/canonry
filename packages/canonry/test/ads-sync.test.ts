import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest'
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
import {
  executeAdsSync,
  liveAdsInsightHourRange,
  readInsightDays,
  trailingAdsInsightHourRange,
} from '../src/ads-sync.js'
import type { CanonryConfig } from '../src/config.js'

const NOW = '2026-06-10T00:00:00.000Z'

/** The account's wall-clock hour, the unit both range edges are expressed in. */
function accountHourFor(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}`
}

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
  review: { status: 'in_review' },
  account_integrity_review: {
    review: { status: 'approved' },
    details: { decision: 'allowed', reason: 'Low risk', status_updated_at: '2026-06-03T18:57:34.397908+00:00' },
  },
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
  it('closes the trailing range on the START of the account current local day', () => {
    // 17:37 UTC is 13:37 in New York. The edge is the start of that local day,
    // which is the highest edge the provider accepts: an `until` in the future
    // is refused outright with "400: time_ranges.end cannot be in the future",
    // failing the whole call rather than clamping. Nothing is lost by staying
    // in the past, since a ranged call never returns the open day at any edge.
    expect(trailingAdsInsightHourRange(
      new Date('2026-07-21T17:37:00.000Z'),
      'America/New_York',
    )).toEqual({
      type: 'hour_range',
      // Unchanged: only the upper edge moves, so the 90-day backfill window is
      // exactly the window it always was.
      since: '2026-04-22T13',
      until: '2026-07-21T00',
      timezone: 'America/New_York',
    })
  })

  it('never names an upper edge later than the account current local hour', () => {
    // The regression guard for the 400. Whatever the zone or the time of day,
    // the edge must already have happened on the account's own wall clock.
    for (const [iso, zone] of [
      ['2026-07-21T17:37:00.000Z', 'America/New_York'],
      ['2026-11-01T18:00:00.000Z', 'America/New_York'], // 25-hour fall-back day
      ['2026-03-08T17:00:00.000Z', 'America/New_York'], // 23-hour spring-forward day
      ['2026-09-06T19:00:00.000Z', 'America/Santiago'], // no hour 00 that day
      ['2026-06-10T18:00:00.000Z', 'Asia/Tokyo'],
      ['2026-06-10T18:00:00.000Z', 'Pacific/Kiritimati'], // UTC+14
      ['2026-06-10T02:00:00.000Z', 'Pacific/Midway'], // UTC-11
    ] as const) {
      const at = new Date(iso)
      const nowHour = accountHourFor(at, zone)
      expect(trailingAdsInsightHourRange(at, zone).until <= nowHour).toBe(true)
      expect(liveAdsInsightHourRange({
        startDate: '2026-01-01',
        fetchedAtMs: at.getTime(),
        timezone: zone,
      }).until <= nowHour).toBe(true)
    }
  })

  it('opens the day at the first hour that local day actually has', () => {
    // America/Santiago springs forward AT midnight into 2026-09-06: the clock
    // goes 23:59:59 -> 01:00:00, so that day has no hour 00 and it begins at
    // 01:00. Naming "2026-09-06T00" would ask the provider about a wall-clock
    // hour its own calendar never had.
    const at = new Date('2026-09-06T19:00:00.000Z') // 16:00 local on 09-06
    expect(trailingAdsInsightHourRange(at, 'America/Santiago').until).toBe('2026-09-06T01')
    expect(liveAdsInsightHourRange({
      startDate: '2026-09-05',
      fetchedAtMs: at.getTime(),
      timezone: 'America/Santiago',
    })).toEqual({
      type: 'hour_range',
      since: '2026-09-05T00',
      until: '2026-09-06T01',
      timezone: 'America/Santiago',
    })
  })

  it('lands the edge on the current date across both DST transitions', () => {
    // The edge is a calendar lookup, not arithmetic over a day's length, so a
    // 25-hour fall-back day and a 23-hour spring-forward day are both simply
    // "the date the anchor is in".
    const fallBack = new Date('2026-11-01T18:00:00.000Z') // 13:00 local on 11-01
    expect(trailingAdsInsightHourRange(fallBack, 'America/New_York').until).toBe('2026-11-01T00')
    expect(liveAdsInsightHourRange({
      startDate: '2026-10-30',
      fetchedAtMs: fallBack.getTime(),
      timezone: 'America/New_York',
    }).until).toBe('2026-11-01T00')
    expect(trailingAdsInsightHourRange(
      new Date('2026-03-08T17:00:00.000Z'),
      'America/New_York',
    ).until).toBe('2026-03-08T00')
  })

  it('reads the closed days ranged and the open day unranged, and merges them', async () => {
    // The two calls exist because neither shape can do both jobs: the ranged
    // one is the only source of conversions, the unranged one the only source
    // of the day in progress.
    const seen: Array<Record<string, unknown>> = []
    const read = async (options: Record<string, unknown>) => {
      seen.push(options)
      return options.timeRanges
        ? [{ id: 'closed', start_time: 1, end_time: 2, readable_time: '2026-06-09', impressions: 3326, conversions: 7 }]
        : [
            { id: 'open', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 1736 },
            { id: 'stale', start_time: 1, end_time: 2, readable_time: '2026-06-09', impressions: 3326 },
          ]
    }

    const result = await readInsightDays({
      read: read as never,
      rangedFields: ['campaign.conversions'],
      inProgressFields: ['campaign.impressions'],
      timeRanges: [trailingAdsInsightHourRange(new Date('2026-06-10T18:00:00.000Z'), 'America/Denver')],
      inProgressDate: '2026-06-10',
    })

    expect(result.closedDays.map((row) => row.readable_time)).toEqual(['2026-06-09'])
    expect(result.closedDays[0]?.conversions).toBe(7)
    // ONLY the open day is taken from the unranged response. Its other rows
    // duplicate the ranged ones and carry no conversions, so adopting them
    // would overwrite real counts with nothing.
    expect(result.inProgressDay?.readable_time).toBe('2026-06-10')
    expect(result.inProgressDay?.conversions).toBeUndefined()

    // The ranged call asks for conversions; the unranged one must not, and is
    // capped at one page because it has no way to bound its own window.
    expect(seen[0]).toEqual({ fields: ['campaign.conversions'], timeRanges: [expect.objectContaining({ until: '2026-06-10T00' })] })
    expect(seen[1]).toEqual({ fields: ['campaign.impressions'], firstPageOnly: true })
  })

  it('reports no open day rather than an empty one when the provider has nothing yet', async () => {
    // Ordinary early in a local day, and permanent for an entity that is not
    // delivering. A zero-filled row would claim the provider reported zero.
    const result = await readInsightDays({
      read: (async (options: Record<string, unknown>) => (options.timeRanges
        ? [{ id: 'closed', start_time: 1, end_time: 2, readable_time: '2026-06-09', impressions: 3326, conversions: 0 }]
        : [{ id: 'older', start_time: 1, end_time: 2, readable_time: '2026-06-09', impressions: 3326 }])) as never,
      rangedFields: ['campaign.conversions'],
      inProgressFields: ['campaign.impressions'],
      timeRanges: [],
      inProgressDate: '2026-06-10',
    })

    expect(result.inProgressDay).toBeNull()
    expect(result.closedDays).toHaveLength(1)
  })

  it('builds a live insight range from the request only, never from the clock', () => {
    const request = {
      startDate: '2026-07-14',
      fetchedAtMs: Date.parse('2026-07-21T17:37:00.000Z'),
      timezone: 'America/New_York',
    }
    const expected = {
      type: 'hour_range',
      // The start of the window's first local day: that day is a WHOLE day
      // upstream, so it is comparable with the whole-day stored rollup.
      since: '2026-07-14T00',
      // And the start of the local day the anchor is in, so the range covers
      // the window's CLOSED days. It may not reach past that: an edge in the
      // future is a 400 on the whole call, and no accepted edge returns the
      // open day anyway, so the open day is read unranged instead.
      until: '2026-07-21T00',
      timezone: 'America/New_York',
    }

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-21T17:37:00.000Z'))
      expect(liveAdsInsightHourRange(request)).toEqual(expected)
      // A walk that crosses an account-local hour still measures the same
      // range: the anchor is the frozen instant the route issued the read at,
      // and the reported `fetchedAt` therefore describes every call in it.
      vi.setSystemTime(new Date('2026-07-21T18:41:00.000Z'))
      expect(liveAdsInsightHourRange(request)).toEqual(expected)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the live range at the first local hour the account timezone actually has', () => {
    // America/Santiago springs forward AT midnight on 2026-09-06: the clock
    // goes 23:59:59 -> 01:00:00, so local hour 00 does not exist that day and
    // "2026-09-06T00" would name a wall-clock hour the account never had.
    expect(liveAdsInsightHourRange({
      startDate: '2026-09-06',
      fetchedAtMs: Date.parse('2026-09-08T12:00:00.000Z'),
      timezone: 'America/Santiago',
    }).since).toBe('2026-09-06T01')

    // Same day, an ordinary account: nothing moves. The fix must not shift the
    // window for the accounts that were always fine.
    expect(liveAdsInsightHourRange({
      startDate: '2026-09-06',
      fetchedAtMs: Date.parse('2026-09-08T12:00:00.000Z'),
      timezone: 'America/New_York',
    }).since).toBe('2026-09-06T00')

    // And a normal account on ITS OWN spring-forward day, where the gap is at
    // 02:00 local: midnight is intact, so the window still starts at hour 00.
    expect(liveAdsInsightHourRange({
      startDate: '2026-03-08',
      fetchedAtMs: Date.parse('2026-03-10T12:00:00.000Z'),
      timezone: 'America/New_York',
    }).since).toBe('2026-03-08T00')
  })

  it('snapshots entities, normalizes insights spend to micros, and completes the run', async () => {
    const db = createTempDb()
    seed(db)

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })

    const run = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
    expect(run?.status).toBe('completed')

    const campaign = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()
    expect(campaign?.name).toBe('Homeowners Free Estimate')
    expect(campaign?.dailySpendLimitMicros).toBe(150_000_000)
    expect(campaign?.conversionEventSettingIds).toEqual([])

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
    // No conversions field on the insight rows → defaults to 0 (the API omits
    // it when the account has no conversion tracking).
    expect(campaignDay?.conversions).toBe(0)
    const groupDay = insightRows.find((r) => r.level === 'ad_group')
    expect(groupDay?.entityId).toBe('adgrp_ddd')
    expect(groupDay?.spendMicros).toBe(570_000)

    const conn = db.select().from(adsConnections).where(eq(adsConnections.projectId, 'proj_1')).get()
    expect(conn?.displayName).toBe('Acme Exteriors, Inc')
    expect(conn?.currencyCode).toBe('USD')
    expect(conn?.status).toBe('active')
    expect(conn?.reviewStatus).toBe('in_review')
    expect(conn?.integrityReviewStatus).toBe('approved')
    expect(conn?.integrityDecision).toBe('allowed')
    expect(conn?.lastSyncedAt).toBeTruthy()
    // CAMPAIGN carries an empty conversion_event_setting_ids → tracking off.
    expect(conn?.conversionTrackingConfigured).toBe(false)
  })

  it('captures conversion counts and flags the connection when conversion tracking is configured', async () => {
    const db = createTempDb()
    seed(db)

    // A conversion-tracking account: the campaign carries a configured event id
    // and the insight rows return a conversions metric (fractional attribution
    // figures round to the integer column).
    const trackedCampaign = { ...CAMPAIGN, conversion_event_setting_ids: ['cevent_1111'] }
    const trackedCampaignInsights = [
      { id: 'r1', start_time: 1, end_time: 2, readable_time: '2026-06-09', impressions: 3326, clicks: 40, spend: 90.45, conversions: 5 },
      { id: 'r2', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 1736, clicks: 23, spend: 39.28, conversions: 2.6 },
    ]
    const trackedGroupInsights = [
      { id: 'r3', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 64, clicks: 1, spend: 0.57, conversions: 1 },
    ]
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
      if (u.endsWith('/ad_account')) return respond(ACCOUNT)
      if (u.includes('/campaigns/cmpn_bbb/insights')) return respond(list(trackedCampaignInsights))
      if (u.includes('/ad_groups/adgrp_ddd/insights')) return respond(list(trackedGroupInsights))
      if (u.includes('/campaigns')) return respond(list([trackedCampaign]))
      if (u.includes('/ad_groups?campaign_id=cmpn_bbb')) return respond(list([AD_GROUP]))
      if (u.includes('/ads?ad_group_id=adgrp_ddd')) return respond(list([AD]))
      throw new Error(`unexpected URL in test: ${u}`)
    }

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })

    const insightRows = db.select().from(adsInsightsDaily).all()
    const campaignJun9 = insightRows.find((r) => r.level === 'campaign' && r.date === '2026-06-09')
    expect(campaignJun9?.conversions).toBe(5)
    const campaignJun10 = insightRows.find((r) => r.level === 'campaign' && r.date === '2026-06-10')
    // 2.6 attribution figure → rounds to 3 in the integer column.
    expect(campaignJun10?.conversions).toBe(3)
    const groupDay = insightRows.find((r) => r.level === 'ad_group')
    expect(groupDay?.conversions).toBe(1)

    const conn = db.select().from(adsConnections).where(eq(adsConnections.projectId, 'proj_1')).get()
    expect(conn?.conversionTrackingConfigured).toBe(true)
    const campaign = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()
    expect(campaign?.conversionEventSettingIds).toEqual(['cevent_1111'])
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

  it('overwrites the in-progress day on the next sync rather than duplicating or sticking', async () => {
    const db = createTempDb()
    seed(db)

    // 18:00 UTC is 12:00 in Denver, so the account's local 2026-06-10 is a
    // half over. The provider serves that day only from the UNRANGED call, so
    // the SAME date comes back with bigger numbers on every read and the
    // rollup row has to track them: it is keyed (project, level, entity,
    // date), so a second sync must UPSERT rather than insert a second row or
    // leave the first read's partial figure in place forever.
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    vi.setSystemTime(new Date('2026-06-10T18:00:00.000Z'))

    // The closed day carries a real conversion count; the open day never does.
    const closedDay = { ...CAMPAIGN_INSIGHTS[0], conversions: 9 }
    let partialDay = {
      id: 'r2', start_time: 2, end_time: 3, readable_time: '2026-06-10',
      impressions: 1736, clicks: 23, spend: 39.28,
    }
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
      const ranged = u.includes('time_ranges')
      if (u.endsWith('/ad_account')) return respond(ACCOUNT)
      // The provider's real split: the ranged call stops before the open day,
      // the unranged call leads with it and repeats the closed days behind it.
      if (u.includes('/campaigns/cmpn_bbb/insights')) {
        return respond(list(ranged ? [closedDay] : [partialDay, CAMPAIGN_INSIGHTS[0]]))
      }
      if (u.includes('/ad_groups/adgrp_ddd/insights')) return respond(list(ranged ? [] : AD_GROUP_INSIGHTS))
      if (u.includes('/campaigns')) return respond(list([CAMPAIGN]))
      if (u.includes('/ad_groups?campaign_id=cmpn_bbb')) return respond(list([AD_GROUP]))
      if (u.includes('/ads?ad_group_id=adgrp_ddd')) return respond(list([AD]))
      throw new Error(`unexpected URL in test: ${u}`)
    }

    const inProgressRows = () => db.select().from(adsInsightsDaily).all()
      .filter((row) => row.level === 'campaign' && row.date === '2026-06-10')

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })
    expect(inProgressRows()).toHaveLength(1)
    expect(inProgressRows()[0]?.impressions).toBe(1736)
    const firstRowId = inProgressRows()[0]?.id

    // Later the same local day: more delivery has landed on that same date.
    partialDay = { ...partialDay, impressions: 2061, clicks: 31, spend: 55.1 }
    db.insert(runs).values({
      id: 'run_2', projectId: 'proj_1', kind: 'ads-sync', status: 'queued', trigger: 'manual', createdAt: NOW,
    }).run()
    await executeAdsSync(db, 'run_2', 'proj_1', { config: testConfig() })

    const after = inProgressRows()
    // Not duplicated: still exactly one row for the day, and the same row.
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(firstRowId)
    // Not stuck: every metric moved to the newer partial reading, and the row
    // now points at the sync that last wrote it.
    expect(after[0]?.impressions).toBe(2061)
    expect(after[0]?.clicks).toBe(31)
    expect(after[0]?.spendMicros).toBe(55_100_000)
    expect(after[0]?.syncRunId).toBe('run_2')

    // The completed day beside it is untouched by the overwrite, conversions
    // included: the unranged read repeats that date without a conversion
    // count, and adopting it would have zeroed a real figure.
    const completedDay = db.select().from(adsInsightsDaily).all()
      .find((row) => row.level === 'campaign' && row.date === '2026-06-09')
    expect(completedDay?.impressions).toBe(3326)
    expect(completedDay?.conversions).toBe(9)
  })

  it('leaves a stored conversion count alone on a day the provider will not report', async () => {
    const db = createTempDb()
    seed(db)

    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    vi.setSystemTime(new Date('2026-06-10T18:00:00.000Z'))

    // A real count already stored for the open date, as if the row had been
    // written by an earlier sync that could read it.
    db.insert(adsInsightsDaily).values({
      id: 'pre_existing', projectId: 'proj_1', syncRunId: null,
      level: 'campaign', entityId: 'cmpn_bbb', date: '2026-06-10',
      impressions: 100, clicks: 2, spendMicros: 1_000_000, conversions: 5,
    }).run()

    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
      const ranged = u.includes('time_ranges')
      if (u.endsWith('/ad_account')) return respond(ACCOUNT)
      if (u.includes('/campaigns/cmpn_bbb/insights')) {
        return respond(list(ranged ? [] : [{
          id: 'r2', start_time: 2, end_time: 3, readable_time: '2026-06-10',
          impressions: 1736, clicks: 23, spend: 39.28,
        }]))
      }
      if (u.includes('/ad_groups/adgrp_ddd/insights')) return respond(list([]))
      if (u.includes('/campaigns')) return respond(list([CAMPAIGN]))
      if (u.includes('/ad_groups?campaign_id=cmpn_bbb')) return respond(list([AD_GROUP]))
      if (u.includes('/ads?ad_group_id=adgrp_ddd')) return respond(list([AD]))
      throw new Error(`unexpected URL in test: ${u}`)
    }

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })

    const row = db.select().from(adsInsightsDaily).all()
      .find((r) => r.level === 'campaign' && r.date === '2026-06-10')
    // The metrics the unranged call DID report moved.
    expect(row?.impressions).toBe(1736)
    expect(row?.clicks).toBe(23)
    // The one it could not report is left as it was. Writing 0 here would turn
    // a number this read could not obtain into a number that is simply wrong.
    expect(row?.conversions).toBe(5)
  })

  it('KEEPS a still-listed campaign whose sub-fetch fails, rather than dropping it', async () => {
    const db = createTempDb()
    seed(db)

    // First sync succeeds and snapshots the campaign.
    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })
    const first = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()
    expect(first?.name).toBe('Homeowners Free Estimate')
    const firstSyncedAt = first?.syncedAt

    // Second sync: the provider still LISTS the campaign, but its insight
    // fetch 503s. Observed live 2026-09-08: OpenAI returned a run of 503s and
    // the whole workspace read as having zero campaigns.
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
      if (u.endsWith('/ad_account')) return respond(ACCOUNT)
      if (u.includes('/campaigns/cmpn_bbb/insights')) {
        return new Response('upstream connect error', { status: 503 })
      }
      if (u.includes('/campaigns')) return respond(list([CAMPAIGN]))
      if (u.includes('/ad_groups?campaign_id=cmpn_bbb')) return respond(list([AD_GROUP]))
      if (u.includes('/ad_groups/adgrp_ddd/insights')) return respond(list(AD_GROUP_INSIGHTS))
      if (u.includes('/ads?ad_group_id=adgrp_ddd')) return respond(list([AD]))
      throw new Error(`unexpected URL in test: ${u}`)
    }
    db.insert(runs).values({
      id: 'run_2', projectId: 'proj_1', kind: 'ads-sync', status: 'queued', trigger: 'manual', createdAt: NOW,
    }).run()
    await executeAdsSync(db, 'run_2', 'proj_1', { config: testConfig() })

    // The row survives, still carrying its previous syncedAt as the staleness
    // signal, and its children survive with it.
    const kept = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()
    expect(kept).toBeTruthy()
    expect(kept?.name).toBe('Homeowners Free Estimate')
    expect(kept?.syncedAt).toBe(firstSyncedAt)
    expect(db.select().from(adsAdGroups).where(eq(adsAdGroups.id, 'adgrp_ddd')).get()).toBeTruthy()
    expect(db.select().from(adsAds).where(eq(adsAds.id, 'ad_eee')).get()).toBeTruthy()
  })

  it('DELETES a campaign the provider no longer lists', async () => {
    const db = createTempDb()
    seed(db)
    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })
    expect(db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()).toBeTruthy()

    // The campaign is gone upstream: listCampaigns returns an empty set.
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
      if (u.endsWith('/ad_account')) return respond(ACCOUNT)
      if (u.includes('/campaigns')) return respond(list([]))
      throw new Error(`unexpected URL in test: ${u}`)
    }
    db.insert(runs).values({
      id: 'run_2', projectId: 'proj_1', kind: 'ads-sync', status: 'queued', trigger: 'manual', createdAt: NOW,
    }).run()
    await executeAdsSync(db, 'run_2', 'proj_1', { config: testConfig() })

    expect(db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()).toBeUndefined()
    expect(db.select().from(adsAdGroups).where(eq(adsAdGroups.id, 'adgrp_ddd')).get()).toBeUndefined()
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
