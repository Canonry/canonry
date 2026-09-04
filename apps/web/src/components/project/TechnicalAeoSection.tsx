import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight, LoaderCircle, Play, RefreshCw, ScanSearch } from 'lucide-react'
import type { MetricTone } from '../../view-models.js'
import { RunKinds, type SiteAuditFactorSummaryDto, type SiteAuditPageDto } from '@ainyc/canonry-contracts'

import { heyClient, isEmbed } from '../../api.js'
import {
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditOptions,
  getApiV1ProjectsByNameTechnicalAeoOptions,
  getApiV1ProjectsByNameTechnicalAeoPagesOptions,
  getApiV1ProjectsByNameTechnicalAeoTrendOptions,
  getApiV1ProjectsByNameRunsOptions,
} from '@ainyc/canonry-api-client/react-query'
import {
  CartesianGrid,
  ComposedChart,
  Line,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_STYLE,
  CHART_TONE,
  formatObservedInstantLabel,
  formatObservedInstantTick,
  observedInstant,
} from '../shared/ChartPrimitives.js'
import { addToast } from '../../lib/toast-store.js'
import { Button } from '../ui/button.js'
import { WriteButton } from '../shared/AccessControls.js'
import { Card } from '../ui/card.js'
import {
  DataTablePagination,
  DataTableSearch,
  MiddleTruncatedText,
  urlSearchText,
  useClientTable,
} from '../shared/DataTableControls.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { useTriggerSiteAudit } from '../../queries/mutations.js'
import { getRunTrackerState, subscribeRunTracker } from '../../lib/run-tracker-store.js'
import { PageAuditEvidence } from './PageAuditEvidence.js'

const PAGES_FETCH_LIMIT = 100
const FACTOR_DRILLDOWN_PAGE_CAP = 12
const EMPTY_SITE_AUDIT_PAGES: SiteAuditPageDto[] = []

function siteAuditPageSearchText(page: SiteAuditPageDto): string {
  return urlSearchText(page.url)
}

function scoreTone(score: number): MetricTone {
  if (score >= 70) return 'positive'
  if (score >= 40) return 'caution'
  return 'negative'
}

function scoreTextClass(score: number): string {
  return score >= 70 ? 'text-positive-400' : score >= 40 ? 'text-caution-400' : 'text-negative-400'
}

function factorTone(status: SiteAuditFactorSummaryDto['status']): MetricTone {
  return status === 'pass' ? 'positive' : status === 'partial' ? 'caution' : 'negative'
}

// aeo-audit v3 is gradeless; canonry bands the 0–100 score into pass/partial/fail.
function statusLabel(score: number): string {
  return score >= 70 ? 'Pass' : score >= 40 ? 'Partial' : 'Fail'
}

/**
 * The x value on the site-score trend is a trend point's `auditedAt` — the
 * moment the audit ran (`new Date().toISOString()` when the snapshot is
 * written), not a day stamp. It is a real instant, so it localizes to the
 * viewer: an audit at 2026-07-20T01:52Z reads "Jul 19" in New York, the day
 * that viewer was actually on. Recharts hands its formatters the raw axis
 * value, so the brand is restored here, at the one place an `auditedAt` enters
 * a date formatter.
 */
function formatAuditedAtTick(value: string): string {
  return formatObservedInstantTick(observedInstant(String(value)))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAuditedAtLabel(value: any): string {
  return formatObservedInstantLabel(observedInstant(String(value)))
}

export function TechnicalAeoSection({
  projectName,
  projectId,
  runId,
  integrated = false,
  compactCopy = false,
  footer,
  unavailableFooter,
}: {
  projectName: string
  projectId: string
  /** When supplied, keep every scorecard read pinned to the parent Site Health scan. */
  runId?: string | null
  /** Hide duplicate history and run controls when rendered inside Site Health. */
  integrated?: boolean
  /** Use concise findings copy in the explicit onboarding flow. */
  compactCopy?: boolean
  /** Rendered only after persisted Page health evidence has loaded successfully. */
  footer?: ReactNode
  /** Rendered after an unavailable/error state so a parent flow can recover. */
  unavailableFooter?: ReactNode
}) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [expandedFactor, setExpandedFactor] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const effectiveRunId = runId === undefined ? selectedRunId : runId
  const [isManualRefreshing, setIsManualRefreshing] = useState(false)
  const lastAutoRefreshedRun = useRef<string | null>(null)

  const scoreQuery = useQuery(getApiV1ProjectsByNameTechnicalAeoOptions({
    client: heyClient,
    path: { name: projectName },
    ...(effectiveRunId ? { query: { runId: effectiveRunId } } : {}),
  }))
  const trendQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoTrendOptions({
      client: heyClient,
      path: { name: projectName },
      query: { limit: 30 },
    }),
    enabled: !integrated,
  })
  // One unfiltered fetch powers both the per-page table (filtered client-side)
  // and the per-factor drill-down (which pages fall below pass on a factor).
  const pagesQuery = useQuery(getApiV1ProjectsByNameTechnicalAeoPagesOptions({
    client: heyClient,
    path: { name: projectName },
    query: {
      limit: PAGES_FETCH_LIMIT,
      sort: 'score-asc',
      ...(effectiveRunId ? { runId: effectiveRunId } : {}),
    },
  }))
  const auditRunsQuery = useQuery({
    ...getApiV1ProjectsByNameRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { kind: RunKinds['site-audit'], limit: 10 },
    }),
    enabled: !integrated,
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const hasActiveAudit = query.state.data?.some(
        (run) => run.status === 'queued' || run.status === 'running',
      )
      return hasActiveAudit ? 3000 : 10_000
    },
  })
  const runMutation = useTriggerSiteAudit()
  const trackerState = useSyncExternalStore(subscribeRunTracker, getRunTrackerState, getRunTrackerState)
  const trackedAudit = Object.values(trackerState.runs).find(
    (run) => run.kind === RunKinds['site-audit'] && run.projectId === projectId,
  )
  const auditRuns = auditRunsQuery.data ?? []
  const activeAudit = auditRuns.find((run) => run.status === 'queued' || run.status === 'running')
  const latestAudit = auditRuns.at(-1)
  const auditBusy = runMutation.isPending || Boolean(trackedAudit) || Boolean(activeAudit)
  const auditStatus = runMutation.isPending
    ? 'starting'
    : activeAudit?.status ?? trackedAudit?.lastAnnouncedStatus

  const refreshAll = useCallback(async () => {
    const results = await Promise.all([
      scoreQuery.refetch(),
      pagesQuery.refetch(),
      ...(!integrated ? [trendQuery.refetch()] : []),
    ])
    const failed = results.find((result) => result.error)
    if (failed?.error) throw failed.error
    return results[0]
  }, [integrated, pagesQuery.refetch, scoreQuery.refetch, trendQuery.refetch])

  useEffect(() => {
    if (integrated) return
    if (effectiveRunId) return
    if (!latestAudit || (latestAudit.status !== 'completed' && latestAudit.status !== 'partial')) return
    if (scoreQuery.data?.runId === latestAudit.id || lastAutoRefreshedRun.current === latestAudit.id) return
    lastAutoRefreshedRun.current = latestAudit.id
    void refreshAll().catch((error: unknown) => {
      addToast({
        title: 'Technical AEO auto-refresh failed',
        detail: error instanceof Error ? error.message : 'Could not load the completed audit.',
        tone: 'negative',
        dedupeKey: `technical-aeo:auto-refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    })
  }, [effectiveRunId, integrated, latestAudit?.id, latestAudit?.status, projectName, refreshAll, scoreQuery.data?.runId])

  const handleManualRefresh = async () => {
    setIsManualRefreshing(true)
    try {
      const scoreResult = await refreshAll()
      addToast({
        title: 'Technical AEO refreshed',
        detail: auditBusy
          ? 'The audit is still running. This view will refresh again when it finishes.'
          : scoreResult.data?.hasData
            ? `Latest score is ${scoreResult.data.aggregateScore}/100 from ${scoreResult.data.pagesAudited} audited page${scoreResult.data.pagesAudited === 1 ? '' : 's'}.`
            : 'No audit data yet. Run an audit to crawl the sitemap.',
        tone: scoreResult.data?.hasData ? 'positive' : 'caution',
        dedupeKey: `technical-aeo:refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (error) {
      addToast({
        title: 'Technical AEO refresh failed',
        detail: error instanceof Error ? error.message : 'Could not reload technical audit data.',
        tone: 'negative',
        dedupeKey: `technical-aeo:refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    } finally {
      setIsManualRefreshing(false)
    }
  }

  const startAudit = () => runMutation.mutate({ projectName, projectId })
  const auditStatusLabel = auditStatus === 'running'
    ? 'Audit running'
    : auditStatus === 'queued'
      ? 'Audit queued'
      : 'Starting audit'

  const score = scoreQuery.data
  const allPages = pagesQuery.data?.pages ?? EMPTY_SITE_AUDIT_PAGES
  const onboardingEvidencePage = compactCopy
    ? allPages.find((page) => page.status === 'success' && page.overallScore < 70)
      ?? allPages.find((page) => page.status === 'success')
    : undefined
  const onboardingEvidenceNeedsFix = Boolean(
    onboardingEvidencePage && onboardingEvidencePage.overallScore < 70,
  )
  const onboardingPageAuditQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditOptions({
      client: heyClient,
      path: { name: projectName },
      query: {
        ...(effectiveRunId ? { runId: effectiveRunId } : {}),
        url: onboardingEvidencePage?.url ?? '',
      },
    }),
    // Onboarding needs one concrete proof, not the full graph and inventory.
    // The pages read is already worst-first, so this bounded request opens the
    // first actionable page without enabling the heavy Site Health explorer.
    enabled: compactCopy && Boolean(onboardingEvidencePage),
  })
  const hasErrors = (score?.pagesErrored ?? 0) > 0
  const showErrorsOnly = errorsOnly && hasErrors
  const tableSourcePages = useMemo(
    () => showErrorsOnly ? allPages.filter((page) => page.status === 'error') : allPages,
    [allPages, showErrorsOnly],
  )
  const pagesTable = useClientTable({
    rows: tableSourcePages,
    getSearchText: siteAuditPageSearchText,
  })
  const pagesCapped = score ? score.pagesAudited > allPages.length : false
  const primaryFactorId = score?.crossCuttingIssues[0]?.factorId
    ?? score?.factors.find((factor) => factor.pagesPartial + factor.pagesFailing > 0)?.id
    ?? null

  useEffect(() => {
    setErrorsOnly(false)
    setExpandedFactor(integrated ? primaryFactorId : null)
  }, [effectiveRunId, integrated, primaryFactorId])

  if (scoreQuery.isLoading) {
    return (
      <div className={`flex min-h-40 items-center justify-center gap-2 text-sm text-secondary ${integrated ? '' : 'mt-6'}`} role="status">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        Loading page health...
      </div>
    )
  }

  if (scoreQuery.error) {
    return (
      <>
        <section
          className={`flex flex-col gap-4 rounded-lg border border-negative bg-negative-soft px-5 py-5 sm:flex-row sm:items-center sm:justify-between ${integrated ? '' : 'mt-6'}`}
          role="alert"
        >
          <div className="flex min-w-0 gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-negative" aria-hidden="true" />
            <div>
              {integrated ? (
                <h3 className="font-semibold text-negative">Page health could not load</h3>
              ) : (
                <h2 className="font-semibold text-negative">Page health could not load</h2>
              )}
              <p className="mt-1 text-sm text-secondary">The saved audit could not be read. Try loading it again.</p>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => void handleManualRefresh()}
            disabled={isManualRefreshing}
          >
            <RefreshCw className={`size-4 ${isManualRefreshing ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
            {isManualRefreshing ? 'Trying again...' : 'Try again'}
          </Button>
        </section>
        {unavailableFooter}
      </>
    )
  }

  // Onboarding / empty state — instructional copy is allowed here.
  if (!score || !score.hasData) {
    if (integrated) {
      return (
        <>
          <section className="rounded-lg border border-default bg-surface-subtle px-5 py-7 text-center">
            <ScanSearch className="mx-auto size-7 text-muted" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-heading">Page health unavailable</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-secondary">
              Run a new Site Health scan to calculate page-level technical findings.
            </p>
          </section>
          {unavailableFooter}
        </>
      )
    }
    return (
      <Card className="surface-card mt-6 p-8 text-center">
        <ScanSearch className="mx-auto mb-3 h-8 w-8 text-muted" aria-hidden="true" />
        <h2 className="text-base font-semibold text-heading">No technical audit yet</h2>
        <p className="supporting-copy mx-auto mt-2 max-w-md">
          A technical AEO audit crawls your sitemap and scores every page for structured data, AI-readable content,
          crawler access, freshness, and more, then rolls it up into one site score.
        </p>
        {!isEmbed() && (
          <div className="mt-5 flex items-center justify-center gap-3">
            <WriteButton type="button" onClick={startAudit} disabled={auditBusy}>
              {auditBusy ? (
                <LoaderCircle className="mr-1.5 h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
              )}
              {auditBusy ? auditStatusLabel : 'Run first audit'}
            </WriteButton>
          </div>
        )}
        {auditBusy ? (
          <p className="mt-3 text-xs text-muted" role="status" aria-live="polite">
            The dashboard will refresh automatically when the audit finishes.
          </p>
        ) : null}
      </Card>
    )
  }

  const deltaLabel = score.deltaScore == null
    ? null
    : `${score.deltaScore >= 0 ? '+' : ''}${score.deltaScore} vs previous`
  const deltaTone: MetricTone = score.trend === 'up' ? 'positive' : score.trend === 'down' ? 'negative' : 'neutral'

  const trendPoints = trendQuery.data?.points ?? []
  const trendRows = trendPoints.map((p) => ({ runId: p.runId, date: p.auditedAt, score: p.aggregateScore }))
  const viewingHistorical = runId === undefined && selectedRunId !== null
  const successPages = allPages.filter((p) => p.status === 'success')
  const attentionFactorCount = score.factors.filter(
    (factor) => factor.pagesPartial + factor.pagesFailing > 0,
  ).length
  const hasAnyRecommendations = score.crossCuttingIssues.some(
    (issue) => issue.topRecommendations.length > 0,
  )
  // For a factor, the audited pages scoring below pass (< 70) on that factor,
  // worst-first — the "what's failing" behind the pass/partial/fail counts.
  function pagesBelowPass(factorId: string): Array<{ url: string; score: number }> {
    const rows: Array<{ url: string; score: number }> = []
    for (const page of successPages) {
      const fx = page.factors.find((candidate) => candidate.id === factorId)
      if (fx && fx.score < 70) rows.push({ url: page.url, score: fx.score })
    }
    return rows.sort((a, b) => a.score - b.score)
  }

  return (
    <div className={integrated ? '' : 'mt-6'}>
      {/* Hero — aggregate score + sitemap provenance + action */}
      {integrated ? (
        <section className="flex flex-col gap-3 border-b border-default pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-secondary">Site score</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span
                aria-label={`Site score ${score.aggregateScore} out of 100`}
                className={`inline-flex items-baseline gap-1 font-mono tabular-nums ${scoreTextClass(score.aggregateScore)}`}
              >
                <span className="text-3xl font-semibold">{score.aggregateScore}</span>
                <span className="text-sm text-muted">/100</span>
              </span>
              <ToneBadge tone={scoreTone(score.aggregateScore)}>{statusLabel(score.aggregateScore)}</ToneBadge>
              {deltaLabel ? <ToneBadge tone={deltaTone}>{deltaLabel}</ToneBadge> : null}
            </div>
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm tabular-nums text-secondary">
            <span>{score.pagesAudited} page{score.pagesAudited === 1 ? '' : 's'} checked</span>
            <span aria-hidden="true" className="text-faint">·</span>
            <span>{attentionFactorCount} check{attentionFactorCount === 1 ? '' : 's'} need{attentionFactorCount === 1 ? 's' : ''} attention</span>
            {score.pagesErrored > 0 ? (
              <>
                <span aria-hidden="true" className="text-faint">·</span>
                <span className="text-negative">{score.pagesErrored} crawl error{score.pagesErrored === 1 ? '' : 's'}</span>
              </>
            ) : null}
          </p>
        </section>
      ) : (
        <section className="surface-card flex flex-wrap items-start justify-between gap-6 rounded-lg border border-default bg-surface p-6">
        <div className="min-w-0">
          <p className="eyebrow eyebrow-soft">{viewingHistorical ? 'Technical AEO history' : 'Technical AEO'}</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className={`text-4xl font-semibold tabular-nums ${scoreTextClass(score.aggregateScore)}`}>
              {score.aggregateScore}
            </span>
            <span className="text-lg text-muted">/ 100</span>
            <ToneBadge tone={scoreTone(score.aggregateScore)}>{statusLabel(score.aggregateScore)}</ToneBadge>
            {deltaLabel ? <ToneBadge tone={deltaTone}>{deltaLabel}</ToneBadge> : null}
            {auditBusy ? <ToneBadge tone="neutral">{auditStatusLabel}</ToneBadge> : null}
          </div>
          <p className="supporting-copy mt-2 tabular-nums">
            {score.pagesDiscovered} URL{score.pagesDiscovered === 1 ? '' : 's'} in sitemap · {score.pagesAudited} audited · {score.pagesSkipped} skipped · {score.pagesErrored} errored
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span className="text-faint">Sitemap:</span>
            <a
              href={score.sitemapUrl ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="max-w-[22rem] truncate text-secondary underline decoration-mono-700 underline-offset-2 hover:text-strong"
            >
              {score.sitemapUrl}
            </a>
            <InfoTooltip text="Every audit re-reads this sitemap, so pages you add or remove are picked up on the next run. Discovered/audited counts and the score reflect the sitemap at the time of the latest run. Override it with `canonry technical-aeo run <project> --sitemap-url <url>`." />
          </p>
          {score.auditedAt ? (
            <p className="mt-0.5 text-xs text-faint">Audited {new Date(score.auditedAt).toLocaleString()}</p>
          ) : null}
          {auditBusy ? (
            <p className="mt-1 text-xs text-muted" role="status" aria-live="polite">
              Results refresh automatically when this audit finishes.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {runId === undefined && trendPoints.length > 1 ? (
            <select
              aria-label="View a Technical AEO audit"
              value={selectedRunId ?? ''}
              onChange={(event) => setSelectedRunId(event.target.value || null)}
              className="min-h-11 rounded-md border border-base bg-bg px-3 text-sm text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
            >
              <option value="">Latest audit</option>
              {[...trendPoints].reverse().slice(1).map((point) => (
                <option key={point.runId} value={point.runId}>
                  {new Date(point.auditedAt).toLocaleDateString()} · {point.aggregateScore}/100
                </option>
              ))}
            </select>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void handleManualRefresh()} disabled={isManualRefreshing}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${isManualRefreshing ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
            {isManualRefreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          {!isEmbed() && (
            <WriteButton type="button" size="sm" onClick={startAudit} disabled={auditBusy}>
              {auditBusy ? (
                <LoaderCircle className="mr-1.5 h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
              )}
              {auditBusy ? auditStatusLabel : 'Re-run audit'}
            </WriteButton>
          )}
        </div>
      </section>
      )}

      {/* Trend */}
      {!integrated && trendRows.length >= 2 ? (
        <section className="page-section-divider">
          <div className="section-head">
            <p className="eyebrow eyebrow-soft">Trend</p>
            <h2>Site score over time</h2>
          </div>
          <div className="mt-3 h-56">
            <p className="sr-only">
              Technical AEO scores range from {Math.min(...trendRows.map((row) => row.score))} to {Math.max(...trendRows.map((row) => row.score))} across {trendRows.length} audits. Use the audit selector to inspect a previous scorecard.
            </p>
            <div className="h-full" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trendRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={CHART_AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: CHART_AXIS_STROKE }}
                  tickFormatter={formatAuditedAtTick}
                  minTickGap={24}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tick={CHART_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                />
                <RechartsTooltip
                  {...CHART_TOOLTIP_STYLE}
                  cursor={{ stroke: CHART_AXIS_STROKE, strokeWidth: 1 }}
                  labelFormatter={formatAuditedAtLabel}
                  formatter={(value) => [`${value}/100`, 'Site score']}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  name="score"
                  stroke={CHART_TONE.positive}
                  strokeWidth={2.5}
                  dot={{ r: 2.5, fill: CHART_TONE.positive, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
            </div>
          </div>
        </section>
      ) : null}

      {/* Factor scorecard — expandable rows reveal which pages fail + how to fix */}
      <section className={integrated ? 'pt-5' : 'page-section-divider'}>
        {integrated ? (
          <div>
            <h3 className="text-base font-semibold text-heading">
              {compactCopy ? 'Checks' : 'Technical findings'}
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-secondary">
              {compactCopy
                ? hasAnyRecommendations
                  ? 'Open a check to see affected pages and recommended fixes.'
                  : onboardingEvidencePage
                    ? onboardingEvidenceNeedsFix
                      ? 'Open a check to see affected pages. Page-level evidence for the first page to fix appears below.'
                      : 'Open a check to see affected pages. Page-level evidence for one audited page appears below.'
                    : 'Open a check to see affected pages and score details.'
                : hasAnyRecommendations
                  ? 'Select a check to see affected pages and recommended fixes.'
                  : 'Select a check to see affected pages and score details.'}
            </p>
          </div>
        ) : (
          <div className="section-head">
            <p className="eyebrow eyebrow-soft">Scorecard</p>
            <h2 className="inline-flex items-center gap-1.5">
              Ranking factors
              <InfoTooltip text="Each factor is scored 0–100 per page (via the aeo-audit engine), then averaged across all successfully-audited pages. Pass ≥70, partial 40–69, fail <40. Expand a row to see which pages fall short and how to fix it." />
            </h2>
          </div>
        )}
        <div className="evidence-table-wrap mt-3">
          <table className={`evidence-table ${integrated ? 'min-w-[42rem]' : ''}`}>
            <thead>
              <tr>
                <th>{integrated ? 'Technical check' : 'Factor'}</th>
                {!integrated ? <th className="text-right">Weight</th> : null}
                <th className="text-right">{integrated ? 'Score' : 'Avg'}</th>
                <th>Status</th>
                <th>{integrated ? 'Pages affected' : 'Pass / Partial / Fail'}</th>
              </tr>
            </thead>
            <tbody>
              {score.factors.map((f) => {
                const expanded = expandedFactor === f.id
                const issue = score.crossCuttingIssues.find((c) => c.factorId === f.id)
                const belowPass = expanded ? pagesBelowPass(f.id) : []
                const belowPassTotal = f.pagesPartial + f.pagesFailing
                const auditedFactorPages = f.pagesPassing + belowPassTotal
                const hasRecommendations = Boolean(issue?.topRecommendations.length)
                const hasTwoDetailColumns = hasRecommendations && belowPassTotal > 0
                return (
                  <Fragment key={f.id}>
                    <tr className={expanded ? 'bg-surface-subtle' : undefined}>
                      <td>
                        <button
                          type="button"
                          className="flex min-h-11 w-full items-center gap-2 text-left font-medium text-strong outline-none hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mono-400"
                          aria-expanded={expanded}
                          onClick={() => setExpandedFactor(expanded ? null : f.id)}
                        >
                          {expanded
                            ? <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden="true" />
                            : <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />}
                          {f.name}
                        </button>
                      </td>
                      {!integrated ? <td className="text-right tabular-nums text-muted">{f.weight}%</td> : null}
                      <td className="text-right font-mono tabular-nums text-strong">
                        {f.avgScore}{integrated ? <span className="text-muted">/100</span> : null}
                      </td>
                      <td><ToneBadge tone={factorTone(f.status)}>{statusLabel(f.avgScore)}</ToneBadge></td>
                      {integrated ? (
                        <td className={`tabular-nums ${belowPassTotal > 0 ? 'text-strong' : 'text-muted'}`}>
                          {belowPassTotal} of {auditedFactorPages}
                        </td>
                      ) : (
                        <td className="tabular-nums text-secondary">
                          <span className="text-positive-400">{f.pagesPassing}</span>
                          {' / '}
                          <span className="text-caution-400">{f.pagesPartial}</span>
                          {' / '}
                          <span className="text-negative-400">{f.pagesFailing}</span>
                        </td>
                      )}
                    </tr>
                    {expanded ? (
                      <tr className="bg-surface-subtle">
                        <td colSpan={integrated ? 4 : 5} className="px-4 pb-5 pt-0">
                          <div className={`grid gap-5 border-t border-subtle pt-4 ${hasTwoDetailColumns ? 'lg:grid-cols-2' : ''}`}>
                            {hasRecommendations && issue ? (
                              <section aria-labelledby={`technical-finding-${f.id}-fixes`}>
                                <h4 id={`technical-finding-${f.id}-fixes`} className="text-sm font-semibold text-heading">
                                  Recommended fixes
                                </h4>
                                <ol className="mt-2 list-decimal space-y-1.5 pl-5 marker:text-muted">
                                  {issue.topRecommendations.map((rec, i) => (
                                    <li key={i} className="pl-1 text-sm text-secondary">{rec}</li>
                                  ))}
                                </ol>
                                {integrated ? (
                                  <p className="mt-3 text-xs text-muted">Weight: {f.weight}% of the site score</p>
                                ) : null}
                              </section>
                            ) : belowPassTotal === 0 ? (
                              <p className="text-sm text-secondary">Every audited page passes this check.</p>
                            ) : null}

                            {belowPassTotal > 0 ? (
                              <section aria-labelledby={`technical-finding-${f.id}-pages`}>
                                <h4 id={`technical-finding-${f.id}-pages`} className="text-sm font-semibold text-heading">
                                  Affected pages ({belowPassTotal})
                                </h4>
                                {integrated && pagesQuery.isLoading ? (
                                  <div className="mt-3 flex items-center gap-2 text-sm text-secondary" role="status">
                                    <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                                    Loading affected pages...
                                  </div>
                                ) : integrated && pagesQuery.error ? (
                                  <div className="mt-3" role="alert">
                                    <p className="text-sm font-medium text-negative">Affected pages could not load</p>
                                    <p className="mt-1 text-sm text-secondary">Try the page-level audit read again.</p>
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      size="sm"
                                      className="mt-3"
                                      onClick={() => void pagesQuery.refetch()}
                                      disabled={pagesQuery.isFetching}
                                    >
                                      {pagesQuery.isFetching ? (
                                        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                                      ) : (
                                        <RefreshCw className="size-4" aria-hidden="true" />
                                      )}
                                      {pagesQuery.isFetching ? 'Retrying affected pages...' : 'Retry affected pages'}
                                    </Button>
                                  </div>
                                ) : belowPass.length > 0 ? (
                                  <ul className="mt-2 space-y-1.5">
                                    {belowPass.slice(0, FACTOR_DRILLDOWN_PAGE_CAP).map((row) => (
                                      <li key={row.url} className="flex min-w-0 items-center gap-2 text-sm">
                                        <span className={`w-8 shrink-0 text-right font-mono tabular-nums ${scoreTextClass(row.score)}`}>{row.score}</span>
                                        <a
                                          href={row.url}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="min-w-0 truncate text-link outline-none hover:text-heading focus-visible:ring-2 focus-visible:ring-mono-400"
                                          title={row.url}
                                        >
                                          {row.url}
                                        </a>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="mt-2 text-sm text-secondary">Page details are not available in the loaded audit sample.</p>
                                )}
                                {belowPass.length > FACTOR_DRILLDOWN_PAGE_CAP ? (
                                  <p className="mt-2 text-xs text-muted">
                                    + {belowPass.length - FACTOR_DRILLDOWN_PAGE_CAP} more below pass
                                  </p>
                                ) : null}
                                {pagesCapped && (!integrated || (!pagesQuery.isLoading && !pagesQuery.error)) ? (
                                  <p className="mt-2 text-xs text-muted">Showing the worst {allPages.length} audited pages.</p>
                                ) : null}
                              </section>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {compactCopy && onboardingEvidencePage ? (
        <section className="border-t border-default pt-5" aria-labelledby="onboarding-page-evidence-heading">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div className="min-w-0">
              <h3 id="onboarding-page-evidence-heading" className="text-base font-semibold text-heading">
                {onboardingEvidenceNeedsFix ? 'First page to fix' : 'Example audited page'}
              </h3>
              <a
                href={onboardingEvidencePage.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block max-w-2xl truncate font-mono text-sm text-link outline-none hover:text-heading focus-visible:ring-2 focus-visible:ring-mono-400"
                title={onboardingEvidencePage.url}
              >
                {onboardingEvidencePage.url}
              </a>
            </div>
            <ToneBadge tone={scoreTone(onboardingEvidencePage.overallScore)}>
              {Math.round(onboardingEvidencePage.overallScore)}/100
            </ToneBadge>
          </div>
          <PageAuditEvidence
            audit={onboardingPageAuditQuery.data}
            isLoading={onboardingPageAuditQuery.isLoading}
            error={onboardingPageAuditQuery.error}
            onRetry={() => { void onboardingPageAuditQuery.refetch() }}
          />
        </section>
      ) : null}

      {/* Opportunities — one structured block per cross-cutting factor */}
      {!integrated && score.crossCuttingIssues.length > 0 ? (
        <section className="page-section-divider">
          <div className="section-head">
            <p className="eyebrow eyebrow-soft">Opportunities</p>
            <h2 className="inline-flex items-center gap-1.5">
              Prioritized fixes
              <InfoTooltip text="Factors scoring below pass across the most pages, ranked by site-wide impact. Fixing one of these typically lifts many pages at once." />
            </h2>
          </div>
          <div className="mt-3 divide-y divide-mono-800/60 overflow-hidden rounded-lg border border-default">
            {score.crossCuttingIssues.map((issue) => {
              return (
                <div key={issue.factorId} className="p-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-heading">{issue.factorName}</span>
                    <ToneBadge tone={scoreTone(issue.avgScore)}>{statusLabel(issue.avgScore)}</ToneBadge>
                    <span className="text-xs tabular-nums text-muted">
                      avg {issue.avgScore} · affects {issue.affectedPages} of {issue.totalPages} pages ({issue.affectedPct}%)
                    </span>
                  </div>
                  {issue.topRecommendations.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {issue.topRecommendations.map((rec, i) => (
                        <li key={i} className="flex gap-2 text-sm text-secondary">
                          <span className="select-none text-faint">→</span>
                          <span>{rec}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* Per-page breakdown */}
      {!integrated ? (
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Pages</p>
            <h2>Per-page breakdown</h2>
          </div>
          {hasErrors ? (
            <div className="segmented" role="group" aria-label="Filter pages">
              <button
                type="button"
                onClick={() => {
                  setErrorsOnly(false)
                  pagesTable.setPage(1)
                }}
                aria-pressed={!showErrorsOnly}
                className={`segmented-option min-h-11 tabular-nums ${!showErrorsOnly ? 'segmented-option-active' : ''}`}
              >
                All {score.pagesAudited}
              </button>
              <button
                type="button"
                onClick={() => {
                  setErrorsOnly(true)
                  pagesTable.setPage(1)
                }}
                aria-pressed={showErrorsOnly}
                className={`segmented-option min-h-11 tabular-nums ${showErrorsOnly ? 'segmented-option-active text-negative' : ''}`}
              >
                Errors {score.pagesErrored}
              </button>
            </div>
          ) : null}
        </div>
        {allPages.length > 0 ? (
          <DataTableSearch
            value={pagesTable.query}
            onChange={pagesTable.setQuery}
            label="Filter audited page URLs"
            placeholder="Filter page URL or query parameters"
            className="mt-3 max-w-md"
          />
        ) : null}
        {pagesTable.totalRows === 0 ? (
          <p className="supporting-copy mt-3">
            {pagesTable.hasQuery ? 'No pages match this filter.' : 'No pages recorded.'}
          </p>
        ) : (
          <>
            <div className="evidence-table-wrap mt-3">
              <table className="evidence-table">
                <thead>
                  <tr>
                    <th className="text-right">Score</th>
                    <th>Status</th>
                    <th className="w-full">URL</th>
                  </tr>
                </thead>
                <tbody>
                  {pagesTable.rows.map((p: SiteAuditPageDto) => (
                    <tr key={p.url}>
                      <td className="text-right tabular-nums">
                        {p.status === 'error'
                          ? <span className="inline-flex items-center gap-1 text-negative-400"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />err</span>
                          : <span className={scoreTextClass(p.overallScore)}>{p.overallScore}</span>}
                      </td>
                      <td>{p.status === 'error' ? <ToneBadge tone="negative">Error</ToneBadge> : <ToneBadge tone={scoreTone(p.overallScore)}>{statusLabel(p.overallScore)}</ToneBadge>}</td>
                      <td className="w-full max-w-0">
                        <a href={p.url} target="_blank" rel="noreferrer" className="block truncate text-neutral hover:text-heading" title={p.status === 'error' ? p.error ?? p.url : p.url}>
                          <MiddleTruncatedText
                            value={p.url}
                            headLength={54}
                            tailLength={20}
                            title={p.status === 'error' ? p.error ?? p.url : p.url}
                          />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataTablePagination
              page={pagesTable.page}
              pageSize={pagesTable.pageSize}
              visibleRows={pagesTable.rows.length}
              totalRows={pagesTable.totalRows}
              onPageChange={pagesTable.setPage}
              itemLabel={pagesTable.hasQuery ? 'matches' : 'rows'}
            />
            {pagesCapped ? (
              <p className="mt-2 text-xs text-faint">Showing the worst {allPages.length} of {score.pagesAudited} audited pages.</p>
            ) : null}
          </>
        )}
      </section>
      ) : null}
      {footer}
    </div>
  )
}
