import type { GA4SocialReferralHistoryEntry } from '../api.js'

export const SOCIAL_CHART_TOP_N = 6
export const SOCIAL_OTHER_KEY = '__other__'
export const SOCIAL_TOTAL_KEY = '_socialTotal'

export interface SocialChartAggregation {
  data: Array<Record<string, string | number>>
  sources: string[]
  otherCount: number
}

export function aggregateSocialChartData(
  history: GA4SocialReferralHistoryEntry[],
  topN: number = SOCIAL_CHART_TOP_N,
): SocialChartAggregation {
  const totals = new Map<string, number>()
  for (const row of history) {
    totals.set(row.source, (totals.get(row.source) ?? 0) + row.sessions)
  }

  const ranked = [...totals.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })
  const topEntries = ranked.slice(0, topN)
  const topSources = new Set(topEntries.map(([source]) => source))
  const otherCount = Math.max(0, ranked.length - topN)

  const byDate = new Map<string, Record<string, string | number>>()
  for (const row of history) {
    let entry = byDate.get(row.date)
    if (!entry) {
      entry = { date: row.date, [SOCIAL_TOTAL_KEY]: 0 }
      byDate.set(row.date, entry)
    }
    const key = topSources.has(row.source) ? row.source : SOCIAL_OTHER_KEY
    entry[key] = ((entry[key] as number) ?? 0) + row.sessions
    entry[SOCIAL_TOTAL_KEY] = ((entry[SOCIAL_TOTAL_KEY] as number) ?? 0) + row.sessions
  }

  const data = [...byDate.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  )

  const sources = topEntries.map(([source]) => source)
  if (otherCount > 0) sources.push(SOCIAL_OTHER_KEY)

  return { data, sources, otherCount }
}

/** UTM-tagged sources often use `+` for spaces. Decode for display while keeping the raw value for tooltips/sorting. */
export function decodeSocialSourceLabel(source: string): string {
  return source.replace(/\+/g, ' ')
}

export function truncateLabel(label: string, max = 30): string {
  if (label.length <= max) return label
  return label.slice(0, Math.max(1, max - 1)) + '…'
}
