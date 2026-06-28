import { and, asc, eq, sql } from 'drizzle-orm'
import { gscDailyTotals } from '@ainyc/canonry-db'
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
 * and the daily trend — summing the dimensioned `gsc_search_data` rows does not
 * equal Google's property total. Returns an empty array when the project has no
 * daily-totals rows in the window (callers fall back to the dimensioned sum for
 * back-compat with projects that have not re-synced).
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
