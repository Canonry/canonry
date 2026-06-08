import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import type {
  ProjectReportDto,
  ReportActionPlanItem,
  ReportAudience,
  ReportInsight,
} from '@ainyc/canonry-contracts'
import {
  contentActionLabel,
  dedupeReportActions,
  dedupeReportOpportunities,
  deltaPercent,
  formatDeltaCopy,
  reportActionCategoryLabel,
  reportActionTone,
  reportConfidenceLabel,
  reportHorizonLabel,
  reportSeverityLabel,
} from '@ainyc/canonry-contracts'

import { ToneBadge } from '../components/shared/ToneBadge.js'
import { Button } from '../components/ui/button.js'
import { downloadReportHtml, heyClient, ApiError } from '../api.js'
import { getApiV1ProjectsByNameReportOptions } from '@ainyc/canonry-api-client/react-query'
import { asyncHandler } from '../lib/async-handler.js'
import { useDismissContentTarget } from '../queries/mutations.js'
import { addToast } from '../lib/toast-store.js'
import type { MetricTone } from '../view-models.js'


const SEVERITY_TONE: Record<ReportInsight['severity'], MetricTone> = {
  critical: 'negative',
  high: 'negative',
  medium: 'caution',
  low: 'neutral',
}


function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}


function formatLocationLabel(location: NonNullable<ProjectReportDto['meta']['location']>): string {
  const place = [location.city, location.region, location.country].filter(Boolean).join(', ')
  return place ? `${location.label} (${place})` : location.label
}



// severityLabel / horizonLabel / actionLabel moved to @ainyc/canonry-contracts
// (`reportSeverityLabel`, `reportHorizonLabel`, `contentActionLabel`) so the
// HTML report renderer and the web dashboard can't drift on what users see.



export function ReportPage({ projectName }: { projectName: string }) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const reportQuery = useQuery(
    getApiV1ProjectsByNameReportOptions({ client: heyClient, path: { name: projectName } }),
  )

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
            onClick={asyncHandler(handleDownload)}
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
      <ActionPlanSection report={report} audience="client" projectName={projectName} />
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

  const crawlerRequests = {
    current: sa.verifiedCrawlerHits.current + sa.unverifiedCrawlerHits.current,
    prior: sa.verifiedCrawlerHits.prior + sa.unverifiedCrawlerHits.prior,
    deltaPct: deltaPercent(
      sa.verifiedCrawlerHits.current + sa.unverifiedCrawlerHits.current,
      sa.verifiedCrawlerHits.prior + sa.unverifiedCrawlerHits.prior,
    ),
  }
  const crawlerDelta = formatDeltaCopy(crawlerRequests, 'requests')
  const crawlerSubtitle = `${formatNumber(sa.verifiedCrawlerHits.current)} verified · ${formatNumber(sa.unverifiedCrawlerHits.current)} unverified${crawlerDelta ? ` · ${crawlerDelta}` : ''}`
  const userFetchDelta = formatDeltaCopy(sa.aiUserFetchHits, 'requests')
  const referralDelta = formatDeltaCopy(sa.referralArrivals, 'sessions')
  // For the client view we cap at the top 5 entries — agencies see the full breakdown in the HTML report.
  const topOperators = sa.byOperator
    .filter(o => o.verifiedHits > 0 || o.unverifiedHits > 0 || o.userFetchHits > 0 || o.referralArrivals > 0)
    .slice(0, 5)

  return (
    <section className="page-section-divider">
      <SectionHeading
        eyebrow={SERVER_ACTIVITY_EYEBROW_CLIENT}
        title={SERVER_ACTIVITY_TITLE}
        subtitle={SERVER_ACTIVITY_INTRO_HAS_DATA}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="AI bot requests observed"
          value={formatNumber(crawlerRequests.current)}
          subtitle={crawlerSubtitle}
        />
        <Metric
          label="AI user-fetch requests"
          value={formatNumber(sa.aiUserFetchHits.current)}
          subtitle={userFetchDelta || 'ChatGPT-User, Perplexity-User, MistralAI-User'}
        />
        <Metric
          label="AI referral sessions"
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
                  <th>Bot requests (7d)</th>
                  <th>User fetches (7d)</th>
                  <th>Referral sessions</th>
                </tr>
              </thead>
              <tbody>
                {topOperators.map(o => (
                  <tr key={o.operator}>
                    <td className="evidence-query-cell">{o.operator}</td>
                    <td>{formatNumber(o.verifiedHits + o.unverifiedHits)}</td>
                    <td>{formatNumber(o.userFetchHits)}</td>
                    <td>{formatNumber(o.referralArrivals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Bot requests are bulk crawl (GPTBot, PerplexityBot, …). User fetches are on-demand reads triggered by real users inside an AI surface (ChatGPT-User, Perplexity-User, …). Verified means the request came from an IP the operator publishes as its own; unverified means the user-agent matched but the IP is not in a published range. User-fetch totals count both, since many genuine user fetches come from outside any published range.
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
  // When `window` is ≥ 2, the prior/current values are rolling averages,
  // not single-check snapshots — say so explicitly so the reader knows
  // the number isn't twitchy.
  const window = delta.window ?? 1
  const compare = window >= 2 ? `vs prior ${window} checks (avg ${delta.prior}%)` : `since last check (was ${delta.prior}%)`
  if (delta.direction === 'up') {
    return { text: `Up ${delta.deltaAbs.toFixed(1)} points ${compare}`, tone: 'positive', arrow: '↑' }
  }
  if (delta.direction === 'down') {
    return { text: `Down ${Math.abs(delta.deltaAbs).toFixed(1)} points ${compare}`, tone: 'negative', arrow: '↓' }
  }
  const steadyCompare = window >= 2 ? `vs prior ${window} checks (avg ${delta.prior}%)` : `since last check (was ${delta.prior}%)`
  return { text: `Holding steady ${steadyCompare}`, tone: 'neutral', arrow: '→' }
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

function ActionPlanSection({ report, audience, projectName }: { report: ProjectReportDto; audience: ReportAudience; projectName: string }) {
  const rawActions = audience === 'client'
    ? report.clientSummary.actionItems
    : report.agencyDiagnostics.priorities.length > 0
      ? report.agencyDiagnostics.priorities
      : report.actionPlan.filter(a => actionAudienceMatches(a, audience))
  const dedupedActions = dedupeReportActions(report, rawActions)
  const isClient = audience === 'client'
  const dismissMutation = useDismissContentTarget()
  // Optimistic dismissals: a targetRef in this set is rendered as "gone"
  // immediately on click, before the server confirms. The mutation
  // invalidates the report query on success; once the refetch returns
  // without the row, the natural unmount removes the entry. On error we
  // remove from the set so the card re-appears with a toast.
  //
  // This set is the source of truth for "what the user thinks they
  // dismissed" — the actual server state is whatever the next report
  // refetch returns. They converge after a successful round-trip.
  const [optimisticDismissed, setOptimisticDismissed] = useState<Set<string>>(new Set())
  // Filter dedupedActions through the optimistic set so the UI updates
  // instantly. Server-side filter still applies on the next refetch;
  // this is purely a render-time bypass to remove perceived latency.
  const actions = optimisticDismissed.size > 0
    ? dedupedActions.filter(a => !a.targetRef || !optimisticDismissed.has(a.targetRef))
    : dedupedActions

  const handleDismiss = (action: ProjectReportDto['actionPlan'][number]) => {
    if (!action.targetRef) return
    const ref = action.targetRef
    // No `window.confirm` — single-click dismissal with optimistic UI is
    // the right primitive here. The action is reversible via `DELETE
    // /content/dismissals/:targetRef` (and a future "Dismissed" panel),
    // so the friction of a confirm dialog outweighs the misclick risk.
    // Toast confirms the dismissal landed and gives the user a chance to
    // notice if it was unintentional.
    setOptimisticDismissed(prev => new Set(prev).add(ref))
    dismissMutation.mutate(
      { projectName, body: { targetRef: ref } },
      {
        onSuccess: () => {
          addToast({
            tone: 'positive',
            title: `Dismissed "${action.title}"`,
            detail: 'Will not appear in future reports until un-dismissed.',
          })
          // Don't clear optimisticDismissed here — the mutation
          // invalidates the report query, the row drops out of
          // `dedupedActions` on refetch, and the natural unmount makes
          // the optimistic entry redundant (filter is a no-op on a row
          // that isn't there). We clear on error so the user can retry.
        },
        onError: (err) => {
          addToast({
            tone: 'negative',
            title: `Couldn't dismiss "${action.title}"`,
            detail: String(err),
          })
          setOptimisticDismissed(prev => {
            const next = new Set(prev)
            next.delete(ref)
            return next
          })
        },
      },
    )
  }
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
                {action.targetRef && (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => handleDismiss(action)}
                      className="rounded-md border border-zinc-700/60 bg-zinc-900/50 px-2.5 py-1 text-[11px] font-medium text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-100"
                      title="Stop showing this recommendation. The page-detection logic relies on GSC/GA syncs that lag by days — if you've already addressed it, dismissing keeps the report current."
                    >
                      Mark addressed
                    </button>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
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
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-zinc-400">
                      {contentActionLabel(o.action)}
                      {o.winnabilityClass === 'ceded' && <ToneBadge tone="caution">Ceded surface</ToneBadge>}
                    </p>
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

function EmptyHint({ message }: { message: string }) {
  return <p className="text-sm text-zinc-500 py-4 text-center">{message}</p>
}
