import type {
  BasketChangeEvent,
  BrandMetricsDto,
  ModelAttribution,
  ModelAttributionEvent,
  ModelEvidenceState,
  ModelPointerChangeDisclosure,
  ModelServiceMismatch,
  QueryClass,
  ServedModelAttribution,
  TrendDirection,
  WindowRateChange,
} from '@ainyc/canonry-contracts'
import type { MetricTone } from '../view-models.js'
import {
  observedInstant,
  type ObservedInstant,
} from '../components/shared/ChartPrimitives.js'
import { formatMonthDay, formatSweepDay } from './format-helpers.js'

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
  servedModelAttribution?: ServedModelAttribution
  modelServiceMismatch?: Record<string, ModelServiceMismatch>
  modelPointerChanges?: Record<string, ModelPointerChangeDisclosure>
}

export interface GroupedModelAttributionEvent {
  provider: string
  event: ModelAttributionEvent
}

export interface ModelAttributionEventBucket {
  bucketStartDate: string
  events: GroupedModelAttributionEvent[]
}

/**
 * The real observation window a bucket actually covers. `bucket.startDate` is a
 * synthetic boundary anchored to the window's earliest run — a sweep can sit a
 * week or more inside its own bucket — so it is a grouping key, never a date to
 * show. These are the sweep timestamps themselves.
 */
export interface BucketObservedRange {
  start: ObservedInstant
  end: ObservedInstant
  /** Distinct sweeps pooled into this one plotted point. */
  sweepCount: number
}

/** Standalone (not an intersection) so the optionality survives — an older API omits all three. */
interface OptionalObservedRangeFields {
  dataStartDate?: string
  dataEndDate?: string
  sweepCount?: number
}

/**
 * A newer bundle can run against an older API that predates the real-range
 * fields. Missing is NOT an excuse to fall back to `startDate`: that boundary
 * is exactly the wrong date. Return null and let the caller say so plainly.
 */
export function readBucketObservedRange(
  bucket: BrandMetricsDto['buckets'][number],
): BucketObservedRange | null {
  const candidate = bucket as unknown as OptionalObservedRangeFields
  const { dataStartDate, dataEndDate } = candidate
  if (typeof dataStartDate !== 'string' || typeof dataEndDate !== 'string') return null
  return {
    start: observedInstant(dataStartDate),
    end: observedInstant(dataEndDate),
    sweepCount: candidate.sweepCount ?? 1,
  }
}

/**
 * A real instant as a day in the viewer's timezone: "Sep 29", with the year
 * only outside the current one. The same en-US style as the Visibility card's
 * sweep times, so one page never mixes "Sep 29" with "29 Sept".
 */
export function formatObservedDay(instant: ObservedInstant, now: Date = new Date()): string {
  return formatSweepDay(instant, now)
}

/** The days a bucket's sweeps span: "Sep 29", or "Mar 13 to Apr 8". Null on an older API. */
export function formatBucketDayRange(bucket: BrandMetricsDto['buckets'][number], now: Date = new Date()): string | null {
  const range = readBucketObservedRange(bucket)
  if (!range) return null
  const start = formatObservedDay(range.start, now)
  const end = formatObservedDay(range.end, now)
  return start === end ? start : `${start} to ${end}`
}

/**
 * The date a bucket's point is really about, in the viewer's own timezone, and
 * always how many sweeps it pools ("Sep 29 · 2 sweeps", "Mar 13 to Apr 8 · 41
 * sweeps"): two sweeps on one day are still two readings, and a multi-week
 * average must never look like a single one.
 */
export function formatBucketDateLabel(bucket: BrandMetricsDto['buckets'][number], now: Date = new Date()): string {
  const range = readBucketObservedRange(bucket)
  const days = formatBucketDayRange(bucket, now)
  if (!range || !days) return 'Sweep date unavailable'
  return `${days} · ${range.sweepCount} ${range.sweepCount === 1 ? 'sweep' : 'sweeps'}`
}

/** Axis tick for a bucket ("Mar 13"): the first sweep it actually contains, in the viewer's timezone. */
export function formatBucketDateTick(bucket: BrandMetricsDto['buckets'][number]): string {
  const range = readBucketObservedRange(bucket)
  return range ? formatMonthDay(range.start) : ''
}

export function normalizeProviderKey(provider: string): string {
  return provider.trim().toLowerCase()
}

/**
 * The tracked competitor set as a cache-key segment. Analytics reads that
 * depend on it rotate their key when a competitor is added or removed, so the
 * change costs one fetch rather than an invalidation plus a refetch.
 */
export function competitorFrameKey(competitorDomains: readonly string[]): string {
  return competitorDomains
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('\n')
}

/** Human-friendly engine names (data keys are lowercase). */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  muse: 'Muse',
  local: 'Local',
}

/** An engine's name as people read it ("OpenAI", "Perplexity"). */
export function providerDisplayName(name: string): string {
  const key = normalizeProviderKey(name)
  return PROVIDER_DISPLAY_NAMES[key] ?? name.charAt(0).toUpperCase() + name.slice(1)
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

/**
 * What the engines reported actually answering with. An older API omits the
 * field entirely and a project whose window predates served capture returns
 * `{}` — both render as "nothing to say", never as a change.
 */
export function readServedModelAttribution(dto: BrandMetricsDto): ServedModelAttribution {
  return (dto as MetricsWithOptionalModelAttribution).servedModelAttribution ?? {}
}

export function readModelServiceMismatch(dto: BrandMetricsDto): Record<string, ModelServiceMismatch> {
  return (dto as MetricsWithOptionalModelAttribution).modelServiceMismatch ?? {}
}

/**
 * Providers whose numbers were produced by a model id the provider is free to
 * move onto a different underlying model. Absent on an older API, empty for a
 * project on fixed model ids. The sentence a reader sees is built from these
 * facts by `buildModelChangeNotice` in contracts, which the CLI calls too, so
 * neither surface can word this caveat more softly than the other.
 */
export function readModelPointerChanges(dto: BrandMetricsDto): Record<string, ModelPointerChangeDisclosure> {
  return (dto as MetricsWithOptionalModelAttribution).modelPointerChanges ?? {}
}

/** "a", "a and b", "a, b and c". */
export function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Human-readable, categorical evidence label. This never turns mixed data into
 * a single model: "a, b", or "a, b and an unknown model".
 */
export function formatModelEvidence(state: ModelEvidenceState): string {
  switch (state.status) {
    case 'known':
      return state.model
    case 'unknown':
      return 'Unknown model'
    case 'mixed':
      if (state.models.length === 0) return 'Unknown model'
      return `${state.models.join(', ')}${state.includesUnknown ? ' and an unknown model' : ''}`
  }
}

/** A mixed point's models as a phrase ("a and b", "a, b and an unknown model"). */
export function formatMixedModels(state: Extract<ModelEvidenceState, { status: 'mixed' }>): string {
  return joinWithAnd([...state.models, ...(state.includesUnknown ? ['an unknown model'] : [])])
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
 * An event whose `from` state is the pre-window anchor did NOT necessarily
 * happen inside the window — it happened somewhere between the last sweep
 * before the window and the first sweep inside it. Its `bucketStartDate` is
 * therefore the bucket where the new state was first SEEN, not where the change
 * occurred, and drawing a chart marker there tells the operator a change
 * happened on a date it may well not have.
 *
 * So the two kinds are separated at the source: only `buckets` may become chart
 * markers, and `beforeWindow` still renders in the written summary (dated "on
 * or before", with its lower bound) so a real change is never dropped — it is
 * just never placed inside the window.
 */
export interface ModelAttributionEventPartition {
  /** Changes datable to a plotted bucket. Safe to mark on the chart. */
  buckets: ModelAttributionEventBucket[]
  /** Changes that happened before the window opened. Never marked on the chart. */
  beforeWindow: GroupedModelAttributionEvent[]
}

export function partitionModelAttributionEvents(
  attribution: ModelAttribution,
): ModelAttributionEventPartition {
  const inWindow: ModelAttribution = {}
  const beforeWindow: GroupedModelAttributionEvent[] = []
  for (const [provider, entry] of Object.entries(attribution)) {
    const datable = entry.events.filter(event => !event.fromPreWindowAnchor)
    for (const event of entry.events) {
      if (event.fromPreWindowAnchor) beforeWindow.push({ provider, event })
    }
    if (datable.length > 0) inWindow[provider] = { ...entry, events: datable }
  }
  return {
    buckets: groupModelAttributionEvents(inWindow),
    beforeWindow: beforeWindow.sort((a, b) =>
      a.event.observedAt.localeCompare(b.event.observedAt) || a.provider.localeCompare(b.provider)),
  }
}

export interface ProviderEventCount {
  provider: string
  shown: number
  total: number
}

/**
 * Exactly the providers whose own event list the server capped, each with its
 * own pair. This is what the truncation note must be built from: with gemini at
 * 2 of 40 and openai complete at 1 of 1, a pooled "showing 3 of 41" invites the
 * operator to distrust openai's history too, which is a false statement about
 * that engine.
 */
export function truncatedProviderCounts(attribution: ModelAttribution): ProviderEventCount[] {
  const truncated: ProviderEventCount[] = []
  for (const [provider, entry] of Object.entries(attribution)) {
    const total = entry.eventTotal ?? entry.events.length
    if (total > entry.events.length) truncated.push({ provider, shown: entry.events.length, total })
  }
  return truncated.sort((a, b) => a.provider.localeCompare(b.provider))
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
 * The API's own 0-1 rate behind each plotted point of the selected metric,
 * oldest first: the overall rate of every bucket, or each bucket's mention
 * share where it has one. The chart rows are rounded to the axis, so any figure
 * a reader sees is formatted from these instead; a rate that rounds to 0.0
 * still reads `<0.1%`. Selects values only, never recomputes one.
 */
export function plottedMetricRates(dto: BrandMetricsDto, metric: MetricChoice): number[] {
  if (metric === 'mentionShare') {
    return dto.buckets.flatMap(b => {
      const rate = (b as { mentionShare?: BrandMetricsDto['buckets'][number]['mentionShare'] }).mentionShare?.rate
      return typeof rate === 'number' && Number.isFinite(rate) ? [rate] : []
    })
  }
  const field: 'citationRate' | 'mentionRate' = metric === 'cited' ? 'citationRate' : 'mentionRate'
  return dto.buckets.map(b => b[field])
}

/**
 * The server's change across the window for the selected metric: its first
 * and latest bucket rates and the difference between them, or null when fewer
 * than two buckets carry the rate. Selects the API's value, never subtracts.
 */
export function metricWindowChange(dto: BrandMetricsDto, metric: MetricChoice): WindowRateChange | null {
  // A response that predates the field has no change to show, never a zero.
  const windowChange = (dto as { windowChange?: BrandMetricsDto['windowChange'] }).windowChange
  if (!windowChange) return null
  switch (metric) {
    case 'cited': return windowChange.citationRate
    case 'mentioned': return windowChange.mentionRate
    case 'mentionShare': return windowChange.mentionShare
  }
}

/**
 * One engine's most recent 0-1 rate: the bucket the right end of its line is
 * drawn from, skipping the buckets it is missing from (the gaps `connectNulls`
 * bridges). Same field choice as `buildTrendRows` in by-engine mode, so it is
 * the unrounded value of that point. Returns null when the engine never appears.
 */
export function latestProviderRate(dto: BrandMetricsDto, provider: string, metric: PresenceMetricChoice): number | null {
  const field: 'citationRate' | 'mentionRate' = metric === 'mentioned' ? 'mentionRate' : 'citationRate'
  for (let i = dto.buckets.length - 1; i >= 0; i--) {
    const metricRow = bucketProviders(dto.buckets[i]!)[provider]
    if (metricRow) return metricRow[field]
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

// ── What changed: the query set and the models behind the trend ──

type MetricsBucket = BrandMetricsDto['buckets'][number]

function instantMs(value: string): number {
  return Date.parse(value)
}

/** True when `at` falls between a point's first and last sweep, inclusive. */
function withinBucket(bucket: MetricsBucket, at: string): boolean {
  const range = readBucketObservedRange(bucket)
  if (!range) return false
  const time = instantMs(at)
  return time >= instantMs(range.start) && time <= instantMs(range.end)
}

/** The recorded query-set changes. An older API omits the field; that reads as none. */
export function readBasketChanges(dto: BrandMetricsDto): BasketChangeEvent[] {
  return (dto as { basketChanges?: BasketChangeEvent[] }).basketChanges ?? []
}

/** The query-set changes first measured inside one plotted point, oldest first. */
export function basketChangesInBucket(bucket: MetricsBucket, changes: readonly BasketChangeEvent[]): BasketChangeEvent[] {
  return changes
    .filter(change => withinBucket(bucket, change.at))
    .sort((a, b) => instantMs(a.at) - instantMs(b.at))
}

/**
 * A Perplexity preset (`fast`, `low`, ...) picks its own model for every
 * answer, so answering with a different model is the preset working, not a
 * substitution. A fixed Perplexity model is a `vendor/model` slug (the
 * provider's model registry), so an id without "/" is a preset.
 */
export function isPerplexityPreset(provider: string, state: ModelEvidenceState): boolean {
  return normalizeProviderKey(provider) === 'perplexity' && state.status === 'known' && !state.model.includes('/')
}

/** Every served-model mismatch that is a real substitution: all but a Perplexity preset's. */
export function substitutedModels(
  mismatch: Record<string, ModelServiceMismatch>,
): Array<{ provider: string; mismatch: ModelServiceMismatch }> {
  return Object.entries(mismatch)
    .filter(([provider, entry]) => !isPerplexityPreset(provider, entry.configured))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => ({ provider, mismatch: entry }))
}

export interface QuerySetChange {
  /** The first sweep on the new query set. */
  at: ObservedInstant
  /** Stored query keys (normalized query text). */
  added: string[]
  removed: string[]
  /** Queries measured before and after. Null when the response has no point to count from. */
  fromCount: number | null
  toCount: number | null
}

/**
 * The window's query-set changes, newest first, with the query count on either
 * side. The server holds every plotted point to the newest query set, so the
 * latest point's count is the set after the newest change; each earlier count
 * walks back through a change's added and removed queries.
 */
export function querySetChanges(dto: BrandMetricsDto): QuerySetChange[] {
  let count: number | null = dto.buckets.at(-1)?.queryCount ?? null
  return [...readBasketChanges(dto)]
    .sort((a, b) => instantMs(b.at) - instantMs(a.at))
    .map(change => {
      const toCount = count
      const before = toCount === null ? null : toCount - change.added.length + change.removed.length
      count = before !== null && before >= 0 ? before : null
      return { at: observedInstant(change.at), added: change.added, removed: change.removed, fromCount: count, toCount }
    })
}

export interface ModelChangeRow {
  provider: string
  /** The first sweep on the new model. */
  at: ObservedInstant
  /** Inherited from before the window: it happened after `anchorAt`, on or before `at`. */
  onOrBefore: boolean
  anchorAt: ObservedInstant | null
  from: ModelEvidenceState
  to: ModelEvidenceState
  /** For a move onto a Perplexity preset: what the engine answered with on either side. */
  served: { from: ModelEvidenceState; to: ModelEvidenceState } | null
  /** A preset that kept its id while the engine moved it onto a different model. */
  reroute: boolean
}

/** The model a provider was set to at `at`: the last change on or before it, else the first change's `from`. */
function configuredStateAt(entry: ModelAttribution[string], at: string): ModelEvidenceState {
  const events = [...entry.events].sort((a, b) => instantMs(a.observedAt) - instantMs(b.observedAt))
  let state = events[0]?.from ?? entry.latestObservation.state
  for (const event of events) {
    if (instantMs(event.observedAt) <= instantMs(at)) state = event.to
  }
  return state
}

function modelChangeRow(
  provider: string,
  event: ModelAttributionEvent,
  served: ModelChangeRow['served'],
  reroute: boolean,
): ModelChangeRow {
  return {
    provider,
    at: observedInstant(event.observedAt),
    onOrBefore: event.fromPreWindowAnchor === true,
    anchorAt: event.anchorObservedAt ? observedInstant(event.anchorObservedAt) : null,
    from: event.from,
    to: event.to,
    served,
    reroute,
  }
}

/**
 * Every model change in the window as one row, newest first. A Perplexity
 * preset keeps its id while the engine picks the model, so the served series
 * joins in two ways: the served move behind a switch onto the preset, and any
 * later re-route under it, which the configured series never shows.
 */
export function modelChangeRows(attribution: ModelAttribution, served: ServedModelAttribution): ModelChangeRow[] {
  const rows: ModelChangeRow[] = []
  for (const [provider, entry] of Object.entries(attribution)) {
    const servedEntry = served[provider] as ServedModelAttribution[string] | undefined
    const servedEvents = servedEntry?.events ?? []
    const configuredAt = new Set(entry.events.map(event => event.observedAt))
    for (const event of entry.events) {
      const servedEvent = isPerplexityPreset(provider, event.to)
        ? servedEvents.find(candidate => candidate.observedAt === event.observedAt)
        : undefined
      rows.push(modelChangeRow(provider, event, servedEvent ? { from: servedEvent.from, to: servedEvent.to } : null, false))
    }
    for (const event of servedEvents) {
      if (configuredAt.has(event.observedAt)) continue
      if (!isPerplexityPreset(provider, configuredStateAt(entry, event.observedAt))) continue
      rows.push(modelChangeRow(provider, event, null, true))
    }
  }
  return rows.sort((a, b) => instantMs(b.at) - instantMs(a.at) || a.provider.localeCompare(b.provider))
}

/**
 * The collapsed "What changed" line. It names what the latest point first
 * measured ("Sep 29 · 3 queries added · 4 new models"), or, when that point
 * brought nothing new, the day of the newest change. Null when nothing changed.
 */
export function whatChangedSummary({ latest, queryChanges, modelRows, now = new Date() }: {
  latest: MetricsBucket | undefined
  queryChanges: readonly QuerySetChange[]
  modelRows: readonly ModelChangeRow[]
  now?: Date
}): string | null {
  const instants = [...queryChanges.map(change => change.at), ...modelRows.map(row => row.at)]
  if (instants.length === 0) return null
  const inLatest = (at: string) => latest !== undefined && withinBucket(latest, at)
  const latestQueries = queryChanges.filter(change => inLatest(change.at))
  const added = latestQueries.reduce((sum, change) => sum + change.added.length, 0)
  const removed = latestQueries.reduce((sum, change) => sum + change.removed.length, 0)
  const models = modelRows.filter(row => inLatest(row.at)).length
  const days = latest ? formatBucketDayRange(latest, now) : null
  if (days === null || added + removed + models === 0) {
    const newest = instants.reduce((a, b) => (instantMs(b) > instantMs(a) ? b : a))
    return `No changes since ${formatObservedDay(newest, now)}`
  }
  const parts = [days]
  if (added > 0) parts.push(`${added} ${added === 1 ? 'query' : 'queries'} added`)
  if (removed > 0) parts.push(`${removed} ${removed === 1 ? 'query' : 'queries'} removed`)
  if (models > 0) parts.push(`${models} new ${models === 1 ? 'model' : 'models'}`)
  return parts.join(' · ')
}

/**
 * The sweep right before `at`, or null when no known sweep is provably the
 * adjacent one. A date that is only "some earlier sweep" would misstate when
 * the change could have happened, so a gap in what is known leaves it out.
 *
 * - `recentSweeps`: the newest real sweeps, a contiguous run back from the
 *   latest, so the newest of them before `at` is the adjacent one.
 * - `buckets`: a point's first and last sweeps. A pooled point hides the
 *   sweeps between them, so a boundary counts only when nothing can sit in
 *   between: `at` opens its point (the point before ends on the adjacent
 *   sweep), or `at` closes a two-sweep point (its first sweep is adjacent).
 * - `windowAnchor`: the last sweep before the window, adjacent to its first.
 */
export function sweepBefore(
  at: string,
  recentSweeps: readonly string[],
  buckets: readonly MetricsBucket[],
  windowAnchor: string | null = null,
): ObservedInstant | null {
  const atMs = instantMs(at)
  if (!Number.isFinite(atMs)) return null
  const recent = recentSweeps.filter(time => instantMs(time) < atMs)
  if (recent.length > 0) return observedInstant(recent.reduce((a, b) => (instantMs(b) > instantMs(a) ? b : a)))

  const ranges = buckets
    .map(bucket => readBucketObservedRange(bucket))
    .filter((range): range is BucketObservedRange => range !== null)
    .sort((a, b) => instantMs(a.start) - instantMs(b.start))
  const index = ranges.findIndex(range => instantMs(range.start) <= atMs && atMs <= instantMs(range.end))
  if (index === -1) return null
  const range = ranges[index]!
  if (instantMs(range.start) === atMs) {
    if (index > 0) return ranges[index - 1]!.end
    return windowAnchor && instantMs(windowAnchor) < atMs ? observedInstant(windowAnchor) : null
  }
  return range.sweepCount === 2 && instantMs(range.end) === atMs ? range.start : null
}

/** How the query set moved between the first and latest plotted points. */
export interface QuerySetShift {
  /** Recorded changes after the first point's first sweep, up to the latest point's last. */
  changes: BasketChangeEvent[]
  firstCount: number
  latestCount: number
}

/**
 * Whether the first and latest plotted points measured different query sets:
 * their query counts differ, or a recorded change falls after the first
 * point's first sweep. Null when the set held still, or with one point.
 */
export function querySetShift(
  plotted: readonly MetricsBucket[],
  changes: readonly BasketChangeEvent[],
): QuerySetShift | null {
  if (plotted.length < 2) return null
  const first = plotted[0]!
  const latest = plotted.at(-1)!
  const start = readBucketObservedRange(first)?.start ?? first.startDate
  const end = readBucketObservedRange(latest)?.end ?? latest.endDate
  const inWindow = changes
    .filter(change => instantMs(change.at) > instantMs(start) && instantMs(change.at) <= instantMs(end))
    .sort((a, b) => instantMs(a.at) - instantMs(b.at))
  if (inWindow.length === 0 && first.queryCount === latest.queryCount) return null
  return { changes: inWindow, firstCount: first.queryCount, latestCount: latest.queryCount }
}

/**
 * Whether the headline may print its first-to-latest change. Not across a
 * query-set change: the figure would compare two different baskets. Mention
 * share is the one exception, because it reads non-brand answers only: a
 * change that added or removed branded queries alone leaves its set intact.
 * `classify` must be the metrics route's brand matcher.
 */
export function showsChangeFigure(
  shift: QuerySetShift | null,
  metric: MetricChoice,
  mentionShareScope: 'non-brand' | 'pooled',
  classify?: (queryText: string) => QueryClass | null,
): boolean {
  if (!shift) return true
  if (metric !== 'mentionShare' || mentionShareScope !== 'non-brand' || !classify) return false
  const keys = shift.changes.flatMap(change => [...change.added, ...change.removed])
  return keys.length > 0 && keys.every(key => classify(key) === 'branded')
}
