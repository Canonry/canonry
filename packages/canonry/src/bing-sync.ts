import crypto from 'node:crypto'
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import {
  bingCrawlStats,
  bingKeywordDemand,
  bingPageStats,
  bingQueryStats,
  bingSiteSnapshots,
  bingSitemaps,
  sitemapListSyncs,
  bingTrafficDaily,
  projects,
  queries,
  runs,
} from '@canonry/canonry-db'
import {
  BingSiteSnapshotKinds,
  FeatureNames,
  OutcomeReasonCodes,
  OutcomeStatuses,
  RunStatuses,
  describeError,
  type BingSiteSnapshotKind,
  type BingSiteSnapshotStatus,
} from '@canonry/canonry-contracts'
import {
  BingApiError,
  bingDateToDay,
  bingPositionOrNull,
  bingKeywordMarket,
  getActivePagePreviewBlocks,
  getBlockedUrls,
  getConnectedPages,
  getContentSubmissionQuota,
  getCountryRegionSettings,
  getCrawlIssues,
  getCrawlSettings,
  getCrawlStats,
  getDeepLinkBlocks,
  getFeedDetails,
  getFeeds,
  getFetchedUrls,
  getKeywordHistory,
  getPageStats,
  getQueryParameters,
  getQueryStats,
  getRankAndTrafficStats,
  getSiteRoles,
  getUrlSubmissionQuota,
  parseBingDate,
  type BingFeed,
  type BingKeywordMarket,
  type BingQueryStats,
} from '@canonry/canonry-integration-bing'
import type { CanonryConfig } from './config.js'
import { credentialGateKey, sharedRateGate, type SleepFn } from './inspect-rate-gate.js'
import { createLogger } from './logger.js'
import { runFailure, startRunOutcome, withOutcomeReason } from './sync-outcome.js'

const log = createLogger('BingSync')

/**
 * Spacing between Bing request STARTS, shared with the URL inspection sweep
 * through the same per-account gate (`bing:<key digest>`), so a sync and a
 * sweep on one key never add up to more than one request every two seconds.
 */
export const BING_SYNC_SPACING_MS = 2_000

/** A tracked query's demand is re-read once its newest stored week is older than this. */
export const BING_KEYWORD_DEMAND_REFRESH_DAYS = 7

/**
 * Most tracked queries whose demand one sync refreshes. A large basket is
 * spread over several daily syncs instead of spending one run's whole budget.
 */
export const BING_KEYWORD_DEMAND_MAX_PER_SYNC = 30

/** Sitemap indexes expanded per sync (one `GetFeedDetails` call each). */
export const BING_SITEMAP_INDEX_MAX_PER_SYNC = 20

/** Bing's error code for a read the key is not allowed to make (owner-only reads). */
const BING_NOT_AUTHORIZED = 14

export interface BingSyncOptions {
  config: CanonryConfig
  /** Test seam: replaces the real two-second spacing. */
  sleep?: SleepFn
  /** Test seam: the clock used for staleness and `synced_at`. */
  now?: () => Date
}

type SectionName = 'traffic' | 'queries' | 'pages' | 'crawl-stats' | 'sitemaps' | 'site' | 'keyword-demand'

interface SectionResult {
  section: SectionName
  ok: boolean
  rows: number
  error?: string
}

/** A throttle that outlasted the client's retries: stop calling Bing for the rest of the run. */
class BingSyncThrottled extends Error {
  constructor(cause: unknown) {
    super(describeError(cause), { cause })
    this.name = 'BingSyncThrottled'
  }
}

function isThrottle(err: unknown): boolean {
  return err instanceof BingApiError && (err.isThrottle || err.status === 429)
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

const BLOCKED_ENTITY_TYPES = ['page', 'directory'] as const
const BLOCKED_REQUEST_TYPES = ['cache-only', 'full-removal'] as const
const COUNTRY_REGION_TYPES = ['page', 'directory', 'domain', 'subdomain'] as const
const SITE_ROLES = ['administrator', 'read-only', 'read-write'] as const

function enumWord<T extends string>(words: readonly T[], value: unknown): T | null {
  return typeof value === 'number' && Number.isInteger(value) ? words[value] ?? null : null
}

/** Convert every `/Date(...)/` string in a raw Bing row to ISO, leaving other fields untouched. */
function convertDates(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (key === '__type') continue
    out[key] = typeof value === 'string' && value.startsWith('/Date(') ? parseBingDate(value) : value
  }
  return out
}

/**
 * Sum Bing weekly rows that share a (date, key). Bing has been seen to send a
 * query twice for one week (case variants collapse in SQLite's unique index
 * only when identical), so rows are merged before the upsert rather than
 * letting the second silently overwrite the first.
 */
function mergeWeekly(rows: readonly BingQueryStats[]): Array<{ date: string; key: string; clicks: number; impressions: number; avgClickPosition: number | null; avgImpressionPosition: number | null }> {
  const merged = new Map<string, { date: string; key: string; clicks: number; impressions: number; clickPosWeight: number; clickPosSum: number; imprPosWeight: number; imprPosSum: number }>()
  for (const row of rows) {
    const date = bingDateToDay(row.Date)
    const key = typeof row.Query === 'string' ? row.Query.trim() : ''
    if (!date || !key) continue
    const id = `${date}\u0000${key}`
    const entry = merged.get(id) ?? { date, key, clicks: 0, impressions: 0, clickPosWeight: 0, clickPosSum: 0, imprPosWeight: 0, imprPosSum: 0 }
    const clicks = count(row.Clicks)
    const impressions = count(row.Impressions)
    entry.clicks += clicks
    entry.impressions += impressions
    const clickPos = bingPositionOrNull(row.AvgClickPosition)
    if (clickPos !== null) {
      const weight = Math.max(clicks, 1)
      entry.clickPosSum += clickPos * weight
      entry.clickPosWeight += weight
    }
    const imprPos = bingPositionOrNull(row.AvgImpressionPosition)
    if (imprPos !== null) {
      const weight = Math.max(impressions, 1)
      entry.imprPosSum += imprPos * weight
      entry.imprPosWeight += weight
    }
    merged.set(id, entry)
  }
  return [...merged.values()].map((entry) => ({
    date: entry.date,
    key: entry.key,
    clicks: entry.clicks,
    impressions: entry.impressions,
    avgClickPosition: entry.clickPosWeight > 0 ? entry.clickPosSum / entry.clickPosWeight : null,
    avgImpressionPosition: entry.imprPosWeight > 0 ? entry.imprPosSum / entry.imprPosWeight : null,
  }))
}

/**
 * Read every Bing Webmaster data method for one project and store it:
 * daily traffic, weekly query and page stats, daily crawl stats, sitemaps,
 * site settings, and weekly search demand for the tracked queries.
 *
 * Sections are independent: one failing marks the run `partial` and the rest
 * still land. A throttle that survives the client's own retries ends the run
 * there, because Bing's limit is on the account and further calls are what
 * keep it asserted (see `integration-bing/AGENTS.md`).
 */
export async function executeBingSync(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: BingSyncOptions,
): Promise<void> {
  const reportOutcome = startRunOutcome(db, runId, FeatureNames.bing, 'sync')
  const now = opts.now ?? (() => new Date())
  const sleep: SleepFn = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  db.update(runs).set({ status: RunStatuses.running, startedAt: now().toISOString() }).where(eq(runs.id, runId)).run()

  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw withOutcomeReason(new Error(`Project not found: ${projectId}`), OutcomeReasonCodes.NOT_FOUND)
    }
    const conn = opts.config.bing?.connections?.find((c) => c.domain === project.canonicalDomain)
    if (!conn) {
      throw withOutcomeReason(
        new Error('No Bing connection found for this project. Run "canonry bing connect <project>" first.'),
        OutcomeReasonCodes.NOT_CONNECTED,
      )
    }
    if (!conn.siteUrl) {
      throw withOutcomeReason(
        new Error('No Bing site configured. Run "canonry bing set-site <project> <url>" first.'),
        OutcomeReasonCodes.PROPERTY_NOT_FOUND,
      )
    }
    const apiKey = conn.apiKey
    const siteUrl = conn.siteUrl
    const gate = sharedRateGate(credentialGateKey('bing', apiKey))
    let throttled = false

    /** Every Bing call in the run goes through here: paced, and short-circuited after a throttle. */
    async function call<T>(read: () => Promise<T>): Promise<T> {
      if (throttled) throw new BingSyncThrottled(new Error('Bing throttled this account earlier in the run'))
      await gate.take(BING_SYNC_SPACING_MS, sleep)
      try {
        return await read()
      } catch (err) {
        if (isThrottle(err)) {
          throttled = true
          throw new BingSyncThrottled(err)
        }
        throw err
      }
    }

    const results: SectionResult[] = []
    async function section(name: SectionName, work: () => Promise<number>): Promise<void> {
      try {
        const rows = await work()
        results.push({ section: name, ok: true, rows })
        log.info('section.completed', { runId, projectId, section: name, rows })
      } catch (err) {
        const error = describeError(err)
        results.push({ section: name, ok: false, rows: 0, error })
        log.warn('section.failed', { runId, projectId, section: name, error, throttled: err instanceof BingSyncThrottled })
      }
    }

    await section('traffic', async () => {
      const rows = await call(() => getRankAndTrafficStats(apiKey, siteUrl))
      const syncedAt = now().toISOString()
      let written = 0
      db.transaction((tx) => {
        for (const row of rows) {
          const date = bingDateToDay(row.Date)
          if (!date) continue
          const values = { clicks: count(row.Clicks), impressions: count(row.Impressions), syncRunId: runId, syncedAt }
          tx.insert(bingTrafficDaily).values({ id: crypto.randomUUID(), projectId, date, ...values })
            .onConflictDoUpdate({ target: [bingTrafficDaily.projectId, bingTrafficDaily.date], set: values })
            .run()
          written += 1
        }
      })
      return written
    })

    await section('queries', async () => {
      const merged = mergeWeekly(await call(() => getQueryStats(apiKey, siteUrl)))
      const syncedAt = now().toISOString()
      db.transaction((tx) => {
        for (const row of merged) {
          const values = { clicks: row.clicks, impressions: row.impressions, avgClickPosition: row.avgClickPosition, avgImpressionPosition: row.avgImpressionPosition, syncRunId: runId, syncedAt }
          tx.insert(bingQueryStats).values({ id: crypto.randomUUID(), projectId, date: row.date, query: row.key, ...values })
            .onConflictDoUpdate({ target: [bingQueryStats.projectId, bingQueryStats.date, bingQueryStats.query], set: values })
            .run()
        }
      })
      return merged.length
    })

    await section('pages', async () => {
      const merged = mergeWeekly(await call(() => getPageStats(apiKey, siteUrl)))
      const syncedAt = now().toISOString()
      db.transaction((tx) => {
        for (const row of merged) {
          const values = { clicks: row.clicks, impressions: row.impressions, avgClickPosition: row.avgClickPosition, avgImpressionPosition: row.avgImpressionPosition, syncRunId: runId, syncedAt }
          tx.insert(bingPageStats).values({ id: crypto.randomUUID(), projectId, date: row.date, page: row.key, ...values })
            .onConflictDoUpdate({ target: [bingPageStats.projectId, bingPageStats.date, bingPageStats.page], set: values })
            .run()
        }
      })
      return merged.length
    })

    await section('crawl-stats', async () => {
      const rows = await call(() => getCrawlStats(apiKey, siteUrl))
      const syncedAt = now().toISOString()
      let written = 0
      db.transaction((tx) => {
        for (const row of rows) {
          const date = bingDateToDay(row.Date)
          if (!date) continue
          const values = {
            crawledPages: count(row.CrawledPages),
            inIndex: count(row.InIndex),
            crawlErrors: count(row.CrawlErrors),
            inLinks: count(row.InLinks),
            code2xx: count(row.Code2xx),
            code301: count(row.Code301),
            code302: count(row.Code302),
            code4xx: count(row.Code4xx),
            code5xx: count(row.Code5xx),
            allOtherCodes: count(row.AllOtherCodes),
            blockedByRobotsTxt: count(row.BlockedByRobotsTxt),
            connectionTimeout: count(row.ConnectionTimeout),
            containsMalware: count(row.ContainsMalware),
            dnsFailures: count(row.DnsFailures),
            syncRunId: runId,
            syncedAt,
          }
          tx.insert(bingCrawlStats).values({ id: crypto.randomUUID(), projectId, date, ...values })
            .onConflictDoUpdate({ target: [bingCrawlStats.projectId, bingCrawlStats.date], set: values })
            .run()
          written += 1
        }
      })
      return written
    })

    await section('sitemaps', async () => {
      const top = await call(() => getFeeds(apiKey, siteUrl))
      const collected = new Map<string, { feed: BingFeed; parentUrl: string | null }>()
      for (const feed of top) {
        if (feed.Url) collected.set(feed.Url, { feed, parentUrl: null })
      }
      // A sitemap index's children only appear through GetFeedDetails, which
      // returns the index itself plus one row per child sitemap.
      const indexes = top.filter((feed) => /index/i.test(feed.Type ?? '')).slice(0, BING_SITEMAP_INDEX_MAX_PER_SYNC)
      for (const index of indexes) {
        const details = await call(() => getFeedDetails(apiKey, siteUrl, index.Url))
        for (const child of details) {
          if (!child.Url || child.Url === index.Url || collected.has(child.Url)) continue
          collected.set(child.Url, { feed: child, parentUrl: index.Url })
        }
      }
      const syncedAt = now().toISOString()
      const urls = [...collected.keys()]
      db.transaction((tx) => {
        for (const { feed, parentUrl } of collected.values()) {
          const values = {
            parentUrl,
            type: feed.Type ?? 'Unknown',
            status: feed.Status ?? 'Unknown',
            urlCount: count(feed.UrlCount),
            fileSize: count(feed.FileSize),
            compressed: feed.Compressed === true,
            submittedAt: parseBingDate(feed.Submitted ?? null),
            lastCrawledAt: parseBingDate(feed.LastCrawled ?? null),
            syncRunId: runId,
            syncedAt,
          }
          tx.insert(bingSitemaps).values({ id: crypto.randomUUID(), projectId, url: feed.Url, ...values })
            .onConflictDoUpdate({ target: [bingSitemaps.projectId, bingSitemaps.url], set: values })
            .run()
        }
        // Bing is the record: a sitemap it no longer lists is gone.
        tx.delete(bingSitemaps)
          .where(urls.length > 0
            ? and(eq(bingSitemaps.projectId, projectId), notInArray(bingSitemaps.url, urls))
            : eq(bingSitemaps.projectId, projectId))
          .run()
        // An empty list is now a real answer, not "never read".
        tx.insert(sitemapListSyncs).values({ projectId, engine: 'bing', syncedAt, syncRunId: runId })
          .onConflictDoUpdate({ target: [sitemapListSyncs.projectId, sitemapListSyncs.engine], set: { syncedAt, syncRunId: runId } })
          .run()
      })
      return collected.size
    })

    await section('site', async () => {
      const reads: Array<{ kind: BingSiteSnapshotKind; read: () => Promise<unknown> }> = [
        {
          kind: BingSiteSnapshotKinds['url-submission-quota'],
          read: async () => {
            const quota = await getUrlSubmissionQuota(apiKey, siteUrl)
            return { dailyQuota: count(quota?.DailyQuota), monthlyQuota: count(quota?.MonthlyQuota) }
          },
        },
        {
          kind: BingSiteSnapshotKinds['content-submission-quota'],
          read: async () => {
            const quota = await getContentSubmissionQuota(apiKey, siteUrl)
            return { dailyQuota: count(quota?.DailyQuota), monthlyQuota: count(quota?.MonthlyQuota) }
          },
        },
        {
          kind: BingSiteSnapshotKinds['crawl-settings'],
          read: async () => {
            const settings = await getCrawlSettings(apiKey, siteUrl)
            return {
              crawlBoostAvailable: settings?.CrawlBoostAvailable === true,
              crawlBoostEnabled: settings?.CrawlBoostEnabled === true,
              crawlRate: Array.isArray(settings?.CrawlRate) ? settings.CrawlRate.filter((v) => typeof v === 'number') : [],
            }
          },
        },
        {
          kind: BingSiteSnapshotKinds['crawl-issues'],
          read: async () => (await getCrawlIssues(apiKey, siteUrl)).map((issue) => ({
            url: issue.Url,
            httpCode: typeof issue.HttpCode === 'number' ? issue.HttpCode : null,
            inLinks: typeof issue.InLinks === 'number' ? issue.InLinks : null,
            issues: issue.Issues ?? issue.IssueType ?? null,
          })),
        },
        {
          kind: BingSiteSnapshotKinds['blocked-urls'],
          read: async () => (await getBlockedUrls(apiKey, siteUrl)).map((row) => ({
            url: row.Url,
            date: parseBingDate(row.Date ?? null),
            daysToExpire: typeof row.DaysToExpire === 'number' ? row.DaysToExpire : null,
            entityType: enumWord(BLOCKED_ENTITY_TYPES, row.EntityType),
            requestType: enumWord(BLOCKED_REQUEST_TYPES, row.RequestType),
          })),
        },
        {
          kind: BingSiteSnapshotKinds['page-preview-blocks'],
          read: async () => (await getActivePagePreviewBlocks(apiKey, siteUrl)).map(convertDates),
        },
        {
          kind: BingSiteSnapshotKinds['deep-link-blocks'],
          read: async () => (await getDeepLinkBlocks(apiKey, siteUrl)).map(convertDates),
        },
        {
          kind: BingSiteSnapshotKinds['query-parameters'],
          read: async () => (await getQueryParameters(apiKey, siteUrl)).map((row) => ({
            parameter: row.Parameter,
            isEnabled: typeof row.IsEnabled === 'boolean' ? row.IsEnabled : null,
            date: parseBingDate(row.Date ?? null),
            source: row.Source ?? null,
          })),
        },
        {
          kind: BingSiteSnapshotKinds['country-region-settings'],
          read: async () => (await getCountryRegionSettings(apiKey, siteUrl)).map((row) => ({
            url: row.Url,
            countryCode: row.TwoLetterIsoCountryCode,
            type: enumWord(COUNTRY_REGION_TYPES, row.Type),
            date: parseBingDate(row.Date ?? null),
          })),
        },
        {
          kind: BingSiteSnapshotKinds['fetched-urls'],
          read: async () => (await getFetchedUrls(apiKey, siteUrl)).map((row) => ({
            url: row.Url,
            date: parseBingDate(row.Date ?? null),
            expired: typeof row.Expired === 'boolean' ? row.Expired : null,
            fetched: typeof row.Fetched === 'boolean' ? row.Fetched : null,
          })),
        },
        {
          kind: BingSiteSnapshotKinds['connected-pages'],
          read: async () => (await getConnectedPages(apiKey, siteUrl)).map(convertDates),
        },
        {
          kind: BingSiteSnapshotKinds['site-roles'],
          read: async () => (await getSiteRoles(apiKey, siteUrl)).map((row) => ({
            site: row.Site ?? null,
            email: row.Email ?? null,
            role: enumWord(SITE_ROLES, row.Role),
            date: parseBingDate(row.Date ?? null),
            expired: typeof row.Expired === 'boolean' ? row.Expired : null,
          })),
        },
      ]

      let failed = 0
      let stored = 0
      for (const { kind, read } of reads) {
        let status: BingSiteSnapshotStatus = 'ok'
        let payload: unknown = null
        let error: string | null = null
        try {
          payload = await call(read)
        } catch (err) {
          if (err instanceof BingSyncThrottled) throw err
          const unauthorized = err instanceof BingApiError && err.bingErrorCode === BING_NOT_AUTHORIZED
          status = unauthorized ? 'unauthorized' : 'failed'
          error = unauthorized ? 'This Bing key is not allowed to read this setting (owner-only).' : describeError(err)
          if (!unauthorized) failed += 1
        }
        const syncedAt = now().toISOString()
        // A failed read keeps the last good payload: the operator still sees
        // what Bing said, and `status` / `error` say it could not be re-read.
        const previous = status === 'failed'
          ? db.select({ payload: bingSiteSnapshots.payload }).from(bingSiteSnapshots)
            .where(and(eq(bingSiteSnapshots.projectId, projectId), eq(bingSiteSnapshots.kind, kind))).get()
          : undefined
        const values = { status, payload: status === 'failed' ? previous?.payload ?? null : payload, error, syncRunId: runId, syncedAt }
        db.insert(bingSiteSnapshots).values({ id: crypto.randomUUID(), projectId, kind, ...values })
          .onConflictDoUpdate({ target: [bingSiteSnapshots.projectId, bingSiteSnapshots.kind], set: values })
          .run()
        stored += 1
      }
      if (failed > 0) throw new Error(`${failed} of ${reads.length} Bing site settings could not be read`)
      return stored
    })

    await section('keyword-demand', async () => {
      const market: BingKeywordMarket = bingKeywordMarket(project.country, project.language)
      const tracked = db.select({ query: queries.query }).from(queries).where(eq(queries.projectId, projectId)).all()
      if (tracked.length === 0) return 0
      const cutoff = new Date(now().getTime() - BING_KEYWORD_DEMAND_REFRESH_DAYS * 86_400_000).toISOString()
      const lastSynced = new Map(db
        .select({ query: bingKeywordDemand.query, syncedAt: sql<string>`MAX(${bingKeywordDemand.syncedAt})` })
        .from(bingKeywordDemand)
        .where(and(
          eq(bingKeywordDemand.projectId, projectId),
          eq(bingKeywordDemand.country, market.country),
          eq(bingKeywordDemand.language, market.language),
        ))
        .groupBy(bingKeywordDemand.query)
        .all()
        .map((row) => [row.query, row.syncedAt] as const))
      // Never-read queries first, then the stalest.
      const due = tracked
        .map((row) => ({ query: row.query, syncedAt: lastSynced.get(row.query) ?? null }))
        .filter((row) => row.syncedAt === null || row.syncedAt < cutoff)
        .sort((a, b) => (a.syncedAt ?? '').localeCompare(b.syncedAt ?? ''))
        .slice(0, BING_KEYWORD_DEMAND_MAX_PER_SYNC)
      let written = 0
      let failures = 0
      let lastError: unknown
      for (const { query } of due) {
        let history
        try {
          history = await call(() => getKeywordHistory(apiKey, query, market))
        } catch (err) {
          if (err instanceof BingSyncThrottled) throw err
          failures += 1
          lastError = err
          continue
        }
        const syncedAt = now().toISOString()
        db.transaction((tx) => {
          for (const week of history) {
            const date = bingDateToDay(week.Date)
            if (!date) continue
            const values = { impressions: count(week.Impressions), broadImpressions: count(week.BroadImpressions), syncRunId: runId, syncedAt }
            tx.insert(bingKeywordDemand)
              .values({ id: crypto.randomUUID(), projectId, query, country: market.country, language: market.language, date, ...values })
              .onConflictDoUpdate({
                target: [bingKeywordDemand.projectId, bingKeywordDemand.query, bingKeywordDemand.country, bingKeywordDemand.language, bingKeywordDemand.date],
                set: values,
              })
              .run()
            written += 1
          }
          // A query Bing has no volume for still records that it was read, so
          // it is not re-requested every day.
          if (history.length === 0) {
            const date = now().toISOString().slice(0, 10)
            tx.insert(bingKeywordDemand)
              .values({ id: crypto.randomUUID(), projectId, query, country: market.country, language: market.language, date, impressions: 0, broadImpressions: 0, syncRunId: runId, syncedAt })
              .onConflictDoNothing()
              .run()
          }
        })
      }
      if (failures > 0) throw new Error(`${failures} of ${due.length} keyword demand reads failed; last: ${describeError(lastError)}`)
      return written
    })

    const failed = results.filter((r) => !r.ok)
    const status = failed.length === 0
      ? RunStatuses.completed
      : failed.length === results.length
        ? RunStatuses.failed
        : RunStatuses.partial
    const error = failed.length === 0
      ? null
      : `${throttled ? 'Bing throttled this account; stopped early. ' : ''}${failed.map((r) => `${r.section}: ${r.error}`).join('; ')}`.slice(0, 2000)
    db.update(runs).set({ status, error, finishedAt: now().toISOString() }).where(eq(runs.id, runId)).run()

    const rows = results.reduce((sum, r) => sum + r.rows, 0)
    log.info('sync.completed', { runId, projectId, status, rows, failedSections: failed.map((r) => r.section) })
    if (status === RunStatuses.completed) {
      reportOutcome({ status: OutcomeStatuses.succeeded, counts: { rows, items: results.length } })
    } else {
      reportOutcome({
        status: status === RunStatuses.partial ? OutcomeStatuses.partial : OutcomeStatuses.failed,
        ...runFailure(new Error(error ?? 'Bing sync failed'), throttled ? OutcomeReasonCodes.RATE_LIMITED : undefined),
        counts: { rows, items: results.length, failures: failed.length },
      })
    }
  } catch (err) {
    const message = describeError(err)
    db.update(runs).set({ status: RunStatuses.failed, error: message, finishedAt: now().toISOString() }).where(eq(runs.id, runId)).run()
    log.error('sync.failed', { runId, projectId, error: message })
    reportOutcome({ status: OutcomeStatuses.failed, ...runFailure(err) })
    throw err
  }
}

