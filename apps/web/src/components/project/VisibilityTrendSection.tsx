import { useState } from 'react'
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

const WINDOWS: MetricsWindow[] = ['7d', '30d', '90d', 'all']
const MODE_OPTIONS: Array<{ value: TrendSeriesMode; label: string }> = [
  { value: 'overall', label: 'Overall' },
  { value: 'byProvider', label: 'By provider' },
]
const METRIC_OPTIONS: Array<{ value: MetricChoice; label: string }> = [
  { value: 'mentioned', label: 'Mentioned' },
  { value: 'cited', label: 'Cited' },
]

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

function Pills<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (next: T) => void
  ariaLabel: string
}) {
  return (
    <div className="flex gap-1" role="tablist" aria-label={ariaLabel}>
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
            value === opt.value
              ? 'bg-zinc-700 border-zinc-600 text-zinc-50'
              : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300'
          }`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
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
      </div>
      <div className="visibility-trend-controls">
        <Pills options={METRIC_OPTIONS} value={metric} onChange={setMetric} ariaLabel="Metric" />
        <Pills options={MODE_OPTIONS} value={mode} onChange={setMode} ariaLabel="Series" />
        <div className="ml-auto">
          <Pills
            options={WINDOWS.map(w => ({ value: w, label: w === 'all' ? 'All' : w }))}
            value={window}
            onChange={setWindow}
            ariaLabel="Time window"
          />
        </div>
      </div>
    </>
  )

  let body: React.ReactNode
  if (error) {
    body = <p className="text-sm text-rose-400">{error instanceof Error ? error.message : String(error)}</p>
  } else if (metricsQuery.isLoading && !data) {
    body = <div className="visibility-trend-chart animate-pulse rounded-lg bg-zinc-900/40" aria-hidden="true" />
  } else if (!data) {
    body = null
  } else {
    const { rows, series, hasData, singleBucket } = buildTrendRows(data, metric, mode)
    const caption = formatQueryChangeCaption(data.queryChanges)
    if (!hasData) {
      body = (
        <p className="text-sm text-zinc-500">Run a sweep to start tracking citations and mentions over time.</p>
      )
    } else if (mode === 'byProvider' && series.length === 0) {
      body = (
        <p className="text-sm text-zinc-500">
          No per-provider breakdown for this data yet — switch to <span className="text-zinc-300">Overall</span> to see the trend.
        </p>
      )
    } else {
      body = (
        <>
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
                  labelFormatter={formatChartDateLabel}
                  formatter={(value, name) => [`${value ?? '—'}%`, seriesLabel(String(name))]}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: CHART_AXIS_TICK.fill }}
                  formatter={(value: string) => seriesLabel(value)}
                />
                {series.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key}
                    stroke={seriesColor(key, i)}
                    strokeWidth={isOverallSeries(key) ? 2.5 : 1.5}
                    // A marker on every run/bucket point so the actual readings are visible.
                    dot={{ r: 2.5 }}
                    activeDot={{ r: 4 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {singleBucket && (
            <p className="visibility-trend-note">
              Only one sweep so far — the trend line fills in after the next run.
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
