import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, adsConnections, adsCampaigns, adsAdGroups, adsAds, adsInsightsDaily } from '@ainyc/canonry-db'
import { buildRunErrorFromMessages, serializeRunError, dollarsToMicros } from '@ainyc/canonry-contracts'
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
  OpenAiAdsInsightRow,
} from '@ainyc/canonry-integration-openai-ads'
import type { CanonryConfig } from './config.js'
import { getOpenAiAdsConnection } from './ads-config.js'
import { createLogger } from './logger.js'

const log = createLogger('AdsSync')

const CAMPAIGN_INSIGHT_FIELDS = ['campaign.impressions', 'campaign.clicks', 'campaign.spend', 'metadata.readable_time']
const AD_GROUP_INSIGHT_FIELDS = ['ad_group.impressions', 'ad_group.clicks', 'ad_group.spend', 'metadata.readable_time']

// Re-pull a trailing window every run, not just new days. The last 1-2 days
// under-report (reporting lag) and finalize on a later sync — which is exactly
// why insights upsert on (project, level, entity, date) rather than append.
const ADS_INSIGHTS_TRAILING_DAYS = 28

interface AdsSyncOptions {
  config: CanonryConfig
}

/**
 * Today as YYYY-MM-DD in the account timezone, so the window aligns with the
 * `readable_time` day the API keys rows on. Falls back to UTC when the timezone
 * is absent or not an IANA zone.
 */
function todayInTimezone(timezone: string | null | undefined): string {
  if (timezone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date())
    } catch {
      // not an IANA zone — fall through to UTC
    }
  }
  return new Date().toISOString().slice(0, 10)
}

/** Trailing window of `days` ending (inclusive) on `today` (YYYY-MM-DD). */
function trailingWindow(today: string, days: number): { startDate: string; endDate: string } {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (days - 1))
  return { startDate: d.toISOString().slice(0, 10), endDate: today }
}

interface InsightUpsert {
  level: 'campaign' | 'ad_group'
  entityId: string
  date: string
  impressions: number
  clicks: number
  spendMicros: number
}

// The insights API returns spend/cpc as DECIMAL DOLLARS while budgets/bids
// are integer micros — rollups normalize everything to micros at ingest.
function toInsightUpserts(level: InsightUpsert['level'], entityId: string, rows: OpenAiAdsInsightRow[]): InsightUpsert[] {
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
    })
  }
  return upserts
}

/**
 * Sync the project's connected OpenAI ad account: entity snapshots
 * (campaigns / ad groups / ads, range-replaced per project) plus daily
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

    // Trailing insights window in the account timezone (settles lagging days).
    const insightsWindow = trailingWindow(todayInTimezone(account.timezone), ADS_INSIGHTS_TRAILING_DAYS)

    const errors = new Map<string, string>()
    const adGroupsByCampaign = new Map<string, OpenAiAdsAdGroup[]>()
    const adsByGroup = new Map<string, OpenAiAdsAd[]>()
    const insightUpserts: InsightUpsert[] = []
    const syncedCampaigns: OpenAiAdsCampaign[] = []

    for (const campaign of campaigns) {
      try {
        const [adGroups, campaignInsights] = await Promise.all([
          listAdGroups(apiKey, campaign.id),
          getCampaignInsights(apiKey, campaign.id, { fields: CAMPAIGN_INSIGHT_FIELDS, ...insightsWindow }),
        ])
        const groupResults = await Promise.all(adGroups.map(async (group) => ({
          group,
          ads: await listAds(apiKey, group.id),
          insights: await getAdGroupInsights(apiKey, group.id, { fields: AD_GROUP_INSIGHT_FIELDS, ...insightsWindow }),
        })))

        syncedCampaigns.push(campaign)
        adGroupsByCampaign.set(campaign.id, adGroups)
        insightUpserts.push(...toInsightUpserts('campaign', campaign.id, campaignInsights))
        for (const { group, ads, insights } of groupResults) {
          adsByGroup.set(group.id, ads)
          insightUpserts.push(...toInsightUpserts('ad_group', group.id, insights))
        }
      } catch (err) {
        errors.set(campaign.name, err instanceof Error ? err.message : String(err))
        log.error('campaign.failed', { runId, campaignId: campaign.id, error: err instanceof Error ? err.message : String(err) })
      }
    }

    const insertNow = new Date().toISOString()
    db.transaction((tx) => {
      // Range-replace entity snapshots for the project. Deleting campaigns
      // cascades through ad groups and ads, so upstream-deleted entities
      // disappear locally too. Insights rows are NOT wiped — history must
      // survive entity churn; they upsert on (project, level, entity, date).
      // On a partial sync (some campaigns failed) the failed campaigns'
      // snapshots are intentionally dropped this cycle rather than kept
      // stale — the next successful sync restores them.
      tx.delete(adsCampaigns).where(eq(adsCampaigns.projectId, projectId)).run()

      for (const campaign of syncedCampaigns) {
        tx.insert(adsCampaigns).values({
          id: campaign.id,
          projectId,
          name: campaign.name,
          status: campaign.status,
          biddingType: campaign.bidding_type,
          dailySpendLimitMicros: campaign.budget?.daily_spend_limit_micros ?? null,
          lifetimeSpendLimitMicros: campaign.budget?.lifetime_spend_limit_micros ?? null,
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
            status: group.status,
            billingEventType: group.bidding_config?.billing_event_type ?? null,
            maxBidMicros: group.bidding_config?.max_bid_micros ?? null,
            // context_hints arrives as an array whose single element is a
            // \n-joined block of example queries; split into individual lines
            // so every consumer (DTO, MCP, overlap matcher) sees the real
            // hint count, not an array length of 1.
            contextHints: (group.context_hints ?? []).flatMap((h) => h.split('\n')).map((s) => s.trim()).filter(Boolean),
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
          ...upsert,
          syncRunId: runId,
        }).onConflictDoUpdate({
          target: [adsInsightsDaily.projectId, adsInsightsDaily.level, adsInsightsDaily.entityId, adsInsightsDaily.date],
          set: {
            impressions: upsert.impressions,
            clicks: upsert.clicks,
            spendMicros: upsert.spendMicros,
            syncRunId: runId,
          },
        }).run()
      }

      tx.update(adsConnections).set({
        adAccountId: account.id,
        displayName: account.name,
        currencyCode: account.currency_code,
        timezone: account.timezone,
        status: account.status,
        lastSyncedAt: insertNow,
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
    const errorMsg = err instanceof Error ? err.message : String(err)
    db.update(runs)
      .set({ status: 'failed', error: serializeRunError({ message: errorMsg }), finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()
    log.error('sync.failed', { runId, projectId, error: errorMsg })
    throw err
  }
}
