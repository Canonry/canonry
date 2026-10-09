import { formatRunErrorOneLine, normalizeProjectDomain, unattributedAnswersLabel, uncheckedSourcesLabel, type RunErrorDto } from '@ainyc/canonry-contracts'
import type { CitationState } from '../view-models.js'

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

/** One-line summary of a `RunErrorDto`, suitable for tight UI surfaces. */
export const summarizeRunError = formatRunErrorOneLine

/**
 * A figure and its percent sign, split so a hero can set the sign apart
 * (rendered faint): `66.7%` is `{ figure: '66.7', sign: '%' }`. Text with no
 * trailing sign (`No data`, a count) comes back whole with an empty sign. Both
 * halves are the input's own characters; nothing is reformatted.
 */
export function splitPercentSign(text: string): { figure: string; sign: string } {
  return text.endsWith('%') ? { figure: text.slice(0, -1), sign: '%' } : { figure: text, sign: '' }
}

/** The signal a coverage rate reads: the answer text (`mentioned`) or its source links (`cited`). */
export type CoverageSignal = 'mentioned' | 'cited'

/**
 * The server's count of saved answers a rate left out of both its sides, as the
 * shared label for that rate's own signal: a mention rate names the answers it
 * could not tie to one property (`unattributed`), a citation rate the answers
 * whose sources could not be checked (`unchecked`). Each count belongs to one
 * signal, so its line never shows under the other.
 */
export function excludedAnswersLabel(
  value: { denominator?: number | null; unattributed?: number; unchecked?: number },
  signal: CoverageSignal,
): string | null {
  return signal === 'cited' ? uncheckedSourcesLabel(value) : unattributedAnswersLabel(value)
}

/**
 * The older site-wide cited flag (`citationState`: any page on the project's
 * domain in the sources), named for what it reads. Advanced views put it beside
 * per-property numbers, which credit only a property's own pages, so a bare
 * "Cited" there reads as a property result it never was.
 */
export function siteCitationLabel(domain: string, state: CitationState): string {
  const site = normalizeProjectDomain(domain)
  switch (state) {
    case 'cited': return `${site} cited (any page)`
    case 'emerging': return `${site} newly cited (any page)`
    case 'lost': return `${site} citation lost (any page)`
    case 'not-cited': return `${site} not cited (any page)`
    case 'pending': return 'Pending'
  }
}

export function formatErrorLog(error: RunErrorDto): string {
  const sections: string[] = []
  if (error.message) sections.push(error.message)
  if (error.providers) {
    for (const [provider, detail] of Object.entries(error.providers)) {
      const head = `[${provider}] ${detail.message}`
      if (detail.raw !== undefined) {
        sections.push(`${head}\n\n${JSON.stringify(detail.raw, null, 2)}`)
      } else {
        sections.push(head)
      }
    }
  }
  return sections.length > 0 ? sections.join('\n\n') : 'Run failed.'
}

export function toTitleCase(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * A sweep's time in the viewer's zone: "Sep 29, 5:41 AM", the time alone when
 * it falls on the same day as `sameDayAs` (the sentence already names that
 * day), and the year only outside the current one ("Sep 29, 2025, 5:41 AM").
 */
export function formatSweepInstant(iso: string, sameDayAs?: string | null, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (sameDayAs && new Date(sameDayAs).toDateString() === date.toDateString()) return time
  return `${formatSweepDay(iso, now)}, ${time}`
}

/**
 * A sweep's day in the viewer's zone, in the same style as
 * {@link formatSweepInstant}: "Sep 29", with the year only outside the current
 * one ("Sep 29, 2025"). Always en-US, so a card's dates read one way whatever
 * the browser's locale.
 */
export function formatSweepDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.getFullYear() === now.getFullYear()
    ? formatMonthDay(iso)
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** A sweep's day without its year ("Sep 29"), for chart ticks. en-US, like the rest. */
export function formatMonthDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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

/**
 * Combine an IANA zone name with its short abbreviation into a display label,
 * e.g. ("America/New_York", "EDT") → "America/New_York · EDT". Falls back to
 * the zone name alone when no distinct abbreviation is available.
 */
export function formatTimeZoneLabel(zone: string, abbrev: string | undefined): string {
  return abbrev && abbrev !== zone ? `${zone} · ${abbrev}` : zone
}

/**
 * The viewer's local timezone, for labeling times rendered in local time
 * (e.g. the server-traffic hourly rollups). Resolved from the browser's Intl
 * settings — a presentation concern, not server data.
 */
export function localTimeZoneLabel(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const abbrev = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts()
    .find((part) => part.type === 'timeZoneName')?.value
  return formatTimeZoneLabel(zone, abbrev)
}
