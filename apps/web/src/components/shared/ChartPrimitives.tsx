/**
 * Shared Recharts configuration and chart wrapper components.
 *
 * ALL charts in the web app must use Recharts via these primitives.
 * Do not use custom SVG charts, Chart.js, Highcharts, D3, or any other
 * charting library. See CLAUDE.md "Charting" section.
 */
import type { CSSProperties } from 'react'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'

// Re-export Recharts components that pages may need directly
export {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
}

/** Standard dark-theme tooltip styles matching the design system. */
export const CHART_TOOLTIP_STYLE: {
  contentStyle: CSSProperties
  labelStyle: CSSProperties
  itemStyle: CSSProperties
} = {
  contentStyle: {
    backgroundColor: 'var(--chart-tooltip-bg, #18181b)',
    border: '1px solid var(--chart-tooltip-border, #3f3f46)',
    borderRadius: 8,
    fontSize: 12,
  },
  labelStyle: { color: 'var(--chart-tooltip-label, #e4e4e7)' },
  itemStyle: { color: 'var(--chart-tooltip-item, #a1a1aa)' },
}

/** Standard axis tick styling. */
export const CHART_AXIS_TICK = { fill: 'var(--chart-neutral-text-dim, #71717a)', fontSize: 11 } as const

/** Standard grid line color. */
export const CHART_GRID_STROKE = 'var(--chart-grid, #27272a)'

/** Standard axis line stroke. */
export const CHART_AXIS_STROKE = 'var(--chart-axis, #27272a)'

/**
 * Palette for multi-series charts (up to 8 series). Each entry bridges to the
 * `--chart-series-N` CSS token (registered in styles.css) with the original hex
 * as the fallback, so the default dark render is unchanged and a theme can
 * override the ramp at runtime. Recharts passes these straight to SVG
 * fill/stroke, which resolve CSS variables. NEVER do string math on these
 * (slice/alpha-concat) — a `var(...)` string would break.
 */
export const CHART_SERIES_COLORS = [
  'var(--chart-series-1, #34d399)', // emerald-400
  'var(--chart-series-2, #60a5fa)', // blue-400
  'var(--chart-series-3, #f472b6)', // pink-400
  'var(--chart-series-4, #facc15)', // yellow-400
  'var(--chart-series-5, #a78bfa)', // violet-400
  'var(--chart-series-6, #fb923c)', // orange-400
  'var(--chart-series-7, #22d3ee)', // cyan-400
  'var(--chart-series-8, #f87171)', // red-400
] as const

/**
 * Stable per-engine line colors. Aligned with the `ProviderBadge` identity
 * (gemini = blue, openai = green, claude = amber/orange, perplexity =
 * teal/cyan, local = violet) and drawn from `CHART_SERIES_COLORS` so a given
 * engine reads as the SAME color in every chart, badge, and legend across the
 * dashboard. Unknown engines fall back to the positional palette.
 */
export const PROVIDER_SERIES_COLORS: Record<string, string> = {
  gemini: '#60a5fa', // blue-400
  openai: '#34d399', // emerald-400
  claude: '#fb923c', // orange-400
  perplexity: '#22d3ee', // cyan-400
  local: '#a78bfa', // violet-400
}

/** Color for an engine's line/legend swatch — stable map first, palette fallback. */
export function providerSeriesColor(provider: string, fallbackIndex = 0): string {
  return PROVIDER_SERIES_COLORS[provider] ?? CHART_SERIES_COLORS[fallbackIndex % CHART_SERIES_COLORS.length]!
}

/**
 * Neutral color tokens for custom SVG visualizations (non-Recharts).
 * Mirrors the dashboard's zinc neutral ramp so custom charts stay on
 * the documented dashboard palette.
 */
export const CHART_NEUTRAL = {
  text: 'var(--chart-neutral-text, #a1a1aa)',           // zinc-400 — primary axis labels
  textDim: 'var(--chart-neutral-text-dim, #71717a)',    // zinc-500 — secondary text
  textFaint: 'var(--chart-neutral-text-faint, #52525b)', // zinc-600 — faintest text, track lines
  surface: 'var(--chart-neutral-surface, #27272a)',     // zinc-800 — area fill, track surface
  trackSubtle: 'var(--chart-neutral-track-subtle, rgb(255 255 255 / 0.04))',
  gridLine: 'var(--chart-neutral-grid-line, rgb(255 255 255 / 0.06))',
} as const

/**
 * Tone fills for direct categorical charts (bars, donuts).
 * Matches the Listening Post tone palette. Use the
 * `Deep` variant when the chart wants heavier visual weight
 * (large donut arcs); use the base variant for sparklines and gauges.
 */
export const CHART_TONE = {
  positive: 'var(--chart-tone-positive, #34d399)',          // emerald-400 — gauge fill, sparkline positive
  positiveDeep: 'var(--chart-tone-positive-deep, #10b981)', // emerald-500 — donut arc weight
  caution: 'var(--chart-tone-caution, #fbbf24)',            // amber-400
  negative: 'var(--chart-tone-negative, #fb7185)',          // rose-400
  neutral: 'var(--chart-tone-neutral, #a1a1aa)',            // zinc-400
} as const

/**
 * Two kinds of value reach a date formatter, and they are NOT the same thing.
 * They look identical at runtime ("2026-07-10T00:00:00.000Z"), so only the
 * type system can keep them apart — which is why the split below is a type,
 * not a comment.
 *
 *  - A CALENDAR DATE ("2026-03-15", or a day-stamped API value): names a day,
 *    not a moment. It has no clock reading, so converting it into a viewer's
 *    timezone invents one and can shift it a day. `formatChartDateLabel` /
 *    `formatChartDateTick` handle these and apply NO timezone conversion at
 *    all — they read the calendar fields exactly as written.
 *  - An OBSERVED INSTANT: a moment something actually happened (a sweep ran).
 *    Localizing it for the viewer is correct and wanted. Only
 *    `formatObservedInstantLabel` / `formatObservedInstantTick` do that, and
 *    they accept only the branded type below.
 *
 * A synthetic value (a bucket boundary, a grouping key) is neither — nothing
 * happened at it. It stays a plain `string`, so the compiler rejects it at the
 * localizing formatters, and the calendar formatters cannot shift it. There is
 * no longer any path from a synthetic boundary to a wrong day.
 */
export type ObservedInstant = string & { readonly __observedInstant: unique symbol }

/**
 * The ONLY constructor for an `ObservedInstant`. Call it exactly where a real
 * timestamp enters the UI — a sweep time the API observed. Never call it on a
 * bucket boundary or another derived key: that is the one remaining way to
 * reintroduce the bug, and it is now a deliberate, greppable act rather than
 * something a formatter does silently.
 */
export function observedInstant(iso: string): ObservedInstant {
  return iso as ObservedInstant
}

/** `2026-03-15` / `2026-03-15T…` → the calendar fields exactly as written. */
function calendarParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/**
 * Format a CALENDAR DATE for chart tooltips (e.g. "Mar 15, 2026"). No timezone
 * is applied, so the day rendered is always the day written in the string.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatChartDateLabel(value: any): string {
  const raw = String(value)
  const parts = calendarParts(raw)
  if (!parts) return raw
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Format a CALENDAR DATE as a compact axis tick (e.g. "3/15"). No timezone applied. */
export function formatChartDateTick(value: string): string {
  const parts = calendarParts(String(value))
  if (!parts) return String(value)
  return `${parts.month}/${parts.day}`
}

/** Format a real instant in the VIEWER's timezone (07-20T01:52Z reads "Jul 19, 2026" in New York). */
export function formatObservedInstantLabel(instant: ObservedInstant): string {
  return new Date(instant).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Format a real instant as a compact axis tick in the viewer's timezone (e.g. "7/19"). */
export function formatObservedInstantTick(instant: ObservedInstant): string {
  const d = new Date(instant)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
