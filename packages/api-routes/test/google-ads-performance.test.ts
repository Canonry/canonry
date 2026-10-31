import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AppError,
  RunKinds,
  RunStatuses,
  RunTriggers,
  UserRoles,
  formatIsoDate,
  googleAdsPerformanceDtoSchema,
  inclusiveDayCount,
  shiftIsoCalendarDate,
  type GoogleAdsCampaignMetricDto,
  type GoogleAdsPerformanceDto,
} from '@canonry/canonry-contracts'
import {
  createClient,
  googleAdsConnections,
  googleAdsRawSnapshots,
  migrate,
  projects,
  runs,
} from '@canonry/canonry-db'
import { googleMarketingRoutes } from '../src/google-marketing.js'

/**
 * Every date below is fixed. The route derives its cutoff from the payload's own
 * `fetchedAt`, never from a clock, so a fixture captured at a frozen instant must
 * report the same window forever — that is the property under test, not a
 * convenience.
 */
const CAPTURED_AT = '2026-08-25T12:00:00.000Z'
/** The account-local calendar day of the capture. Partial, therefore excluded. */
const OPEN_DATE = '2026-08-25'
/** The newest CLOSED day. Every window ends here. */
const AS_OF_DATE = '2026-08-24'
const COVERAGE_START = '2026-07-26'
const SHA = 'a'.repeat(64)

interface TestContext {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  /** Every provider call the route made. Must stay empty: this is a stored read. */
  liveCalls: string[]
}

function buildApp(): TestContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-ads-performance-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'project_acme', name: 'acme', displayName: 'Acme',
    canonicalDomain: 'https://acme.example', country: 'US', language: 'en',
    createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT,
  }).run()

  const liveCalls: string[] = []
  const app = Fastify()
  app.decorate('db', db)
  app.addHook('onRequest', async (request) => {
    request.principal = { kind: 'user', id: 'admin', name: 'admin', scopes: ['*'], role: UserRoles.admin, viaCookie: true }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    throw error
  })
  app.register(googleMarketingRoutes, {
    googleMarketingLiveReader: {
      listGoogleAdsCustomers: async () => {
        liveCalls.push('google-ads-customers')
        return {
          customers: [], totalAccessible: 0, truncated: false,
          selection: { loginCustomerId: null, customerId: null, selectedAt: null }, fetchedAt: CAPTURED_AT,
        }
      },
      listGtmAccounts: async () => {
        liveCalls.push('gtm-accounts')
        return { accounts: [], totalAccessible: 0, truncated: false, fetchedAt: CAPTURED_AT }
      },
      listGtmContainers: async (_project, accountId) => {
        liveCalls.push('gtm-containers')
        return { accountId, containers: [], totalAccessible: 0, truncated: false, fetchedAt: CAPTURED_AT }
      },
      listGtmWorkspaces: async (_project, accountId, containerId) => {
        liveCalls.push('gtm-workspaces')
        return { accountId, containerId, workspaces: [], totalAccessible: 0, truncated: false, fetchedAt: CAPTURED_AT }
      },
    },
  })

  return { app, db, tmpDir, liveCalls }
}

function metricRow(
  campaignId: string,
  date: string,
  values: Partial<Omit<GoogleAdsCampaignMetricDto, 'campaignId' | 'date'>>,
): GoogleAdsCampaignMetricDto {
  return {
    campaignId,
    date,
    impressions: values.impressions ?? 0,
    clicks: values.clicks ?? 0,
    costMicros: values.costMicros ?? 0,
    conversions: values.conversions ?? 0,
    conversionValueMicros: values.conversionValueMicros ?? null,
  }
}

/**
 * A 31-day snapshot captured mid-day on OPEN_DATE, exactly as the sync runtime
 * writes one: the queried range ENDS on the still-open capture day.
 */
function seedSnapshots(ctx: TestContext, options: {
  rows: readonly GoogleAdsCampaignMetricDto[]
  campaignIds: readonly string[]
  inventoryCampaigns?: ReadonlyArray<{ id: string; name: string; status: 'enabled' | 'paused' | 'removed' | 'unknown' }>
  truncated?: boolean
  timeZone?: string | null
  queryStartDate?: string
  queryEndDate?: string
}): void {
  const inventoryCampaigns = options.inventoryCampaigns ?? []
  ctx.db.insert(runs).values({
    id: 'ads-sync-run', projectId: 'project_acme', kind: RunKinds['google-ads-sync'],
    status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: CAPTURED_AT,
  }).run()
  ctx.db.insert(googleAdsConnections).values({
    id: 'ads-connection', projectId: 'project_acme', selectedCustomerId: '1234567890',
    selectedCustomerName: 'Acme Ads', selectedCustomerCurrencyCode: 'USD',
    selectedCustomerTimeZone: options.timeZone === undefined ? 'UTC' : options.timeZone,
    scopes: [],
    lastInventorySnapshotAt: CAPTURED_AT, lastInventorySnapshotId: 'inventory-snapshot',
    lastMetricsSnapshotAt: CAPTURED_AT, lastMetricsSnapshotId: 'metrics-snapshot',
    createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT,
  }).run()
  ctx.db.insert(googleAdsRawSnapshots).values([
    {
      id: 'inventory-snapshot', projectId: 'project_acme', connectionId: 'ads-connection',
      runId: 'ads-sync-run', kind: 'inventory', customerId: '1234567890',
      payloadChecksum: SHA, rawPayloadSha256: null, rawPayloadBytes: null, redactedFieldCount: 0,
      capturedAt: CAPTURED_AT, createdAt: CAPTURED_AT,
      payload: {
        kind: 'inventory',
        data: {
          customerId: '1234567890',
          fetchedAt: CAPTURED_AT,
          campaigns: inventoryCampaigns.map(campaign => ({
            id: campaign.id,
            resourceName: `customers/1234567890/campaigns/${campaign.id}`,
            name: campaign.name,
            status: campaign.status,
            advertisingChannelType: 'SEARCH',
            biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
          })),
          conversionActions: [],
          customerConversionGoals: [],
          campaignConversionGoals: [],
          customConversionGoals: [],
          campaignGoalConfigurations: [],
        },
      },
    },
    {
      id: 'metrics-snapshot', projectId: 'project_acme', connectionId: 'ads-connection',
      runId: 'ads-sync-run', kind: 'campaign-metrics', customerId: '1234567890',
      payloadChecksum: SHA, rawPayloadSha256: null, rawPayloadBytes: null, redactedFieldCount: 0,
      capturedAt: CAPTURED_AT, createdAt: CAPTURED_AT,
      payload: {
        kind: 'campaign-metrics',
        data: {
          query: {
            campaignIds: [...options.campaignIds],
            startDate: options.queryStartDate ?? COVERAGE_START,
            endDate: options.queryEndDate ?? OPEN_DATE,
          },
          rows: [...options.rows],
          truncated: options.truncated ?? false,
          fetchedAt: CAPTURED_AT,
        },
      },
    },
  ]).run()
}

/**
 * The fixture the math assertions below are hand-computed against.
 *
 * Deliberate shapes:
 * - `2026-08-25` is the OPEN capture day and carries huge values, so any leak
 *   into a window is impossible to miss.
 * - `2026-08-19` is a provider day with zero impressions (ctr must be null).
 * - `2026-08-20`, `2026-08-23`, `2026-08-24` have no rows (must be densified).
 * - `c2` never appears in the inventory snapshot.
 * - conversions are fractional, because Google reports them that way.
 */
function seedReferenceFixture(ctx: TestContext): void {
  seedSnapshots(ctx, {
    campaignIds: ['c1', 'c2'],
    inventoryCampaigns: [{ id: 'c1', name: 'Brand Search', status: 'enabled' }],
    rows: [
      // Prior 7-day period (2026-08-11 .. 2026-08-17).
      metricRow('c1', '2026-08-15', { impressions: 220, clicks: 10, costMicros: 3_000_000, conversions: 1.25, conversionValueMicros: 1_500_000 }),
      // Current 7-day window (2026-08-18 .. 2026-08-24).
      metricRow('c1', '2026-08-18', { impressions: 100, clicks: 5, costMicros: 1_500_000, conversions: 2.5, conversionValueMicros: 3_000_000 }),
      metricRow('c1', '2026-08-19', {}),
      metricRow('c1', '2026-08-21', { impressions: 300, clicks: 15, costMicros: 4_500_000 }),
      metricRow('c2', '2026-08-22', { impressions: 40 }),
      // The still-open capture day.
      metricRow('c1', OPEN_DATE, { impressions: 999_999, clicks: 999, costMicros: 9_999_999, conversions: 99 }),
    ],
  })
}

async function readPerformance(ctx: TestContext, query = ''): Promise<GoogleAdsPerformanceDto> {
  const response = await ctx.app.inject({ method: 'GET', url: `/projects/acme/google-ads/performance${query}` })
  expect(response.statusCode).toBe(200)
  const parsed = googleAdsPerformanceDtoSchema.safeParse(response.json())
  expect(parsed.success ? null : parsed.error.issues).toBeNull()
  return response.json<GoogleAdsPerformanceDto>()
}

const contexts: TestContext[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close()
    fs.rmSync(context.tmpDir, { recursive: true, force: true })
  }
})

describe('GET /projects/:name/google-ads/performance', () => {
  it('sums the closed window exactly and derives every ratio from the finished sums', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context, '?window=7d')

    expect(performance.window).toBe('7d')
    expect(performance.startDate).toBe('2026-08-18')
    expect(performance.endDate).toBe(AS_OF_DATE)
    expect(performance.days).toBe(7)
    expect(performance.totals).toEqual({
      impressions: 440,
      clicks: 20,
      costMicros: 6_000_000,
      conversions: 2.5,
      conversionValueMicros: 3_000_000,
      // Raw float, never rounded server-side.
      ctr: 20 / 440,
      cpcMicros: 300_000,
      conversionRate: 2.5 / 20,
      costPerConversionMicros: 2_400_000,
    })
    // Not the rounded 0.05 a display layer would show.
    expect(performance.totals.ctr).toBeCloseTo(0.045454545454545456, 15)
    expect(performance.totals.conversions).toBe(2.5)
    // No provider call may happen on a stored read: a live metrics read spends
    // the advertiser's budget.
    expect(context.liveCalls).toEqual([])
  })

  it('densifies the daily series so it sums exactly to the totals', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context, '?window=7d')

    expect(performance.daily.map(point => point.date)).toEqual([
      '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24',
    ])
    const summed = performance.daily.reduce(
      (acc, point) => ({
        impressions: acc.impressions + point.impressions,
        clicks: acc.clicks + point.clicks,
        costMicros: acc.costMicros + point.costMicros,
        conversions: acc.conversions + point.conversions,
      }),
      { impressions: 0, clicks: 0, costMicros: 0, conversions: 0 },
    )
    expect(summed).toEqual({
      impressions: performance.totals.impressions,
      clicks: performance.totals.clicks,
      costMicros: performance.totals.costMicros,
      conversions: performance.totals.conversions,
    })
  })

  it('marks a calendar gap as filled zero delivery instead of dropping the day', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context, '?window=7d')

    expect(performance.daily.find(point => point.date === '2026-08-20')).toEqual({
      date: '2026-08-20', origin: 'filled', impressions: 0, clicks: 0, costMicros: 0, conversions: 0, ctr: null,
    })
    expect(performance.daily.filter(point => point.origin === 'filled').map(point => point.date))
      .toEqual(['2026-08-20', '2026-08-23', '2026-08-24'])
    expect(performance.daily.find(point => point.date === '2026-08-18')?.origin).toBe('provider')
  })

  it('reports a zero denominator as null and a measured zero as zero', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context, '?window=7d')

    // Zero impressions is an UNDEFINED ctr, not a ctr of 0.
    const noImpressions = performance.daily.find(point => point.date === '2026-08-19')
    expect(noImpressions).toMatchObject({ origin: 'provider', impressions: 0, clicks: 0 })
    expect(noImpressions?.ctr).toBeNull()

    // 40 impressions and 0 clicks IS a measured ctr of 0.
    const measuredZero = performance.daily.find(point => point.date === '2026-08-22')
    expect(measuredZero?.ctr).toBe(0)

    const c2 = performance.campaigns.find(campaign => campaign.campaignId === 'c2')
    expect(c2?.totals.ctr).toBe(0)
    expect(c2?.totals.cpcMicros).toBeNull()
    expect(c2?.totals.conversionRate).toBeNull()
    expect(c2?.totals.costPerConversionMicros).toBeNull()
    expect(c2?.totals.conversionValueMicros).toBeNull()
  })

  it('excludes the partial capture day from totals, the series, and the campaign rows', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context, '?window=7d')

    expect(performance.daily.some(point => point.date === OPEN_DATE)).toBe(false)
    expect(performance.endDate).toBe(AS_OF_DATE)
    expect(performance.totals.impressions).toBe(440)
    expect(performance.totals.clicks).toBe(20)
    expect(performance.totals.costMicros).toBe(6_000_000)
    expect(performance.campaigns.find(campaign => campaign.campaignId === 'c1')?.totals.impressions).toBe(400)
    expect(performance.source).toMatchObject({
      snapshotId: 'metrics-snapshot',
      capturedAt: CAPTURED_AT,
      customerId: '1234567890',
      currencyCode: 'USD',
      timeZone: 'UTC',
      asOfDate: AS_OF_DATE,
      openDate: OPEN_DATE,
      truncated: false,
      campaignsQueried: 2,
      campaignsInInventory: 1,
    })
  })

  it('keeps a campaign the inventory snapshot does not name', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context, '?window=7d')

    expect(performance.campaigns).toEqual([
      {
        campaignId: 'c1',
        name: 'Brand Search',
        status: 'enabled',
        totals: {
          impressions: 400,
          clicks: 20,
          costMicros: 6_000_000,
          conversions: 2.5,
          conversionValueMicros: 3_000_000,
          ctr: 20 / 400,
          cpcMicros: 300_000,
          conversionRate: 2.5 / 20,
          costPerConversionMicros: 2_400_000,
        },
      },
      {
        campaignId: 'c2',
        name: null,
        status: 'unknown',
        totals: {
          impressions: 40,
          clicks: 0,
          costMicros: 0,
          conversions: 0,
          conversionValueMicros: null,
          ctr: 0,
          cpcMicros: null,
          conversionRate: null,
          costPerConversionMicros: null,
        },
      },
    ])
  })

  it('compares against the prior equal period without rounding the change ratios', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context, '?window=7d')

    expect(performance.comparisonUnavailableReason).toBeNull()
    expect(performance.comparison).toEqual({
      days: 7,
      prior: {
        startDate: '2026-08-11',
        endDate: '2026-08-17',
        days: 7,
        totals: {
          impressions: 220,
          clicks: 10,
          costMicros: 3_000_000,
          conversions: 1.25,
          conversionValueMicros: 1_500_000,
          ctr: 10 / 220,
          cpcMicros: 300_000,
          conversionRate: 1.25 / 10,
          costPerConversionMicros: 2_400_000,
        },
      },
      change: {
        impressions: 1,
        clicks: 1,
        costMicros: 1,
        conversions: 1,
        // Same rate in both periods is a measured 0 change, not a null.
        ctr: 0,
        conversionRate: 0,
      },
    })
  })

  it('defaults to the 14 day window', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context)

    expect(performance.window).toBe('14d')
    expect(performance.days).toBe(14)
    expect(performance.startDate).toBe('2026-08-11')
    expect(performance.endDate).toBe(AS_OF_DATE)
    expect(performance.daily).toHaveLength(14)
    // The prior 14 days start 2026-07-28, inside the stored 31-day range.
    expect(performance.comparison?.prior).toMatchObject({ startDate: '2026-07-28', endDate: '2026-08-10' })
  })

  it('refuses a 30 day comparison the stored snapshot can never cover', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    const performance = await readPerformance(context, '?window=30d')

    expect(performance.days).toBe(30)
    expect(performance.startDate).toBe('2026-07-26')
    expect(performance.endDate).toBe(AS_OF_DATE)
    // 31 stored days hold at most 30 closed days, so 30d consumes all of them
    // and 2 x 30 = 60 never fit.
    expect(performance.comparison).toBeNull()
    expect(performance.comparisonUnavailableReason).toBe('insufficient-history')
    // The window itself is still real evidence.
    expect(performance.source?.asOfDate).toBe(AS_OF_DATE)
    expect(performance.totals.impressions).toBe(660)
  })

  it('returns the documented empty payload rather than a 404 when nothing is stored', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    const performance = await readPerformance(context)

    expect(performance).toEqual({
      window: '14d',
      startDate: shiftIsoCalendarDate(formatIsoDate(new Date().toISOString()), -14),
      endDate: shiftIsoCalendarDate(formatIsoDate(new Date().toISOString()), -1),
      days: 14,
      totals: {
        impressions: 0,
        clicks: 0,
        costMicros: 0,
        conversions: 0,
        conversionValueMicros: null,
        ctr: null,
        cpcMicros: null,
        conversionRate: null,
        costPerConversionMicros: null,
      },
      daily: [],
      campaigns: [],
      comparison: null,
      comparisonUnavailableReason: 'no-snapshot',
      source: null,
    })
    expect(inclusiveDayCount(performance.startDate, performance.endDate)).toBe(14)
    expect(context.liveCalls).toEqual([])
  })

  it('normalizes a bare day count and keeps an empty selection at the default', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)
    expect(await readPerformance(context, '?window=7')).toEqual(await readPerformance(context, '?window=7d'))
    expect(await readPerformance(context, '?window=')).toEqual(await readPerformance(context))
  })

  it('rejects an unsupported window instead of silently serving another one', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedReferenceFixture(context)

    // 30d is now SERVABLE (it consumes all 30 closed days) so it is no longer a
    // rejection case; 90d still is, since the stored snapshot cannot reach it.
    for (const window of ['28d', '90d', 'week']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/projects/acme/google-ads/performance?window=${encodeURIComponent(window)}`,
      })
      expect(response.statusCode, window).toBe(400)
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('404s an unknown project', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    const response = await context.app.inject({ method: 'GET', url: '/projects/nope/google-ads/performance' })
    expect(response.statusCode).toBe(404)
  })

  it('reads the capture day in the account time zone, not UTC', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    // 2026-08-25T12:00:00Z is already 2026-08-25 21:00 in Tokyo and 2026-08-25
    // 05:00 in Los Angeles, so both accounts open on the same date here; the
    // point is that the zone, not UTC, decides which date the instant is.
    seedSnapshots(context, {
      campaignIds: ['c1'],
      timeZone: 'Asia/Tokyo',
      inventoryCampaigns: [{ id: 'c1', name: 'Brand Search', status: 'enabled' }],
      rows: [metricRow('c1', OPEN_DATE, { impressions: 5_000, clicks: 50, costMicros: 1_000_000 })],
    })

    const performance = await readPerformance(context, '?window=7d')

    expect(performance.source?.timeZone).toBe('Asia/Tokyo')
    expect(performance.source?.openDate).toBe(OPEN_DATE)
    expect(performance.source?.asOfDate).toBe(AS_OF_DATE)
    expect(performance.totals.impressions).toBe(0)
    expect(performance.daily.every(point => point.origin === 'filled')).toBe(true)
  })

  it('reports a truncated snapshot and a stale window without moving the cutoff', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    seedSnapshots(context, {
      campaignIds: ['c1'],
      truncated: true,
      inventoryCampaigns: [{ id: 'c1', name: 'Brand Search', status: 'paused' }],
      rows: [metricRow('c1', '2026-08-24', { impressions: 10, clicks: 1, costMicros: 250_000, conversions: 0.5 })],
    })

    const first = await readPerformance(context, '?window=7d')
    const second = await readPerformance(context, '?window=7d')

    expect(first.source?.truncated).toBe(true)
    expect(first.endDate).toBe(AS_OF_DATE)
    // Two reads at different wall-clock instants must name the same window.
    expect(second).toEqual(first)
    expect(first.campaigns[0]).toMatchObject({ campaignId: 'c1', name: 'Brand Search', status: 'paused' })
    expect(first.totals.conversions).toBe(0.5)
    expect(first.totals.costPerConversionMicros).toBe(500_000)
  })
})
