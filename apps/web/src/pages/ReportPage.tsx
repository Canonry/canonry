import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import type {
  CitationCell,
  CitationsTrendPoint,
  CompetitorRow,
  GscQueryRow,
  IndexingHealthSection,
  ProjectReportDto,
  ReportActionPlanItem,
  ReportAudience,
  ReportInsight,
} from '@ainyc/canonry-contracts'
import {
  absolutizeProjectUrl,
  actionConfidenceLabel,
  CitationStates,
  contentActionLabel,
  dedupeReportActions,
  dedupeReportOpportunities,
  formatDeltaCopy,
  reportActionCategoryLabel,
  reportActionTone,
  reportConfidenceLabel,
  reportHorizonLabel,
  reportSeverityLabel,
} from '@ainyc/canonry-contracts'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
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

function formatLocationLabel(location: NonNullable<ProjectReportDto['meta']['location']>): string {
  const place = [location.city, location.region, location.country].filter(Boolean).join(', ')
  return place ? `${location.label} (${place})` : location.label
}

function locationTreatmentTone(treatment: ProjectReportDto['meta']['providerLocationHandling'][number]['treatment']): MetricTone {
  switch (treatment) {
    case 'request-param':
    case 'prompt':
      return 'positive'
    case 'browser-geo':
      return 'caution'
    case 'ignored':
      return 'negative'
  }
}

const LOCATION_TREATMENT_LABEL: Record<ProjectReportDto['meta']['providerLocationHandling'][number]['treatment'], string> = {
  'request-param': 'Request parameter',
  prompt: 'Prompt-injected',
  'browser-geo': 'Browser geo',
  ignored: 'Ignored',
}

// severityLabel / horizonLabel / actionLabel moved to @ainyc/canonry-contracts
// (`reportSeverityLabel`, `reportHorizonLabel`, `contentActionLabel`) so the
// HTML report renderer and the web dashboard can't drift on what users see.

function CitedMentionedGlyphs({ cell }: { cell: CitationCell | null }) {
  if (!cell) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[12px] text-zinc-700">
        <span>—</span>
        <span>—</span>
      </span>
    )
  }
  const cited = cell.citationState === CitationStates.cited
  const mentioned = cell.answerMentioned
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px]">
      <span className={cited ? 'text-emerald-300' : 'text-zinc-500'} title={cited ? 'Cited (your domain in source list)' : 'Not cited'}>
        {cited ? 'C' : 'c'}
      </span>
      <span
        className={mentioned === true ? 'text-emerald-300' : mentioned === false ? 'text-zinc-500' : 'text-zinc-700'}
        title={
          mentioned === true ? 'Mentioned (your brand in answer text)'
            : mentioned === false ? 'Not mentioned'
            : 'No answer text'
        }
      >
        {mentioned === true ? 'M' : mentioned === false ? 'm' : '–'}
      </span>
    </span>
  )
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
      await downloadReportHtml(projectName, 'client')
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
          <p className="eyebrow">AI Visibility Report</p>
          <h1 className="page-title">{report.meta.project.displayName}</h1>
          <p className="page-subtitle">
            {report.meta.project.canonicalDomain} · {report.meta.project.country} / {report.meta.project.language.toUpperCase()}
            {report.meta.location
              ? ` · Location: ${formatLocationLabel(report.meta.location)}`
              : ' · No location set'}
            {' · '}Generated {formatDate(report.meta.generatedAt)}
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

      <ClientSummarySection report={report} />
      <WhatsChangedSection report={report} audience="client" />
      <ServerActivityClientView report={report} />
      <ActionPlanSection report={report} audience="client" />
      <ClientEvidenceSection report={report} />
    </div>
  )
}

// Section heading for the server-side AI visibility view. Mirrors the
// HTML renderer's `serverActivityHeading('client', …)` per the
// report-parity rule — eyebrow, title, and subtitle must match verbatim.
const SERVER_ACTIVITY_TITLE = 'AI Visibility — Server-Side'
const SERVER_ACTIVITY_EYEBROW_CLIENT = 'AI engine attention'
const SERVER_ACTIVITY_INTRO_HAS_DATA = 'What AI engines actually do in your server logs over the last 7 days — the other half of citations.'
const SERVER_ACTIVITY_INTRO_NO_DATA = 'Live telemetry from your server logs.'

/**
 * Client-friendly summary of server-side AI visibility data.
 * Hidden when no source is connected (per the agreed empty-state policy: silent for client).
 * When `hasData=false` (source connected but nothing synced yet), shows one short
 * line so users know their connection is healthy.
 */
function ServerActivityClientView({ report }: { report: ProjectReportDto }) {
  const sa = report.serverActivity
  if (!sa) return null

  if (!sa.hasData) {
    return (
      <section className="page-section-divider">
        <SectionHeading
          eyebrow={SERVER_ACTIVITY_EYEBROW_CLIENT}
          title={SERVER_ACTIVITY_TITLE}
          subtitle={SERVER_ACTIVITY_INTRO_NO_DATA}
        />
        <p className="text-sm text-zinc-500">
          Your server-side traffic source is connected. Numbers will appear after the next sync.
        </p>
      </section>
    )
  }

  const verifiedDelta = formatDeltaCopy(sa.verifiedCrawlerHits, 'crawls')
  const referralDelta = formatDeltaCopy(sa.referralArrivals, 'arrivals')
  // For the client view we cap at the top 5 entries — agencies see the full breakdown in the HTML report.
  const topOperators = sa.byOperator.filter(o => o.verifiedHits > 0 || o.referralArrivals > 0).slice(0, 5)

  return (
    <section className="page-section-divider">
      <SectionHeading
        eyebrow={SERVER_ACTIVITY_EYEBROW_CLIENT}
        title={SERVER_ACTIVITY_TITLE}
        subtitle={SERVER_ACTIVITY_INTRO_HAS_DATA}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Metric
          label="AI bots visited your site"
          value={formatNumber(sa.verifiedCrawlerHits.current)}
          subtitle={verifiedDelta}
        />
        <Metric
          label="People clicked through from AI"
          value={formatNumber(sa.referralArrivals.current)}
          subtitle={referralDelta}
        />
      </div>
      {topOperators.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-2">By AI tool</p>
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th>AI tool</th>
                  <th>Bot visits (7d)</th>
                  <th>Click-throughs</th>
                </tr>
              </thead>
              <tbody>
                {topOperators.map(o => (
                  <tr key={o.operator}>
                    <td className="evidence-query-cell">{o.operator}</td>
                    <td>{formatNumber(o.verifiedHits)}</td>
                    <td>{formatNumber(o.referralArrivals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Verified visits only. We confirm each bot via reverse-DNS so the numbers above can't be inflated by anyone faking a user agent.
          </p>
        </div>
      )}
    </section>
  )
}

function actionAudienceMatches(action: ReportActionPlanItem, audience: ReportAudience): boolean {
  return action.audience === 'both' || action.audience === audience
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  openai: 'ChatGPT',
  claude: 'Claude',
  perplexity: 'Perplexity',
  local: 'Local model',
  'cdp:chatgpt': 'ChatGPT (browser)',
}

function providerDisplayName(name: string): string {
  return PROVIDER_DISPLAY_NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
}

function clientTrendCopy(delta: ProjectReportDto['whatsChanged']['citationRate']): { text: string; tone: MetricTone; arrow: string } | null {
  if (!delta) return null
  if (delta.direction === 'up') {
    return { text: `Up ${delta.deltaAbs.toFixed(1)} points since last check (was ${delta.prior}%)`, tone: 'positive', arrow: '↑' }
  }
  if (delta.direction === 'down') {
    return { text: `Down ${Math.abs(delta.deltaAbs).toFixed(1)} points since last check (was ${delta.prior}%)`, tone: 'negative', arrow: '↓' }
  }
  return { text: `Holding steady since last check (was ${delta.prior}%)`, tone: 'neutral', arrow: '→' }
}

function ClientSummarySection({ report }: { report: ProjectReportDto }) {
  const exec = report.executiveSummary
  const sc = report.citationScorecard
  const totalQ = exec.totalQueryCount
  const heroNumber = totalQ > 0 ? `${exec.citationRate}%` : '—'
  const heroSentence = totalQ > 0
    ? `When customers asked AI ${totalQ} ${totalQ === 1 ? 'question' : 'questions'} about your industry, AI linked to your website in ${exec.citedQueryCount} of ${totalQ === 1 ? 'them' : 'those answers'}.`
    : 'No AI check has been run yet. Run a check to see how AI tools answer customer questions about your business.'
  const trend = clientTrendCopy(report.whatsChanged.citationRate)
  const providerSubtitle = sc.providers.length > 0
    ? sc.providers.map(providerDisplayName).join(', ')
    : `${formatNumber(exec.queryCount)} ${exec.queryCount === 1 ? 'question' : 'questions'} tested`

  return (
    <section className="page-section-divider">
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-900/40 p-6 sm:p-8">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Overview</p>
        <p className="mt-3 text-6xl font-bold tracking-tight text-zinc-50 sm:text-7xl">{heroNumber}</p>
        <p className="mt-3 max-w-2xl text-base text-zinc-300 sm:text-lg">{heroSentence}</p>
        {trend && (
          <p className={`mt-3 text-sm font-medium ${trend.tone === 'positive' ? 'text-emerald-400' : trend.tone === 'negative' ? 'text-rose-400' : 'text-zinc-400'}`}>
            <span className="mr-1">{trend.arrow}</span>{trend.text}
          </p>
        )}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <BigMetricTile
          label="AI mentions your name"
          value={`${exec.mentionRate}%`}
          subtitle={totalQ > 0 ? `Says your name in ${exec.mentionedQueryCount} of ${totalQ} ${totalQ === 1 ? 'answer' : 'answers'}` : 'No data yet'}
        />
        <BigMetricTile
          label="AI links to your website"
          value={`${exec.citationRate}%`}
          subtitle={totalQ > 0 ? `Cites your site as a source in ${exec.citedQueryCount} of ${totalQ} ${totalQ === 1 ? 'answer' : 'answers'}` : 'No data yet'}
        />
        <BigMetricTile
          label="AI tools tested"
          value={formatNumber(exec.providerCount)}
          subtitle={providerSubtitle}
        />
      </div>

      <div className="mt-4 rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-3 text-xs text-zinc-400">
        <span className="font-semibold text-zinc-200">Mentions and links are different.</span>{' '}
        A <span className="font-medium text-zinc-200">mention</span> is when AI says your name out loud in its answer.
        A <span className="font-medium text-zinc-200">link</span> is when AI lists your website as a source it used.
        AI can do either, both, or neither — that's why we track both.
      </div>

      {sc.queries.length > 0 && (
        <div className="mt-5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5">
          <p className="text-sm font-semibold text-zinc-100">Customer questions we tested</p>
          <p className="mt-1 text-xs text-zinc-500">These are the {sc.queries.length} {sc.queries.length === 1 ? 'question we asked' : 'questions we asked'} every AI tool. The numbers above measure how often you came up.</p>
          <ol className="mt-4 grid gap-2 sm:grid-cols-2">
            {sc.queries.map((q, i) => (
              <li key={i} className="flex items-start gap-3 rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-200">
                <span className="shrink-0 text-xs font-semibold tabular-nums text-zinc-500">{String(i + 1).padStart(2, '0')}</span>
                <span>"{q}"</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {sc.providerRates.length > 0 && (
        <div className="mt-5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5">
          <p className="text-sm font-semibold text-zinc-100">How often each AI tool links to your website</p>
          <p className="mt-1 text-xs text-zinc-500">Higher is better. Each bar shows the share of customer questions where the AI cited your site.</p>
          <div className="mt-4 space-y-3">
            {sc.providerRates.map(r => (
              <div key={r.provider} className="grid grid-cols-[120px_1fr_120px] items-center gap-3">
                <span className="text-sm text-zinc-300">{providerDisplayName(r.provider)}</span>
                <div className="h-3 overflow-hidden rounded-full bg-zinc-800/80">
                  <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${Math.max(r.citationRate, 1.5)}%` }} />
                </div>
                <span className="text-right text-sm font-semibold text-zinc-100">
                  {r.citationRate}% <span className="font-normal text-zinc-500">({r.citedCount}/{r.totalCount})</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.clientSummary.confidenceNotes.length > 0 && (
        <div className="mt-4 grid gap-2">
          {report.clientSummary.confidenceNotes.map((note, i) => (
            <div key={i} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-400">{note}</div>
          ))}
        </div>
      )}
    </section>
  )
}

function BigMetricTile({ label, value, subtitle }: { label: string; value: string; subtitle: string }) {
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-3 text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">{value}</p>
      <p className="mt-2 text-xs text-zinc-500">{subtitle}</p>
    </div>
  )
}

function clientHorizonLabel(horizon: ReportActionPlanItem['horizon']): string {
  switch (horizon) {
    case 'immediate': return 'Do now'
    case 'short-term': return 'This month'
    case 'medium-term': return 'Next quarter'
  }
}

function clientConfidenceLabel(confidence: ReportActionPlanItem['confidence']): string {
  switch (confidence) {
    case 'high': return 'Strong evidence'
    case 'medium': return 'Some evidence'
    case 'low': return 'Worth trying'
  }
}

function ActionPlanSection({ report, audience }: { report: ProjectReportDto; audience: ReportAudience }) {
  const rawActions = audience === 'client'
    ? report.clientSummary.actionItems
    : report.agencyDiagnostics.priorities.length > 0
      ? report.agencyDiagnostics.priorities
      : report.actionPlan.filter(a => actionAudienceMatches(a, audience))
  const actions = dedupeReportActions(report, rawActions)
  const isClient = audience === 'client'
  return (
    <section className="page-section-divider">
      <SectionHeading
        eyebrow={isClient ? 'Action plan' : 'Agency actions'}
        title={isClient ? 'What to do next' : 'Agency Action Plan'}
        subtitle={isClient ? 'Approve these in order. They are sorted by what will move the needle fastest.' : 'The highest-leverage work, sorted by urgency and evidence strength.'}
      />
      {actions.length === 0 ? (
        <EmptyHint message="No recommendations yet — run an AI check to populate this." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {actions.map((action, idx) => {
            const proof = action.evidence.length > 0 ? action.evidence : action.why
            const hasDetails = action.why.length > 0 || action.evidence.length > 0
            return (
              <article key={`${action.priority}-${action.title}`} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
                <div className="flex items-start gap-3">
                  <div
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-800/80 text-sm font-semibold text-zinc-100"
                    title="Priority — 1 will move the needle fastest"
                  >
                    {idx + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap gap-2">
                      <ToneBadge tone={reportActionTone(action)}>{isClient ? clientHorizonLabel(action.horizon) : reportHorizonLabel(action.horizon)}</ToneBadge>
                      {!isClient && <ToneBadge tone="neutral">{reportActionCategoryLabel(action.category)}</ToneBadge>}
                      <ToneBadge tone="neutral">{isClient ? clientConfidenceLabel(action.confidence) : `${reportConfidenceLabel(action.confidence)} confidence`}</ToneBadge>
                    </div>
                    <p className="text-sm font-medium text-zinc-100">{action.title}</p>
                  </div>
                </div>
                <p className="mt-3 text-sm text-zinc-400">{action.action}</p>
                <ProofChips items={proof} limit={3} className="mt-3" />
                {hasDetails && (
                  <details className="mt-3 text-xs text-zinc-400">
                    <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">{isClient ? 'See the data behind this' : 'Evidence details'}</summary>
                    {action.why.length > 0 && (
                      <div className="mt-2">
                        <p className="eyebrow-soft mb-1">{isClient ? 'Why this matters' : 'Why'}</p>
                        <ul className="list-disc space-y-1 pl-4">
                          {action.why.map((item, i) => <li key={i}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                    {action.evidence.length > 0 && (
                      <div className="mt-2">
                        <p className="eyebrow-soft mb-1">{isClient ? 'What we saw' : 'Evidence'}</p>
                        <ul className="list-disc space-y-1 pl-4">
                          {action.evidence.map((item, i) => <li key={i}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                  </details>
                )}
                <p className="mt-3 border-t border-zinc-800/60 pt-3 text-xs text-zinc-300">
                  <span className="font-medium">{isClient ? 'What success looks like:' : 'Win condition:'}</span> {action.successMetric}
                </p>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function AgencyDiagnosticsSection({ report }: { report: ProjectReportDto }) {
  const diagnostics = report.agencyDiagnostics.diagnostics.filter(d => d.title !== 'Location caveat')
  if (diagnostics.length === 0) return null
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Agency diagnostics" title="Technical Diagnostics" subtitle="Fast-read operator flags behind the action plan." />
      <div className="grid gap-3 lg:grid-cols-2">
        {diagnostics.map(d => (
          <div key={d.title} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
            <div className="mb-2 flex items-center gap-2">
              <ToneBadge tone={d.severity}>{d.severity}</ToneBadge>
              <p className="text-sm font-medium text-zinc-100">{d.title}</p>
            </div>
            <p className="text-sm text-zinc-400">{d.detail}</p>
            <ProofChips items={d.evidence} limit={3} className="mt-3" />
          </div>
        ))}
      </div>
    </section>
  )
}

function HorizontalBarRow({ label, value, displayValue, max, barClass }: { label: string; value: number; displayValue: string; max: number; barClass: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, 1.5) : 0
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
      <div className="min-w-0">
        <p className="truncate text-zinc-300" title={label}>{label}</p>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-800/80">
          <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="whitespace-nowrap text-sm font-semibold text-zinc-100">{displayValue}</span>
    </div>
  )
}

function ClientEvidenceSection({ report }: { report: ProjectReportDto }) {
  const ai = report.aiSourceOrigin.topDomains.slice(0, 5)
  const gsc = report.gsc
  const indexing = report.indexingHealth
  const opportunities = dedupeReportOpportunities(report).slice(0, 5)

  const aiMax = ai.length > 0 ? Math.max(...ai.map(d => d.count)) : 0
  const gscMax = gsc ? Math.max(...gsc.topQueries.slice(0, 5).map(q => q.impressions), 1) : 0

  const hasAnything = ai.length > 0 || gsc !== null || indexing !== null || opportunities.length > 0

  return (
    <section className="page-section-divider">
      <SectionHeading
        eyebrow="What we based this on"
        title="The signals behind this plan"
        subtitle="The data behind the recommendations above. Switch to Agency for the full breakdowns."
      />
      {!hasAnything ? (
        <EmptyHint message="No supporting evidence yet — this fills in after the first AI check." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {ai.length > 0 && (
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5">
              <p className="text-sm font-semibold text-zinc-100">Where AI gets its answers</p>
              <p className="mt-1 text-xs text-zinc-500">The websites AI tools cited most often when answering customer questions about your industry.</p>
              <div className="mt-4 space-y-3">
                {ai.map(d => (
                  <HorizontalBarRow
                    key={d.domain}
                    label={d.domain + (d.isCompetitor ? ' (competitor)' : '')}
                    value={d.count}
                    displayValue={`${formatNumber(d.count)}×`}
                    max={aiMax}
                    barClass="bg-zinc-400/70"
                  />
                ))}
              </div>
            </div>
          )}
          {indexing && (
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5">
              <p className="text-sm font-semibold text-zinc-100">Pages Google can find on your site</p>
              <p className="mt-1 text-xs text-zinc-500">Google indexing your site increases the chances of it appearing in AI search (especially Gemini).</p>
              <p className={`mt-4 text-5xl font-bold tracking-tight ${indexing.indexedPct >= 90 ? 'text-emerald-400' : indexing.indexedPct >= 70 ? 'text-amber-400' : 'text-rose-400'}`}>
                {indexing.indexedPct}%
              </p>
              <p className="mt-1 text-xs text-zinc-500">{formatNumber(indexing.indexed)} of {formatNumber(indexing.total)} pages indexed</p>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-zinc-800/80">
                <div
                  className={`h-full rounded-full ${indexing.indexedPct >= 90 ? 'bg-emerald-500/70' : indexing.indexedPct >= 70 ? 'bg-amber-500/70' : 'bg-rose-500/70'}`}
                  style={{ width: `${Math.max(indexing.indexedPct, 1.5)}%` }}
                />
              </div>
              <p className="mt-3 text-xs text-zinc-400">
                <span className="font-medium text-zinc-200">{formatNumber(indexing.notIndexed)}</span> {indexing.notIndexed === 1 ? 'page is' : 'pages are'} not indexed yet.
              </p>
            </div>
          )}
          {gsc && (
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5">
              <p className="text-sm font-semibold text-zinc-100">What people search Google for</p>
              <p className="mt-1 text-xs text-zinc-500">
                You appeared in <span className="font-semibold text-zinc-200">{formatNumber(gsc.totalImpressions)}</span> Google searches and got <span className="font-semibold text-zinc-200">{formatNumber(gsc.totalClicks)}</span> {gsc.totalClicks === 1 ? 'click' : 'clicks'} this period.
              </p>
              {gsc.topQueries.length > 0 && (
                <div className="mt-4 space-y-3">
                  {gsc.topQueries.slice(0, 5).map(q => (
                    <HorizontalBarRow
                      key={q.query}
                      label={q.query}
                      value={q.impressions}
                      displayValue={`${formatNumber(q.impressions)} ${q.impressions === 1 ? 'search' : 'searches'}`}
                      max={gscMax}
                      barClass="bg-sky-500/70"
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {opportunities.length > 0 && (
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5">
              <p className="text-sm font-semibold text-zinc-100">Topics where you could improve</p>
              <p className="mt-1 text-xs text-zinc-500">Customer questions where better content on your site would help AI cite you.</p>
              <ul className="mt-4 space-y-2 text-sm text-zinc-300">
                {opportunities.map((o, i) => (
                  <li key={i} className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-3 py-2">
                    <p className="font-medium text-zinc-100">{o.query}</p>
                    <p className="mt-0.5 text-xs text-zinc-400">{contentActionLabel(o.action)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ─── Section: Executive summary ────────────────────────────────────────────

function ExecutiveSummarySection({ report }: { report: ProjectReportDto }) {
  const exec = report.executiveSummary
  const trendArrow = exec.trend === 'up' ? '↑ Up' : exec.trend === 'down' ? '↓ Down' : exec.trend === 'flat' ? '→ Flat' : '—'
  const queryNoun = exec.totalQueryCount === 1 ? 'query' : 'queries'
  const citedFragment = exec.totalQueryCount > 0
    ? `${exec.citedQueryCount}/${exec.totalQueryCount} ${queryNoun} cited`
    : 'no queries'
  const mentionedFragment = exec.totalQueryCount > 0
    ? `${exec.mentionedQueryCount}/${exec.totalQueryCount} ${queryNoun} mentioned`
    : 'no queries'
  const citationSuffix = `${trendArrow} · ${citedFragment} · ${exec.providerCount} provider${exec.providerCount === 1 ? '' : 's'}`
  const competitorSuffix = `${exec.competitorCount} competitor${exec.competitorCount === 1 ? '' : 's'} tracked`
  const headlineTitle = exec.totalQueryCount > 0
    ? `${exec.citedQueryCount} of ${exec.totalQueryCount} tracked ${queryNoun} cite ${report.meta.project.displayName}`
    : 'No AI citation data yet'
  const headlineSubtitle = exec.totalQueryCount > 0
    ? `${exec.citationRate}% citation coverage and ${exec.mentionRate}% mention coverage across ${exec.providerCount} provider${exec.providerCount === 1 ? '' : 's'}.`
    : 'Run a check to populate the first citation and mention baseline.'
  const priorityActions = report.agencyDiagnostics.priorities.length > 0
    ? report.agencyDiagnostics.priorities
    : report.actionPlan
  const actionCount = dedupeReportActions(report, priorityActions).length
  const dateRange = gscDateRange(report)
  return (
    <section className="page-section-divider">
      <SectionHeading
        eyebrow="Section 1"
        title="Executive Summary"
        subtitle="Citation = source list. Mention = answer text. They are independent signals."
      />
      <div className="mb-4 grid gap-3 lg:grid-cols-[2fr_3fr]">
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">Latest AI visibility check</p>
          <p className="mt-2 text-lg font-semibold tracking-tight text-zinc-100">{headlineTitle}</p>
          <p className="mt-2 text-sm text-zinc-400">{headlineSubtitle}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
            <p className="eyebrow-soft">Citation trend</p>
            <p className={`text-xl font-semibold tracking-tight ${
              exec.trend === 'up' ? 'text-emerald-400'
                : exec.trend === 'down' ? 'text-rose-400'
                : 'text-zinc-100'
            }`}>{trendArrow}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{citedFragment}</p>
          </div>
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
            <p className="eyebrow-soft">Mention coverage</p>
            <p className="text-xl font-semibold tracking-tight text-zinc-100">{exec.mentionRate}%</p>
            <p className="mt-1 text-[11px] text-zinc-500">{mentionedFragment}</p>
          </div>
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
            <p className="eyebrow-soft">Prioritized actions</p>
            <p className="text-xl font-semibold tracking-tight text-zinc-100">{formatNumber(actionCount)}</p>
            <p className="mt-1 text-[11px] text-zinc-500">Sorted for agency follow-up.</p>
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Citation rate" value={formatPercent(exec.citationRate, 0)} tone={trendTone(exec.trend)} subtitle={citationSuffix} />
        <Metric label="Mention rate" value={formatPercent(exec.mentionRate, 0)} subtitle={mentionedFragment} />
        <Metric label="Queries tracked" value={formatNumber(exec.queryCount)} subtitle={competitorSuffix} />
        {exec.gsc && (
          <Metric
            label="GSC clicks"
            value={formatNumber(exec.gsc.clicks)}
            subtitle={`${formatNumber(exec.gsc.impressions)} imp · ${formatRatio(exec.gsc.ctr)} CTR${dateRange ? ` · ${dateRange}` : ''}`}
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
      <LocationHandlingCard report={report} />
    </section>
  )
}

// ─── Section: What's Changed ───────────────────────────────────────────────

const WHATS_CHANGED_PERIOD_DAYS = 14

function deltaTone(direction: 'up' | 'down' | 'flat'): MetricTone {
  if (direction === 'up') return 'positive'
  if (direction === 'down') return 'negative'
  return 'neutral'
}

function deltaArrow(direction: 'up' | 'down' | 'flat'): string {
  if (direction === 'up') return '↑'
  if (direction === 'down') return '↓'
  return '→'
}

function RateDeltaTile({
  label,
  delta,
  unit,
}: {
  label: string
  delta: ProjectReportDto['whatsChanged']['citationRate']
  unit: '%' | 'count'
}) {
  if (!delta) {
    return (
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
        <p className="eyebrow-soft">{label}</p>
        <p className="text-2xl font-semibold tracking-tight text-zinc-500">—</p>
        <p className="mt-1 text-[11px] text-zinc-500">No prior data</p>
      </div>
    )
  }
  const valueSuffix = unit === '%' ? '%' : ''
  const sign = delta.deltaAbs > 0 ? '+' : ''
  const tone = deltaTone(delta.direction)
  const toneClass = tone === 'positive' ? 'text-emerald-400'
    : tone === 'negative' ? 'text-rose-400'
    : 'text-zinc-100'
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
      <p className="eyebrow-soft">{label}</p>
      <p className={`text-2xl font-semibold tracking-tight ${toneClass}`}>
        {delta.current}{valueSuffix} <span className="text-sm font-medium">{deltaArrow(delta.direction)}</span>
      </p>
      <p className="mt-1 text-[11px] text-zinc-500">
        {sign}{unit === '%' ? delta.deltaAbs.toFixed(1) : delta.deltaAbs}{valueSuffix} vs {delta.prior}{valueSuffix}
      </p>
    </div>
  )
}

function TrafficDeltaTile({
  label,
  delta,
  countLabel,
}: {
  label: string
  delta: ProjectReportDto['whatsChanged']['gscClicksDelta']
  countLabel: string
}) {
  if (!delta) {
    return (
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
        <p className="eyebrow-soft">{label}</p>
        <p className="text-2xl font-semibold tracking-tight text-zinc-500">—</p>
        <p className="mt-1 text-[11px] text-zinc-500">Not enough trend data</p>
      </div>
    )
  }
  const sign = delta.deltaAbs > 0 ? '+' : ''
  const tone = deltaTone(delta.direction)
  const toneClass = tone === 'positive' ? 'text-emerald-400'
    : tone === 'negative' ? 'text-rose-400'
    : 'text-zinc-100'
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
      <p className="eyebrow-soft">{label}</p>
      <p className={`text-2xl font-semibold tracking-tight ${toneClass}`}>
        {formatNumber(delta.current)} <span className="text-sm font-medium">{deltaArrow(delta.direction)}</span>
      </p>
      <p className="mt-1 text-[11px] text-zinc-500">
        {sign}{formatNumber(delta.deltaAbs)} {countLabel} vs prior {WHATS_CHANGED_PERIOD_DAYS} days
      </p>
    </div>
  )
}

function ProviderMovementsTable({
  movements,
  audience,
}: {
  movements: ProjectReportDto['whatsChanged']['providerMovements']
  audience: ReportAudience
}) {
  const meaningful = movements.filter(m => m.direction !== 'flat')
  if (meaningful.length === 0) return null
  const isClient = audience === 'client'
  return (
    <div className="mt-4">
      <p className="eyebrow mb-2">{isClient ? 'How each AI tool changed' : 'AI engine movements'}</p>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>{isClient ? 'AI tool' : 'Engine'}</th>
              <th>{isClient ? 'Was' : 'Prior'}</th>
              <th>{isClient ? 'Now' : 'Current'}</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {meaningful.map(m => {
              const sign = m.deltaAbs > 0 ? '+' : ''
              const tone = deltaTone(m.direction)
              const cellClass = tone === 'positive' ? 'text-emerald-400'
                : tone === 'negative' ? 'text-rose-400'
                : 'text-zinc-300'
              return (
                <tr key={m.provider}>
                  <td>{isClient ? providerDisplayName(m.provider) : m.provider}</td>
                  <td>{m.prior}%</td>
                  <td>{m.current}%</td>
                  <td className={cellClass}>
                    {sign}{m.deltaAbs.toFixed(1)}% {deltaArrow(m.direction)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function WinsLossesTable({
  insights,
  heading,
  emptyMessage,
  audience,
}: {
  insights: readonly ReportInsight[]
  heading: string
  emptyMessage: string
  audience: ReportAudience
}) {
  if (insights.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
        <p className="eyebrow mb-1">{heading}</p>
        <p className="text-xs text-zinc-500">{emptyMessage}</p>
      </div>
    )
  }
  const isClient = audience === 'client'
  return (
    <div className="mt-4">
      <p className="eyebrow mb-2">{heading}</p>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              {!isClient && <th>Severity</th>}
              <th>{isClient ? 'What changed' : 'Title'}</th>
              <th>{isClient ? 'Customer question' : 'Query'}</th>
              <th>{isClient ? 'AI tool' : 'Provider'}</th>
            </tr>
          </thead>
          <tbody>
            {insights.map(i => (
              <tr key={i.id}>
                {!isClient && (
                  <td>
                    <ToneBadge tone={SEVERITY_TONE[i.severity]}>{reportSeverityLabel(i.severity)}</ToneBadge>
                    {i.instanceCount > 1 && <span className="ml-2 text-[11px] text-zinc-500">×{i.instanceCount}</span>}
                  </td>
                )}
                <td className="evidence-query-cell">{i.title}{isClient && i.instanceCount > 1 && <span className="ml-2 text-[11px] text-zinc-500">×{i.instanceCount}</span>}</td>
                <td className="text-xs text-zinc-400">{i.query}</td>
                <td className="text-xs text-zinc-400">{isClient ? providerDisplayName(i.provider) : i.provider}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function WhatsChangedSection({ report, audience }: { report: ProjectReportDto; audience: ReportAudience }) {
  const w = report.whatsChanged
  const isClient = audience === 'client'
  const everythingEmpty = !w.enoughHistory
    && !w.gscClicksDelta
    && !w.aiReferralsDelta
    && w.wins.length === 0
    && w.regressions.length === 0
  const heading = (
    <SectionHeading
      eyebrow={isClient ? 'Since last check' : 'Section 2'}
      title={isClient ? "What's different since last check" : "What's Changed"}
      subtitle={isClient ? undefined : w.headline}
    />
  )
  if (everythingEmpty) {
    return (
      <section className="page-section-divider">
        {heading}
        <EmptyHint message={isClient ? 'No comparison yet — trends will appear after a few more checks.' : 'Trends will appear after a few more checks.'} />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      {heading}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <RateDeltaTile label={isClient ? 'AI links to your website' : 'Citation rate'} delta={w.citationRate} unit="%" />
        <RateDeltaTile label={isClient ? 'AI mentions your name' : 'Mention rate'} delta={w.mentionRate} unit="%" />
        <RateDeltaTile label={isClient ? 'Questions AI answered with you' : 'Cited queries'} delta={w.citedQueryCount} unit="count" />
        <TrafficDeltaTile label={isClient ? 'Visitors from Google' : 'GSC clicks'} delta={w.gscClicksDelta} countLabel={isClient ? 'visits' : 'clicks'} />
        <TrafficDeltaTile label={isClient ? 'Visitors from AI tools' : 'AI referral sessions'} delta={w.aiReferralsDelta} countLabel={isClient ? 'visits' : 'sessions'} />
      </div>
      <ProviderMovementsTable movements={w.providerMovements} audience={audience} />
      <WinsLossesTable insights={w.wins} heading={isClient ? 'What got better' : 'Wins'} emptyMessage={isClient ? 'No new wins this period.' : 'No new gains in the latest check.'} audience={audience} />
      <WinsLossesTable insights={w.regressions} heading={isClient ? 'What got worse' : 'Regressions'} emptyMessage={isClient ? 'Nothing got worse this period.' : 'No new regressions in the latest check.'} audience={audience} />
    </section>
  )
}

function LocationHandlingCard({ report }: { report: ProjectReportDto }) {
  const location = report.meta.location
  const handling = report.meta.providerLocationHandling
  if (!location && handling.length === 0) return null
  return (
    <div className="mt-5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
      <p className="eyebrow mb-2">Location handling</p>
      <p className="text-sm text-zinc-300">
        <span className="font-medium">Location for this run: </span>
        {location ? formatLocationLabel(location) : 'none — providers received the queries verbatim with no geographic hint.'}
        {location && location.otherConfiguredLabels.length > 0 && (
          <span className="text-zinc-500">
            {' '}— other configured locations ({location.otherConfiguredLabels.join(', ')}) need their own check to compare.
          </span>
        )}
      </p>
      {handling.length > 0 && (
        <div className="evidence-table-wrap mt-3">
          <table className="evidence-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Treatment</th>
                <th>How the location reached the model</th>
              </tr>
            </thead>
            <tbody>
              {handling.map(h => (
                <tr key={h.provider}>
                  <td>{h.provider}</td>
                  <td>
                    <ToneBadge tone={locationTreatmentTone(h.treatment)}>
                      {LOCATION_TREATMENT_LABEL[h.treatment]}
                    </ToneBadge>
                  </td>
                  <td className="text-zinc-400">{h.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
        <SectionHeading eyebrow="Section 3" title="Citation Scorecard" subtitle="Per-engine citation and mention coverage from the latest check." />
        <EmptyHint message="No completed answer-visibility runs yet." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 3" title="Citation Scorecard" subtitle="Per-engine citation and mention coverage from the latest check." />
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
      <p className="mb-2 text-[11px] text-zinc-500">
        Each cell shows two flags —{' '}
        <span className="font-mono text-emerald-300">C</span>/
        <span className="font-mono text-zinc-500">c</span> = cited / not cited (your domain in the source list),{' '}
        <span className="font-mono text-emerald-300">M</span>/
        <span className="font-mono text-zinc-500">m</span> = mentioned / not mentioned (your brand in the answer text),{' '}
        <span className="font-mono text-zinc-700">–</span> = no data.
      </p>
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
                      <CitedMentionedGlyphs cell={cell} />
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
        <SectionHeading eyebrow="Section 4" title="Competitor Landscape" subtitle="Who AI engines cite and mention instead of the client." />
        <EmptyHint message="No competitor data yet. Add competitors and run a check." />
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
      <SectionHeading eyebrow="Section 4" title="Competitor Landscape" subtitle="Who AI engines cite and mention instead of the client." />
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
        <SectionHeading eyebrow="Section 5" title="AI Citation Sources" subtitle="External domains AI engines cited most in the latest check." />
        <EmptyHint message="No source data yet. Run a check first." />
      </section>
    )
  }
  const totalCitations = so.categories.reduce((s, c) => s + c.count, 0)
  const competitor = so.categories.find(c => c.category === 'competitor')
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 5" title="AI Citation Sources" subtitle="External domains AI engines cited most in the latest check." />
      {competitor && (
        <p className="mb-3 text-sm text-zinc-300">
          <span className="font-semibold">{competitor.sharePct}%</span> of citations went to tracked competitors ({competitor.count} of {totalCitations}).
        </p>
      )}
      {so.topDomains.length > 0 && (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
          <p className="eyebrow mb-3">Top sources</p>
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
                        ? <ToneBadge tone="negative">Tracked competitor</ToneBadge>
                        : <ToneBadge tone="neutral">External</ToneBadge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {so.categories.length > 0 && (
        <div className="mt-4">
          <ShareBars
            heading="By source type"
            rows={so.categories.map(c => {
              const tone = c.category === 'competitor'
                ? '#f43f5e'
                : c.category === 'directory' || c.category === 'forum'
                  ? '#f59e0b'
                  : '#3b82f6'
              return { label: c.label, count: c.count, sharePct: c.sharePct, color: tone }
            })}
            countLabel="citations"
          />
        </div>
      )}
    </section>
  )
}

// ─── Section: GSC performance ──────────────────────────────────────────────

function gscDateRange(report: ProjectReportDto): string {
  const summary = report.executiveSummary.gsc
  const gsc = report.gsc
  const start = summary?.periodStart || gsc?.periodStart || gsc?.trend[0]?.date || ''
  const end = summary?.periodEnd || gsc?.periodEnd || gsc?.trend.at(-1)?.date || ''
  if (!start && !end) return ''
  if (start && end) return `${formatDate(start)} → ${formatDate(end)}`
  return formatDate(start || end)
}

function GscPerformanceSection({ report }: { report: ProjectReportDto }) {
  const gsc = report.gsc
  if (!gsc) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 6" title="GSC Performance" subtitle="Search demand signals to compare against AI visibility." />
        <EmptyHint message="Google Search Console is not connected for this project." />
      </section>
    )
  }
  const dateRange = gscDateRange(report)
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 6" title="GSC Performance" subtitle={`Search demand signals to compare against AI visibility${dateRange ? ` for ${dateRange}` : ''}.`} />
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
          <ShareBars
            heading="Search demand by intent"
            rows={gsc.categoryBreakdown.map((c, i) => ({
              label: c.category,
              count: c.clicks,
              sharePct: c.sharePct,
              color: CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length],
            }))}
            countLabel="clicks"
          />
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
              <th>Clicks</th>
              <th>Imp.</th>
              <th>CTR</th>
              <th>Pos.</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.query}>
                <td className="evidence-query-cell">{r.query}</td>
                <td>{formatNumber(r.clicks)}</td>
                <td>{formatNumber(r.impressions)}</td>
                <td>{formatRatio(r.ctr)}</td>
                <td>{r.avgPosition.toFixed(1)}</td>
                <td><ToneBadge tone="neutral">{r.category}</ToneBadge></td>
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
        <SectionHeading eyebrow="Section 7" title="GA4 Traffic" subtitle="Site traffic from the connected Google Analytics 4 property." />
        <EmptyHint message="Google Analytics 4 is not connected for this project." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 7" title="GA4 Traffic" subtitle={`Site traffic from ${formatDate(ga.periodStart)} to ${formatDate(ga.periodEnd)}.`} />
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
                {ga.topLandingPages.map(p => (
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
          <ShareBars
            heading="Channel mix"
            rows={ga.channelBreakdown.map((c, i) => ({
              label: c.channel,
              count: c.sessions,
              sharePct: c.sharePct,
              color: CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length],
            }))}
            countLabel="sessions"
          />
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
        <SectionHeading eyebrow="Section 8" title="Social Referrals" subtitle="Social traffic split by channel and campaign." />
        <EmptyHint message="No social referral data." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 8" title="Social Referrals" subtitle="Social traffic split by channel and campaign." />
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Total sessions" value={formatNumber(sr.totalSessions)} />
        <Metric label="Organic" value={formatNumber(sr.organicSessions)} />
        <Metric label="Paid" value={formatNumber(sr.paidSessions)} />
      </div>
      {sr.channels.length > 0 && (
        <div className="mt-4">
          <ShareBars
            heading="Social channel mix"
            rows={sr.channels.map((c, i) => ({
              label: c.channelGroup,
              count: c.sessions,
              sharePct: c.sharePct,
              color: CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length],
            }))}
            countLabel="sessions"
          />
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
        <SectionHeading eyebrow="Section 9" title="AI Referral Traffic" subtitle="Traffic arriving from AI answer engines." />
        <EmptyHint message="No AI referral data." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 9" title="AI Referral Traffic" subtitle="Traffic arriving from AI answer engines." />
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
          <ShareBars
            heading="AI sessions by source"
            rows={ai.bySource.map((s, i) => ({
              label: s.source,
              count: s.sessions,
              sharePct: s.sharePct,
              color: CHART_SERIES_COLORS[(i + 2) % CHART_SERIES_COLORS.length],
            }))}
            countLabel="sessions"
          />
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
        <SectionHeading eyebrow="Section 11" title="Indexing Health" subtitle="Connect Google Search Console or Bing Webmaster Tools to populate this section." />
        <EmptyHint message="No indexing data — connect Google Search Console or Bing Webmaster Tools." />
      </section>
    )
  }
  const indexingSubtitle = `Pages absent from ${ih.provider === 'google' ? 'Google' : 'Bing'} are harder for AI engines to retrieve.`
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 11" title="Indexing Health" subtitle={indexingSubtitle} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Indexed" value={formatNumber(ih.indexed)} tone="positive" />
        <Metric label="Total inspected" value={formatNumber(ih.total)} />
        <Metric label="Indexed share" value={`${ih.indexedPct}%`} />
      </div>
      <CoverageBreakdown ih={ih} />
    </section>
  )
}

function CoverageBreakdown({ ih }: { ih: IndexingHealthSection }) {
  const segments = [
    { label: 'Indexed', count: ih.indexed, color: '#10b981' },
    { label: 'Not indexed', count: ih.notIndexed, color: '#f59e0b' },
    { label: 'Deindexed', count: ih.deindexed, color: '#f43f5e' },
    { label: 'Unknown', count: ih.unknown, color: '#71717a' },
  ].filter(s => s.count > 0)
  const total = segments.reduce((s, x) => s + x.count, 0) || 1
  if (segments.length === 0) return null
  return (
    <div className="mt-4 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
      <p className="eyebrow mb-3">Coverage breakdown</p>
      <div className="flex h-7 w-full overflow-hidden rounded-md">
        {segments.map(s => (
          <div
            key={s.label}
            style={{ width: `${(s.count / total) * 100}%`, background: s.color }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-400">
        {segments.map(s => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
            <span className="text-zinc-300">{s.label}:</span>
            <span className="tabular-nums text-zinc-100">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Section: Citations trend ──────────────────────────────────────────────

function CitationsTrendSection({ report }: { report: ProjectReportDto }) {
  const trend = report.citationsTrend
  if (trend.length === 0) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 12" title="Citations Over Time" subtitle="Citation coverage across recent checks." />
        <EmptyHint message="Run multiple checks to see a trend." />
      </section>
    )
  }
  if (isTrendBaseline(trend)) {
    return (
      <section className="page-section-divider">
        <SectionHeading eyebrow="Section 12" title="Citations Over Time" subtitle="Citation coverage across recent checks." />
        <EmptyHint message={`Building baseline (${trend.length} of ${MIN_TREND_POINTS} checks completed). Trend will appear once more checks are recorded.`} />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 12" title="Citations Over Time" subtitle="Citation coverage across recent checks." />
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
      <p className="eyebrow mb-2">Check-by-check breakdown</p>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Check</th>
              <th>Cited queries</th>
              <th>Per-engine rates</th>
            </tr>
          </thead>
          <tbody>
            {trend.map(t => (
              <tr key={t.runId}>
                <td className="evidence-query-cell">{formatDate(t.date)}</td>
                <td>
                  {t.citationRate}% <span className="text-zinc-500">({t.citedQueryCount}/{t.totalQueryCount})</span>
                </td>
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
        <SectionHeading eyebrow="Section 13" title="Insights &amp; Alerts" subtitle="Regressions, gains, and recurring alerts ordered by severity." />
        <EmptyHint message="No active insights — everything looks stable." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 13" title="Insights &amp; Alerts" subtitle="Regressions, gains, and recurring alerts ordered by severity." />
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
                  <ToneBadge tone={SEVERITY_TONE[i.severity]}>{reportSeverityLabel(i.severity)}</ToneBadge>
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
  const opps = dedupeReportOpportunities(report)
  if (opps.length === 0) return null
  const canonical = report.meta.project.canonicalDomain
  const highlights = opps.slice(0, 3)
  return (
    <section className="page-section-divider">
      <SectionHeading
        eyebrow="Section 14"
        title="Content Opportunities"
        subtitle="Queries where content work has the clearest path to more AI citations. Opportunity score is 0–100, higher = stronger."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {highlights.map(o => (
          <article key={o.targetRef} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
            <div className="text-2xl font-semibold tracking-tight text-zinc-100" title="Opportunity score (0–100, higher = stronger)">
              {Math.round(o.score)}
              <span className="ml-0.5 text-sm font-normal text-zinc-500">/100</span>
            </div>
            <p className="mt-2 text-sm font-medium text-zinc-100">{o.query}</p>
            <p className="mt-1 text-xs text-zinc-500">
              {contentActionLabel(o.action)} · {actionConfidenceLabel(o.actionConfidence)} confidence
            </p>
            <ProofChips items={o.drivers} limit={2} className="mt-3" />
          </article>
        ))}
      </div>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Action</th>
              <th title="Opportunity score (0–100)">Score</th>
              <th>Why</th>
              <th>Our page</th>
              <th>Winning competitor</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {opps.slice(0, 10).map(o => (
              <tr key={o.targetRef}>
                <td className="evidence-query-cell">{o.query}</td>
                <td><ToneBadge tone="neutral">{contentActionLabel(o.action)}</ToneBadge></td>
                <td title="Opportunity score (0–100)">{Math.round(o.score)}</td>
                <td className="text-xs text-zinc-400">
                  {o.drivers.length > 0
                    ? <ul className="list-disc pl-4 space-y-0.5">{o.drivers.map((d, i) => <li key={i}>{d}</li>)}</ul>
                    : <span className="text-zinc-600">No driver signal yet</span>}
                </td>
                <td className="text-xs">
                  {o.ourBestPage
                    ? <a href={absolutizeProjectUrl(o.ourBestPage.url, canonical)} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{o.ourBestPage.url}</a>
                    : <span className="text-zinc-600">No page yet</span>}
                </td>
                <td className="text-xs">
                  {o.winningCompetitor
                    ? <a href={o.winningCompetitor.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{o.winningCompetitor.domain}</a>
                    : <span className="text-zinc-600">—</span>}
                </td>
                <td><ToneBadge tone="neutral">{actionConfidenceLabel(o.actionConfidence)}</ToneBadge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ContentGapsSection({ report }: { report: ProjectReportDto }) {
  if (report.contentGaps.length === 0) return null
  return (
    <section className="page-section-divider">
      <SectionHeading
        eyebrow="Section 15"
        title="Content Gaps"
        subtitle="Tracked queries where competitors are cited and the client is missing."
      />
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Competitors cited</th>
              <th>Domains</th>
              <th>Miss rate</th>
            </tr>
          </thead>
          <tbody>
            {report.contentGaps.slice(0, 10).map(g => {
              const visible = g.competitorDomains.slice(0, 5)
              const more = g.competitorDomains.length - visible.length
              return (
                <tr key={g.query}>
                  <td className="evidence-query-cell">{g.query}</td>
                  <td>{g.competitorCount}</td>
                  <td className="text-xs text-zinc-400">
                    {visible.join(', ')}{more > 0 ? `, +${more} more` : ''}
                  </td>
                  <td>{Math.round(g.missRate * 100)}%</td>
                </tr>
              )
            })}
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
        <SectionHeading eyebrow="Section 16" title="Recommended Next Steps" subtitle="Action items bucketed by timing." />
        <EmptyHint message="No prioritized actions yet." />
      </section>
    )
  }
  return (
    <section className="page-section-divider">
      <SectionHeading eyebrow="Section 16" title="Recommended Next Steps" subtitle="Action items bucketed by timing." />
      <div className="space-y-2">
        {report.recommendedNextSteps.map((s, i) => (
          <div key={i} className="flex items-start gap-3 rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2.5">
            <span className="shrink-0 rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-0.5 text-[11px] uppercase tracking-wide text-zinc-400">
              {reportHorizonLabel(s.horizon)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-zinc-100">{s.title}</p>
              <p className="text-xs text-zinc-500">{s.rationale}</p>
            </div>
          </div>
        ))}
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

function ProofChips({ items, limit = 3, className }: { items: readonly string[]; limit?: number; className?: string }) {
  if (items.length === 0) return null
  const visible = items.slice(0, limit)
  const more = items.length - visible.length
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ''}`}>
      {visible.map((item, i) => (
        <span key={i} className="rounded-md border border-zinc-800/60 bg-zinc-900/40 px-2 py-0.5 text-[11px] text-zinc-300">
          {item}
        </span>
      ))}
      {more > 0 && (
        <span className="rounded-md border border-zinc-800/60 bg-zinc-900/40 px-2 py-0.5 text-[11px] text-zinc-400">
          +{more} more
        </span>
      )}
    </div>
  )
}

function ShareBars({
  heading,
  rows,
  countLabel,
}: {
  heading: string
  rows: ReadonlyArray<{ label: string; count: number; sharePct: number; color?: string }>
  countLabel: string
}) {
  const visible = rows.filter(r => r.count > 0 || r.sharePct > 0)
  if (visible.length === 0) return null
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
      <p className="eyebrow mb-3">{heading}</p>
      <div className="space-y-2">
        {visible.map((r, i) => {
          const pct = Math.max(0, Math.min(100, r.sharePct))
          const color = r.color ?? CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length]
          return (
            <div key={r.label} className="grid grid-cols-[160px_1fr_auto] items-center gap-3">
              <div className="truncate text-xs text-zinc-400">{r.label}</div>
              <div className="h-2 rounded-sm bg-zinc-800">
                <div className="h-full rounded-sm" style={{ width: `${pct.toFixed(1)}%`, background: color }} />
              </div>
              <div className="text-right text-xs tabular-nums text-zinc-200">
                {formatNumber(r.count)} <span className="text-zinc-500">{countLabel} · {r.sharePct}%</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EmptyHint({ message }: { message: string }) {
  return <p className="text-sm text-zinc-500 py-4 text-center">{message}</p>
}
