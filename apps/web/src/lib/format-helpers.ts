/** Common search-analytics metrics shared across GSC, Bing, etc. */
export enum SearchMetric {
  Clicks = 'clicks',
  Impressions = 'impressions',
  CTR = 'ctr',
  Position = 'position',
}

export const SEARCH_METRIC_LABELS: Record<SearchMetric, string> = {
  [SearchMetric.Clicks]: 'Clicks',
  [SearchMetric.Impressions]: 'Impressions',
  [SearchMetric.CTR]: 'CTR',
  [SearchMetric.Position]: 'Position',
}

export const SEARCH_METRIC_SHORT_LABELS: Record<SearchMetric, string> = {
  [SearchMetric.Clicks]: 'Clicks',
  [SearchMetric.Impressions]: 'Impr',
  [SearchMetric.CTR]: 'CTR',
  [SearchMetric.Position]: 'Pos',
}

export function formatErrorLog(error: string): string {
  // Extract the human-readable prefix and try to pretty-print any JSON within
  const bracketMatch = error.match(/^(\[.*?\])\s*(.+)/)
  if (bracketMatch) {
    const prefix = bracketMatch[1]
    const rest = bracketMatch[2]
    // Try to find and pretty-print embedded JSON
    const jsonStart = rest.indexOf('{')
    if (jsonStart >= 0) {
      const message = rest.slice(0, jsonStart).trim()
      const jsonPart = rest.slice(jsonStart)
      try {
        const parsed = JSON.parse(jsonPart)
        return `${prefix} ${message}\n\n${JSON.stringify(parsed, null, 2)}`
      } catch {
        // Not valid JSON, just format the text
      }
    }
    return `${prefix}\n${rest}`
  }
  // Try to pretty-print the whole thing as JSON
  try {
    const parsed = JSON.parse(error)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return error
  }
}

export function toTitleCase(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export function formatBooleanState(value: boolean | null): string {
  if (value === null) return 'Unknown'
  return value ? 'Pass' : 'Fail'
}

export function formatHour(h: number): string {
  if (h === 0) return '12:00 AM'
  if (h < 12) return `${h}:00 AM`
  if (h === 12) return '12:00 PM'
  return `${h - 12}:00 PM`
}

export function buildPreset(freq: string, hour: number): string {
  if (freq === 'twice-daily') return 'twice-daily'
  if (freq.startsWith('weekly@')) return `${freq}@${hour}`
  return `daily@${hour}`
}

export function parsePreset(preset: string | null, cronExpr: string): { freq: string; hour: number; customCron: string } {
  if (!preset) return { freq: 'custom', hour: 6, customCron: cronExpr }
  if (preset === 'twice-daily') return { freq: 'twice-daily', hour: 6, customCron: '' }
  const dailyMatch = preset.match(/^daily(?:@(\d+))?$/)
  if (dailyMatch) return { freq: 'daily', hour: dailyMatch[1] ? parseInt(dailyMatch[1]) : 6, customCron: '' }
  const weeklyMatch = preset.match(/^(weekly@(?:mon|tue|wed|thu|fri|sat|sun))(?:@(\d+))?$/)
  if (weeklyMatch) return { freq: weeklyMatch[1], hour: weeklyMatch[2] ? parseInt(weeklyMatch[2]) : 6, customCron: '' }
  return { freq: 'custom', hour: 6, customCron: cronExpr }
}

export function scheduleLabel(preset: string | null, cronExpr: string, timezone: string): string {
  const tzShort = timezone === 'UTC' ? 'UTC' : (timezone.split('/').pop()?.replace(/_/g, ' ') ?? timezone)
  if (!preset) return `Custom: ${cronExpr} · ${tzShort}`
  if (preset === 'twice-daily') return `Twice a day (6am & 6pm) · ${tzShort}`
  const dailyMatch = preset.match(/^daily(?:@(\d+))?$/)
  if (dailyMatch) {
    const h = dailyMatch[1] ? parseInt(dailyMatch[1]) : 6
    return `Every day at ${formatHour(h)} · ${tzShort}`
  }
  const weeklyMatch = preset.match(/^weekly@(mon|tue|wed|thu|fri|sat|sun)(?:@(\d+))?$/)
  if (weeklyMatch) {
    const days: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }
    const h = weeklyMatch[2] ? parseInt(weeklyMatch[2]) : 6
    return `Every ${days[weeklyMatch[1]]} at ${formatHour(h)} · ${tzShort}`
  }
  return `${preset} · ${tzShort}`
}
