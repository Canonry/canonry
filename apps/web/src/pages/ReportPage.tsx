import { ReportVisibilitySummary } from '../components/project/ReportVisibilitySummary.js'
import { reportVisibilityLocationLabel, shareOfVoiceReason, shareOfVoiceSummary } from '@ainyc/canonry-contracts'
import { useState, type JSX, type ReactNode } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import type {
  ProjectReportDto,
  ReportAudience,
  ReportInsight,
  ReportPeriodDays,
  ReportSectionId,
} from '@ainyc/canonry-contracts'
import {
  contentActionLabel,
  dedupeReportOpportunities,
  deltaPercent,
  describeLandingPage,
  formatDate,
  formatDeltaCopy,
  formatNumber,
  formatWindowCountDelta,
  REPORT_DEFAULT_PERIOD_DAYS,
  REPORT_HEADER_COPY,
  REPORT_PERIOD_OPTIONS,
  REPORT_SECTION_COPY,
  reportActionCategoryLabel,
  reportActionConfidenceBadge,
  reportActionHorizonBadge,
  reportActionTone,
  reportAudienceActions,
  reportBarChartLabel,
  reportClientCitedSubtitle,
  reportClientClicksNoun,
  reportClientHeroSentence,
  reportClientIndexedPages,
  reportClientIndexingTone,
  reportClientMentionedSubtitle,
  reportClientNotIndexedTail,
  reportClientProvidersSubtitle,
  reportClientQueriesSubtitle,
  reportClientSearchCount,
  reportClientSourceCount,
  reportClientTrendCopy,
  reportCrawlerTrustSummary,
  reportDeltaArrow,
  reportDirectionTone,
  reportHeaderMarketLabel,
  reportHeaderPeriodLabel,
  reportInstanceCountLabel,
  reportLineChartLabel,
  reportMovementChangeCopy,
  reportPriorWindowLabel,
  reportProviderDisplayName,
  reportRateDeltaCopy,
  reportReferralRedirectNote,
  ReportSectionIds,
  reportSectionOrder,
  reportServerActivityClientOperatorHeaders,
  reportServerActivityHeading,
  reportSeverityLabel,
  reportSeverityTone,
  safeLinkHref,
} from '@ainyc/canonry-contracts'

import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import {
  Bar,
  BarChart,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_NEUTRAL,
  CHART_SERIES_COLORS,
  CHART_TONE,
  Cell,
  formatChartDateLabel,
  formatChartDateTick,
  formatObservedInstantLabel,
  formatObservedInstantTick,
  LabelList,
  MultiAxisTrendChart,
  observedInstant,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from '../components/shared/ChartPrimitives.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { Button } from '../components/ui/button.js'
import { downloadReportHtml, heyClient, isEmbed, ApiError } from '../api.js'
import { getApiV1ProjectsByNameReportOptions } from '@ainyc/canonry-api-client/react-query'
import { asyncHandler } from '../lib/async-handler.js'
import { useDismissContentTarget } from '../queries/mutations.js'
import { addToast } from '../lib/toast-store.js'
import type { MetricTone } from '../view-models.js'

// Each agency report slice adds its imports inside its own slot below, so
// parallel branches merge without touching each other's lines. Do not import a
// name again that the imports above already bring in.

// ── report slice S1 imports: agency overview ──
// ── end report slice S1 imports ──

// ── report slice S2 imports: competitive evidence ──
// ── end report slice S2 imports ──

// ── report slice S3 imports: search and traffic ──
// ── end report slice S3 imports ──

// ── report slice S4 imports: server-side, indexing and trend ──
// ── end report slice S4 imports ──

// ── report slice S5 imports: insights and content ──
// ── end report slice S5 imports ──

/*
 * The in-app report and the downloadable HTML report
 * (packages/api-routes/src/report-renderer.ts) render the same DTO. Section
 * order comes from `reportSectionOrder` and every visible string from
 * REPORT_SECTION_COPY, both in @ainyc/canonry-contracts. The `data-report-*`
 * attributes are the outline hooks apps/web/test/report-outline.ts reads to
 * hold this page to the HTML report's committed outline goldens.
 */

/** Accessible name of the audience toggle. */
export const REPORT_AUDIENCE_TOGGLE_LABEL = 'Report audience'

/** Visible labels of the audience toggle options. */
export const REPORT_AUDIENCE_LABELS: Readonly<Record<ReportAudience, string>> = {
  client: 'Client',
  agency: 'Agency',
}

/** The toggle's options, in the order it shows them. The page opens on the first. */
const REPORT_AUDIENCE_OPTIONS: readonly ReportAudience[] = ['client', 'agency']

const TONE_TEXT_CLASS: Readonly<Record<MetricTone, string>> = {
  positive: 'text-positive-400',
  caution: 'text-caution-400',
  negative: 'text-negative-400',
  neutral: 'text-heading',
}

const TONE_BAR_CLASS: Readonly<Record<MetricTone, string>> = {
  positive: 'bg-positive-500/70',
  caution: 'bg-caution-500/70',
  negative: 'bg-negative-500/70',
  neutral: 'bg-mono-500/70',
}

export function ReportPage({ projectName }: { projectName: string }) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [period, setPeriod] = useState<ReportPeriodDays>(REPORT_DEFAULT_PERIOD_DAYS)
  const [selectedAudience, setSelectedAudience] = useState<ReportAudience>('client')
  // A read-only embed shows only the client report: no toggle, and the
  // download is the client file too.
  const embedded = isEmbed()
  const audience: ReportAudience = embedded ? 'client' : selectedAudience

  const reportQuery = useQuery({
    ...getApiV1ProjectsByNameReportOptions({ client: heyClient, path: { name: projectName }, query: { period } }),
    // Keep the current report on screen while a new period loads so the
    // toggle and content don't flash to a full-page skeleton on every switch.
    placeholderData: keepPreviousData,
  })

  async function handleDownload() {
    setDownloading(true)
    setDownloadError(null)
    try {
      await downloadReportHtml(projectName, audience, period)
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Download failed'
      setDownloadError(message)
    } finally {
      setDownloading(false)
    }
  }

  if (reportQuery.isLoading) {
    return <p className="text-sm text-muted py-8 text-center">Loading report…</p>
  }
  if (reportQuery.error) {
    const message = reportQuery.error instanceof Error ? reportQuery.error.message : 'Failed to load report'
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-negative-400">{message}</p>
      </div>
    )
  }
  const report = reportQuery.data
  if (!report) return null

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <p className="eyebrow">{REPORT_HEADER_COPY.eyebrow}</p>
          <h1 className="page-title">{report.meta.project.displayName}</h1>
          <p className="page-subtitle">
            {report.meta.project.canonicalDomain} · {report.meta.project.country} / {report.meta.project.language.toUpperCase()}
            {' · '}{report.visibility?.selection.mode === 'advanced' ? reportVisibilityLocationLabel(report.visibility) : reportHeaderMarketLabel(report.meta.location)}
            {' · '}{reportHeaderPeriodLabel(report.meta.periodDays)}
            {' · '}{REPORT_HEADER_COPY.generated} {formatDate(report.meta.generatedAt)}
          </p>
          {downloadError && <p className="mt-2 text-xs text-negative-400">{downloadError}</p>}
        </div>
        <div className="page-header-right flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!embedded && <AudienceToggle audience={audience} onChange={setSelectedAudience} />}
            <PeriodToggle period={period} onChange={setPeriod} />
          </div>
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

      {reportSectionOrder(report, audience).map(id => (
        <ReportSectionSlot key={id} id={id} report={report} audience={audience} projectName={projectName} />
      ))}
    </div>
  )
}

/** Client or agency view of the same report. The download follows the choice. */
function AudienceToggle({
  audience,
  onChange,
}: {
  audience: ReportAudience
  onChange: (audience: ReportAudience) => void
}) {
  return (
    <div className="segmented" role="group" aria-label={REPORT_AUDIENCE_TOGGLE_LABEL}>
      {REPORT_AUDIENCE_OPTIONS.map((option) => {
        const active = option === audience
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={active}
            className={`segmented-option ${active ? 'segmented-option-active' : ''}`}
          >
            {REPORT_AUDIENCE_LABELS[option]}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The component for one slot of `reportSectionOrder`. The switch is exhaustive
 * with no default, so a new section id fails to compile until it renders.
 */
function ReportSectionSlot({
  id,
  report,
  audience,
  projectName,
}: {
  id: ReportSectionId
  report: ProjectReportDto
  audience: ReportAudience
  projectName: string
}): JSX.Element {
  switch (id) {
    case ReportSectionIds['client-summary']:
      return report.visibility ? <ReportVisibilitySummary visibility={report.visibility} /> : <ClientSummarySection report={report} />
    case ReportSectionIds['executive-summary']:
      return <AgencyExecutiveSummary report={report} />
    case ReportSectionIds['share-of-voice']:
      return <ReportShareOfVoice report={report} />
    case ReportSectionIds['whats-changed']:
      return <WhatsChangedSection report={report} audience={audience} />
    case ReportSectionIds['server-activity']:
      return audience === 'client' ? <ServerActivityClientView report={report} /> : <AgencyServerActivity report={report} />
    case ReportSectionIds['client-action-plan']:
      return <ActionPlanSection report={report} audience="client" projectName={projectName} />
    case ReportSectionIds['agency-action-plan']:
      return <ActionPlanSection report={report} audience="agency" projectName={projectName} />
    case ReportSectionIds['agency-diagnostics']:
      return <AgencyDiagnostics report={report} />
    case ReportSectionIds['citation-scorecard']:
      return <AgencyCitationScorecard report={report} />
    case ReportSectionIds['competitor-landscape']:
      return <AgencyCompetitorLandscape report={report} />
    case ReportSectionIds['ai-source-origin']:
      return <AgencyAiSourceOrigin report={report} />
    case ReportSectionIds.gsc:
      return <AgencyGscPerformance report={report} />
    case ReportSectionIds.ga:
      return <AgencyGaTraffic report={report} />
    case ReportSectionIds['social-referrals']:
      return <AgencySocialReferrals report={report} />
    case ReportSectionIds['ai-referrals']:
      return <AgencyAiReferrals report={report} />
    case ReportSectionIds['indexing-health']:
      return <AgencyIndexingHealth report={report} />
    case ReportSectionIds['citations-trend']:
      return <AgencyCitationsTrend report={report} />
    case ReportSectionIds.insights:
      return <AgencyInsights report={report} />
    case ReportSectionIds['content-opportunities']:
      return <AgencyContentOpportunities report={report} />
    case ReportSectionIds['content-gaps']:
      return <AgencyContentGaps report={report} />
    case ReportSectionIds['recommended-next-steps']:
      return <AgencyRecommendedNextSteps report={report} />
    case ReportSectionIds['client-evidence-summary']:
      return <ClientEvidenceSection report={report} />
  }
}

export function ReportShareOfVoice({ report }: { report: Pick<ProjectReportDto, 'mentionLandscape'> }) {
  const shares = [report.mentionLandscape.nonBrand?.shareOfVoice, report.mentionLandscape.branded?.shareOfVoice?.queryClass === 'branded' ? report.mentionLandscape.branded.shareOfVoice : undefined]
  return <div className="space-y-2 text-sm text-secondary" aria-label="Share of voice" data-report-section={ReportSectionIds['share-of-voice']}>
    {shares.map(share => share ? <div key={share.queryClass}>
      <p>{shareOfVoiceSummary(share.percent, share.queryClass, share)}</p>
      {share.reason ? <p>{shareOfVoiceReason(share.reason)}</p> : null}
    </div> : null)}
  </div>
}

// Time-window selector. Re-fetches the report scoped to the chosen window.
function PeriodToggle({
  period,
  onChange,
}: {
  period: ReportPeriodDays
  onChange: (p: ReportPeriodDays) => void
}) {
  return (
    <div className="segmented" role="group" aria-label="Report time period">
      {REPORT_PERIOD_OPTIONS.map((opt) => {
        const active = opt === period
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            aria-pressed={active}
            className={`segmented-option ${active ? 'segmented-option-active' : ''}`}
          >
            {opt}d
          </button>
        )
      })}
    </div>
  )
}

/**
 * Client summary of server-side AI activity. Silent until a traffic source is
 * connected; a connected source with nothing synced yet shows one empty state.
 */
function ServerActivityClientView({ report }: { report: ProjectReportDto }) {
  const sa = report.serverActivity
  if (!sa) return null
  const windowDays = report.meta.periodDays
  const copy = REPORT_SECTION_COPY['server-activity']

  if (!sa.hasData) {
    return (
      <ReportSection {...reportServerActivityHeading('client', false, windowDays)}>
        <EmptyHint message={copy.client.empty} />
      </ReportSection>
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
  const priorWindowLabel = reportPriorWindowLabel(windowDays)
  const crawlerTrust = reportCrawlerTrustSummary(sa.verifiedCrawlerHits.current, sa.unverifiedCrawlerHits.current)
  const crawlerDelta = formatDeltaCopy(crawlerRequests, copy.countNouns.requests, priorWindowLabel)
  const userFetchDelta = formatDeltaCopy(sa.aiUserFetchHits, copy.countNouns.requests, priorWindowLabel)
  // Referral arrivals mix paid and organic clicks, so the API's class summary
  // rides beside the total, and arrivals lost to redirects are named rather
  // than hidden. Same fragments, in the same order, as the HTML report.
  const referralSubtitle = [
    formatDeltaCopy(sa.referralArrivals, copy.countNouns.sessions, priorWindowLabel),
    sa.referralArrivalsClassSummary,
    reportReferralRedirectNote(sa.referralRedirects),
  ].filter(Boolean).join(' · ')
  // The client view caps the operator table at five; the agency view lists every operator.
  const topOperators = sa.byOperator
    .filter(o => o.verifiedHits > 0 || o.unverifiedHits > 0 || o.userFetchHits > 0 || o.referralArrivals > 0)
    .slice(0, 5)
  const [toolHeader, botRequestsHeader, userFetchesHeader, referralSessionsHeader] = reportServerActivityClientOperatorHeaders(windowDays)

  return (
    <ReportSection {...reportServerActivityHeading('client', true, windowDays)}>
      <ReportTiles
        columns={3}
        tiles={[
          { label: copy.client.tiles.botRequests, value: formatNumber(crawlerRequests.current), subtitle: crawlerDelta ? `${crawlerTrust} · ${crawlerDelta}` : crawlerTrust },
          { label: copy.client.tiles.userFetches, value: formatNumber(sa.aiUserFetchHits.current), subtitle: userFetchDelta || copy.client.userFetchFallback },
          { label: copy.client.tiles.referralSessions, value: formatNumber(sa.referralArrivals.current), subtitle: referralSubtitle },
        ]}
      />
      {topOperators.length > 0 && (
        <ReportTableBlock
          title={copy.client.operatorsHeading}
          headers={[
            toolHeader,
            { label: botRequestsHeader, numeric: true },
            { label: userFetchesHeader, numeric: true },
            { label: referralSessionsHeader, numeric: true },
          ]}
          footnote={<ReportNote>{copy.client.operatorsFootnote}</ReportNote>}
        >
          {topOperators.map(o => (
            <tr key={o.operator}>
              <td className="evidence-query-cell">{o.operator}</td>
              <td className="text-right tabular-nums">{formatNumber(o.verifiedHits + o.unverifiedHits)}</td>
              <td className="text-right tabular-nums">{formatNumber(o.userFetchHits)}</td>
              <td className="text-right tabular-nums">{formatNumber(o.referralArrivals)}</td>
            </tr>
          ))}
        </ReportTableBlock>
      )}
    </ReportSection>
  )
}

function ClientSummarySection({ report }: { report: ProjectReportDto }) {
  const exec = report.executiveSummary
  const sc = report.citationScorecard
  const copy = REPORT_SECTION_COPY['client-summary']
  const totalQ = exec.totalQueryCount ?? 0
  const heroNumber = totalQ > 0 ? `${exec.mentionRate}%` : '—'
  const trend = reportClientTrendCopy(report.whatsChanged.mentionRate)
  const { lead, mention, link, closing } = copy.explainer

  return (
    <section id={ReportSectionIds['client-summary']} data-report-section={ReportSectionIds['client-summary']} className="page-section-divider">
      <div className="rounded-2xl border border-default bg-bg-elevated/40 p-6 sm:p-8">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{copy.heroEyebrow}</p>
        <p className="mt-3 text-6xl font-bold tracking-tight text-primary sm:text-7xl">{heroNumber}</p>
        <p className="mt-3 max-w-2xl text-base text-neutral sm:text-lg">{reportClientHeroSentence(totalQ, exec.mentionedQueryCount)}</p>
        {trend && (
          <p className={`mt-3 text-sm font-medium ${trend.tone === 'positive' ? 'text-positive-400' : trend.tone === 'negative' ? 'text-negative-400' : 'text-secondary'}`}>
            <span className="mr-1">{trend.arrow}</span>{trend.text}
          </p>
        )}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <BigMetricTile label={copy.tiles.mentioned} value={`${exec.mentionRate}%`} subtitle={reportClientMentionedSubtitle(exec.mentionedQueryCount, totalQ)} />
        <BigMetricTile label={copy.tiles.cited} value={`${exec.citationRate}%`} subtitle={reportClientCitedSubtitle(exec.citedQueryCount, totalQ)} />
        <BigMetricTile label={copy.tiles.providers} value={formatNumber(exec.providerCount)} subtitle={reportClientProvidersSubtitle(sc.providers, exec.queryCount)} />
      </div>

      <div className="mt-4 rounded-xl border border-default bg-bg/40 px-4 py-3 text-[13px] text-secondary" data-report-note>
        <span className="font-semibold text-strong">{lead}</span>{' '}
        {mention.article} <span className="font-medium text-strong">{mention.term}</span> {mention.definition}{' '}
        {link.article} <span className="font-medium text-strong">{link.term}</span> {link.definition}{' '}
        {closing}
      </div>

      {sc.queries.length > 0 && (
        <div className="mt-5 rounded-xl border border-default bg-surface p-5">
          <h3 className="text-sm font-semibold text-heading" data-report-heading>{copy.queriesHeading}</h3>
          <p className="mt-1 text-[13px] text-secondary" data-report-note>{reportClientQueriesSubtitle(sc.queries.length)}</p>
          <ol className="mt-4 grid gap-2 sm:grid-cols-2">
            {sc.queries.map((q, i) => (
              <li key={i} className="flex items-start gap-3 rounded-lg border border-default bg-bg/40 px-3 py-2 text-sm text-strong">
                <span className="shrink-0 text-xs font-semibold tabular-nums text-muted">{String(i + 1).padStart(2, '0')}</span>
                <span>"{q}"</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {sc.providerRates.length > 0 && (
        <div className="mt-5 rounded-xl border border-default bg-surface p-5">
          <h3 className="text-sm font-semibold text-heading" data-report-heading>{copy.providerBarsHeading}</h3>
          <p className="mt-1 text-[13px] text-secondary" data-report-note>{copy.providerBarsSubtitle}</p>
          <div className="mt-4 space-y-3">
            {sc.providerRates.map(r => (
              <div key={r.provider} className="grid grid-cols-[120px_1fr_120px] items-center gap-3">
                <span className="text-sm text-neutral">{reportProviderDisplayName(r.provider)}</span>
                <div className="h-3 overflow-hidden rounded-full bg-mono-800/80">
                  <div className="h-full rounded-full bg-positive-500/70" style={{ width: `${Math.max(r.mentionRate, 1.5)}%` }} />
                </div>
                <span className="text-right text-sm font-semibold text-heading">
                  {r.mentionRate}% <span className="font-normal text-muted">({r.mentionedCount}/{r.totalCount})</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.clientSummary.confidenceNotes.length > 0 && (
        <div className="mt-4 grid gap-2">
          {report.clientSummary.confidenceNotes.map((note, i) => (
            <div key={i} className="rounded-lg border border-default bg-surface px-3 py-2 text-[13px] text-secondary" data-report-note>{note}</div>
          ))}
        </div>
      )}
    </section>
  )
}

function BigMetricTile({ label, value, subtitle }: { label: string; value: string; subtitle: string }) {
  return (
    <div className="rounded-xl border border-default bg-surface p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted" data-report-tile>{label}</p>
      <p className="mt-3 text-4xl font-bold tracking-tight text-primary sm:text-5xl">{value}</p>
      <p className="mt-2 text-[13px] text-secondary">{subtitle}</p>
    </div>
  )
}

function ActionPlanSection({ report, audience, projectName }: { report: ProjectReportDto; audience: ReportAudience; projectName: string }) {
  const dedupedActions = reportAudienceActions(report, audience)
  const isClient = audience === 'client'
  const sectionId = isClient ? ReportSectionIds['client-action-plan'] : ReportSectionIds['agency-action-plan']
  const copy = REPORT_SECTION_COPY[sectionId]
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
    <ReportSection id={sectionId} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      {actions.length === 0 ? (
        <EmptyHint message={copy.empty} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {actions.map((action, idx) => {
            const proof = action.evidence.length > 0 ? action.evidence : action.why
            const hasDetails = action.why.length > 0 || action.evidence.length > 0
            return (
              <article key={`${action.priority}-${action.title}`} className="rounded-xl border border-default bg-surface p-4">
                <div className="flex items-start gap-3">
                  <div
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-mono-800/80 text-sm font-semibold text-heading"
                    title={copy.rankTitle}
                  >
                    {idx + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap gap-2">
                      <ToneBadge tone={reportActionTone(action)}>{reportActionHorizonBadge(audience, action.horizon)}</ToneBadge>
                      {!isClient && <ToneBadge tone="neutral">{reportActionCategoryLabel(action.category)}</ToneBadge>}
                      <ToneBadge tone="neutral">{reportActionConfidenceBadge(audience, action.confidence)}</ToneBadge>
                    </div>
                    <h3 className="text-sm font-medium text-heading" data-report-heading>{action.title}</h3>
                  </div>
                </div>
                <p className="mt-3 text-sm text-secondary">{action.action}</p>
                <ProofChips items={proof} limit={3} className="mt-3" />
                {hasDetails && (
                  <details className="mt-3 text-[13px] text-secondary">
                    <summary className="cursor-pointer text-secondary hover:text-neutral">{copy.detailsSummary}</summary>
                    {action.why.length > 0 && (
                      <div className="mt-2">
                        <p className="eyebrow-soft mb-1">{copy.whyLabel}</p>
                        <ul className="list-disc space-y-1 pl-4">
                          {action.why.map((item, i) => <li key={i}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                    {action.evidence.length > 0 && (
                      <div className="mt-2">
                        <p className="eyebrow-soft mb-1">{copy.evidenceLabel}</p>
                        <ul className="list-disc space-y-1 pl-4">
                          {action.evidence.map((item, i) => <li key={i}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                  </details>
                )}
                <p className="mt-3 border-t border-default pt-3 text-[13px] text-neutral">
                  <span className="font-medium">{copy.successLabel}</span> {action.successMetric}
                </p>
                {action.targetRef && !isEmbed() && (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => handleDismiss(action)}
                      className="rounded-md border border-default bg-bg-elevated/50 px-2.5 py-1 text-[11px] font-medium text-neutral hover:border-mono-600 hover:bg-mono-800/70 hover:text-heading"
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
    </ReportSection>
  )
}

function HorizontalBarRow({ label, value, displayValue, max, barClass }: { label: string; value: number; displayValue: string; max: number; barClass: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, 1.5) : 0
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
      <div className="min-w-0">
        <p className="truncate text-neutral" title={label}>{label}</p>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-mono-800/80">
          <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="whitespace-nowrap text-sm font-semibold text-heading">{displayValue}</span>
    </div>
  )
}

function ClientEvidenceSection({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['client-evidence-summary']
  const ai = report.aiSourceOrigin.topDomains.slice(0, 5)
  const gsc = report.gsc
  const indexing = report.indexingHealth
  const opportunities = dedupeReportOpportunities(report).slice(0, 5)

  const aiMax = ai.length > 0 ? Math.max(...ai.map(d => d.count)) : 0
  const gscMax = gsc ? Math.max(...gsc.topQueries.slice(0, 5).map(q => q.impressions), 1) : 0
  const indexingTone = indexing ? reportClientIndexingTone(indexing.indexedPct) : 'neutral'

  const hasAnything = ai.length > 0 || gsc !== null || indexing !== null || opportunities.length > 0

  return (
    <ReportSection id={ReportSectionIds['client-evidence-summary']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      {!hasAnything ? (
        <EmptyHint message={copy.empty} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {ai.length > 0 && (
            <div className="rounded-xl border border-default bg-surface p-5">
              <h3 className="text-sm font-semibold text-heading" data-report-heading>{copy.sources.heading}</h3>
              <p className="mt-1 text-[13px] text-secondary" data-report-note>{copy.sources.subtitle}</p>
              <div className="mt-4 space-y-3">
                {ai.map(d => (
                  <HorizontalBarRow
                    key={d.domain}
                    label={d.isCompetitor ? `${d.domain} ${copy.sources.competitorTag}` : d.domain}
                    value={d.count}
                    displayValue={reportClientSourceCount(d.count)}
                    max={aiMax}
                    barClass="bg-mono-400/70"
                  />
                ))}
              </div>
            </div>
          )}
          {indexing && (
            <div className="rounded-xl border border-default bg-surface p-5">
              <h3 className="text-sm font-semibold text-heading" data-report-heading>{copy.indexing.heading}</h3>
              <p className="mt-1 text-[13px] text-secondary" data-report-note>{copy.indexing.subtitle}</p>
              <p className={`mt-4 text-5xl font-bold tracking-tight ${TONE_TEXT_CLASS[indexingTone]}`}>
                {indexing.indexedPct}%
              </p>
              <p className="mt-1 text-[13px] text-secondary">{reportClientIndexedPages(indexing.indexed, indexing.total)}</p>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-mono-800/80">
                <div className={`h-full rounded-full ${TONE_BAR_CLASS[indexingTone]}`} style={{ width: `${Math.max(indexing.indexedPct, 1.5)}%` }} />
              </div>
              <p className="mt-3 text-[13px] text-secondary">
                <span className="font-medium text-strong">{formatNumber(indexing.notIndexed)}</span> {reportClientNotIndexedTail(indexing.notIndexed)}
              </p>
            </div>
          )}
          {gsc && (
            <div className="rounded-xl border border-default bg-surface p-5">
              <h3 className="text-sm font-semibold text-heading" data-report-heading>{copy.search.heading}</h3>
              <p className="mt-1 text-[13px] text-secondary" data-report-note>
                {copy.search.subtitleLead} <span className="font-semibold text-strong">{formatNumber(gsc.totalImpressions)}</span> {copy.search.subtitleMiddle} <span className="font-semibold text-strong">{formatNumber(gsc.totalClicks)}</span> {reportClientClicksNoun(gsc.totalClicks)} {copy.search.subtitleTail}
              </p>
              {gsc.topQueries.length > 0 && (
                <div className="mt-4 space-y-3">
                  {gsc.topQueries.slice(0, 5).map(q => (
                    <HorizontalBarRow
                      key={q.query}
                      label={q.query}
                      value={q.impressions}
                      displayValue={reportClientSearchCount(q.impressions)}
                      max={gscMax}
                      barClass="bg-info-500/70"
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {opportunities.length > 0 && (
            <div className="rounded-xl border border-default bg-surface p-5">
              <h3 className="text-sm font-semibold text-heading" data-report-heading>{copy.opportunities.heading}</h3>
              <p className="mt-1 text-[13px] text-secondary" data-report-note>{copy.opportunities.subtitle}</p>
              <ul className="mt-4 space-y-2 text-sm text-neutral">
                {opportunities.map((o, i) => (
                  <li key={i} className="rounded-lg border border-default bg-bg/40 px-3 py-2">
                    <p className="font-medium text-heading">{o.query}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-[13px] text-secondary">
                      {contentActionLabel(o.action)}
                      {o.winnabilityClass === 'ceded' && <ToneBadge tone="caution">{copy.opportunities.cededTag}</ToneBadge>}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ReportSection>
  )
}

// ─── Section: What's Changed ───────────────────────────────────────────────

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
      <div className="rounded-xl border border-default bg-surface px-4 py-3">
        <p className="eyebrow-soft" data-report-tile>{label}</p>
        <p className="text-2xl font-semibold tracking-tight text-muted">—</p>
        <p className="mt-1 text-[13px] text-secondary">{REPORT_SECTION_COPY['whats-changed'].rateTileEmpty}</p>
      </div>
    )
  }
  const valueSuffix = unit === '%' ? '%' : ''
  return (
    <div className="rounded-xl border border-default bg-surface px-4 py-3">
      <p className="eyebrow-soft" data-report-tile>{label}</p>
      <p className={`text-2xl font-semibold tracking-tight ${TONE_TEXT_CLASS[reportDirectionTone(delta.direction)]}`}>
        {delta.current}{valueSuffix} <span className="text-sm font-medium">{reportDeltaArrow(delta.direction)}</span>
      </p>
      {/* Rates keep percentage-point copy; counts take the shared smart-% copy the HTML report prints. */}
      <p className="mt-1 text-[13px] text-secondary">{reportRateDeltaCopy(delta, unit)}</p>
    </div>
  )
}

function TrafficDeltaTile({
  label,
  delta,
  countLabel,
  comparisonWindowDays,
}: {
  label: string
  delta: ProjectReportDto['whatsChanged']['gscClicksDelta']
  countLabel: string
  comparisonWindowDays: number
}) {
  if (!delta) {
    return (
      <div className="rounded-xl border border-default bg-surface px-4 py-3">
        <p className="eyebrow-soft" data-report-tile>{label}</p>
        <p className="text-2xl font-semibold tracking-tight text-muted">—</p>
        <p className="mt-1 text-[13px] text-secondary">{REPORT_SECTION_COPY['whats-changed'].trafficTileEmpty}</p>
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-default bg-surface px-4 py-3">
      <p className="eyebrow-soft" data-report-tile>{label}</p>
      <p className={`text-2xl font-semibold tracking-tight ${TONE_TEXT_CLASS[reportDirectionTone(delta.direction)]}`}>
        {formatNumber(delta.current)} <span className="text-sm font-medium">{reportDeltaArrow(delta.direction)}</span>
      </p>
      <p className="mt-1 text-[13px] text-secondary">
        {formatWindowCountDelta(delta, countLabel, reportPriorWindowLabel(comparisonWindowDays))}
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
  const copy = isClient ? REPORT_SECTION_COPY['whats-changed'].client : REPORT_SECTION_COPY['whats-changed'].agency
  const [engineHeader, priorHeader, currentHeader, changeHeader] = copy.movementHeaders
  return (
    <ReportTableBlock
      title={copy.movementsHeading}
      headers={[engineHeader, { label: priorHeader, numeric: true }, { label: currentHeader, numeric: true }, { label: changeHeader, numeric: true }]}
    >
      {meaningful.map(m => {
        const tone = reportDirectionTone(m.direction)
        return (
          <tr key={m.provider}>
            <td>{isClient ? reportProviderDisplayName(m.provider) : m.provider}</td>
            <td className="text-right tabular-nums">{m.prior}%</td>
            <td className="text-right tabular-nums">{m.current}%</td>
            <td className={`text-right tabular-nums ${tone === 'neutral' ? 'text-neutral' : TONE_TEXT_CLASS[tone]}`}>
              {reportMovementChangeCopy(m)}
            </td>
          </tr>
        )
      })}
    </ReportTableBlock>
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
      <ReportCard title={heading}>
        <ReportNote>{emptyMessage}</ReportNote>
      </ReportCard>
    )
  }
  const isClient = audience === 'client'
  const copy = isClient ? REPORT_SECTION_COPY['whats-changed'].client : REPORT_SECTION_COPY['whats-changed'].agency
  return (
    <ReportTableBlock title={heading} headers={copy.insightHeaders}>
      {insights.map(i => (
        <tr key={i.id}>
          {!isClient && (
            <td>
              <ToneBadge tone={reportSeverityTone(i.severity)}>{reportSeverityLabel(i.severity)}</ToneBadge>
            </td>
          )}
          <td className="evidence-query-cell">
            {i.title}
            {i.instanceCount > 1 && <ToneBadge tone="neutral" className="ml-2">{reportInstanceCountLabel(i.instanceCount)}</ToneBadge>}
          </td>
          <td className="text-[13px] text-secondary">{i.query}</td>
          <td className="text-[13px] text-secondary">{isClient ? reportProviderDisplayName(i.provider) : i.provider}</td>
        </tr>
      ))}
    </ReportTableBlock>
  )
}

function WhatsChangedSection({ report, audience }: { report: ProjectReportDto; audience: ReportAudience }) {
  const w = report.whatsChanged
  const isClient = audience === 'client'
  const { client, agency } = REPORT_SECTION_COPY['whats-changed']
  const copy = isClient ? client : agency
  const everythingEmpty = !w.enoughHistory
    && !w.gscClicksDelta
    && !w.aiReferralsDelta
    && w.wins.length === 0
    && w.regressions.length === 0
  return (
    <ReportSection id={ReportSectionIds['whats-changed']} eyebrow={copy.eyebrow} title={copy.title} intro={isClient ? undefined : w.headline}>
      {everythingEmpty ? (
        <EmptyHint message={copy.empty} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <RateDeltaTile label={isClient ? client.tiles.mentionRate : agency.tiles.citationRate} delta={isClient ? w.mentionRate : w.citationRate} unit="%" />
            <RateDeltaTile label={isClient ? client.tiles.citationRate : agency.tiles.mentionRate} delta={isClient ? w.citationRate : w.mentionRate} unit="%" />
            <RateDeltaTile label={isClient ? client.tiles.mentionedQueryCount : agency.tiles.citedQueryCount} delta={isClient ? w.mentionedQueryCount : w.citedQueryCount} unit="count" />
            <TrafficDeltaTile label={copy.tiles.gscClicks} delta={w.gscClicksDelta} countLabel={copy.gscCountLabel} comparisonWindowDays={w.comparisonWindowDays} />
            <TrafficDeltaTile label={copy.tiles.aiReferrals} delta={w.aiReferralsDelta} countLabel={copy.aiReferralsCountLabel} comparisonWindowDays={w.comparisonWindowDays} />
          </div>
          <ProviderMovementsTable movements={w.providerMovements} audience={audience} />
          <WinsLossesTable insights={w.wins} heading={copy.winsHeading} emptyMessage={copy.winsEmpty} audience={audience} />
          <WinsLossesTable insights={w.regressions} heading={copy.regressionsHeading} emptyMessage={copy.regressionsEmpty} audience={audience} />
        </>
      )}
    </ReportSection>
  )
}

// ─── Agency report sections ────────────────────────────────────────────────
// One marked region per build slice. Each placeholder renders its section
// heading only; the slice replaces it inside its own region, keeping the
// function name and its `{ report }` props, which ReportSectionSlot renders.

// ── report slice S1: agency overview ──
function AgencyExecutiveSummary(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['executive-summary']
  return <ReportSection id={ReportSectionIds['executive-summary']} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyDiagnostics(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['agency-diagnostics']
  return <ReportSection id={ReportSectionIds['agency-diagnostics']} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyRecommendedNextSteps(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['recommended-next-steps']
  return <ReportSection id={ReportSectionIds['recommended-next-steps']} eyebrow={copy.eyebrow} title={copy.title} />
}
// ── end report slice S1 ──

// ── report slice S2: competitive evidence ──
function AgencyCitationScorecard(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['citation-scorecard']
  return <ReportSection id={ReportSectionIds['citation-scorecard']} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyCompetitorLandscape(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['competitor-landscape']
  return <ReportSection id={ReportSectionIds['competitor-landscape']} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyAiSourceOrigin(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['ai-source-origin']
  return <ReportSection id={ReportSectionIds['ai-source-origin']} eyebrow={copy.eyebrow} title={copy.title} />
}
// ── end report slice S2 ──

// ── report slice S3: search and traffic ──
function AgencyGscPerformance(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY.gsc
  return <ReportSection id={ReportSectionIds.gsc} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyGaTraffic(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY.ga
  return <ReportSection id={ReportSectionIds.ga} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencySocialReferrals(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['social-referrals']
  return <ReportSection id={ReportSectionIds['social-referrals']} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyAiReferrals(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['ai-referrals']
  return <ReportSection id={ReportSectionIds['ai-referrals']} eyebrow={copy.eyebrow} title={copy.title} />
}
// ── end report slice S3 ──

// ── report slice S4: server-side, indexing and trend ──
function AgencyServerActivity({ report }: { report: ProjectReportDto }) {
  const heading = reportServerActivityHeading('agency', report.serverActivity?.hasData ?? false, report.meta.periodDays)
  return <ReportSection id={heading.id} eyebrow={heading.eyebrow} title={heading.title} />
}

function AgencyIndexingHealth(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['indexing-health']
  return <ReportSection id={ReportSectionIds['indexing-health']} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyCitationsTrend(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['citations-trend']
  return <ReportSection id={ReportSectionIds['citations-trend']} eyebrow={copy.eyebrow} title={copy.title} />
}
// ── end report slice S4 ──

// ── report slice S5: insights and content ──
function AgencyInsights(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY.insights
  return <ReportSection id={ReportSectionIds.insights} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyContentOpportunities(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['content-opportunities']
  return <ReportSection id={ReportSectionIds['content-opportunities']} eyebrow={copy.eyebrow} title={copy.title} />
}

function AgencyContentGaps(_props: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['content-gaps']
  return <ReportSection id={ReportSectionIds['content-gaps']} eyebrow={copy.eyebrow} title={copy.title} />
}
// ── end report slice S5 ──

// ─── Shared report helpers ─────────────────────────────────────────────────
// Every section, client or agency, is built from these. They write the
// data-report-* outline hooks, so a section assembled from them reads the way
// the HTML report does. Exported for the report tests.

/** A report section: its id, outline hook, and heading copy. Leave `intro` out where the HTML report shows none. */
export function ReportSection({
  id,
  eyebrow,
  title,
  intro,
  children,
}: {
  id: ReportSectionId
  eyebrow: string
  title: string
  intro?: string | null
  children?: ReactNode
}) {
  return (
    <section id={id} data-report-section={id} className="page-section-divider">
      <SectionHeading eyebrow={eyebrow} title={title} subtitle={intro ?? undefined} />
      {children}
    </section>
  )
}

function SectionHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <p className="eyebrow-soft" data-report-eyebrow>{eyebrow}</p>
      <h2 className="page-title">{title}</h2>
      {subtitle && <p className="page-subtitle mt-1" data-report-intro>{subtitle}</p>}
    </div>
  )
}

/** A card or table title (h3). A tooltip sits beside the heading, never inside it. */
function ReportHeading({ title, tooltip }: { title: string; tooltip?: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <h3 className="text-sm font-semibold text-heading" data-report-heading>{title}</h3>
      {tooltip ? <ReportNote tooltip={tooltip} /> : null}
    </div>
  )
}

type ReportNoteProps =
  | { children: ReactNode; className?: string; tooltip?: undefined }
  | { tooltip: string; children?: undefined; className?: undefined }

/**
 * Supporting copy the HTML report prints as a note. Inline at 13px by default;
 * pass `tooltip` to keep the same words in an InfoTooltip beside a heading.
 * The outline reads the same text either way.
 */
export function ReportNote(props: ReportNoteProps) {
  if (props.tooltip !== undefined) {
    return <span className="inline-flex" data-report-note><InfoTooltip text={props.tooltip} /></span>
  }
  return <p className={`mt-2 text-[13px] text-secondary ${props.className ?? ''}`} data-report-note>{props.children}</p>
}

/** A bordered card with an optional title: a chart, a chip list, or a short callout. */
export function ReportCard({
  title,
  tooltip,
  children,
  className = '',
}: {
  title?: string
  tooltip?: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={`mt-4 rounded-xl border border-default bg-surface p-4 ${className}`}>
      {title ? <ReportHeading title={title} tooltip={tooltip} /> : null}
      {children}
    </div>
  )
}

export interface ReportTableHeader {
  label: string
  /** Right-aligned tabular numbers. */
  numeric?: boolean
  /** Words for an InfoTooltip beside the header text. */
  tooltip?: string
  className?: string
}

/**
 * A titled data table in its own horizontal scroll container. Headers are
 * strings, or objects for numeric alignment and header tooltips. `note`
 * renders between the title and the table; `footnote` after the table, where
 * the HTML report prints its closing note. Children are the `<tr>` rows.
 */
export function ReportTableBlock({
  title,
  tooltip,
  note,
  footnote,
  headers,
  children,
  className = '',
  tableClassName = '',
}: {
  title?: string
  tooltip?: string
  note?: ReactNode
  footnote?: ReactNode
  headers: readonly (string | ReportTableHeader)[]
  children: ReactNode
  className?: string
  tableClassName?: string
}) {
  return (
    <div className={`mt-4 ${className}`}>
      {title ? <ReportHeading title={title} tooltip={tooltip} /> : null}
      {note}
      <div className="evidence-table-wrap">
        <table className={`evidence-table ${tableClassName}`}>
          <thead>
            <tr>
              {headers.map((header, index) => {
                const cell = typeof header === 'string' ? { label: header } : header
                const className = [cell.numeric ? 'text-right' : '', cell.className ?? ''].filter(Boolean).join(' ')
                return (
                  <th key={`${index}-${cell.label}`} className={className || undefined}>
                    {cell.tooltip ? (
                      <span className="inline-flex items-center gap-1">{cell.label}<InfoTooltip text={cell.tooltip} /></span>
                    ) : cell.label}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {footnote}
    </div>
  )
}

/** A metric tile: label, value, and one line under it. Pass a node to tone part of the subtitle. */
export function Metric({ label, value, tone, subtitle }: { label: string; value: ReactNode; tone?: MetricTone; subtitle?: ReactNode }) {
  return (
    <div className="rounded-xl border border-default bg-surface px-4 py-3">
      <p className="eyebrow-soft" data-report-tile>{label}</p>
      <p className={`text-2xl font-semibold tracking-tight ${TONE_TEXT_CLASS[tone ?? 'neutral']}`}>{value}</p>
      {subtitle ? <p className="mt-1 text-[13px] text-secondary">{subtitle}</p> : null}
    </div>
  )
}

export interface ReportTile {
  label: string
  value: ReactNode
  /** One line under the value; a node can tone part of it, such as a delta. */
  subtitle?: ReactNode
  tone?: MetricTone
}

const TILE_COLUMN_CLASS = {
  1: '',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
  5: 'sm:grid-cols-2 lg:grid-cols-5',
} as const

/** A row of metric tiles in the order the HTML report lists them. */
export function ReportTiles({ tiles, columns = 3 }: { tiles: readonly ReportTile[]; columns?: keyof typeof TILE_COLUMN_CLASS }) {
  return (
    <div className={`grid gap-3 ${TILE_COLUMN_CLASS[columns]}`}>
      {tiles.map(tile => <Metric key={tile.label} {...tile} />)}
    </div>
  )
}

export interface ShareBarRow {
  label: string
  count: number
  sharePct: number
  /** A CHART_SERIES_COLORS or CHART_TONE entry. */
  color: string
  /** The text after the bar, e.g. `8.0K sessions · 67%`. */
  valueLabel: ReactNode
}

/**
 * Horizontal bars drawn the way the HTML report draws them. On the `share`
 * scale each bar is its share (clamped to 0-100) and a row with no count and
 * no share is dropped; on the `max` scale bars are sized against the largest
 * count and nothing draws when every count is 0. Renders nothing when no row
 * is left.
 */
export function ShareBars({ title, rows, scale }: { title: string; rows: readonly ShareBarRow[]; scale: 'share' | 'max' }) {
  const visible = scale === 'share' ? rows.filter(row => row.count > 0 || row.sharePct > 0) : rows
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (visible.length === 0 || (scale === 'max' && total === 0)) return null
  const max = Math.max(...rows.map(row => row.count), 1)
  return (
    <ReportCard title={title}>
      <div className="space-y-3">
        {visible.map((row, index) => {
          const width = scale === 'share' ? Math.max(0, Math.min(100, row.sharePct)) : (row.count / max) * 100
          return (
            <div key={`${index}-${row.label}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate text-neutral" title={row.label}>{row.label}</p>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-mono-800/80">
                  <div data-share-bar className="h-full rounded-full" style={{ width: `${width}%`, background: row.color }} />
                </div>
              </div>
              <span className="whitespace-nowrap text-[13px] tabular-nums text-secondary">{row.valueLabel}</span>
            </div>
          )
        })}
      </div>
    </ReportCard>
  )
}

/**
 * The chart palettes, so a report section needs no chart import of its own.
 * `series[i]` stands in for the HTML report's `COLORS.series[i]` (its accent is
 * `series[1]`), and `tone` for its positive, caution, negative and neutral colors.
 */
export const REPORT_CHART_COLORS = { series: CHART_SERIES_COLORS, tone: CHART_TONE } as const

/**
 * Axis tick and tooltip formatters for a dated x axis, chosen by what the date
 * means. `calendar` values (a Search Console or server-log day) read exactly as
 * written, with no timezone. `observed` values are run timestamps, localized
 * for the viewer.
 */
export function reportChartDateFormatters(dates: 'calendar' | 'observed'): {
  xTickFormatter: (value: string) => string
  labelFormatter: (value: string) => string
} {
  return dates === 'calendar'
    ? { xTickFormatter: formatChartDateTick, labelFormatter: formatChartDateLabel }
    : {
        xTickFormatter: value => formatObservedInstantTick(observedInstant(value)),
        labelFormatter: value => formatObservedInstantLabel(observedInstant(value)),
      }
}

/** A link to a cited or competitor page: a safe href only (`#` otherwise), opened in a new tab. */
export function ReportExternalLink({
  href,
  children,
  className = '',
}: {
  href: string | null | undefined
  children: ReactNode
  className?: string
}) {
  return (
    <a href={safeLinkHref(href)} target="_blank" rel="noopener noreferrer" className={`text-link hover:underline ${className}`}>
      {children}
    </a>
  )
}

/**
 * A one-series line chart in a card, named `<title> line chart` like the HTML
 * report's SVG. Renders nothing without data. `dates` picks the x-axis
 * formatters by what the x values mean (see reportChartDateFormatters); leave
 * it out when the x values are not dates.
 */
export function ReportLineChart({
  title,
  data,
  xKey,
  dataKey,
  color,
  height = 200,
  formatValue,
  dates,
}: {
  title: string
  data: readonly Record<string, unknown>[]
  xKey: string
  dataKey: string
  /** A REPORT_CHART_COLORS entry. */
  color: string
  height?: number
  formatValue?: (value: number) => string
  dates?: 'calendar' | 'observed'
}) {
  if (data.length === 0) return null
  const formatters = dates ? reportChartDateFormatters(dates) : undefined
  return (
    <ReportCard title={title}>
      <div role="img" aria-label={reportLineChartLabel(title)}>
        <MultiAxisTrendChart
          data={data}
          xKey={xKey}
          series={[{ dataKey, label: title, color, axisId: 'value', formatValue }]}
          height={height}
          xTickFormatter={formatters?.xTickFormatter}
          labelFormatter={formatters?.labelFormatter}
        />
      </div>
    </ReportCard>
  )
}

export interface ReportBarChartRow {
  label: string
  value: number
  /** A CHART_SERIES_COLORS or CHART_TONE entry. */
  color: string
  /** Drawn at the end of the bar, e.g. `50% (1/2)`. */
  valueLabel: string
}

/**
 * Horizontal bars in a card, one row per label, named `<title> bar chart` like
 * the HTML report's SVG. `domainMax` fixes the scale (the scorecard reads
 * 0-100); `track` draws the unfilled rest of each row. Renders nothing without
 * rows.
 */
export function ReportBarChart({
  title,
  rows,
  domainMax,
  rowHeight = 32,
  track = false,
  labelWidth = 96,
}: {
  title: string
  rows: readonly ReportBarChartRow[]
  domainMax?: number
  rowHeight?: number
  track?: boolean
  labelWidth?: number
}) {
  if (rows.length === 0) return null
  const max = domainMax ?? Math.max(...rows.map(row => row.value), 1)
  const height = Math.max(rows.length * rowHeight + 24, 80)
  return (
    <ReportCard title={title}>
      <div role="img" aria-label={reportBarChartLabel(title)}>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={[...rows]} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 0 }}>
            <XAxis type="number" domain={[0, max]} hide />
            <YAxis type="category" dataKey="label" width={labelWidth} tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} tickLine={false} axisLine={false} />
            <Bar dataKey="value" radius={3} isAnimationActive={false} background={track ? { fill: CHART_NEUTRAL.surface } : false}>
              {rows.map((row, index) => <Cell key={`${index}-${row.label}`} fill={row.color} />)}
              <LabelList dataKey="valueLabel" position="right" fill={CHART_NEUTRAL.text} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ReportCard>
  )
}

/** A landing page cell: the path, plus the tracking-query summary with the full URL as its title. */
export function LandingPageCell({ page }: { page: string }) {
  const described = describeLandingPage(page)
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="font-mono text-[13px] text-heading">{described.path}</span>
      {described.querySummary ? <span className="text-[13px] text-secondary" title={described.raw}>{described.querySummary}</span> : null}
    </span>
  )
}

export function ProofChips({ items, limit = 3, className }: { items: readonly string[]; limit?: number; className?: string }) {
  if (items.length === 0) return null
  const visible = items.slice(0, limit)
  const more = items.length - visible.length
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ''}`}>
      {visible.map((item, i) => (
        <span key={i} className="rounded-md border border-default bg-bg-elevated/40 px-2 py-0.5 text-[11px] text-neutral">
          {item}
        </span>
      ))}
      {more > 0 && (
        <span className="rounded-md border border-default bg-bg-elevated/40 px-2 py-0.5 text-[11px] text-secondary">
          +{more} more
        </span>
      )}
    </div>
  )
}

/** An empty state, in the HTML report's words. */
export function EmptyHint({ message }: { message: string }) {
  return <p className="py-4 text-center text-sm text-secondary" data-report-empty>{message}</p>
}
