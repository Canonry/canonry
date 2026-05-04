import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import type {
  CitationCell,
  CitationsTrendPoint,
  CompetitorRow,
  ContentTargetRowDto,
  GscQueryRow,
  IndexingHealthSection,
  ProjectReportDto,
  RecommendedNextStep,
  ReportInsight,
} from '@ainyc/canonry-contracts'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_SERIES_COLORS,
  CHART_TOOLTIP_STYLE,
  formatChartDateLabel,
  formatChartDateTick,
} from '../components/shared/ChartPrimitives.js'
import { isTrendBaseline, MIN_TREND_POINTS } from '@ainyc/canonry-intelligence'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { Button } from '../components/ui/button.js'
import { downloadReportHtml, fetchReport, ApiError } from '../api.js'
import { queryKeys } from '../queries/query-keys.js'
import type { MetricTone } from '../view-models.js'

const SEVERITY_TONE: Record<ReportInsight['severity'], MetricTone> = {
  critical: 'negative',
  high: 'negative',
  medium: 'caution',
  low: 'neutral',
}

const FINDING_TONE_LABEL: Record<ProjectReportDto['executiveSummary']['findings'][number]['tone'], string> = {
  positive: 'Positive',
  caution: 'Caution',
  negative: 'Negative',
  neutral: 'Neutral',
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
}

function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(1)}%`
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function trendTone(trend: ProjectReportDto['executiveSummary']['trend']): MetricTone {
  switch (trend) {
    case 'up': return 'positive'
    case 'down': return 'negative'
    case 'flat': return 'neutral'
    case 'unknown': return 'neutral'
  }
}

function severityLabel(severity: ReportInsight['severity']): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1)
}

function horizonLabel(horizon: RecommendedNextStep['horizon']): string {
  switch (horizon) {
    case 'immediate': return 'Immediate'
    case 'short-term': return 'Short term'
    case 'medium-term': return 'Medium term'
  }
}

function actionLabel(action: ContentTargetRowDto['action']): string {
  switch (action) {
    case 'create': return 'Create'
    case 'expand': return 'Expand'
    case 'refresh': return 'Refresh'
    case 'add-schema': return 'Add schema'
  }
}

function citationStateClass(cell: CitationCell | null): string {
  if (!cell) return 'bg-zinc-900/30 text-zinc-700'
  if (cell.citationState === 'cited') return 'bg-emerald-500/20 text-emerald-300'
  if (cell.citationState === 'pending') return 'bg-amber-500/15 text-amber-300'
  return 'bg-zinc-900/40 text-zinc-500'
}

function citationStateLabel(cell: CitationCell | null): string {
  if (!cell) return '—'
  if (cell.citationState === 'cited') return 'Cited'
  if (cell.citationState === 'pending') return 'Pending'
  return 'Not cited'
}

function pressureTone(label: CompetitorRow['pressureLabel']): MetricTone {
  switch (label) {
    case 'High': return 'negative'
    case 'Moderate': return 'caution'
    case 'Low': return 'neutral'
    case 'None': return 'neutral'
  }
}

export function ReportPage({ projectName }: { projectName: string }) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const reportQuery = useQuery({
    queryKey: queryKeys.report(projectName),
    queryFn: () => fetchReport(projectName),
  })

  async function handleDownload() {
    setDownloading(true)
    setDownloadError(null)
    try {
      await downloadReportHtml(projectName)
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Download failed'
      setDownloadError(message)
    } finally {
      setDownloading(false)
    }
  }

  if (reportQuery.isLoading) {
    return <p className="text-sm text-zinc-500 py-8 text-center">Loading report…</p>
  }
  if (reportQuery.error) {
    const message = reportQuery.error instanceof Error ? reportQuery.error.message : 'Failed to load report'
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-rose-400">{message}</p>
      </div>
    )
  }
  const report = reportQuery.data
  if (!report) return null

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <p className="eyebrow">AEO Report</p>
          <h1 className="page-title">{report.meta.project.displayName}</h1>
          <p className="page-subtitle">
            {report.meta.project.canonicalDomain} · {report.meta.project.country} / {report.meta.project.language.toUpperCase()} · Generated {formatDate(report.meta.generatedAt)}
          </p>
          {downloadError && <p className="mt-2 text-xs text-rose-400">{downloadError}</p>}
        </div>
        <div className="page-header-right">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDownload}
            disabled={downloading}
          >
            <Download className="size-4" />
            {downloading ? 'Preparing…' : 'Download report HTML'}
          </Button>
        </div>
      </div>

      <ExecutiveSummarySection report={report} />
      <CitationScorecardSection report={report} />
      <CompetitorLandscapeSection report={report} />
      <AiSourceOriginSection report={report} />
      <GscPerformanceSection report={report} />
      <GaTrafficSection report={report} />
      <SocialReferralsSection report={report} />
      <AiReferralsSection report={report} />
      <IndexingHealthSectionView report={report} />
      <CitationsTrendSection report={report} />
      <InsightsSection report={report} />
      <ContentOpportunitiesSection report={report} />
      <NextStepsSection report={report} />
    </div>
  )
}

// ─── Section: Executive summary ────────────────────────────────────────────

function ExecutiveSummarySection({ report }: { report: ProjectReportDto }) {
  const exec = report.executiveSummary
  const trendArrow = exec.trend === 'up' ? '↑ Up' : exec.trend === 'down' ? '↓ Down' : exec.trend === 'flat' ? '→ Flat' : '—'
  const providerSuffix = `${trendArrow} · ${exec.providerCount} provider${exec.providerCount === 1 ? '' : 's'}`
  const competitorSuffix = `${exec.competitorCount} competitor${exec.competitorCount === 1 ? '' : 's'} tracked`
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 1" title="Executive summary" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Citation rate" value={formatPercent(exec.citationRate, 0)} tone={trendTone(exec.trend)} subtitle={providerSuffix} />
        <Metric label="Keywords tracked" value={formatNumber(exec.keywordCount)} subtitle={competitorSuffix} />
        {exec.gsc && (
          <Metric
            label="GSC clicks"
            value={formatNumber(exec.gsc.clicks)}
            subtitle={`${formatNumber(exec.gsc.impressions)} imp · ${formatRatio(exec.gsc.ctr)} CTR`}
          />
        )}
        {exec.ga && (
          <Metric
            label="GA sessions"
            value={formatNumber(exec.ga.sessions)}
            subtitle={`${formatNumber(exec.ga.users)} users · ${formatDate(exec.ga.periodStart)} → ${formatDate(exec.ga.periodEnd)}`}
          />
        )}
      </div>
      {exec.findings.length > 0 && (
        <div className="mt-5 space-y-2">
          {exec.findings.map((f, i) => (
            <div
              key={i}
              className={`insight-card rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-4 ${
                f.tone === 'positive' ? 'insight-card-positive' :
                f.tone === 'caution' ? 'insight-card-caution' :
                f.tone === 'negative' ? 'insight-card-negative' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <ToneBadge tone={f.tone}>{FINDING_TONE_LABEL[f.tone]}</ToneBadge>
                <span className="text-sm font-medium text-zinc-100">{f.title}</span>
              </div>
              <p className="text-sm text-zinc-400">{f.detail}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Metric({ label, value, tone, subtitle }: { label: string; value: string; tone?: MetricTone; subtitle?: string }) {
  const toneClass = tone === 'positive' ? 'text-emerald-400'
    : tone === 'caution' ? 'text-amber-400'
    : tone === 'negative' ? 'text-rose-400'
    : 'text-zinc-100'
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
      <p className="eyebrow-soft">{label}</p>
      <p className={`text-2xl font-semibold tracking-tight ${toneClass}`}>{value}</p>
      {subtitle && <p className="mt-1 text-[11px] text-zinc-500">{subtitle}</p>}
    </div>
  )
}

// ─── Section: Citation scorecard ───────────────────────────────────────────

function CitationScorecardSection({ report }: { report: ProjectReportDto }) {
  const sc = report.citationScorecard
  if (sc.providers.length === 0 || sc.keywords.length === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 2" title="Citation scorecard" />
        <EmptyHint message="No completed answer-visibility runs yet." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 2" title="Citation scorecard" />
      <div className="mb-4">
        <p className="eyebrow mb-2">Provider citation rate</p>
        <div className="h-48 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={sc.providerRates} layout="vertical" margin={{ left: 20, right: 20, top: 8, bottom: 8 }}>
              <CartesianGrid stroke={CHART_GRID_STROKE} horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
              <YAxis type="category" dataKey="provider" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={90} />
              <RechartsTooltip
                {...CHART_TOOLTIP_STYLE}
                formatter={(_v, _n, item) => {
                  const row = item?.payload as { citationRate: number; citedCount: number; totalCount: number } | undefined
                  if (!row) return ''
                  return `${row.citationRate}% (${row.citedCount}/${row.totalCount})`
                }}
              />
              <Bar dataKey="citationRate" fill={CHART_SERIES_COLORS[0]} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ul className="mt-2 space-y-0.5 text-[11px] text-zinc-500">
          {sc.providerRates.map(r => (
            <li key={r.provider}>
              <span className="font-medium text-zinc-300">{r.provider}</span>: {r.citationRate}% ({r.citedCount}/{r.totalCount})
            </li>
          ))}
        </ul>
      </div>
      <p className="eyebrow mb-2">Keyword × provider</p>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Keyword</th>
              {sc.providers.map(p => <th key={p}>{p}</th>)}
            </tr>
          </thead>
          <tbody>
            {sc.keywords.map((kw, i) => (
              <tr key={kw}>
                <td className="evidence-keyword-cell">{kw}</td>
                {sc.providers.map((p, j) => {
                  const cell = sc.matrix[i]?.[j] ?? null
                  return (
                    <td key={p}>
                      <span className={`inline-flex items-center justify-center rounded-md px-2 py-1 text-[11px] font-semibold ${citationStateClass(cell)}`}>
                        {citationStateLabel(cell)}
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">Cited = domain in source list · Not cited = absent · Pending = run incomplete · — = no snapshot</p>
    </section>
  )
}

// ─── Section: Competitor landscape ─────────────────────────────────────────

function CompetitorLandscapeSection({ report }: { report: ProjectReportDto }) {
  const cl = report.competitorLandscape
  const canonical = report.meta.project.canonicalDomain
  if (cl.competitors.length === 0 && cl.projectCitationCount === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 3" title="Competitor landscape" />
        <EmptyHint message="No competitor data yet. Add competitors and run a visibility sweep." />
      </section>
    )
  }
  const barData = [
    { label: canonical, count: cl.projectCitationCount, isProject: true },
    ...cl.competitors.map(c => ({ label: c.domain, count: c.citationCount, isProject: false })),
  ]
  const showBars = barData.length > 1
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 3" title="Competitor landscape" />
      {showBars && (
        <div className="mb-4">
          <p className="eyebrow mb-2">Citations per domain</p>
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3" style={{ height: barData.length * 32 + 32 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} layout="vertical" margin={{ left: 20, right: 32, top: 8, bottom: 8 }}>
                <CartesianGrid stroke={CHART_GRID_STROKE} horizontal={false} />
                <XAxis type="number" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
                <YAxis type="category" dataKey="label" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={140} />
                <RechartsTooltip {...CHART_TOOLTIP_STYLE} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {barData.map((d, i) => (
                    <Cell key={i} fill={d.isProject ? '#3b82f6' : CHART_SERIES_COLORS[(i + 1) % CHART_SERIES_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {cl.competitors.length === 0 ? (
        <EmptyHint message="No competitors configured." />
      ) : (
        <div className="competitor-table-wrap">
          <table className="competitor-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Pressure</th>
                <th>Citations</th>
                <th>SOV</th>
                <th>Cited keywords</th>
              </tr>
            </thead>
            <tbody>
              {cl.competitors.map(c => (
                <tr key={c.domain}>
                  <td className="evidence-keyword-cell">{c.domain}</td>
                  <td><ToneBadge tone={pressureTone(c.pressureLabel)}>{c.pressureLabel}</ToneBadge></td>
                  <td>{c.citationCount} / {c.totalCount}</td>
                  <td>{c.sharePct}%</td>
                  <td className="text-xs text-zinc-400">
                    {c.citedKeywords.slice(0, 5).join(', ')}{c.citedKeywords.length > 5 ? '…' : ''}
                    {c.theirCitedPages.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
                          {c.theirCitedPages.length} cited URL{c.theirCitedPages.length > 1 ? 's' : ''}
                        </summary>
                        <ul className="mt-1 space-y-1 pl-3">
                          {c.theirCitedPages.map((p, i) => (
                            <li key={i}>
                              <a href={p.url} className="break-all text-blue-400 hover:underline" target="_blank" rel="noreferrer">{p.url}</a>
                              <span className="ml-2 text-zinc-500">{p.citedFor.join(', ')}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ─── Section: AI source origin ─────────────────────────────────────────────

function AiSourceOriginSection({ report }: { report: ProjectReportDto }) {
  const so = report.aiSourceOrigin
  if (so.categories.length === 0 && so.topDomains.length === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 4" title="AI source origin" />
        <EmptyHint message="No source data yet. Run a visibility sweep first." />
      </section>
    )
  }
  const pieData = so.categories.filter(c => c.count > 0).map(c => ({ name: c.label, value: c.count }))
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 4" title="AI source origin" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="eyebrow mb-2">AI source categories</p>
          {pieData.length === 0 ? (
            <EmptyHint message="No category data." />
          ) : (
            <div className="h-64 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={85} stroke="none">
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip {...CHART_TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        <div>
          <p className="eyebrow mb-2">Top source domains</p>
          {so.topDomains.length === 0 ? (
            <EmptyHint message="No domains tracked yet." />
          ) : (
            <div className="evidence-table-wrap">
              <table className="evidence-table">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Citations</th>
                    <th>Tag</th>
                  </tr>
                </thead>
                <tbody>
                  {so.topDomains.map(d => (
                    <tr key={d.domain}>
                      <td className="evidence-keyword-cell text-xs">{d.domain}</td>
                      <td>{d.count}</td>
                      <td>
                        {d.isCompetitor
                          ? <ToneBadge tone="negative">Competitor</ToneBadge>
                          : <ToneBadge tone="neutral">External</ToneBadge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Section: GSC performance ──────────────────────────────────────────────

function GscPerformanceSection({ report }: { report: ProjectReportDto }) {
  const gsc = report.gsc
  if (!gsc) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 5" title="GSC performance" />
        <EmptyHint message="Google Search Console is not connected for this project." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 5" title="GSC performance" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Clicks" value={formatNumber(gsc.totalClicks)} />
        <Metric label="Impressions" value={formatNumber(gsc.totalImpressions)} />
        <Metric label="CTR" value={formatRatio(gsc.ctr)} />
        <Metric label="Avg position" value={gsc.avgPosition.toFixed(1)} />
      </div>
      {gsc.trend.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">Clicks over time</p>
          <div className="h-56 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={gsc.trend} margin={{ left: 8, right: 12, top: 8, bottom: 8 }}>
                <CartesianGrid stroke={CHART_GRID_STROKE} />
                <XAxis dataKey="date" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} tickFormatter={formatChartDateTick} />
                <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
                <RechartsTooltip {...CHART_TOOLTIP_STYLE} labelFormatter={formatChartDateLabel} />
                <Line type="monotone" dataKey="clicks" stroke={CHART_SERIES_COLORS[0]} strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {gsc.topQueries.length > 0 && <TopQueriesTable rows={gsc.topQueries} />}
      {gsc.categoryBreakdown.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">Query categories</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {gsc.categoryBreakdown.map(c => (
              <div key={c.category} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
                <p className="eyebrow-soft">{c.category}</p>
                <p className="text-base font-semibold text-zinc-100">{formatNumber(c.clicks)} clicks</p>
                <p className="text-[11px] text-zinc-500">{formatPercent(c.sharePct)} share · {formatNumber(c.impressions)} impressions</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {(gsc.trackedButNoGsc.length > 0 || gsc.gscButNotTracked.length > 0) && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {gsc.trackedButNoGsc.length > 0 && (
            <KeywordList title="Tracked but no GSC impressions" tone="caution" items={gsc.trackedButNoGsc} />
          )}
          {gsc.gscButNotTracked.length > 0 && (
            <KeywordList title="GSC queries not yet tracked" tone="neutral" items={gsc.gscButNotTracked} />
          )}
        </div>
      )}
    </section>
  )
}

function TopQueriesTable({ rows }: { rows: GscQueryRow[] }) {
  return (
    <div className="mt-4">
      <p className="eyebrow mb-2">Top queries</p>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Category</th>
              <th>Clicks</th>
              <th>Impr.</th>
              <th>CTR</th>
              <th>Pos.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.query}>
                <td className="evidence-keyword-cell">{r.query}</td>
                <td className="text-xs text-zinc-400">{r.category}</td>
                <td>{formatNumber(r.clicks)}</td>
                <td>{formatNumber(r.impressions)}</td>
                <td>{formatRatio(r.ctr)}</td>
                <td>{r.avgPosition.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function KeywordList({ title, items, tone }: { title: string; items: string[]; tone: MetricTone }) {
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3">
      <div className="flex items-center justify-between">
        <p className="eyebrow">{title}</p>
        <ToneBadge tone={tone}>{items.length}</ToneBadge>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-zinc-400">
        {items.slice(0, 8).map(k => <li key={k} className="truncate">· {k}</li>)}
        {items.length > 8 && <li className="text-zinc-600">+ {items.length - 8} more</li>}
      </ul>
    </div>
  )
}

// ─── Section: GA4 traffic ──────────────────────────────────────────────────

function GaTrafficSection({ report }: { report: ProjectReportDto }) {
  const ga = report.ga
  if (!ga) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 6" title="GA4 traffic" />
        <EmptyHint message="Google Analytics 4 is not connected for this project." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 6" title="GA4 traffic" />
      <p className="page-subtitle">{formatDate(ga.periodStart)} → {formatDate(ga.periodEnd)}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Metric label="Sessions" value={formatNumber(ga.totalSessions)} />
        <Metric label="Users" value={formatNumber(ga.totalUsers)} />
        <Metric label="Organic sessions" value={formatNumber(ga.totalOrganicSessions)} />
      </div>
      {ga.topLandingPages.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">Top landing pages</p>
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Sessions</th>
                  <th>Users</th>
                  <th>Organic</th>
                </tr>
              </thead>
              <tbody>
                {ga.topLandingPages.slice(0, 12).map(p => (
                  <tr key={p.page}>
                    <td className="evidence-keyword-cell text-xs">{p.page}</td>
                    <td>{formatNumber(p.sessions)}</td>
                    <td>{formatNumber(p.users)}</td>
                    <td>{formatNumber(p.organicSessions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {ga.channelBreakdown.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">Channel breakdown</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ga.channelBreakdown.map(c => (
              <div key={c.channel} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
                <p className="eyebrow-soft">{c.channel}</p>
                <p className="text-base font-semibold text-zinc-100">{formatNumber(c.sessions)}</p>
                <p className="text-[11px] text-zinc-500">{formatPercent(c.sharePct)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ─── Section: Social referrals ─────────────────────────────────────────────

function SocialReferralsSection({ report }: { report: ProjectReportDto }) {
  const sr = report.socialReferrals
  if (!sr) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 7" title="Social referrals" />
        <EmptyHint message="No social referral data." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 7" title="Social referrals" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Total sessions" value={formatNumber(sr.totalSessions)} />
        <Metric label="Organic" value={formatNumber(sr.organicSessions)} />
        <Metric label="Paid" value={formatNumber(sr.paidSessions)} />
      </div>
      {sr.channels.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">By channel</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {sr.channels.map(c => (
              <div key={c.channelGroup} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
                <p className="eyebrow-soft">{c.channelGroup}</p>
                <p className="text-base font-semibold text-zinc-100">{formatNumber(c.sessions)}</p>
                <p className="text-[11px] text-zinc-500">{formatPercent(c.sharePct)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {sr.topCampaigns.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">Top campaigns</p>
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Medium</th>
                  <th>Sessions</th>
                </tr>
              </thead>
              <tbody>
                {sr.topCampaigns.map((c, i) => (
                  <tr key={`${c.source}-${c.medium}-${i}`}>
                    <td>{c.source}</td>
                    <td className="text-xs text-zinc-400">{c.medium}</td>
                    <td>{formatNumber(c.sessions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

// ─── Section: AI referrals ─────────────────────────────────────────────────

function AiReferralsSection({ report }: { report: ProjectReportDto }) {
  const ai = report.aiReferrals
  if (!ai) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 8" title="AI referral traffic" />
        <EmptyHint message="No AI referral data." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 8" title="AI referral traffic" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Metric label="Sessions" value={formatNumber(ai.totalSessions)} />
        <Metric label="Users" value={formatNumber(ai.totalUsers)} />
      </div>
      {ai.trend.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">AI sessions trend</p>
          <div className="h-48 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={ai.trend} margin={{ left: 8, right: 12, top: 8, bottom: 8 }}>
                <CartesianGrid stroke={CHART_GRID_STROKE} />
                <XAxis dataKey="date" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} tickFormatter={formatChartDateTick} />
                <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
                <RechartsTooltip {...CHART_TOOLTIP_STYLE} labelFormatter={formatChartDateLabel} />
                <Line type="monotone" dataKey="sessions" stroke={CHART_SERIES_COLORS[0]} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {ai.bySource.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">By source</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ai.bySource.map(s => (
              <div key={s.source} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
                <p className="eyebrow-soft">{s.source}</p>
                <p className="text-base font-semibold text-zinc-100">{formatNumber(s.sessions)}</p>
                <p className="text-[11px] text-zinc-500">{formatNumber(s.users)} users · {formatPercent(s.sharePct)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {ai.topLandingPages.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">Top AI landing pages</p>
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <thead><tr><th>Page</th><th>Sessions</th><th>Users</th></tr></thead>
              <tbody>
                {ai.topLandingPages.map(p => (
                  <tr key={p.page}>
                    <td className="evidence-keyword-cell text-xs">{p.page}</td>
                    <td>{formatNumber(p.sessions)}</td>
                    <td>{formatNumber(p.users)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

// ─── Section: Indexing health ──────────────────────────────────────────────

function IndexingHealthSectionView({ report }: { report: ProjectReportDto }) {
  const ih = report.indexingHealth
  if (!ih || !ih.provider) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 9" title="Indexing health" />
        <EmptyHint message="No indexing data — connect Google Search Console or Bing Webmaster Tools." />
      </section>
    )
  }
  const tone: MetricTone = ih.indexedPct >= 90 ? 'positive' : ih.indexedPct >= 70 ? 'caution' : 'negative'
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 9" title={`Indexing health — ${ih.provider}`} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Indexed" value={formatPercent(ih.indexedPct, 0)} tone={tone} />
        <Metric label="Total pages" value={formatNumber(ih.total)} />
        <Metric label="Indexed pages" value={formatNumber(ih.indexed)} />
        <Metric label="Not indexed" value={formatNumber(ih.notIndexed)} />
        <DeindexedOrUnknown ih={ih} />
      </div>
    </section>
  )
}

function DeindexedOrUnknown({ ih }: { ih: IndexingHealthSection }) {
  if (ih.provider === 'google') return <Metric label="Deindexed" value={formatNumber(ih.deindexed)} />
  return <Metric label="Unknown" value={formatNumber(ih.unknown)} />
}

// ─── Section: Citations trend ──────────────────────────────────────────────

function CitationsTrendSection({ report }: { report: ProjectReportDto }) {
  const trend = report.citationsTrend
  if (trend.length === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 10" title="Citations over time" />
        <EmptyHint message="Run multiple visibility sweeps to see a trend." />
      </section>
    )
  }
  if (isTrendBaseline(trend)) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 10" title="Citations over time" />
        <EmptyHint message={`Establishing baseline (${trend.length} of ${MIN_TREND_POINTS} runs collected). Trend will appear once more sweeps are recorded.`} />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 10" title="Citations over time" />
      <div className="h-64 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={trend} margin={{ left: 8, right: 12, top: 8, bottom: 8 }}>
            <CartesianGrid stroke={CHART_GRID_STROKE} />
            <XAxis dataKey="date" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} tickFormatter={formatChartDateTick} />
            <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
            <RechartsTooltip
              {...CHART_TOOLTIP_STYLE}
              labelFormatter={formatChartDateLabel}
              formatter={(v) => `${v}%`}
            />
            <Line type="monotone" dataKey="citationRate" stroke={CHART_SERIES_COLORS[0]} strokeWidth={2} dot />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <PerProviderTrendTable trend={trend} />
    </section>
  )
}

function PerProviderTrendTable({ trend }: { trend: CitationsTrendPoint[] }) {
  if (trend.length === 0) return null
  return (
    <div className="mt-4">
      <p className="eyebrow mb-2">Run-by-run breakdown</p>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Overall rate</th>
              <th>Per-provider rates</th>
            </tr>
          </thead>
          <tbody>
            {trend.map(t => (
              <tr key={t.runId}>
                <td className="evidence-keyword-cell">{formatDate(t.date)}</td>
                <td>{t.citationRate}%</td>
                <td className="text-xs text-zinc-400">
                  {t.providerRates.map(r => `${r.provider}: ${r.citationRate}%`).join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Section: Insights ─────────────────────────────────────────────────────

function InsightsSection({ report }: { report: ProjectReportDto }) {
  if (report.insights.length === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 11" title="Insights &amp; alerts" />
        <EmptyHint message="No active insights — everything looks stable." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 11" title="Insights &amp; alerts" />
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Title</th>
              <th>Keyword</th>
              <th>Provider</th>
              <th>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {report.insights.map(i => (
              <tr key={i.id}>
                <td>
                  <ToneBadge tone={SEVERITY_TONE[i.severity]}>{severityLabel(i.severity)}</ToneBadge>
                  {i.instanceCount > 1 && (
                    <span className="ml-2 text-[11px] text-zinc-500">×{i.instanceCount}</span>
                  )}
                </td>
                <td className="evidence-keyword-cell">{i.title}</td>
                <td className="text-xs text-zinc-400">{i.keyword}</td>
                <td className="text-xs text-zinc-400">{i.provider}</td>
                <td className="text-xs text-zinc-400">{i.recommendation ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ─── Section: Content opportunities ────────────────────────────────────────

function ContentOpportunitiesSection({ report }: { report: ProjectReportDto }) {
  if (report.contentOpportunities.length === 0) {
    return null
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 12" title="Content opportunities" />
      <p className="page-subtitle mb-3">Ranked, action-typed targets from the content recommendation engine. Top 10 shown.</p>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Action</th>
              <th>Score</th>
              <th>Our page</th>
              <th>Winning competitor</th>
              <th>Demand</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {report.contentOpportunities.slice(0, 10).map(o => (
              <tr key={o.targetRef}>
                <td className="evidence-keyword-cell">{o.query}</td>
                <td><ToneBadge tone="neutral">{actionLabel(o.action)}</ToneBadge></td>
                <td>{Math.round(o.score)}</td>
                <td className="text-xs">
                  {o.ourBestPage
                    ? <a href={o.ourBestPage.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{o.ourBestPage.url}</a>
                    : <span className="text-zinc-600">—</span>}
                </td>
                <td className="text-xs">
                  {o.winningCompetitor
                    ? <a href={o.winningCompetitor.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{o.winningCompetitor.domain}</a>
                    : <span className="text-zinc-600">—</span>}
                </td>
                <td><ToneBadge tone="neutral">{o.demandSource}</ToneBadge></td>
                <td><ToneBadge tone="neutral">{o.actionConfidence}</ToneBadge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ─── Section: Next steps ───────────────────────────────────────────────────

function NextStepsSection({ report }: { report: ProjectReportDto }) {
  if (report.recommendedNextSteps.length === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 13" title="Recommended next steps" />
        <EmptyHint message="No prioritized actions yet." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 13" title="Recommended next steps" />
      <div className="grid gap-3 lg:grid-cols-3">
        {(['immediate', 'short-term', 'medium-term'] as const).map(h => {
          const steps = report.recommendedNextSteps.filter(s => s.horizon === h)
          if (steps.length === 0) return null
          const tone: MetricTone = h === 'immediate' ? 'negative' : h === 'short-term' ? 'caution' : 'neutral'
          return (
            <div key={h} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
              <ToneBadge tone={tone}>{horizonLabel(h)}</ToneBadge>
              <ul className="mt-3 space-y-3">
                {steps.map((s, i) => (
                  <li key={i}>
                    <p className="text-sm font-medium text-zinc-100">{s.title}</p>
                    <p className="text-xs text-zinc-500">{s.rationale}</p>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── Shared helpers ────────────────────────────────────────────────────────

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-3">
      <p className="eyebrow-soft">{eyebrow}</p>
      <h2 className="page-title">{title}</h2>
    </div>
  )
}

function EmptyHint({ message }: { message: string }) {
  return <p className="text-sm text-zinc-500 py-4 text-center">{message}</p>
}
