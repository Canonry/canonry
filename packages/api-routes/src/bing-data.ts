import crypto from 'node:crypto'
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  bingCrawlStats,
  bingKeywordDemand,
  bingPageStats,
  bingQueryStats,
  bingSiteSnapshots,
  bingSitemaps,
  bingTrafficDaily,
  queries,
  runs,
} from '@canonry/canonry-db'
import {
  RunKinds,
  RunStatuses,
  bingSiteSnapshotKindSchema,
  escapeLikePattern,
  providerError,
  quotaExceeded,
  validationError,
  type BingCrawlStatsResponseDto,
  type BingFetchedUrlsResponseDto,
  type BingKeywordDemandResponseDto,
  type BingKeywordResearchResponseDto,
  type BingLinksResponseDto,
  type BingPageQueriesResponseDto,
  type BingPageTotalsResponseDto,
  type BingQueryHistoryResponseDto,
  type BingQueryPagesResponseDto,
  type BingQueryTotalsResponseDto,
  type BingSiteResponseDto,
  type BingSitemapsResponseDto,
  type BingStatsRowDto,
  type BingTrafficResponseDto,
  type BingUrlChildrenResponseDto,
  type BingUrlTrafficResponseDto,
  type BingWeeklyTotalsRowDto,
} from '@canonry/canonry-contracts'
import {
  BingApiError,
  bingDateToDay,
  bingPositionOrNull,
  bingKeywordMarket,
  getChildrenUrlInfo,
  getChildrenUrlTrafficInfo,
  getFetchedUrlDetails,
  getFetchedUrls,
  getKeyword,
  getKeywordHistory,
  getLinkCounts,
  getPageQueryStats,
  getQueryPageDetailStats,
  getQueryPageStats,
  getQueryTrafficStats,
  getRelatedKeywords,
  getUrlLinks,
  getUrlTrafficInfo,
  parseBingDate,
  type BingQueryStats,
} from '@canonry/canonry-integration-bing'
import { assertForwardRange } from './google.js'
import { resolveProject, syncRunTrigger, type ScheduledSyncClaim } from './helpers.js'

/** Default span of a stored read with no explicit dates, anchored at the newest stored day. */
export const BING_DEFAULT_WINDOW_DAYS = 28
const MAX_WINDOW_DAYS = 3660
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 5000

export interface BingSiteAccess {
  apiKey: string
  siteUrl: string
}

export interface BingDataRoutesOptions {
  claimScheduledSync?: ScheduledSyncClaim
  onSyncRequested?: (runId: string, projectId: string) => void
  /** Resolves the project's Bing key and selected site, or throws the usual "connect first" errors. */
  requireSite: (canonicalDomain: string) => BingSiteAccess
  /** Resolves just the key (keyword research needs no site). */
  requireApiKey: (canonicalDomain: string) => string
}

function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

function parseDays(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) {
    throw validationError(`"days" must be an integer from 1 to ${MAX_WINDOW_DAYS}`)
  }
  return n
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIST_LIMIT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw validationError('"limit" must be a positive integer')
  return Math.min(n, MAX_LIST_LIMIT)
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw validationError('"offset" must be a non-negative integer')
  return n
}

function parsePage(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw validationError('"page" must be an integer from 0 to 65535')
  return n
}

function requireText(value: string | undefined, name: string): string {
  const trimmed = value?.trim()
  if (!trimmed) throw validationError(`"${name}" is required`)
  return trimmed
}

function requireHttpUrl(value: string | undefined, name: string): string {
  const raw = requireText(value, name)
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http')
  } catch {
    throw validationError(`"${name}" must be an http(s) URL`)
  }
  return raw
}

/**
 * Resolve a stored read's window. Explicit `startDate` wins; otherwise `days`
 * (default 28) ends at `endDate`, or at the newest stored day so a lagging
 * Bing feed does not read as a run of zeros.
 */
export function resolveBingWindow(
  query: { startDate?: string; endDate?: string; days?: string },
  latest: string | null,
  defaultDays = BING_DEFAULT_WINDOW_DAYS,
): { startDate: string | null; endDate: string | null } {
  assertForwardRange(query.startDate, query.endDate)
  if (query.startDate) return { startDate: query.startDate, endDate: query.endDate ?? null }
  const days = parseDays(query.days, defaultDays)
  const anchor = query.endDate ?? latest
  if (!anchor) return { startDate: null, endDate: null }
  return { startDate: shiftDay(anchor, -(days - 1)), endDate: anchor }
}

function ctrOf(clicks: number, impressions: number): number {
  return impressions > 0 ? clicks / impressions : 0
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100
}

/** Map a Bing failure on a live read to an API error that says what happened upstream. */
function bingReadError(err: unknown, what: string): unknown {
  if (!(err instanceof BingApiError)) return err
  if (err.isThrottle || err.status === 429) {
    return quotaExceeded('Bing Webmaster API', { reason: 'bing-throttled', detail: err.message })
  }
  if (err.bingErrorCode === 14) {
    return providerError(`Bing refused to read ${what}: this API key is not allowed to (owner-only).`, { bingErrorCode: 14 })
  }
  if (err.status === 400 && err.bingErrorCode === null) {
    // Our own pre-flight validation (empty query, bad URL) also raises BingApiError 400.
    return validationError(err.message)
  }
  return providerError(`Bing could not read ${what}: ${err.message}`, { bingErrorCode: err.bingErrorCode, httpStatus: err.status })
}

async function liveRead<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (err) {
    throw bingReadError(err, what)
  }
}

function statsRows(rows: readonly BingQueryStats[]): BingStatsRowDto[] {
  return rows
    .map((row) => ({
      date: bingDateToDay(row.Date),
      key: row.Query,
      clicks: Math.max(0, row.Clicks ?? 0),
      impressions: Math.max(0, row.Impressions ?? 0),
      ctr: ctrOf(row.Clicks ?? 0, row.Impressions ?? 0),
      avgImpressionPosition: bingPositionOrNull(row.AvgImpressionPosition),
      avgClickPosition: bingPositionOrNull(row.AvgClickPosition),
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.clicks - a.clicks || b.impressions - a.impressions)
}

type WeeklyTable = typeof bingQueryStats | typeof bingPageStats

/** Weekly-stat aggregates shared by `/bing/queries` and `/bing/pages`. */
function weeklyAggregates(table: WeeklyTable) {
  // Positions are weighted by impressions (or clicks), with a floor of 1 so a
  // row Bing positioned but counted zero for still contributes.
  return {
    clicks: sql<number>`COALESCE(SUM(${table.clicks}), 0)`,
    impressions: sql<number>`COALESCE(SUM(${table.impressions}), 0)`,
    avgImpressionPosition: sql<number | null>`SUM(${table.avgImpressionPosition} * MAX(${table.impressions}, 1)) / SUM(CASE WHEN ${table.avgImpressionPosition} IS NOT NULL THEN MAX(${table.impressions}, 1) END)`,
    avgClickPosition: sql<number | null>`SUM(${table.avgClickPosition} * MAX(${table.clicks}, 1)) / SUM(CASE WHEN ${table.avgClickPosition} IS NOT NULL THEN MAX(${table.clicks}, 1) END)`,
    weeks: sql<number>`COUNT(DISTINCT ${table.date})`,
  }
}

function totalsShape(row: { clicks: number; impressions: number; avgImpressionPosition: number | null; avgClickPosition: number | null; weeks: number }) {
  return {
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
    ctr: ctrOf(Number(row.clicks), Number(row.impressions)),
    avgImpressionPosition: round(row.avgImpressionPosition === null ? null : Number(row.avgImpressionPosition)),
    avgClickPosition: round(row.avgClickPosition === null ? null : Number(row.avgClickPosition)),
    weeks: Number(row.weeks),
  }
}

export async function bingDataRoutes(app: FastifyInstance, opts: BingDataRoutesOptions) {
  // POST /projects/:name/bing/sync
  app.post<{ Params: { name: string } }>('/projects/:name/bing/sync', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    // Refuse before writing a run row, like the GSC sync: a project with no
    // Bing site would otherwise collect a failed run every scheduled refresh.
    opts.requireSite(project.canonicalDomain)

    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: RunKinds['bing-sync'],
      status: RunStatuses.queued,
      trigger: syncRunTrigger(opts.claimScheduledSync, project.name, RunKinds['bing-sync']),
      createdAt: new Date().toISOString(),
    }).run()
    opts.onSyncRequested?.(runId, project.id)
    return app.db.select().from(runs).where(eq(runs.id, runId)).get()
  })

  // GET /projects/:name/bing/traffic
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; days?: string }
  }>('/projects/:name/bing/traffic', async (request): Promise<BingTrafficResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const bounds = app.db
      .select({ latest: sql<string | null>`MAX(${bingTrafficDaily.date})`, earliest: sql<string | null>`MIN(${bingTrafficDaily.date})` })
      .from(bingTrafficDaily)
      .where(eq(bingTrafficDaily.projectId, project.id))
      .get()
    const latest = bounds?.latest ?? null
    const window = resolveBingWindow(request.query, latest)
    const conditions: SQL[] = [eq(bingTrafficDaily.projectId, project.id)]
    if (window.startDate) conditions.push(gte(bingTrafficDaily.date, window.startDate))
    if (window.endDate) conditions.push(lte(bingTrafficDaily.date, window.endDate))
    const rows = latest === null && !request.query.startDate
      ? []
      : app.db.select().from(bingTrafficDaily).where(and(...conditions)).orderBy(asc(bingTrafficDaily.date)).all()
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0)
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0)
    return {
      rows: rows.map((row) => ({ date: row.date, clicks: row.clicks, impressions: row.impressions, ctr: ctrOf(row.clicks, row.impressions) })),
      totals: { clicks, impressions, ctr: ctrOf(clicks, impressions) },
      window,
      latestAvailableDate: latest,
      earliestAvailableDate: bounds?.earliest ?? null,
    }
  })

  function weeklyList<K extends 'query' | 'page'>(
    table: WeeklyTable,
    keyColumn: typeof bingQueryStats.query | typeof bingPageStats.page,
    projectId: string,
    query: { startDate?: string; endDate?: string; days?: string; search?: string; groupBy?: string; limit?: string; offset?: string },
    keyGroup: K,
  ): {
    groupBy: K | 'week'
    keyed: Array<{ key: string } & ReturnType<typeof totalsShape>>
    weekly: BingWeeklyTotalsRowDto[]
    totalMatching: number
    truncated: boolean
    window: { startDate: string | null; endDate: string | null }
    latestAvailableDate: string | null
  } {
    const latest = app.db.select({ latest: sql<string | null>`MAX(${table.date})` }).from(table).where(eq(table.projectId, projectId)).get()?.latest ?? null
    const window = resolveBingWindow(query, latest)
    const groupBy = query.groupBy ?? keyGroup
    if (groupBy !== keyGroup && groupBy !== 'week') {
      throw validationError(`"groupBy" must be ${keyGroup} or week`)
    }
    const conditions: SQL[] = [eq(table.projectId, projectId)]
    if (window.startDate) conditions.push(gte(table.date, window.startDate))
    if (window.endDate) conditions.push(lte(table.date, window.endDate))
    const search = query.search?.trim()
    if (search) conditions.push(sql`${keyColumn} LIKE ${'%' + escapeLikePattern(search) + '%'} ESCAPE '\\'`)
    const where = and(...conditions)
    const empty = latest === null && !query.startDate

    if (groupBy === 'week') {
      const weekly: BingWeeklyTotalsRowDto[] = empty
        ? []
        : app.db
          .select({ date: table.date, ...weeklyAggregates(table) })
          .from(table)
          .where(where)
          .groupBy(table.date)
          .orderBy(asc(table.date))
          .all()
          .map((row) => ({ date: row.date, ...totalsShape(row) }))
      return { groupBy: 'week', keyed: [], weekly, totalMatching: weekly.length, truncated: false, window, latestAvailableDate: latest }
    }

    const limit = parseLimit(query.limit)
    const offset = parseOffset(query.offset)
    const aggregates = weeklyAggregates(table)
    const keyed = empty
      ? []
      : app.db
        .select({ key: keyColumn, ...aggregates })
        .from(table)
        .where(where)
        .groupBy(keyColumn)
        .orderBy(desc(aggregates.clicks), desc(aggregates.impressions), asc(keyColumn))
        .limit(limit)
        .offset(offset)
        .all()
        .map((row) => ({ key: row.key, ...totalsShape(row) }))
    const totalMatching = empty
      ? 0
      : Number(app.db.select({ total: sql<number>`COUNT(DISTINCT ${keyColumn})` }).from(table).where(where).get()?.total ?? 0)
    return { groupBy: keyGroup, keyed, weekly: [], totalMatching, truncated: offset + keyed.length < totalMatching, window, latestAvailableDate: latest }
  }

  // GET /projects/:name/bing/queries
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; days?: string; query?: string; groupBy?: string; limit?: string; offset?: string }
  }>('/projects/:name/bing/queries', async (request): Promise<BingQueryTotalsResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const result = weeklyList(bingQueryStats, bingQueryStats.query, project.id, { ...request.query, search: request.query.query }, 'query')
    return {
      groupBy: result.groupBy,
      rows: result.keyed.map(({ key, ...rest }) => ({ query: key, ...rest })),
      weekly: result.weekly,
      totalMatching: result.totalMatching,
      truncated: result.truncated,
      window: result.window,
      latestAvailableDate: result.latestAvailableDate,
    }
  })

  // GET /projects/:name/bing/pages
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; days?: string; page?: string; groupBy?: string; limit?: string; offset?: string }
  }>('/projects/:name/bing/pages', async (request): Promise<BingPageTotalsResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const result = weeklyList(bingPageStats, bingPageStats.page, project.id, { ...request.query, search: request.query.page }, 'page')
    return {
      groupBy: result.groupBy,
      rows: result.keyed.map(({ key, ...rest }) => ({ page: key, ...rest })),
      weekly: result.weekly,
      totalMatching: result.totalMatching,
      truncated: result.truncated,
      window: result.window,
      latestAvailableDate: result.latestAvailableDate,
    }
  })

  // GET /projects/:name/bing/crawl-stats
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; days?: string }
  }>('/projects/:name/bing/crawl-stats', async (request): Promise<BingCrawlStatsResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const latest = app.db.select({ latest: sql<string | null>`MAX(${bingCrawlStats.date})` }).from(bingCrawlStats).where(eq(bingCrawlStats.projectId, project.id)).get()?.latest ?? null
    const window = resolveBingWindow(request.query, latest)
    const conditions: SQL[] = [eq(bingCrawlStats.projectId, project.id)]
    if (window.startDate) conditions.push(gte(bingCrawlStats.date, window.startDate))
    if (window.endDate) conditions.push(lte(bingCrawlStats.date, window.endDate))
    const rows = latest === null && !request.query.startDate
      ? []
      : app.db.select().from(bingCrawlStats).where(and(...conditions)).orderBy(desc(bingCrawlStats.date)).all()
    return {
      rows: rows.map(({ id: _id, projectId: _projectId, syncRunId: _syncRunId, syncedAt: _syncedAt, ...day }) => day),
      window,
      latestAvailableDate: latest,
    }
  })

  // GET /projects/:name/bing/sitemaps
  app.get<{ Params: { name: string } }>('/projects/:name/bing/sitemaps', async (request): Promise<BingSitemapsResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db.select().from(bingSitemaps).where(eq(bingSitemaps.projectId, project.id))
      .orderBy(sql`${bingSitemaps.parentUrl} IS NOT NULL`, asc(bingSitemaps.url))
      .all()
    return {
      sitemaps: rows.map((row) => ({
        url: row.url,
        parentUrl: row.parentUrl,
        type: row.type,
        status: row.status,
        urlCount: row.urlCount,
        fileSize: row.fileSize,
        compressed: row.compressed,
        submittedAt: row.submittedAt,
        lastCrawledAt: row.lastCrawledAt,
        syncedAt: row.syncedAt,
      })),
      syncedAt: rows.reduce<string | null>((latest, row) => (latest === null || row.syncedAt > latest ? row.syncedAt : latest), null),
    }
  })

  // GET /projects/:name/bing/site
  app.get<{ Params: { name: string }; Querystring: { kind?: string } }>('/projects/:name/bing/site', async (request): Promise<BingSiteResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const conditions: SQL[] = [eq(bingSiteSnapshots.projectId, project.id)]
    if (request.query.kind) {
      const kind = bingSiteSnapshotKindSchema.safeParse(request.query.kind)
      if (!kind.success) throw validationError(`"kind" must be one of: ${bingSiteSnapshotKindSchema.options.join(', ')}`)
      conditions.push(eq(bingSiteSnapshots.kind, kind.data))
    }
    const order = new Map(bingSiteSnapshotKindSchema.options.map((kind, index) => [kind, index]))
    const rows = app.db.select().from(bingSiteSnapshots).where(and(...conditions)).all()
      .filter((row) => bingSiteSnapshotKindSchema.safeParse(row.kind).success)
      .sort((a, b) => (order.get(a.kind as never) ?? 99) - (order.get(b.kind as never) ?? 99))
    return {
      snapshots: rows.map((row) => ({
        kind: bingSiteSnapshotKindSchema.parse(row.kind),
        status: row.status === 'ok' || row.status === 'unauthorized' ? row.status : 'failed',
        payload: row.payload ?? null,
        error: row.error,
        syncedAt: row.syncedAt,
      })),
      syncedAt: rows.reduce<string | null>((latest, row) => (latest === null || row.syncedAt > latest ? row.syncedAt : latest), null),
    }
  })

  // GET /projects/:name/bing/keyword-demand
  app.get<{ Params: { name: string }; Querystring: { query?: string } }>('/projects/:name/bing/keyword-demand', async (request): Promise<BingKeywordDemandResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const market = bingKeywordMarket(project.country, project.language)
    const marketWhere = and(
      eq(bingKeywordDemand.projectId, project.id),
      eq(bingKeywordDemand.country, market.country),
      eq(bingKeywordDemand.language, market.language),
    )
    const stored = app.db.select().from(bingKeywordDemand).where(marketWhere).orderBy(asc(bingKeywordDemand.date)).all()
    const byQuery = new Map<string, typeof stored>()
    for (const row of stored) {
      const list = byQuery.get(row.query) ?? []
      list.push(row)
      byQuery.set(row.query, list)
    }
    // Every tracked query gets a row, read or not, so a gap is visible.
    const tracked = app.db.select({ query: queries.query }).from(queries).where(eq(queries.projectId, project.id)).orderBy(asc(queries.query)).all()
    const names = [...new Set([...tracked.map((row) => row.query), ...byQuery.keys()])]
    const rows = names.map((name) => {
      const weeks = byQuery.get(name) ?? []
      const newest = weeks.at(-1) ?? null
      return {
        query: name,
        country: market.country,
        language: market.language,
        latestWeek: newest?.date ?? null,
        latestImpressions: newest?.impressions ?? null,
        latestBroadImpressions: newest?.broadImpressions ?? null,
        avgWeeklyImpressions: weeks.length > 0 ? Math.round((weeks.reduce((sum, w) => sum + w.impressions, 0) / weeks.length) * 10) / 10 : null,
        weeks: weeks.length,
        syncedAt: weeks.reduce<string | null>((latest, w) => (latest === null || w.syncedAt > latest ? w.syncedAt : latest), null),
      }
    }).sort((a, b) => (b.avgWeeklyImpressions ?? -1) - (a.avgWeeklyImpressions ?? -1) || a.query.localeCompare(b.query))
    const requested = request.query.query?.trim()
    const history = requested
      ? (byQuery.get(requested) ?? []).map((week) => ({ date: week.date, impressions: week.impressions, broadImpressions: week.broadImpressions }))
      : []
    return { market, rows, history }
  })

  // ── Live reads ──────────────────────────────────────────────────────────

  // GET /projects/:name/bing/query-pages
  app.get<{ Params: { name: string }; Querystring: { query?: string } }>('/projects/:name/bing/query-pages', async (request): Promise<BingQueryPagesResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const searchQuery = requireText(request.query.query, 'query')
    const site = opts.requireSite(project.canonicalDomain)
    const rows = await liveRead('pages for this query', () => getQueryPageStats(site.apiKey, site.siteUrl, searchQuery))
    return { query: searchQuery, rows: statsRows(rows) }
  })

  // GET /projects/:name/bing/page-queries
  app.get<{ Params: { name: string }; Querystring: { page?: string } }>('/projects/:name/bing/page-queries', async (request): Promise<BingPageQueriesResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const page = requireHttpUrl(request.query.page, 'page')
    const site = opts.requireSite(project.canonicalDomain)
    const rows = await liveRead('queries for this page', () => getPageQueryStats(site.apiKey, site.siteUrl, page))
    return { page, rows: statsRows(rows) }
  })

  // GET /projects/:name/bing/query-history
  app.get<{ Params: { name: string }; Querystring: { query?: string; page?: string } }>('/projects/:name/bing/query-history', async (request): Promise<BingQueryHistoryResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const searchQuery = requireText(request.query.query, 'query')
    const page = request.query.page ? requireHttpUrl(request.query.page, 'page') : null
    const site = opts.requireSite(project.canonicalDomain)
    if (page) {
      const rows = await liveRead('this query on this page', () => getQueryPageDetailStats(site.apiKey, site.siteUrl, searchQuery, page))
      return {
        query: searchQuery,
        page,
        granularity: 'week',
        rows: rows
          .map((row) => ({ date: bingDateToDay(row.Date), clicks: Math.max(0, row.Clicks ?? 0), impressions: Math.max(0, row.Impressions ?? 0), ctr: ctrOf(row.Clicks ?? 0, row.Impressions ?? 0), position: bingPositionOrNull(row.Position) }))
          .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
      }
    }
    const rows = await liveRead('this query', () => getQueryTrafficStats(site.apiKey, site.siteUrl, searchQuery))
    return {
      query: searchQuery,
      page: null,
      granularity: 'day',
      rows: rows
        .map((row) => ({ date: bingDateToDay(row.Date), clicks: Math.max(0, row.Clicks ?? 0), impressions: Math.max(0, row.Impressions ?? 0), ctr: ctrOf(row.Clicks ?? 0, row.Impressions ?? 0), position: null }))
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
    }
  })

  // GET /projects/:name/bing/url-traffic
  app.get<{ Params: { name: string }; Querystring: { url?: string; children?: string; page?: string } }>('/projects/:name/bing/url-traffic', async (request): Promise<BingUrlTrafficResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const url = requireHttpUrl(request.query.url, 'url')
    const page = parsePage(request.query.page)
    const withChildren = request.query.children === 'true' || request.query.children === '1'
    const site = opts.requireSite(project.canonicalDomain)
    const info = await liveRead('traffic for this URL', () => getUrlTrafficInfo(site.apiKey, site.siteUrl, url))
    const children = withChildren
      ? await liveRead('traffic for the URLs under this one', () => getChildrenUrlTrafficInfo(site.apiKey, site.siteUrl, url, page))
      : []
    const shape = (row: { Url?: string; Clicks?: number; Impressions?: number; IsPage?: boolean } | undefined, fallbackUrl: string) => ({
      url: row?.Url ?? fallbackUrl,
      clicks: Math.max(0, row?.Clicks ?? 0),
      impressions: Math.max(0, row?.Impressions ?? 0),
      isPage: row?.IsPage === true,
    })
    return { url: shape(info, url), children: children.map((row) => shape(row, row.Url)), page }
  })

  // GET /projects/:name/bing/url-children
  app.get<{ Params: { name: string }; Querystring: { url?: string; page?: string } }>('/projects/:name/bing/url-children', async (request): Promise<BingUrlChildrenResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const url = requireHttpUrl(request.query.url, 'url')
    const page = parsePage(request.query.page)
    const site = opts.requireSite(project.canonicalDomain)
    const rows = await liveRead('the URLs under this one', () => getChildrenUrlInfo(site.apiKey, site.siteUrl, url, page))
    return {
      url,
      page,
      rows: rows.map((row) => ({
        url: row.Url,
        httpStatus: typeof row.HttpStatus === 'number' ? row.HttpStatus : null,
        documentSize: typeof row.DocumentSize === 'number' ? row.DocumentSize : null,
        anchorCount: typeof row.AnchorCount === 'number' ? row.AnchorCount : null,
        isPage: typeof row.IsPage === 'boolean' ? row.IsPage : null,
        totalChildUrlCount: typeof row.TotalChildUrlCount === 'number' ? row.TotalChildUrlCount : null,
        discoveryDate: parseBingDate(row.DiscoveryDate ?? null),
        lastCrawledDate: parseBingDate(row.LastCrawledDate ?? null),
      })),
    }
  })

  // GET /projects/:name/bing/links
  app.get<{ Params: { name: string }; Querystring: { url?: string; page?: string } }>('/projects/:name/bing/links', async (request): Promise<BingLinksResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const url = request.query.url ? requireHttpUrl(request.query.url, 'url') : null
    const page = parsePage(request.query.page)
    const site = opts.requireSite(project.canonicalDomain)
    if (url) {
      const links = await liveRead('inbound links for this URL', () => getUrlLinks(site.apiKey, site.siteUrl, url, page))
      return { url, page, totalPages: links.TotalPages, rows: links.Details.map((row) => ({ url: row.Url, count: null, anchorText: row.AnchorText ?? null })) }
    }
    const counts = await liveRead('inbound link counts', () => getLinkCounts(site.apiKey, site.siteUrl, page))
    return { url: null, page, totalPages: counts.TotalPages, rows: counts.Links.map((row) => ({ url: row.Url, count: Math.max(0, row.Count ?? 0), anchorText: null })) }
  })

  // GET /projects/:name/bing/fetched-urls
  app.get<{ Params: { name: string }; Querystring: { url?: string } }>('/projects/:name/bing/fetched-urls', async (request): Promise<BingFetchedUrlsResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const url = request.query.url ? requireHttpUrl(request.query.url, 'url') : null
    const site = opts.requireSite(project.canonicalDomain)
    if (url) {
      const details = await liveRead('the Fetch as Bingbot result', () => getFetchedUrlDetails(site.apiKey, site.siteUrl, url))
      return {
        rows: [],
        details: details
          ? {
              url: details.Url ?? url,
              date: parseBingDate(details.Date ?? null),
              status: details.Status ?? null,
              headers: details.Headers ?? null,
              document: details.Document ?? null,
            }
          : null,
      }
    }
    const rows = await liveRead('Fetch as Bingbot history', () => getFetchedUrls(site.apiKey, site.siteUrl))
    return {
      rows: rows.map((row) => ({
        url: row.Url,
        date: parseBingDate(row.Date ?? null),
        expired: typeof row.Expired === 'boolean' ? row.Expired : null,
        fetched: typeof row.Fetched === 'boolean' ? row.Fetched : null,
      })),
      details: null,
    }
  })

  // GET /projects/:name/bing/keywords
  app.get<{
    Params: { name: string }
    Querystring: { keyword?: string; country?: string; language?: string; startDate?: string; endDate?: string }
  }>('/projects/:name/bing/keywords', async (request): Promise<BingKeywordResearchResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const keyword = requireText(request.query.keyword, 'keyword')
    const projectMarket = bingKeywordMarket(project.country, project.language)
    const market = {
      country: request.query.country?.trim().toLowerCase() || projectMarket.country,
      language: request.query.language?.trim() || projectMarket.language,
    }
    assertForwardRange(request.query.startDate, request.query.endDate)
    const today = new Date().toISOString().slice(0, 10)
    const endDate = request.query.endDate ?? today
    const startDate = request.query.startDate ?? shiftDay(endDate, -(BING_DEFAULT_WINDOW_DAYS - 1))
    const apiKey = opts.requireApiKey(project.canonicalDomain)
    // Three independent Bing reads; sequential so one request never fans out
    // into a burst on the shared account limit.
    const volume = await liveRead('keyword volume', () => getKeyword(apiKey, keyword, market, startDate, endDate))
    const history = await liveRead('keyword history', () => getKeywordHistory(apiKey, keyword, market))
    const related = await liveRead('related keywords', () => getRelatedKeywords(apiKey, keyword, market, startDate, endDate))
    return {
      keyword,
      market,
      window: { startDate, endDate },
      volume: volume ? { impressions: Math.max(0, volume.Impressions ?? 0), broadImpressions: Math.max(0, volume.BroadImpressions ?? 0) } : null,
      history: history
        .map((week) => ({ date: bingDateToDay(week.Date), impressions: Math.max(0, week.Impressions ?? 0), broadImpressions: Math.max(0, week.BroadImpressions ?? 0) }))
        .filter((week): week is { date: string; impressions: number; broadImpressions: number } => week.date !== null)
        .sort((a, b) => a.date.localeCompare(b.date)),
      related: related
        .map((row) => ({ query: row.Query, impressions: Math.max(0, row.Impressions ?? 0), broadImpressions: Math.max(0, row.BroadImpressions ?? 0) }))
        .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query)),
    }
  })
}
