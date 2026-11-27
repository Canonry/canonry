import crypto from 'node:crypto'
import { eq, and, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import { runs, projects, gscSearchData, gscDailyTotals, gscQueryDailyTotals, gscDataWatermarks, gscSitemaps, sitemapListSyncs } from '@canonry/canonry-db'
import {
  fetchSearchAnalytics,
  listSitemaps,
  refreshAccessToken,
  GSC_DATA_LAG_DAYS,
  GSC_REPORTING_TIME_ZONE,
  type GscSitemap,
} from '@canonry/canonry-integration-google'
import { formatIsoDateInTimeZone, shiftIsoCalendarDate, describeError, FeatureNames, OutcomeReasonCodes, OutcomeStatuses } from '@canonry/canonry-contracts'
import type { CanonryConfig } from './config.js'
import { saveConfigPatch } from './config.js'
import { writeCoverageSnapshot } from './gsc-coverage-snapshot.js'
import { getGoogleAuthConfig, getGoogleConnection, patchGoogleConnection } from './google-config.js'
import { createLogger } from './logger.js'
import { googleRunFailure, startRunOutcome, withOutcomeReason } from './sync-outcome.js'

const log = createLogger('GscSync')

// `formatDate` / `daysAgo` were the UTC-calendar helpers this file used to
// bound its fetch window. Both are gone: GSC reports on the Pacific calendar,
// so the bounds now come from `formatIsoDateInTimeZone` +
// `shiftIsoCalendarDate`, which step real calendar dates in the right zone.

/**
 * Sitemap indexes whose files one sync reads. Each is one more Search Console
 * call; an index past the cap keeps the files a previous sync stored.
 */
export const GSC_SITEMAP_INDEX_MAX_PER_SYNC = 20

function countOrNull(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The URLs a sitemap lists, summed over Google's content types, or null when Google sent none. */
function gscSitemapUrlCount(sitemap: GscSitemap): number | null {
  if (!sitemap.contents || sitemap.contents.length === 0) return null
  return sitemap.contents.reduce((sum, content) => sum + (countOrNull(content.submitted) ?? 0), 0)
}

/**
 * Store the property's sitemaps, and the files inside each index, so the
 * dashboard and agents read them without a live call. Rows Google no longer
 * lists are removed, except the files of an index this sync did not reach.
 */
export async function syncGscSitemaps(
  db: DatabaseClient,
  projectId: string,
  runId: string,
  accessToken: string,
  propertyId: string,
): Promise<{ sitemaps: number; indexesRead: number }> {
  const top = await listSitemaps(accessToken, propertyId)
  const indexes = top.filter((sitemap) => sitemap.isSitemapsIndex)
  const read = indexes.slice(0, GSC_SITEMAP_INDEX_MAX_PER_SYNC)
  const files = new Map<string, GscSitemap[]>()
  for (const index of read) files.set(index.path, await listSitemaps(accessToken, propertyId, index.path))

  const syncedAt = new Date().toISOString()
  const toRow = (sitemap: GscSitemap, parentUrl: string | null) => ({
    projectId,
    url: sitemap.path,
    parentUrl,
    isIndex: Boolean(sitemap.isSitemapsIndex),
    isPending: Boolean(sitemap.isPending),
    type: sitemap.type ?? null,
    urlCount: gscSitemapUrlCount(sitemap),
    warnings: countOrNull(sitemap.warnings),
    errors: countOrNull(sitemap.errors),
    submittedAt: sitemap.lastSubmitted ?? null,
    lastDownloadedAt: sitemap.lastDownloaded ?? null,
    syncRunId: runId,
    syncedAt,
  })
  const rows = [
    ...top.map((sitemap) => toRow(sitemap, null)),
    ...[...files.entries()].flatMap(([parent, children]) => children.map((child) => toRow({ ...child, isSitemapsIndex: false }, parent))),
  ]
  // A file listed both on its own and inside an index is one sitemap; keep its top-level row.
  const byUrl = new Map<string, (typeof rows)[number]>()
  for (const row of rows) if (!byUrl.has(row.url)) byUrl.set(row.url, row)
  const unread = new Set(indexes.slice(GSC_SITEMAP_INDEX_MAX_PER_SYNC).map((index) => index.path))

  db.transaction((tx) => {
    const stored = tx.select({ url: gscSitemaps.url, parentUrl: gscSitemaps.parentUrl }).from(gscSitemaps).where(eq(gscSitemaps.projectId, projectId)).all()
    for (const row of stored) {
      if (byUrl.has(row.url) || (row.parentUrl !== null && unread.has(row.parentUrl))) continue
      tx.delete(gscSitemaps).where(and(eq(gscSitemaps.projectId, projectId), eq(gscSitemaps.url, row.url))).run()
    }
    for (const row of byUrl.values()) {
      tx.insert(gscSitemaps).values({ id: crypto.randomUUID(), ...row }).onConflictDoUpdate({
        target: [gscSitemaps.projectId, gscSitemaps.url],
        set: { ...row },
      }).run()
    }
    tx.insert(sitemapListSyncs).values({ projectId, engine: 'google', syncedAt, syncRunId: runId }).onConflictDoUpdate({
      target: [sitemapListSyncs.projectId, sitemapListSyncs.engine],
      set: { syncedAt, syncRunId: runId },
    }).run()
  })
  return { sitemaps: byUrl.size, indexesRead: read.length }
}

interface GscSyncOptions {
  days?: number
  full?: boolean
  config: CanonryConfig
  /** Persists a refreshed access token; defaults to the active config.yaml. */
  saveConfigPatch?: (patch: Partial<CanonryConfig>) => void
}

export async function executeGscSync(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: GscSyncOptions,
): Promise<void> {
  const reportOutcome = startRunOutcome(db, runId, FeatureNames.search_console, 'sync')
  const now = new Date().toISOString()

  // Mark run as running
  db.update(runs).set({ status: 'running', startedAt: now }).where(eq(runs.id, runId)).run()

  try {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleAuthConfig(opts.config)
    if (!googleClientId || !googleClientSecret) {
      throw withOutcomeReason(new Error('Google OAuth is not configured in the local Canonry config'), OutcomeReasonCodes.NOT_CONNECTED)
    }

    // Load the project to get canonicalDomain for domain-scoped connection lookup
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw withOutcomeReason(new Error(`Project not found: ${projectId}`), OutcomeReasonCodes.NOT_FOUND)
    }

    const conn = getGoogleConnection(opts.config, project.canonicalDomain, 'gsc')
    if (!conn || !conn.refreshToken) {
      throw withOutcomeReason(new Error('No GSC connection found or connection is incomplete'), OutcomeReasonCodes.NOT_CONNECTED)
    }

    if (!conn.propertyId) {
      throw withOutcomeReason(
        new Error('No GSC property selected. Use "canonry google properties" to list available sites, then set one with the API.'),
        OutcomeReasonCodes.PROPERTY_NOT_FOUND,
      )
    }
    const propertyId = conn.propertyId

    // Refresh token if needed
    let accessToken = conn.accessToken!
    const expiresAt = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() : 0
    if (Date.now() > expiresAt - 5 * 60 * 1000) {
      const tokens = await refreshAccessToken(googleClientId, googleClientSecret, conn.refreshToken)
      accessToken = tokens.access_token
      patchGoogleConnection(opts.config, project.canonicalDomain, 'gsc', {
        accessToken: tokens.access_token,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      })
      const persistConfigPatch = opts.saveConfigPatch ?? saveConfigPatch
      persistConfigPatch(opts.config)
    }

    // Determine date range.
    //
    // Ask through TODAY, not through a hard-coded lag boundary. Google's
    // publishing delay varies; pinning the ceiling at `today - 3` meant the
    // sync never requested the day Google had already published, so stored
    // data sat a day behind the Search Console UI forever (measured on
    // canonry.ai: GSC served through 08-10 while Canonry held 08-09). The API
    // returns the days that exist and omits the rest, so asking wide is free.
    //
    // The lag still pads the START, so a `days`-day request yields `days` days
    // of PUBLISHED data rather than `days` minus the delay.
    // Both bounds are dates on GOOGLE's reporting calendar, which is Pacific
    // Time. A UTC date names the following day between 00:00 and 08:00 UTC —
    // exactly when a nightly sync tends to fire — so both bounds would sit a
    // day out for a third of the clock.
    const lagOffset = GSC_DATA_LAG_DAYS
    const endDate = formatIsoDateInTimeZone(new Date().toISOString(), GSC_REPORTING_TIME_ZONE)
    const days = opts.full ? 480 : (opts.days ?? 30) // 480 days ≈ 16 months (GSC max)
    const startDate = shiftIsoCalendarDate(endDate, -(days + lagOffset))

    // Fetch search analytics with pagination
    log.info('fetch.start', { runId, projectId, propertyId: conn.propertyId, startDate, endDate })
    const rows = await fetchSearchAnalytics(accessToken, conn.propertyId, {
      startDate,
      endDate,
    })

    log.info('fetch.complete', { runId, projectId, rowCount: rows.length })

    // Delete existing rows for this project in the same date range to avoid duplicates on re-sync
    db.delete(gscSearchData)
      .where(
        and(
          eq(gscSearchData.projectId, projectId),
          sql`${gscSearchData.date} >= ${startDate}`,
          sql`${gscSearchData.date} <= ${endDate}`,
        )
      )
      .run()

    // Store rows in batches
    const batchSize = 500
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      const insertNow = new Date().toISOString()

      for (const row of batch) {
        // keys order matches dimensions: query, page, country, device, date
        const [query, page, country, device, date] = row.keys
        db.insert(gscSearchData).values({
          id: crypto.randomUUID(),
          projectId,
          syncRunId: runId,
          date: date ?? '',
          query: query ?? '',
          page: page ?? '',
          country: country ?? null,
          device: device ?? null,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: String(row.ctr),
          position: String(row.position),
          createdAt: insertNow,
        }).run()
      }
    }

    // Property-level daily totals (no query/page dimensions). Summing the
    // dimensioned rows above does NOT equal Google's property total: the `page`
    // dimension over-counts impressions and the dropped anonymized rare queries
    // under-count clicks. Fetch the un-dimensioned daily figure so the headline
    // totals + daily trend match the GSC UI. Shares the main fetch's try block —
    // a failure fails the sync, which is acceptable because the dimensioned data
    // is already persisted and a re-sync recovers the totals.
    const totalRows = await fetchSearchAnalytics(accessToken, propertyId, {
      startDate,
      endDate,
      dimensions: ['date'],
    })

    db.delete(gscDailyTotals)
      .where(
        and(
          eq(gscDailyTotals.projectId, projectId),
          sql`${gscDailyTotals.date} >= ${startDate}`,
          sql`${gscDailyTotals.date} <= ${endDate}`,
        )
      )
      .run()

    const dailyTotalsNow = new Date().toISOString()
    for (const row of totalRows) {
      const [date] = row.keys
      db.insert(gscDailyTotals).values({
        id: crypto.randomUUID(),
        projectId,
        date: date ?? '',
        clicks: row.clicks,
        impressions: row.impressions,
        position: String(row.position),
        createdAt: dailyTotalsNow,
      }).run()
    }

    // Advance the monotonic data watermark.
    //
    // The furthest date this sync SAW, never lower than what a previous sync
    // already recorded. Search Analytics omits zero-data days, so the observed
    // max walks backward across a quiet stretch; letting the anchor follow it
    // would slide every window into the past and move its totals. Monotonic is
    // the property that makes this usable as a frontier at all.
    //
    // `syncedThroughDate` records how far we ASKED, so the gap between the two
    // is attributable rather than mysterious.
    const observedThrough = totalRows
      .map((row) => row.keys[0] ?? '')
      .filter((date) => date !== '')
      .reduce<string | null>((max, date) => (max === null || date > max ? date : max), null)
    if (observedThrough !== null || endDate) {
      const existing = db.select().from(gscDataWatermarks)
        .where(eq(gscDataWatermarks.projectId, projectId)).get()
      const nextThrough = [existing?.dataThroughDate ?? null, observedThrough]
        .filter((d): d is string => d !== null)
        .reduce<string | null>((max, d) => (max === null || d > max ? d : max), null)
      if (nextThrough !== null) {
        db.insert(gscDataWatermarks).values({
          projectId,
          dataThroughDate: nextThrough,
          syncedThroughDate: endDate,
          updatedAt: dailyTotalsNow,
        }).onConflictDoUpdate({
          target: gscDataWatermarks.projectId,
          set: { dataThroughDate: nextThrough, syncedThroughDate: endDate, updatedAt: dailyTotalsNow },
        }).run()
      }
    }

    log.info('daily-totals.complete', {
      runId, projectId, rowCount: totalRows.length, observedThrough, syncedThrough: endDate,
    })

    // Per-query daily totals (no `page` dimension). Same reason as above,
    // applied one level down: summing `gsc_search_data` by query multiplies
    // impressions by how many of the site's pages ranked on the same SERP.
    // That error is ~0% for a query with one ranking page and ~500% for
    // brand+category terms where several rank together, so it reorders a
    // top-queries table rather than merely inflating it. Google deduplicates
    // when `page` is absent, and also returns its own per-query `position`.
    const queryTotalRows = await fetchSearchAnalytics(accessToken, propertyId, {
      startDate,
      endDate,
      dimensions: ['date', 'query'],
    })

    db.delete(gscQueryDailyTotals)
      .where(
        and(
          eq(gscQueryDailyTotals.projectId, projectId),
          sql`${gscQueryDailyTotals.date} >= ${startDate}`,
          sql`${gscQueryDailyTotals.date} <= ${endDate}`,
        )
      )
      .run()

    const queryTotalsNow = new Date().toISOString()
    for (const row of queryTotalRows) {
      // keys order matches dimensions: date, query
      const [date, query] = row.keys
      if (!date || !query) continue
      db.insert(gscQueryDailyTotals).values({
        id: crypto.randomUUID(),
        projectId,
        date,
        query,
        clicks: row.clicks,
        impressions: row.impressions,
        position: String(row.position),
        syncedAt: queryTotalsNow,
        syncRunId: runId,
        createdAt: queryTotalsNow,
      }).run()
    }

    log.info('query-totals.complete', { runId, projectId, rowCount: queryTotalRows.length })

    // The sitemap list rides along with the sync so nothing has to ask Google
    // live to show it. A failure here keeps the last stored list and does not
    // fail the sync: the search data above is already saved.
    try {
      const stored = await syncGscSitemaps(db, projectId, runId, accessToken, propertyId)
      log.info('sitemaps.complete', { runId, projectId, ...stored })
    } catch (err) {
      log.warn('sitemaps.failed', { runId, projectId, error: describeError(err) })
    }

    // URL inspection deliberately does NOT happen here.
    //
    // Each call to Google's URL Inspection API costs ~7.1s (≈6.3s of Google's
    // own latency for a live index lookup, plus the ~1.1s pacing the API's
    // 1 req/sec soft limit requires) and one unit of a 2000/property/day quota.
    // Inspecting inline made the run scale with the site: measured at 240.9s of
    // a 241.9s sync for 31 URLs — 99.6% of the run — while the search-analytics
    // work above finished in 1.07s. The dashboard polls this run for 120s, so
    // every sync on a site with more than ~17 indexed pages timed out, silently,
    // and showed pre-sync numbers.
    //
    // Coverage is instead owned by `inspect-sitemap`, which the server already
    // chains off a successful sync via `maybeRefreshGscCoverage`. That walks the
    // whole sitemap rather than the top 50 by clicks, so it is both more complete
    // and no longer duplicated — the two loops previously re-inspected 33 of the
    // same URLs per cycle, spending quota to confirm what search analytics had
    // already reported for free.

    // Single writer — see gsc-coverage-snapshot.ts. `inspect-sitemap` chains
    // off this run and rewrites the same row, so both must compute it the same
    // way or the chained run silently overwrites what this one derived.
    const coverage = writeCoverageSnapshot(db, projectId, runId)

    // Mark run as completed
    db.update(runs)
      .set({ status: 'completed', finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.info('sync.completed', { runId, projectId, searchDataRows: rows.length, indexed: coverage.indexed, notIndexed: coverage.notIndexed, unknown: coverage.unknown, verifiedByInspection: coverage.verifiedByInspection })
    const counts = { rows: rows.length, urls: new Set(rows.map((row) => row.keys[1] ?? '')).size }
    reportOutcome(rows.length === 0
      ? { status: OutcomeStatuses.skipped, reasonCode: OutcomeReasonCodes.NO_DATA, counts }
      : { status: OutcomeStatuses.succeeded, counts })
  } catch (err) {
    const errorMsg = describeError(err)
    db.update(runs)
      .set({ status: 'failed', error: errorMsg, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.error('sync.failed', { runId, projectId, error: errorMsg })
    reportOutcome({ status: OutcomeStatuses.failed, ...googleRunFailure(err) })
    throw err
  }
}
