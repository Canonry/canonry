import type { GA4SessionHistoryEntry } from '@ainyc/canonry-contracts'

/** One day's landing-page-dimensioned aggregation from `ga_traffic_snapshots`. */
export interface LandingPageDayAggregate {
  date: string
  sessions: number
  organicSessions: number
  /** `SUM(users)` across landing pages — overcounts, used only as a fallback. */
  users: number
}

/** One day's property-level totals from `ga_daily_totals` (no page dimension). */
export interface DailyTotalRow {
  date: string
  users: number
}

/**
 * Build the daily session series, taking `users` from the deduplicated
 * property-level totals whenever that day has been synced.
 *
 * Why this exists: `users` is not additive across landing pages. GA counts one
 * visitor who reads three pages as ONE user, but that visitor contributes to
 * three `ga_traffic_snapshots` rows, so `SUM(users) GROUP BY date` inflates the
 * day. `ga_daily_totals` stores the same day fetched with only the `date`
 * dimension, letting GA do the dedup, so it matches what the GA UI reports.
 *
 * `sessions` and `organicSessions` keep coming from the landing-page rows:
 * GA4 attributes exactly one landing page per session, so summing them is
 * correct, and organic has no property-level counterpart in this table.
 *
 * Days synced before this table existed have no total row. Rather than silently
 * mixing two methodologies along one x-axis, each entry reports which one
 * produced its `users` via `usersSource`.
 */
export function buildSessionHistory(
  landingPageDays: readonly LandingPageDayAggregate[],
  dailyTotals: readonly DailyTotalRow[],
): GA4SessionHistoryEntry[] {
  const totalsByDate = new Map(dailyTotals.map((row) => [row.date, row.users]))

  return landingPageDays.map((day) => {
    const deduplicated = totalsByDate.get(day.date)
    return {
      date: day.date,
      sessions: day.sessions,
      organicSessions: day.organicSessions,
      users: deduplicated ?? day.users,
      usersSource: deduplicated === undefined ? 'landing-page-sum' as const : 'deduplicated' as const,
    }
  })
}
