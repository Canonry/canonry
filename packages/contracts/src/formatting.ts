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

/**
 * Smart-percent base threshold. When the PRIOR-window value is at least this
 * large, a delta is expressed as a percentage; below it, a raw rounded delta
 * is shown instead so a tiny base never produces a misleading percentage
 * (e.g. "+50%" off a base of 2). Same rule the Discord orchestrator uses.
 */
export const MIN_PCT_BASE = 30

/** Round to one decimal place: round1(0.3333) → 0.3, round1(3.3333) → 3.3. */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * "Smart %" subtitle for an AVERAGE metric (e.g. cited-query count averaged
 * over a rolling window). When the prior average is a large-enough base
 * (`prior >= MIN_PCT_BASE`) and a percentage is computable, render the signed
 * percent — otherwise fall back to a clean rounded raw delta vs the prior
 * average. `deltaPct` is already signed (negative = down); we only add a '+'
 * for positive values.
 *
 * Pure. Shared by the report SPA and HTML renderer so both surfaces produce
 * byte-identical copy per the report-parity rule.
 */
export function formatAverageDelta(d: { deltaAbs: number; prior: number; deltaPct: number | null }): string {
  if (d.prior >= MIN_PCT_BASE && d.deltaPct !== null) {
    const sign = d.deltaPct > 0 ? '+' : ''
    return `${sign}${d.deltaPct}% vs prior`
  }
  const sign = d.deltaAbs > 0 ? '+' : ''
  return `${sign}${round1(d.deltaAbs)} vs ${round1(d.prior)}`
}

/**
 * "Smart %" subtitle for a WINDOW-COUNT metric (e.g. GSC clicks summed over a
 * trailing window vs the prior window). When the prior total is a large-enough
 * base and a percentage is computable, render the signed percent followed by
 * the window label; otherwise render a rounded absolute delta with the count
 * label (`visits`, `clicks`, …) and the window label.
 *
 * Pure. Shared by the report SPA and HTML renderer.
 */
export function formatWindowCountDelta(
  d: { deltaAbs: number; prior: number; deltaPct: number | null },
  countLabel: string,
  windowLabel: string,
): string {
  if (d.prior >= MIN_PCT_BASE && d.deltaPct !== null) {
    const sign = d.deltaPct > 0 ? '+' : ''
    return `${sign}${d.deltaPct}% ${windowLabel}`
  }
  const sign = d.deltaAbs > 0 ? '+' : ''
  return `${sign}${formatNumber(Math.round(d.deltaAbs))} ${countLabel} ${windowLabel}`
}

/**
 * Convert a compact `YYYYMMDD` calendar date to ISO `YYYY-MM-DD`.
 *
 * Google's reporting APIs return the `date` dimension in the compact form
 * while canonry stores and compares ISO dates everywhere. Values that are
 * already ISO (or any other shape) are returned unchanged, so this is safe to
 * apply to a mixed series and safe to re-apply.
 *
 * Pure string surgery — no Date construction, so no timezone can shift the day.
 */
export function compactDateToIso(value: string): string {
  if (value.length !== 8 || !/^\d{8}$/.test(value)) return value
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}
