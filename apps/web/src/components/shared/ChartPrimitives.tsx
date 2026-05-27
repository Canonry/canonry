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
    backgroundColor: '#18181b',
    border: '1px solid #3f3f46',
    borderRadius: 8,
    fontSize: 12,
  },
  labelStyle: { color: '#e4e4e7' },
  itemStyle: { color: '#a1a1aa' },
}

/** Standard axis tick styling. */
export const CHART_AXIS_TICK = { fill: '#71717a', fontSize: 11 } as const

/** Standard grid line color. */
export const CHART_GRID_STROKE = '#27272a'

/** Standard axis line stroke. */
export const CHART_AXIS_STROKE = '#27272a'

/** Palette for multi-series charts (up to 8 series). */
export const CHART_SERIES_COLORS = [
  '#34d399', // emerald-400
  '#60a5fa', // blue-400
  '#f472b6', // pink-400
  '#facc15', // yellow-400
  '#a78bfa', // violet-400
  '#fb923c', // orange-400
  '#22d3ee', // cyan-400
  '#f87171', // red-400
] as const

/**
 * Neutral color tokens for custom SVG visualizations (non-Recharts).
 * Mirrors the dashboard's zinc neutral ramp so custom charts stay on
 * the documented palette in DESIGN.md.
 */
export const CHART_NEUTRAL = {
  text: '#a1a1aa',      // zinc-400 — primary axis labels
  textDim: '#71717a',   // zinc-500 — secondary text
  textFaint: '#52525b', // zinc-600 — faintest text, track lines
  surface: '#27272a',   // zinc-800 — area fill, track surface
  gridLine: 'rgba(255, 255, 255, 0.06)',
} as const

/**
 * Tone fills for direct categorical charts (bars, donuts).
 * Matches the Listening Post tone palette in DESIGN.md. Use the
 * `Deep` variant when the chart wants heavier visual weight
 * (large donut arcs); use the base variant for sparklines and gauges.
 */
export const CHART_TONE = {
  positive: '#34d399',     // emerald-400 — gauge fill, sparkline positive
  positiveDeep: '#10b981', // emerald-500 — donut arc weight
  caution: '#fbbf24',      // amber-400
  negative: '#fb7185',     // rose-400
  neutral: '#a1a1aa',      // zinc-400
} as const

/** Parse a date string that may be a date-only ("2026-03-15") or full ISO timestamp. */
function parseChartDate(value: string): Date {
  const s = String(value)
  // Date-only strings (no "T") need a time suffix to avoid UTC-midnight timezone shifts
  if (!s.includes('T')) return new Date(s + 'T00:00:00')
  return new Date(s)
}

/** Format a date label for chart tooltips (e.g. "Mar 15, 2026"). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatChartDateLabel(value: any): string {
  const d = parseChartDate(String(value))
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Format a date tick for chart axes (e.g. "3/15"). */
export function formatChartDateTick(value: string): string {
  const d = parseChartDate(value)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
