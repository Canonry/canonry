import type { BrandMetricsDto, QueryChangeEvent, TrendDirection } from '@ainyc/canonry-contracts'
import type { MetricTone } from '../view-models.js'

/**
 * Pure reshaping of `BrandMetricsDto` into Recharts-ready rows for the
 * visibility-over-time chart. This is the ONLY place a metric is mapped to a
 * DTO field and a 0-1 rate is scaled to the 0-100 axis — no rates are derived
 * or recomputed here, so the chart stays a faithful renderer of the API's math
 * (UI/CLI parity). Tested in `apps/web/test/visibility-trend-helpers.test.ts`.
 */

/** Series keys for the two overall lines (overall mode plots both at once). */
export const CITED_KEY = '__cited__'
export const MENTIONED_KEY = '__mentioned__'

export type TrendSeriesMode = 'overall' | 'byProvider'

/** Which metric line to plot. */
export type MetricChoice = 'cited' | 'mentioned'

export interface TrendRow {
  date: string
  [series: string]: number | string | null
}

export interface TrendData {
  rows: TrendRow[]
  /** Line keys to plot: cited/mentioned keys in overall mode, provider names in byProvider mode. */
  series: string[]
  hasData: boolean
  /** A single bucket can't draw a line — the chart shows a dot + "not enough history" hint. */
  singleBucket: boolean
}

/** Presentation-only: 0-1 rate → 0-100 axis value, one decimal. */
function toPercent(rate: number): number {
  return Math.round(rate * 1000) / 10
}

export function buildTrendRows(
  dto: BrandMetricsDto,
  metric: MetricChoice,
  mode: TrendSeriesMode,
): TrendData {
  const hasData = dto.buckets.length > 0
  const singleBucket = dto.buckets.length === 1

  if (mode === 'overall') {
    // Overall plots the single metric line the toggle selects.
    const key = metric === 'cited' ? CITED_KEY : MENTIONED_KEY
    const field: 'citationRate' | 'mentionRate' = metric === 'cited' ? 'citationRate' : 'mentionRate'
    const rows: TrendRow[] = dto.buckets.map(b => ({ date: b.startDate, [key]: toPercent(b[field]) }))
    return { rows, series: [key], hasData, singleBucket }
  }

  // byProvider — one metric broken out per provider (`both` falls back to cited).
  const field: 'citationRate' | 'mentionRate' = metric === 'mentioned' ? 'mentionRate' : 'citationRate'
  // series is the union of providers across all buckets so a
  // provider that appears or disappears mid-history still gets its own line.
  // `?? {}` guards buckets from an older backend (≤4.67.0) that predates the
  // per-bucket breakdown and omits `byProvider` entirely — degrade to no
  // provider lines instead of throwing on `Object.keys(undefined)`.
  const series = [...new Set(dto.buckets.flatMap(b => Object.keys(b.byProvider ?? {})))].sort()
  const rows: TrendRow[] = dto.buckets.map(b => {
    const row: TrendRow = { date: b.startDate }
    for (const provider of series) {
      const metricRow = b.byProvider?.[provider]
      // null (not 0) when a provider has no data in this bucket — Recharts
      // `connectNulls` bridges the gap rather than dropping the line to zero.
      row[provider] = metricRow ? toPercent(metricRow[field]) : null
    }
    return row
  })
  return { rows, series, hasData, singleBucket }
}

/** Map an API trend direction to a design-system tone. */
export function trendToTone(direction: TrendDirection): MetricTone {
  switch (direction) {
    case 'improving':
      return 'positive'
    case 'declining':
      return 'negative'
    case 'stable':
      return 'neutral'
  }
}

/** "2026-04-03" → "04/03" (MM/DD; ISO date is already zero-padded). */
function mmdd(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-')
  if (!m || !d) return iso
  return `${m}/${d}`
}

function signedDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`
}

/**
 * One-line caption explaining query-set changes beneath the chart, so a rate
 * dip that coincides with newly-added queries reads as expected, not a
 * regression. Lists up to two changes inline; collapses three or more into a
 * count + the most recent so the caption never sprawls into a messy run-on.
 * Returns null when there are no changes (nothing to render).
 */
export function formatQueryChangeCaption(changes: QueryChangeEvent[]): string | null {
  if (changes.length === 0) return null
  if (changes.length <= 2) {
    return `Query set changed: ${changes.map(c => `${signedDelta(c.delta)} on ${mmdd(c.date)}`).join(', ')}`
  }
  const latest = [...changes].sort((a, b) => b.date.localeCompare(a.date))[0]!
  return `Query set changed ${changes.length} times (latest ${signedDelta(latest.delta)} on ${mmdd(latest.date)})`
}
