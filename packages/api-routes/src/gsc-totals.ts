import { and, asc, eq, sql, max, min } from 'drizzle-orm'
import { gscDailyTotals, gscQueryDailyTotals, gscSearchData, gscDataWatermarks } from '@ainyc/canonry-db'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { shiftIsoCalendarDate, type MetricsWindow } from '@ainyc/canonry-contracts'

export interface GscDailyTotal {
  date: string
  clicks: number
  impressions: number
  position: number
}

/** Days a labelled rolling window covers. `all` has no fixed span. */
const WINDOW_DAYS: Record<Exclude<MetricsWindow, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 }

/**
 * The inclusive date range a labelled GSC window actually covers, plus the
 * reporting lag that decided it.
 */
export interface GscWindowRange {
  /** Inclusive lower bound, or `null` for `all`. */
  startDate: string | null
  /** Inclusive upper bound: the latest date the property has published. */
  endDate: string | null
  /** `MAX(date)` across the project's GSC data, ignoring any window. */
  latestDataDate: string | null
  /**
   * Calendar days between `latestDataDate` and today, on GSC's Pacific
   * calendar. `null` with no data.
   *
   * This is NOT Google's publication lag, and must never be labelled as one.
   * The Search Analytics API returns no row for a day with no data, so a day
   * that Google HAS published but on which the property earned zero
   * impressions is indistinguishable from a day Google has not published yet.
   * A quiet tail therefore inflates this number. It measures exactly what it
   * says — how long since we last recorded traffic — and any surface reading
   * it must phrase it that way ("data through X"), never as a claim about
   * Google being behind.
   */
  daysSinceLatestData: number | null
}

/**
 * Resolve a labelled window against the last day Search Console actually
 * published, NOT against the clock.
 *
 * Google publishes search analytics on a two-to-three day delay, so the most
 * recent days of a now-anchored window are dates that cannot ever hold data.
 * Anchoring `30d` at today therefore returns 27 or 28 days of data under a
 * label that promises 30, and the shortfall grows as the window shrinks: a
 * `7d` window spends three of its seven days on the lag and delivers four.
 *
 * Worse, the shortfall is invisible and it is not monotonic across labels.
 * Canonry's now-anchored `30d` covered 2026-07-13..2026-08-09 while Search
 * Console's own `28 days` covered 2026-07-14..2026-08-10 — neither range
 * contains the other, so the wider Canonry window reported FEWER impressions
 * (1,174) than the narrower Google one (1,360). A total that moves the wrong
 * way when you widen the window reads as missing data, and there is no way for
 * an operator to tell that apart from a real decline.
 *
 * Anchoring on the last published day is what Search Console's own UI does, so
 * `30d` means thirty days of data and the two surfaces become comparable.
 *
 * `today` is injected rather than read from the clock so this stays pure and
 * testable, matching the `gbp-summary` precedent.
 */
export function resolveGscWindowRange(
  window: MetricsWindow,
  latestDataDate: string | null,
  today: string,
): GscWindowRange {
  // `all` has no lower bound to place, but it still stops where the data does.
  if (window === 'all') {
    return {
      startDate: null,
      endDate: latestDataDate,
      latestDataDate,
      daysSinceLatestData: gscDaysSinceLatestData(latestDataDate, today),
    }
  }
  return resolveGscWindowDays(WINDOW_DAYS[window], latestDataDate, today)
}

/**
 * The same anchoring for a window expressed as a day count rather than a
 * label.
 *
 * Surfaces that hard-code their own horizon (the suggested-queries basket
 * mirrors Google's 28-day default) need identical treatment: a now-anchored
 * 28 days delivers 25 under the reporting lag. There, the shortfall does more
 * than shrink a number — the surface gates an impression floor, so a query
 * that clears the floor across the true window can fall under it and be
 * withheld entirely.
 */
export function resolveGscWindowDays(
  days: number,
  latestDataDate: string | null,
  today: string,
): GscWindowRange {
  // With no data there is no anchor: fall back to the now-anchored cutoff so
  // an empty project still filters rather than scanning all history.
  if (latestDataDate === null) {
    return {
      startDate: shiftIsoCalendarDate(today, -days),
      endDate: null,
      latestDataDate: null,
      daysSinceLatestData: null,
    }
  }
  // `days - 1`, because the range is INCLUSIVE at both ends: a 7-day window
  // ending on the 10th starts on the 4th, not the 3rd.
  return {
    startDate: shiftIsoCalendarDate(latestDataDate, -(days - 1)),
    endDate: latestDataDate,
    latestDataDate,
    daysSinceLatestData: gscDaysSinceLatestData(latestDataDate, today),
  }
}

/**
 * The range a request reads when it may carry a labelled window AND explicit
 * `startDate` / `endDate` bounds. The result is the range to query with and
 * the range to report, so the two cannot drift apart.
 *
 * - Both dates: exactly those dates. The label is ignored.
 * - `endDate` only: the label's span, anchored on that end date (the same
 *   anchoring the report uses). Anchoring on the published frontier instead
 *   would put a `30d` lower bound AFTER an earlier explicit end, and the range
 *   would be empty although the stored rows exist. `all` stays open at the
 *   start.
 * - `startDate` only: from that date to the label's end, the last published
 *   day. A start past that day leaves the end open (`null`) rather than
 *   reporting a range that runs backwards.
 * - Neither: `resolveGscWindowRange`.
 *
 * A `null` side means unbounded, both in the report and in the read. The
 * caller refuses malformed or reversed explicit bounds first
 * (`assertForwardRange`).
 */
export function resolveGscRequestWindow(
  window: MetricsWindow,
  latestDataDate: string | null,
  today: string,
  startDate: string | undefined,
  endDate: string | undefined,
): GscWindowRange {
  const resolved = resolveGscWindowRange(window, latestDataDate, today)
  if (endDate !== undefined && startDate === undefined) {
    return {
      ...resolved,
      startDate: window === 'all' ? null : shiftIsoCalendarDate(endDate, -(WINDOW_DAYS[window] - 1)),
      endDate,
    }
  }
  const start = startDate ?? resolved.startDate
  const end = endDate ?? resolved.endDate
  return {
    ...resolved,
    startDate: start,
    endDate: start !== null && end !== null && start > end ? null : end,
  }
}

/** Calendar days between the last published date and today. Never negative. */
function gscDaysSinceLatestData(latestDataDate: string | null, today: string): number | null {
  if (latestDataDate === null) return null
  return Math.max(0, Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latestDataDate}T00:00:00Z`)) / 86_400_000,
  ))
}

/**
 * The furthest GSC reporting date a project has reached — the anchor every
 * window hangs off.
 *
 * `MAX(date)` over the stored rows ALONE is not a frontier. Search Analytics
 * returns no row for a day with no data, so on a quiet property the observed
 * max walks backward and drags every anchored window back with it: a `30d`
 * window slides into the previous month and its totals change for a reason
 * that has nothing to do with the site's performance.
 *
 * So the persisted `gsc_data_watermarks.data_through_date` — which a sync may
 * only ADVANCE — takes precedence, and the observed max is a floor under it
 * for projects that synced before the watermark existed. A quiet tail can
 * then leave the frontier where it is instead of moving it backward.
 *
 * Both stored tables are consulted for that floor because they sync
 * independently: a project from before `gsc_daily_totals` existed has only
 * dimensioned rows, and anchoring behind data the endpoint is about to return
 * would cut it off.
 */
export function readLatestGscDataDate(db: DatabaseClient, projectId: string): string | null {
  const watermark = db.select({ through: gscDataWatermarks.dataThroughDate })
    .from(gscDataWatermarks).where(eq(gscDataWatermarks.projectId, projectId)).get()?.through ?? null
  const property = db.select({ latest: max(gscDailyTotals.date) })
    .from(gscDailyTotals).where(eq(gscDailyTotals.projectId, projectId)).get()?.latest ?? null
  const dimensioned = db.select({ latest: max(gscSearchData.date) })
    .from(gscSearchData).where(eq(gscSearchData.projectId, projectId)).get()?.latest ?? null
  return [watermark, property, dimensioned]
    .filter((d): d is string => d !== null)
    .reduce<string | null>((maxDate, d) => (maxDate === null || d > maxDate ? d : maxDate), null)
}

/**
 * The earliest GSC reporting date a project has stored — the floor under any
 * period a surface is willing to reach back to.
 *
 * The mirror of `readLatestGscDataDate`, and it exists for the same reason.
 * Search Analytics omits days with no data, so a date carrying no stored row is
 * ambiguous: INSIDE the synced span it is a real zero-count day, but BEFORE the
 * earliest row it may equally be a day nobody ever fetched. Counting the second
 * as zero lets a half-synced baseline manufacture growth — a prior period the
 * backfill only half reaches reads as half the traffic it actually had, and the
 * tile above it prints a rise that never happened.
 *
 * There is no `data_from_date` watermark to consult: `gsc_data_watermarks`
 * records only how far FORWARD a sync has reached. The observed minimum across
 * both stored tables is therefore the frontier, and a quiet LEADING stretch
 * walks it forward — withholding a comparison that could have been made. That
 * is the safe direction to be wrong in, and it is the same trade the top-end
 * frontier already takes.
 *
 * Both tables are consulted for the same reason `readLatestGscDataDate`
 * consults both: they sync independently, and a project from before
 * `gsc_daily_totals` existed has only dimensioned rows. A period that reaches
 * into dimensioned-only history is not silently trusted either — it aggregates
 * to `source: 'dimensioned'`, which the comparison marks not comparable.
 */
export function readEarliestGscDataDate(db: DatabaseClient, projectId: string): string | null {
  const property = db.select({ earliest: min(gscDailyTotals.date) })
    .from(gscDailyTotals).where(eq(gscDailyTotals.projectId, projectId)).get()?.earliest ?? null
  const dimensioned = db.select({ earliest: min(gscSearchData.date) })
    .from(gscSearchData).where(eq(gscSearchData.projectId, projectId)).get()?.earliest ?? null
  return [property, dimensioned]
    .filter((d): d is string => d !== null)
    .reduce<string | null>((earliest, d) => (earliest === null || d < earliest ? d : earliest), null)
}

/**
 * Read the property-level daily GSC totals for a project over an inclusive
 * `[startDate, endDate]` window, ordered by date ascending.
 *
 * These rows come from the un-dimensioned (`dimensions: ['date']`) GSC sync and
 * are the CORRECT source for the headline clicks / impressions / CTR / position
 * and the daily trend on dates where they exist — summing the dimensioned
 * `gsc_search_data` rows does not equal Google's property total.
 */
export function readGscDailyTotals(
  db: DatabaseClient,
  projectId: string,
  startDate: string,
  endDate: string,
): GscDailyTotal[] {
  const rows = db
    .select({
      date: gscDailyTotals.date,
      clicks: gscDailyTotals.clicks,
      impressions: gscDailyTotals.impressions,
      position: gscDailyTotals.position,
    })
    .from(gscDailyTotals)
    .where(
      and(
        eq(gscDailyTotals.projectId, projectId),
        sql`${gscDailyTotals.date} >= ${startDate}`,
        sql`${gscDailyTotals.date} <= ${endDate}`,
      ),
    )
    .orderBy(asc(gscDailyTotals.date))
    .all()

  return rows.map((r) => {
    const position = Number(r.position)
    return {
      date: r.date,
      clicks: r.clicks,
      impressions: r.impressions,
      position: Number.isFinite(position) ? position : 0,
    }
  })
}

export function mergeGscDailyTotalsWithFallback(
  propertyTotals: readonly GscDailyTotal[],
  dimensionedFallback: readonly GscDailyTotal[],
): GscDailyTotal[] {
  const byDate = new Map<string, GscDailyTotal>()
  for (const row of dimensionedFallback) byDate.set(row.date, row)
  for (const row of propertyTotals) byDate.set(row.date, row)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** One (date, query) observation. The grain BOTH sources share. */
export interface GscQueryDayRow {
  date: string
  query: string
  clicks: number
  impressions: number
  position: number
}

export interface GscQueryTotal {
  query: string
  clicks: number
  impressions: number
  /** Impression-weighted across the days in the window. */
  position: number
}

export interface GscQueryAggregate extends GscQueryTotal {
  /**
   * How this query's window was sourced.
   *
   * `google` — every day came from the un-dimensioned `['date','query']` fetch
   * (accurate). `page-summed` — every day came from the legacy
   * `gsc_search_data` sum, whose impressions are inflated by the `page`
   * fan-out. `mixed` — the window spans both, which is the normal state while
   * a backfill is partial: recent days accurate, older days not.
   *
   * A `mixed` total is deliberately NOT suppressed. Dropping the legacy days
   * would silently shorten the window and undercount; blending them without
   * saying so would overstate. The caller is told instead.
   */
  source: 'google' | 'page-summed' | 'mixed'
  /**
   * Distinct dates the query appeared on in the window, across both sources.
   * A day covered by both counts once: the merge keeps one row per
   * (date, query).
   */
  days: number
}

/**
 * Read per-(date, query) rows from the accurate un-dimensioned fetch over an
 * inclusive `[startDate, endDate]` window.
 *
 * Deliberately NOT pre-aggregated. The merge below has to happen at day grain,
 * because a partially-backfilled query has accurate rows for only part of the
 * window and must keep its legacy rows for the rest.
 */
export function readGscQueryDailyRows(
  db: DatabaseClient,
  projectId: string,
  startDate: string,
  endDate: string,
): GscQueryDayRow[] {
  const rows = db
    .select({
      date: gscQueryDailyTotals.date,
      query: gscQueryDailyTotals.query,
      clicks: gscQueryDailyTotals.clicks,
      impressions: gscQueryDailyTotals.impressions,
      position: gscQueryDailyTotals.position,
    })
    .from(gscQueryDailyTotals)
    .where(
      and(
        eq(gscQueryDailyTotals.projectId, projectId),
        sql`${gscQueryDailyTotals.date} >= ${startDate}`,
        sql`${gscQueryDailyTotals.date} <= ${endDate}`,
      ),
    )
    .all()

  return rows.map((r) => {
    const position = Number(r.position)
    return {
      date: r.date,
      query: r.query,
      clicks: r.clicks,
      impressions: r.impressions,
      position: Number.isFinite(position) ? position : 0,
    }
  })
}

/**
 * Read per-(date, query) rows from the legacy dimensioned `gsc_search_data`
 * table over an inclusive `[startDate, endDate]` window, folded across its
 * `page` / `country` / `device` rows.
 *
 * This is the FALLBACK side of `mergeGscQueryTotalsWithFallback`. Its
 * impressions over-count (one SERP showing several of the site's pages becomes
 * several rows), which is why the merge prefers the accurate table wherever it
 * has the day. Position is TEXT in this table, so it is cast explicitly before
 * the impression weighting. Empty queries (the sync writes `query ?? ''`) and
 * zero-impression rows are left out: neither names a query anyone searched.
 */
export function readGscQueryDailyFallbackRows(
  db: DatabaseClient,
  projectId: string,
  startDate: string,
  endDate: string,
): GscQueryDayRow[] {
  const rows = db
    .select({
      date: gscSearchData.date,
      query: gscSearchData.query,
      clicks: sql<number>`COALESCE(SUM(${gscSearchData.clicks}), 0)`,
      impressions: sql<number>`COALESCE(SUM(${gscSearchData.impressions}), 0)`,
      position: sql<number>`COALESCE(SUM(CAST(${gscSearchData.position} AS REAL) * ${gscSearchData.impressions}) * 1.0 / NULLIF(SUM(${gscSearchData.impressions}), 0), 0)`,
    })
    .from(gscSearchData)
    .where(
      and(
        eq(gscSearchData.projectId, projectId),
        sql`${gscSearchData.date} >= ${startDate}`,
        sql`${gscSearchData.date} <= ${endDate}`,
        sql`${gscSearchData.query} <> ''`,
        sql`${gscSearchData.impressions} > 0`,
      ),
    )
    .groupBy(gscSearchData.date, gscSearchData.query)
    .all()

  return rows.map((r) => ({
    date: r.date,
    query: r.query,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    position: Number(r.position),
  }))
}

export interface GscQueryTotalsPage {
  /** This page, ordered clicks desc, impressions desc, query asc by code point. */
  rows: GscQueryAggregate[]
  /** Every query in the window, ignoring `limit` / `offset`. */
  totalMatching: number
}

/**
 * One page of `mergeGscQueryTotalsWithFallback`, computed in SQLite so a page
 * reads only its own rows into the process.
 *
 * The merge in JS needs both sources' (date, query) rows for the WHOLE window
 * in memory before it can aggregate, sort and slice, so `limit=1` on a busy
 * property still built every row. Here the same steps run in the database:
 *
 * 1. Source per (date, query): the accurate `gsc_query_daily_totals` row when
 *    one exists, otherwise the `gsc_search_data` rows under the same filters
 *    as `readGscQueryDailyFallbackRows` (text position cast to REAL and
 *    impression-weighted, empty queries and zero-impression rows left out).
 * 2. Per query: summed clicks and impressions, impression-weighted position
 *    with the plain daily mean when the window has no impressions, the count of
 *    merged days, and the `google` / `page-summed` / `mixed` tag.
 * 3. Order, then `LIMIT` / `OFFSET`. `ORDER BY query` uses SQLite's BINARY
 *    collation, a byte compare of UTF-8, which is code point order.
 *
 * `startDate` / `endDate` are inclusive; `null` leaves that side open. The
 * figures must stay identical to `mergeGscQueryTotalsWithFallback` over the
 * two readers; a parity test holds them together (position to 1e-12
 * relative, since SQLite's SUM() compensates float rounding and the JS loop
 * does not).
 */
export function readGscQueryTotalsPage(
  db: DatabaseClient,
  projectId: string,
  startDate: string | null,
  endDate: string | null,
  limit: number,
  offset: number,
): GscQueryTotalsPage {
  const from = startDate ?? ''
  const to = endDate ?? '9999-12-31'
  // SQLite refuses a LIMIT / OFFSET past 64-bit integers ("datatype mismatch"),
  // and a caller may send any digits. Past 2^53 no page could hold rows anyway.
  const bound = (n: number, floor: number) => Math.min(Math.max(Math.floor(n), floor), Number.MAX_SAFE_INTEGER)
  const pageLimit = bound(limit, 1)
  const pageOffset = bound(offset, 0)
  // Source selection happens on the raw legacy rows: a `gsc_search_data` row
  // counts only when the accurate table has no row for its (date, query). The
  // legacy rows are then folded per query directly rather than per day first.
  // That is the same sum, since every kept legacy day has impressions > 0 and
  // (sum(p*i) / sum(i)) * sum(i) = sum(p*i), and it skips a (date, query) sort
  // of the whole legacy window. Its days are the distinct dates left.
  //
  // A query's plain-mean fallback only applies when its window has no
  // impressions, which means no legacy day at all, so the legacy side adds
  // nothing to `position_sum`.
  const perQuery = sql`
    WITH accurate AS (
      SELECT query, clicks, impressions,
        COALESCE(CAST(position AS REAL), 0) AS position
      FROM gsc_query_daily_totals
      WHERE project_id = ${projectId} AND date >= ${from} AND date <= ${to}
    ),
    legacy AS (
      SELECT l.query, l.date, l.clicks, l.impressions,
        CAST(l.position AS REAL) * l.impressions AS weighted_position
      FROM gsc_search_data l
      WHERE l.project_id = ${projectId} AND l.date >= ${from} AND l.date <= ${to}
        AND l.query <> '' AND l.impressions > 0
        AND NOT EXISTS (
          SELECT 1 FROM gsc_query_daily_totals a
          WHERE a.project_id = ${projectId} AND a.date = l.date AND a.query = l.query
        )
    ),
    per_query AS (
      SELECT query,
        SUM(clicks) AS clicks,
        SUM(impressions) AS impressions,
        SUM(weighted_position) AS weighted_position_sum,
        SUM(position) AS position_sum,
        SUM(days) AS days,
        MAX(accurate) AS saw_accurate,
        MIN(accurate) AS all_accurate
      FROM (
        SELECT query, clicks, impressions, position * impressions AS weighted_position,
          position, 1 AS days, 1 AS accurate
        FROM accurate
        UNION ALL
        SELECT query, SUM(clicks), SUM(impressions), SUM(weighted_position),
          0, COUNT(DISTINCT date), 0
        FROM legacy
        GROUP BY query
      )
      GROUP BY query
    )`

  const rows = db.all<{
    query: string
    clicks: number
    impressions: number
    position: number | null
    days: number
    source: GscQueryAggregate['source']
    total_matching: number
  }>(sql`${perQuery}
    SELECT query, clicks, impressions,
      CASE WHEN impressions > 0 THEN weighted_position_sum * 1.0 / impressions
        ELSE position_sum * 1.0 / days END AS position,
      days,
      CASE WHEN saw_accurate = 1 AND all_accurate = 0 THEN 'mixed'
        WHEN saw_accurate = 1 THEN 'google'
        ELSE 'page-summed' END AS source,
      COUNT(*) OVER () AS total_matching
    FROM per_query
    ORDER BY clicks DESC, impressions DESC, query ASC
    LIMIT ${pageLimit} OFFSET ${pageOffset}`)

  // The window count rides on every returned row; a page past the end returns
  // none, so only then is the count read on its own.
  const totalMatching = rows.length > 0
    ? Number(rows[0]!.total_matching)
    // COUNT(*) always yields one row.
    : Number(db.get<{ total: number }>(sql`${perQuery} SELECT COUNT(*) AS total FROM per_query`).total)

  return {
    rows: rows.map((r) => ({
      query: r.query,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      position: Number(r.position ?? 0),
      days: Number(r.days),
      source: r.source,
    })),
    totalMatching,
  }
}

interface QueryAccumulator {
  clicks: number
  impressions: number
  weightedPositionSum: number
  positionSum: number
  positionDays: number
  sawAccurate: boolean
  sawLegacy: boolean
}

/**
 * Merge the accurate and legacy sources at (date, query) grain, THEN aggregate
 * to one row per query.
 *
 * Order matters. Aggregating first and preferring the accurate total would
 * replace a query's whole-window legacy figure with an accurate figure covering
 * only the backfilled days — silently truncating a 90-day report to whatever
 * the backfill has reached, and undercounting. Merging per day keeps every day
 * in the window and uses the best source available for each one.
 *
 * `position` is impression-weighted across the merged days, which is the
 * correct way to combine Google's own per-day per-query averages: a
 * 1-impression day must not weigh as much as a 500-impression one.
 */
export function mergeGscQueryTotalsWithFallback(
  accurateDays: readonly GscQueryDayRow[],
  fallbackDays: readonly GscQueryDayRow[],
): GscQueryAggregate[] {
  const dayKey = (r: GscQueryDayRow): string => `${r.date}\u0000${r.query}`

  // Per (date, query): accurate wins, legacy fills the gap.
  const byDay = new Map<string, { row: GscQueryDayRow; accurate: boolean }>()
  for (const row of fallbackDays) byDay.set(dayKey(row), { row, accurate: false })
  for (const row of accurateDays) byDay.set(dayKey(row), { row, accurate: true })

  const byQuery = new Map<string, QueryAccumulator>()
  for (const { row, accurate } of byDay.values()) {
    const acc = byQuery.get(row.query) ?? {
      clicks: 0,
      impressions: 0,
      weightedPositionSum: 0,
      positionSum: 0,
      positionDays: 0,
      sawAccurate: false,
      sawLegacy: false,
    }
    acc.clicks += row.clicks
    acc.impressions += row.impressions
    acc.weightedPositionSum += row.position * row.impressions
    // Unweighted fallback so a window whose every day has zero impressions
    // still reports the position Google gave, rather than collapsing to 0.
    acc.positionSum += row.position
    acc.positionDays += 1
    if (accurate) acc.sawAccurate = true
    else acc.sawLegacy = true
    byQuery.set(row.query, acc)
  }

  return [...byQuery.entries()].map(([query, acc]) => ({
    query,
    clicks: acc.clicks,
    impressions: acc.impressions,
    position:
      acc.impressions > 0
        ? acc.weightedPositionSum / acc.impressions
        : acc.positionDays > 0
          ? acc.positionSum / acc.positionDays
          : 0,
    source: acc.sawAccurate && acc.sawLegacy ? 'mixed' : acc.sawAccurate ? 'google' : 'page-summed',
    // One merged row per (date, query), so this is the distinct-date count.
    days: acc.positionDays,
  }))
}
