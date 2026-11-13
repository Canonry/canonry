import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import {
  createClient,
  migrate,
  projects,
  gaAcquisitionDaily,
  gaDailyTotals,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gaSocialReferrals,
} from '@canonry/canonry-db'
import type { GA4SocialPlatformPerformanceDto } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'
import { buildSocialPlatformPerformance, socialPlatformGroupFor } from '../src/ga-social-platform-performance.js'
import type { SocialPlatformPerformanceInput, SourceKeyRow } from '../src/ga-social-platform-performance.js'

const stamp = '2026-10-01T12:00:00.000Z'

function sessions(source: string, medium: string, channelGroup: string, value: number): SourceKeyRow {
  return { source, medium, channelGroup, value }
}

function build(overrides: Partial<SocialPlatformPerformanceInput> = {}): GA4SocialPlatformPerformanceDto {
  return buildSocialPlatformPerformance({
    sessionRows: [],
    conversionRows: [],
    dailyRows: [],
    hasAcquisitionRows: true,
    siteSessions: 10_000,
    siteConversions: 0,
    totalSessions: 10_000,
    countedEventNames: ['purchase'],
    conversionRateUnavailableReason: null,
    ...overrides,
  })
}

describe('socialPlatformGroupFor', () => {
  it('keeps a platform source in any channel group and an unmatched source only in GA4 social', () => {
    // Meta ads tagged fb_ads land in Paid Other; creator links in Unassigned.
    expect(socialPlatformGroupFor('FB_Ads', 'Paid Other')).toEqual({ key: 'facebook', platform: 'facebook' })
    expect(socialPlatformGroupFor('shopmy', 'Unassigned')).toEqual({ key: 'shopmy', platform: 'shopmy' })
    expect(socialPlatformGroupFor('rstyle.me', 'Referral')).toEqual({ key: 'ltk', platform: 'ltk' })
    expect(socialPlatformGroupFor('newsletter', 'Organic Social')).toEqual({ key: 'source:newsletter', platform: null })
    expect(socialPlatformGroupFor('newsletter', 'Referral')).toBeNull()
    expect(socialPlatformGroupFor('google', 'Organic Search')).toBeNull()
    // Outside GA4 Social a one-letter word does not name a platform; a hostname does.
    expect(socialPlatformGroupFor('promo-x', 'Email')).toBeNull()
    expect(socialPlatformGroupFor('t.co', 'Referral')).toEqual({ key: 'x', platform: 'x' })
    expect(socialPlatformGroupFor('fb', 'Paid Other')).toEqual({ key: 'facebook', platform: 'facebook' })
    // Inside it, the existing GA4 social grouping is unchanged.
    expect(socialPlatformGroupFor('promo-x', 'Organic Social')).toEqual({ key: 'x', platform: 'x' })
  })
})

describe('buildSocialPlatformPerformance', () => {
  it('counts every platform row once and partitions sessions, classes and shares', () => {
    const block = build({
      sessionRows: [
        sessions('FB_Ads', 'paidsocial', 'Paid Other', 1500),
        sessions('facebook.com', 'referral', 'Organic Social', 120),
        sessions('ig', 'social', 'Organic Social', 1200),
        sessions('shopmy', '(not set)', 'Unassigned', 400),
        sessions('newsletter', '(not set)', 'Organic Social', 5),
        sessions('google', 'organic', 'Organic Search', 5000),
        sessions('(direct)', '(none)', 'Direct', 3000),
      ],
      conversionRows: [
        sessions('FB_Ads', 'paidsocial', 'Paid Other', 6),
        sessions('ig', 'social', 'Organic Social', 12),
        sessions('shopmy', '(not set)', 'Unassigned', 8),
        sessions('google', 'organic', 'Organic Search', 30),
      ],
    })
    expect(block.status).toBe('ready')
    expect(block.platforms.map(row => row.label)).toEqual(['Facebook', 'Instagram', 'ShopMy', 'newsletter'])
    expect(block.sessions).toBe(1500 + 120 + 1200 + 400 + 5)
    expect(block.platforms.reduce((sum, row) => sum + row.sessions, 0)).toBe(block.sessions)
    expect(block.conversions).toBe(6 + 12 + 8)
    for (const row of block.platforms) {
      expect(row.paidSessions + row.organicSessions).toBe(row.sessions)
      expect(row.sources.reduce((sum, source) => sum + source.sessions, 0)).toBe(row.sessions)
      expect(row.paid.sessions + row.organic.sessions).toBe(row.sessions)
    }
    expect(block.platforms.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10)
    expect(block.platforms.flatMap(row => row.sources).reduce((sum, source) => sum + source.share, 0)).toBeCloseTo(1, 10)

    const facebook = block.platforms.find(row => row.platform === 'facebook')!
    expect(facebook).toMatchObject({ paidSessions: 1500, organicSessions: 120, channelGroups: ['Paid Other', 'Organic Social'] })
    expect(facebook.sources[0]).toMatchObject({ source: 'FB_Ads', channelGroup: 'Paid Other', trafficClass: 'paid', conversions: 6 })
    expect(block.paidSessions).toBe(1500)
    expect(block.sharePct).toBeCloseTo(32.25, 6)
  })

  it('ranks by conversions per 1,000 sessions only from the minimum sessions, with server-rounded values', () => {
    const block = build({
      sessionRows: [
        sessions('FB_Ads', 'paidsocial', 'Paid Other', 1500),
        sessions('ig', 'social', 'Organic Social', 1200),
        sessions('Pinterest', 'PaidSocial', 'Paid Social', 1000),
        sessions('shopmy', '(not set)', 'Unassigned', 999),
      ],
      conversionRows: [
        sessions('FB_Ads', 'paidsocial', 'Paid Other', 6),
        sessions('ig', 'social', 'Organic Social', 12),
        sessions('Pinterest', 'PaidSocial', 'Paid Social', 4),
        sessions('shopmy', '(not set)', 'Unassigned', 40),
      ],
    })
    const byLabel = new Map(block.platforms.map(row => [row.label, row]))
    expect(byLabel.get('Instagram')).toMatchObject({ conversionsPerThousandSessions: 10, conversionsPerThousandSessionsDisplay: '10.0', enoughSessions: true, rank: 1 })
    // A tie on the rate goes to more conversions.
    expect(byLabel.get('Facebook')).toMatchObject({ conversionsPerThousandSessions: 4, rank: 2 })
    expect(byLabel.get('Pinterest')).toMatchObject({ conversionsPerThousandSessions: 4, enoughSessions: true, rank: 3 })
    // 999 sessions: the best rate here, and still not ranked.
    expect(byLabel.get('ShopMy')).toMatchObject({ conversionsPerThousandSessions: 40.04, conversionsPerThousandSessionsDisplay: '40.0', enoughSessions: false, rank: null })
    expect(block.minSessions).toBe(1000)
    expect(byLabel.get('Facebook')!.paid).toMatchObject({ sessions: 1500, conversions: 6, conversionsPerThousandSessions: 4 })
    expect(byLabel.get('Facebook')!.organic).toMatchObject({ sessions: 0, conversions: 0, conversionsPerThousandSessions: null, conversionsPerThousandSessionsDisplay: '—' })
  })

  it('keeps conversions that have no session row, without inventing a rate for them', () => {
    const block = build({
      sessionRows: [sessions('ig', 'social', 'Organic Social', 1200)],
      conversionRows: [sessions('ig', 'social', 'Organic Social', 3), sessions('instagram.com', 'referral', 'Organic Social', 2)],
    })
    const instagram = block.platforms[0]!
    expect(instagram).toMatchObject({ sessions: 1200, conversions: 5 })
    const lateRow = instagram.sources.find(source => source.source === 'instagram.com')!
    expect(lateRow).toMatchObject({ sessions: 0, conversions: 2, conversionsPerThousandSessions: null })
  })

  it('withholds every rate and rank with the reason, and keeps sessions', () => {
    const block = build({
      sessionRows: [sessions('ig', 'social', 'Organic Social', 1200)],
      conversionRows: [sessions('ig', 'social', 'Organic Social', 12)],
      conversionRateUnavailableReason: 'sessions-before-leads',
    })
    expect(block).toMatchObject({ conversionRateAvailable: false, conversionRateUnavailableReason: 'sessions-before-leads', sessions: 1200, conversions: 12 })
    expect(block.platforms[0]).toMatchObject({ conversions: 12, conversionsPerThousandSessions: null, conversionsPerThousandSessionsDisplay: '—', rank: null })
    expect(block.site.conversionsPerThousandSessions).toBeNull()
  })

  it('reports conversions as unmeasured, not zero, when no conversion event is read', () => {
    const block = build({
      sessionRows: [sessions('ig', 'social', 'Organic Social', 1200)],
      conversionRows: null,
      siteConversions: null,
      conversionRateUnavailableReason: 'no-data',
    })
    expect(block.conversions).toBeNull()
    expect(block.platforms[0]).toMatchObject({ conversions: null, rank: null })
    expect(block.site).toMatchObject({ conversions: null, conversionsPerThousandSessions: null })
  })

  it('is unavailable without stored acquisition rows', () => {
    const block = build({ hasAcquisitionRows: false, sessionRows: [] })
    expect(block).toMatchObject({ status: 'unavailable', unavailableReason: 'sessions-not-synced', platforms: [], sessions: 0 })
  })

  it('charts only platform rows, labelled like the table', () => {
    const block = build({
      sessionRows: [sessions('FB_Ads', 'paidsocial', 'Paid Other', 10), sessions('google', 'organic', 'Organic Search', 50)],
      dailyRows: [
        { date: '2026-09-10', source: 'FB_Ads', channelGroup: 'Paid Other', sessions: 4 },
        { date: '2026-09-11', source: 'FB_Ads', channelGroup: 'Paid Other', sessions: 6 },
        { date: '2026-09-11', source: 'google', channelGroup: 'Organic Search', sessions: 50 },
      ],
    })
    expect(block.daily.series.map(series => series.label)).toEqual(['Facebook'])
    expect(block.daily.days.map(day => day.date)).toEqual(['2026-09-10', '2026-09-11'])
  })
})

describe('GET /ga/traffic socialPlatformPerformance', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>

  const url = '/api/v1/projects/shop/ga/traffic?startDate=2026-09-01&endDate=2026-09-30'

  function acquisition(id: string, date: string, source: string, medium: string, channelGroup: string, value: number, hostName = 'shop.example') {
    db.insert(gaAcquisitionDaily).values({ id, projectId: 'p', date, channelGroup, source, medium, hostName, landingPage: '/', landingPageNormalized: '/', sessions: value, syncedAt: stamp, createdAt: stamp }).run()
  }
  function lead(id: string, date: string, source: string, medium: string, channelGroup: string, value: number, eventName = 'generate_lead') {
    db.insert(gaLeadEventsDaily).values({ id, projectId: 'p', date, eventName, channelGroup, source, medium, hostName: 'checkout.shop.example', landingPage: '/', landingPageNormalized: '/', attributionScope: 'landing-page', eventCount: value, syncedAt: stamp, createdAt: stamp }).run()
  }
  function syncState(overrides: Partial<typeof gaMeasurementSyncStates.$inferInsert> = {}) {
    db.insert(gaMeasurementSyncStates).values({ projectId: 'p', acquisitionStatus: 'ready', acquisitionSyncedAt: stamp, leadStatus: 'ready', leadSyncedAt: stamp, leadAttributionScope: 'landing-page', leadEventNames: ['generate_lead'], updatedAt: stamp, ...overrides }).run()
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-social-platforms-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    db.insert(projects).values({ id: 'p', name: 'shop', displayName: 'Shop', canonicalDomain: 'shop.example', country: 'US', language: 'en', createdAt: stamp, updatedAt: stamp }).run()
    const connection: Ga4CredentialRecord = { projectName: 'shop', propertyId: '123', clientEmail: 'ga@example.com', privateKey: 'unused', createdAt: stamp, updatedAt: stamp }
    const ga4CredentialStore: Ga4CredentialStore = {
      getConnection: (name: string) => (name === 'shop' ? connection : undefined),
      upsertConnection: (record: Ga4CredentialRecord) => record,
      deleteConnection: () => true,
    }
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true, ga4CredentialStore })
    await app.ready()

    // GA4's Social channel table holds only what GA4 itself called social.
    db.insert(gaSocialReferrals).values({ id: 's1', projectId: 'p', date: '2026-09-10', source: 'ig', medium: 'social', channelGroup: 'Organic Social', sessions: 1200, users: 900, syncedAt: stamp }).run()
    acquisition('a1', '2026-09-10', 'FB_Ads', 'paidsocial', 'Paid Other', 1500)
    acquisition('a2', '2026-09-10', 'ig', 'social', 'Organic Social', 1200)
    acquisition('a3', '2026-09-10', 'shopmy', '(not set)', 'Unassigned', 400)
    acquisition('a4', '2026-09-10', 'google', 'organic', 'Organic Search', 5000)
    acquisition('a5', '2026-10-05', 'FB_Ads', 'paidsocial', 'Paid Other', 999)
    lead('l1', '2026-09-10', 'FB_Ads', 'paidsocial', 'Paid Other', 6)
    lead('l2', '2026-09-10', 'ig', 'social', 'Organic Social', 12)
    lead('l3', '2026-09-10', 'shopmy', '(not set)', 'Unassigned', 8)
    lead('l4', '2026-09-10', 'google', 'organic', 'Organic Search', 30)
    lead('l5', '2026-10-05', 'FB_Ads', 'paidsocial', 'Paid Other', 50)
    db.insert(gaDailyTotals).values({ id: 'd1', projectId: 'p', date: '2026-09-10', sessions: 10_000, users: 8_000, syncedAt: stamp, createdAt: stamp }).run()
    db.insert(gaDailyTotals).values({ id: 'd2', projectId: 'p', date: '2026-09-11', sessions: 9_000, users: 7_000, syncedAt: stamp, createdAt: stamp }).run()
  })
  afterEach(async () => {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('counts ads and creator links GA4 files outside Social, over the response window', async () => {
    syncState()
    const body = (await app.inject({ method: 'GET', url })).json()
    expect(body).toMatchObject({ windowStart: '2026-09-01', windowEnd: '2026-09-30', socialSessions: 1200 })
    const block = body.socialPlatformPerformance as GA4SocialPlatformPerformanceDto
    expect(block).toMatchObject({ status: 'ready', sessions: 3100, paidSessions: 1500, conversions: 26, conversionRateAvailable: true, countedEventNames: ['generate_lead'] })
    expect(block.platforms.map(row => [row.label, row.sessions, row.conversions, row.rank])).toEqual([
      ['Facebook', 1500, 6, 2],
      ['Instagram', 1200, 12, 1],
      ['ShopMy', 400, 8, null],
    ])
    // Site: every channel's conversions over GA4's session total, on the days
    // the acquisition table covers (Sep 11 has no acquisition row).
    expect(block.site).toMatchObject({ sessions: 10_000, conversions: 56, conversionsPerThousandSessions: 5.6, conversionsPerThousandSessionsDisplay: '5.6' })
  })

  it('withholds rates when the window reaches back before the first stored lead event', async () => {
    syncState()
    acquisition('early', '2026-09-02', 'ig', 'social', 'Organic Social', 300)
    const block = (await app.inject({ method: 'GET', url })).json().socialPlatformPerformance as GA4SocialPlatformPerformanceDto
    expect(block).toMatchObject({ conversionRateAvailable: false, conversionRateUnavailableReason: 'sessions-before-leads' })
    expect(block.platforms.every(row => row.rank === null && row.conversionsPerThousandSessions === null)).toBe(true)
    expect(block.site.conversionsPerThousandSessions).toBeNull()
  })

  it('withholds rates while the latest lead sync has not succeeded', async () => {
    syncState({ leadStatus: 'error' })
    const block = (await app.inject({ method: 'GET', url })).json().socialPlatformPerformance as GA4SocialPlatformPerformanceDto
    expect(block).toMatchObject({ conversionRateAvailable: false, conversionRateUnavailableReason: 'sync-not-ready', conversions: 26 })
  })

  it('reports conversions as unmeasured when no counted event was fetched', async () => {
    syncState({ leadEventNames: ['sign_up'] })
    const block = (await app.inject({ method: 'GET', url })).json().socialPlatformPerformance as GA4SocialPlatformPerformanceDto
    expect(block).toMatchObject({ conversions: null, conversionRateAvailable: false, conversionRateUnavailableReason: 'no-data' })
    expect(block.platforms[0]!.conversions).toBeNull()
  })
})
