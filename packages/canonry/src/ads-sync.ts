import crypto from 'node:crypto'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, adsConnections, adsCampaigns, adsAdGroups, adsAds, adsInsightsDaily } from '@ainyc/canonry-db'
import {
  buildRunErrorFromMessages,
  serializeRunError,
  dollarsToMicros,
  formatIsoDateInTimeZone,
  startOfDayHourInTimeZone,
  describeError,
} from '@ainyc/canonry-contracts'
import {
  getAdAccount,
  listCampaigns,
  listAdGroups,
  listAds,
  getCampaignInsights,
  getAdGroupInsights,
} from '@ainyc/canonry-integration-openai-ads'
import type {
  OpenAiAdsAd,
  OpenAiAdsAdGroup,
  OpenAiAdsCampaign,
  OpenAiAdsInsightHourRange,
  OpenAiAdsInsightRow,
  OpenAiAdsInsightsOptions,
} from '@ainyc/canonry-integration-openai-ads'
import type { CanonryConfig } from './config.js'
import { getOpenAiAdsConnection } from './ads-config.js'
import { createLogger } from './logger.js'

const log = createLogger('AdsSync')

export const CAMPAIGN_INSIGHT_FIELDS = ['campaign.impressions', 'campaign.clicks', 'campaign.spend', 'campaign.conversions', 'metadata.readable_time']
export const AD_GROUP_INSIGHT_FIELDS = ['ad_group.impressions', 'ad_group.clicks', 'ad_group.spend', 'ad_group.conversions', 'metadata.readable_time']
// The same fields MINUS conversions, for the unranged call that returns the
// day in progress. Asking for conversions without time_ranges[] is a 400, and
// the range that would satisfy it is the range that excludes the open day, so
// the day in progress has no conversion figure to read until it closes.
export const CAMPAIGN_IN_PROGRESS_INSIGHT_FIELDS = CAMPAIGN_INSIGHT_FIELDS.filter((field) => field !== 'campaign.conversions')
export const AD_GROUP_IN_PROGRESS_INSIGHT_FIELDS = AD_GROUP_INSIGHT_FIELDS.filter((field) => field !== 'ad_group.conversions')
const INSIGHTS_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000

function accountHour(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value
    if (!part) throw new Error(`OpenAI Ads account timezone did not produce a ${type}`)
    return part
  }
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}`
}

/**
 * The account's CURRENT local calendar date. Every provider daily bucket is
 * stamped with one of these (`readable_time`), and so is every stored rollup
 * row, so this is the one value that says which row is the day in progress.
 */
export function accountLocalDate(at: Date, timezone: string): string {
  return formatIsoDateInTimeZone(at.toISOString(), timezone)
}

/**
 * The EXCLUSIVE upper edge of the last CLOSED account-local day: the start of
 * the day `at` falls in.
 *
 * This is the highest edge a ranged call can safely name, and asking for more
 * buys nothing. Captured live on 2026-07-26 (account on `America/New_York`,
 * 12:56 local):
 *
 * - An `until` in the future is refused outright with
 *   `400: time_ranges.end cannot be in the future.` Edges through
 *   `2026-07-26T20` local (the next UTC midnight) were accepted, and
 *   `2026-07-26T21` through a week out were all refused. The next LOCAL
 *   midnight is therefore not a usable edge, and because the refusal is a 400
 *   on the whole call rather than a clamp, reaching for it does not undercount
 *   the sync, it FAILS the sync.
 * - No accepted edge returns the day in progress anyway. The provider reports
 *   a daily bucket only when the range covers that bucket's whole span, and
 *   the open day's bucket ends at the next local midnight. Every accepted
 *   future edge still came back without today, and a range scoped to the open
 *   day alone returned `200` with `count: 0` rather than a partial row.
 *
 * So the ranged call is for closed days, and the day in progress arrives from
 * the unranged call instead (see `readInsightDays`). Landing the edge on the
 * start of the open day rather than the current hour is what keeps those two
 * sources disjoint: the ranged call then structurally cannot return the same
 * date the unranged call supplies, so neither can overwrite the other.
 *
 * `startOfDayHourInTimeZone` resolves the day's first hour that EXISTS: that
 * is hour 00 except in a zone that springs forward AT midnight, which has no
 * hour 00 on the transition day.
 */
function startOfAccountDay(at: Date, timezone: string): string {
  return startOfDayHourInTimeZone(accountLocalDate(at, timezone), timezone)
}

export function trailingAdsInsightHourRange(
  now: Date,
  timezone: string,
  lookbackMs: number = INSIGHTS_LOOKBACK_MS,
): OpenAiAdsInsightHourRange {
  // The live API rejects conversion fields without time_ranges[], so this
  // ranged call is how the sync reads conversions at all. A timezone-aware
  // hour range works across daylight-saving transitions, and the upper edge
  // closes on the account's current local day: everything below it is a
  // finished day, and the day in progress comes from the unranged call.
  // `since` keeps the default 90-day lookback.
  return {
    type: 'hour_range',
    since: accountHour(new Date(now.getTime() - lookbackMs), timezone),
    until: startOfAccountDay(now, timezone),
    timezone,
  }
}

/**
 * The provider hour range for ONE live-delivery insight call.
 *
 * Both ends come from the route's request, never from this process's clock:
 *
 * - `since` is the START of the window's first day in the account's own wall
 *   clock, so that day is a WHOLE day upstream and is comparable with the
 *   whole-day stored rollup it is diffed against. A range that started at the
 *   read instant's local hour made the first day a mid-day slice on the live
 *   side only, which the comparison then reported as drift on every read.
 *   That start is hour 00 on all but one day a year in zones that spring
 *   forward AT midnight, where hour 00 is skipped and naming it would ask the
 *   provider about a wall-clock hour its own calendar never had, so
 *   `startOfDayHourInTimeZone` resolves the day's first hour that exists.
 * - `until` is the START of the account-local day the FROZEN read anchor falls
 *   in, so this range covers the window's CLOSED days and stops there. It may
 *   not reach further: an edge in the future is refused outright (see
 *   `startOfAccountDay`), and no accepted edge returns the open day regardless.
 *   The open day is read separately and unranged, so that the live side and
 *   the stored side both carry it and the comparison does not report a
 *   stored-only day as drift on every read. Deriving the edge from the frozen
 *   anchor pins every insight call in one walk to the identical range more
 *   firmly than an hourly edge did, since this one only moves at local
 *   midnight, so the reported `fetchedAt` describes all of them.
 */
export function liveAdsInsightHourRange(request: {
  startDate: string
  fetchedAtMs: number
  timezone: string
}): OpenAiAdsInsightHourRange {
  return {
    type: 'hour_range',
    since: startOfDayHourInTimeZone(request.startDate, request.timezone),
    until: startOfAccountDay(new Date(request.fetchedAtMs), request.timezone),
    timezone: request.timezone,
  }
}

/**
 * One entity's daily insight rows, from the two calls it takes to get them
 * all. Neither call alone is enough: the ranged one is the only shape that
 * carries conversions and the only one that can bound a window, and the
 * unranged one is the only shape that returns the day in progress.
 *
 * `inProgressDay` is null when the provider has nothing for the open day yet,
 * which is the ordinary state early in a local day and the permanent state for
 * an entity that is not delivering. That is not an error and not a zero: the
 * caller writes no row for it rather than writing an empty one.
 *
 * The unranged call is capped at ONE page. It has no way to bound its window,
 * so a full walk would fetch the entity's entire lifetime on every sync to
 * find one row. Daily buckets come back newest-first (captured), so the open
 * day is on page one. If the provider ever reordered them the open day would
 * drop back out of the sync, which is a visible undercount and the behavior
 * before this change, rather than a wrong number written into a row.
 */
export async function readInsightDays(input: {
  read: (options: OpenAiAdsInsightsOptions) => Promise<OpenAiAdsInsightRow[]>
  rangedFields: readonly string[]
  inProgressFields: readonly string[]
  timeRanges: readonly OpenAiAdsInsightHourRange[]
  inProgressDate: string
}): Promise<{ closedDays: OpenAiAdsInsightRow[]; inProgressDay: OpenAiAdsInsightRow | null }> {
  const [closedDays, unranged] = await Promise.all([
    input.read({ fields: [...input.rangedFields], timeRanges: [...input.timeRanges] }),
    input.read({ fields: [...input.inProgressFields], firstPageOnly: true }),
  ])
  return {
    closedDays,
    inProgressDay: unranged.find((row) => row.readable_time === input.inProgressDate) ?? null,
  }
}

interface AdsSyncOptions {
  config: CanonryConfig
}

interface InsightUpsert {
  level: 'campaign' | 'ad_group'
  entityId: string
  date: string
  impressions: number
  clicks: number
  spendMicros: number
  /**
   * `null` when the provider did not REPORT conversions for this day, which is
   * every reading of the day in progress. Distinct from 0, which is a reported
   * count of none, and the reason the write path leaves the stored column
   * alone rather than stamping a placeholder over it.
   */
  conversions: number | null
}

// The insights API returns spend/cpc as DECIMAL DOLLARS while budgets/bids
// are integer micros — rollups normalize everything to micros at ingest.
function toInsightUpserts(
  level: InsightUpsert['level'],
  entityId: string,
  rows: readonly OpenAiAdsInsightRow[],
  opts: { conversionsReported: boolean },
): InsightUpsert[] {
  const upserts: InsightUpsert[] = []
  for (const row of rows) {
    if (!row.readable_time) {
      log.warn('insights.row-missing-date', { level, entityId, rowId: row.id })
      continue
    }
    upserts.push({
      level,
      entityId,
      date: row.readable_time,
      impressions: row.impressions ?? 0,
      clicks: row.clicks ?? 0,
      spendMicros: dollarsToMicros(row.spend ?? 0),
      conversions: opts.conversionsReported ? Math.round(row.conversions ?? 0) : null,
    })
  }
  return upserts
}

/**
 * Both halves of one entity's read, flattened into rollup upserts. The closed
 * days carry a reported conversion count; the day in progress never does.
 */
function toDailyUpserts(
  level: InsightUpsert['level'],
  entityId: string,
  read: { closedDays: OpenAiAdsInsightRow[]; inProgressDay: OpenAiAdsInsightRow | null },
): InsightUpsert[] {
  return [
    ...toInsightUpserts(level, entityId, read.closedDays, { conversionsReported: true }),
    ...toInsightUpserts(
      level,
      entityId,
      read.inProgressDay ? [read.inProgressDay] : [],
      { conversionsReported: false },
    ),
  ]
}

/**
 * Sync the project's connected OpenAI ad account: entity snapshots
 * (campaigns / ad groups / ads; refreshed campaigns are replaced and campaigns
 * the provider no longer lists are deleted, while a still-listed campaign whose
 * sub-fetch failed keeps its prior row) plus daily
 * paid-performance rollups at campaign and ad-group level (upserted, so
 * re-syncing an in-progress day replaces instead of duplicating).
 *
 * Ad-level insights are deliberately absent until the per-ad insights
 * endpoint has been exercised against a live account.
 */
export async function executeAdsSync(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: AdsSyncOptions,
): Promise<void> {
  const now = new Date().toISOString()
  db.update(runs).set({ status: 'running', startedAt: now }).where(eq(runs.id, runId)).run()

  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error(`Project not found: ${projectId}`)

    const connRow = db.select().from(adsConnections).where(eq(adsConnections.projectId, projectId)).get()
    if (!connRow) {
      throw new Error('No ads connection found for this project. Run "canonry ads connect" first.')
    }
    const cfgConn = getOpenAiAdsConnection(opts.config, project.name)
    if (!cfgConn?.apiKey) {
      throw new Error('No OpenAI Ads API key in the local Canonry config. Run "canonry ads connect" first.')
    }
    const apiKey = cfgConn.apiKey

    log.info('sync.start', { runId, projectId, adAccountId: connRow.adAccountId })

    // All async I/O happens before the write transaction (better-sqlite3
    // transactions must be synchronous). Per-campaign failures are collected
    // so one bad campaign degrades the run to partial instead of failed.
    const account = await getAdAccount(apiKey)
    const campaigns = await listCampaigns(apiKey)
    // One anchor for the whole walk: the range and the "which date is still
    // open" question must agree, or a walk that crosses local midnight would
    // ask for closed days up to one date and look for the open day at another.
    const insightAnchor = new Date()
    const insightTimeRanges = [trailingAdsInsightHourRange(insightAnchor, account.timezone)]
    const inProgressDate = accountLocalDate(insightAnchor, account.timezone)

    const errors = new Map<string, string>()
    const adGroupsByCampaign = new Map<string, OpenAiAdsAdGroup[]>()
    const adsByGroup = new Map<string, OpenAiAdsAd[]>()
    const insightUpserts: InsightUpsert[] = []
    const syncedCampaigns: OpenAiAdsCampaign[] = []

    for (const campaign of campaigns) {
      try {
        const [adGroups, campaignInsights] = await Promise.all([
          listAdGroups(apiKey, campaign.id),
          readInsightDays({
            read: (options) => getCampaignInsights(apiKey, campaign.id, options),
            rangedFields: CAMPAIGN_INSIGHT_FIELDS,
            inProgressFields: CAMPAIGN_IN_PROGRESS_INSIGHT_FIELDS,
            timeRanges: insightTimeRanges,
            inProgressDate,
          }),
        ])
        const groupResults = await Promise.all(adGroups.map(async (group) => ({
          group,
          ads: await listAds(apiKey, group.id),
          insights: await readInsightDays({
            read: (options) => getAdGroupInsights(apiKey, group.id, options),
            rangedFields: AD_GROUP_INSIGHT_FIELDS,
            inProgressFields: AD_GROUP_IN_PROGRESS_INSIGHT_FIELDS,
            timeRanges: insightTimeRanges,
            inProgressDate,
          }),
        })))

        syncedCampaigns.push(campaign)
        adGroupsByCampaign.set(campaign.id, adGroups)
        insightUpserts.push(...toDailyUpserts('campaign', campaign.id, campaignInsights))
        for (const { group, ads, insights } of groupResults) {
          adsByGroup.set(group.id, ads)
          insightUpserts.push(...toDailyUpserts('ad_group', group.id, insights))
        }
      } catch (err) {
        errors.set(campaign.name, describeError(err))
        log.error('campaign.failed', { runId, campaignId: campaign.id, error: describeError(err) })
      }
    }

    // Conversion tracking is configured at the campaign level: a campaign
    // carries one or more conversion_event_setting_ids once the operator wires
    // up an OpenAI conversion pixel / CAPI event. Detect it from the full
    // campaign list (the field rides the campaign object regardless of whether
    // that campaign's insight fetch succeeded), so the account-level flag is
    // not lost to a single failed per-campaign sync.
    const conversionTrackingConfigured = campaigns.some(
      (c) => (c.conversion_event_setting_ids?.length ?? 0) > 0,
    )

    const insertNow = new Date().toISOString()
    // `listCampaigns` is the authority on which campaigns still exist: it runs
    // outside the per-campaign try, so reaching here means the provider
    // answered it. A campaign missing from that list is genuinely gone
    // upstream; a campaign present in it whose sub-fetch threw is merely
    // unrefreshed this cycle.
    const upstreamIds = campaigns.map((c) => c.id)
    const refreshedIds = syncedCampaigns.map((c) => c.id)
    db.transaction((tx) => {
      // Replace the snapshots we refreshed, and drop the ones the provider no
      // longer lists. Deleting a campaign cascades through its ad groups and
      // ads, so upstream-deleted entities disappear locally too. Insights rows
      // are NOT wiped — history must survive entity churn; they upsert on
      // (project, level, entity, date).
      //
      // A campaign the provider still lists but whose insight or ad-group
      // fetch failed KEEPS its existing row. Dropping it would turn one
      // transient provider error into "this workspace has no campaigns" on
      // every read until the next successful sync, which is a worse lie than
      // one stale row. Its untouched `syncedAt` is the staleness signal.
      tx.delete(adsCampaigns)
        .where(upstreamIds.length === 0
          ? eq(adsCampaigns.projectId, projectId)
          : and(eq(adsCampaigns.projectId, projectId), notInArray(adsCampaigns.id, upstreamIds)))
        .run()
      if (refreshedIds.length > 0) {
        tx.delete(adsCampaigns)
          .where(and(eq(adsCampaigns.projectId, projectId), inArray(adsCampaigns.id, refreshedIds)))
          .run()
      }

      for (const campaign of syncedCampaigns) {
        tx.insert(adsCampaigns).values({
          id: campaign.id,
          projectId,
          name: campaign.name,
          description: campaign.description ?? null,
          status: campaign.status,
          startTime: campaign.start_time ?? null,
          endTime: campaign.end_time ?? null,
          biddingType: campaign.bidding_type,
          dailySpendLimitMicros: campaign.budget?.daily_spend_limit_micros ?? null,
          lifetimeSpendLimitMicros: campaign.budget?.lifetime_spend_limit_micros ?? null,
          conversionEventSettingIds: campaign.conversion_event_setting_ids ?? [],
          targeting: campaign.targeting,
          upstreamCreatedAt: campaign.created_at,
          upstreamUpdatedAt: campaign.updated_at,
          syncRunId: runId,
          syncedAt: insertNow,
        }).run()

        for (const group of adGroupsByCampaign.get(campaign.id) ?? []) {
          tx.insert(adsAdGroups).values({
            id: group.id,
            projectId,
            campaignId: campaign.id,
            name: group.name,
            description: group.description ?? null,
            status: group.status,
            billingEventType: group.bidding_config?.billing_event_type ?? null,
            maxBidMicros: group.bidding_config?.max_bid_micros ?? null,
            contextHints: group.context_hints,
            upstreamCreatedAt: group.created_at,
            upstreamUpdatedAt: group.updated_at,
            syncRunId: runId,
            syncedAt: insertNow,
          }).run()

          for (const ad of adsByGroup.get(group.id) ?? []) {
            tx.insert(adsAds).values({
              id: ad.id,
              projectId,
              adGroupId: group.id,
              name: ad.name,
              status: ad.status,
              creative: ad.creative,
              reviewStatus: ad.review_status ?? ad.review?.status ?? null,
              upstreamCreatedAt: ad.created_at,
              upstreamUpdatedAt: ad.updated_at,
              syncRunId: runId,
              syncedAt: insertNow,
            }).run()
          }
        }
      }

      for (const upsert of insightUpserts) {
        tx.insert(adsInsightsDaily).values({
          id: crypto.randomUUID(),
          projectId,
          level: upsert.level,
          entityId: upsert.entityId,
          date: upsert.date,
          impressions: upsert.impressions,
          clicks: upsert.clicks,
          spendMicros: upsert.spendMicros,
          // A day whose conversions the provider will not report yet starts at
          // the column default. The first sync after that day closes reads it
          // from the ranged call and fills it in.
          conversions: upsert.conversions ?? 0,
          syncRunId: runId,
        }).onConflictDoUpdate({
          target: [adsInsightsDaily.projectId, adsInsightsDaily.level, adsInsightsDaily.entityId, adsInsightsDaily.date],
          set: {
            impressions: upsert.impressions,
            clicks: upsert.clicks,
            spendMicros: upsert.spendMicros,
            // Only written when the provider actually reported a count.
            // Stamping a placeholder over a stored figure would turn a number
            // this read could not obtain into a number that is simply wrong.
            ...(upsert.conversions === null ? {} : { conversions: upsert.conversions }),
            syncRunId: runId,
          },
        }).run()
      }

      // Account metadata came from calls that succeeded, so it always lands.
      // `lastSyncedAt` is different: it dates the ENTITY snapshot, and since a
      // wholly failed refresh now leaves the previous rows in place, advancing
      // it would date stale rows to the failed attempt and let the delivery
      // diagnostics read them as complete and current. Hold it back when the
      // cycle refreshed nothing. An account with genuinely no campaigns
      // records no errors and still advances.
      const entitySnapshotRefreshed = errors.size === 0 || syncedCampaigns.length > 0
      tx.update(adsConnections).set({
        adAccountId: account.id,
        displayName: account.name,
        currencyCode: account.currency_code,
        timezone: account.timezone,
        status: account.status,
        reviewStatus: account.review?.status ?? null,
        integrityReviewStatus: account.account_integrity_review?.review?.status ?? null,
        integrityDecision: account.account_integrity_review?.details?.decision ?? null,
        conversionTrackingConfigured,
        ...(entitySnapshotRefreshed ? { lastSyncedAt: insertNow } : {}),
        updatedAt: insertNow,
      }).where(eq(adsConnections.projectId, projectId)).run()
    })

    const finishedAt = new Date().toISOString()
    if (errors.size === 0) {
      db.update(runs).set({ status: 'completed', finishedAt }).where(eq(runs.id, runId)).run()
    } else if (syncedCampaigns.length > 0) {
      db.update(runs).set({
        status: 'partial',
        error: serializeRunError(buildRunErrorFromMessages(errors)),
        finishedAt,
      }).where(eq(runs.id, runId)).run()
    } else {
      db.update(runs).set({
        status: 'failed',
        error: serializeRunError(buildRunErrorFromMessages(errors)),
        finishedAt,
      }).where(eq(runs.id, runId)).run()
    }

    log.info('sync.done', { runId, projectId, campaigns: syncedCampaigns.length, insightRows: insightUpserts.length, failed: errors.size })
  } catch (err) {
    const errorMsg = describeError(err)
    db.update(runs)
      .set({ status: 'failed', error: serializeRunError({ message: errorMsg }), finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()
    log.error('sync.failed', { runId, projectId, error: errorMsg })
    throw err
  }
}
