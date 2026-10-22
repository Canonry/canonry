import { z } from 'zod'

/**
 * A daily count split into named groups for a stacked chart.
 *
 * Every series has a value on every listed day, so a day's values always add
 * up to its `sessions`. A series missing from a day is not a gap but a broken
 * stack: a chart draws nothing for a lone point between two missing ones, and
 * the bands above it no longer start where the band below ends.
 */
export const stackedDailySeriesSchema = z.object({
  /**
   * Chart series in stacking order, largest first, then `other` when more
   * groups exist than the chart shows. `sessions` is the series' window total.
   */
  series: z.array(z.object({
    key: z.string(),
    label: z.string(),
    sessions: z.number(),
  })),
  /** How many groups the `other` series folds together; 0 when there is no `other` series. */
  otherCount: z.number(),
  /** Ascending by date: the days with at least one count. */
  days: z.array(z.object({
    date: z.string(),
    /** The day's total, equal to the sum of `values`. */
    sessions: z.number(),
    /** Sessions per series key. Every key in `series` is present, with 0 for a group that had none. */
    values: z.record(z.string(), z.number()),
  })),
})
export type StackedDailySeries = z.infer<typeof stackedDailySeriesSchema>

/** Key of the series that folds every group outside the top `limit`. */
export const STACKED_SERIES_OTHER_KEY = 'other'

/**
 * Build a stacked daily series from per-day group counts.
 *
 * Groups are ranked by window total (ties by label); the top `limit` keep
 * their own series and the rest fold into one `other` series labelled
 * `otherLabel`. Counts for the same day and group are summed. Nothing is
 * dropped: the series totals add up to the sum of every input count.
 */
export function buildStackedDailySeries(
  points: Iterable<{ date: string; key: string; label: string; sessions: number }>,
  options: { limit: number; otherLabel: string },
): StackedDailySeries {
  const labels = new Map<string, string>()
  const totals = new Map<string, number>()
  const byDate = new Map<string, Map<string, number>>()
  for (const point of points) {
    labels.set(point.key, point.label)
    totals.set(point.key, (totals.get(point.key) ?? 0) + point.sessions)
    let day = byDate.get(point.date)
    if (!day) {
      day = new Map()
      byDate.set(point.date, day)
    }
    day.set(point.key, (day.get(point.key) ?? 0) + point.sessions)
  }

  const ranked = [...totals.entries()].sort((a, b) => (
    b[1] - a[1] || labels.get(a[0])!.localeCompare(labels.get(b[0])!)
  ))
  const limit = Math.max(0, Math.floor(options.limit))
  // Folding a single group into `other` would only rename it.
  const shown = ranked.length > limit + 1 ? ranked.slice(0, limit) : ranked
  const folded = ranked.slice(shown.length)
  const shownKeys = new Set(shown.map(([key]) => key))

  const series = shown.map(([key, sessions]) => ({ key, label: labels.get(key)!, sessions }))
  if (folded.length > 0) {
    series.push({
      key: STACKED_SERIES_OTHER_KEY,
      label: options.otherLabel,
      sessions: folded.reduce((sum, [, sessions]) => sum + sessions, 0),
    })
  }

  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => {
      const values: Record<string, number> = Object.fromEntries(series.map(s => [s.key, 0]))
      let sessions = 0
      for (const [key, count] of counts) {
        const target = shownKeys.has(key) ? key : STACKED_SERIES_OTHER_KEY
        values[target] = (values[target] ?? 0) + count
        sessions += count
      }
      return { date, sessions, values }
    })

  return { series, otherCount: folded.length, days }
}
