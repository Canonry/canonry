import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Play, RefreshCw, ScanSearch } from 'lucide-react'
import type { MetricTone } from '../../view-models.js'
import type { SiteAuditFactorSummaryDto } from '@ainyc/canonry-contracts'

import { triggerSiteAudit, heyClient } from '../../api.js'
import {
  getApiV1ProjectsByNameTechnicalAeoOptions,
  getApiV1ProjectsByNameTechnicalAeoPagesOptions,
  getApiV1ProjectsByNameTechnicalAeoTrendOptions,
  getApiV1ProjectsByNameTechnicalAeoQueryKey,
  getApiV1ProjectsByNameTechnicalAeoPagesQueryKey,
  getApiV1ProjectsByNameTechnicalAeoTrendQueryKey,
  getApiV1RunsQueryKey,
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
  formatChartDateLabel,
  formatChartDateTick,
} from '../shared/ChartPrimitives.js'
import { addToast } from '../../lib/toast-store.js'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'

function scoreTone(score: number): MetricTone {
  if (score >= 70) return 'positive'
  if (score >= 40) return 'caution'
  return 'negative'
}

function factorTone(status: SiteAuditFactorSummaryDto['status']): MetricTone {
  return status === 'pass' ? 'positive' : status === 'partial' ? 'caution' : 'negative'
}

export function TechnicalAeoSection({ projectName }: { projectName: string }) {
  const queryClient = useQueryClient()
  const [errorsOnly, setErrorsOnly] = useState(false)

  const scoreQuery = useQuery(getApiV1ProjectsByNameTechnicalAeoOptions({ client: heyClient, path: { name: projectName } }))
  const trendQuery = useQuery(getApiV1ProjectsByNameTechnicalAeoTrendOptions({
    client: heyClient,
    path: { name: projectName },
    query: { limit: 30 },
  }))
  const pagesQuery = useQuery(getApiV1ProjectsByNameTechnicalAeoPagesOptions({
    client: heyClient,
    path: { name: projectName },
    query: { limit: 100, sort: 'score-asc', ...(errorsOnly ? { status: 'error' as const } : {}) },
  }))

  const runMutation = useMutation({
    mutationFn: () => triggerSiteAudit(projectName),
    onSuccess: () => {
      addToast({
        title: 'Technical audit started',
        detail: 'The audit crawls your sitemap in the background. Refresh in a minute to see the score.',
        tone: 'positive',
      })
      void queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) })
    },
    onError: (err: unknown) => {
      addToast({
        title: 'Could not start technical audit',
        detail: err instanceof Error ? err.message : 'Failed to start technical audit.',
        tone: 'negative',
      })
    },
  })

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: getApiV1ProjectsByNameTechnicalAeoQueryKey({ client: heyClient, path: { name: projectName } }) })
    void queryClient.invalidateQueries({ queryKey: getApiV1ProjectsByNameTechnicalAeoTrendQueryKey({ client: heyClient, path: { name: projectName }, query: { limit: 30 } }) })
    void queryClient.invalidateQueries({ queryKey: getApiV1ProjectsByNameTechnicalAeoPagesQueryKey({ client: heyClient, path: { name: projectName }, query: { limit: 100, sort: 'score-asc' } }) })
  }

  const score = scoreQuery.data

  if (scoreQuery.isLoading) {
    return <p className="supporting-copy mt-6">Loading technical audit…</p>
  }

  // Onboarding / empty state — instructional copy is allowed here.
  if (!score || !score.hasData) {
    return (
      <Card className="surface-card mt-6 p-8 text-center">
        <ScanSearch className="mx-auto mb-3 h-8 w-8 text-zinc-500" aria-hidden="true" />
        <h2 className="text-base font-semibold text-zinc-100">No technical audit yet</h2>
        <p className="supporting-copy mx-auto mt-2 max-w-md">
          A technical AEO audit crawls your sitemap and scores every page for structured data, AI-readable content,
          crawler access, freshness, and more — then rolls it up into one site score.
        </p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <Button type="button" onClick={() => runMutation.mutate()} disabled={runMutation.isPending}>
            <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {runMutation.isPending ? 'Starting…' : 'Run first audit'}
          </Button>
        </div>
        <p className="mt-3 text-xs text-zinc-600">
          Or from the CLI: <code className="text-zinc-400">canonry technical-aeo run {projectName} --wait</code>
        </p>
      </Card>
    )
  }

  const deltaLabel = score.deltaScore == null
    ? null
    : `${score.deltaScore >= 0 ? '+' : ''}${score.deltaScore} vs previous`
  const deltaTone: MetricTone = score.trend === 'up' ? 'positive' : score.trend === 'down' ? 'negative' : 'neutral'

  const trendRows = trendQuery.data?.points.map((p) => ({ date: p.auditedAt, score: p.aggregateScore })) ?? []
  const pages = pagesQuery.data?.pages ?? []

  return (
    <div className="mt-6">
      {/* Hero — aggregate score + page counts + action */}
      <section className="surface-card flex flex-wrap items-center justify-between gap-6 rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-6">
        <div>
          <p className="eyebrow eyebrow-soft">Technical AEO</p>
          <div className="mt-1 flex items-baseline gap-3">
            <span className={`text-4xl font-semibold tabular-nums ${score.aggregateScore >= 70 ? 'text-emerald-400' : score.aggregateScore >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
              {score.aggregateScore}
            </span>
            <span className="text-lg text-zinc-500">/ 100</span>
            <ToneBadge tone={scoreTone(score.aggregateScore)}>{score.aggregateGrade}</ToneBadge>
            {deltaLabel ? <ToneBadge tone={deltaTone}>{deltaLabel}</ToneBadge> : null}
          </div>
          <p className="supporting-copy mt-2">
            {score.pagesAudited} page{score.pagesAudited === 1 ? '' : 's'} audited · {score.pagesSkipped} skipped · {score.pagesErrored} errored
            {score.pagesDiscovered > score.pagesAudited + score.pagesSkipped
              ? ` · ${score.pagesDiscovered} discovered`
              : ''}
          </p>
          <p className="mt-0.5 text-xs text-zinc-600">
            {score.sitemapUrl}{score.auditedAt ? ` · audited ${new Date(score.auditedAt).toLocaleString()}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
          <Button type="button" size="sm" onClick={() => runMutation.mutate()} disabled={runMutation.isPending}>
            <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {runMutation.isPending ? 'Starting…' : 'Re-run audit'}
          </Button>
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
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trendRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={CHART_AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: CHART_AXIS_STROKE }}
                  tickFormatter={formatChartDateTick}
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
                  labelFormatter={formatChartDateLabel}
                  formatter={(value) => [`${value}/100`, 'Site score']}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  name="score"
                  stroke="#34d399"
                  strokeWidth={2.5}
                  dot={{ r: 2.5, fill: '#34d399', strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      ) : null}

      {/* Factor scorecard */}
      <section className="page-section-divider">
        <div className="section-head">
          <p className="eyebrow eyebrow-soft">Scorecard</p>
          <h2 className="inline-flex items-center gap-1.5">
            Ranking factors
            <InfoTooltip text="Each factor is scored 0–100 per page (via the aeo-audit engine), then averaged across all successfully-audited pages. Pass ≥70, partial 40–69, fail <40. Heavier-weighted factors move the overall site score more." />
          </h2>
        </div>
        <div className="evidence-table-wrap mt-3">
          <table className="evidence-table">
            <thead>
              <tr>
                <th>Factor</th>
                <th className="text-right">Weight</th>
                <th className="text-right">Avg</th>
                <th>Grade</th>
                <th>Pass / Partial / Fail</th>
              </tr>
            </thead>
            <tbody>
              {score.factors.map((f) => (
                <tr key={f.id}>
                  <td className="text-zinc-200">{f.name}</td>
                  <td className="text-right tabular-nums text-zinc-500">{f.weight}%</td>
                  <td className="text-right tabular-nums text-zinc-200">{f.avgScore}</td>
                  <td><ToneBadge tone={factorTone(f.status)}>{f.avgGrade}</ToneBadge></td>
                  <td className="tabular-nums text-zinc-400">
                    <span className="text-emerald-400">{f.pagesPassing}</span>
                    {' / '}
                    <span className="text-amber-400">{f.pagesPartial}</span>
                    {' / '}
                    <span className="text-rose-400">{f.pagesFailing}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Prioritized fixes */}
      {score.prioritizedFixes.length > 0 ? (
        <section className="page-section-divider">
          <div className="section-head">
            <p className="eyebrow eyebrow-soft">Opportunities</p>
            <h2 className="inline-flex items-center gap-1.5">
              Prioritized fixes
              <InfoTooltip text="The factors that score poorly across the most pages, ranked by site-wide impact. Fixing one of these typically lifts many pages at once." />
            </h2>
          </div>
          <ol className="mt-3 space-y-2">
            {score.prioritizedFixes.map((fix, i) => (
              <li key={i} className="insight-card insight-card-caution text-sm text-zinc-300">{fix}</li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* Per-page breakdown */}
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Pages</p>
            <h2>Per-page breakdown</h2>
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
              className="accent-zinc-300"
            />
            Errors only
          </label>
        </div>
        {pages.length === 0 ? (
          <p className="supporting-copy mt-3">{errorsOnly ? 'No errored pages — every audited page was reachable.' : 'No pages recorded.'}</p>
        ) : (
          <div className="evidence-table-wrap mt-3">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th className="text-right">Score</th>
                  <th>Grade</th>
                  <th>URL</th>
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.url}>
                    <td className="text-right tabular-nums">
                      {p.status === 'error'
                        ? <span className="inline-flex items-center gap-1 text-rose-400"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />err</span>
                        : <span className={scoreTone(p.overallScore) === 'positive' ? 'text-emerald-400' : scoreTone(p.overallScore) === 'caution' ? 'text-amber-400' : 'text-rose-400'}>{p.overallScore}</span>}
                    </td>
                    <td>{p.status === 'error' ? <span className="text-zinc-600">—</span> : <ToneBadge tone={scoreTone(p.overallScore)}>{p.overallGrade}</ToneBadge>}</td>
                    <td className="max-w-0">
                      <a href={p.url} target="_blank" rel="noreferrer" className="block truncate text-zinc-300 hover:text-zinc-100" title={p.status === 'error' ? p.error ?? p.url : p.url}>
                        {p.url}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
