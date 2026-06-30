import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MentionShareNoLocationBucket, type MetricsWindow } from '@ainyc/canonry-contracts'
import {
  CartesianGrid,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_NEUTRAL,
  CHART_SERIES_COLORS,
  CHART_TONE,
  CHART_TOOLTIP_STYLE,
  ComposedChart,
  formatChartDateLabel,
  formatChartDateTick,
  Line,
  providerSeriesColor,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from '../shared/ChartPrimitives.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { fetchAnalyticsMetrics } from '../../api.js'
import { STATIC_VISIBILITY_STALE_MS } from '../../queries/query-client.js'
import {
  buildMentionShareTrendRows,
  buildTrendRows,
  CITED_KEY,
  formatQueryChangeCaption,
  latestSeriesValue,
  MENTION_SHARE_KEY,
  MENTION_SHARE_META_KEY,
  MENTIONED_KEY,
  type MentionShareSeriesMode,
  type MentionShareTrendMeta,
  type MetricChoice,
  type TrendRow,
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
const MENTION_SHARE_MODE_OPTIONS: Array<{ value: MentionShareSeriesMode; label: string }> = [
  { value: 'byProvider', label: 'By engine' },
  { value: 'byLocation', label: 'By location' },
  { value: 'overall', label: 'Overall' },
]
const METRIC_OPTIONS: Array<{ value: MetricChoice; label: string }> = [
  { value: 'mentioned', label: 'Mentioned' },
  { value: 'cited', label: 'Cited' },
]

/** Dark ring drawn around the active (hovered) dot so it reads against the line. */
const ACTIVE_DOT_RING = '#18181b'

/** Human-friendly engine names for the legend and tooltip (data keys are lowercase). */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  local: 'Local',
}

function providerDisplayName(name: string): string {
  return PROVIDER_DISPLAY_NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function isOverallSeries(key: string): boolean {
  return key === CITED_KEY || key === MENTIONED_KEY
}

function seriesLabel(key: string): string {
  if (key === CITED_KEY) return 'Cited'
  if (key === MENTIONED_KEY) return 'Mentioned'
  return providerDisplayName(key)
}

function seriesColor(key: string, index: number): string {
  if (key === CITED_KEY) return CHART_TONE.positive // emerald
  if (key === MENTIONED_KEY) return CHART_SERIES_COLORS[1]! // blue
  if (key === MENTION_SHARE_KEY) return CHART_TONE.positive
  return providerSeriesColor(key, index)
}

function firstSeriesValue(rows: TrendRow[], key: string): number | null {
  for (const row of rows) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function isMentionShareTrendMeta(value: unknown): value is MentionShareTrendMeta {
  return typeof value === 'object' && value !== null && 'brandMentionEvents' in value
}

function latestMentionSharePoint(rows: TrendRow[], key = MENTION_SHARE_KEY): { value: number; meta: MentionShareTrendMeta | null } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      const meta = row[MENTION_SHARE_META_KEY]
      return { value, meta: isMentionShareTrendMeta(meta) ? meta : null }
    }
  }
  return null
}

function mentionShareSeriesLabel(key: string, mode: MentionShareSeriesMode): string {
  if (key === MENTION_SHARE_KEY) return 'Mention share'
  if (mode === 'byLocation') return key === MentionShareNoLocationBucket ? 'No location' : key
  return providerDisplayName(key)
}

function competitorFrameKey(competitorDomains: readonly string[]): string {
  return competitorDomains
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('\n')
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
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (next: T) => void
  ariaLabel: string
  className?: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={`segmented ${className ?? ''}`}>
      {options.map(opt => {
        const selected = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            className={`segmented-option ${selected ? 'segmented-option-active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export function VisibilityTrendSection({
  projectName,
  competitorDomains = [],
}: {
  projectName: string
  competitorDomains?: readonly string[]
}) {
  const [window, setWindow] = useState<MetricsWindow>('all')
  const [metric, setMetric] = useState<MetricChoice>('mentioned')
  // Default to the per-engine breakdown: the blended line hides that engines
  // disagree wildly (a brand cited heavily by one engine and ignored by
  // another), which is the first thing an operator needs to see.
  const [mode, setMode] = useState<TrendSeriesMode>('byProvider')
  const metricsFrameKey = useMemo(() => competitorFrameKey(competitorDomains), [competitorDomains])

  const metricsQuery = useQuery({
    queryKey: ['analytics-metrics', projectName, window, metricsFrameKey],
    queryFn: () => fetchAnalyticsMetrics(projectName, window),
    staleTime: STATIC_VISIBILITY_STALE_MS,
  })
  const data = metricsQuery.data ?? null
  const error = metricsQuery.error

  const trend = useMemo(() => (data ? buildTrendRows(data, metric, mode) : null), [data, metric, mode])

  // Headline readout: the selected metric's latest bucket value plus its change
  // across the visible window. Quantifies "where it sits now, which way it
  // moved" without reusing the removed trend badges.
  const byProviderMode = mode === 'byProvider'
  const metricField = metric === 'cited' ? 'citationRate' : 'mentionRate'
  const metricLabel = metric === 'cited' ? 'Cited' : 'Mentioned'
  const metricColor = metric === 'cited' ? CHART_TONE.positive : CHART_SERIES_COLORS[1]!
  // In by-engine mode the headline is the blended rate across every engine,
  // which no single line on the chart matches — neutralize the swatch (so it
  // doesn't read as one engine's color) and tag it "avg".
  const headlineDotColor = byProviderMode ? CHART_NEUTRAL.textDim : metricColor
  const buckets = data?.buckets ?? []
  const latestBucket = buckets.length > 0 ? buckets[buckets.length - 1]! : null
  const latestPct = latestBucket ? round1(latestBucket[metricField] * 100) : null
  const firstPct = buckets.length > 0 ? round1(buckets[0]![metricField] * 100) : null
  const deltaPts = latestPct !== null && firstPct !== null && buckets.length > 1 ? round1(latestPct - firstPct) : null
  const latestObservationLabel = latestBucket
    ? `${metric === 'cited' ? latestBucket.cited : latestBucket.mentionedCount} / ${latestBucket.total} observations`
    : null

  const header = (
    <>
      <div className="visibility-trend-head">
        <div className="space-y-1">
          <p className="eyebrow eyebrow-soft">Trend</p>
          <h2 className="visibility-trend-title">
            Citations &amp; mentions over time
            <InfoTooltip text="How often AI engines cited your domain as a source (Cited) and named your brand in the answer text (Mentioned), across all tracked queries, over time. Each point is a sweep bucket; rates are the share of (query × provider) snapshots in that bucket." />
          </h2>
        </div>
        {latestPct !== null && (
          <div className="visibility-trend-current">
            <span className="visibility-trend-current-dot" style={{ backgroundColor: headlineDotColor }} aria-hidden="true" />
            <span className="visibility-trend-current-label">{metricLabel}</span>
            {byProviderMode && <span className="visibility-trend-current-qualifier">avg</span>}
            <span className="visibility-trend-current-value">{latestPct}%</span>
            {latestObservationLabel && <span className="visibility-trend-current-sample">{latestObservationLabel}</span>}
            {deltaPts !== null && (
              <span
                className={`visibility-trend-current-delta ${
                  deltaPts > 0 ? 'text-emerald-400' : deltaPts < 0 ? 'text-rose-400' : 'text-zinc-500'
                }`}
              >
                {deltaPts > 0 ? '+' : ''}{deltaPts.toFixed(1)} pts
              </span>
            )}
          </div>
        )}
      </div>
      <div className="visibility-trend-controls">
        <Segmented options={METRIC_OPTIONS} value={metric} onChange={setMetric} ariaLabel="Metric" />
        <Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} ariaLabel="Series" />
        <Segmented options={WINDOW_OPTIONS} value={window} onChange={setWindow} ariaLabel="Time window" className="sm:ml-auto" />
      </div>
    </>
  )

  let body: React.ReactNode
  if (error) {
    body = <p className="text-sm text-rose-400">{error instanceof Error ? error.message : String(error)}</p>
  } else if (metricsQuery.isLoading && !data) {
    body = <div className="visibility-trend-chart animate-pulse rounded-lg bg-zinc-900/40" aria-hidden="true" />
  } else if (!data || !trend) {
    body = null
  } else {
    const { rows, series, hasData, singleBucket } = trend
    const caption = formatQueryChangeCaption(data.queryChanges)
    if (!hasData) {
      body = (
        <p className="text-sm text-zinc-400">Run a sweep to start tracking citations and mentions over time.</p>
      )
    } else if (mode === 'byProvider' && series.length === 0) {
      body = (
        <p className="text-sm text-zinc-400">
          No per-engine breakdown for this data yet. Switch to <span className="text-zinc-200">All engines</span> to see the trend.
        </p>
      )
    } else {
      const srSummary = `${metricLabel} rate across ${rows.length} ${rows.length === 1 ? 'sweep' : 'sweeps'}. Latest ${latestPct}%${
        deltaPts !== null ? `, ${deltaPts >= 0 ? 'up' : 'down'} ${Math.abs(deltaPts).toFixed(1)} points over the period` : ''
      }.`
      body = (
        <>
          <p className="sr-only">{srSummary}</p>
          {/* Per-engine key with each line's most recent value, so the engines
              and where they sit now are readable at a glance — replaces the
              cramped bottom legend and gives the by-engine view its payoff. */}
          {mode === 'byProvider' && series.length > 0 && (
            <ul className="trend-legend" aria-label="Engines">
              {series.map((key, i) => {
                const value = latestSeriesValue(rows, key)
                return (
                  <li key={key} className="trend-legend-item">
                    <span
                      className="trend-legend-swatch"
                      style={{ backgroundColor: seriesColor(key, i) }}
                      aria-hidden="true"
                    />
                    <span className="trend-legend-name">{seriesLabel(key)}</span>
                    {value !== null && <span className="trend-legend-value">{value}%</span>}
                  </li>
                )
              })}
            </ul>
          )}
          <div className="visibility-trend-chart">
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
                  {...CHART_TOOLTIP_STYLE}
                  cursor={{ stroke: CHART_AXIS_STROKE, strokeWidth: 1 }}
                  labelFormatter={formatChartDateLabel}
                  formatter={(value, name) => [value == null ? 'no data' : `${value}%`, seriesLabel(String(name))]}
                />
                {series.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key}
                    stroke={seriesColor(key, i)}
                    strokeWidth={isOverallSeries(key) ? 2.5 : 2}
                    // A solid marker on every run/bucket point so the readings are visible.
                    dot={{ r: 2.5, fill: seriesColor(key, i), strokeWidth: 0 }}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: ACTIVE_DOT_RING }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {singleBucket && (
            <p className="visibility-trend-note">Only one sweep so far. The trend line fills in after the next run.</p>
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

export function MentionShareTrendSection({
  projectName,
  competitorDomains,
}: {
  projectName: string
  competitorDomains: readonly string[]
}) {
  const [window, setWindow] = useState<MetricsWindow>('all')
  const [mode, setMode] = useState<MentionShareSeriesMode>('byProvider')
  const metricsFrameKey = useMemo(() => competitorFrameKey(competitorDomains), [competitorDomains])
  const competitorCount = competitorDomains.length

  const metricsQuery = useQuery({
    queryKey: ['analytics-metrics', projectName, window, metricsFrameKey],
    queryFn: () => fetchAnalyticsMetrics(projectName, window),
    staleTime: STATIC_VISIBILITY_STALE_MS,
  })
  const data = metricsQuery.data ?? null
  const error = metricsQuery.error
  const trend = useMemo(() => (data ? buildMentionShareTrendRows(data, mode) : null), [data, mode])
  const overallTrend = useMemo(() => (data ? buildMentionShareTrendRows(data, 'overall') : null), [data])
  const latestPoint = overallTrend ? latestMentionSharePoint(overallTrend.rows) : null
  const latestPct = latestPoint?.value ?? null
  const firstPct = overallTrend ? firstSeriesValue(overallTrend.rows, MENTION_SHARE_KEY) : null
  const latestMeta = latestPoint?.meta ?? null
  const deltaPts = latestPct !== null && firstPct !== null && latestPct !== firstPct
    ? round1(latestPct - firstPct)
    : latestPct !== null && firstPct !== null
      ? 0
      : null

  const header = (
    <>
      <div className="visibility-trend-head">
        <div className="space-y-1">
          <p className="eyebrow eyebrow-soft">Competitive trend</p>
          <h2 className="visibility-trend-title">
            Mention share over time
            <InfoTooltip text="Of all answer-text brand mentions in each sweep bucket (you plus tracked competitors), the share that were you. Buckets with no brand mentions are not plotted." />
          </h2>
        </div>
        {latestPct !== null && (
          <div className="visibility-trend-current">
            <span className="visibility-trend-current-dot" style={{ backgroundColor: CHART_TONE.positive }} aria-hidden="true" />
            <span className="visibility-trend-current-label">Mention share</span>
            {mode !== 'overall' && <span className="visibility-trend-current-qualifier">overall</span>}
            <span className="visibility-trend-current-value">{latestPct}%</span>
            {latestMeta && (
              <span className="visibility-trend-current-sample">
                {latestMeta.projectMentionEvents} / {latestMeta.brandMentionEvents} brand mention events
              </span>
            )}
            {latestMeta && <span className="visibility-trend-current-sample">{latestMeta.answerObservations} answer observations</span>}
            {deltaPts !== null && (
              <span
                className={`visibility-trend-current-delta ${
                  deltaPts > 0 ? 'text-emerald-400' : deltaPts < 0 ? 'text-rose-400' : 'text-zinc-500'
                }`}
              >
                {deltaPts > 0 ? '+' : ''}{deltaPts.toFixed(1)} pts
              </span>
            )}
          </div>
        )}
      </div>
      <div className="visibility-trend-controls">
        <Segmented options={MENTION_SHARE_MODE_OPTIONS} value={mode} onChange={setMode} ariaLabel="Distribution" />
        <Segmented options={WINDOW_OPTIONS} value={window} onChange={setWindow} ariaLabel="Time window" className="sm:ml-auto" />
      </div>
    </>
  )

  let body: React.ReactNode
  if (error) {
    body = <p className="text-sm text-rose-400">{error instanceof Error ? error.message : String(error)}</p>
  } else if (metricsQuery.isLoading && !data) {
    body = <div className="visibility-trend-chart animate-pulse rounded-lg bg-zinc-900/40" aria-hidden="true" />
  } else if (competitorCount === 0) {
    body = <p className="text-sm text-zinc-400">Add tracked competitors to measure mention share over time.</p>
  } else if (!data || !trend) {
    body = null
  } else if (!trend.hasData) {
    body = <p className="text-sm text-zinc-400">No answer-text brand mentions for you or tracked competitors in this window yet.</p>
  } else if (mode !== 'overall' && trend.series.length === 0) {
    body = (
      <p className="text-sm text-zinc-400">
        No {mode === 'byProvider' ? 'engine' : 'location'} distribution is available for this data yet. Switch to <span className="text-zinc-200">Overall</span> to see the trend.
      </p>
    )
  } else {
    const caption = formatQueryChangeCaption(data.queryChanges)
    const { rows, series, singleBucket } = trend
    const srSummary = `Mention share across ${rows.length} ${rows.length === 1 ? 'sweep bucket' : 'sweep buckets'}. Latest ${latestPct}%${
      deltaPts !== null ? `, ${deltaPts >= 0 ? 'up' : 'down'} ${Math.abs(deltaPts).toFixed(1)} points over the period` : ''
    }.`
    body = (
      <>
        <p className="sr-only">{srSummary}</p>
        {mode !== 'overall' && series.length > 0 && (
          <ul className="trend-legend" aria-label={mode === 'byProvider' ? 'Engines' : 'Locations'}>
            {series.map((key, i) => {
              const value = latestSeriesValue(rows, key)
              return (
                <li key={key} className="trend-legend-item">
                  <span
                    className="trend-legend-swatch"
                    style={{ backgroundColor: seriesColor(key, i) }}
                    aria-hidden="true"
                  />
                  <span className="trend-legend-name">{mentionShareSeriesLabel(key, mode)}</span>
                  {value !== null && <span className="trend-legend-value">{value}%</span>}
                </li>
              )
            })}
          </ul>
        )}
        <div className="visibility-trend-chart">
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
                {...CHART_TOOLTIP_STYLE}
                cursor={{ stroke: CHART_AXIS_STROKE, strokeWidth: 1 }}
                labelFormatter={formatChartDateLabel}
                formatter={(value, name) => [value == null ? 'no data' : `${value}%`, mentionShareSeriesLabel(String(name), mode)]}
              />
              {series.map((key, i) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={key}
                  stroke={seriesColor(key, i)}
                  strokeWidth={key === MENTION_SHARE_KEY ? 2.5 : 2}
                  dot={{ r: 2.5, fill: seriesColor(key, i), strokeWidth: 0 }}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: ACTIVE_DOT_RING }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {singleBucket && (
          <p className="visibility-trend-note">Only one competitive mention-share point so far. The trend line fills in after another sweep with brand mentions.</p>
        )}
        {caption && <p className="visibility-trend-note">{caption}</p>}
      </>
    )
  }

  return (
    <section className="visibility-trend mention-share-trend">
      {header}
      {body}
    </section>
  )
}
