import { and, asc, eq, sql } from 'drizzle-orm'
import { gscDailyTotals, gscQueryDailyTotals } from '@ainyc/canonry-db'
import type { DatabaseClient } from '@ainyc/canonry-db'

export interface GscDailyTotal {
  date: string
  clicks: number
  impressions: number
  position: number
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

export interface GscQueryTotal {
  query: string
  clicks: number
  impressions: number
  /** Google's own per-query average position, impression-weighted by Google. */
  position: number
}

export interface GscQueryAggregate extends GscQueryTotal {
  /**
   * `google` when the figures come from the un-dimensioned per-query fetch
   * (accurate). `page-summed` when the window predates that fetch and the
   * numbers are the legacy `gsc_search_data` sum, whose impressions are
   * inflated by the `page` fan-out. Never mix the two in one comparison
   * without saying which is which.
   */
  source: 'google' | 'page-summed'
}

/**
 * Read per-query daily totals over an inclusive `[startDate, endDate]` window
 * and fold them to one row per query.
 *
 * These come from the `dimensions: ['date', 'query']` sync, which carries NO
 * `page` dimension, so Google collapses a SERP showing several of the site's
 * URLs into the single impression it actually was. Summing `gsc_search_data`
 * by query instead multiplies impressions by how many pages ranked together.
 *
 * `position` is re-weighted by impressions across the days in the window,
 * which is the correct way to combine Google's own per-day per-query averages.
 */
export function readGscQueryTotals(
  db: DatabaseClient,
  projectId: string,
  startDate: string,
  endDate: string,
): GscQueryTotal[] {
  const rows = db
    .select({
      query: gscQueryDailyTotals.query,
      clicks: sql<number>`COALESCE(SUM(${gscQueryDailyTotals.clicks}), 0)`,
      impressions: sql<number>`COALESCE(SUM(${gscQueryDailyTotals.impressions}), 0)`,
      // Impression-weighted mean of Google's per-day per-query positions. A
      // plain AVG would let a 1-impression day count as much as a 500-impression
      // one; position is not additive across days.
      position: sql<number>`COALESCE(SUM(${gscQueryDailyTotals.position} * ${gscQueryDailyTotals.impressions}) * 1.0 / NULLIF(SUM(${gscQueryDailyTotals.impressions}), 0), 0)`,
    })
    .from(gscQueryDailyTotals)
    .where(
      and(
        eq(gscQueryDailyTotals.projectId, projectId),
        sql`${gscQueryDailyTotals.date} >= ${startDate}`,
        sql`${gscQueryDailyTotals.date} <= ${endDate}`,
      ),
    )
    .groupBy(gscQueryDailyTotals.query)
    .all()

  return rows.map((r) => ({
    query: r.query,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    position: Number(r.position),
  }))
}

/**
 * Prefer Google's per-query figures, falling back to the legacy page-summed
 * aggregate for queries the accurate fetch has not covered yet (a window that
 * predates the `['date','query']` sync, or a re-sync that has not run).
 *
 * The fallback is kept rather than dropped so a historical report still renders
 * — but every row carries `source`, so a caller can never silently blend an
 * accurate impression count with an inflated one.
 */
export function mergeGscQueryTotalsWithFallback(
  queryTotals: readonly GscQueryTotal[],
  dimensionedFallback: readonly GscQueryTotal[],
): GscQueryAggregate[] {
  const byQuery = new Map<string, GscQueryAggregate>()
  for (const row of dimensionedFallback) byQuery.set(row.query, { ...row, source: 'page-summed' })
  for (const row of queryTotals) byQuery.set(row.query, { ...row, source: 'google' })
  return [...byQuery.values()]
}
