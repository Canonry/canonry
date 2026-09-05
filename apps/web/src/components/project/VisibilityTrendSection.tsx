import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { buildModelChangeNotice, describeError } from '@ainyc/canonry-contracts'
import type { BrandMetricsDto, MetricsWindow } from '@ainyc/canonry-contracts'
import type { VisibilityReportResponse, VisibilityReportRate, VisibilityReportPopulation } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameVisibilityReportOptions } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../../api.js'
import type { VisibilitySelectionState } from '../../lib/measurement-view-url.js'
import { Button } from '../ui/button.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { safeExternalUrl } from '../../lib/safe-url.js'
import {
  CartesianGrid,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_NEUTRAL,
  CHART_SERIES_COLORS,
  CHART_TONE,
  ComposedChart,
  formatObservedInstantLabel,
  Line,
  observedInstant,
  providerSeriesColor,
  ReferenceLine,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from '../shared/ChartPrimitives.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { fetchAnalyticsMetrics } from '../../api.js'
import { STATIC_VISIBILITY_STALE_MS } from '../../queries/query-client.js'
import {
  buildSelectedTrendRows,
  CITED_KEY,
  countModelAttributionEvents,
  formatBucketDateLabel,
  formatBucketDateTick,
  formatModelEvidence,
  formatQueryChangeCaption,
  formatServedModelIds,
  groupModelAttributionEvents,
  latestSeriesValue,
  latestPlottedProviderModelEvidence,
  MENTION_SHARE_KEY,
  MENTIONED_KEY,
  normalizeProviderKey,
  partitionModelAttributionEvents,
  readBucketModelEvidence,
  readModelAttribution,
  readModelPointerChanges,
  readModelServiceMismatch,
  readServedModelAttribution,
  truncatedProviderCounts,
  type MetricChoice,
  type ModelAttributionEventPartition,
  type ProviderEventCount,
  type TrendSeriesMode,
} from '../../lib/visibility-trend-helpers.js'

const WINDOW_OPTIONS: Array<{ value: MetricsWindow; label: string }> = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
]

const REPORT_CLASS_LABEL = { 'non-brand': 'Non-brand queries', branded: 'Branded queries', unknown: 'Unclassified queries' }
const REPORT_CONTROL = 'min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const reportPercent = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 })

function ReportRate({ value }: { value: VisibilityReportRate }) {
  if (value.rate === null) return <span className="text-sm text-secondary">{value.reason === 'not-applicable' ? 'Not applicable' : 'Not measured'}</span>
  return <span className="inline-flex flex-col gap-1"><strong className="tabular-nums text-heading">{reportPercent.format(value.rate)}</strong><span className="text-sm tabular-nums text-secondary">{value.numerator} of {value.denominator}</span></span>
}

function ReportTrend({ population }: { population: VisibilityReportPopulation }) {
  const points = population.trend.flatMap(point => {
    const plotted = { createdAt: point.createdAt, mentioned: point.mentionCoverage.rate, cited: point.citationCoverage.rate }
    return point.continuity.state === 'comparable' || point.continuity.state === 'first'
      ? [plotted]
      : [{ createdAt: point.createdAt, mentioned: null, cited: null }, plotted]
  })
  if (points.length === 0) return <p className="py-6 text-sm text-secondary">No measured trend for this selection.</p>
  return <>
    <div className="visibility-trend-chart" role="img" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} mention and citation trend`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis dataKey="createdAt" tick={CHART_AXIS_TICK} tickLine={false} axisLine={{ stroke: CHART_AXIS_STROKE }} tickFormatter={value => new Date(String(value)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} minTickGap={24} />
          <YAxis domain={[0, 1]} tick={CHART_AXIS_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={value => reportPercent.format(Number(value))} />
          <RechartsTooltip formatter={value => typeof value === 'number' ? reportPercent.format(value) : 'Not measured'} labelFormatter={value => new Date(String(value)).toLocaleDateString()} />
          <Line type="linear" dataKey="mentioned" name="Mentioned" stroke={CHART_SERIES_COLORS[1]} strokeWidth={2} connectNulls={false} isAnimationActive={false} dot={{ r: 3 }} />
          <Line type="linear" dataKey="cited" name="Cited" stroke={CHART_TONE.positive} strokeWidth={2} connectNulls={false} isAnimationActive={false} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <details className="py-3 text-sm text-secondary"><summary className="min-h-11 cursor-pointer py-3">Trend data and comparability</summary>
      <div className="overflow-x-auto"><table className="evidence-table"><thead><tr><th>Date</th><th>Mentioned</th><th>Cited</th><th>Comparison</th></tr></thead><tbody>
        {population.trend.map(point => <tr key={point.runId}><td>{new Date(point.createdAt).toLocaleDateString()}</td><td><ReportRate value={point.mentionCoverage} /></td><td><ReportRate value={point.citationCoverage} /></td><td>{point.continuity.state.replaceAll('-', ' ')}</td></tr>)}
      </tbody></table></div>
    </details>
  </>
}

export interface VisibilityReportViewProps {
  report: VisibilityReportResponse
  onSelectionChange: (patch: Record<string, unknown>) => void
  onManageQueries?: () => void
  onPage?: (cursor: string) => void
  onSearch?: (search: string) => void
  search?: string
  queryKey?: string
}

/** Presentation only: every displayed count, rate and population comes from the report. */
export function VisibilityReportView({ report, onSelectionChange, onManageQueries, onPage, onSearch, search = '', queryKey }: VisibilityReportViewProps) {
  const [scopeSearch, setScopeSearch] = useState('')
  const [breakdownSearch, setBreakdownSearch] = useState('')
  const [scopeKind, setScopeKind] = useState<'groups' | 'properties'>(() => report.populations.some(population => population.breakdown.groups.length > 0) ? 'groups' : 'properties')
  const reportElement = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!queryKey) return
    const answers = reportElement.current?.querySelector<HTMLElement>('[aria-label="Measured answers"]')
    answers?.focus({ preventScroll: true })
    answers?.scrollIntoView?.({ block: 'start' })
  }, [queryKey])
  const { selection, scopeOptions, filterOptions } = report
  const measurement = selection.measurement
  const selectedScopeLabel = selection.scope.label
  const visibleScopes = scopeOptions.filter(scope => scope.label.toLocaleLowerCase().includes(scopeSearch.toLocaleLowerCase()))
  const filterSelect = (label: string, key: string, value: string, choices: { value: string; label: string }[]) => <label className="min-w-40 flex-1"><span className="mb-1 block text-sm font-medium text-heading">{label}</span><select aria-label={label} className={REPORT_CONTROL} value={value} onChange={event => onSelectionChange({ [key]: event.target.value || undefined, measurementQueryKey: undefined })}>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
  return <section ref={reportElement} className="page-section-divider" aria-label="AI visibility results">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <ToneBadge tone={measurement.state === 'measured' ? 'positive' : 'neutral'}>{measurement.state === 'measured' ? 'Complete' : measurement.state === 'partial' ? 'Partial' : 'Not measured'}</ToneBadge>
        {measurement.completedAt ? <span className="text-sm text-secondary">{new Date(measurement.completedAt).toLocaleString()}</span> : null}
      </div>
      {onManageQueries ? <Button variant="outline" onClick={onManageQueries}>Manage queries</Button> : null}
    </div>
    {measurement.awaitingSweep ? <p role="status" className="border-b border-default py-3 text-sm text-secondary">Measured under revision {measurement.measuredRevision ?? 'unavailable'}. Project has {measurement.pendingAssignmentCount} assignments awaiting sweep.</p> : null}
    {selection.provenance.kind === 'legacy-simple' ? <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default py-3 text-sm text-secondary"><p>Legacy results have no frozen query classification.</p>{selection.queryClass !== 'unknown' && selection.queryClass !== 'all' ? <Button variant="outline" onClick={() => onSelectionChange({ queryClass: 'unknown', measurementQueryKey: undefined })}>View unclassified results</Button> : null}</div> : null}
    <div className="flex flex-wrap items-start gap-4 border-b border-default py-4">
      {scopeOptions.length > 1 ? <details className="min-w-64 flex-1" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
        <summary className={`${REPORT_CONTROL} cursor-pointer`}>{selectedScopeLabel}</summary>
        <div className="mt-2 border border-default bg-surface p-3">
          <label><span className="sr-only">Search scopes</span><input type="search" aria-label="Search scopes" className={REPORT_CONTROL} placeholder="Search groups, markets, properties" value={scopeSearch} onChange={event => setScopeSearch(event.target.value)} /></label>
          <div className="mt-2 max-h-72 overflow-y-auto">{visibleScopes.map(scope => <button key={`${scope.kind}:${scope.id}`} className="flex min-h-11 w-full items-center justify-between gap-3 rounded px-2 text-left text-sm text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" aria-current={selection.scope.kind === scope.kind && selection.scope.id === scope.id ? 'true' : undefined} onClick={event => { const details = event.currentTarget.closest('details'); if (details) details.open = false; onSelectionChange({ measurementScope: scope.kind, measurementScopeKey: scope.kind === 'project' ? undefined : scope.id }) }}><span>{scope.label}</span><span className="text-secondary">{scope.kind === 'group' ? 'Group' : scope.kind === 'market' ? 'Market' : scope.kind === 'property' ? 'Property' : `${scope.targetCount} properties`}</span></button>)}{visibleScopes.length === 0 ? <p className="py-3 text-sm text-secondary">No matching scopes.</p> : null}</div>
        </div>
      </details> : null}
      {filterSelect('Query type', 'queryClass', selection.queryClass, [{ value: 'non-brand', label: 'Non-brand' }, { value: 'branded', label: 'Branded' }, { value: 'all', label: 'All classes, separate' }, { value: 'unknown', label: 'Unclassified' }])}
      {filterSelect('Answer engine', 'measurementProvider', selection.provider ?? '', [{ value: '', label: 'All engines' }, ...filterOptions.providers.map(provider => ({ value: provider, label: provider }))])}
      {filterSelect('Search location', 'measurementLocation', selection.location.kind === 'exact' ? selection.location.value : selection.location.kind === 'none' ? 'none' : '', [{ value: '', label: 'All locations' }, ...filterOptions.locations.filter(location => location.kind !== 'all').map(location => ({ value: location.kind === 'exact' ? location.value : 'none', label: location.kind === 'exact' ? location.value : 'No location' }))])}
    </div>
    <details className="border-b border-default py-2 text-sm text-secondary"><summary className="min-h-11 cursor-pointer py-3">Date, model and measured run</summary><div className="flex flex-wrap gap-4 pb-3">
      <label className="min-w-40 flex-1"><span className="mb-1 block">From</span><input aria-label="From date" type="date" className={REPORT_CONTROL} value={selection.time.from?.slice(0, 10) ?? ''} onChange={event => onSelectionChange({ measurementFrom: event.target.value ? `${event.target.value}T00:00:00.000Z` : undefined })} /></label>
      <label className="min-w-40 flex-1"><span className="mb-1 block">Through</span><input aria-label="Through date" type="date" className={REPORT_CONTROL} value={selection.time.to?.slice(0, 10) ?? ''} onChange={event => onSelectionChange({ measurementTo: event.target.value ? `${event.target.value}T23:59:59.999Z` : undefined })} /></label>
      {filterSelect('Model', 'measurementModel', selection.model ?? '', [{ value: '', label: 'All observed models' }, ...Array.from(new Set(filterOptions.models.filter(model => !selection.provider || model.provider === selection.provider).map(model => model.model))).map(model => ({ value: model, label: model }))])}
      {filterSelect('Measured run', 'measurementRunId', selection.run.explicit ? selection.run.id ?? '' : '', [{ value: '', label: 'Latest measured results' }, ...report.populations[0]!.trend.map(point => ({ value: point.runId, label: new Date(point.createdAt).toLocaleString() }))])}
    </div></details>
    {report.populations.map(population => <section key={population.queryClass} aria-label={REPORT_CLASS_LABEL[population.queryClass]} className="py-6">
      <div className="section-head"><h2>{REPORT_CLASS_LABEL[population.queryClass]}</h2><InfoTooltip text={population.queryClass === 'non-brand' ? 'Queries that do not name the measured identity. Geography alone is not a brand.' : population.queryClass === 'branded' ? 'Queries that name the measured identity.' : 'The measured definition could not establish a query class. These answers are not included in branded or non-brand rates.'} /></div>
      <div className="flex flex-wrap gap-x-12 gap-y-5 border-y border-default py-5">
        <div><p className="mb-2 text-sm text-secondary">Mentioned answers</p><ReportRate value={population.summary.mentionCoverage} /></div>
        <div><p className="mb-2 text-sm text-secondary">Cited answers</p><ReportRate value={population.summary.citationCoverage} /></div>
        {selection.mode === 'advanced' ? <div><p className="mb-2 text-sm text-secondary">Properties mentioned</p><ReportRate value={population.summary.propertyReach} /></div> : null}
        <div><p className="mb-2 text-sm text-secondary">Queries measured</p><strong className="tabular-nums text-heading">{population.summary.queryCount}</strong></div>
      </div>
      {selection.mode === 'advanced' ? <div className="flex flex-wrap gap-x-8 gap-y-3 border-b border-default py-4" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} property outcomes`}>
        {([['bothSignals', 'mentioned and cited'], ['mentionedOnly', 'mentioned only'], ['citedOnly', 'cited only'], ['neither', 'neither signal'], ['notMeasured', 'not measured']] as const).map(([key, label]) => <div key={key}><strong className="block tabular-nums text-heading">{population.summary.outcomes[key]}</strong><span className="text-sm text-secondary">{label}</span>{key === 'notMeasured' ? <InfoTooltip text="No eligible completed measurement for this selection. This is not the same as a measured answer with neither signal." /> : null}</div>)}
      </div> : null}
      <ReportTrend population={population} />
      {selection.mode === 'advanced' && (population.breakdown.groups.length > 0 || population.breakdown.properties.length > 0) ? <section className="border-t border-default py-5" aria-label="Scope breakdown">
        <div className="flex flex-wrap items-end justify-between gap-3"><div className="flex gap-2"><Button variant={scopeKind === 'groups' ? 'secondary' : 'ghost'} onClick={() => setScopeKind('groups')}>Groups</Button><Button variant={scopeKind === 'properties' ? 'secondary' : 'ghost'} onClick={() => setScopeKind('properties')}>Properties</Button></div><input type="search" aria-label="Search breakdown" placeholder="Search" value={breakdownSearch} onChange={event => setBreakdownSearch(event.target.value)} className={`${REPORT_CONTROL} max-w-sm`} /></div>
        <div className="mt-3 overflow-x-auto"><table className="evidence-table"><thead><tr><th>{scopeKind === 'groups' ? 'Group' : 'Property'}</th><th>Queries</th><th>Mentioned</th><th>Cited</th></tr></thead><tbody>{population.breakdown[scopeKind].filter(row => row.label.toLocaleLowerCase().includes(breakdownSearch.toLocaleLowerCase())).map(row => <tr key={row.id}><td><button className="min-h-11 text-left text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" onClick={() => onSelectionChange({ measurementScope: scopeKind === 'groups' ? 'group' : 'property', measurementScopeKey: row.id })}>{row.label}</button></td><td>{row.queryCount}</td><td><ReportRate value={row.mentionCoverage} /></td><td><ReportRate value={row.citationCoverage} /></td></tr>)}</tbody></table></div>
      </section> : null}
      <section className="border-t border-default py-5" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} query performance`}>
        <div className="section-head"><h3>Query performance</h3>{onSearch ? <input type="search" aria-label={`Search ${REPORT_CLASS_LABEL[population.queryClass]}`} placeholder="Search queries" className={`${REPORT_CONTROL} max-w-sm`} value={search} onChange={event => onSearch(event.target.value)} /> : null}</div>
        <div className="overflow-x-auto"><table className="evidence-table"><thead><tr><th>Query</th><th>Answer engine</th><th>Search location</th><th>Mentioned</th><th>Cited</th><th><span className="sr-only">Evidence</span></th></tr></thead><tbody>{population.queries.items.map(row => <tr key={JSON.stringify([row.queryKey, row.provider, row.model, row.location])}><td className="min-w-64 font-medium text-heading">{row.query}</td><td>{row.provider}{row.model ? <span className="block text-sm text-secondary">{row.model}</span> : null}</td><td>{row.location ?? 'No location'}</td><td><ReportRate value={row.mentionCoverage} /></td><td><ReportRate value={row.citationCoverage} /></td><td><Button variant="ghost" aria-label={`View answers for ${row.query} · ${row.provider}`} onClick={() => onSelectionChange({ queryClass: population.queryClass, measurementQueryKey: row.queryKey, measurementProvider: row.provider, measurementModel: row.model ?? undefined, measurementLocation: row.location ?? 'none' })}>View answers</Button></td></tr>)}</tbody></table></div>
        {population.queries.items.length === 0 ? <p className="py-4 text-sm text-secondary">No measured queries match this selection.</p> : <p className="mt-3 text-sm text-secondary">{population.queries.items.length} shown of {population.queries.total}</p>}
        {population.queries.nextCursor && onPage ? <Button variant="outline" onClick={() => onPage(population.queries.nextCursor!)}>Next queries</Button> : null}
      </section>
      {queryKey ? <section tabIndex={-1} className="scroll-mt-6 border-t border-default py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" aria-label="Measured answers"><div className="section-head"><h3>Answers</h3><Button variant="ghost" onClick={() => onSelectionChange({ measurementQueryKey: undefined })}>Close answers</Button></div>
        {population.evidence.items.map(answer => <article key={answer.answerId} className="border-b border-default py-4"><div className="flex flex-wrap items-center gap-3"><strong className="text-sm text-heading">{answer.provider}</strong><span className="text-sm text-secondary">{answer.location ?? 'No location'}</span><span className="text-sm text-secondary">{new Date(answer.createdAt).toLocaleString()}</span><ToneBadge tone="neutral">{answer.mentioned === null ? 'Mention not checked' : answer.mentioned ? 'Mentioned' : 'Not mentioned'}</ToneBadge><ToneBadge tone="neutral">{answer.cited === null ? 'Citation not checked' : answer.cited ? 'Cited' : 'Not cited'}</ToneBadge></div><h4 className="mt-3 text-sm font-medium text-heading">{answer.query}</h4><p className="mt-3 max-w-prose whitespace-pre-wrap text-sm leading-6 text-primary">{answer.answerText ?? 'Answer text unavailable.'}</p><ul className="mt-3 space-y-2">{answer.sources.map(source => { const url = safeExternalUrl(source); return <li key={source} className="break-all text-sm">{url ? <a href={url} target="_blank" rel="noreferrer" className="text-link hover:underline">{source}</a> : <span className="text-secondary">{source}</span>}</li> })}</ul></article>)}
        {population.evidence.items.length === 0 ? <p className="py-4 text-sm text-secondary">No stored answers for this query in this selection.</p> : null}
        {population.evidence.nextCursor && onPage ? <Button variant="outline" onClick={() => onPage(population.evidence.nextCursor!)}>Next answers</Button> : null}
      </section> : null}
      <section className="border-t border-default py-5" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} competitors`}><div className="section-head"><h3>Competitors</h3></div>
        {population.competitorAvailability.state === 'unavailable' ? <p className="text-sm text-secondary">Competitor rates unavailable for this historical definition.</p> : population.competitors.length === 0 ? <p className="text-sm text-secondary">No measured competitors in this selection.</p> : <div className="overflow-x-auto"><table className="evidence-table"><thead><tr><th>Competitor</th><th>Mentioned</th><th>Cited</th></tr></thead><tbody>{population.competitors.map(row => <tr key={row.domain}><td>{row.domain}</td><td><ReportRate value={row.mentionCoverage} /></td><td><ReportRate value={row.citationCoverage} /></td></tr>)}</tbody></table></div>}
        {population.observedCompetitors.length > 0 ? <details className="mt-4 text-sm"><summary className="min-h-11 cursor-pointer py-3 text-heading">Other names in answers</summary><ul className="divide-y divide-default">{population.observedCompetitors.map(row => <li key={row.name} className="flex items-center justify-between gap-4 py-3"><span>{row.name}</span><span className="tabular-nums text-secondary">{row.answerCount} {row.answerCount === 1 ? 'answer' : 'answers'}</span></li>)}</ul><p className="py-2 text-secondary">Observed names, not additions to your tracked competitors.</p></details> : null}
      </section>
    </section>)}
  </section>
}

export function VisibilityWorkspace({ projectName, selection, onSelectionChange, onManageQueries, fallback }: {
  projectName: string
  selection: VisibilitySelectionState
  onSelectionChange: (patch: Record<string, unknown>) => void
  onManageQueries?: () => void
  fallback?: ReactNode
}) {
  const [cursor, setCursor] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const reportQuery = useQuery({
    ...getApiV1ProjectsByNameVisibilityReportOptions({ client: heyClient, path: { name: projectName }, query: {
      scope: selection.measurementScope, scopeKey: selection.measurementScopeKey, queryClass: selection.queryClass,
      provider: selection.provider, model: selection.model, location: selection.location,
      from: selection.from, to: selection.to, revision: selection.revision,
      runId: selection.measurementRunId, queryKey: selection.queryKey, limit: 50, cursor, search: search || undefined,
    } }),
    retry: false,
    // The parent keys this workspace by every aggregate filter, but opening
    // or closing answers does not replace the summary or query search.
    // Placeholder responses never expose another query's answers below.
    placeholderData: keepPreviousData,
  })
  if (reportQuery.data?.selection.availability.state === 'unsupported') return <>{fallback}</>
  if (reportQuery.error) {
    return <section className="page-section-divider" role="alert"><h2>AI visibility unavailable</h2><p className="my-3 text-sm text-secondary">{describeError(reportQuery.error)}</p><Button variant="outline" onClick={() => { setCursor(undefined); void reportQuery.refetch() }}>Retry</Button></section>
  }
  if (!reportQuery.data) return <section className="page-section-divider" role="status" aria-label="Loading AI visibility"><div className="h-64 animate-pulse rounded-md bg-surface" /></section>
  return <div aria-busy={reportQuery.isFetching}><VisibilityReportView report={reportQuery.data} queryKey={reportQuery.isPlaceholderData ? undefined : selection.queryKey} search={search} onSearch={value => { setSearch(value); setCursor(undefined) }} onPage={reportQuery.isFetching ? undefined : setCursor} onSelectionChange={patch => { setCursor(undefined); onSelectionChange(patch) }} onManageQueries={onManageQueries} /></div>
}
const MODE_OPTIONS: Array<{ value: TrendSeriesMode; label: string }> = [
  { value: 'byProvider', label: 'By engine' },
  { value: 'overall', label: 'All engines' },
]
const METRIC_OPTIONS: Array<{ value: MetricChoice; label: string; description: string }> = [
  {
    value: 'mentioned',
    label: 'Mentioned',
    description: 'Your brand or domain appears in the answer text.',
  },
  {
    value: 'cited',
    label: 'Cited',
    description: 'Your domain appears in source or grounding links.',
  },
  {
    value: 'mentionShare',
    label: 'Mention share',
    description: 'On non-brand queries, the share of answer-text brand mentions for you and tracked competitors that were you. Pooled only when query classification is unavailable.',
  },
]
const MENTION_SHARE_COLOR = CHART_SERIES_COLORS[2]!

/** Dark ring drawn around the active (hovered) dot so it reads against the line. */
const ACTIVE_DOT_RING = 'var(--chart-tooltip-bg)'

/** Human-friendly engine names for the legend and tooltip (data keys are lowercase). */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  local: 'Local',
}

function providerDisplayName(name: string): string {
  const key = normalizeProviderKey(name)
  return PROVIDER_DISPLAY_NAMES[key] ?? name.charAt(0).toUpperCase() + name.slice(1)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function isOverallSeries(key: string): boolean {
  return key === CITED_KEY || key === MENTIONED_KEY || key === MENTION_SHARE_KEY
}

function seriesLabel(key: string): string {
  if (key === CITED_KEY) return 'Cited'
  if (key === MENTIONED_KEY) return 'Mentioned'
  if (key === MENTION_SHARE_KEY) return 'Mention share'
  return providerDisplayName(key)
}

function seriesColor(key: string, index: number): string {
  if (key === CITED_KEY) return CHART_TONE.positive // emerald
  if (key === MENTIONED_KEY) return CHART_SERIES_COLORS[1]! // blue
  if (key === MENTION_SHARE_KEY) return MENTION_SHARE_COLOR
  return providerSeriesColor(normalizeProviderKey(key), index)
}

function firstSeriesValue(rows: Array<Record<string, string | number | null>>, key: string): number | null {
  for (const row of rows) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function competitorFrameKey(competitorDomains: readonly string[]): string {
  return competitorDomains
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('\n')
}

type MetricsBucket = BrandMetricsDto['buckets'][number]
type ProviderMetricBucket = MetricsBucket['byProvider'][string]
type MentionShareScope = MetricsBucket['mentionShare']['scope']

interface TooltipPayloadItem {
  name?: string | number
  dataKey?: string | number
  value?: string | number | null
  color?: string
}

function mentionShareScopeLabel(scope: MentionShareScope): string {
  return scope === 'non-brand'
    ? 'non-brand queries'
    : 'pooled queries · classification unavailable'
}

function metricLabel(metric: MetricChoice, mentionShareScope?: MentionShareScope): string {
  if (metric === 'cited') return 'Cited'
  if (metric === 'mentionShare') {
    return mentionShareScope
      ? `Mention share · ${mentionShareScopeLabel(mentionShareScope)}`
      : 'Mention share'
  }
  return 'Mentioned'
}

function metricField(metric: Exclude<MetricChoice, 'mentionShare'>): 'citationRate' | 'mentionRate' {
  return metric === 'cited' ? 'citationRate' : 'mentionRate'
}

function metricCount(bucket: MetricsBucket, metric: Exclude<MetricChoice, 'mentionShare'>): number {
  return metric === 'cited' ? bucket.cited : bucket.mentionedCount
}

function providerMetricCount(
  bucket: MetricsBucket,
  provider: string,
  metric: Exclude<MetricChoice, 'mentionShare'>,
): { count: number; total: number; rate: number } | null {
  const row = (bucket.byProvider as Record<string, ProviderMetricBucket | undefined>)[provider]
  if (!row) return null
  return {
    count: metric === 'cited' ? row.cited : row.mentionedCount,
    total: row.total,
    rate: metric === 'cited' ? row.citationRate : row.mentionRate,
  }
}

function findBucket(buckets: readonly MetricsBucket[], label: string | number | undefined): MetricsBucket | null {
  if (label === undefined) return null
  const key = String(label)
  return buckets.find(b => b.startDate === key) ?? null
}

function formatBucketModelEvidence(bucket: MetricsBucket): string {
  const evidence = readBucketModelEvidence(bucket)
  if (evidence === null) return 'Model attribution unavailable for this bucket.'
  const labels = Object.entries(evidence)
    .sort(([a], [b]) => normalizeProviderKey(a).localeCompare(normalizeProviderKey(b)))
    .map(([provider, state]) => `${providerDisplayName(provider)}: ${formatModelEvidence(state)}`)
  return labels.length > 0 ? `Model evidence: ${labels.join('; ')}` : 'No model evidence in this bucket.'
}

function modelEventMarkerColor(events: ReturnType<typeof groupModelAttributionEvents>[number]['events']): string {
  if (events.some(({ event }) => event.to.status === 'mixed')) return CHART_TONE.caution
  if (events.some(({ event }) => event.to.status === 'unknown')) return CHART_TONE.negative
  if (events.every(({ event }) => event.from.status === 'known' && event.to.status === 'known')) return CHART_SERIES_COLORS[4]!
  return CHART_TONE.positive
}

/**
 * A model-evidence change is grouped by `bucketStartDate`, which is the
 * synthetic grouping key — never a date to show. Resolve it back to the
 * bucket's real sweep dates; if that bucket is no longer in the response, fall
 * back to the event's own observation time, which is also a real instant.
 */
function modelEventDateLabel(
  buckets: readonly MetricsBucket[],
  bucketStartDate: string,
  observedAt: string,
): string {
  const bucket = findBucket(buckets, bucketStartDate)
  return bucket ? formatBucketDateLabel(bucket) : formatObservedInstantLabel(observedInstant(observedAt))
}

function ModelEvidenceSummary({
  partition,
  available,
  counts,
  truncated,
  incompleteHistory,
  served,
  mismatch,
  buckets,
}: {
  partition: ModelAttributionEventPartition
  available: boolean
  counts: { shown: number; total: number }
  truncated: ProviderEventCount[]
  incompleteHistory: string[]
  served: ReturnType<typeof readServedModelAttribution>
  mismatch: ReturnType<typeof readModelServiceMismatch>
  buckets: readonly MetricsBucket[]
}) {
  const descriptionId = useId()
  const servedEntries = Object.entries(served).sort(([a], [b]) => a.localeCompare(b))
  const hasChanges = partition.buckets.length > 0 || partition.beforeWindow.length > 0
  if (!available || !hasChanges) return null

  return (
    <aside className="trend-model-evidence" aria-labelledby="trend-model-evidence-title" aria-describedby={descriptionId}>
      <div className="trend-model-evidence-head">
        <p id="trend-model-evidence-title" className="trend-model-evidence-title">Model evidence changes</p>
        <span className="trend-model-evidence-key" aria-hidden="true">Dashed chart markers</span>
      </div>
      <p id={descriptionId} className="sr-only">
        Model evidence is recorded from the exact snapshots that produced each trend bucket. It is not the project’s configured provider model.
        {counts.total > 0 ? ` ${counts.shown} of ${counts.total} recorded changes are listed.` : ''}
      </p>
      {partition.buckets.length > 0 && (
        <ul className="trend-model-evidence-list">
          {partition.buckets.flatMap(({ bucketStartDate, events: bucketEvents }) => bucketEvents.map(({ provider, event }) => (
            <li key={`${provider}-${event.observedAt}-${event.bucketStartDate}`} className="trend-model-evidence-item">
              <span className="trend-model-evidence-date">{modelEventDateLabel(buckets, bucketStartDate, event.observedAt)}</span>
              <span>{providerDisplayName(provider)}: {formatModelEvidence(event.from)} → {formatModelEvidence(event.to)}</span>
            </li>
          )))}
        </ul>
      )}
      {/* These changes happened before the chart starts. They are listed so
          nothing is lost, but they get no chart marker — a marker would put
          a date on a change that did not happen on that date. */}
      {partition.beforeWindow.length > 0 && (
        <>
          <p className="trend-model-evidence-note">Changed before this date range</p>
          <ul className="trend-model-evidence-list">
            {partition.beforeWindow.map(({ provider, event }) => (
              <li key={`before-${provider}-${event.observedAt}`} className="trend-model-evidence-item">
                <span className="trend-model-evidence-date">
                  on or before {formatObservedInstantLabel(observedInstant(event.observedAt))}
                </span>
                <span>
                  {providerDisplayName(provider)}: {formatModelEvidence(event.from)} → {formatModelEvidence(event.to)}
                  {event.anchorObservedAt
                    ? ` (last seen ${formatModelEvidence(event.from)} on ${formatObservedInstantLabel(observedInstant(event.anchorObservedAt))})`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {truncated.map(entry => (
        <p key={`truncated-${entry.provider}`} className="trend-model-evidence-note">
          {providerDisplayName(entry.provider)}: showing the most recent {entry.shown} of {entry.total} changes.
        </p>
      ))}
      {incompleteHistory.map(provider => (
        <p key={`incomplete-${provider}`} className="trend-model-evidence-note">
          We did not look far enough back to be sure this is every {providerDisplayName(provider)} change.
        </p>
      ))}
      {servedEntries.length > 0 && (
        <>
          <p className="trend-model-evidence-note">What the engines answered with</p>
          <ul className="trend-model-evidence-list">
            {servedEntries.map(([provider, entry]) => {
              const rawIds = formatServedModelIds(entry.latestServedModelIds)
              const substituted = mismatch[provider]
              return (
                <li key={`served-${provider}`} className="trend-model-evidence-item">
                  <span className="trend-model-evidence-date">{formatObservedInstantLabel(observedInstant(entry.latestObservation.observedAt))}</span>
                  <span>
                    {providerDisplayName(provider)}: {rawIds ?? formatModelEvidence(entry.latestObservation.state)}
                    {substituted ? ` — not the ${formatModelEvidence(substituted.configured)} you selected` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </aside>
  )
}

function formatPercent(value: number | null): string {
  return value === null ? 'no data' : `${value}%`
}

function formatRatePercent(rate: number | null | undefined): string {
  return rate == null ? 'undefined' : `${round1(rate * 100)}%`
}

function TrendTooltip({
  active,
  label,
  payload,
  metric,
  mode,
  buckets,
}: {
  active?: boolean
  label?: string | number
  payload?: TooltipPayloadItem[]
  metric: MetricChoice
  mode: TrendSeriesMode
  buckets: readonly MetricsBucket[]
}) {
  if (!active) return null
  const bucket = findBucket(buckets, label)
  if (!bucket) return null

  if (metric === 'mentionShare') {
    const projectMentions = bucket.mentionShare.projectMentionSnapshots
    const competitorMentions = bucket.mentionShare.competitorMentionSnapshots
    const denominator = projectMentions + competitorMentions
    const rate = bucket.mentionShare.rate == null ? null : round1(bucket.mentionShare.rate * 100)
    return (
      <div className="trend-tooltip">
        <p className="trend-tooltip-label">{formatBucketDateLabel(bucket)}</p>
        <div className="trend-tooltip-row">
          <span className="trend-tooltip-swatch trend-tooltip-swatch-ring" style={{ borderColor: MENTION_SHARE_COLOR }} aria-hidden="true" />
          <span className="trend-tooltip-name">Mention share · {mentionShareScopeLabel(bucket.mentionShare.scope)}</span>
          <span className="trend-tooltip-value">{formatPercent(rate)}</span>
        </div>
        {denominator > 0 ? (
          <p className="trend-tooltip-detail">You {projectMentions} / {denominator} brand mentions. Competitors {competitorMentions}.</p>
        ) : (
          <p className="trend-tooltip-detail">No project or competitor brand mentions in this bucket.</p>
        )}
        <p className="trend-tooltip-detail">{formatBucketModelEvidence(bucket)}</p>
      </div>
    )
  }

  const items = mode === 'byProvider'
    ? (payload ?? []).filter(item => item.dataKey !== undefined)
    : [{ dataKey: metric === 'cited' ? CITED_KEY : MENTIONED_KEY, value: round1(bucket[metricField(metric)] * 100) }]
  return (
    <div className="trend-tooltip">
      <p className="trend-tooltip-label">{formatBucketDateLabel(bucket)}</p>
      {items.map((item, index) => {
        const key = String(item.dataKey ?? item.name ?? '')
        const providerCounts = mode === 'byProvider' ? providerMetricCount(bucket, key, metric) : null
        const count = providerCounts?.count ?? metricCount(bucket, metric)
        const total = providerCounts?.total ?? bucket.total
        const value = typeof item.value === 'number'
          ? item.value
          : providerCounts
            ? round1(providerCounts.rate * 100)
            : round1(bucket[metricField(metric)] * 100)
        const color = item.color ?? seriesColor(key, index)
        return (
          <div key={`${key}-${index}`} className="trend-tooltip-block">
            <div className="trend-tooltip-row">
              <span className="trend-tooltip-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
              <span className="trend-tooltip-name">{seriesLabel(key)}</span>
              <span className="trend-tooltip-value">{formatPercent(value)}</span>
            </div>
            <p className="trend-tooltip-detail">
              {count} / {total} snapshots, {metric === 'cited' ? 'source links' : 'answer text'}
            </p>
          </div>
        )
      })}
      <p className="trend-tooltip-detail">{formatBucketModelEvidence(bucket)}</p>
    </div>
  )
}

function TrendDataSummary({
  buckets,
  metric,
  mode,
  series,
}: {
  buckets: readonly MetricsBucket[]
  metric: MetricChoice
  mode: TrendSeriesMode
  series: readonly string[]
}) {
  const summaryScope = buckets[buckets.length - 1]?.mentionShare.scope
  return (
    <table className="sr-only">
      <caption>{metricLabel(metric, summaryScope)} trend data</caption>
      <thead>
        <tr>
          <th scope="col">Bucket</th>
          <th scope="col">Values</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map(bucket => {
          let valueText: string
          if (metric === 'mentionShare') {
            const projectMentions = bucket.mentionShare.projectMentionSnapshots
            const competitorMentions = bucket.mentionShare.competitorMentionSnapshots
            const denominator = projectMentions + competitorMentions
            const scope = mentionShareScopeLabel(bucket.mentionShare.scope)
            valueText = denominator > 0
              ? `${formatRatePercent(bucket.mentionShare.rate)} mention share for ${scope}, ${projectMentions} of ${denominator} brand mentions were you`
              : `mention share undefined for ${scope}, no project or competitor brand mentions`
          } else if (mode === 'byProvider') {
            valueText = series.map(provider => {
              const counts = providerMetricCount(bucket, provider, metric)
              if (!counts) return `${providerDisplayName(provider)} no data`
              return `${providerDisplayName(provider)} ${formatRatePercent(counts.rate)} ${metricLabel(metric).toLowerCase()}, ${counts.count} of ${counts.total} snapshots`
            }).join('; ')
          } else {
            valueText = `${formatRatePercent(bucket[metricField(metric)])} ${metricLabel(metric).toLowerCase()}, ${metricCount(bucket, metric)} of ${bucket.total} snapshots`
          }
          valueText += `; ${formatBucketModelEvidence(bucket)}`
          return (
            <tr key={bucket.startDate}>
              <th scope="row">{formatBucketDateLabel(bucket)}</th>
              <td>{valueText}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * Single-select segmented control. A group of toggle buttons (`role="group"` +
 * `aria-pressed`), not a tab pattern: these switch the chart's series in place,
 * they don't reveal panels, so tab semantics would mislead assistive tech.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: Array<{ value: T; label: string; description?: string }>
  value: T
  onChange: (next: T) => void
  ariaLabel: string
  className?: string
}) {
  const descriptionBaseId = useId()

  return (
    <div role="group" aria-label={ariaLabel} className={`segmented ${className ?? ''}`}>
      {options.map(opt => {
        const selected = value === opt.value
        const descriptionId = opt.description ? `${descriptionBaseId}-${opt.value}-description` : undefined
        return (
          <Fragment key={opt.value}>
            <button
              type="button"
              aria-pressed={selected}
              aria-describedby={descriptionId}
              className={`segmented-option ${selected ? 'segmented-option-active' : ''}`}
              onClick={() => onChange(opt.value)}
            >
              {opt.label}
            </button>
            {opt.description && (
              <span id={descriptionId} className="sr-only">
                {opt.description}
              </span>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

export function VisibilityTrendSection({
  projectName,
  competitorDomains = [],
  analyticsRevision = 'none',
}: {
  projectName: string
  competitorDomains?: readonly string[]
  /** Latest completed answer-visibility logical-sweep revision from dashboard polling. */
  analyticsRevision?: string
}) {
  const [window, setWindow] = useState<MetricsWindow>('all')
  const [metric, setMetric] = useState<MetricChoice>('mentioned')
  // Default to the per-engine breakdown: the blended line hides that engines
  // disagree wildly (a brand cited heavily by one engine and ignored by
  // another), which is the first thing an operator needs to see.
  const [mode, setMode] = useState<TrendSeriesMode>('byProvider')
  const metricsFrameKey = useMemo(() => competitorFrameKey(competitorDomains), [competitorDomains])

  const metricsQuery = useQuery({
    queryKey: ['analytics-metrics', projectName, window, metricsFrameKey, analyticsRevision],
    queryFn: () => fetchAnalyticsMetrics(projectName, window),
    staleTime: STATIC_VISIBILITY_STALE_MS,
  })
  const data = metricsQuery.data ?? null
  const error = metricsQuery.error

  const effectiveMode: TrendSeriesMode = metric === 'mentionShare' ? 'overall' : mode
  const trend = useMemo(
    () => (data ? buildSelectedTrendRows(data, metric, effectiveMode) : null),
    [data, metric, effectiveMode],
  )
  const modelAttribution = data ? readModelAttribution(data) : null
  // Only the in-window half may become chart markers. A change inherited from
  // the last sweep BEFORE the window has no in-window date to mark.
  const modelEvents = useMemo(
    () => partitionModelAttributionEvents(modelAttribution ?? {}),
    [modelAttribution],
  )
  const modelEventCounts = useMemo(
    () => countModelAttributionEvents(modelAttribution ?? {}),
    [modelAttribution],
  )
  const truncatedProviders = useMemo(
    () => truncatedProviderCounts(modelAttribution ?? {}),
    [modelAttribution],
  )
  const incompleteHistoryProviders = useMemo(
    () => Object.entries(modelAttribution ?? {})
      .filter(([, entry]) => entry.anchorUnavailable)
      .map(([provider]) => provider)
      .sort(),
    [modelAttribution],
  )
  const servedAttribution = useMemo(() => (data ? readServedModelAttribution(data) : {}), [data])
  const serviceMismatch = useMemo(() => (data ? readModelServiceMismatch(data) : {}), [data])
  // Only a recorded update is surfaced in the dashboard. A moving model id
  // with no update on record does not add persistent commentary to the chart.
  const modelChangeNotice = useMemo(
    () => (data ? buildModelChangeNotice(readModelPointerChanges(data)) : null),
    [data],
  )

  // Headline readout: the selected metric's latest bucket value plus its change
  // across the visible window. Quantifies "where it sits now, which way it
  // moved" without reusing the removed trend badges.
  const byProviderMode = metric !== 'mentionShare' && effectiveMode === 'byProvider'
  const buckets = data?.buckets ?? []
  // The top-level scope survives an empty response. Falling back to non-brand
  // here would relabel an empty, unclassifiable project as classifiable.
  const mentionShareScope: MentionShareScope = buckets[buckets.length - 1]?.mentionShare.scope
    ?? data?.mentionShareScope
    ?? 'pooled'
  const currentMetricLabel = metricLabel(metric, mentionShareScope)
  const metricColor = metric === 'cited'
    ? CHART_TONE.positive
    : metric === 'mentionShare'
      ? MENTION_SHARE_COLOR
      : CHART_SERIES_COLORS[1]!
  // In by-engine mode the headline is the blended rate across every engine,
  // which no single line on the chart matches — neutralize the swatch (so it
  // doesn't read as one engine's color) and tag it "avg".
  const headlineDotColor = byProviderMode ? CHART_NEUTRAL.textDim : metricColor
  // The x-axis KEY stays `startDate` (monotonic, and what the model-evidence
  // reference lines are positioned by), but the tick a reader sees is resolved
  // back to the bucket's real first sweep. A key that has no bucket gets no
  // label — better blank than a synthetic boundary printed as a date.
  const bucketTickFormatter = useMemo(() => {
    const labels = new Map(buckets.map(b => [b.startDate, formatBucketDateTick(b)]))
    return (value: string) => labels.get(String(value)) ?? ''
  }, [buckets])
  const latestPct = metric === 'mentionShare'
    ? (trend ? latestSeriesValue(trend.rows, MENTION_SHARE_KEY) : null)
    : buckets.length > 0
      ? round1(buckets[buckets.length - 1]![metricField(metric)] * 100)
      : null
  const firstPct = metric === 'mentionShare'
    ? (trend ? firstSeriesValue(trend.rows, MENTION_SHARE_KEY) : null)
    : buckets.length > 0
      ? round1(buckets[0]![metricField(metric)] * 100)
      : null
  const plottedPointCount = metric === 'mentionShare'
    ? trend?.rows.filter(row => typeof row[MENTION_SHARE_KEY] === 'number').length ?? 0
    : buckets.length
  const deltaPts = latestPct !== null && firstPct !== null && plottedPointCount > 1 ? round1(latestPct - firstPct) : null
  const competitorCount = competitorDomains.length

  const header = (
    <>
      {/* Above the section head, which is where the headline number and its
          delta live. Whoever is about to send that number to a client has to
          meet the caveat BEFORE they read it, so it cannot sit under the head
          (they have already read the number) or in the model-evidence aside
          below the chart (they have already sent it). Tinted, not alarming —
          nothing is broken, the reading just needs care. */}
      {modelChangeNotice?.kind === 'change' && (
        <p className="mb-3 rounded-lg border border-caution-800/60 bg-caution-950/20 px-3 py-2 text-[11px] leading-snug text-secondary">
          {modelChangeNotice.text}
        </p>
      )}
      <div className="visibility-trend-head">
        <div className="space-y-1">
          <p className="eyebrow eyebrow-soft">Trend</p>
          <h2 className="visibility-trend-title">
            Answer-engine trend
            <InfoTooltip text="Three separate signals over sweep buckets: answer text mentions, source citations, and your answer-text mention share against tracked competitors. Mentioned and Cited use all query-provider snapshots. Mention share uses non-brand queries when classification is available; pooled means the project has no usable brand identity for a split." />
          </h2>
        </div>
        {latestPct !== null && (
          <div className="visibility-trend-current">
            <span className="visibility-trend-current-dot" style={{ backgroundColor: headlineDotColor }} aria-hidden="true" />
            <span className="visibility-trend-current-label">{currentMetricLabel}</span>
            {byProviderMode && <span className="visibility-trend-current-qualifier">avg</span>}
            <span className="visibility-trend-current-value">{latestPct}%</span>
            {deltaPts !== null && (
              <span
                className={`visibility-trend-current-delta ${
                  deltaPts > 0 ? 'text-positive-400' : deltaPts < 0 ? 'text-negative-400' : 'text-muted'
                }`}
              >
                {deltaPts > 0 ? '+' : ''}{deltaPts.toFixed(1)} pts
              </span>
            )}
          </div>
        )}
      </div>
      <div className="visibility-trend-controls">
        <Segmented options={METRIC_OPTIONS} value={metric} onChange={setMetric} ariaLabel="Metric" className="visibility-trend-metric-control" />
        {metric !== 'mentionShare' && (
          <Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} ariaLabel="Series" />
        )}
        <Segmented options={WINDOW_OPTIONS} value={window} onChange={setWindow} ariaLabel="Time window" className="sm:ml-auto" />
      </div>
    </>
  )

  let body: React.ReactNode
  if (error) {
    body = <p className="text-sm text-negative-400">{describeError(error)}</p>
  } else if (metricsQuery.isLoading && !data) {
    body = <div className="visibility-trend-chart animate-pulse rounded-lg bg-bg-elevated/40" aria-hidden="true" />
  } else if (metric === 'mentionShare' && competitorCount === 0) {
    body = <p className="text-sm text-secondary">Add tracked competitors to measure mention share over time.</p>
  } else if (!data || !trend) {
    body = null
  } else {
    const { rows, series, hasData } = trend
    const caption = formatQueryChangeCaption(data.queryChanges)
    if (!hasData) {
      body = (
        <p className="text-sm text-secondary">
          {metric === 'mentionShare'
            ? `No answer-text brand mentions for you or tracked competitors on ${mentionShareScopeLabel(mentionShareScope)} in this window yet.`
            : 'Run a sweep to start tracking citations and mentions over time.'}
        </p>
      )
    } else if (byProviderMode && series.length === 0) {
      body = (
        <p className="text-sm text-secondary">
          No per-engine breakdown for this data yet. Switch to <span className="text-strong">All engines</span> to see the trend.
        </p>
      )
    } else {
      const srSummary = `${currentMetricLabel} rate across ${rows.length} ${rows.length === 1 ? 'sweep' : 'sweeps'}. Latest ${latestPct}%${
        deltaPts !== null ? `, ${deltaPts >= 0 ? 'up' : 'down'} ${Math.abs(deltaPts).toFixed(1)} points over the period` : ''
      }.`
      body = (
        <>
          <p className="sr-only">{srSummary}</p>
          <TrendDataSummary buckets={buckets} metric={metric} mode={effectiveMode} series={series} />
          {/* Per-engine key with each line's most recent value, so the engines
              and where they sit now are readable at a glance — replaces the
              cramped bottom legend and gives the by-engine view its payoff. */}
          {byProviderMode && series.length > 0 && (
            <ul className="trend-legend" aria-label="Engines">
              {series.map((key, i) => {
                const value = latestSeriesValue(rows, key)
                const evidence = latestPlottedProviderModelEvidence(buckets, key)
                const evidenceLabel = modelAttribution === null
                  ? 'Attribution unavailable'
                  : evidence
                    ? formatModelEvidence(evidence)
                    : 'No observed model evidence'
                return (
                  <li key={key} className="trend-legend-item">
                    <span
                      className="trend-legend-swatch"
                      style={{ backgroundColor: seriesColor(key, i) }}
                      aria-hidden="true"
                    />
                    <span className="trend-legend-label">
                      <span className="trend-legend-name">{seriesLabel(key)}</span>
                      <span className="trend-legend-model"><span aria-hidden="true">· </span>{evidenceLabel}</span>
                    </span>
                    {value !== null && <span className="trend-legend-value">{value}%</span>}
                  </li>
                )
              })}
            </ul>
          )}
          <div
            className="visibility-trend-chart"
            role="img"
            aria-label={`${currentMetricLabel} trend chart over ${rows.length} ${rows.length === 1 ? 'bucket' : 'buckets'}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={CHART_AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: CHART_AXIS_STROKE }}
                  tickFormatter={bucketTickFormatter}
                  minTickGap={24}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tickFormatter={(v: number) => `${v}%`}
                  tick={CHART_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <RechartsTooltip
                  cursor={{ stroke: CHART_AXIS_STROKE, strokeWidth: 1 }}
                  content={<TrendTooltip metric={metric} mode={effectiveMode} buckets={buckets} />}
                />
                {modelEvents.buckets.map(({ bucketStartDate, events }) => (
                  <ReferenceLine
                    key={`model-evidence-${bucketStartDate}`}
                    x={bucketStartDate}
                    stroke={modelEventMarkerColor(events)}
                    strokeDasharray="4 4"
                    strokeWidth={1.5}
                    ifOverflow="extendDomain"
                  />
                ))}
                {series.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key}
                    stroke={seriesColor(key, i)}
                    strokeDasharray={key === MENTION_SHARE_KEY ? '5 4' : undefined}
                    strokeWidth={isOverallSeries(key) ? 2.5 : 2}
                    // A solid marker on every run/bucket point so the readings are visible.
                    dot={key === MENTION_SHARE_KEY
                      ? { r: 2.75, fill: 'var(--chart-tooltip-bg)', stroke: seriesColor(key, i), strokeWidth: 1.5 }
                      : { r: 2.5, fill: seriesColor(key, i), strokeWidth: 0 }}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: ACTIVE_DOT_RING }}
                    connectNulls={key !== MENTION_SHARE_KEY}
                    isAnimationActive={false}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <ModelEvidenceSummary
            partition={modelEvents}
            available={modelAttribution !== null}
            counts={modelEventCounts}
            truncated={truncatedProviders}
            incompleteHistory={incompleteHistoryProviders}
            served={servedAttribution}
            mismatch={serviceMismatch}
            buckets={buckets}
          />
          {caption && <p className="visibility-trend-note">{caption}</p>}
        </>
      )
    }
  }

  return (
    <section className="visibility-trend">
      {header}
      {body}
    </section>
  )
}
