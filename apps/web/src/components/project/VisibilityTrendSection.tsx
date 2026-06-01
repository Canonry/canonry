import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { MetricsWindow } from '@ainyc/canonry-contracts'
import {
  CartesianGrid,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_SERIES_COLORS,
  CHART_TONE,
  CHART_TOOLTIP_STYLE,
  ComposedChart,
  formatChartDateLabel,
  formatChartDateTick,
  Legend,
  Line,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from '../shared/ChartPrimitives.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { fetchAnalyticsMetrics } from '../../api.js'
import { STATIC_VISIBILITY_STALE_MS } from '../../queries/query-client.js'
import {
  buildTrendRows,
  CITED_KEY,
  formatQueryChangeCaption,
  MENTIONED_KEY,
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
  { value: 'overall', label: 'Overall' },
  { value: 'byProvider', label: 'By provider' },
]
const METRIC_OPTIONS: Array<{ value: MetricChoice; label: string }> = [
  { value: 'mentioned', label: 'Mentioned' },
  { value: 'cited', label: 'Cited' },
]

/** Dark ring drawn around the active (hovered) dot so it reads against the line. */
const ACTIVE_DOT_RING = '#18181b'

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function isOverallSeries(key: string): boolean {
  return key === CITED_KEY || key === MENTIONED_KEY
}

function seriesLabel(key: string): string {
  if (key === CITED_KEY) return 'Cited'
  if (key === MENTIONED_KEY) return 'Mentioned'
  return key
}

function seriesColor(key: string, index: number): string {
  if (key === CITED_KEY) return CHART_TONE.positive // emerald
  if (key === MENTIONED_KEY) return CHART_SERIES_COLORS[1] // blue
  return CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]
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

export function VisibilityTrendSection({ projectName }: { projectName: string }) {
  const [window, setWindow] = useState<MetricsWindow>('all')
  const [metric, setMetric] = useState<MetricChoice>('mentioned')
  const [mode, setMode] = useState<TrendSeriesMode>('overall')

  const metricsQuery = useQuery({
    queryKey: ['analytics-metrics', projectName, window],
    queryFn: () => fetchAnalyticsMetrics(projectName, window),
    staleTime: STATIC_VISIBILITY_STALE_MS,
  })
  const data = metricsQuery.data ?? null
  const error = metricsQuery.error

  const trend = useMemo(() => (data ? buildTrendRows(data, metric, mode) : null), [data, metric, mode])

  // Headline readout: the selected metric's latest bucket value plus its change
  // across the visible window. Quantifies "where it sits now, which way it
  // moved" without reusing the removed trend badges.
  const metricField = metric === 'cited' ? 'citationRate' : 'mentionRate'
  const metricLabel = metric === 'cited' ? 'Cited' : 'Mentioned'
  const metricColor = metric === 'cited' ? CHART_TONE.positive : CHART_SERIES_COLORS[1]
  const buckets = data?.buckets ?? []
  const latestPct = buckets.length > 0 ? round1(buckets[buckets.length - 1]![metricField] * 100) : null
  const firstPct = buckets.length > 0 ? round1(buckets[0]![metricField] * 100) : null
  const deltaPts = latestPct !== null && firstPct !== null && buckets.length > 1 ? round1(latestPct - firstPct) : null

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
            <span className="visibility-trend-current-dot" style={{ backgroundColor: metricColor }} aria-hidden="true" />
            <span className="visibility-trend-current-label">{metricLabel}</span>
            <span className="visibility-trend-current-value">{latestPct}%</span>
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
          No per-provider breakdown for this data yet. Switch to <span className="text-zinc-200">Overall</span> to see the trend.
        </p>
      )
    } else {
      const srSummary = `${metricLabel} rate across ${rows.length} ${rows.length === 1 ? 'sweep' : 'sweeps'}. Latest ${latestPct}%${
        deltaPts !== null ? `, ${deltaPts >= 0 ? 'up' : 'down'} ${Math.abs(deltaPts).toFixed(1)} points over the period` : ''
      }.`
      body = (
        <>
          <p className="sr-only">{srSummary}</p>
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
                {mode === 'byProvider' && (
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: CHART_AXIS_TICK.fill }}
                    formatter={(value: string) => seriesLabel(value)}
                  />
                )}
                {series.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key}
                    stroke={seriesColor(key, i)}
                    strokeWidth={isOverallSeries(key) ? 2.5 : 1.5}
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
