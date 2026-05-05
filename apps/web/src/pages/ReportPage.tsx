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
import { absolutizeProjectUrl } from '@ainyc/canonry-contracts'

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
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { Button } from '../components/ui/button.js'
import { downloadReportHtml, fetchReport, ApiError } from '../api.js'
import { queryKeys } from '../queries/query-keys.js'
import type { MetricTone } from '../view-models.js'

// Mirrors MIN_TREND_POINTS in @ainyc/canonry-intelligence/trend-stability.
// Inlined because that package's barrel imports node:crypto, which Vite
// can't bundle for the browser. Keep these in lockstep.
const MIN_TREND_POINTS = 4
function isTrendBaseline(points: readonly unknown[]): boolean {
  return points.length < MIN_TREND_POINTS
}

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
      <SectionHeading eyebrow="Section 1" title="Executive summary" subtitle="Top-line citation rate with trend versus the prior run, plus the most actionable findings from the latest visibility sweep." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Citation rate" value={formatPercent(exec.citationRate, 0)} tone={trendTone(exec.trend)} subtitle={providerSuffix} />
        <Metric label="Queries tracked" value={formatNumber(exec.queryCount)} subtitle={competitorSuffix} />
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
  if (sc.providers.length === 0 || sc.queries.length === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 2" title="Citation scorecard" subtitle="Whether your domain appeared in each AI engine's source list for every tracked keyword in the latest sweep — green = cited, red = not cited, gray = no snapshot." />
        <EmptyHint message="No completed answer-visibility runs yet." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 2" title="Citation scorecard" subtitle="Whether your domain appeared in each AI engine's source list for every tracked keyword in the latest sweep — green = cited, red = not cited, gray = no snapshot." />
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
      <p className="eyebrow mb-2">Query × provider</p>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Query</th>
              {sc.providers.map(p => <th key={p}>{p}</th>)}
            </tr>
          </thead>
          <tbody>
            {sc.queries.map((q: string, i: number) => (
              <tr key={q}>
                <td className="evidence-query-cell">{q}</td>
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
  const ml = report.mentionLandscape
  const canonical = report.meta.project.canonicalDomain
  const noCitationData = cl.competitors.length === 0 && cl.projectCitationCount === 0
  const noMentionData = ml.competitors.length === 0 && ml.projectMentionCount === 0
  if (noCitationData && noMentionData) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 3" title="Competitor landscape" subtitle="Where tracked competitors appear in AI answers compared to your domain — both in source citations and in the answer text itself." />
        <EmptyHint message="No competitor data yet. Add competitors and run a visibility sweep." />
      </section>
    )
  }
  const citationBarData = [
    { label: canonical, count: cl.projectCitationCount, isProject: true },
    ...cl.competitors.map(c => ({ label: c.domain, count: c.citationCount, isProject: false })),
  ]
  const mentionBarData = [
    { label: canonical, count: ml.projectMentionCount, isProject: true },
    ...ml.competitors.map(c => ({ label: c.domain, count: c.mentionCount, isProject: false })),
  ]
  const showCitationBars = citationBarData.length > 1
  const showMentionBars = mentionBarData.length > 1
  const mentionByDomain = new Map(ml.competitors.map(m => [m.domain, m]))
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 3" title="Competitor landscape" subtitle="Where tracked competitors appear in AI answers compared to your domain — both in source citations and in the answer text itself." />
      <div className="grid gap-4 lg:grid-cols-2">
        {showCitationBars && (
          <div>
            <p className="eyebrow mb-2">Citations per domain</p>
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3" style={{ height: citationBarData.length * 32 + 32 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={citationBarData} layout="vertical" margin={{ left: 20, right: 32, top: 8, bottom: 8 }}>
                  <CartesianGrid stroke={CHART_GRID_STROKE} horizontal={false} />
                  <XAxis type="number" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
                  <YAxis type="category" dataKey="label" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={140} />
                  <RechartsTooltip {...CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {citationBarData.map((d, i) => (
                      <Cell key={i} fill={d.isProject ? '#3b82f6' : CHART_SERIES_COLORS[(i + 1) % CHART_SERIES_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        {showMentionBars && (
          <div>
            <p className="eyebrow mb-2">Mentions per domain</p>
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3" style={{ height: mentionBarData.length * 32 + 32 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={mentionBarData} layout="vertical" margin={{ left: 20, right: 32, top: 8, bottom: 8 }}>
                  <CartesianGrid stroke={CHART_GRID_STROKE} horizontal={false} />
                  <XAxis type="number" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
                  <YAxis type="category" dataKey="label" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={140} />
                  <RechartsTooltip {...CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {mentionBarData.map((d, i) => (
                      <Cell key={i} fill={d.isProject ? '#3b82f6' : CHART_SERIES_COLORS[(i + 1) % CHART_SERIES_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">Citations = domain in source list · Mentions = brand or domain in answer text — independent signals.</p>
      {cl.competitors.length === 0 ? (
        <EmptyHint message="No competitors configured." />
      ) : (
        <div className="competitor-table-wrap mt-4">
          <table className="competitor-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Pressure</th>
                <th>Citations</th>
                <th>Mentions</th>
                <th>SOV</th>
                <th>Cited queries</th>
              </tr>
            </thead>
            <tbody>
              {cl.competitors.map(c => {
                const mention = mentionByDomain.get(c.domain)
                const mentionCount = mention?.mentionCount ?? 0
                const mentionTotal = mention?.totalCount ?? ml.totalAnswerSnapshots
                return (
                  <tr key={c.domain}>
                    <td className="evidence-query-cell">{c.domain}</td>
                    <td><ToneBadge tone={pressureTone(c.pressureLabel)}>{c.pressureLabel}</ToneBadge></td>
                    <td>{c.citationCount} / {c.totalCount}</td>
                    <td>{mentionCount} / {mentionTotal}</td>
                    <td>{c.sharePct}%</td>
                    <td className="text-xs text-zinc-400">
                      {c.citedQueries.slice(0, 5).join(', ')}{c.citedQueries.length > 5 ? '…' : ''}
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
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ─── Section: AI citation sources ──────────────────────────────────────────

function AiSourceOriginSection({ report }: { report: ProjectReportDto }) {
  const so = report.aiSourceOrigin
  if (so.categories.length === 0 && so.topDomains.length === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 4" title="AI citation sources" subtitle="Every external website AI engines cited as a source for your tracked keywords in the latest sweep — categorized by site type on the left and ranked by frequency on the right. Your own domains are excluded; tracked competitors are flagged." />
        <EmptyHint message="No source data yet. Run a visibility sweep first." />
      </section>
    )
  }
  const pieData = so.categories.filter(c => c.count > 0).map(c => ({ name: c.label, value: c.count }))
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 4" title="AI citation sources" subtitle="Every external website AI engines cited as a source for your tracked keywords in the latest sweep — categorized by site type on the left and ranked by frequency on the right. Your own domains are excluded; tracked competitors are flagged." />
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
                      <td className="evidence-query-cell text-xs">{d.domain}</td>
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
        <SectionHeading eyebrow="Section 5" title="GSC performance" subtitle="Your site's performance in Google's regular (non-AI) search results — top queries, intent breakdown, and the click trend, sourced from Google Search Console for the most recent sync window." />
        <EmptyHint message="Google Search Console is not connected for this project." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 5" title="GSC performance" subtitle="Your site's performance in Google's regular (non-AI) search results — top queries, intent breakdown, and the click trend, sourced from Google Search Console for the most recent sync window." />
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
            <QueryList title="Tracked but no GSC impressions" tone="caution" items={gsc.trackedButNoGsc} />
          )}
          {gsc.gscButNotTracked.length > 0 && (
            <QueryList title="GSC queries not yet tracked" tone="neutral" items={gsc.gscButNotTracked} />
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
                <td className="evidence-query-cell">{r.query}</td>
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

function QueryList({ title, items, tone }: { title: string; items: string[]; tone: MetricTone }) {
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
        <SectionHeading eyebrow="Section 6" title="GA4 traffic" subtitle="Total sessions and users on your site, with top landing pages and channel breakdown — sourced from Google Analytics 4." />
        <EmptyHint message="Google Analytics 4 is not connected for this project." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 6" title="GA4 traffic" subtitle={`Total sessions and users on your site between ${formatDate(ga.periodStart)} and ${formatDate(ga.periodEnd)}, with top landing pages and channel breakdown — sourced from Google Analytics 4.`} />
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
                    <td className="evidence-query-cell text-xs">{p.page}</td>
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
        <SectionHeading eyebrow="Section 7" title="Social referrals" subtitle="Sessions on your site sent by social platforms (LinkedIn, Facebook, X, etc.) — paid versus organic split with the top driving campaigns. Sourced from Google Analytics 4." />
        <EmptyHint message="No social referral data." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 7" title="Social referrals" subtitle="Sessions on your site sent by social platforms (LinkedIn, Facebook, X, etc.) — paid versus organic split with the top driving campaigns. Sourced from Google Analytics 4." />
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
        <SectionHeading eyebrow="Section 8" title="AI referral traffic" subtitle="Sessions on your site referred by AI answer engines (ChatGPT, Perplexity, Claude, Copilot, Gemini, etc.) — broken down by referrer with a daily trend and the top landing pages. Sourced from Google Analytics 4." />
        <EmptyHint message="No AI referral data." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 8" title="AI referral traffic" subtitle="Sessions on your site referred by AI answer engines (ChatGPT, Perplexity, Claude, Copilot, Gemini, etc.) — broken down by referrer with a daily trend and the top landing pages. Sourced from Google Analytics 4." />
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
                    <td className="evidence-query-cell text-xs">{p.page}</td>
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
        <SectionHeading eyebrow="Section 9" title="Indexing health" subtitle="What share of your tracked URLs are currently indexed in Google or Bing — connect Google Search Console or Bing Webmaster Tools to populate this section." />
        <EmptyHint message="No indexing data — connect Google Search Console or Bing Webmaster Tools." />
      </section>
    )
  }
  const tone: MetricTone = ih.indexedPct >= 90 ? 'positive' : ih.indexedPct >= 70 ? 'caution' : 'negative'
  const indexingSubtitle = `What share of your tracked URLs are currently indexed in ${ih.provider === 'google' ? 'Google' : 'Bing'} — sourced from ${ih.provider === 'google' ? 'Google Search Console URL Inspection' : 'Bing Webmaster Tools URL Inspection'}. Pages absent from the index can't be retrieved by AI engines either.`
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 9" title={`Indexing health — ${ih.provider}`} subtitle={indexingSubtitle} />
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
        <SectionHeading eyebrow="Section 10" title="Citations over time" subtitle="Citation rate across every visibility sweep — the share of (keyword × provider) pairs in each run where your domain appeared in the source list, with a per-provider breakdown beneath." />
        <EmptyHint message="Run multiple visibility sweeps to see a trend." />
      </section>
    )
  }
  if (isTrendBaseline(trend)) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 10" title="Citations over time" subtitle="Citation rate across every visibility sweep — the share of (keyword × provider) pairs in each run where your domain appeared in the source list, with a per-provider breakdown beneath." />
        <EmptyHint message={`Establishing baseline (${trend.length} of ${MIN_TREND_POINTS} runs collected). Trend will appear once more sweeps are recorded.`} />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 10" title="Citations over time" subtitle="Citation rate across every visibility sweep — the share of (keyword × provider) pairs in each run where your domain appeared in the source list, with a per-provider breakdown beneath." />
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
                <td className="evidence-query-cell">{formatDate(t.date)}</td>
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
        <SectionHeading eyebrow="Section 11" title="Insights &amp; alerts" subtitle="Regressions (citations lost), gains (citations won), and opportunities surfaced by the intelligence engine across the most recent sweeps — ordered by severity and recurrence." />
        <EmptyHint message="No active insights — everything looks stable." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 11" title="Insights &amp; alerts" subtitle="Regressions (citations lost), gains (citations won), and opportunities surfaced by the intelligence engine across the most recent sweeps — ordered by severity and recurrence." />
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Title</th>
              <th>Query</th>
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
                <td className="evidence-query-cell">{i.title}</td>
                <td className="text-xs text-zinc-400">{i.query}</td>
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
  const canonical = report.meta.project.canonicalDomain
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 12" title="Content opportunities" subtitle="Queries where you have search demand or competitor citation pressure but aren't winning AI citations. Each row carries a suggested action (create / refresh / expand / add-schema). Top 10 shown." />
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
                <td className="evidence-query-cell">{o.query}</td>
                <td><ToneBadge tone="neutral">{actionLabel(o.action)}</ToneBadge></td>
                <td>{Math.round(o.score)}</td>
                <td className="text-xs">
                  {o.ourBestPage
                    ? <a href={absolutizeProjectUrl(o.ourBestPage.url, canonical)} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{o.ourBestPage.url}</a>
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
        <SectionHeading eyebrow="Section 13" title="Recommended next steps" subtitle="Action items bucketed by horizon (immediate, short-term, medium-term), drawn from open insights and the highest-ranked content opportunities." />
        <EmptyHint message="No prioritized actions yet." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 13" title="Recommended next steps" subtitle="Action items bucketed by horizon (immediate, short-term, medium-term), drawn from open insights and the highest-ranked content opportunities." />
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

function SectionHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <p className="eyebrow-soft">{eyebrow}</p>
      <h2 className="page-title">{title}</h2>
      {subtitle && <p className="page-subtitle mt-1">{subtitle}</p>}
    </div>
  )
}

function EmptyHint({ message }: { message: string }) {
  return <p className="text-sm text-zinc-500 py-4 text-center">{message}</p>
}
