import type {
  BrandMetricsDto,
  ModelAttribution,
  ModelAttributionEvent,
  ModelEvidenceState,
  QueryChangeEvent,
  TrendDirection,
} from '@ainyc/canonry-contracts'
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

export type TrendSeriesMode = 'overall' | 'byProvider'

/** Which metric line to plot. */
export type PresenceMetricChoice = 'cited' | 'mentioned'
export type MetricChoice = PresenceMetricChoice | 'mentionShare'

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

type BucketProviderMetric = BrandMetricsDto['buckets'][number]['byProvider'][string]
type BucketWithOptionalProviders = Omit<BrandMetricsDto['buckets'][number], 'byProvider'> & {
  byProvider?: Record<string, BucketProviderMetric | undefined>
}
type BucketWithOptionalModelEvidence = BrandMetricsDto['buckets'][number] & {
  modelEvidenceByProvider?: Record<string, ModelEvidenceState>
}
type MetricsWithOptionalModelAttribution = BrandMetricsDto & {
  modelAttribution?: ModelAttribution
}

export interface GroupedModelAttributionEvent {
  provider: string
  event: ModelAttributionEvent
}

export interface ModelAttributionEventBucket {
  bucketStartDate: string
  events: GroupedModelAttributionEvent[]
}

export function normalizeProviderKey(provider: string): string {
  return provider.trim().toLowerCase()
}

/** Presentation-only: 0-1 rate → 0-100 axis value, one decimal. */
function toPercent(rate: number): number {
  return Math.round(rate * 1000) / 10
}

function bucketProviders(bucket: BrandMetricsDto['buckets'][number]): Record<string, BucketProviderMetric | undefined> {
  return (bucket as BucketWithOptionalProviders).byProvider ?? {}
}

export function buildTrendRows(
  dto: BrandMetricsDto,
  metric: PresenceMetricChoice,
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
  const series = [...new Set(dto.buckets.flatMap(b => Object.keys(bucketProviders(b))))].sort()
  const rows: TrendRow[] = dto.buckets.map(b => {
    const row: TrendRow = { date: b.startDate }
    const providers = bucketProviders(b)
    for (const provider of series) {
      const metricRow = providers[provider]
      // null (not 0) when a provider has no data in this bucket — Recharts
      // `connectNulls` bridges the gap rather than dropping the line to zero.
      row[provider] = metricRow ? toPercent(metricRow[field]) : null
    }
    return row
  })
  return { rows, series, hasData, singleBucket }
}

/**
 * The web app can be served by a newer static bundle against an older API.
 * Keep a missing property distinct from the API's observed `unknown` state:
 * the former means attribution is unavailable, the latter means the sampled
 * snapshots did not record a model.
 */
export function readBucketModelEvidence(
  bucket: BrandMetricsDto['buckets'][number],
): Record<string, ModelEvidenceState> | null {
  const candidate = bucket as BucketWithOptionalModelEvidence
  if (!Object.hasOwn(candidate, 'modelEvidenceByProvider')) return null
  return candidate.modelEvidenceByProvider ?? {}
}

export function readModelAttribution(dto: BrandMetricsDto): ModelAttribution | null {
  const candidate = dto as MetricsWithOptionalModelAttribution
  if (!Object.hasOwn(candidate, 'modelAttribution')) return null
  return candidate.modelAttribution ?? {}
}

function findNormalizedProvider<T>(byProvider: Record<string, T | undefined>, provider: string): T | undefined {
  const target = normalizeProviderKey(provider)
  return Object.entries(byProvider).find(([key]) => normalizeProviderKey(key) === target)?.[1]
}

/** Human-readable, categorical evidence label. This never turns mixed data into a single model. */
export function formatModelEvidence(state: ModelEvidenceState): string {
  switch (state.status) {
    case 'known':
      return state.model
    case 'unknown':
      return 'Unknown model'
    case 'mixed':
      return `Mixed: ${state.models.join(', ')}${state.includesUnknown ? ' + unknown' : ''}`
  }
}

/**
 * Read the evidence from the same last bucket that draws a provider's plotted
 * point. Do not use run-detail/citation history: it can include a different
 * window, a probe, or a partial sweep that the analytics response excluded.
 */
export function latestPlottedProviderModelEvidence(
  buckets: readonly BrandMetricsDto['buckets'][number][],
  provider: string,
): ModelEvidenceState | null {
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    const bucket = buckets[index]!
    if (!findNormalizedProvider(bucketProviders(bucket), provider)) continue
    const evidence = readBucketModelEvidence(bucket)
    return evidence ? findNormalizedProvider(evidence, provider) ?? null : null
  }
  return null
}

/** Group categorical changes by the existing plotted bucket; no false-precision timestamp markers. */
export function groupModelAttributionEvents(
  attribution: ModelAttribution,
): ModelAttributionEventBucket[] {
  const byBucket = new Map<string, GroupedModelAttributionEvent[]>()
  for (const [provider, entry] of Object.entries(attribution)) {
    for (const event of entry.events) {
      const rows = byBucket.get(event.bucketStartDate) ?? []
      rows.push({ provider, event })
      byBucket.set(event.bucketStartDate, rows)
    }
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucketStartDate, events]) => ({
      bucketStartDate,
      events: [...events].sort((a, b) => a.provider.localeCompare(b.provider) || a.event.observedAt.localeCompare(b.event.observedAt)),
    }))
}

/**
 * How many changes the response actually carries vs how many it observed. The
 * server caps the per-provider list, so `total > shown` means the operator is
 * looking at a partial history and the UI has to say so.
 */
export function countModelAttributionEvents(
  attribution: ModelAttribution,
): { shown: number; total: number } {
  let shown = 0
  let total = 0
  for (const entry of Object.values(attribution)) {
    shown += entry.events.length
    // An older server omits `eventTotal`; its list is the whole history.
    total += entry.eventTotal ?? entry.events.length
  }
  return { shown, total }
}

export function buildMentionShareTrendRows(dto: BrandMetricsDto): TrendData {
  const rows: TrendRow[] = dto.buckets.map(b => {
    const mentionShare = (b as { mentionShare?: BrandMetricsDto['buckets'][number]['mentionShare'] }).mentionShare
    return {
      date: b.startDate,
      [MENTION_SHARE_KEY]: mentionShare?.rate == null ? null : toPercent(mentionShare.rate),
    }
  })
  const plottedValues = rows
    .map(row => row[MENTION_SHARE_KEY])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return {
    rows,
    series: [MENTION_SHARE_KEY],
    hasData: plottedValues.length > 0,
    singleBucket: plottedValues.length === 1,
  }
}

export function buildSelectedTrendRows(
  dto: BrandMetricsDto,
  metric: MetricChoice,
  mode: TrendSeriesMode,
): TrendData {
  if (metric === 'mentionShare') return buildMentionShareTrendRows(dto)
  return buildTrendRows(dto, metric, mode)
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
