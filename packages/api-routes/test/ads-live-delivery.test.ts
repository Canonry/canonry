import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import {
  AppError,
  formatIsoDateInTimeZone,
  startOfDayHourInTimeZone,
  startOfNextDayHourInTimeZone,
} from '@canonry/canonry-contracts'
import type { AdsLiveDeliveryDto } from '@canonry/canonry-contracts'
import {
  createClient,
  migrate,
  projects,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
} from '@canonry/canonry-db'
import { adsRoutes } from '../src/ads.js'
import type {
  AdsLiveDeliveryReader,
  AdsLiveInsightsRequest,
  AdsLiveProviderEntity,
  VerifiedAdsAccount,
} from '../src/ads.js'
import {
  buildFieldDeltas,
  buildMetricDeltas,
  buildLiveEntityComparison,
  liveComparisonWindow,
  summarizeLiveDrift,
} from '../src/ads-live-delivery.js'

const NOW = '2026-06-10T12:00:00.000Z'
const API_KEY = 'sk-ads-live-super-secret-key'
const WINDOW = { startDate: '2026-06-03', endDate: '2026-06-10' }

const VERIFIED: VerifiedAdsAccount = {
  id: 'adacct_aaa',
  name: 'Acme Exteriors, Inc',
  status: 'active',
  currencyCode: 'USD',
  timezone: 'America/Denver',
  reviewStatus: 'in_review',
  integrityReviewStatus: 'approved',
  integrityDecision: 'allowed',
}

function liveEntity(
  id: string,
  status: string,
  extra: Partial<AdsLiveProviderEntity> = {},
): AdsLiveProviderEntity {
  return {
    id,
    name: `${id} name`,
    status,
    reviewStatus: null,
    mode: null,
    updatedAt: 200,
    ...extra,
  }
}

function metricRow(
  date: string,
  values: { impressions?: number; clicks?: number; spend?: number; conversions?: number },
) {
  return {
    date,
    startTime: 1_760_000_000,
    endTime: 1_760_086_400,
    impressions: values.impressions ?? null,
    clicks: values.clicks ?? null,
    spend: values.spend ?? null,
    conversions: values.conversions ?? null,
    ctr: null,
    cpc: null,
    cpm: null,
  }
}

/**
 * The account-local `YYYY-MM-DDTHH` bucket key, the unit the provider's hour
 * ranges are expressed in. Mirrors `accountHour` in the host's ads-sync.
 */
function accountHourKey(atMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(atMs))
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)!.value
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}`
}

/** The account-local date the frozen read anchor falls in. */
function readDateOf(request: AdsLiveInsightsRequest): string {
  return formatIsoDateInTimeZone(new Date(request.fetchedAtMs).toISOString(), request.timezone)
}

/**
 * The hour range the host builds from one insight request. Mirrors
 * `liveAdsInsightHourRange` in the host's ads-sync, down to resolving both
 * edges through the shared timezone helpers rather than assuming every
 * account's day begins at local hour 00.
 *
 * `until` is the START of the anchor's local day, so the range covers the
 * window's CLOSED days and stops. It cannot reach further: the provider
 * refuses an `until` in the future outright. The open day arrives from a
 * separate unranged call instead. See `servedDayBuckets`.
 */
function rangeOf(request: AdsLiveInsightsRequest) {
  return {
    since: startOfDayHourInTimeZone(request.startDate, request.timezone),
    until: startOfDayHourInTimeZone(readDateOf(request), request.timezone),
    timezone: request.timezone,
  }
}

/**
 * What a provider does with an hour range: serve the buckets that fall inside
 * it and nothing else. A fake that returns its fixture regardless of the range
 * cannot see a window-alignment bug at all. `until` is the EXCLUSIVE edge, so
 * a bucket landing exactly on it belongs to the next range.
 */
function servedBuckets(
  buckets: Array<{ hour: string; impressions: number }>,
  request: AdsLiveInsightsRequest,
) {
  const range = rangeOf(request)
  return buckets
    .filter((bucket) => bucket.hour >= range.since && bucket.hour < range.until)
    .map((bucket) => metricRow(bucket.hour.slice(0, 10), { impressions: bucket.impressions }))
}

/**
 * What the provider actually emits, and what the host reader therefore has to
 * do twice to get a whole window.
 *
 * The RANGED call serves DAILY buckets, and only for a day whose own
 * boundaries the range fully covers. A day runs from where it starts on the
 * account's wall clock to where the next day starts, so the day in progress,
 * whose end is still in the future, can never be covered by a range the
 * provider will accept, and comes back from no ranged call at all.
 *
 * The UNRANGED call is what serves that day, so the host makes it alongside
 * and keeps the anchor's local date from it. This fake mirrors both, because
 * the stored side carries the open day: a live side that omitted it would
 * report a stored-only day as drift on every single read.
 */
function servedDayBuckets(
  buckets: Array<{ date: string; impressions: number }>,
  request: AdsLiveInsightsRequest,
) {
  const range = rangeOf(request)
  const readDate = readDateOf(request)
  return buckets
    .filter((bucket) => {
      if (bucket.date === readDate) return true
      const dayStart = startOfDayHourInTimeZone(bucket.date, request.timezone)
      const dayEnd = startOfNextDayHourInTimeZone(bucket.date, request.timezone)
      return dayStart >= range.since && dayEnd <= range.until
    })
    .map((bucket) => metricRow(bucket.date, { impressions: bucket.impressions }))
}

interface Overrides {
  campaigns?: AdsLiveProviderEntity[]
  adGroups?: AdsLiveProviderEntity[]
  ads?: AdsLiveProviderEntity[]
  campaignMetrics?: ReturnType<typeof metricRow>[]
  adGroupMetrics?: ReturnType<typeof metricRow>[]
  /** Hourly campaign buckets, served only when they fall inside the asked-for range. */
  campaignHourBuckets?: Array<{ hour: string; impressions: number }>
  /** Daily campaign buckets, served only when the range covers the whole day. */
  campaignDayBuckets?: Array<{ date: string; impressions: number }>
  /** Advances the fake clock after each insight call, so a walk can outlive an hour. */
  advanceClockPerInsightMs?: number
  readerError?: unknown
  verifyError?: unknown
  verifiedAccountId?: string
  /** Blocks account verification until resolved, so a read stays in flight. */
  holdVerify?: Promise<void>
  /** Fires when a read reaches account verification, before it parks. */
  onVerifyStart?: () => void
  accountTimezone?: string
  minIntervalMs?: number
  omitReader?: boolean
}

function buildApp(overrides: Overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-live-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const logLines: string[] = []
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk))
      callback()
    },
  })

  const readerCalls: Array<{ method: string; apiKey: string; entityId?: string }> = []
  const insightRequests: Array<{
    method: string
    request: AdsLiveInsightsRequest
    wallClockNow: number
  }> = []
  const throwIfConfigured = () => {
    if (overrides.readerError !== undefined) throw overrides.readerError
  }
  const recordInsight = (method: string, request: AdsLiveInsightsRequest) => {
    insightRequests.push({ method, request, wallClockNow: Date.now() })
    if (overrides.advanceClockPerInsightMs !== undefined) {
      vi.setSystemTime(new Date(Date.now() + overrides.advanceClockPerInsightMs))
    }
  }

  const reader: AdsLiveDeliveryReader = {
    listCampaigns: async (apiKey) => {
      readerCalls.push({ method: 'listCampaigns', apiKey })
      throwIfConfigured()
      return overrides.campaigns ?? []
    },
    listAdGroups: async (apiKey, campaignId) => {
      readerCalls.push({ method: 'listAdGroups', apiKey, entityId: campaignId })
      throwIfConfigured()
      return overrides.adGroups ?? []
    },
    listAds: async (apiKey, adGroupId) => {
      readerCalls.push({ method: 'listAds', apiKey, entityId: adGroupId })
      throwIfConfigured()
      return overrides.ads ?? []
    },
    campaignInsights: async (apiKey, campaignId, request) => {
      readerCalls.push({ method: 'campaignInsights', apiKey, entityId: campaignId })
      recordInsight('campaignInsights', request)
      throwIfConfigured()
      if (overrides.campaignHourBuckets) return servedBuckets(overrides.campaignHourBuckets, request)
      if (overrides.campaignDayBuckets) return servedDayBuckets(overrides.campaignDayBuckets, request)
      return overrides.campaignMetrics ?? []
    },
    adGroupInsights: async (apiKey, adGroupId, request) => {
      readerCalls.push({ method: 'adGroupInsights', apiKey, entityId: adGroupId })
      recordInsight('adGroupInsights', request)
      throwIfConfigured()
      return overrides.adGroupMetrics ?? []
    },
  }

  const app = Fastify({ logger: { level: 'trace', stream: logStream } })
  app.decorate('db', db)
  // Mirrors the production global handler: AppError is serialized, everything
  // else is logged in full and answered with a generic message.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    app.log.error(error)
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } })
  })

  void app.register(adsRoutes, {
    adsCredentialStore: {
      getConnection: (projectName) => projectName === 'acme'
        ? { projectName, apiKey: API_KEY, adAccountId: 'adacct_aaa', createdAt: NOW, updatedAt: NOW }
        : undefined,
      upsertConnection: (entry) => entry,
      removeConnection: () => false,
    },
    verifyAdsAccount: async () => {
      overrides.onVerifyStart?.()
      if (overrides.holdVerify) await overrides.holdVerify
      if (overrides.verifyError !== undefined) throw overrides.verifyError
      return {
        ...VERIFIED,
        id: overrides.verifiedAccountId ?? VERIFIED.id,
        timezone: overrides.accountTimezone ?? VERIFIED.timezone,
      }
    },
    adsLiveDeliveryReader: overrides.omitReader ? undefined : reader,
    adsLiveDeliveryMinIntervalMs: overrides.minIntervalMs ?? 0,
    adsLiveDeliveryMaxPagesPerReaderCall: 100,
    adsReconcileSweepIntervalMs: 0,
  })

  function seedProject(name = 'acme'): string {
    const id = crypto.randomUUID()
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: `${name}.example`,
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
    }).run()
    return id
  }

  function seedConnection(projectId: string): void {
    db.insert(adsConnections).values({
      id: crypto.randomUUID(), projectId, adAccountId: 'adacct_aaa',
      displayName: 'Acme Exteriors, Inc', currencyCode: 'USD', timezone: 'America/Denver',
      status: 'active', reviewStatus: 'in_review', integrityReviewStatus: 'approved',
      integrityDecision: 'allowed', conversionTrackingConfigured: true,
      lastSyncedAt: '2026-06-09T00:00:00.000Z', createdAt: NOW, updatedAt: NOW,
    }).run()
  }

  /** The observed incident: Canonry says paused / 111 impressions. */
  function seedStaleSnapshot(projectId: string): void {
    db.insert(adsCampaigns).values({
      id: 'cmpn_1', projectId, name: 'Homeowners Free Estimate', status: 'paused',
      biddingType: 'clicks', dailySpendLimitMicros: 150_000_000, syncedAt: NOW,
      conversionEventSettingIds: [], upstreamUpdatedAt: 100,
    }).run()
    db.insert(adsAdGroups).values({
      id: 'adgrp_1', projectId, campaignId: 'cmpn_1', name: 'Deck Project Planning',
      status: 'paused', billingEventType: 'click', maxBidMicros: 2_000_000,
      contextHints: [], upstreamUpdatedAt: 100, syncedAt: NOW,
    }).run()
    db.insert(adsAds).values({
      id: 'ad_1', projectId, adGroupId: 'adgrp_1', name: 'HO Deck - Materials',
      status: 'paused', reviewStatus: 'approved', upstreamUpdatedAt: 100, syncedAt: NOW,
    }).run()
    const rows = [
      { level: 'campaign', entityId: 'cmpn_1', date: '2026-06-10', impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
      // Older than the 7d window, so never compared: the provider was never
      // asked about it.
      { level: 'campaign', entityId: 'cmpn_1', date: '2026-05-01', impressions: 9_999, clicks: 99, spendMicros: 9_000_000, conversions: 9 },
    ]
    for (const row of rows) {
      db.insert(adsInsightsDaily).values({ id: crypto.randomUUID(), projectId, syncRunId: null, ...row }).run()
    }
  }

  /**
   * One campaign whose stored rollup is dated the way ads-sync dates it: with
   * the provider's own `readable_time`, which is an ACCOUNT-LOCAL calendar day.
   */
  function seedDatedCampaign(projectId: string, date: string, impressions: number): void {
    db.insert(adsCampaigns).values({
      id: 'cmpn_1', projectId, name: 'Homeowners Free Estimate', status: 'active',
      biddingType: 'clicks', dailySpendLimitMicros: 150_000_000, syncedAt: NOW,
      conversionEventSettingIds: [], upstreamUpdatedAt: 200,
    }).run()
    db.insert(adsInsightsDaily).values({
      id: crypto.randomUUID(), projectId, syncRunId: null,
      level: 'campaign', entityId: 'cmpn_1', date,
      impressions, clicks: 0, spendMicros: 0, conversions: 0,
    }).run()
  }

  return {
    app, db, tmpDir, reader, readerCalls, insightRequests, logLines,
    seedProject, seedConnection, seedStaleSnapshot, seedDatedCampaign,
  }
}

describe('ads live delivery comparison (pure)', () => {
  it('reports only the fields that differ, and nothing when one side is absent', () => {
    const live = { name: 'A', status: 'active', reviewStatus: 'approved', mode: 'standard', updatedAt: 5 }
    const stored = { name: 'A', status: 'paused', reviewStatus: 'approved', upstreamUpdatedAt: 4, syncedAt: NOW }

    expect(buildFieldDeltas(live, stored)).toEqual([
      { field: 'status', live: 'active', stored: 'paused' },
    ])
    expect(buildFieldDeltas(live, { ...stored, status: 'active' })).toEqual([])
    expect(buildFieldDeltas(live, null)).toEqual([])
    expect(buildFieldDeltas(null, stored)).toEqual([])
  })

  it('compares metrics per date, converts provider dollars to micros, and ignores pre-window stored dates', () => {
    const deltas = buildMetricDeltas(
      [metricRow('2026-06-10', { impressions: 162, clicks: 5, spend: 1.5, conversions: 0 })],
      [
        { date: '2026-06-10', impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
        { date: '2026-05-01', impressions: 9_999, clicks: 99, spendMicros: 9_000_000, conversions: 9 },
      ],
      WINDOW,
    )

    expect(deltas).toEqual([
      {
        date: '2026-06-10',
        live: { impressions: 162, clicks: 5, spendMicros: 1_500_000, conversions: 0 },
        stored: { impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
        drifted: true,
      },
    ])
  })

  it('sums the provider\'s disjoint buckets within one date and calls an exact match undrifted', () => {
    const deltas = buildMetricDeltas(
      [
        metricRow('2026-06-09', { impressions: 60, clicks: 2, spend: 0.25, conversions: 1 }),
        metricRow('2026-06-09', { impressions: 40, clicks: 1, spend: 0.75, conversions: 0 }),
      ],
      [{ date: '2026-06-09', impressions: 100, clicks: 3, spendMicros: 1_000_000, conversions: 1 }],
      WINDOW,
    )

    expect(deltas).toEqual([
      {
        date: '2026-06-09',
        live: { impressions: 100, clicks: 3, spendMicros: 1_000_000, conversions: 1 },
        stored: { impressions: 100, clicks: 3, spendMicros: 1_000_000, conversions: 1 },
        drifted: false,
      },
    ])
  })

  it('flags a date only one side reports, and claims nothing when neither side was read', () => {
    const liveOnly = buildMetricDeltas(
      [metricRow('2026-06-08', { impressions: 12 })],
      [],
      WINDOW,
    )
    expect(liveOnly).toEqual([
      {
        date: '2026-06-08',
        live: { impressions: 12, clicks: 0, spendMicros: 0, conversions: 0 },
        stored: null,
        drifted: true,
      },
    ])

    const storedOnly = buildMetricDeltas(
      [],
      [{ date: '2026-06-08', impressions: 12, clicks: 0, spendMicros: 0, conversions: 0 }],
      WINDOW,
    )
    expect(storedOnly[0]).toMatchObject({ date: '2026-06-08', live: null, drifted: true })

    expect(buildMetricDeltas(null, null, WINDOW)).toBeNull()
  })

  it('dates the compared window in the account timezone, so an east-of-UTC day is not dropped', () => {
    // 22:00 UTC on the 10th is already 07:00 on the 11th in Tokyo, and both
    // the provider's buckets and the stored rollups are dated in the account's
    // own zone. A UTC-derived window ends a whole day early here.
    const fetchedAtMs = Date.parse('2026-06-10T22:00:00.000Z')
    expect(liveComparisonWindow(fetchedAtMs, 7, 'Asia/Tokyo')).toEqual({
      startDate: '2026-06-04',
      endDate: '2026-06-11',
    })
    expect(liveComparisonWindow(fetchedAtMs, 7, 'UTC')).toEqual({
      startDate: '2026-06-03',
      endDate: '2026-06-10',
    })

    const live = [metricRow('2026-06-11', { impressions: 162 })]
    const stored = [{ date: '2026-06-11', impressions: 162, clicks: 0, spendMicros: 0, conversions: 0 }]

    // Account-dated window: the two sides meet and agree.
    expect(buildMetricDeltas(live, stored, liveComparisonWindow(fetchedAtMs, 7, 'Asia/Tokyo'))).toEqual([{
      date: '2026-06-11',
      live: { impressions: 162, clicks: 0, spendMicros: 0, conversions: 0 },
      stored: { impressions: 162, clicks: 0, spendMicros: 0, conversions: 0 },
      drifted: false,
    }])

    // UTC-derived window: the stored row falls past `endDate` and is filtered
    // out, so identical numbers are reported as the snapshot having nothing.
    // That is the misreport this window derivation exists to avoid.
    expect(buildMetricDeltas(live, stored, liveComparisonWindow(fetchedAtMs, 7, 'UTC'))).toEqual([{
      date: '2026-06-11',
      live: { impressions: 162, clicks: 0, spendMicros: 0, conversions: 0 },
      stored: null,
      drifted: true,
    }])
  })

  it('counts the lookback in CALENDAR days, so a DST transition cannot move the start date', () => {
    // The window's first day is also the day the provider range starts at, so
    // a boundary that slips by one lands a whole metric date on one side of
    // the comparison only, which then reads as drift on a healthy account.
    // Spring forward: the local day is 23 hours, so a fixed 24-hour step from
    // just after midnight on the 9th skips the 8th entirely.
    expect(liveComparisonWindow(Date.parse('2026-03-09T04:30:00.000Z'), 1, 'America/New_York'))
      .toEqual({ startDate: '2026-03-08', endDate: '2026-03-09' })
    // Fall back: the local day is 25 hours, so the same step from late on the
    // 1st never leaves it.
    expect(liveComparisonWindow(Date.parse('2026-11-02T04:30:00.000Z'), 1, 'America/New_York'))
      .toEqual({ startDate: '2026-10-31', endDate: '2026-11-01' })
    // A zone that transitions AT midnight, where the target day has no hour 00.
    expect(liveComparisonWindow(Date.parse('2026-09-07T03:30:00.000Z'), 1, 'America/Santiago'))
      .toEqual({ startDate: '2026-09-06', endDate: '2026-09-07' })
    // Control: an ordinary date in the same zone is untouched by the fix.
    expect(liveComparisonWindow(Date.parse('2026-06-10T12:00:00.000Z'), 7, 'America/New_York'))
      .toEqual({ startDate: '2026-06-03', endDate: '2026-06-10' })
  })

  it('summarizes drift across entities without conflating status and metric drift', () => {
    const statusOnly = buildLiveEntityComparison({
      entityType: 'campaign',
      id: 'cmpn_1',
      parentId: null,
      live: { name: 'A', status: 'active', reviewStatus: null, mode: null, updatedAt: 5 },
      stored: { name: 'A', status: 'paused', reviewStatus: null, upstreamUpdatedAt: 4, syncedAt: NOW },
      liveMetrics: [],
      storedMetrics: [],
    }, WINDOW)
    const metricsOnly = buildLiveEntityComparison({
      entityType: 'ad_group',
      id: 'adgrp_1',
      parentId: 'cmpn_1',
      live: { name: 'B', status: 'paused', reviewStatus: null, mode: null, updatedAt: 5 },
      stored: { name: 'B', status: 'paused', reviewStatus: null, upstreamUpdatedAt: 4, syncedAt: NOW },
      liveMetrics: [metricRow('2026-06-10', { impressions: 5 })],
      storedMetrics: [],
    }, WINDOW)
    const clean = buildLiveEntityComparison({
      entityType: 'ad',
      id: 'ad_1',
      parentId: 'adgrp_1',
      live: { name: 'C', status: 'paused', reviewStatus: 'approved', mode: null, updatedAt: 5 },
      stored: { name: 'C', status: 'paused', reviewStatus: 'approved', upstreamUpdatedAt: 4, syncedAt: NOW },
      liveMetrics: null,
      storedMetrics: null,
    }, WINDOW)

    expect(statusOnly.drifted).toBe(true)
    expect(metricsOnly.drifted).toBe(true)
    expect(clean.drifted).toBe(false)
    expect(clean.metricDeltas).toBeNull()
    expect(summarizeLiveDrift([statusOnly, metricsOnly, clean])).toEqual({
      entitiesCompared: 3,
      driftedEntities: 2,
      statusDrifted: 1,
      metricsDrifted: 1,
    })
  })
})

describe('GET /projects/:name/ads/live-delivery', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (ctx) {
      await ctx.app.close()
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    }
  })

  async function start(overrides: Overrides = {}) {
    ctx = buildApp(overrides)
    await ctx.app.ready()
    return ctx
  }

  it('surfaces the live-vs-stored status and metric drift that made the snapshot wrong', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active', { name: 'Homeowners Free Estimate', mode: 'standard' })],
      adGroups: [liveEntity('adgrp_1', 'serving', { name: 'Deck Project Planning' })],
      ads: [liveEntity('ad_1', 'active', { name: 'HO Deck - Materials', reviewStatus: 'approved' })],
      campaignMetrics: [metricRow('2026-06-10', { impressions: 162, clicks: 5, spend: 1.5, conversions: 0 })],
      adGroupMetrics: [metricRow('2026-06-10', { impressions: 162, clicks: 5, spend: 1.5, conversions: 0 })],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto
    expect(body.basis).toBe('live-provider-read')
    expect(body.fetchedAt).toBe(NOW)
    expect(body.adAccountId).toBe('adacct_aaa')
    expect(body.storedSnapshotSyncedAt).toBe('2026-06-09T00:00:00.000Z')
    expect(body.metricsWindow).toEqual({ lookbackDays: 7 })
    expect(body.errors).toEqual([])
    expect(body.bounds.truncated).toBe(false)

    const campaign = body.entities.find((entity) => entity.id === 'cmpn_1')!
    expect(campaign.presence).toBe('both')
    expect(campaign.live).toEqual({
      name: 'Homeowners Free Estimate',
      status: 'active',
      reviewStatus: null,
      mode: 'standard',
      updatedAt: 200,
    })
    expect(campaign.stored).toMatchObject({ status: 'paused', upstreamUpdatedAt: 100 })
    expect(campaign.fieldDeltas).toEqual([{ field: 'status', live: 'active', stored: 'paused' }])
    // Provider rows are returned exactly as given: spend stays in the
    // provider's decimal units and is never folded into a total here.
    expect(campaign.liveMetrics).toEqual([
      metricRow('2026-06-10', { impressions: 162, clicks: 5, spend: 1.5, conversions: 0 }),
    ])
    expect(campaign.metricDeltas).toEqual([{
      date: '2026-06-10',
      live: { impressions: 162, clicks: 5, spendMicros: 1_500_000, conversions: 0 },
      stored: { impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
      drifted: true,
    }])
    expect(campaign.drifted).toBe(true)

    const adGroup = body.entities.find((entity) => entity.id === 'adgrp_1')!
    expect(adGroup.parentId).toBe('cmpn_1')
    expect(adGroup.fieldDeltas).toEqual([{ field: 'status', live: 'serving', stored: 'paused' }])

    const ad = body.entities.find((entity) => entity.id === 'ad_1')!
    expect(ad.liveMetrics).toBeNull()
    expect(ad.metricDeltas).toBeNull()
    expect(ad.fieldDeltas).toEqual([{ field: 'status', live: 'active', stored: 'paused' }])

    expect(body.drift).toEqual({
      entitiesCompared: 3,
      driftedEntities: 3,
      statusDrifted: 3,
      metricsDrifted: 2,
    })
  })

  it('never mutates provider or local state: only read methods are called and stored rows are untouched', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active')],
      adGroups: [liveEntity('adgrp_1', 'active')],
      ads: [liveEntity('ad_1', 'active')],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(200)
    expect([...new Set(ctx.readerCalls.map((call) => call.method))].sort()).toEqual([
      'adGroupInsights', 'campaignInsights', 'listAdGroups', 'listAds', 'listCampaigns',
    ])
    // The stale snapshot is evidence, not something the diagnostic repairs.
    const storedCampaign = ctx.db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_1')).get()
    expect(storedCampaign?.status).toBe('paused')
    const storedRollup = ctx.db.select().from(adsInsightsDaily)
      .where(eq(adsInsightsDaily.date, '2026-06-10')).get()
    expect(storedRollup?.impressions).toBe(111)
  })

  it('marks a stored entity absent upstream only when the walk was complete', async () => {
    await start({ campaigns: [], adGroups: [], ads: [] })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(body.bounds.truncated).toBe(false)
    expect(body.entities.map((entity) => entity.presence)).toEqual([
      'stored-only', 'stored-only', 'stored-only',
    ])
    expect(body.entities.every((entity) => entity.drifted)).toBe(true)
    // No metric claim is made for an entity the provider does not have.
    expect(body.entities.every((entity) => entity.metricDeltas === null)).toBe(true)
  })

  it('caps the walk and suppresses stored-only rows once the result is truncated', async () => {
    const campaigns = Array.from({ length: 7 }, (_, index) => liveEntity(`cmpn_x${index}`, 'active'))
    await start({ campaigns, adGroups: [], ads: [] })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(body.bounds.truncated).toBe(true)
    expect(body.bounds.maxCampaigns).toBe(5)
    expect(body.entities).toHaveLength(5)
    expect(body.entities.every((entity) => entity.presence === 'live-only')).toBe(true)
    // cmpn_1 / adgrp_1 / ad_1 exist locally but were never walked, so the
    // response must not imply the provider deleted them.
    expect(body.entities.some((entity) => entity.id === 'cmpn_1')).toBe(false)
  })

  it('scopes the walk to one campaign and honors the metrics window', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active'), liveEntity('cmpn_2', 'active')],
      adGroups: [],
      ads: [],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/projects/acme/ads/live-delivery?campaignId=cmpn_1&lookbackDays=1',
    })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(res.statusCode).toBe(200)
    expect(body.metricsWindow).toEqual({ lookbackDays: 1 })
    // cmpn_2 is out of scope entirely; the scoped campaign's stored children
    // are still compared, and the provider reporting none makes them
    // stored-only.
    expect(body.entities.map((entity) => entity.id)).toEqual(['cmpn_1', 'adgrp_1', 'ad_1'])
    expect(body.entities.map((entity) => entity.presence)).toEqual([
      'both', 'stored-only', 'stored-only',
    ])
    expect(ctx.readerCalls.filter((call) => call.method === 'campaignInsights'))
      .toEqual([{ method: 'campaignInsights', apiKey: API_KEY, entityId: 'cmpn_1' }])
  })

  it('rejects an invalid lookback window', async () => {
    await start()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/projects/acme/ads/live-delivery?lookbackDays=90',
    })

    expect(res.statusCode).toBe(400)
    expect(ctx.readerCalls).toEqual([])
  })

  it('throttles a second live read for the same project and reports the wait', async () => {
    await start({ campaigns: [], minIntervalMs: 60_000 })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const first = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(first.statusCode).toBe(200)

    vi.setSystemTime(new Date(Date.parse(NOW) + 20_000))
    const second = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(second.statusCode).toBe(429)
    const body = JSON.parse(second.body) as { error: { code: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')
    // Refused for being EARLY, not for being concurrent: the first walk
    // finished, so this is purely the spacing rule.
    expect(body.error.details).toMatchObject({
      reason: 'min-interval',
      minIntervalMs: 60_000,
      retryAfterMs: 40_000,
    })
    expect(ctx.readerCalls.filter((call) => call.method === 'listCampaigns')).toHaveLength(1)

    vi.setSystemTime(new Date(Date.parse(NOW) + 60_001))
    const third = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(third.statusCode).toBe(200)
  })

  it('does not report an east-of-UTC account\'s current local day as drift', async () => {
    // 22:00 UTC is already the 11th in Tokyo. The provider reports a bucket
    // for the 11th and the local snapshot holds the identical row for the
    // 11th; a UTC-derived window would filter the stored side out and call it
    // drift.
    vi.setSystemTime(new Date('2026-06-10T22:00:00.000Z'))
    await start({
      accountTimezone: 'Asia/Tokyo',
      campaigns: [liveEntity('cmpn_1', 'active', { name: 'Homeowners Free Estimate' })],
      adGroups: [],
      ads: [],
      campaignMetrics: [metricRow('2026-06-11', { impressions: 162 })],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedDatedCampaign(projectId, '2026-06-11', 162)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(res.statusCode).toBe(200)
    const campaign = body.entities.find((entity) => entity.id === 'cmpn_1')!
    expect(campaign.metricDeltas).toEqual([{
      date: '2026-06-11',
      live: { impressions: 162, clicks: 0, spendMicros: 0, conversions: 0 },
      stored: { impressions: 162, clicks: 0, spendMicros: 0, conversions: 0 },
      drifted: false,
    }])
    expect(body.drift.metricsDrifted).toBe(0)
    expect(campaign.drifted).toBe(false)
  })

  it('asks the provider for the WHOLE first day of the window, so the boundary day is not false drift', async () => {
    // 12:00 UTC is 06:00 in Denver, so a range anchored to the read instant's
    // local hour would start the first day at 06:00 and miss its morning,
    // while the stored rollup for that day is a full day. Every read would
    // then report the difference as drift, on a healthy account.
    await start({
      campaigns: [liveEntity('cmpn_1', 'active', { name: 'Homeowners Free Estimate' })],
      adGroups: [],
      ads: [],
      campaignHourBuckets: [
        { hour: '2026-06-03T02', impressions: 40 },
        { hour: '2026-06-03T18', impressions: 60 },
      ],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedDatedCampaign(projectId, '2026-06-03', 100)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(res.statusCode).toBe(200)
    // The provider range starts at 00:00 local on the window's first day, and
    // that day is the SAME boundary the stored side is filtered to.
    expect(ctx.insightRequests[0].request).toEqual({
      startDate: '2026-06-03',
      fetchedAtMs: Date.parse(NOW),
      timezone: 'America/Denver',
    })
    expect(rangeOf(ctx.insightRequests[0].request).since).toBe('2026-06-03T00')
    expect(liveComparisonWindow(Date.parse(NOW), 7, 'America/Denver').startDate).toBe('2026-06-03')

    const campaign = body.entities.find((entity) => entity.id === 'cmpn_1')!
    expect(campaign.metricDeltas).toEqual([{
      date: '2026-06-03',
      live: { impressions: 100, clicks: 0, spendMicros: 0, conversions: 0 },
      stored: { impressions: 100, clicks: 0, spendMicros: 0, conversions: 0 },
      drifted: false,
    }])
    expect(campaign.drifted).toBe(false)
    expect(body.drift.metricsDrifted).toBe(0)
  })

  it('reads the day in progress unranged, so it is not false drift', async () => {
    // 12:00 UTC is 06:00 in Denver, so the account's local 2026-06-10 is a
    // quarter over and its daily bucket runs to 06-11 00:00 local. The
    // provider serves a day only when the range covers that WHOLE span, and
    // it refuses a range that ends in the future, so no ranged call can ever
    // return the day in progress. The stored side holds that day's partial row
    // from the last sync, so a live side without it reported a stored-only day
    // as drift on every read and ran a day behind the provider's own UI. The
    // host reads it from a second, unranged call instead.
    await start({
      campaigns: [liveEntity('cmpn_1', 'active', { name: 'Homeowners Free Estimate' })],
      adGroups: [],
      ads: [],
      campaignDayBuckets: [
        { date: '2026-06-09', impressions: 137 },
        // Partial on BOTH sides and equal: the last ads-sync stored exactly
        // this reading of the day in progress, so there is nothing to report.
        { date: '2026-06-10', impressions: 68 },
      ],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedDatedCampaign(projectId, '2026-06-09', 137)
    ctx.db.insert(adsInsightsDaily).values({
      id: crypto.randomUUID(), projectId, syncRunId: null,
      level: 'campaign', entityId: 'cmpn_1', date: '2026-06-10',
      impressions: 68, clicks: 0, spendMicros: 0, conversions: 0,
    }).run()

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(res.statusCode).toBe(200)
    // The ranged edge stops at the START of the open day and never names a
    // future hour: "2026-06-11T00" would be refused with
    // "400: time_ranges.end cannot be in the future" and fail the whole read.
    expect(rangeOf(ctx.insightRequests[0].request).until).toBe('2026-06-10T00')
    // And that day is the window's last day on the stored side too, so the
    // two sides are filtered and asked over the same closing date.
    expect(liveComparisonWindow(Date.parse(NOW), 7, 'America/Denver').endDate).toBe('2026-06-10')

    const campaign = body.entities.find((entity) => entity.id === 'cmpn_1')!
    expect(campaign.metricDeltas).toEqual([
      {
        date: '2026-06-09',
        live: { impressions: 137, clicks: 0, spendMicros: 0, conversions: 0 },
        stored: { impressions: 137, clicks: 0, spendMicros: 0, conversions: 0 },
        drifted: false,
      },
      {
        date: '2026-06-10',
        live: { impressions: 68, clicks: 0, spendMicros: 0, conversions: 0 },
        stored: { impressions: 68, clicks: 0, spendMicros: 0, conversions: 0 },
        drifted: false,
      },
    ])
    expect(campaign.drifted).toBe(false)
    expect(body.drift.metricsDrifted).toBe(0)
  })

  it('pins every insight call in one walk to the identical range, across an hour boundary', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active')],
      adGroups: [liveEntity('adgrp_1', 'active')],
      ads: [],
      // The walk itself outlives an account-local hour between the two calls.
      advanceClockPerInsightMs: 61 * 60_000,
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(res.statusCode).toBe(200)
    expect(ctx.insightRequests.map((entry) => entry.method))
      .toEqual(['campaignInsights', 'adGroupInsights'])
    // The clock genuinely moved across an hour boundary between the calls.
    expect(ctx.insightRequests.map((entry) => accountHourKey(entry.wallClockNow, 'America/Denver')))
      .toEqual(['2026-06-10T06', '2026-06-10T07'])
    // Both calls still measure one identical range, anchored to the instant
    // the response reports as `fetchedAt`.
    const ranges = ctx.insightRequests.map((entry) => rangeOf(entry.request))
    expect(ranges[0]).toEqual({
      since: '2026-06-03T00',
      until: '2026-06-10T00',
      timezone: 'America/Denver',
    })
    expect(ranges[1]).toEqual(ranges[0])
    expect(body.fetchedAt).toBe(NOW)
    expect(ctx.insightRequests.every(
      (entry) => entry.request.fetchedAtMs === Date.parse(body.fetchedAt),
    )).toBe(true)
  })

  it('reports the walk budget in reader calls and the real upstream HTTP ceiling', async () => {
    await start({ campaigns: [liveEntity('cmpn_1', 'active')], adGroups: [], ads: [] })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    // account identity + campaign list + campaign insights + ad group list.
    expect(body.bounds.readerCalls).toBe(4)
    expect(body.bounds.maxReaderCalls).toBe(40)
    // A reader call is not one HTTP request: each list/insight read
    // auto-paginates, so the honest ceiling is two orders of magnitude higher.
    // An insight read additionally makes one single-page unranged request for
    // the day in progress, which the ceiling charges to every reader call.
    expect(body.bounds.maxPagesPerReaderCall).toBe(100)
    expect(body.bounds.maxUpstreamHttpRequests).toBe(40 * (100 + 1))
  })

  it('spends the attempt once provider I/O has begun, so a failed read is still throttled', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active')],
      adGroups: [],
      ads: [],
      minIntervalMs: 60_000,
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const listCampaigns = ctx.reader.listCampaigns
    let attempts = 0
    ctx.reader.listCampaigns = async (apiKey) => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('upstream down'), { status: 502 })
      return listCampaigns(apiKey)
    }

    const failed = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(failed.statusCode).toBe(502)

    // Same instant. Account verification and the campaign list already went
    // upstream, so this attempt is spent: one admitted read can fan out to
    // thousands of HTTP requests, and re-arming on failure would turn a
    // provider outage into a retry storm.
    const retry = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(retry.statusCode).toBe(429)
    expect(attempts).toBe(1)

    // The interval still expires normally; the failure costs one interval, not more.
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_001))
    const third = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(third.statusCode).toBe(200)
    expect(attempts).toBe(2)
  })

  it('spends the attempt when account verification fails: the provider was already called', async () => {
    await start({
      verifyError: Object.assign(new Error('upstream down'), { status: 503 }),
      minIntervalMs: 60_000,
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const first = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const second = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(first.statusCode).toBe(502)
    // Verification IS provider I/O, so the attempt counted.
    expect(second.statusCode).toBe(429)
  })

  it('does not spend the attempt when the read fails before the provider is touched', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active')],
      adGroups: [],
      ads: [],
      minIntervalMs: 60_000,
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const badInput = await ctx.app.inject({
      method: 'GET',
      url: '/projects/acme/ads/live-delivery?lookbackDays=90',
    })
    expect(badInput.statusCode).toBe(400)
    expect(ctx.readerCalls).toEqual([])

    // Same instant: nothing was asked of the provider, so nothing was spent
    // and the operator can correct the request immediately.
    const retry = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(retry.statusCode).toBe(200)
  })

  it('does not spend the attempt for a project with no ads connection', async () => {
    await start({ campaigns: [liveEntity('cmpn_1', 'active')], adGroups: [], ads: [], minIntervalMs: 60_000 })
    const projectId = ctx.seedProject()

    const noConnection = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(noConnection.statusCode).toBe(400)
    expect(ctx.readerCalls).toEqual([])

    ctx.seedConnection(projectId)
    const retry = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(retry.statusCode).toBe(200)
  })

  it('admits only one of two concurrent reads while the first is still in flight', async () => {
    // Real timers: an unawaited injection needs real event-loop turns to
    // dispatch, and a frozen clock stalls it.
    vi.useRealTimers()
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    let markInFlight!: () => void
    const inFlight = new Promise<void>((resolve) => { markInFlight = resolve })
    await start({
      campaigns: [],
      minIntervalMs: 60_000,
      holdVerify: gate,
      onVerifyStart: () => { markInFlight() },
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    // The first read parks inside account verification and is NOT awaited, so
    // the second one arrives while the first is genuinely mid-walk. This is
    // the case the claim-before-I/O ordering exists for.
    const first = ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    await inFlight
    const second = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    openGate()
    // Exactly one 200 and one 429: the successful read holds the interval, and
    // the loser is rejected rather than queued.
    const statuses = [(await first).statusCode, second.statusCode].sort()
    expect(statuses).toEqual([200, 429])
    expect(ctx.readerCalls.filter((call) => call.method === 'listCampaigns')).toHaveLength(1)
  })

  it('refuses a concurrent read even after the interval has expired mid-walk', async () => {
    // Fake the CLOCK ONLY: the first read is deliberately left unawaited while
    // it is still walking, which needs real event-loop turns to dispatch, but
    // the whole point of this case is to move time forward while it runs.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    let markInFlight!: () => void
    const inFlight = new Promise<void>((resolve) => { markInFlight = resolve })
    let verifyStarts = 0
    await start({
      campaigns: [],
      minIntervalMs: 60_000,
      holdVerify: gate,
      onVerifyStart: () => {
        verifyStarts += 1
        if (verifyStarts === 1) markInFlight()
        // A second walk must never get here. Let it through rather than park
        // it behind the same gate, so a regression fails on the assertions
        // below instead of deadlocking into a timeout.
        else openGate()
      },
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const first = ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    await inFlight

    // A whole minimum interval passes while the first walk is STILL upstream.
    // A claim expressed as a timestamp expires exactly here, which admitted a
    // second walk onto the same account: with a ~4040-request ceiling per walk,
    // a slow provider makes overlapping walks the normal case rather than the
    // rare one.
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_001))
    const second = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(second.statusCode).toBe(429)
    const body = JSON.parse(second.body) as { error: { code: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')
    // Refused for being CONCURRENT. The interval is already gone, so no
    // retryAfterMs is claimed: how much longer the running walk needs is not
    // knowable from here.
    expect(body.error.details).toEqual({ reason: 'read-in-flight', minIntervalMs: 60_000 })

    openGate()
    expect((await first).statusCode).toBe(200)
    // The refused read never reached the provider: exactly one walk happened.
    expect(verifyStarts).toBe(1)
    expect(ctx.readerCalls.filter((call) => call.method === 'listCampaigns')).toHaveLength(1)
  })

  it('clears the in-flight marker when the walk throws, so a failure cannot wedge the project', async () => {
    let verifyStarts = 0
    await start({
      verifyError: Object.assign(new Error('upstream down'), { status: 503 }),
      minIntervalMs: 60_000,
      onVerifyStart: () => { verifyStarts += 1 },
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const failed = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(failed.statusCode).toBe(502)
    expect(verifyStarts).toBe(1)

    // Same instant: refused by the SPACING rule, because the attempt reached
    // the provider. A leaked marker would show up here as a concurrency
    // refusal for a walk that is not running.
    const immediate = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(immediate.statusCode).toBe(429)
    expect((JSON.parse(immediate.body) as { error: { details?: Record<string, unknown> } }).error.details)
      .toMatchObject({ reason: 'min-interval' })

    // Past the interval the spacing rule has no opinion left, so the read is
    // admitted and reaches the provider again. A leaked marker would refuse
    // this project forever.
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_001))
    const next = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(next.statusCode).toBe(502)
    expect(verifyStarts).toBe(2)
  })

  it('400s a project with no ads connection without calling the provider', async () => {
    await start()
    ctx.seedProject()

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(400)
    expect(ctx.readerCalls).toEqual([])
  })

  it('refuses to label live rows with the wrong account when the key moved', async () => {
    await start({ verifiedAccountId: 'adacct_other', campaigns: [liveEntity('cmpn_1', 'active')] })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(400)
    expect(ctx.readerCalls).toEqual([])
  })

  it('records a failed sub-read without its provider message and keeps the rest of the walk', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active')],
      readerError: undefined,
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    // Fail only the ad-group listing; everything else still resolves.
    ctx.reader.listAdGroups = async () => {
      throw Object.assign(new Error(`upstream rejected Authorization: Bearer ${API_KEY}`), { status: 503 })
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(res.statusCode).toBe(200)
    expect(body.errors).toEqual([
      { surface: 'ad group list', entityId: 'cmpn_1', upstreamStatus: 503 },
    ])
    expect(body.entities.map((entity) => entity.id)).toEqual(['cmpn_1'])
    expect(res.body).not.toContain(API_KEY)
  })
})

describe('live delivery credential safety', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  /** An upstream failure that embeds the credential everywhere it could. */
  function hostileError(): Error {
    const error = new Error(`401 unauthorized for Authorization: Bearer ${API_KEY}`)
    return Object.assign(error, {
      status: 401,
      code: API_KEY,
      body: { requestUrl: `https://api.ads.openai.com/v1/campaigns?api_key=${API_KEY}` },
      response: { headers: { authorization: `Bearer ${API_KEY}` } },
    })
  }

  it('never serializes the credential on the success path', async () => {
    ctx = buildApp({
      campaigns: [liveEntity('cmpn_1', 'active', { name: 'Homeowners Free Estimate' })],
      adGroups: [liveEntity('adgrp_1', 'active')],
      ads: [liveEntity('ad_1', 'active')],
      campaignMetrics: [metricRow('2026-06-10', { impressions: 1, spend: 0.5 })],
      adGroupMetrics: [metricRow('2026-06-10', { impressions: 1, spend: 0.5 })],
    })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(200)
    // The reader DOES receive the key (that is the whole point of a
    // server-side passthrough) but nothing it touches reaches the caller.
    expect(ctx.readerCalls.every((call) => call.apiKey === API_KEY)).toBe(true)
    expect(res.body).not.toContain(API_KEY)
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain(API_KEY)
    expect(ctx.logLines.join('\n')).not.toContain(API_KEY)
  })

  it('never serializes or logs the credential when the provider read fails', async () => {
    ctx = buildApp({ readerError: hostileError() })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body) as { error: { code: string; message: string; details?: unknown } }
    expect(body.error.code).toBe('PROVIDER_ERROR')
    expect(body.error.message).toBe('OpenAI Ads API campaign list read failed')
    expect(body.error.details).toEqual({ upstreamStatus: 401 })
    expect(res.body).not.toContain(API_KEY)
    expect(ctx.logLines.join('\n')).not.toContain(API_KEY)
  })

  it('never serializes or logs the credential when account verification fails', async () => {
    ctx = buildApp({ verifyError: hostileError() })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body) as { error: { message: string } }
    expect(body.error.message).toBe('OpenAI Ads API account identity read failed')
    expect(res.body).not.toContain(API_KEY)
    expect(ctx.logLines.join('\n')).not.toContain(API_KEY)
  })

  it('never serializes or logs the credential when a per-entity read fails', async () => {
    ctx = buildApp({ campaigns: [liveEntity('cmpn_1', 'active')] })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.reader.campaignInsights = async () => {
      throw hostileError()
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto
    expect(body.errors).toEqual([
      { surface: 'campaign insights', entityId: 'cmpn_1', upstreamStatus: 401 },
    ])
    expect(res.body).not.toContain(API_KEY)
    expect(ctx.logLines.join('\n')).not.toContain(API_KEY)
  })
})
