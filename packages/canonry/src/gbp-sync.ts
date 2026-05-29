import crypto from 'node:crypto'
import { eq, and, desc, inArray, lt } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, gbpLocations, gbpDailyMetrics, gbpKeywordImpressions, gbpKeywordMonthly, gbpPlaceActions, gbpLodgingSnapshots, gbpPlaceDetails } from '@ainyc/canonry-db'
import { buildRunErrorFromMessages, serializeRunError } from '@ainyc/canonry-contracts'
import { refreshAccessToken } from '@ainyc/canonry-integration-google'
import {
  fetchDailyMetrics,
  listMonthlyKeywords,
  listPlaceActionLinks,
  getLodging,
  countPopulatedGroups,
  hashLodging,
  GBP_DAILY_METRICS,
} from '@ainyc/canonry-integration-google-business-profile'
import { getPlaceDetails, hashPlaceDetails } from '@ainyc/canonry-integration-google-places'
import type { CanonryConfig } from './config.js'
import { saveConfigPatch } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection, patchGoogleConnection } from './google-config.js'
import { getPlacesConfig } from './places-config.js'
import { createLogger } from './logger.js'

const MS_PER_DAY = 86_400_000

const log = createLogger('GbpSync')

// How many locations to pull concurrently. Each location issues ~4 + a few
// calls (daily metrics + trailing-window keywords + KEYWORD_TREND_MONTHS
// per-month keyword calls + place actions + lodging), spread across four
// different API hosts that each have their own 300 QPM cap; 4 locations in
// flight keeps every host well under its cap even for large chains.
const LOCATION_CONCURRENCY = 4
const DEFAULT_DAYS_OF_METRICS = 30
const DEFAULT_MONTHS_OF_KEYWORDS = 12
// How many recent COMPLETE months of per-month keyword impressions to fetch
// each sync for the accumulating monthly series (gbp_keyword_monthly). The
// monthly endpoint returns one aggregate per range, so a real month series
// needs one call per month — we fetch the last few complete months and let
// history build up across syncs. Two are enough for a month-over-month drop;
// three gives a small buffer.
const KEYWORD_TREND_MONTHS = 3
// Drop monthly keyword rows older than this many months so the accumulate
// table stays bounded.
const KEYWORD_HISTORY_RETENTION_MONTHS = 18

function daysAgo(n: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

function monthMinus(n: number): { year: number; month: number } {
  const d = new Date()
  // Anchor to day 1 BEFORE shifting months. Subtracting months while keeping
  // the day-of-month overflows when the target month is shorter (e.g. on the
  // 29th–31st, month-2 can land in the following month), which would otherwise
  // yield duplicate or skipped months in the per-month keyword series.
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - n)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
}

interface GbpSyncOptions {
  locationNames?: string[]
  daysOfMetrics?: number
  monthsOfKeywords?: number
  config: CanonryConfig
}

/**
 * Sync GBP performance data (daily metrics + monthly keyword impressions) for
 * a project's selected locations. Reviews and Q&A are intentionally absent:
 * the v4 reviews API is separately access-gated by Google, and the Q&A API was
 * retired. Each location is range-replaced so re-runs don't duplicate.
 */
export async function executeGbpSync(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: GbpSyncOptions,
): Promise<void> {
  const now = new Date().toISOString()
  db.update(runs).set({ status: 'running', startedAt: now }).where(eq(runs.id, runId)).run()

  try {
    const { clientId, clientSecret } = getGoogleAuthConfig(opts.config)
    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth is not configured in the local Canonry config')
    }

    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error(`Project not found: ${projectId}`)

    const conn = getGoogleConnection(opts.config, project.canonicalDomain, 'gbp')
    if (!conn || !conn.refreshToken) {
      throw new Error('No GBP connection found or connection is incomplete. Run "canonry gbp connect" first.')
    }

    // Refresh the access token if it's within 5 minutes of expiry.
    let accessToken = conn.accessToken!
    const expiresAt = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() : 0
    if (Date.now() > expiresAt - 5 * 60 * 1000) {
      const tokens = await refreshAccessToken(clientId, clientSecret, conn.refreshToken)
      accessToken = tokens.access_token
      patchGoogleConnection(opts.config, project.canonicalDomain, 'gbp', {
        accessToken: tokens.access_token,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      })
      saveConfigPatch(opts.config)
    }

    // Resolve which locations to sync: selected rows, optionally narrowed to
    // an explicit locationNames subset (used for retrying a failed location).
    let locationRows = db.select().from(gbpLocations)
      .where(and(eq(gbpLocations.projectId, projectId), eq(gbpLocations.selected, true)))
      .all()
    if (opts.locationNames?.length) {
      const wanted = new Set(opts.locationNames)
      locationRows = locationRows.filter((l) => wanted.has(l.locationName))
    }

    if (locationRows.length === 0) {
      throw new Error('No selected GBP locations to sync. Discover and select locations first.')
    }

    const daysOfMetrics = opts.daysOfMetrics ?? DEFAULT_DAYS_OF_METRICS
    const monthsOfKeywords = opts.monthsOfKeywords ?? DEFAULT_MONTHS_OF_KEYWORDS
    const metricsStart = daysAgo(daysOfMetrics)
    const metricsEnd = daysAgo(1) // performance data lags ~1 day
    const keywordsStart = monthMinus(monthsOfKeywords)
    const keywordsEnd = monthMinus(0)
    // The last N COMPLETE months (monthMinus(0) is the in-progress current
    // month, so we start at monthMinus(1)) for the accumulating monthly series.
    const trendMonths = Array.from({ length: KEYWORD_TREND_MONTHS }, (_, i) => monthMinus(i + 1))
    const keywordRetentionCutoff = monthKey(monthMinus(KEYWORD_HISTORY_RETENTION_MONTHS))

    // Resolved Places config (key + tier + refresh cadence). Enrichment is
    // gated per-location below; when disabled or unconfigured the sync behaves
    // exactly as before.
    const { apiKey: placesApiKey, tier: placesTier, refreshIntervalDays: placesRefreshDays } = getPlacesConfig(opts.config)

    log.info('sync.start', { runId, projectId, locations: locationRows.length, daysOfMetrics, monthsOfKeywords })

    const errors = new Map<string, string>()
    let okCount = 0

    // Process locations in bounded-concurrency batches.
    for (let i = 0; i < locationRows.length; i += LOCATION_CONCURRENCY) {
      const batch = locationRows.slice(i, i + LOCATION_CONCURRENCY)
      await Promise.all(batch.map(async (loc) => {
        try {
          const [metricRows, keywordRows, placeActionRows, lodging, monthlyKeywordResults] = await Promise.all([
            fetchDailyMetrics(accessToken, loc.locationName, {
              metrics: GBP_DAILY_METRICS,
              startDate: metricsStart,
              endDate: metricsEnd,
            }),
            listMonthlyKeywords(accessToken, loc.locationName, {
              startMonth: keywordsStart,
              endMonth: keywordsEnd,
            }),
            listPlaceActionLinks(accessToken, loc.locationName),
            // null when the location is not a lodging-category property.
            getLodging(accessToken, loc.locationName),
            // Per-month keyword impressions for the accumulating monthly series.
            // One call per complete month (the endpoint aggregates a range into
            // a single figure, so month resolution requires month-sized calls).
            Promise.all(trendMonths.map(async (m) => ({
              month: monthKey(m),
              rows: await listMonthlyKeywords(accessToken, loc.locationName, { startMonth: m, endMonth: m }),
            }))),
          ])

          // Lodging snapshot-on-change: only insert a new row when the content
          // hash differs from the latest stored snapshot for this location.
          const lodgingHash = lodging ? hashLodging(lodging) : null
          const latestLodging = lodging
            ? db.select().from(gbpLodgingSnapshots)
                .where(and(eq(gbpLodgingSnapshots.projectId, projectId), eq(gbpLodgingSnapshots.locationName, loc.locationName)))
                .orderBy(desc(gbpLodgingSnapshots.syncedAt))
                .limit(1)
                .get()
            : undefined
          const lodgingChanged = lodging !== null && latestLodging?.contentHash !== lodgingHash

          // Places (New) enrichment — supplemental rendered-listing data, only
          // for lodging-capable locations that carry a Maps placeId. A refresh
          // cadence gate avoids re-fetching (and re-billing) unchanged hotels;
          // snapshot-on-change avoids storing duplicate rows. Best-effort: a
          // Places error is logged and skipped so it never fails the run.
          let placeToWrite: { contentHash: string; attributes: Record<string, unknown>; tier: string; placeId: string } | null = null
          // Id of the existing latest snapshot to re-stamp when a fetch returns
          // unchanged content. `syncedAt` doubles as the last-fetched marker the
          // cadence gate reads, so it MUST advance on every fetch — not only on
          // a content change — or a listing that stays stable past the interval
          // would be re-fetched (and re-billed) on every subsequent sync.
          let placeToTouch: string | null = null
          if (placesTier !== 'off' && placesApiKey && lodging !== null && loc.placeId) {
            const latestPlace = db.select().from(gbpPlaceDetails)
              .where(and(eq(gbpPlaceDetails.projectId, projectId), eq(gbpPlaceDetails.locationName, loc.locationName)))
              .orderBy(desc(gbpPlaceDetails.syncedAt))
              .limit(1)
              .get()
            const ageDays = latestPlace ? (Date.now() - new Date(latestPlace.syncedAt).getTime()) / MS_PER_DAY : Infinity
            if (ageDays >= placesRefreshDays) {
              try {
                const place = await getPlaceDetails(loc.placeId, placesApiKey, { tier: placesTier })
                const hash = hashPlaceDetails(place)
                if (!latestPlace || latestPlace.contentHash !== hash) {
                  placeToWrite = { contentHash: hash, attributes: place as Record<string, unknown>, tier: placesTier, placeId: loc.placeId }
                } else {
                  placeToTouch = latestPlace.id
                }
              } catch (placesErr) {
                log.warn('places.failed', { runId, location: loc.locationName, error: placesErr instanceof Error ? placesErr.message : String(placesErr) })
              }
            }
          }

          const insertNow = new Date().toISOString()
          // Range-replace the per-sync surfaces for this location in one
          // transaction so a re-sync never leaves stale or duplicate rows.
          db.transaction((tx) => {
            tx.delete(gbpDailyMetrics)
              .where(and(eq(gbpDailyMetrics.projectId, projectId), eq(gbpDailyMetrics.locationName, loc.locationName)))
              .run()
            for (const row of metricRows) {
              tx.insert(gbpDailyMetrics).values({
                id: crypto.randomUUID(),
                projectId,
                locationName: loc.locationName,
                date: row.date,
                metric: row.metric,
                value: row.value,
                syncRunId: runId,
              }).run()
            }

            tx.delete(gbpKeywordImpressions)
              .where(and(eq(gbpKeywordImpressions.projectId, projectId), eq(gbpKeywordImpressions.locationName, loc.locationName)))
              .run()
            for (const row of keywordRows) {
              tx.insert(gbpKeywordImpressions).values({
                id: crypto.randomUUID(),
                projectId,
                locationName: loc.locationName,
                periodStart: monthKey(keywordsStart),
                periodEnd: monthKey(keywordsEnd),
                keyword: row.keyword,
                valueCount: row.valueCount,
                valueThreshold: row.valueThreshold,
                syncRunId: runId,
              }).run()
            }

            // Keyword monthly series — ACCUMULATE (do not wipe the location's
            // whole history like the surfaces above). Replace only the months
            // we just fetched (idempotent re-sync), leave older in-retention
            // months in place, then prune anything past the retention window.
            const fetchedMonths = monthlyKeywordResults.map((r) => r.month)
            if (fetchedMonths.length > 0) {
              tx.delete(gbpKeywordMonthly)
                .where(and(
                  eq(gbpKeywordMonthly.projectId, projectId),
                  eq(gbpKeywordMonthly.locationName, loc.locationName),
                  inArray(gbpKeywordMonthly.month, fetchedMonths),
                ))
                .run()
              for (const { month, rows } of monthlyKeywordResults) {
                for (const row of rows) {
                  tx.insert(gbpKeywordMonthly).values({
                    id: crypto.randomUUID(),
                    projectId,
                    locationName: loc.locationName,
                    month,
                    keyword: row.keyword,
                    valueCount: row.valueCount,
                    valueThreshold: row.valueThreshold,
                    syncRunId: runId,
                    syncedAt: insertNow,
                  }).run()
                }
              }
              tx.delete(gbpKeywordMonthly)
                .where(and(
                  eq(gbpKeywordMonthly.projectId, projectId),
                  eq(gbpKeywordMonthly.locationName, loc.locationName),
                  lt(gbpKeywordMonthly.month, keywordRetentionCutoff),
                ))
                .run()
            }

            tx.delete(gbpPlaceActions)
              .where(and(eq(gbpPlaceActions.projectId, projectId), eq(gbpPlaceActions.locationName, loc.locationName)))
              .run()
            for (const row of placeActionRows) {
              tx.insert(gbpPlaceActions).values({
                id: crypto.randomUUID(),
                projectId,
                locationName: loc.locationName,
                placeActionLinkName: row.placeActionLinkName,
                placeActionType: row.placeActionType,
                uri: row.uri,
                isPreferred: row.isPreferred,
                providerType: row.providerType,
                syncRunId: runId,
              }).run()
            }

            // Lodging: append a new snapshot only when the profile changed
            // (hotel attributes change rarely — don't store a row per sync).
            if (lodging !== null && lodgingChanged) {
              tx.insert(gbpLodgingSnapshots).values({
                id: crypto.randomUUID(),
                projectId,
                locationName: loc.locationName,
                contentHash: lodgingHash!,
                attributes: lodging,
                populatedGroupCount: countPopulatedGroups(lodging),
                syncedAt: insertNow,
                syncRunId: runId,
              }).run()
            }

            // Places: append a new rendered-listing snapshot when the Place
            // Details content changed; otherwise re-stamp the existing latest
            // row so `syncedAt` records this fetch and the cadence gate can
            // throttle the next sync (decided above, gated + cadenced).
            if (placeToWrite) {
              tx.insert(gbpPlaceDetails).values({
                id: crypto.randomUUID(),
                projectId,
                locationName: loc.locationName,
                placeId: placeToWrite.placeId,
                contentHash: placeToWrite.contentHash,
                tier: placeToWrite.tier,
                attributes: placeToWrite.attributes,
                syncedAt: insertNow,
                syncRunId: runId,
              }).run()
            } else if (placeToTouch) {
              tx.update(gbpPlaceDetails)
                .set({ syncedAt: insertNow, syncRunId: runId })
                .where(eq(gbpPlaceDetails.id, placeToTouch))
                .run()
            }

            tx.update(gbpLocations)
              .set({ syncedAt: insertNow, updatedAt: insertNow })
              .where(eq(gbpLocations.id, loc.id))
              .run()
          })
          okCount++
        } catch (err) {
          errors.set(loc.locationName, err instanceof Error ? err.message : String(err))
          log.error('location.failed', { runId, location: loc.locationName, error: err instanceof Error ? err.message : String(err) })
        }
      }))
    }

    const finishedAt = new Date().toISOString()
    if (errors.size === 0) {
      db.update(runs).set({ status: 'completed', finishedAt }).where(eq(runs.id, runId)).run()
    } else if (okCount > 0) {
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

    log.info('sync.done', { runId, projectId, ok: okCount, failed: errors.size })
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

// The monthly-keywords endpoint aggregates the whole requested range into one
// figure per keyword (it does not break the count down by month), so each row
// records the trailing window via periodStart / periodEnd (both YYYY-MM).
function monthKey(m: { year: number; month: number }): string {
  return `${m.year}-${String(m.month).padStart(2, '0')}`
}
