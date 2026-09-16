import { ReportVisibilitySummary } from '../components/project/ReportVisibilitySummary.js'
import { reportVisibilityLocationLabel, shareOfVoiceReason, shareOfVoiceSummary } from '@ainyc/canonry-contracts'
import { useState, type JSX, type ReactNode } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import type {
  DeltaWindow,
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
  deltaTone,
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
  reportMoreChipLabel,
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
import { reportExecutiveHeadline, reportMarketScope } from '@ainyc/canonry-contracts'
// ── end report slice S1 imports ──

// ── report slice S2 imports: competitive evidence ──
import {
  CitationStates,
  reportCitedUrlCount,
  reportCompetitorMentionCopy,
  reportPressureTone,
  reportProviderRateLabel,
  reportSourceCategoryShareLabel,
  reportSourceCategoryTone,
  reportSourceOriginHeadline,
  reportTruncatedList,
  type ReportCompetitorMentionCopy,
} from '@ainyc/canonry-contracts'
// ── end report slice S2 imports ──

// ── report slice S3 imports: search and traffic ──
import { formatRatio, reportGaIntro, reportGscIntro, reportShareBarShareLabel } from '@ainyc/canonry-contracts'
// ── end report slice S3 imports ──

// ── report slice S4 imports: server-side, indexing and trend ──
import {
  isTrendBaseline,
  reportCitationsTrendBaseline,
  reportIndexingIntro,
  reportIndexingLegendLabel,
  reportServerActivityAgencyOperatorHeaders,
  reportServerActivityAgencyTiles,
  reportServerActivityCrawledPathsNote,
  reportServerActivityOperatorDelta,
  reportServerActivityPathHits,
  reportServerActivityTrendTitle,
  reportTrendProviderRates,
} from '@ainyc/canonry-contracts'
// ── end report slice S4 imports ──

// ── report slice S5 imports: insights and content ──
import {
  absolutizeProjectUrl,
  actionConfidenceLabel,
  reportCompactList,
  reportMissRateLabel,
  reportOpportunityActionLine,
  winnabilityClassLabel,
  WinnabilityClasses,
} from '@ainyc/canonry-contracts'
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

/**
 * A toned fragment inside a line of supporting copy, such as a trend label or a
 * delta. A neutral or unknown tone adds no class, so the fragment keeps the
 * line's own color.
 */
const TONE_INLINE_TEXT_CLASS: Readonly<Record<MetricTone, string>> = {
  positive: TONE_TEXT_CLASS.positive,
  caution: TONE_TEXT_CLASS.caution,
  negative: TONE_TEXT_CLASS.negative,
  neutral: '',
}

/**
 * A prior-window delta in the HTML report's words and tone, or nothing when
 * there is no copy to show. Both audiences render it: the HTML report wraps
 * every one of these in `<span class="tone-…">`, so a client reading the in-app
 * report sees the same colour as a client reading the downloaded one.
 */
function serverActivityDelta(delta: DeltaWindow, noun: string, priorWindowLabel: string): ReactNode {
  const text = formatDeltaCopy(delta, noun, priorWindowLabel)
  if (!text) return null
  return <span className={TONE_INLINE_TEXT_CLASS[deltaTone(delta.deltaPct)] || undefined}>{text}</span>
}

/**
 * Supporting-copy fragments joined with the HTML report's ` · `, dropping the
 * ones with nothing to say so a missing fragment leaves no stray separator.
 * Nothing at all renders no line.
 */
function joinReportParts(parts: readonly ReactNode[]): ReactNode {
  const visible = parts.filter(Boolean)
  if (visible.length === 0) return undefined
  return visible.map((part, index) => <span key={index}>{index > 0 ? ' · ' : null}{part}</span>)
}

/** No pending dismissals. A module constant so an empty render keeps one identity. */
const NO_DISMISSALS: ReadonlySet<string> = new Set()

export function ReportPage({ projectName }: { projectName: string }) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [period, setPeriod] = useState<ReportPeriodDays>(REPORT_DEFAULT_PERIOD_DAYS)
  const [selectedAudience, setSelectedAudience] = useState<ReportAudience>('client')
  // A read-only embed shows only the client report: no toggle, and the
  // download is the client file too.
  const embedded = isEmbed()
  const audience: ReportAudience = embedded ? 'client' : selectedAudience

  // One optimistic-dismissal set for the whole page. The client and agency
  // action plans are separate sections, so a set owned by either one is thrown
  // away the moment the reader switches audience, and a dismissal still waiting
  // on its POST would reappear in both views as if the click had failed.
  // Owning the mutation here also keeps its toast and its rollback alive when
  // the section that started it unmounts.
  const [dismissals, setDismissals] = useState<{ project: string; refs: ReadonlySet<string> }>(
    () => ({ project: projectName, refs: NO_DISMISSALS }),
  )
  // Adjusting state during render is React's sanctioned reset when a prop
  // changes: another project's report must not inherit these dismissals.
  if (dismissals.project !== projectName) setDismissals({ project: projectName, refs: NO_DISMISSALS })
  const dismissedRefs = dismissals.project === projectName ? dismissals.refs : NO_DISMISSALS
  const dismissMutation = useDismissContentTarget()

  const handleDismiss = (action: ProjectReportDto['actionPlan'][number]) => {
    const ref = action.targetRef
    if (!ref) return
    const withoutStaleProject = (previous: { project: string; refs: ReadonlySet<string> }) =>
      new Set(previous.project === projectName ? previous.refs : [])
    // No `window.confirm` — single-click dismissal with optimistic UI is the
    // right primitive here. The action is reversible via `DELETE
    // /content/dismissals/:targetRef` (and a future "Dismissed" panel), so the
    // friction of a confirm dialog outweighs the misclick risk. The toast
    // confirms the dismissal landed and is what catches an unintended one.
    setDismissals(previous => ({ project: projectName, refs: withoutStaleProject(previous).add(ref) }))
    dismissMutation.mutate(
      { projectName, body: { targetRef: ref } },
      {
        onSuccess: () => {
          addToast({
            tone: 'positive',
            title: `Dismissed "${action.title}"`,
            detail: 'Will not appear in future reports until un-dismissed.',
          })
          // Don't clear the entry here — the mutation invalidates the report
          // query, the row drops out of the refetched plan, and the filter
          // becomes a no-op on a row that is no longer there. We clear only on
          // error, so the user can retry.
        },
        onError: (err) => {
          addToast({
            tone: 'negative',
            title: `Couldn't dismiss "${action.title}"`,
            detail: String(err),
          })
          setDismissals(previous => {
            const refs = withoutStaleProject(previous)
            refs.delete(ref)
            return { project: projectName, refs }
          })
        },
      },
    )
  }

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
        <ReportSectionSlot key={id} id={id} report={report} audience={audience} dismissedRefs={dismissedRefs} onDismiss={handleDismiss} />
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
  dismissedRefs,
  onDismiss,
}: {
  id: ReportSectionId
  report: ProjectReportDto
  audience: ReportAudience
  /** Actions dismissed on this page and not yet gone from the server's answer. */
  dismissedRefs: ReadonlySet<string>
  onDismiss: (action: ProjectReportDto['actionPlan'][number]) => void
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
      return <ActionPlanSection report={report} audience="client" dismissedRefs={dismissedRefs} onDismiss={onDismiss} />
    case ReportSectionIds['agency-action-plan']:
      return <ActionPlanSection report={report} audience="agency" dismissedRefs={dismissedRefs} onDismiss={onDismiss} />
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
  const crawlerDelta = serverActivityDelta(crawlerRequests, copy.countNouns.requests, priorWindowLabel)
  const userFetchDelta = serverActivityDelta(sa.aiUserFetchHits, copy.countNouns.requests, priorWindowLabel)
  // Referral arrivals mix paid and organic clicks, so the API's class summary
  // rides beside the total, and arrivals lost to redirects are named rather
  // than hidden. Same fragments, in the same order, as the HTML report, and
  // only the delta carries a tone.
  const referralSubtitle = joinReportParts([
    serverActivityDelta(sa.referralArrivals, copy.countNouns.sessions, priorWindowLabel),
    sa.referralArrivalsClassSummary,
    reportReferralRedirectNote(sa.referralRedirects),
  ])
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
          { label: copy.client.tiles.botRequests, value: formatNumber(crawlerRequests.current), subtitle: crawlerDelta ? <>{crawlerTrust} · {crawlerDelta}</> : crawlerTrust },
          { label: copy.client.tiles.userFetches, value: formatNumber(sa.aiUserFetchHits.current), subtitle: userFetchDelta ?? copy.client.userFetchFallback },
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
          {/* The HTML report has no section heading above these cards, so a
              real h3 here would sit two levels under the page title with
              nothing between. The outline hook is what parity reads. */}
          <p className="text-sm font-semibold text-heading" data-report-heading>{copy.queriesHeading}</p>
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
          <p className="text-sm font-semibold text-heading" data-report-heading>{copy.providerBarsHeading}</p>
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

function ActionPlanSection({ report, audience, dismissedRefs, onDismiss }: {
  report: ProjectReportDto
  audience: ReportAudience
  dismissedRefs: ReadonlySet<string>
  onDismiss: (action: ProjectReportDto['actionPlan'][number]) => void
}) {
  const dedupedActions = reportAudienceActions(report, audience)
  const isClient = audience === 'client'
  const sectionId = isClient ? ReportSectionIds['client-action-plan'] : ReportSectionIds['agency-action-plan']
  const copy = REPORT_SECTION_COPY[sectionId]
  // Filter through the page's optimistic set so the card goes on click, before
  // the server confirms. The set lives on ReportPage because this section is
  // unmounted by an audience switch. The server-side filter still applies on
  // the next refetch; this is purely a render-time bypass for the latency.
  const actions = dismissedRefs.size > 0
    ? dedupedActions.filter(action => !action.targetRef || !dismissedRefs.has(action.targetRef))
    : dedupedActions
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
                      onClick={() => onDismiss(action)}
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
                    <div className="mt-0.5 flex items-center gap-2 text-[13px] text-secondary">
                      {contentActionLabel(o.action)}
                      {o.winnabilityClass === WinnabilityClasses.ceded && <ToneBadge tone="caution">{copy.opportunities.cededTag}</ToneBadge>}
                    </div>
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
// One marked region per group of agency sections, each with its own import
// slot above. ReportSectionSlot renders every section by its function name
// with `{ report }` props, so keep both. Name a region's private helpers after
// its section, so regions never collide.

// ── report slice S1: agency overview ──
/**
 * The left-border accent of an insight card, by tone. Neutral keeps the base
 * card's accent. The card carries no full border: a `border` or
 * `border-default` utility outranks these component rules and would erase the
 * accent.
 */
const OVERVIEW_INSIGHT_TONE_CLASS: Readonly<Record<MetricTone, string>> = {
  positive: 'insight-card-positive',
  caution: 'insight-card-caution',
  negative: 'insight-card-negative',
  neutral: '',
}

function overviewInsightCardClass(tone: MetricTone, layout: string): string {
  return ['insight-card', OVERVIEW_INSIGHT_TONE_CLASS[tone], layout].filter(Boolean).join(' ')
}

/** The market scope warning: a caution insight card. */
const EXECUTIVE_SCOPE_WARNING_CLASS = overviewInsightCardClass('caution', 'gap-1 rounded-r-lg bg-caution-950/25 px-3 py-2')

/** Metric tile columns: the row stays full whether or not GSC and GA are connected. */
function executiveMetricColumns(count: number): 3 | 4 | 5 {
  return count >= 5 ? 5 : count === 4 ? 4 : 3
}

/** Executive summary: hero, proof tiles, metric tiles, findings, then market scope, in the HTML report's order. */
function AgencyExecutiveSummary({ report }: { report: ProjectReportDto }) {
  const summary = report.executiveSummary
  const copy = REPORT_SECTION_COPY['executive-summary']
  const headline = reportExecutiveHeadline(report)
  const proofTiles: ReportTile[] = [
    { label: copy.proofTiles.citationTrend, value: headline.trendLabel, tone: headline.trendTone, subtitle: headline.citedFragment },
    { label: copy.proofTiles.mentionCoverage, value: `${summary.mentionRate}%`, subtitle: headline.mentionedFragment },
    { label: copy.proofTiles.prioritizedActions, value: formatNumber(headline.prioritizedActionCount), subtitle: copy.prioritizedActionsCopy },
  ]
  const metricTiles: ReportTile[] = [
    {
      label: copy.tiles.citationRate,
      value: `${summary.citationRate}%`,
      subtitle: (
        <>
          <span className={TONE_INLINE_TEXT_CLASS[headline.trendTone] || undefined}>{headline.trendLabel}</span>
          {` · ${headline.citedFragment} · ${headline.providerCountLabel}`}
        </>
      ),
    },
    { label: copy.tiles.mentionRate, value: `${summary.mentionRate}%`, subtitle: headline.mentionedFragment },
    { label: copy.tiles.queriesTracked, value: formatNumber(summary.queryCount), subtitle: headline.competitorCountLabel },
  ]
  if (summary.gsc && headline.gscDelta !== null) {
    metricTiles.push({ label: copy.tiles.gscClicks, value: formatNumber(summary.gsc.clicks), subtitle: headline.gscDelta })
  }
  if (summary.ga && headline.gaDelta !== null) {
    metricTiles.push({ label: copy.tiles.gaSessions, value: formatNumber(summary.ga.sessions), subtitle: headline.gaDelta })
  }

  return (
    <ReportSection id={ReportSectionIds['executive-summary']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="rounded-xl border border-default bg-surface p-5">
          <p className="eyebrow-soft">{copy.heroKicker}</p>
          <p className="mt-2 text-xl font-semibold tracking-tight text-heading">{headline.title}</p>
          <p className="mt-2 text-sm text-secondary">{headline.subtitle}</p>
        </div>
        <ReportTiles columns={3} tiles={proofTiles} />
      </div>
      <div className="mt-3">
        <ReportTiles columns={executiveMetricColumns(metricTiles.length)} tiles={metricTiles} />
      </div>
      {summary.findings.length > 0 && (
        <div className="mt-4 grid gap-2">
          {summary.findings.map((finding, index) => (
            <div key={`${index}-${finding.title}`} className={overviewInsightCardClass(finding.tone, 'gap-1 rounded-r-lg bg-surface px-4 py-3')}>
              <strong className="text-sm font-semibold text-heading">{finding.title}</strong>
              <span className="text-[13px] text-secondary">{finding.detail}</span>
            </div>
          ))}
        </div>
      )}
      <ExecutiveMarketScope report={report} />
    </ReportSection>
  )
}

/** The market the check ran in, the configured markets it left out, and how providers received it. Absent with neither a market nor provider location data. */
function ExecutiveMarketScope({ report }: { report: ProjectReportDto }) {
  const scope = reportMarketScope(report)
  if (!scope) return null
  const copy = REPORT_SECTION_COPY['executive-summary'].marketScope
  return (
    <ReportCard title={copy.heading}>
      <div className="grid gap-3 sm:grid-cols-3">
        <ExecutiveMarketScopeTile label={copy.currentLabel} value={scope.currentValue} detail={copy.currentCopy} />
        <ExecutiveMarketScopeTile label={copy.notIncludedLabel} value={scope.notIncludedValue} detail={scope.notIncludedCopy} />
        <ExecutiveMarketScopeTile label={copy.providerLabel} value={scope.providerValue} detail={scope.providerCopy} />
      </div>
      {scope.weakProviders !== null && (
        <ReportNote className={EXECUTIVE_SCOPE_WARNING_CLASS}>
          <strong className="font-semibold text-heading">{copy.warningTitle}</strong>{' '}
          {scope.weakProviders} {copy.warningDetail}
        </ReportNote>
      )}
    </ReportCard>
  )
}

function ExecutiveMarketScopeTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-default bg-bg/40 px-3 py-2.5">
      <p className="eyebrow-soft" data-report-tile>{label}</p>
      <p className="text-lg font-semibold leading-tight text-heading">{value}</p>
      <p className="mt-1.5 text-[13px] text-secondary">{detail}</p>
    </div>
  )
}

/** Operator flags behind the action plan, one tone card each. The legacy location caveat stays hidden: market scope covers it. */
function AgencyDiagnostics({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['agency-diagnostics']
  const diagnostics = report.agencyDiagnostics.diagnostics.filter(diagnostic => diagnostic.title !== copy.hiddenTitle)
  return (
    <ReportSection id={ReportSectionIds['agency-diagnostics']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      {diagnostics.length === 0 ? (
        <EmptyHint message={copy.empty} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {diagnostics.map((diagnostic, index) => (
            <article key={`${index}-${diagnostic.title}`} className={overviewInsightCardClass(diagnostic.severity, 'gap-2 rounded-r-lg bg-surface p-4')}>
              <h3 className="text-sm font-semibold text-heading" data-report-heading>{diagnostic.title}</h3>
              <p className="text-sm text-secondary">{diagnostic.detail}</p>
              <ProofChips items={diagnostic.evidence} limit={3} className="mt-1" />
            </article>
          ))}
        </div>
      )}
    </ReportSection>
  )
}

/** Action items bucketed by timing. The horizon badge shows the raw value, as the HTML report does. */
function AgencyRecommendedNextSteps({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['recommended-next-steps']
  const steps = report.recommendedNextSteps
  return (
    <ReportSection id={ReportSectionIds['recommended-next-steps']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      {steps.length === 0 ? (
        <EmptyHint message={copy.empty} />
      ) : (
        <ol className="grid gap-2">
          {steps.map((step, index) => (
            <li key={`${index}-${step.title}`} className="flex items-start gap-3 rounded-lg border border-default bg-surface px-4 py-3">
              <ToneBadge tone="neutral" className="shrink-0">{step.horizon}</ToneBadge>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-heading">{step.title}</p>
                <p className="mt-0.5 text-[13px] text-secondary">{step.rationale}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </ReportSection>
  )
}
// ── end report slice S1 ──

// ── report slice S2: competitive evidence ──
type ScorecardData = ProjectReportDto['citationScorecard']
type ScorecardCellData = ScorecardData['matrix'][number][number]
type LandscapeMentions = ProjectReportDto['mentionLandscape']
type LandscapeCompetitor = ProjectReportDto['competitorLandscape']['competitors'][number]

function AgencyCitationScorecard({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['citation-scorecard']
  const scorecard = report.citationScorecard
  const series = REPORT_CHART_COLORS.series
  return (
    <ReportSection id={ReportSectionIds['citation-scorecard']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      <ReportBarChart
        title={copy.providerChartTitle}
        rows={scorecard.providerRates.map((rate, index) => ({
          label: rate.provider,
          value: rate.citationRate,
          color: series[index % series.length],
          valueLabel: reportProviderRateLabel(rate),
        }))}
        domainMax={Math.max(...scorecard.providerRates.map(rate => rate.citationRate), 100)}
        track
      />
      {scorecard.queries.length > 0 && scorecard.providers.length > 0
        ? <ScorecardMatrix scorecard={scorecard} />
        : <EmptyHint message={copy.empty} />}
    </ReportSection>
  )
}

/** The query × provider matrix under its glyph legend. */
function ScorecardMatrix({ scorecard }: { scorecard: ScorecardData }) {
  const { queryHeader, glyphs, legend } = REPORT_SECTION_COPY['citation-scorecard']
  return (
    <ReportTableBlock
      headers={[queryHeader, ...scorecard.providers]}
      note={
        <ReportNote className="mb-2">
          {legend.lead}{' '}
          <ScorecardGlyph mark="yes">{glyphs.cited}</ScorecardGlyph>/<ScorecardGlyph mark="no">{glyphs.notCited}</ScorecardGlyph>{' '}
          {legend.citedMeaning}{' '}
          <ScorecardGlyph mark="yes">{glyphs.mentioned}</ScorecardGlyph>/<ScorecardGlyph mark="no">{glyphs.notMentioned}</ScorecardGlyph>{' '}
          {legend.mentionedMeaning}{' '}
          <ScorecardGlyph mark="pending">{glyphs.pending}</ScorecardGlyph>{' '}
          {legend.pendingMeaning}
        </ReportNote>
      }
    >
      {scorecard.queries.map((query, queryIndex) => (
        <tr key={`${queryIndex}-${query}`}>
          <td className="evidence-query-cell">{query}</td>
          {scorecard.providers.map((provider, providerIndex) => (
            <td key={`${providerIndex}-${provider}`} className="whitespace-nowrap font-mono text-[13px]">
              <ScorecardCell cell={scorecard.matrix.at(queryIndex)?.at(providerIndex) ?? null} />
            </td>
          ))}
        </tr>
      ))}
    </ReportTableBlock>
  )
}

const SCORECARD_MARK_CLASS = {
  yes: `font-semibold ${TONE_TEXT_CLASS.positive}`,
  no: 'text-secondary',
  pending: 'italic text-secondary',
} as const

function ScorecardGlyph({ mark, children }: { mark: keyof typeof SCORECARD_MARK_CLASS; children: ReactNode }) {
  return <span className={SCORECARD_MARK_CLASS[mark]}>{children}</span>
}

/**
 * Citation glyph, then mention glyph: the two signals are independent, so a
 * cell never folds them into one label. Only a cited state reads C, an answer
 * with no mention verdict reads –, and a pair with no snapshot reads — —.
 */
function ScorecardCell({ cell }: { cell: ScorecardCellData }) {
  const { glyphs } = REPORT_SECTION_COPY['citation-scorecard']
  if (!cell) return <ScorecardGlyph mark="pending">{glyphs.missingCell}</ScorecardGlyph>
  const cited = cell.citationState === CitationStates.cited
  return (
    <>
      <ScorecardGlyph mark={cited ? 'yes' : 'no'}>{cited ? glyphs.cited : glyphs.notCited}</ScorecardGlyph>{' '}
      {cell.answerMentioned === null
        ? <ScorecardGlyph mark="pending">{glyphs.pending}</ScorecardGlyph>
        : <ScorecardGlyph mark={cell.answerMentioned ? 'yes' : 'no'}>{cell.answerMentioned ? glyphs.mentioned : glyphs.notMentioned}</ScorecardGlyph>}
    </>
  )
}

function AgencyCompetitorLandscape({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['competitor-landscape']
  const { competitors, projectCitationCount } = report.competitorLandscape
  const mentions = report.mentionLandscape
  // `canonry report` renders whatever payload the API returned, and an older
  // server sends no class split. The HTML report reads that as no branded data.
  const branded = mentions.branded as LandscapeMentions['branded'] | undefined
  const nonBrand = mentions.nonBrand as LandscapeMentions['nonBrand'] | undefined
  const hasBrandedAnswers = (branded?.totalAnswerSnapshots ?? 0) > 0
  const noCitationData = competitors.length === 0 && projectCitationCount === 0
  const noMentionData = mentions.competitors.length === 0 && mentions.projectMentionCount === 0 && !hasBrandedAnswers
  if (noCitationData && noMentionData) {
    return (
      <ReportSection id={ReportSectionIds['competitor-landscape']} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={copy.empty} />
      </ReportSection>
    )
  }

  const canonicalDomain = report.meta.project.canonicalDomain
  const mentionCopy = reportCompetitorMentionCopy(mentions)
  const citationRows = landscapeChartRows(canonicalDomain, projectCitationCount, competitors.map(row => ({ domain: row.domain, count: row.citationCount })))
  const mentionRows = landscapeChartRows(canonicalDomain, mentions.projectMentionCount, mentions.competitors.map(row => ({ domain: row.domain, count: row.mentionCount })))
  // Branded recall gets its own labelled chart and is never added into the competitive one.
  const brandedRows = branded && hasBrandedAnswers
    ? landscapeChartRows(canonicalDomain, branded.projectMentionCount, branded.competitors.map(row => ({ domain: row.domain, count: row.mentionCount })))
    : []
  const mentionShareUnavailable = !nonBrand?.shareOfVoice
    && mentions.projectMentionCount === 0
    && mentions.competitors.length > 0
    && mentions.competitors.every(row => row.sharePct === null)
  const citationChart = <LandscapeChart title={copy.citationsChartTitle} rows={citationRows} />
  const mentionChart = <LandscapeChart title={mentionCopy.mentionsChartTitle} rows={mentionRows} />

  return (
    <ReportSection id={ReportSectionIds['competitor-landscape']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      {mentionShareUnavailable ? <ReportNote>{mentionCopy.mentionShareUnavailable}</ReportNote> : null}
      {citationRows.length > 0 && mentionRows.length > 0
        ? <div className="grid gap-x-4 lg:grid-cols-2">{citationChart}{mentionChart}</div>
        : <>{citationChart}{mentionChart}</>}
      {competitors.length > 0
        ? <LandscapeTable report={report} mentionCopy={mentionCopy} />
        : <EmptyHint message={copy.noCompetitors} />}
      {brandedRows.length > 0 ? (
        <div className="mt-4">
          <ReportNote>{mentionCopy.brandedNote}</ReportNote>
          <LandscapeChart title={copy.brandedChartTitle} rows={brandedRows} />
        </div>
      ) : null}
    </ReportSection>
  )
}

/**
 * The project's bar first in the accent color, then one bar per competitor in
 * the palette colors after it, as the HTML report draws them. A chart with only
 * the project's bar compares nothing, so it gets no rows and is left out.
 */
function landscapeChartRows(
  canonicalDomain: string,
  projectCount: number,
  competitors: readonly { domain: string; count: number }[],
): ReportBarChartRow[] {
  if (competitors.length === 0) return []
  const series = REPORT_CHART_COLORS.series
  return [
    { label: canonicalDomain, value: projectCount, color: series[1], valueLabel: String(projectCount) },
    // The project is bar 0, so competitor `index` is bar index + 1, drawn in series[(bar + 1) % 8].
    ...competitors.map((competitor, index) => ({
      label: competitor.domain,
      value: competitor.count,
      color: series[(index + 2) % series.length],
      valueLabel: String(competitor.count),
    })),
  ]
}

function LandscapeChart({ title, rows }: { title: string; rows: readonly ReportBarChartRow[] }) {
  return <ReportBarChart title={title} rows={rows} rowHeight={28} labelWidth={160} />
}

/** One row per competitor. Its mentions come from the class-scoped mention landscape, matched by domain. */
function LandscapeTable({ report, mentionCopy }: { report: ProjectReportDto; mentionCopy: ReportCompetitorMentionCopy }) {
  const copy = REPORT_SECTION_COPY['competitor-landscape']
  const mentions = report.mentionLandscape
  const mentionByDomain = new Map(mentions.competitors.map(row => [row.domain, row]))
  return (
    <ReportTableBlock
      headers={[
        copy.headers.domain,
        copy.headers.pressure,
        { label: copy.headers.citations, numeric: true },
        { label: mentionCopy.mentionsHeader, numeric: true, tooltip: mentionCopy.mentionsTooltip },
        { label: copy.headers.citationShare, numeric: true, tooltip: copy.citationShareTooltip },
        copy.headers.citedQueries,
      ]}
    >
      {report.competitorLandscape.competitors.map((competitor, index) => {
        const mention = mentionByDomain.get(competitor.domain)
        return (
          <tr key={`${index}-${competitor.domain}`}>
            <td className="evidence-query-cell">{competitor.domain}</td>
            <td><ToneBadge tone={reportPressureTone(competitor.pressureLabel)}>{competitor.pressureLabel}</ToneBadge></td>
            <td className="whitespace-nowrap text-right tabular-nums">{competitor.citationCount} / {competitor.totalCount}</td>
            <td className="whitespace-nowrap text-right tabular-nums">{mention?.mentionCount ?? 0} / {mention?.totalCount ?? mentions.totalAnswerSnapshots}</td>
            <td className="text-right tabular-nums">{competitor.sharePct}%</td>
            <td className="min-w-48">
              {reportTruncatedList(competitor.citedQueries, 5)}
              {competitor.theirCitedPages.length > 0 ? <LandscapeCitedPages pages={competitor.theirCitedPages} /> : null}
            </td>
          </tr>
        )
      })}
    </ReportTableBlock>
  )
}

/** A competitor's cited URLs behind a disclosure. An unsafe URL keeps its text, and its link goes nowhere. */
function LandscapeCitedPages({ pages }: { pages: LandscapeCompetitor['theirCitedPages'] }) {
  return (
    <details className="mt-2 text-[13px] text-secondary">
      <summary className="cursor-pointer rounded-sm text-secondary hover:text-neutral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500/60">{reportCitedUrlCount(pages.length)}</summary>
      <ul className="mt-2 space-y-1">
        {pages.map((page, index) => (
          <li key={`${index}-${page.url}`} className="break-all">
            <ReportExternalLink href={page.url}>{page.url}</ReportExternalLink>{' '}
            <span className="text-secondary">{page.citedFor.join(', ')}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function AgencyAiSourceOrigin({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['ai-source-origin']
  const origin = report.aiSourceOrigin
  if (origin.categories.length === 0 && origin.topDomains.length === 0) {
    return (
      <ReportSection id={ReportSectionIds['ai-source-origin']} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={copy.empty} />
      </ReportSection>
    )
  }
  const headline = reportSourceOriginHeadline(origin.categories)
  const [domainHeader, citationsHeader, tagHeader] = copy.topSourceHeaders
  return (
    <ReportSection id={ReportSectionIds['ai-source-origin']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      {headline ? <ReportNote><strong className="font-semibold text-heading">{headline.share}</strong> {headline.detail}</ReportNote> : null}
      {origin.topDomains.length > 0 ? (
        <ReportTableBlock title={copy.topSourcesHeading} headers={[domainHeader, { label: citationsHeader, numeric: true }, tagHeader]}>
          {origin.topDomains.map((source, index) => (
            <tr key={`${index}-${source.domain}`}>
              <td className="evidence-query-cell">{source.domain}</td>
              <td className="text-right tabular-nums">{source.count}</td>
              <td>
                {source.isCompetitor
                  ? <ToneBadge tone="negative">{copy.trackedCompetitorTag}</ToneBadge>
                  : <ToneBadge tone="neutral">{copy.externalTag}</ToneBadge>}
              </td>
            </tr>
          ))}
        </ReportTableBlock>
      ) : null}
      <ShareBars
        title={copy.categoriesHeading}
        scale="max"
        rows={origin.categories.map(category => ({
          label: category.label,
          count: category.count,
          sharePct: category.sharePct,
          color: sourceOriginBarColor(reportSourceCategoryTone(category.category)),
          valueLabel: `${category.count} ${reportSourceCategoryShareLabel(category.sharePct)}`,
        }))}
      />
    </ReportSection>
  )
}

/** A source-type bar color, picked as the HTML report picks it: its accent color for any source it does not flag. */
function sourceOriginBarColor(tone: MetricTone): string {
  const colors: Readonly<Record<MetricTone, string>> = {
    negative: REPORT_CHART_COLORS.tone.negative,
    caution: REPORT_CHART_COLORS.tone.caution,
    positive: REPORT_CHART_COLORS.series[1],
    neutral: REPORT_CHART_COLORS.series[1],
  }
  return colors[tone]
}
// ── end report slice S2 ──

// ── report slice S3: search and traffic ──
// Mirrors renderGsc, renderGa, renderSocial and renderAiReferrals in the HTML
// report: the same blocks in the same order, each shown under the same
// condition. A section without its data source shows only its empty state.

/** A GSC crossover card lists this many queries, then `+N more`. */
const GSC_CROSSOVER_CHIP_LIMIT = 6

function AgencyGscPerformance({ report }: { report: ProjectReportDto }) {
  const gsc = report.gsc
  const copy = REPORT_SECTION_COPY.gsc
  if (!gsc) {
    return (
      <ReportSection id={ReportSectionIds.gsc} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={copy.empty} />
      </ReportSection>
    )
  }
  const [queryHeader, clicksHeader, impressionsHeader, ctrHeader, positionHeader, categoryHeader] = copy.topQueryHeaders
  return (
    <ReportSection id={ReportSectionIds.gsc} eyebrow={copy.eyebrow} title={copy.title} intro={reportGscIntro(report)}>
      <ReportTiles
        columns={4}
        tiles={[
          { label: copy.tiles.clicks, value: formatNumber(gsc.totalClicks) },
          { label: copy.tiles.impressions, value: formatNumber(gsc.totalImpressions) },
          { label: copy.tiles.ctr, value: formatRatio(gsc.ctr) },
          { label: copy.tiles.position, value: gsc.avgPosition.toFixed(1) },
        ]}
      />
      <ReportLineChart
        title={copy.trendTitle}
        data={gsc.trend}
        xKey="date"
        dataKey="clicks"
        color={REPORT_CHART_COLORS.series[1]}
        formatValue={formatNumber}
        dates="calendar"
      />
      <ReportTableBlock
        title={copy.topQueriesHeading}
        headers={[
          queryHeader,
          { label: clicksHeader, numeric: true },
          { label: impressionsHeader, numeric: true },
          { label: ctrHeader, numeric: true },
          { label: positionHeader, numeric: true },
          categoryHeader,
        ]}
      >
        {gsc.topQueries.map((row, index) => (
          <tr key={`${index}-${row.query}`}>
            <td className="evidence-query-cell">{row.query}</td>
            <td className="text-right tabular-nums">{formatNumber(row.clicks)}</td>
            <td className="text-right tabular-nums">{formatNumber(row.impressions)}</td>
            <td className="text-right tabular-nums">{formatRatio(row.ctr)}</td>
            <td className="text-right tabular-nums">{row.avgPosition.toFixed(1)}</td>
            <td><ToneBadge tone="neutral">{row.category}</ToneBadge></td>
          </tr>
        ))}
      </ReportTableBlock>
      <ShareBars
        title={copy.intentHeading}
        scale="share"
        rows={searchTrafficShareBarRows(
          gsc.categoryBreakdown.map(row => ({ label: row.category, count: row.clicks, sharePct: row.sharePct })),
          copy.intentCountLabel,
        )}
      />
      <GscCrossoverCard title={copy.untrackedDemand.heading} note={copy.untrackedDemand.subtitle} queries={gsc.trackedButNoGsc} />
      <GscCrossoverCard title={copy.suggestedQueries.heading} note={copy.suggestedQueries.subtitle} queries={gsc.gscButNotTracked} />
    </ReportSection>
  )
}

/** Tracked queries with no search demand, or searched queries not yet tracked. Nothing renders for an empty list. */
function GscCrossoverCard({ title, note, queries }: { title: string; note: string; queries: readonly string[] }) {
  if (queries.length === 0) return null
  return (
    <ReportCard title={title}>
      <ReportNote>{note}</ReportNote>
      <ProofChips items={queries} limit={GSC_CROSSOVER_CHIP_LIMIT} className="mt-3" />
    </ReportCard>
  )
}

function AgencyGaTraffic({ report }: { report: ProjectReportDto }) {
  const ga = report.ga
  const copy = REPORT_SECTION_COPY.ga
  if (!ga) {
    return (
      <ReportSection id={ReportSectionIds.ga} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={copy.empty} />
      </ReportSection>
    )
  }
  const [pageHeader, sessionsHeader, organicHeader] = copy.topPageHeaders
  return (
    <ReportSection id={ReportSectionIds.ga} eyebrow={copy.eyebrow} title={copy.title} intro={reportGaIntro(ga)}>
      <ReportTiles
        columns={3}
        tiles={[
          { label: copy.tiles.sessions, value: formatNumber(ga.totalSessions) },
          { label: copy.tiles.users, value: formatNumber(ga.totalUsers) },
          { label: copy.tiles.organicSessions, value: formatNumber(ga.totalOrganicSessions) },
        ]}
      />
      <ReportTableBlock
        title={copy.topPagesHeading}
        headers={[pageHeader, { label: sessionsHeader, numeric: true }, { label: organicHeader, numeric: true }]}
      >
        {ga.topLandingPages.map((row, index) => (
          <tr key={`${index}-${row.page}`}>
            <td><LandingPageCell page={row.page} /></td>
            <td className="text-right tabular-nums">{formatNumber(row.sessions)}</td>
            <td className="text-right tabular-nums">{formatNumber(row.organicSessions)}</td>
          </tr>
        ))}
      </ReportTableBlock>
      <ShareBars
        title={copy.channelsHeading}
        scale="share"
        rows={searchTrafficShareBarRows(
          ga.channelBreakdown.map(row => ({ label: row.channel, count: row.sessions, sharePct: row.sharePct })),
          copy.channelsCountLabel,
        )}
      />
    </ReportSection>
  )
}

function AgencySocialReferrals({ report }: { report: ProjectReportDto }) {
  const social = report.socialReferrals
  const copy = REPORT_SECTION_COPY['social-referrals']
  if (!social) {
    return (
      <ReportSection id={ReportSectionIds['social-referrals']} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={copy.empty} />
      </ReportSection>
    )
  }
  const [sourceHeader, mediumHeader, sessionsHeader] = copy.campaignHeaders
  // Unlike GA, the channel bars come before the table, and the table renders even with no campaigns.
  return (
    <ReportSection id={ReportSectionIds['social-referrals']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      <ReportTiles
        columns={3}
        tiles={[
          { label: copy.tiles.sessions, value: formatNumber(social.totalSessions) },
          { label: copy.tiles.organic, value: formatNumber(social.organicSessions) },
          { label: copy.tiles.paid, value: formatNumber(social.paidSessions) },
        ]}
      />
      <ShareBars
        title={copy.channelsHeading}
        scale="share"
        rows={searchTrafficShareBarRows(
          social.channels.map(row => ({ label: row.channelGroup, count: row.sessions, sharePct: row.sharePct })),
          copy.channelsCountLabel,
        )}
      />
      <ReportTableBlock
        title={copy.campaignsHeading}
        headers={[sourceHeader, mediumHeader, { label: sessionsHeader, numeric: true }]}
      >
        {social.topCampaigns.map((row, index) => (
          <tr key={`${index}-${row.source}-${row.medium}`}>
            <td className="evidence-query-cell">{row.source}</td>
            <td className="text-[13px] text-secondary">{row.medium}</td>
            <td className="text-right tabular-nums">{formatNumber(row.sessions)}</td>
          </tr>
        ))}
      </ReportTableBlock>
    </ReportSection>
  )
}

function AgencyAiReferrals({ report }: { report: ProjectReportDto }) {
  const ai = report.aiReferrals
  const copy = REPORT_SECTION_COPY['ai-referrals']
  if (!ai) {
    return (
      <ReportSection id={ReportSectionIds['ai-referrals']} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={copy.empty} />
      </ReportSection>
    )
  }
  const [pageHeader, sessionsHeader] = copy.topPageHeaders
  // Sessions only: the DTO carries no truthful AI-referral user count.
  return (
    <ReportSection id={ReportSectionIds['ai-referrals']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      <ReportTiles columns={3} tiles={[{ label: copy.tiles.sessions, value: formatNumber(ai.totalSessions) }]} />
      <ReportLineChart
        title={copy.trendTitle}
        data={ai.trend}
        xKey="date"
        dataKey="sessions"
        color={REPORT_CHART_COLORS.series[2]}
        formatValue={formatNumber}
        dates="calendar"
      />
      <ShareBars
        title={copy.sourcesHeading}
        scale="share"
        rows={searchTrafficShareBarRows(
          ai.bySource.map(row => ({ label: row.source, count: row.sessions, sharePct: row.sharePct })),
          copy.sourcesCountLabel,
          2,
        )}
      />
      <ReportTableBlock title={copy.topPagesHeading} headers={[pageHeader, { label: sessionsHeader, numeric: true }]}>
        {ai.topLandingPages.map((row, index) => (
          <tr key={`${index}-${row.page}`}>
            <td><LandingPageCell page={row.page} /></td>
            <td className="text-right tabular-nums">{formatNumber(row.sessions)}</td>
          </tr>
        ))}
      </ReportTableBlock>
    </ReportSection>
  )
}

/**
 * Share bars for a traffic breakdown, drawn the way the HTML report draws them:
 * each row keeps the series color of its position in the breakdown (starting
 * `colorOffset` colors in), so dropping an empty row never recolors the rest,
 * and the text after the bar reads `8.0K sessions · 67%`.
 */
function searchTrafficShareBarRows(
  rows: readonly { label: string; count: number; sharePct: number }[],
  countLabel: string,
  colorOffset = 0,
): ShareBarRow[] {
  const palette = REPORT_CHART_COLORS.series
  return rows.map((row, index) => ({
    ...row,
    color: palette[(index + colorOffset) % palette.length],
    valueLabel: (
      <>
        <span className="font-medium text-heading">{formatNumber(row.count)}</span>{' '}
        {reportShareBarShareLabel(countLabel, row.sharePct)}
      </>
    ),
  }))
}
// ── end report slice S3 ──

// ── report slice S4: server-side, indexing and trend ──
/**
 * The agency's full server-side view, in the HTML report's order: four window
 * tiles, the verified crawl trend, then the operator, crawled path, product and
 * landing tables. The window is the report period, as in the HTML report.
 */
function AgencyServerActivity({ report }: { report: ProjectReportDto }) {
  const sa = report.serverActivity
  const windowDays = report.meta.periodDays
  const copy = REPORT_SECTION_COPY['server-activity']
  const agency = copy.agency
  // Unlike the client view, the agency view keeps the section before a source
  // is connected or synced: the operator is the reader who can act on it.
  if (!sa?.hasData) {
    return (
      <ReportSection {...reportServerActivityHeading('agency', false, windowDays)}>
        <EmptyHint message={sa ? agency.empty : agency.emptyNotConnected} />
      </ReportSection>
    )
  }

  const priorWindowLabel = reportPriorWindowLabel(windowDays)
  const tiles = reportServerActivityAgencyTiles(windowDays)
  const [operatorHeader, verifiedHeader, unverifiedHeader, userFetchesHeader, referralSessionsHeader, deltaHeader] = reportServerActivityAgencyOperatorHeaders(windowDays)
  const [crawledPathHeader, hitsHeader, verifiedHitsHeader, operatorCountHeader] = agency.crawledPathHeaders
  const [productHeader, productSessionsHeader, landingPathCountHeader] = agency.referralProductHeaders
  const [landingPathHeader, landingSessionsHeader, productCountHeader] = agency.referralLandingHeaders
  // Referral arrivals mix paid and organic clicks, and arrivals lost to
  // redirects are named rather than hidden: the HTML report's fragments, in its order.
  const referralParts = [
    serverActivityDelta(sa.referralArrivals, copy.countNouns.sessions, priorWindowLabel),
    sa.referralArrivalsClassSummary,
    reportReferralRedirectNote(sa.referralRedirects),
  ]

  return (
    <ReportSection {...reportServerActivityHeading('agency', true, windowDays)}>
      <ReportTiles
        columns={4}
        tiles={[
          { label: tiles.verified, value: formatNumber(sa.verifiedCrawlerHits.current), subtitle: serverActivityDelta(sa.verifiedCrawlerHits, copy.countNouns.hits, priorWindowLabel) },
          { label: tiles.unverified, value: formatNumber(sa.unverifiedCrawlerHits.current), subtitle: serverActivityDelta(sa.unverifiedCrawlerHits, copy.countNouns.hits, priorWindowLabel) },
          { label: tiles.userFetches, value: formatNumber(sa.aiUserFetchHits.current), subtitle: serverActivityDelta(sa.aiUserFetchHits, copy.countNouns.hits, priorWindowLabel) },
          {
            label: tiles.referralSessions,
            value: formatNumber(sa.referralArrivals.current),
            subtitle: joinReportParts(referralParts),
          },
        ]}
      />
      <ReportLineChart
        title={reportServerActivityTrendTitle(windowDays)}
        data={sa.dailyTrend}
        xKey="date"
        dataKey="verifiedCrawlerHits"
        color={REPORT_CHART_COLORS.series[1]}
        formatValue={formatNumber}
        dates="calendar"
      />
      {sa.byOperator.length > 0 && (
        <ReportTableBlock
          title={agency.operatorsHeading}
          tooltip={agency.operatorsNote}
          headers={[
            operatorHeader,
            { label: verifiedHeader, numeric: true },
            { label: unverifiedHeader, numeric: true },
            { label: userFetchesHeader, numeric: true },
            { label: referralSessionsHeader, numeric: true },
            { label: deltaHeader, numeric: true },
          ]}
        >
          {sa.byOperator.map(operator => (
            <tr key={operator.operator}>
              <td className="evidence-query-cell">{operator.operator}</td>
              <td className="text-right tabular-nums">{formatNumber(operator.verifiedHits)}</td>
              <td className="text-right tabular-nums text-secondary">{formatNumber(operator.unverifiedHits)}</td>
              <td className="text-right tabular-nums">{formatNumber(operator.userFetchHits)}</td>
              <td className="text-right tabular-nums">{formatNumber(operator.referralArrivals)}</td>
              <td className={`text-right tabular-nums ${operator.deltaPct === null ? '' : TONE_INLINE_TEXT_CLASS[deltaTone(operator.deltaPct)]}`}>
                {reportServerActivityOperatorDelta(operator.deltaPct)}
              </td>
            </tr>
          ))}
        </ReportTableBlock>
      )}
      {sa.topCrawledPaths.length > 0 && (
        <ReportTableBlock
          title={agency.crawledPathsHeading}
          note={<ReportNote className="mb-2">{reportServerActivityCrawledPathsNote(windowDays)}</ReportNote>}
          headers={[crawledPathHeader, { label: hitsHeader, numeric: true }, { label: verifiedHitsHeader, numeric: true }, { label: operatorCountHeader, numeric: true }]}
        >
          {sa.topCrawledPaths.map((path, index) => (
            <tr key={`${index}-${path.path}`}>
              <td><LandingPageCell page={path.path} /></td>
              <td className="text-right tabular-nums">{formatNumber(reportServerActivityPathHits(path))}</td>
              <td className="text-right tabular-nums text-secondary">{formatNumber(path.verifiedHits)}</td>
              <td className="text-right tabular-nums">{path.distinctOperators}</td>
            </tr>
          ))}
        </ReportTableBlock>
      )}
      {sa.referralProducts.length > 0 && (
        <ReportTableBlock
          title={agency.referralProductsHeading}
          note={<ReportNote className="mb-2">{agency.referralProductsNote}</ReportNote>}
          headers={[productHeader, { label: productSessionsHeader, numeric: true }, { label: landingPathCountHeader, numeric: true }]}
        >
          {sa.referralProducts.map(product => (
            <tr key={product.product}>
              <td className="evidence-query-cell">{product.product}</td>
              <td className="text-right tabular-nums">{formatNumber(product.arrivals)}</td>
              <td className="text-right tabular-nums">{product.distinctLandingPaths}</td>
            </tr>
          ))}
        </ReportTableBlock>
      )}
      {sa.topReferralLandingPaths.length > 0 && (
        <ReportTableBlock
          title={agency.referralLandingHeading}
          headers={[landingPathHeader, { label: landingSessionsHeader, numeric: true }, { label: productCountHeader, numeric: true }]}
        >
          {sa.topReferralLandingPaths.map((landing, index) => (
            <tr key={`${index}-${landing.path}`}>
              <td><LandingPageCell page={landing.path} /></td>
              <td className="text-right tabular-nums">{formatNumber(landing.arrivals)}</td>
              <td className="text-right tabular-nums">{landing.distinctProducts}</td>
            </tr>
          ))}
        </ReportTableBlock>
      )}
    </ReportSection>
  )
}

interface IndexingCoverageSegment {
  key: 'indexed' | 'notIndexed' | 'deindexed' | 'unknown'
  label: string
  count: number
  /** A REPORT_CHART_COLORS tone. */
  color: string
}

/** Indexing coverage from the connected search console: three tiles, then a stacked coverage bar and its legend. */
function AgencyIndexingHealth({ report }: { report: ProjectReportDto }) {
  const health = report.indexingHealth
  const copy = REPORT_SECTION_COPY['indexing-health']
  if (!health) {
    return (
      <ReportSection id={ReportSectionIds['indexing-health']} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={copy.empty} />
      </ReportSection>
    )
  }
  const coverage: IndexingCoverageSegment[] = [
    { key: 'indexed', label: copy.segments.indexed, count: health.indexed, color: REPORT_CHART_COLORS.tone.positive },
    { key: 'notIndexed', label: copy.segments.notIndexed, count: health.notIndexed, color: REPORT_CHART_COLORS.tone.caution },
    { key: 'deindexed', label: copy.segments.deindexed, count: health.deindexed, color: REPORT_CHART_COLORS.tone.negative },
    { key: 'unknown', label: copy.segments.unknown, count: health.unknown, color: REPORT_CHART_COLORS.tone.neutral },
  ]
  // A state with no pages draws no segment and names no legend entry, as in the HTML report.
  const segments = coverage.filter(segment => segment.count > 0)
  return (
    <ReportSection id={ReportSectionIds['indexing-health']} eyebrow={copy.eyebrow} title={copy.title} intro={reportIndexingIntro(health.provider)}>
      <ReportTiles
        columns={3}
        tiles={[
          { label: copy.tiles.indexed, value: formatNumber(health.indexed), tone: 'positive' },
          { label: copy.tiles.total, value: formatNumber(health.total) },
          { label: copy.tiles.share, value: `${health.indexedPct}%` },
        ]}
      />
      <ReportCard title={copy.coverageHeading}>
        <IndexingCoverageBar label={copy.coverageLabel} segments={segments} />
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-secondary">
          {segments.map(segment => (
            <li key={segment.key} className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: segment.color }} />
              {reportIndexingLegendLabel(segment.label, segment.count)}
            </li>
          ))}
        </ul>
      </ReportCard>
    </ReportSection>
  )
}

/** One full-width stacked bar with a segment per coverage state, both axes hidden. */
function IndexingCoverageBar({ label, segments }: { label: string; segments: readonly IndexingCoverageSegment[] }) {
  const row = Object.fromEntries(segments.map(segment => [segment.key, segment.count]))
  return (
    <div role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height={28}>
        <BarChart data={[row]} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0} accessibilityLayer={false}>
          <XAxis type="number" domain={[0, 'dataMax']} hide />
          <YAxis type="category" hide />
          {segments.map(segment => (
            <Bar key={segment.key} dataKey={segment.key} stackId="coverage" fill={segment.color} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Citation coverage across recent checks, charted once there are enough checks to read as a trend. */
function AgencyCitationsTrend({ report }: { report: ProjectReportDto }) {
  const trend = report.citationsTrend
  const copy = REPORT_SECTION_COPY['citations-trend']
  const id = ReportSectionIds['citations-trend']
  // Too few checks for a trend: the HTML report prints the empty or baseline state alone, with no intro.
  if (isTrendBaseline(trend)) {
    return (
      <ReportSection id={id} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={trend.length === 0 ? copy.empty : reportCitationsTrendBaseline(trend.length)} />
      </ReportSection>
    )
  }
  const [checkHeader, citedQueriesHeader, engineRatesHeader] = copy.breakdownHeaders
  return (
    <ReportSection id={id} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      {/* A check's date is when its run finished: a real instant, localized for the viewer. */}
      <ReportLineChart
        title={copy.chartTitle}
        data={trend}
        xKey="date"
        dataKey="citationRate"
        color={REPORT_CHART_COLORS.tone.positive}
        height={220}
        formatValue={value => `${value}%`}
        dates="observed"
      />
      <ReportTableBlock title={copy.breakdownHeading} headers={[checkHeader, { label: citedQueriesHeader, numeric: true }, engineRatesHeader]}>
        {trend.map(point => (
          <tr key={point.runId}>
            <td>{formatDate(point.date)}</td>
            <td className="text-right tabular-nums">
              {point.citationRate}% <span className="text-muted">({point.citedQueryCount}/{point.totalQueryCount})</span>
            </td>
            <td>{reportTrendProviderRates(point.providerRates)}</td>
          </tr>
        ))}
      </ReportTableBlock>
    </ReportSection>
  )
}
// ── end report slice S4 ──

// ── report slice S5: insights and content ──
/**
 * Insights & Alerts. The API has already deduped insights and counts repeats
 * in `instanceCount`, so rows render as given. The table keeps the HTML
 * report's fixed column widths and 680px minimum width.
 */
function AgencyInsights({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY.insights
  if (report.insights.length === 0) {
    return (
      <ReportSection id={ReportSectionIds.insights} eyebrow={copy.eyebrow} title={copy.title}>
        <EmptyHint message={copy.empty} />
      </ReportSection>
    )
  }
  const [severityHeader, titleHeader, queryHeader, providerHeader, recommendationHeader] = copy.headers
  return (
    <ReportSection id={ReportSectionIds.insights} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      <ReportTableBlock
        headers={[
          { label: severityHeader, className: 'w-24' },
          { label: titleHeader, className: 'w-[28%]' },
          { label: queryHeader, className: 'w-[18%]' },
          { label: providerHeader, className: 'w-[88px]' },
          { label: recommendationHeader, className: 'w-auto' },
        ]}
        tableClassName="table-fixed min-w-[680px]"
      >
        {report.insights.map(insight => (
          <tr key={insight.id}>
            <td className="align-top">
              <ToneBadge tone={reportSeverityTone(insight.severity)}>{reportSeverityLabel(insight.severity)}</ToneBadge>
            </td>
            <td className="evidence-query-cell break-words align-top">
              {insight.title}
              {insight.instanceCount > 1 && <ToneBadge tone="neutral" className="ml-2">{reportInstanceCountLabel(insight.instanceCount)}</ToneBadge>}
            </td>
            <td className="break-words align-top text-[13px] text-secondary">{insight.query}</td>
            <td className="break-words align-top text-[13px] text-secondary">{insight.provider}</td>
            <td className="break-words align-top text-[13px] text-secondary">
              {insight.recommendation ? insight.recommendation : <span className="text-muted">{copy.noRecommendation}</span>}
            </td>
          </tr>
        ))}
      </ReportTableBlock>
    </ReportSection>
  )
}

type ContentOpportunity = ProjectReportDto['contentOpportunities'][number]

/**
 * Content Opportunities: the top three as cards, then the top ten in a table,
 * both from the deduped list the HTML report uses. reportSectionOrder leaves
 * the section out when that list is empty.
 */
function AgencyContentOpportunities({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['content-opportunities']
  const opportunities = dedupeReportOpportunities(report)
  const canonicalDomain = report.meta.project.canonicalDomain
  const [queryHeader, actionHeader, winnabilityHeader, scoreHeader, whyHeader, ourPageHeader, winningHeader, confidenceHeader] = copy.headers
  return (
    <ReportSection id={ReportSectionIds['content-opportunities']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {opportunities.slice(0, 3).map((opportunity, index) => (
          <ContentOpportunityCard key={`${index}-${opportunity.targetRef}`} opportunity={opportunity} />
        ))}
      </div>
      <ReportTableBlock
        headers={[
          queryHeader,
          actionHeader,
          winnabilityHeader,
          { label: scoreHeader, numeric: true, tooltip: copy.scoreHeaderTooltip },
          whyHeader,
          ourPageHeader,
          winningHeader,
          confidenceHeader,
        ]}
      >
        {opportunities.slice(0, 10).map((opportunity, index) => (
          <ContentOpportunityRow key={`${index}-${opportunity.targetRef}`} opportunity={opportunity} canonicalDomain={canonicalDomain} />
        ))}
      </ReportTableBlock>
    </ReportSection>
  )
}

/** A highlight card: the rounded score out of 100, the query, the action line, and up to two drivers. */
function ContentOpportunityCard({ opportunity }: { opportunity: ContentOpportunity }) {
  const copy = REPORT_SECTION_COPY['content-opportunities']
  return (
    <article className="rounded-xl border border-default bg-surface p-4">
      <div className="mb-2.5 flex items-center gap-1.5">
        <p className="text-3xl font-extrabold leading-none tracking-tight tabular-nums text-heading">
          {Math.round(opportunity.score)}
          <span className="ml-1 text-sm font-semibold text-muted">{copy.scoreSuffix}</span>
        </p>
        <InfoTooltip text={copy.scoreCardTooltip} />
      </div>
      <h3 className="text-sm font-semibold text-heading" data-report-heading>{opportunity.query}</h3>
      <p className="mt-1 text-[13px] text-secondary">{reportOpportunityActionLine(opportunity)}</p>
      <ProofChips items={opportunity.drivers} limit={2} className="mt-3" />
    </article>
  )
}

/** One table row. Winnability is caution only when the cited surface is ceded; our page links on the project domain. */
function ContentOpportunityRow({ opportunity, canonicalDomain }: { opportunity: ContentOpportunity; canonicalDomain: string }) {
  const copy = REPORT_SECTION_COPY['content-opportunities']
  const ceded = opportunity.winnabilityClass === WinnabilityClasses.ceded
  return (
    <tr>
      <td className="evidence-query-cell">{opportunity.query}</td>
      <td><ToneBadge tone="neutral">{contentActionLabel(opportunity.action)}</ToneBadge></td>
      <td><ToneBadge tone={ceded ? 'caution' : 'neutral'}>{winnabilityClassLabel(opportunity.winnabilityClass)}</ToneBadge></td>
      <td className="text-right tabular-nums" title={copy.scoreHeaderTooltip}>{Math.round(opportunity.score)}</td>
      <td>
        {opportunity.drivers.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4 text-[13px] text-secondary">
            {opportunity.drivers.map((driver, index) => <li key={index}>{driver}</li>)}
          </ul>
        ) : (
          <span className="text-[13px] text-secondary">{copy.noDriverSignal}</span>
        )}
      </td>
      <td>
        {opportunity.ourBestPage ? (
          <ReportExternalLink href={absolutizeProjectUrl(opportunity.ourBestPage.url, canonicalDomain)} className="break-all text-[13px]">
            {opportunity.ourBestPage.url}
          </ReportExternalLink>
        ) : (
          <span className="text-[13px] text-secondary">{copy.noPage}</span>
        )}
      </td>
      <td>
        {opportunity.winningCompetitor ? (
          <ReportExternalLink href={opportunity.winningCompetitor.url} className="text-[13px]">
            {opportunity.winningCompetitor.domain}
          </ReportExternalLink>
        ) : (
          <span className="text-muted">{copy.noWinningCompetitor}</span>
        )}
      </td>
      <td><ToneBadge tone="neutral">{actionConfidenceLabel(opportunity.actionConfidence)}</ToneBadge></td>
    </tr>
  )
}

/** Content Gaps: the top ten, each naming its first five competitor domains. reportSectionOrder leaves the section out when there are none. */
function AgencyContentGaps({ report }: { report: ProjectReportDto }) {
  const copy = REPORT_SECTION_COPY['content-gaps']
  const [queryHeader, competitorsHeader, domainsHeader, missRateHeader] = copy.headers
  return (
    <ReportSection id={ReportSectionIds['content-gaps']} eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro}>
      <ReportTableBlock
        headers={[
          queryHeader,
          { label: competitorsHeader, numeric: true },
          domainsHeader,
          { label: missRateHeader, numeric: true },
        ]}
      >
        {report.contentGaps.slice(0, 10).map((gap, index) => (
          <tr key={`${index}-${gap.query}`}>
            <td className="evidence-query-cell">{gap.query}</td>
            <td className="text-right tabular-nums">{gap.competitorCount}</td>
            <td className="text-[13px] text-secondary">{reportCompactList(gap.competitorDomains, 5)}</td>
            <td className="text-right tabular-nums">{reportMissRateLabel(gap.missRate)}</td>
          </tr>
        ))}
      </ReportTableBlock>
    </ReportSection>
  )
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
                  // The tooltip trigger sits inside the cell, so without an
                  // explicit name the column would be announced as its label
                  // PLUS the whole tooltip sentence — on every data cell in it.
                  <th key={`${index}-${cell.label}`} className={className || undefined} aria-label={cell.tooltip ? cell.label : undefined}>
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
          // The `role="img"` wrapper above names this chart, so the chart's own
          // focusable role="application" surface would nest one inside it.
          accessibilityLayer={false}
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
          {/* The card's `role="img"` wrapper already names this chart; recharts'
              accessibility layer would nest a focusable role="application" svg
              inside it, and this chart has no tooltip to reach. */}
          <BarChart data={[...rows]} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 0 }} accessibilityLayer={false}>
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
        <span key={i} className="rounded-md border border-default bg-bg-elevated/40 px-2 py-0.5 text-[13px] text-neutral">
          {item}
        </span>
      ))}
      {more > 0 && (
        <span className="rounded-md border border-default bg-bg-elevated/40 px-2 py-0.5 text-[13px] text-secondary">
          {reportMoreChipLabel(more)}
        </span>
      )}
    </div>
  )
}

/** An empty state, in the HTML report's words. */
export function EmptyHint({ message }: { message: string }) {
  return <p className="py-4 text-center text-sm text-secondary" data-report-empty>{message}</p>
}
