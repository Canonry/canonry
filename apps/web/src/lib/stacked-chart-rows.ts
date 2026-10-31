/**
 * Chart rows for a server-built stacked daily series.
 *
 * Nothing is counted here: the API already ranked the groups, folded the rest
 * into `other` and gave every series a value on every day it lists. This only
 * lays those values out as Recharts rows, under index keys so a group key with
 * a dot in it (a hostname) is never read as a property path.
 */

export interface StackedSeriesInput {
  series: ReadonlyArray<{ key: string; label: string; sessions: number }>
  days: ReadonlyArray<{ date: string; sessions: number; values: Readonly<Record<string, number>> }>
}

export interface StackedChartSeries {
  dataKey: string
  key: string
  label: string
}

export interface StackedChartRows {
  rows: Array<Record<string, string | number | null>>
  series: StackedChartSeries[]
}

export const BASELINE_DATA_KEY = 'baseline'

/**
 * `baseline` is a reference line drawn beside the stack (total sessions). A
 * date the baseline has and the series does not is a synced day with none of
 * the stacked traffic, so the series read 0 there; a date with no baseline
 * reading leaves the line blank rather than drawing a zero.
 */
export function buildStackedChartRows(
  input: StackedSeriesInput | undefined,
  baseline: ReadonlyArray<{ date: string; value: number }> = [],
): StackedChartRows {
  const series = (input?.series ?? []).map((entry, index) => ({ dataKey: `s${index}`, key: entry.key, label: entry.label }))
  const byDate = new Map<string, Readonly<Record<string, number>>>()
  for (const day of input?.days ?? []) byDate.set(day.date, day.values)
  const baselineByDate = new Map(baseline.map(point => [point.date, point.value]))
  const dates = [...new Set([...byDate.keys(), ...baselineByDate.keys()])].sort()

  const rows = dates.map(date => {
    const values = byDate.get(date)
    const row: Record<string, string | number | null> = { date, [BASELINE_DATA_KEY]: baselineByDate.get(date) ?? null }
    for (const entry of series) row[entry.dataKey] = values?.[entry.key] ?? 0
    return row
  })
  return { rows, series }
}
