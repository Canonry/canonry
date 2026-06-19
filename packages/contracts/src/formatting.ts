export function formatRatio(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0%'
  return `${(value * 100).toFixed(1)}%`
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
}

export function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
    const d = dateOnly && dateOnly[1] && dateOnly[2] && dateOnly[3]
      ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
      : new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-US', dateOnly ? { ...options, timeZone: 'UTC' } : options)
  } catch {
    return iso
  }
}

export function formatIsoDate(iso: string): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const yyyy = d.getUTCFullYear()
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  } catch {
    return iso
  }
}

export function formatDateRange(start: string, end: string): string {
  if (!start && !end) return ''
  if (start && end) return `${formatDate(start)} → ${formatDate(end)}`
  return formatDate(start || end)
}

/** Matches a date-only ISO calendar date with no time component, e.g. "2026-06-30". */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse an ISO 8601 date or date-time into epoch milliseconds for use as an
 * INCLUSIVE upper bound on full-timestamp values. A date-only string (no time
 * component, parsed as UTC) is widened to the END of that UTC day
 * (`23:59:59.999`) so the whole day is included rather than just its midnight
 * instant; a date-time keeps its exact instant. Returns `null` when the input
 * cannot be parsed. The inclusive lower bound needs no helper — a date-only
 * value already parses to the day's start (`00:00:00`).
 */
export function parseInclusiveEndMs(iso: string): number | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return DATE_ONLY_PATTERN.test(iso) ? ms + 86_400_000 - 1 : ms
}

export interface DeltaWindow {
  current: number
  prior: number
  deltaPct: number | null
}

export function deltaPercent(current: number, prior: number): number | null {
  if (prior <= 0) return null
  return Math.round(((current - prior) / prior) * 100)
}

export type DeltaTone = 'positive' | 'negative' | 'neutral'

export function deltaTone(deltaPct: number | null): DeltaTone {
  if (deltaPct === null || deltaPct === 0) return 'neutral'
  return deltaPct > 0 ? 'positive' : 'negative'
}

// Canonical subtitle copy for a "current vs prior window" tile. Used by
// both the SPA and the HTML renderer so they stay verbatim-identical per
// the report-parity rule.
export function formatDeltaCopy(d: DeltaWindow, suffix: string, windowLabel = 'vs prior 7 days'): string {
  if (d.deltaPct === null) {
    return d.prior === 0 ? 'First baseline week' : ''
  }
  if (d.deltaPct > 0) return `Up ${d.deltaPct}% ${windowLabel} (${formatNumber(d.prior)} ${suffix})`
  if (d.deltaPct < 0) return `Down ${Math.abs(d.deltaPct)}% ${windowLabel} (${formatNumber(d.prior)} ${suffix})`
  return `Flat ${windowLabel} (${formatNumber(d.prior)} ${suffix})`
}
