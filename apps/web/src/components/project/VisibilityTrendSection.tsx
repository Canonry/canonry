import { Fragment, useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BrandMetricsDto, MetricsWindow } from '@ainyc/canonry-contracts'
import {
  CartesianGrid,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_NEUTRAL,
  CHART_SERIES_COLORS,
  CHART_TONE,
  ComposedChart,
  formatChartDateLabel,
  formatChartDateTick,
  Line,
  providerSeriesColor,
  ReferenceLine,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from '../shared/ChartPrimitives.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { fetchAnalyticsMetrics } from '../../api.js'
import { STATIC_VISIBILITY_STALE_MS } from '../../queries/query-client.js'
import {
  buildSelectedTrendRows,
  CITED_KEY,
  formatModelEvidence,
  formatQueryChangeCaption,
  groupModelAttributionEvents,
  latestSeriesValue,
  latestPlottedProviderModelEvidence,
  MENTION_SHARE_KEY,
  MENTIONED_KEY,
  normalizeProviderKey,
  readBucketModelEvidence,
  readModelAttribution,
  type MetricChoice,
  type TrendSeriesMode,
} from '../../lib/visibility-trend-helpers.js'

const WINDOW_OPTIONS: Array<{ value: MetricsWindow; label: string }> = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
]
const MODE_OPTIONS: Array<{ value: TrendSeriesMode; label: string }> = [
  { value: 'byProvider', label: 'By engine' },
  { value: 'overall', label: 'All engines' },
]
const METRIC_OPTIONS: Array<{ value: MetricChoice; label: string; description: string }> = [
  {
    value: 'mentioned',
    label: 'Mentioned',
    description: 'Your brand or domain appears in the answer text.',
  },
  {
    value: 'cited',
    label: 'Cited',
    description: 'Your domain appears in source or grounding links.',
  },
  {
    value: 'mentionShare',
    label: 'Mention share',
    description: 'Of all answer-text brand mentions for you and tracked competitors, the share that were you.',
  },
]
const MENTION_SHARE_COLOR = CHART_SERIES_COLORS[2]!

/** Dark ring drawn around the active (hovered) dot so it reads against the line. */
const ACTIVE_DOT_RING = 'var(--chart-tooltip-bg)'

/** Human-friendly engine names for the legend and tooltip (data keys are lowercase). */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  local: 'Local',
}

function providerDisplayName(name: string): string {
  const key = normalizeProviderKey(name)
  return PROVIDER_DISPLAY_NAMES[key] ?? name.charAt(0).toUpperCase() + name.slice(1)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function isOverallSeries(key: string): boolean {
  return key === CITED_KEY || key === MENTIONED_KEY || key === MENTION_SHARE_KEY
}

function seriesLabel(key: string): string {
  if (key === CITED_KEY) return 'Cited'
  if (key === MENTIONED_KEY) return 'Mentioned'
  if (key === MENTION_SHARE_KEY) return 'Mention share'
  return providerDisplayName(key)
}

function seriesColor(key: string, index: number): string {
  if (key === CITED_KEY) return CHART_TONE.positive // emerald
  if (key === MENTIONED_KEY) return CHART_SERIES_COLORS[1]! // blue
  if (key === MENTION_SHARE_KEY) return MENTION_SHARE_COLOR
  return providerSeriesColor(normalizeProviderKey(key), index)
}

function firstSeriesValue(rows: Array<Record<string, string | number | null>>, key: string): number | null {
  for (const row of rows) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function competitorFrameKey(competitorDomains: readonly string[]): string {
  return competitorDomains
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('\n')
}

type MetricsBucket = BrandMetricsDto['buckets'][number]
type ProviderMetricBucket = MetricsBucket['byProvider'][string]

interface TooltipPayloadItem {
  name?: string | number
  dataKey?: string | number
  value?: string | number | null
  color?: string
}

function metricLabel(metric: MetricChoice): string {
  if (metric === 'cited') return 'Cited'
  if (metric === 'mentionShare') return 'Mention share'
  return 'Mentioned'
}

function metricField(metric: Exclude<MetricChoice, 'mentionShare'>): 'citationRate' | 'mentionRate' {
  return metric === 'cited' ? 'citationRate' : 'mentionRate'
}

function metricCount(bucket: MetricsBucket, metric: Exclude<MetricChoice, 'mentionShare'>): number {
  return metric === 'cited' ? bucket.cited : bucket.mentionedCount
}

function providerMetricCount(
  bucket: MetricsBucket,
  provider: string,
  metric: Exclude<MetricChoice, 'mentionShare'>,
): { count: number; total: number; rate: number } | null {
  const row = (bucket.byProvider as Record<string, ProviderMetricBucket | undefined>)[provider]
  if (!row) return null
  return {
    count: metric === 'cited' ? row.cited : row.mentionedCount,
    total: row.total,
    rate: metric === 'cited' ? row.citationRate : row.mentionRate,
  }
}

function findBucket(buckets: readonly MetricsBucket[], label: string | number | undefined): MetricsBucket | null {
  if (label === undefined) return null
  const key = String(label)
  return buckets.find(b => b.startDate === key) ?? null
}

function formatBucketModelEvidence(bucket: MetricsBucket): string {
  const evidence = readBucketModelEvidence(bucket)
  if (evidence === null) return 'Model attribution unavailable for this bucket.'
  const labels = Object.entries(evidence)
    .sort(([a], [b]) => normalizeProviderKey(a).localeCompare(normalizeProviderKey(b)))
    .map(([provider, state]) => `${providerDisplayName(provider)}: ${formatModelEvidence(state)}`)
  return labels.length > 0 ? `Model evidence: ${labels.join('; ')}` : 'No model evidence in this bucket.'
}

function modelEventMarkerColor(events: ReturnType<typeof groupModelAttributionEvents>[number]['events']): string {
  if (events.some(({ event }) => event.to.status === 'mixed')) return CHART_TONE.caution
  if (events.some(({ event }) => event.to.status === 'unknown')) return CHART_TONE.negative
  if (events.every(({ event }) => event.from.status === 'known' && event.to.status === 'known')) return CHART_SERIES_COLORS[4]!
  return CHART_TONE.positive
}

function ModelEvidenceSummary({
  events,
  available,
}: {
  events: ReturnType<typeof groupModelAttributionEvents>
  available: boolean
}) {
  const descriptionId = useId()
  return (
    <aside className="trend-model-evidence" aria-labelledby="trend-model-evidence-title" aria-describedby={descriptionId}>
      <div className="trend-model-evidence-head">
        <p id="trend-model-evidence-title" className="trend-model-evidence-title">Model evidence changes</p>
        <span className="trend-model-evidence-key" aria-hidden="true">Dashed chart markers</span>
      </div>
      <p id={descriptionId} className="sr-only">
        Model evidence is recorded from the exact snapshots that produced each trend bucket. It is not the project’s configured provider model.
      </p>
      {!available ? (
        <p className="trend-model-evidence-empty">Attribution unavailable from this API version.</p>
      ) : events.length === 0 ? (
        <p className="trend-model-evidence-empty">No model evidence changes in this window.</p>
      ) : (
        <ul className="trend-model-evidence-list">
          {events.flatMap(({ bucketStartDate, events: bucketEvents }) => bucketEvents.map(({ provider, event }) => (
            <li key={`${provider}-${event.observedAt}-${event.bucketStartDate}`} className="trend-model-evidence-item">
              <span className="trend-model-evidence-date">{formatChartDateLabel(bucketStartDate)}</span>
              <span>{providerDisplayName(provider)}: {formatModelEvidence(event.from)} → {formatModelEvidence(event.to)}</span>
            </li>
          )))}
        </ul>
      )}
    </aside>
  )
}

function formatPercent(value: number | null): string {
  return value === null ? 'no data' : `${value}%`
}

function formatRatePercent(rate: number | null | undefined): string {
  return rate == null ? 'undefined' : `${round1(rate * 100)}%`
}

function TrendTooltip({
  active,
  label,
  payload,
  metric,
  mode,
  buckets,
}: {
  active?: boolean
  label?: string | number
  payload?: TooltipPayloadItem[]
  metric: MetricChoice
  mode: TrendSeriesMode
  buckets: readonly MetricsBucket[]
}) {
  if (!active) return null
  const bucket = findBucket(buckets, label)
  if (!bucket) return null

  if (metric === 'mentionShare') {
    const projectMentions = bucket.mentionShare.projectMentionSnapshots
    const competitorMentions = bucket.mentionShare.competitorMentionSnapshots
    const denominator = projectMentions + competitorMentions
    const rate = bucket.mentionShare.rate == null ? null : round1(bucket.mentionShare.rate * 100)
    return (
      <div className="trend-tooltip">
        <p className="trend-tooltip-label">{formatChartDateLabel(bucket.startDate)}</p>
        <div className="trend-tooltip-row">
          <span className="trend-tooltip-swatch trend-tooltip-swatch-ring" style={{ borderColor: MENTION_SHARE_COLOR }} aria-hidden="true" />
          <span className="trend-tooltip-name">Mention share</span>
          <span className="trend-tooltip-value">{formatPercent(rate)}</span>
        </div>
        {denominator > 0 ? (
          <p className="trend-tooltip-detail">You {projectMentions} / {denominator} brand mentions. Competitors {competitorMentions}.</p>
        ) : (
          <p className="trend-tooltip-detail">No project or competitor brand mentions in this bucket.</p>
        )}
        <p className="trend-tooltip-detail">{formatBucketModelEvidence(bucket)}</p>
      </div>
    )
  }

  const items = mode === 'byProvider'
    ? (payload ?? []).filter(item => item.dataKey !== undefined)
    : [{ dataKey: metric === 'cited' ? CITED_KEY : MENTIONED_KEY, value: round1(bucket[metricField(metric)] * 100) }]
  return (
    <div className="trend-tooltip">
      <p className="trend-tooltip-label">{formatChartDateLabel(bucket.startDate)}</p>
      {items.map((item, index) => {
        const key = String(item.dataKey ?? item.name ?? '')
        const providerCounts = mode === 'byProvider' ? providerMetricCount(bucket, key, metric) : null
        const count = providerCounts?.count ?? metricCount(bucket, metric)
        const total = providerCounts?.total ?? bucket.total
        const value = typeof item.value === 'number'
          ? item.value
          : providerCounts
            ? round1(providerCounts.rate * 100)
            : round1(bucket[metricField(metric)] * 100)
        const color = item.color ?? seriesColor(key, index)
        return (
          <div key={`${key}-${index}`} className="trend-tooltip-block">
            <div className="trend-tooltip-row">
              <span className="trend-tooltip-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
              <span className="trend-tooltip-name">{seriesLabel(key)}</span>
              <span className="trend-tooltip-value">{formatPercent(value)}</span>
            </div>
            <p className="trend-tooltip-detail">
              {count} / {total} snapshots, {metric === 'cited' ? 'source links' : 'answer text'}
            </p>
          </div>
        )
      })}
      <p className="trend-tooltip-detail">{formatBucketModelEvidence(bucket)}</p>
    </div>
  )
}

function TrendDataSummary({
  buckets,
  metric,
  mode,
  series,
}: {
  buckets: readonly MetricsBucket[]
  metric: MetricChoice
  mode: TrendSeriesMode
  series: readonly string[]
}) {
  return (
    <table className="sr-only">
      <caption>{metricLabel(metric)} trend data</caption>
      <thead>
        <tr>
          <th scope="col">Bucket</th>
          <th scope="col">Values</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map(bucket => {
          let valueText: string
          if (metric === 'mentionShare') {
            const projectMentions = bucket.mentionShare.projectMentionSnapshots
            const competitorMentions = bucket.mentionShare.competitorMentionSnapshots
            const denominator = projectMentions + competitorMentions
            valueText = denominator > 0
              ? `${formatRatePercent(bucket.mentionShare.rate)} mention share, ${projectMentions} of ${denominator} brand mentions were you`
              : 'mention share undefined, no project or competitor brand mentions'
          } else if (mode === 'byProvider') {
            valueText = series.map(provider => {
              const counts = providerMetricCount(bucket, provider, metric)
              if (!counts) return `${providerDisplayName(provider)} no data`
              return `${providerDisplayName(provider)} ${formatRatePercent(counts.rate)} ${metricLabel(metric).toLowerCase()}, ${counts.count} of ${counts.total} snapshots`
            }).join('; ')
          } else {
            valueText = `${formatRatePercent(bucket[metricField(metric)])} ${metricLabel(metric).toLowerCase()}, ${metricCount(bucket, metric)} of ${bucket.total} snapshots`
          }
          valueText += `; ${formatBucketModelEvidence(bucket)}`
          return (
            <tr key={bucket.startDate}>
              <th scope="row">{formatChartDateLabel(bucket.startDate)}</th>
              <td>{valueText}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * Single-select segmented control. A group of toggle buttons (`role="group"` +
 * `aria-pressed`), not a tab pattern: these switch the chart's series in place,
 * they don't reveal panels, so tab semantics would mislead assistive tech.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: Array<{ value: T; label: string; description?: string }>
  value: T
  onChange: (next: T) => void
  ariaLabel: string
  className?: string
}) {
  const descriptionBaseId = useId()

  return (
    <div role="group" aria-label={ariaLabel} className={`segmented ${className ?? ''}`}>
      {options.map(opt => {
        const selected = value === opt.value
        const descriptionId = opt.description ? `${descriptionBaseId}-${opt.value}-description` : undefined
        return (
          <Fragment key={opt.value}>
            <button
              type="button"
              aria-pressed={selected}
              aria-describedby={descriptionId}
              className={`segmented-option ${selected ? 'segmented-option-active' : ''}`}
              onClick={() => onChange(opt.value)}
            >
              {opt.label}
            </button>
            {opt.description && (
              <span id={descriptionId} className="sr-only">
                {opt.description}
              </span>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

export function VisibilityTrendSection({
  projectName,
  competitorDomains = [],
  analyticsRevision = 'none',
}: {
  projectName: string
  competitorDomains?: readonly string[]
  /** Latest completed answer-visibility logical-sweep revision from dashboard polling. */
  analyticsRevision?: string
}) {
  const [window, setWindow] = useState<MetricsWindow>('all')
  const [metric, setMetric] = useState<MetricChoice>('mentioned')
  // Default to the per-engine breakdown: the blended line hides that engines
  // disagree wildly (a brand cited heavily by one engine and ignored by
  // another), which is the first thing an operator needs to see.
  const [mode, setMode] = useState<TrendSeriesMode>('byProvider')
  const metricsFrameKey = useMemo(() => competitorFrameKey(competitorDomains), [competitorDomains])

  const metricsQuery = useQuery({
    queryKey: ['analytics-metrics', projectName, window, metricsFrameKey, analyticsRevision],
    queryFn: () => fetchAnalyticsMetrics(projectName, window),
    staleTime: STATIC_VISIBILITY_STALE_MS,
  })
  const data = metricsQuery.data ?? null
  const error = metricsQuery.error

  const effectiveMode: TrendSeriesMode = metric === 'mentionShare' ? 'overall' : mode
  const trend = useMemo(
    () => (data ? buildSelectedTrendRows(data, metric, effectiveMode) : null),
    [data, metric, effectiveMode],
  )
  const modelAttribution = data ? readModelAttribution(data) : null
  const modelEvents = useMemo(
    () => groupModelAttributionEvents(modelAttribution ?? {}),
    [modelAttribution],
  )

  // Headline readout: the selected metric's latest bucket value plus its change
  // across the visible window. Quantifies "where it sits now, which way it
  // moved" without reusing the removed trend badges.
  const byProviderMode = metric !== 'mentionShare' && effectiveMode === 'byProvider'
  const currentMetricLabel = metricLabel(metric)
  const metricColor = metric === 'cited'
    ? CHART_TONE.positive
    : metric === 'mentionShare'
      ? MENTION_SHARE_COLOR
      : CHART_SERIES_COLORS[1]!
  // In by-engine mode the headline is the blended rate across every engine,
  // which no single line on the chart matches — neutralize the swatch (so it
  // doesn't read as one engine's color) and tag it "avg".
  const headlineDotColor = byProviderMode ? CHART_NEUTRAL.textDim : metricColor
  const buckets = data?.buckets ?? []
  const latestPct = metric === 'mentionShare'
    ? (trend ? latestSeriesValue(trend.rows, MENTION_SHARE_KEY) : null)
    : buckets.length > 0
      ? round1(buckets[buckets.length - 1]![metricField(metric)] * 100)
      : null
  const firstPct = metric === 'mentionShare'
    ? (trend ? firstSeriesValue(trend.rows, MENTION_SHARE_KEY) : null)
    : buckets.length > 0
      ? round1(buckets[0]![metricField(metric)] * 100)
      : null
  const plottedPointCount = metric === 'mentionShare'
    ? trend?.rows.filter(row => typeof row[MENTION_SHARE_KEY] === 'number').length ?? 0
    : buckets.length
  const deltaPts = latestPct !== null && firstPct !== null && plottedPointCount > 1 ? round1(latestPct - firstPct) : null
  const competitorCount = competitorDomains.length

  const header = (
    <>
      <div className="visibility-trend-head">
        <div className="space-y-1">
          <p className="eyebrow eyebrow-soft">Trend</p>
          <h2 className="visibility-trend-title">
            Answer-engine trend
            <InfoTooltip text="Three separate signals over sweep buckets: answer text mentions, source citations, and your answer-text mention share against tracked competitors. Mentioned and Cited use query-provider snapshot rates; Mention share uses project plus competitor brand mentions." />
          </h2>
        </div>
        {latestPct !== null && (
          <div className="visibility-trend-current">
            <span className="visibility-trend-current-dot" style={{ backgroundColor: headlineDotColor }} aria-hidden="true" />
            <span className="visibility-trend-current-label">{currentMetricLabel}</span>
            {byProviderMode && <span className="visibility-trend-current-qualifier">avg</span>}
            <span className="visibility-trend-current-value">{latestPct}%</span>
            {deltaPts !== null && (
              <span
                className={`visibility-trend-current-delta ${
                  deltaPts > 0 ? 'text-positive-400' : deltaPts < 0 ? 'text-negative-400' : 'text-muted'
                }`}
              >
                {deltaPts > 0 ? '+' : ''}{deltaPts.toFixed(1)} pts
              </span>
            )}
          </div>
        )}
      </div>
      <div className="visibility-trend-controls">
        <Segmented options={METRIC_OPTIONS} value={metric} onChange={setMetric} ariaLabel="Metric" className="visibility-trend-metric-control" />
        {metric !== 'mentionShare' && (
          <Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} ariaLabel="Series" />
        )}
        <Segmented options={WINDOW_OPTIONS} value={window} onChange={setWindow} ariaLabel="Time window" className="sm:ml-auto" />
      </div>
    </>
  )

  let body: React.ReactNode
  if (error) {
    body = <p className="text-sm text-negative-400">{error instanceof Error ? error.message : String(error)}</p>
  } else if (metricsQuery.isLoading && !data) {
    body = <div className="visibility-trend-chart animate-pulse rounded-lg bg-bg-elevated/40" aria-hidden="true" />
  } else if (metric === 'mentionShare' && competitorCount === 0) {
    body = <p className="text-sm text-secondary">Add tracked competitors to measure mention share over time.</p>
  } else if (!data || !trend) {
    body = null
  } else {
    const { rows, series, hasData, singleBucket } = trend
    const caption = formatQueryChangeCaption(data.queryChanges)
    if (!hasData) {
      body = (
        <p className="text-sm text-secondary">
          {metric === 'mentionShare'
            ? 'No answer-text brand mentions for you or tracked competitors in this window yet.'
            : 'Run a sweep to start tracking citations and mentions over time.'}
        </p>
      )
    } else if (byProviderMode && series.length === 0) {
      body = (
        <p className="text-sm text-secondary">
          No per-engine breakdown for this data yet. Switch to <span className="text-strong">All engines</span> to see the trend.
        </p>
      )
    } else {
      const srSummary = `${currentMetricLabel} rate across ${rows.length} ${rows.length === 1 ? 'sweep' : 'sweeps'}. Latest ${latestPct}%${
        deltaPts !== null ? `, ${deltaPts >= 0 ? 'up' : 'down'} ${Math.abs(deltaPts).toFixed(1)} points over the period` : ''
      }.`
      body = (
        <>
          <p className="sr-only">{srSummary}</p>
          <TrendDataSummary buckets={buckets} metric={metric} mode={effectiveMode} series={series} />
          {/* Per-engine key with each line's most recent value, so the engines
              and where they sit now are readable at a glance — replaces the
              cramped bottom legend and gives the by-engine view its payoff. */}
          {byProviderMode && series.length > 0 && (
            <ul className="trend-legend" aria-label="Engines">
              {series.map((key, i) => {
                const value = latestSeriesValue(rows, key)
                const evidence = latestPlottedProviderModelEvidence(buckets, key)
                const evidenceLabel = modelAttribution === null
                  ? 'Attribution unavailable'
                  : evidence
                    ? formatModelEvidence(evidence)
                    : 'No observed model evidence'
                return (
                  <li key={key} className="trend-legend-item">
                    <span
                      className="trend-legend-swatch"
                      style={{ backgroundColor: seriesColor(key, i) }}
                      aria-hidden="true"
                    />
                    <span className="trend-legend-label">
                      <span className="trend-legend-name">{seriesLabel(key)}</span>
                      <span className="trend-legend-model"><span aria-hidden="true">· </span>{evidenceLabel}</span>
                    </span>
                    {value !== null && <span className="trend-legend-value">{value}%</span>}
                  </li>
                )
              })}
            </ul>
          )}
          <div
            className="visibility-trend-chart"
            role="img"
            aria-label={`${currentMetricLabel} trend chart over ${rows.length} ${rows.length === 1 ? 'bucket' : 'buckets'}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={CHART_AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: CHART_AXIS_STROKE }}
                  tickFormatter={formatChartDateTick}
                  minTickGap={24}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tickFormatter={(v: number) => `${v}%`}
                  tick={CHART_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <RechartsTooltip
                  cursor={{ stroke: CHART_AXIS_STROKE, strokeWidth: 1 }}
                  content={<TrendTooltip metric={metric} mode={effectiveMode} buckets={buckets} />}
                />
                {modelEvents.map(({ bucketStartDate, events }) => (
                  <ReferenceLine
                    key={`model-evidence-${bucketStartDate}`}
                    x={bucketStartDate}
                    stroke={modelEventMarkerColor(events)}
                    strokeDasharray="4 4"
                    strokeWidth={1.5}
                    ifOverflow="extendDomain"
                  />
                ))}
                {series.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key}
                    stroke={seriesColor(key, i)}
                    strokeDasharray={key === MENTION_SHARE_KEY ? '5 4' : undefined}
                    strokeWidth={isOverallSeries(key) ? 2.5 : 2}
                    // A solid marker on every run/bucket point so the readings are visible.
                    dot={key === MENTION_SHARE_KEY
                      ? { r: 2.75, fill: 'var(--chart-tooltip-bg)', stroke: seriesColor(key, i), strokeWidth: 1.5 }
                      : { r: 2.5, fill: seriesColor(key, i), strokeWidth: 0 }}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: ACTIVE_DOT_RING }}
                    connectNulls={key !== MENTION_SHARE_KEY}
                    isAnimationActive={false}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <ModelEvidenceSummary events={modelEvents} available={modelAttribution !== null} />
          {singleBucket && (
            <p className="visibility-trend-note">
              {metric === 'mentionShare'
                ? 'Only one competitive mention-share point so far. The trend line fills in after another sweep with brand mentions.'
                : 'Only one sweep so far. The trend line fills in after the next run.'}
            </p>
          )}
          {caption && <p className="visibility-trend-note">{caption}</p>}
        </>
      )
    }
  }

  return (
    <section className="visibility-trend">
      {header}
      {body}
    </section>
  )
}
