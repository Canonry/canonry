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
export const MENTION_SHARE_KEY = '__mentionShare__'
export const MENTION_SHARE_META_KEY = '__mentionShareMeta__'
export const MENTION_SHARE_SERIES_META_PREFIX = '__mentionShareSeriesMeta__'
export const MENTION_DISTRIBUTION_PROJECT_ONLY_KEY = '__mentionDistributionProjectOnly__'
export const MENTION_DISTRIBUTION_SHARED_KEY = '__mentionDistributionShared__'
export const MENTION_DISTRIBUTION_COMPETITOR_ONLY_KEY = '__mentionDistributionCompetitorOnly__'
export const MENTION_DISTRIBUTION_UNMENTIONED_KEY = '__mentionDistributionUnmentioned__'
export const MENTION_DISTRIBUTION_KEYS = [
  MENTION_DISTRIBUTION_PROJECT_ONLY_KEY,
  MENTION_DISTRIBUTION_SHARED_KEY,
  MENTION_DISTRIBUTION_COMPETITOR_ONLY_KEY,
  MENTION_DISTRIBUTION_UNMENTIONED_KEY,
] as const

export type TrendSeriesMode = 'overall' | 'byProvider'
export type MentionShareSeriesMode = 'overall' | 'byProvider' | 'byLocation'

/** Which metric line to plot. */
export type MetricChoice = 'cited' | 'mentioned'

export interface TrendRow {
  date: string
  [series: string]: number | string | null | MentionShareTrendMeta
}

export interface MentionShareTrendMeta {
  projectMentionEvents: number
  brandMentionEvents: number
  answerObservations: number
  projectOnlyObservations: number
  sharedObservations: number
  competitorOnlyObservations: number
  unmentionedObservations: number
}

interface MentionShareMetricInput {
  projectMentionEvents: number
  competitorMentionEvents?: number
  brandMentionEvents: number
  answerObservations: number
  projectOnlyObservations?: number
  sharedObservations?: number
  competitorOnlyObservations?: number
  unmentionedObservations?: number
}

type TrendBucket = BrandMetricsDto['buckets'][number]
type LegacyTrendBucket = Omit<TrendBucket, 'byProvider' | 'mentionShare'> & Partial<Pick<TrendBucket, 'byProvider' | 'mentionShare'>>

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

export function mentionShareSeriesMetaKey(seriesKey: string): string {
  return `${MENTION_SHARE_SERIES_META_PREFIX}${seriesKey}`
}

function mentionShareMeta(metric: MentionShareMetricInput): MentionShareTrendMeta {
  const projectOnlyObservations = metric.projectOnlyObservations ?? metric.projectMentionEvents
  const sharedObservations = metric.sharedObservations ?? 0
  const competitorOnlyObservations = metric.competitorOnlyObservations ?? metric.competitorMentionEvents ?? 0
  const unmentionedObservations = metric.unmentionedObservations
    ?? Math.max(metric.answerObservations - projectOnlyObservations - sharedObservations - competitorOnlyObservations, 0)
  return {
    projectMentionEvents: metric.projectMentionEvents,
    brandMentionEvents: metric.brandMentionEvents,
    answerObservations: metric.answerObservations,
    projectOnlyObservations,
    sharedObservations,
    competitorOnlyObservations,
    unmentionedObservations,
  }
}

function mentionDistributionPercent(metric: MentionShareTrendMeta, key: typeof MENTION_DISTRIBUTION_KEYS[number]): number | null {
  if (metric.answerObservations === 0) return null
  const count = key === MENTION_DISTRIBUTION_PROJECT_ONLY_KEY
    ? metric.projectOnlyObservations
    : key === MENTION_DISTRIBUTION_SHARED_KEY
      ? metric.sharedObservations
      : key === MENTION_DISTRIBUTION_COMPETITOR_ONLY_KEY
        ? metric.competitorOnlyObservations
        : metric.unmentionedObservations
  return toPercent(count / metric.answerObservations)
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
  const buckets = dto.buckets as LegacyTrendBucket[]
  const series = [...new Set(buckets.flatMap(b => Object.keys(b.byProvider ?? {})))].sort()
  const rows: TrendRow[] = buckets.map(b => {
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

export function buildMentionShareTrendRows(
  dto: BrandMetricsDto,
  mode: MentionShareSeriesMode = 'overall',
): TrendData {
  const buckets = dto.buckets as LegacyTrendBucket[]
  const series = mode === 'overall'
    ? [...MENTION_DISTRIBUTION_KEYS]
    : [...new Set(buckets.flatMap(b => Object.keys(b.mentionShare?.[mode] ?? {})))].sort()
  const rows: TrendRow[] = buckets.map(b => {
    const mentionShare = b.mentionShare
    const meta = mentionShare === undefined ? null : mentionShareMeta(mentionShare)
    const row: TrendRow = {
      date: b.startDate,
      [MENTION_SHARE_META_KEY]: meta,
    }
    if (mode === 'overall') {
      row[MENTION_SHARE_KEY] = mentionShare?.rate == null ? null : toPercent(mentionShare.rate)
      for (const key of MENTION_DISTRIBUTION_KEYS) {
        row[key] = meta === null ? null : mentionDistributionPercent(meta, key)
      }
    } else {
      const scopedMetrics = mentionShare?.[mode] ?? {}
      for (const key of series) {
        if (!(key in scopedMetrics)) {
          row[key] = null
          continue
        }
        const metric = scopedMetrics[key]
        row[key] = metric.rate === null ? null : toPercent(metric.rate)
        row[mentionShareSeriesMetaKey(key)] = mentionShareMeta(metric)
      }
    }
    return row
  })
  const plottedBucketCount = rows.filter(row =>
    series.some(key => typeof row[key] === 'number' && Number.isFinite(row[key] as number)),
  ).length
  return {
    rows,
    series,
    hasData: plottedBucketCount > 0,
    singleBucket: plottedBucketCount === 1,
  }
}

/**
 * The most recent plotted value for a series — the value at the right end of
 * its line. A direct read of the rows the chart already draws (skips the
 * trailing `null`s `connectNulls` bridges over), used to label the per-engine
 * legend without recomputing any rate. Returns null when the series never
 * appears.
 */
export function latestSeriesValue(rows: TrendRow[], key: string): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i]![key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
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
