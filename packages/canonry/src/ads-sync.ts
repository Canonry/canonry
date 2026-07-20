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

const CAMPAIGN_INSIGHT_FIELDS = ['campaign.impressions', 'campaign.clicks', 'campaign.spend', 'campaign.conversions', 'metadata.readable_time']
const AD_GROUP_INSIGHT_FIELDS = ['ad_group.impressions', 'ad_group.clicks', 'ad_group.spend', 'ad_group.conversions', 'metadata.readable_time']

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
  conversions: number
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
      conversions: Math.round(row.conversions ?? 0),
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

    const errors = new Map<string, string>()
    const adGroupsByCampaign = new Map<string, OpenAiAdsAdGroup[]>()
    const adsByGroup = new Map<string, OpenAiAdsAd[]>()
    const insightUpserts: InsightUpsert[] = []
    const syncedCampaigns: OpenAiAdsCampaign[] = []

    for (const campaign of campaigns) {
      try {
        const [adGroups, campaignInsights] = await Promise.all([
          listAdGroups(apiKey, campaign.id),
          getCampaignInsights(apiKey, campaign.id, { fields: CAMPAIGN_INSIGHT_FIELDS }),
        ])
        const groupResults = await Promise.all(adGroups.map(async (group) => ({
          group,
          ads: await listAds(apiKey, group.id),
          insights: await getAdGroupInsights(apiKey, group.id, { fields: AD_GROUP_INSIGHT_FIELDS }),
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
          ...upsert,
          syncRunId: runId,
        }).onConflictDoUpdate({
          target: [adsInsightsDaily.projectId, adsInsightsDaily.level, adsInsightsDaily.entityId, adsInsightsDaily.date],
          set: {
            impressions: upsert.impressions,
            clicks: upsert.clicks,
            spendMicros: upsert.spendMicros,
            conversions: upsert.conversions,
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
        reviewStatus: account.review?.status ?? null,
        integrityReviewStatus: account.account_integrity_review?.review?.status ?? null,
        integrityDecision: account.account_integrity_review?.details?.decision ?? null,
        conversionTrackingConfigured,
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
