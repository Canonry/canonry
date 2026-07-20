import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight, LoaderCircle, Play, RefreshCw, ScanSearch } from 'lucide-react'
import type { MetricTone } from '../../view-models.js'
import { RunKinds, type SiteAuditFactorSummaryDto, type SiteAuditPageDto } from '@ainyc/canonry-contracts'

import { heyClient, isEmbed } from '../../api.js'
import {
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
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { useTriggerSiteAudit } from '../../queries/mutations.js'
import { getRunTrackerState, subscribeRunTracker } from '../../lib/run-tracker-store.js'

const PAGES_FETCH_LIMIT = 100
const FACTOR_DRILLDOWN_PAGE_CAP = 12

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

export function TechnicalAeoSection({ projectName, projectId }: { projectName: string; projectId: string }) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [expandedFactor, setExpandedFactor] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [isManualRefreshing, setIsManualRefreshing] = useState(false)
  const lastAutoRefreshedRun = useRef<string | null>(null)

  const scoreQuery = useQuery(getApiV1ProjectsByNameTechnicalAeoOptions({
    client: heyClient,
    path: { name: projectName },
    ...(selectedRunId ? { query: { runId: selectedRunId } } : {}),
  }))
  const trendQuery = useQuery(getApiV1ProjectsByNameTechnicalAeoTrendOptions({
    client: heyClient,
    path: { name: projectName },
    query: { limit: 30 },
  }))
  // One unfiltered fetch powers both the per-page table (filtered client-side)
  // and the per-factor drill-down (which pages fall below pass on a factor).
  const pagesQuery = useQuery(getApiV1ProjectsByNameTechnicalAeoPagesOptions({
    client: heyClient,
    path: { name: projectName },
    query: {
      limit: PAGES_FETCH_LIMIT,
      sort: 'score-asc',
      ...(selectedRunId ? { runId: selectedRunId } : {}),
    },
  }))
  const auditRunsQuery = useQuery({
    ...getApiV1ProjectsByNameRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { kind: RunKinds['site-audit'], limit: 10 },
    }),
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
      trendQuery.refetch(),
      pagesQuery.refetch(),
    ])
    const failed = results.find((result) => result.error)
    if (failed?.error) throw failed.error
    return results[0]
  }, [pagesQuery.refetch, scoreQuery.refetch, trendQuery.refetch])

  useEffect(() => {
    if (selectedRunId) return
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
  }, [latestAudit?.id, latestAudit?.status, projectName, refreshAll, scoreQuery.data?.runId, selectedRunId])

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

  useEffect(() => {
    setErrorsOnly(false)
    setExpandedFactor(null)
  }, [selectedRunId])

  if (scoreQuery.isLoading) {
    return <p className="supporting-copy mt-6">Loading technical audit…</p>
  }

  // Onboarding / empty state — instructional copy is allowed here.
  if (!score || !score.hasData) {
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
            <Button type="button" onClick={startAudit} disabled={auditBusy}>
              {auditBusy ? (
                <LoaderCircle className="mr-1.5 h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
              )}
              {auditBusy ? auditStatusLabel : 'Run first audit'}
            </Button>
          </div>
        )}
        {auditBusy ? (
          <p className="mt-3 text-xs text-muted" role="status" aria-live="polite">
            The dashboard will refresh automatically when the audit finishes.
          </p>
        ) : null}
        <p className="mt-3 text-xs text-faint">
          Or from the CLI: <code className="text-secondary">canonry technical-aeo run {projectName} --wait</code>
        </p>
      </Card>
    )
  }

  const deltaLabel = score.deltaScore == null
    ? null
    : `${score.deltaScore >= 0 ? '+' : ''}${score.deltaScore} vs previous`
  const deltaTone: MetricTone = score.trend === 'up' ? 'positive' : score.trend === 'down' ? 'negative' : 'neutral'

  const trendPoints = trendQuery.data?.points ?? []
  const trendRows = trendPoints.map((p) => ({ runId: p.runId, date: p.auditedAt, score: p.aggregateScore }))
  const viewingHistorical = selectedRunId !== null
  const allPages = pagesQuery.data?.pages ?? []
  const successPages = allPages.filter((p) => p.status === 'success')
  const hasErrors = score.pagesErrored > 0
  const showErrorsOnly = errorsOnly && hasErrors
  const visiblePages = showErrorsOnly ? allPages.filter((p) => p.status === 'error') : allPages
  const pagesCapped = score.pagesAudited > allPages.length

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
    <div className="mt-6">
      {/* Hero — aggregate score + sitemap provenance + action */}
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
          {trendPoints.length > 1 ? (
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
            <Button type="button" size="sm" onClick={startAudit} disabled={auditBusy}>
              {auditBusy ? (
                <LoaderCircle className="mr-1.5 h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
              )}
              {auditBusy ? auditStatusLabel : 'Re-run audit'}
            </Button>
          )}
        </div>
      </section>

      {/* Trend */}
      {trendRows.length >= 2 ? (
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
      <section className="page-section-divider">
        <div className="section-head">
          <p className="eyebrow eyebrow-soft">Scorecard</p>
          <h2 className="inline-flex items-center gap-1.5">
            Ranking factors
            <InfoTooltip text="Each factor is scored 0–100 per page (via the aeo-audit engine), then averaged across all successfully-audited pages. Pass ≥70, partial 40–69, fail <40. Expand a row to see which pages fall short and how to fix it." />
          </h2>
        </div>
        <div className="evidence-table-wrap mt-3">
          <table className="evidence-table">
            <thead>
              <tr>
                <th>Factor</th>
                <th className="text-right">Weight</th>
                <th className="text-right">Avg</th>
                <th>Status</th>
                <th>Pass / Partial / Fail</th>
              </tr>
            </thead>
            <tbody>
              {score.factors.map((f) => {
                const expanded = expandedFactor === f.id
                const issue = score.crossCuttingIssues.find((c) => c.factorId === f.id)
                const belowPass = expanded ? pagesBelowPass(f.id) : []
                const belowPassTotal = f.pagesPartial + f.pagesFailing
                return (
                  <Fragment key={f.id}>
                    <tr className={expanded ? 'bg-surface' : undefined}>
                      <td>
                        <button
                          type="button"
                          className="flex items-center gap-1.5 text-left font-medium text-strong hover:text-primary"
                          aria-expanded={expanded}
                          onClick={() => setExpandedFactor(expanded ? null : f.id)}
                        >
                          {expanded
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />}
                          {f.name}
                        </button>
                      </td>
                      <td className="text-right tabular-nums text-muted">{f.weight}%</td>
                      <td className="text-right tabular-nums text-strong">{f.avgScore}</td>
                      <td><ToneBadge tone={factorTone(f.status)}>{statusLabel(f.avgScore)}</ToneBadge></td>
                      <td className="tabular-nums text-secondary">
                        <span className="text-positive-400">{f.pagesPassing}</span>
                        {' / '}
                        <span className="text-caution-400">{f.pagesPartial}</span>
                        {' / '}
                        <span className="text-negative-400">{f.pagesFailing}</span>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="bg-surface">
                        <td colSpan={5} className="px-4 pb-4 pt-0">
                          <div className="space-y-4 border-l border-base pl-4">
                            {issue && issue.topRecommendations.length > 0 ? (
                              <div>
                                <p className="eyebrow eyebrow-soft mb-1.5 text-muted">How to fix</p>
                                <ul className="space-y-1">
                                  {issue.topRecommendations.map((rec, i) => (
                                    <li key={i} className="flex gap-2 text-sm text-neutral">
                                      <span className="select-none text-faint">→</span>
                                      <span>{rec}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : belowPassTotal === 0 ? (
                              <p className="text-sm text-muted">Every audited page passes this factor.</p>
                            ) : null}

                            {belowPassTotal > 0 ? (
                              <div>
                                <p className="eyebrow eyebrow-soft mb-1.5 text-muted">
                                  Pages below pass ({belowPassTotal})
                                </p>
                                <ul className="space-y-1">
                                  {belowPass.slice(0, FACTOR_DRILLDOWN_PAGE_CAP).map((row) => (
                                    <li key={row.url} className="flex items-center gap-2 text-sm">
                                      <span className={`w-8 shrink-0 text-right tabular-nums ${scoreTextClass(row.score)}`}>{row.score}</span>
                                      <a
                                        href={row.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="truncate text-neutral hover:text-heading"
                                        title={row.url}
                                      >
                                        {row.url}
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                                {belowPass.length > FACTOR_DRILLDOWN_PAGE_CAP ? (
                                  <p className="mt-1 text-xs text-faint">
                                    + {belowPass.length - FACTOR_DRILLDOWN_PAGE_CAP} more below pass
                                  </p>
                                ) : null}
                                {pagesCapped ? (
                                  <p className="mt-1 text-xs text-faint">Showing the worst {allPages.length} audited pages.</p>
                                ) : null}
                              </div>
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

      {/* Opportunities — one structured block per cross-cutting factor */}
      {score.crossCuttingIssues.length > 0 ? (
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
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Pages</p>
            <h2>Per-page breakdown</h2>
          </div>
          {hasErrors ? (
            <div className="inline-flex items-center gap-1 rounded-full border border-default p-0.5" role="group" aria-label="Filter pages">
              <button
                type="button"
                onClick={() => setErrorsOnly(false)}
                aria-pressed={!showErrorsOnly}
                className={`min-h-11 rounded-full px-3 py-1 text-xs font-medium tabular-nums transition-colors ${!showErrorsOnly ? 'bg-mono-800 text-heading' : 'text-muted hover:text-neutral'}`}
              >
                All {score.pagesAudited}
              </button>
              <button
                type="button"
                onClick={() => setErrorsOnly(true)}
                aria-pressed={showErrorsOnly}
                className={`min-h-11 rounded-full px-3 py-1 text-xs font-medium tabular-nums transition-colors ${showErrorsOnly ? 'bg-negative-500/15 text-negative' : 'text-muted hover:text-neutral'}`}
              >
                Errors {score.pagesErrored}
              </button>
            </div>
          ) : null}
        </div>
        {visiblePages.length === 0 ? (
          <p className="supporting-copy mt-3">No pages recorded.</p>
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
                  {visiblePages.map((p: SiteAuditPageDto) => (
                    <tr key={p.url}>
                      <td className="text-right tabular-nums">
                        {p.status === 'error'
                          ? <span className="inline-flex items-center gap-1 text-negative-400"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />err</span>
                          : <span className={scoreTextClass(p.overallScore)}>{p.overallScore}</span>}
                      </td>
                      <td>{p.status === 'error' ? <ToneBadge tone="negative">Error</ToneBadge> : <ToneBadge tone={scoreTone(p.overallScore)}>{statusLabel(p.overallScore)}</ToneBadge>}</td>
                      <td className="w-full max-w-0">
                        <a href={p.url} target="_blank" rel="noreferrer" className="block truncate text-neutral hover:text-heading" title={p.status === 'error' ? p.error ?? p.url : p.url}>
                          {p.url}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagesCapped ? (
              <p className="mt-2 text-xs text-faint">Showing the worst {allPages.length} of {score.pagesAudited} audited pages.</p>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}
