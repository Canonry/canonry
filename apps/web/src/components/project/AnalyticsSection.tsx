import { useEffect, useMemo, useState } from 'react'
import type { BrandMetricsDto, GapAnalysisDto, SourceBreakdownDto, MetricsWindow, GapCategory, SourceCategory } from '@ainyc/canonry-contracts'

import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ScoreGauge } from '../shared/ScoreGauge.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { fetchAnalyticsMetrics, fetchAnalyticsGaps, fetchAnalyticsSources } from '../../api.js'
import type { MetricTone } from '../../view-models.js'

const ANALYTICS_WINDOWS: MetricsWindow[] = ['7d', '30d', '90d', 'all']
const GAP_FILTERS: GapCategory[] = ['gap', 'cited', 'uncited']

const SOURCE_CATEGORY_COLORS: Record<SourceCategory, string> = {
  forum: 'bg-amber-500',
  social: 'bg-blue-500',
  news: 'bg-zinc-400',
  reference: 'bg-purple-500',
  blog: 'bg-emerald-500',
  ecommerce: 'bg-orange-500',
  video: 'bg-red-500',
  academic: 'bg-cyan-500',
  other: 'bg-zinc-600',
}

export function AnalyticsSection({ projectName }: { projectName: string }) {
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>('30d')
  const [metrics, setMetrics] = useState<BrandMetricsDto | null>(null)
  const [gaps, setGaps] = useState<GapAnalysisDto | null>(null)
  const [sources, setSources] = useState<SourceBreakdownDto | null>(null)
  const [gapFilter, setGapFilter] = useState<GapCategory | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetchAnalyticsMetrics(projectName, metricsWindow),
      fetchAnalyticsGaps(projectName, metricsWindow),
      fetchAnalyticsSources(projectName, metricsWindow),
    ]).then(([m, g, s]) => {
      if (cancelled) return
      setMetrics(m)
      setGaps(g)
      setSources(s)
      setLoading(false)
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [projectName, metricsWindow])

  if (loading && !metrics) {
    return <p className="text-sm text-zinc-500 py-8 text-center">Loading analytics…</p>
  }

  return (
    <>
      {/* Section 1: Citation Rate Trends */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Citation Metrics</p>
            <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">Citation Rate Trends <InfoTooltip text="Citation rate over time across all runs within the selected window. Each data point represents the percentage of queries where your brand was cited by AI providers." /></h2>
          </div>
          <div className="flex gap-1">
            {ANALYTICS_WINDOWS.map(w => (
              <button
                key={w}
                type="button"
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  metricsWindow === w
                    ? 'bg-zinc-700 border-zinc-600 text-zinc-50'
                    : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300'
                }`}
                onClick={() => setMetricsWindow(w)}
              >
                {w === 'all' ? 'All' : w}
              </button>
            ))}
          </div>
        </div>

        {metrics && (
          <div className="space-y-4">
            {/* Overall + Trend */}
            <div className="flex items-center gap-6">
              <ScoreGauge
                value={`${Math.round(metrics.overall.citationRate * 100)}`}
                label="Citation Rate"
                delta={`${metrics.overall.cited} / ${metrics.overall.total}`}
                tone={metrics.trend === 'improving' ? 'positive' : metrics.trend === 'declining' ? 'negative' : 'neutral'}
                description={`Trend: ${metrics.trend}`}
                isNumeric={true}
              />
              <div className="flex-1 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">Trend</span>
                  <ToneBadge tone={metrics.trend === 'improving' ? 'positive' : metrics.trend === 'declining' ? 'negative' : 'neutral'}>
                    {metrics.trend}
                  </ToneBadge>
                </div>

                {/* Per-provider table */}
                {Object.keys(metrics.byProvider).length > 0 && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                        <th className="text-left py-1 font-medium">Provider</th>
                        <th className="text-right py-1 font-medium">Rate</th>
                        <th className="text-right py-1 font-medium">Cited / Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(metrics.byProvider).map(([provider, m]) => (
                        <tr key={provider} className="border-t border-zinc-800/40">
                          <td className="py-1.5 text-zinc-300">{provider}</td>
                          <td className="py-1.5 text-right text-zinc-200">{(m.citationRate * 100).toFixed(1)}%</td>
                          <td className="py-1.5 text-right text-zinc-400">{m.cited} / {m.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Trend chart */}
            {metrics.buckets.length >= 1 && (
              <AnalyticsTrendChart buckets={metrics.buckets} />
            )}
          </div>
        )}
      </section>

      <div className="page-section-divider" />

      {/* Section 2: Brand Gap Analysis */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Opportunity Analysis</p>
            <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">Brand Gap Analysis <InfoTooltip text="Classification based on the most recent completed run. Cited: your brand appeared in the AI answer. Gap: a competitor was cited but you were not. Not Cited: neither mentioned. Consistency shows how often each keyword was cited across all runs in the selected window." /></h2>
          </div>
        </div>

        {gaps && (
          <>
            <div className="flex gap-1 mb-4">
              {GAP_FILTERS.map(f => {
                const count = f === 'cited' ? gaps.cited.length : f === 'gap' ? gaps.gap.length : gaps.uncited.length
                const active = gapFilter === f
                return (
                  <button
                    key={f}
                    type="button"
                    className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                      active
                        ? f === 'gap' ? 'bg-amber-900/40 border-amber-700/60 text-amber-300'
                          : f === 'cited' ? 'bg-emerald-900/40 border-emerald-700/60 text-emerald-300'
                          : 'bg-zinc-800/40 border-zinc-700 text-zinc-300'
                        : 'border-zinc-800 text-zinc-400 hover:border-zinc-700'
                    }`}
                    onClick={() => setGapFilter(active ? null : f)}
                  >
                    {f === 'gap' ? 'Gap' : f === 'cited' ? 'Cited' : 'Not Cited'} ({count})
                  </button>
                )
              })}
            </div>

            <GapAnalysisTable gaps={gaps} filter={gapFilter} />
          </>
        )}
      </section>

      <div className="page-section-divider" />

      {/* Section 3: Source Origin Breakdown */}
      <section>
        <div className="mb-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Source Intelligence</p>
          <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">Source Origin Breakdown <InfoTooltip text="Aggregated across all runs in the selected window. Shows what types of websites AI engines cite as grounding sources. More runs = more statistically meaningful breakdown." /></h2>
        </div>

        {sources && sources.overall.length > 0 && (
          <div className="space-y-4">
            {/* Stacked bar */}
            <SourceBar categories={sources.overall} />

            {/* Table */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="text-left py-1 font-medium">Category</th>
                  <th className="text-right py-1 font-medium">Count</th>
                  <th className="text-right py-1 font-medium">%</th>
                  <th className="text-left py-1 pl-4 font-medium">Top Sources</th>
                </tr>
              </thead>
              <tbody>
                {sources.overall.map(cat => (
                  <tr key={cat.category} className="border-t border-zinc-800/40">
                    <td className="py-1.5 text-zinc-300 flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${SOURCE_CATEGORY_COLORS[cat.category] ?? 'bg-zinc-600'}`} />
                      {cat.label}
                    </td>
                    <td className="py-1.5 text-right text-zinc-200">{cat.count}</td>
                    <td className="py-1.5 text-right text-zinc-400">{(cat.percentage * 100).toFixed(1)}%</td>
                    <td className="py-1.5 pl-4 text-zinc-500 text-xs truncate max-w-[200px]">
                      {cat.topDomains.slice(0, 3).map(d => d.domain).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {sources && sources.overall.length === 0 && (
          <p className="text-sm text-zinc-500 py-4">No source data available. Run a visibility sweep first.</p>
        )}
      </section>
    </>
  )
}

function AnalyticsTrendChart({ buckets }: { buckets: BrandMetricsDto['buckets'] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const width = 600
  const height = 140
  const padding = { top: 24, right: 10, bottom: 20, left: 40 }
  const chartW = width - padding.left - padding.right
  const chartH = height - padding.top - padding.bottom

  const maxRate = 1

  const bucketCoords = buckets.map((b, i) => {
    const x = padding.left + (buckets.length > 1 ? (i / (buckets.length - 1)) * chartW : chartW / 2)
    const y = padding.top + chartH - (b.citationRate / maxRate) * chartH
    return { x, y }
  })

  const points = bucketCoords.map(c => `${c.x},${c.y}`).join(' ')

  return (
    <div className="surface-card rounded-lg p-3 border border-zinc-800/60">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        aria-label="Citation rate trend chart"
        onMouseLeave={() => setHovered(null)}
      >
        {/* Y-axis labels */}
        <text x={padding.left - 4} y={padding.top + 4} textAnchor="end" className="fill-zinc-500" fontSize="9">
          {(maxRate * 100).toFixed(0)}%
        </text>
        <text x={padding.left - 4} y={padding.top + chartH + 4} textAnchor="end" className="fill-zinc-500" fontSize="9">
          0%
        </text>
        {/* Grid line */}
        <line
          x1={padding.left} y1={padding.top + chartH}
          x2={padding.left + chartW} y2={padding.top + chartH}
          stroke="currentColor" className="text-zinc-800" strokeWidth="0.5"
        />
        {/* Line */}
        <polyline
          fill="none"
          stroke="currentColor"
          className="text-emerald-500"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
        {/* Hover vertical line */}
        {hovered !== null && (
          <line
            x1={bucketCoords[hovered]!.x} y1={padding.top}
            x2={bucketCoords[hovered]!.x} y2={padding.top + chartH}
            stroke="currentColor" className="text-zinc-600" strokeWidth="0.5" strokeDasharray="3 2"
          />
        )}
        {/* Dots + hover targets */}
        {buckets.map((b, i) => {
          const { x, y } = bucketCoords[i]!
          const isHovered = hovered === i
          return (
            <g key={i}>
              {/* Invisible wider hit area */}
              <circle
                cx={x} cy={y} r="10"
                fill="transparent"
                onMouseEnter={() => setHovered(i)}
                style={{ cursor: 'pointer' }}
              />
              <circle cx={x} cy={y} r={isHovered ? 5 : 3} className={isHovered ? 'fill-emerald-400' : 'fill-emerald-500'} />
            </g>
          )
        })}
        {/* Tooltip */}
        {hovered !== null && (() => {
          const b = buckets[hovered]!
          const { x, y } = bucketCoords[hovered]!
          const label = `${(b.citationRate * 100).toFixed(1)}%`
          const date = b.startDate.slice(5, 10)
          const tooltipW = 56
          const tooltipH = 30
          const tx = Math.max(padding.left, Math.min(x - tooltipW / 2, width - padding.right - tooltipW))
          const ty = y - tooltipH - 8
          return (
            <g>
              <rect x={tx} y={ty} width={tooltipW} height={tooltipH} rx="4" className="fill-zinc-800" stroke="currentColor" strokeWidth="0.5" />
              <text x={tx + tooltipW / 2} y={ty + 13} textAnchor="middle" className="fill-zinc-50" fontSize="11" fontWeight="600">
                {label}
              </text>
              <text x={tx + tooltipW / 2} y={ty + 24} textAnchor="middle" className="fill-zinc-400" fontSize="8">
                {date}
              </text>
            </g>
          )
        })()}
        {/* X-axis date labels */}
        {buckets
          .map((b, i) => ({ b, i }))
          .filter(({ i }) => i === 0 || i === buckets.length - 1 || buckets.length <= 7)
          .map(({ b, i }) => {
            const x = bucketCoords[i]!.x
            return (
              <text key={i} x={x} y={height - 2} textAnchor="middle" className="fill-zinc-500" fontSize="8">
                {b.startDate.slice(5, 10)}
              </text>
            )
          })}
      </svg>
    </div>
  )
}

function GapAnalysisTable({ gaps, filter }: { gaps: GapAnalysisDto; filter: GapCategory | null }) {
  const rows = useMemo(() => {
    const all = [
      ...gaps.gap.map(k => ({ ...k, _sort: 0 })),
      ...gaps.cited.map(k => ({ ...k, _sort: 1 })),
      ...gaps.uncited.map(k => ({ ...k, _sort: 2 })),
    ]
    if (filter) return all.filter(k => k.category === filter)
    return all.sort((a, b) => a._sort - b._sort)
  }, [gaps, filter])

  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500 py-4">No keywords found{filter ? ` with status "${filter}"` : ''}.</p>
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
          <th className="text-left py-1 font-medium">Keyword</th>
          <th className="text-left py-1 font-medium">Status</th>
          <th className="text-left py-1 font-medium">Providers Citing</th>
          <th className="text-left py-1 font-medium">Competitors Citing</th>
          <th className="text-right py-1 font-medium">Consistency</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(kw => {
          const tone: MetricTone = kw.category === 'cited' ? 'positive' : kw.category === 'gap' ? 'caution' : 'neutral'
          return (
            <tr
              key={kw.keywordId}
              className={`border-t border-zinc-800/40 ${kw.category === 'gap' ? 'border-l-2 border-l-amber-600/60' : ''}`}
            >
              <td className="py-1.5 text-zinc-200">{kw.keyword}</td>
              <td className="py-1.5">
                <ToneBadge tone={tone}>
                  {kw.category === 'gap' ? 'Gap' : kw.category === 'cited' ? 'Cited' : 'Not Cited'}
                </ToneBadge>
              </td>
              <td className="py-1.5 text-zinc-400 text-xs">
                {kw.providers.length > 0 ? kw.providers.join(', ') : '—'}
              </td>
              <td className="py-1.5 text-zinc-400 text-xs">
                {kw.competitorsCiting.length > 0 ? kw.competitorsCiting.join(', ') : '—'}
              </td>
              <td className="py-1.5 text-right text-zinc-400 text-xs">
                {kw.consistency.totalRuns > 0
                  ? `${kw.consistency.citedRuns}/${kw.consistency.totalRuns} runs`
                  : '—'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function SourceBar({ categories }: { categories: SourceBreakdownDto['overall'] }) {
  const total = categories.reduce((s, c) => s + c.count, 0)
  if (total === 0) return null

  return (
    <div className="flex rounded-full overflow-hidden h-3 bg-zinc-800" aria-label="Source category distribution">
      {categories.map(cat => {
        const widthPct = (cat.count / total) * 100
        if (widthPct < 0.5) return null
        return (
          <div
            key={cat.category}
            className={`${SOURCE_CATEGORY_COLORS[cat.category] ?? 'bg-zinc-600'} transition-all`}
            style={{ width: `${widthPct}%` }}
            title={`${cat.label}: ${(cat.percentage * 100).toFixed(1)}%`}
          />
        )
      })}
    </div>
  )
}
