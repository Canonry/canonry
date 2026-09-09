import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { buildModelChangeNotice, describeError } from '@ainyc/canonry-contracts'
import type { BrandMetricsDto, MetricsWindow } from '@ainyc/canonry-contracts'
import type { VisibilityReportQueryRow, VisibilityReportResponse, VisibilityReportRate, VisibilityReportPopulation } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameVisibilityReportOptions } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../../api.js'
import type { VisibilityAnswerSelection, VisibilitySelectionState } from '../../lib/measurement-view-url.js'
import { Button } from '../ui/button.js'
import { ChevronDown } from 'lucide-react'
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
import { fetchAnalyticsMetrics, isDashboardManagedSweeps } from '../../api.js'
import { MANAGED_SWEEPS_COPY } from './ManagedSweepStatus.js'
import { DataTablePagination, useClientTable } from '../shared/DataTableControls.js'
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

function reportScopeLabel(scope: VisibilityReportResponse['selection']['scope']): string {
  if (scope.kind === 'project') return 'Whole site'
  return scope.kind === 'group' ? `${scope.label} · Group` : scope.kind === 'market' ? `${scope.label} · Market` : scope.label
}

function ReportRate({ value, unit }: { value: VisibilityReportRate; unit?: 'answers' | 'properties' }) {
  if (value.rate === null) return <span className="text-sm text-secondary">{value.reason === 'not-applicable' ? 'Not applicable' : 'Not measured'}</span>
  return <span className="inline-flex flex-col gap-1"><strong className="tabular-nums text-heading">{reportPercent.format(value.rate)}</strong><span className="text-sm tabular-nums text-secondary">{value.numerator} of {value.denominator}{unit ? ` ${unit}` : ''}</span></span>
}

export interface VisibilityQueryGroup {
  queryKey: string
  query: string
  rows: VisibilityReportQueryRow[]
}

/**
 * The report API publishes one row for every observed engine context. Keep
 * those rows intact, but nest them below their one tracked-query identity on
 * the current page so model, location, denominator, and property scope never become an invented
 * query-level aggregate.
 */
export function groupVisibilityQueryRows(rows: readonly VisibilityReportQueryRow[]): VisibilityQueryGroup[] {
  const groups = new Map<string, VisibilityQueryGroup>()
  for (const row of rows) {
    const group = groups.get(row.queryKey)
    if (group) group.rows.push(row)
    else groups.set(row.queryKey, { queryKey: row.queryKey, query: row.query, rows: [row] })
  }
  return [...groups.values()]
}

function ReportTrend({ population }: { population: VisibilityReportPopulation }) {
  const points = population.trend.flatMap(point => {
    const plotted = { createdAt: point.createdAt, mentioned: point.mentionCoverage.rate, cited: point.citationCoverage.rate }
    return point.continuity.state === 'comparable' || point.continuity.state === 'first'
      ? [plotted]
      : [{ createdAt: point.createdAt, mentioned: null, cited: null }, plotted]
  })
  if (points.length === 0) return <p className="py-6 text-sm text-secondary">No measured trend for this selection.</p>
  const hasRates = points.some(point => point.mentioned !== null || point.cited !== null)
  return <>
    {hasRates ? <>
      <ul aria-label="Trend legend" className="flex gap-5 py-3 text-sm text-secondary">
        <li className="flex items-center gap-2"><span aria-hidden="true" className="h-0.5 w-5" style={{ backgroundColor: CHART_SERIES_COLORS[1] }} />Mentioned</li>
        <li className="flex items-center gap-2"><span aria-hidden="true" className="h-0.5 w-5" style={{ backgroundColor: CHART_TONE.positive }} />Cited</li>
      </ul>
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
    </> : <p className="py-6 text-sm text-secondary">No measured trend for this selection.</p>}
    <details className="py-3 text-sm text-secondary"><summary className="min-h-11 cursor-pointer py-3">Trend data and comparability</summary>
      <div className="overflow-x-auto"><table className="evidence-table"><thead><tr><th>Date</th><th>Mentioned</th><th>Cited</th><th>Comparison</th></tr></thead><tbody>
        {population.trend.map(point => <tr key={point.runId}><td>{new Date(point.createdAt).toLocaleDateString()}</td><td><ReportRate value={point.mentionCoverage} /></td><td><ReportRate value={point.citationCoverage} /></td><td>{point.continuity.state.replaceAll('-', ' ')}</td></tr>)}
      </tbody></table></div>
    </details>
  </>
}

export interface VisibilityReportViewProps {
  report: VisibilityReportResponse
  isRefreshing?: boolean
  onSelectionChange: (patch: Record<string, unknown>) => void
  onManageQueries?: () => void
  onPage?: (cursor: string) => void
  onSearch?: (search: string) => void
  search?: string
  queryKey?: string
  answerSelection?: VisibilityAnswerSelection
  evidenceReport?: VisibilityReportResponse
  isEvidenceLoading?: boolean
  evidenceError?: string
  onRetryEvidence?: () => void
  onEvidencePage?: (cursor: string) => void
}

/** Shared by the live report and the isolated overview review. No metric changes. */
export function VisibilityReportFilters({ report, onSelectionChange }: Pick<VisibilityReportViewProps, 'report' | 'onSelectionChange'>) {
  const [scopeSearch, setScopeSearch] = useState('')
  const picker = useRef<HTMLDetailsElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const scopeId = useId()
  const { selection, scopeOptions, filterOptions } = report
  const scopeLabel = reportScopeLabel(selection.scope)
  const visibleScopes = scopeOptions.filter(scope => `${scope.kind === 'project' ? 'Whole site' : scope.label} ${scope.kind}`.toLocaleLowerCase().includes(scopeSearch.trim().toLocaleLowerCase()))

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (picker.current?.open && event.target instanceof Node && !picker.current.contains(event.target)) picker.current.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  const select = (label: string, key: string, value: string, choices: { value: string; label: string }[]) => (
    <label className="min-w-0">
      <span className="mb-1 block text-sm font-medium text-heading">{label}</span>
      <select aria-label={label} className={REPORT_CONTROL} value={value} onChange={event => onSelectionChange({ [key]: event.target.value || undefined, measurementQueryKey: undefined })}>
        {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
    </label>
  )

  return <div className="visibility-filter-container"><div className="visibility-report-filters" data-has-scope={scopeOptions.length > 1} role="group" aria-label="Visibility filters">
    {scopeOptions.length > 1 ? <div className="min-w-0">
      <span id={`${scopeId}-label`} className="mb-1 block text-sm font-medium text-heading">Measurement scope</span>
      <details ref={picker} className="relative" onToggle={event => { if (event.currentTarget.open) { setScopeSearch(''); searchInput.current?.focus() } }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
      }}>
        <summary id={`${scopeId}-value`} aria-labelledby={`${scopeId}-label ${scopeId}-value`} className={`${REPORT_CONTROL} visibility-scope-trigger`}>
          {scopeLabel}<ChevronDown size={16} aria-hidden="true" className="shrink-0 text-secondary" />
        </summary>
        <div className="visibility-scope-menu">
          <input ref={searchInput} type="search" aria-label="Search scopes" className={REPORT_CONTROL} placeholder="Search groups, markets, properties" value={scopeSearch} onChange={event => setScopeSearch(event.target.value)} />
          <div className="mt-2 max-h-72 overflow-y-auto">{visibleScopes.map(scope => <button key={`${scope.kind}:${scope.id}`} className="flex min-h-11 w-full items-center justify-between gap-3 rounded px-2 text-left text-sm text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" aria-current={selection.scope.kind === scope.kind && selection.scope.id === scope.id ? 'true' : undefined} onClick={() => {
            if (picker.current) { picker.current.open = false; picker.current.querySelector('summary')?.focus() }
            onSelectionChange({ measurementScope: scope.kind, measurementScopeKey: scope.kind === 'project' ? undefined : scope.id })
          }}><span className="min-w-0 break-words">{scope.kind === 'project' ? 'Whole site' : scope.label}</span><span className="shrink-0 text-right text-xs text-secondary">{scope.kind === 'group' ? <>Group<span className="block">{scope.targetCount} properties</span></> : scope.kind === 'market' ? <>Market<span className="block">query context</span></> : scope.kind === 'property' ? 'Property' : `${scope.targetCount} properties`}</span></button>)}{visibleScopes.length === 0 ? <p className="py-3 text-sm text-secondary">No matching scopes.</p> : null}</div>
        </div>
      </details>
    </div> : null}
    {select('Query type', 'queryClass', selection.queryClass, [{ value: 'all', label: 'All queries' }, { value: 'non-brand', label: 'Non-brand' }, { value: 'branded', label: 'Branded' }, { value: 'unknown', label: 'Unclassified' }])}
    {select('Answer engine', 'measurementProvider', selection.provider ?? '', [{ value: '', label: 'All engines' }, ...filterOptions.providers.map(provider => ({ value: provider, label: provider }))])}
    {select('Search location', 'measurementLocation', selection.location.kind === 'exact' ? selection.location.value : selection.location.kind === 'none' ? 'none' : '', [{ value: '', label: 'All locations' }, ...filterOptions.locations.filter(location => location.kind !== 'all').map(location => ({ value: location.kind === 'exact' ? location.value : 'none', label: location.kind === 'exact' ? location.value : 'No location' }))])}
  </div></div>
}

/** Presentation only: every displayed count, rate and population comes from the report. */
export function VisibilityReportView({ report, isRefreshing = false, onSelectionChange, onManageQueries, onPage, onSearch, search = '', queryKey, answerSelection, evidenceReport, isEvidenceLoading = false, evidenceError, onRetryEvidence, onEvidencePage }: VisibilityReportViewProps) {
  const reportElement = useRef<HTMLElement>(null)
  const focusedQueryKey = useRef<string | undefined>(undefined)
  const answerReport = evidenceReport ?? report
  const matchingPopulations = answerReport.populations.filter(population => [...population.queries.items, ...population.evidence.items].some(row => row.queryKey === queryKey))
  const answerClasses = answerSelection ? [answerSelection.queryClass] : (matchingPopulations.length ? matchingPopulations : isEvidenceLoading ? [] : report.populations.slice(0, 1)).map(population => population.queryClass)
  const answerFocusKey = queryKey ? JSON.stringify([answerSelection ?? queryKey, answerClasses]) : undefined
  const filterId = useId()
  useEffect(() => {
    if (!answerFocusKey) {
      if (!isRefreshing) focusedQueryKey.current = undefined
      return
    }
    if (focusedQueryKey.current === answerFocusKey) return
    const answers = reportElement.current?.querySelectorAll<HTMLElement>('[aria-label="Measured answers"]')
    if (!answers?.length) return
    for (const answer of answers) {
      const results = answer.closest<HTMLDetailsElement>('details[data-query-results]')
      if (results) results.open = true
    }
    answers[0]!.focus({ preventScroll: true })
    answers[0]!.scrollIntoView?.({ block: 'start' })
    focusedQueryKey.current = answerFocusKey
  }, [answerFocusKey, isRefreshing])
  const { selection, filterOptions } = report
  const measurement = selection.measurement
  const scopeLabel = reportScopeLabel(selection.scope)
  const targetLabels = new Map(report.scopeOptions.filter(scope => scope.kind === 'property').map(scope => [scope.id, scope.label]))
  const answerPage = (population: VisibilityReportPopulation) => {
    const evidence = answerReport.populations.find(value => value.queryClass === population.queryClass)?.evidence
    return {
      items: evidence?.items.filter(answer => answer.queryKey === queryKey && (!answerSelection || (
        answer.provider === answerSelection.provider && answer.model === answerSelection.model
        && answer.location === answerSelection.location && (answerSelection.runId === null || answer.runId === answerSelection.runId)
      ))) ?? [],
      nextCursor: evidence?.nextCursor,
    }
  }
  const filterSelect = (label: string, key: string, value: string, choices: { value: string; label: string }[], help: string) => <div className="min-w-40 flex-1">
    <div className="mb-1 flex items-center gap-1"><label htmlFor={`${filterId}-${key}`} className="text-sm font-medium text-heading">{label}</label><InfoTooltip text={help} /></div>
    <select id={`${filterId}-${key}`} className={REPORT_CONTROL} value={value} onChange={event => onSelectionChange({ [key]: event.target.value || undefined, measurementQueryKey: undefined })}>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
  </div>
  return <section ref={reportElement} className="visibility-report" aria-label="AI visibility results">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <ToneBadge tone={measurement.state === 'measured' ? 'positive' : 'neutral'}>{measurement.state === 'measured' ? 'Complete' : measurement.state === 'partial' ? 'Partial' : 'Not measured'}</ToneBadge>
        {measurement.completedAt ? <span className="text-sm text-secondary">{new Date(measurement.completedAt).toLocaleString()}</span> : null}
        {measurement.awaitingSweep ? <span role="status" className="inline-flex items-center gap-1 text-sm text-secondary"><span>{measurement.pendingAssignmentCount} query assignments pending across project</span><InfoTooltip text={`Measured under revision ${measurement.measuredRevision ?? 'unavailable'}. Project has ${measurement.pendingAssignmentCount} assignments awaiting sweep. Existing results stay visible until those assignments are measured.`} /></span> : null}
      </div>
      {onManageQueries ? <Button variant="outline" onClick={onManageQueries}>Manage queries</Button> : null}
    </div>
    {selection.provenance.kind === 'legacy-simple' && selection.queryClass !== 'unknown' && selection.queryClass !== 'all' ? <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default py-3 text-sm text-secondary"><p>These saved results aren't separated by query type.</p><Button variant="outline" onClick={() => onSelectionChange({ queryClass: 'all', measurementQueryKey: undefined })}>View all saved results</Button></div> : null}
    <VisibilityReportFilters report={report} onSelectionChange={onSelectionChange} />
    <details className="border-b border-default text-sm text-secondary"><summary className="min-h-11 cursor-pointer py-3">More filters</summary><div className="flex flex-wrap gap-4 pb-3">
      <label className="min-w-40 flex-1"><span className="mb-1 block text-sm font-medium text-heading">Start date (UTC)</span><input type="date" className={REPORT_CONTROL} value={selection.time.from?.slice(0, 10) ?? ''} onChange={event => onSelectionChange({ measurementFrom: event.target.value ? `${event.target.value}T00:00:00.000Z` : undefined })} /></label>
      <label className="min-w-40 flex-1"><span className="mb-1 block text-sm font-medium text-heading">End date (UTC)</span><input type="date" className={REPORT_CONTROL} value={selection.time.to?.slice(0, 10) ?? ''} onChange={event => onSelectionChange({ measurementTo: event.target.value ? `${event.target.value}T23:59:59.999Z` : undefined })} /></label>
      {filterSelect('AI model', 'measurementModel', selection.model ?? '', [{ value: '', label: 'All models' }, ...Array.from(new Set(filterOptions.models.filter(model => !selection.provider || model.provider === selection.provider).map(model => model.model))).map(model => ({ value: model, label: model }))], 'Filter by the AI model recorded with each answer. This does not change the model used by future sweeps.')}
      {filterSelect('Results from', 'measurementRunId', selection.run.explicit ? selection.run.id ?? '' : '', [{ value: '', label: 'Latest saved sweep' }, ...[...report.populations[0]!.trend].reverse().map(point => ({ value: point.runId, label: new Date(point.createdAt).toLocaleString() }))], 'Choose a saved AI sweep to view its results. No new sweep starts.')}
    </div></details>
    {report.populations.map(population => {
      // Simple history can predate query labels. In the all-query view, lead
      // with its saved results instead of empty classes that never had queries.
      // Retain historical populations and any explicitly requested class.
      if (selection.mode === 'simple' && selection.queryClass === 'all'
        && population.summary.queryCount === 0 && !population.trend.some(point => point.queryCount > 0)
        && !(queryKey && answerClasses.includes(population.queryClass))
        && report.populations.some(other => other.summary.queryCount > 0 || other.trend.some(point => point.queryCount > 0))) return null
      const queryGroups = groupVisibilityQueryRows(population.queries.items)
      const queryColumnCount = selection.mode === 'advanced' ? 7 : 6
      return <section key={population.queryClass} aria-label={REPORT_CLASS_LABEL[population.queryClass]} className="py-4">
      <div className="section-head"><h2>{REPORT_CLASS_LABEL[population.queryClass]}</h2><InfoTooltip text={population.queryClass === 'non-brand' ? 'Queries that do not name the measured identity. Geography alone is not a brand.' : population.queryClass === 'branded' ? 'Queries that name the measured identity.' : 'These queries were not labeled as branded or non-brand when measured. Their saved results remain available here, separate from branded and non-brand rates.'} /></div>
      <div className="flex flex-wrap gap-x-8 gap-y-4 border-y border-default py-4">
        <div><div className="mb-2 flex items-center gap-1 text-sm text-secondary"><span>{selection.mode === 'advanced' && selection.scope.kind !== 'property' ? 'Answers mentioning a property' : 'Mentioned answers'}</span>{selection.mode === 'advanced' ? <InfoTooltip text="An answer counts when it mentions any assigned property. This does not mean every property was mentioned." /> : null}</div><ReportRate value={population.summary.mentionCoverage} unit="answers" /></div>
        <div><div className="mb-2 flex items-center gap-1 text-sm text-secondary"><span>{selection.mode === 'advanced' && selection.scope.kind !== 'property' ? 'Answers citing a property' : 'Cited answers'}</span>{selection.mode === 'advanced' ? <InfoTooltip text="An answer counts when it cites a matching URL for any assigned property. This does not mean every property was cited." /> : null}</div><ReportRate value={population.summary.citationCoverage} unit="answers" /></div>
        {selection.mode === 'advanced' && selection.scope.kind !== 'property' ? <div><p className="mb-2 text-sm text-secondary">Properties mentioned</p><ReportRate value={population.summary.propertyReach} unit="properties" /></div> : null}
        <div><p className="mb-2 text-sm text-secondary">Queries measured</p><strong className="tabular-nums text-heading">{population.summary.queryCount}</strong></div>
      </div>
      <ReportTrend population={population} />
      {selection.mode === 'advanced' ? <details className="border-t border-default text-sm text-secondary" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} property outcomes`}><summary className="min-h-11 cursor-pointer py-3">Property outcomes</summary><div className="flex flex-wrap gap-x-8 gap-y-3 pb-4">
        {([['bothSignals', 'mentioned and cited'], ['mentionedOnly', 'mentioned only'], ['citedOnly', 'cited only'], ['neither', 'neither signal'], ['notMeasured', 'not measured']] as const).map(([key, label]) => <div key={key}><strong className="block tabular-nums text-heading">{population.summary.outcomes[key]}</strong><span className="text-sm text-secondary">{label}</span>{key === 'notMeasured' ? <InfoTooltip text="No eligible completed measurement for this selection. This is not the same as a measured answer with neither signal." /> : null}</div>)}
      </div></details> : null}
      {selection.mode === 'advanced' && selection.scope.kind !== 'property' && (population.breakdown.groups.length > 0 || population.breakdown.properties.length > 0) ? <ReportScopeBreakdown key={`${selection.scope.kind}:${selection.scope.id}`} population={population} scope={selection.scope.kind} onSelectionChange={onSelectionChange} /> : null}
      <details className="border-t border-default" data-query-results={population.queryClass} aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} query results`}>
        <summary className="min-h-11 cursor-pointer py-5 text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"><span className="font-semibold">Query results</span><span className="ml-3 text-sm font-normal text-secondary">{population.queries.total} {population.queries.total === 1 ? 'result' : 'results'} · {scopeLabel}</span></summary>
        <div className="pb-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">{onSearch ? <input type="search" aria-label={`Search ${REPORT_CLASS_LABEL[population.queryClass]}`} placeholder="Search queries" className={`${REPORT_CONTROL} max-w-sm`} value={search} onChange={event => onSearch(event.target.value)} /> : null}<InfoTooltip text={selection.mode === 'advanced' ? 'Each tracked query is grouped once on this page. Its engine rows retain the recorded model, location, property scope, and answer counts. Mentioned and Cited count answers matching any assigned property, not the percentage of properties found.' : 'Each tracked query is grouped once on this page. Its engine rows retain the recorded model, location, and answer counts. Mentioned counts answers naming your brand. Cited counts answers linking to your site.'} /></div>
        <div className="overflow-x-auto">
          <table className="evidence-table measurement-responsive-table">
            <thead><tr><th>Query</th>{selection.mode === 'advanced' ? <th>Properties</th> : null}<th>Answer engine</th><th>Search location</th><th>Mentioned</th><th>Cited</th><th className="measurement-table-actions"><span className="sr-only">Evidence</span></th></tr></thead>
            {queryGroups.map(group => <tbody key={group.queryKey} data-query-key={group.queryKey}>
              <tr className="bg-surface-subtle">
                <th scope="rowgroup" colSpan={queryColumnCount} className="measurement-query-cell text-sm font-medium normal-case tracking-normal text-heading">{group.query}</th>
              </tr>
              {group.rows.map(row => <tr key={JSON.stringify([row.provider, row.model, row.location])}>
                <td aria-label={`Query: ${group.query}`} className="measurement-query-cell text-secondary"><span aria-hidden="true">↳</span></td>
                {selection.mode === 'advanced' ? <td className="measurement-target-cell">
                  {row.targetKeys.length === 1 ? targetLabels.get(row.targetKeys[0]!) ?? row.targetKeys[0] : row.targetKeys.length > 1 ? <details>
                    <summary className="min-h-11 cursor-pointer py-2 text-secondary">{row.targetKeys.length} properties</summary>
                    <ul className="max-h-48 space-y-2 overflow-y-auto py-2 text-sm text-secondary">{row.targetKeys.map(key => <li key={key}>{targetLabels.get(key) ?? key}</li>)}</ul>
                  </details> : 'No properties'}
                </td> : null}
                <td>{row.provider}{row.model ? <span className="block text-sm text-secondary">{row.model}</span> : null}</td>
                <td>{row.location ?? 'No location'}</td>
                <td><ReportRate value={row.mentionCoverage} /></td>
                <td><ReportRate value={row.citationCoverage} /></td>
                <td className="measurement-table-actions"><Button variant="ghost" aria-label={`View answers for ${row.query} · ${row.provider}`} onClick={() => onSelectionChange({ measurementQueryKey: row.queryKey, measurementAnswer: JSON.stringify({ queryKey: row.queryKey, queryClass: population.queryClass, provider: row.provider, model: row.model, location: row.location, runId: selection.run.id, revision: selection.revision } satisfies VisibilityAnswerSelection) })}>View answers</Button></td>
              </tr>)}
            </tbody>)}
          </table>
        </div>
        {population.queries.items.length === 0 ? <p className="py-4 text-sm text-secondary">No measured queries match this selection.</p> : <p className="mt-3 text-sm text-secondary">{queryGroups.length} {queryGroups.length === 1 ? 'query' : 'queries'} · {population.queries.items.length} {population.queries.items.length === 1 ? 'engine result' : 'engine results'} shown of {population.queries.total} results</p>}
        {population.queries.nextCursor && onPage ? <Button variant="outline" onClick={() => onPage(population.queries.nextCursor!)}>Next queries</Button> : null}
      {queryKey && answerClasses.includes(population.queryClass) ? <section tabIndex={-1} className="scroll-mt-6 border-t border-default py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" aria-label="Measured answers" aria-busy={isEvidenceLoading}><div className="section-head"><h3>Answers</h3><Button variant="ghost" onClick={event => { focusedQueryKey.current = undefined; event.currentTarget.closest('details[data-query-results]')?.querySelector('summary')?.focus(); onSelectionChange({ measurementQueryKey: undefined, measurementAnswer: undefined }) }}>Close answers</Button></div>
        {isEvidenceLoading ? <p role="status" className="py-4 text-sm text-secondary">Loading saved answers…</p> : evidenceError ? <div role="alert" className="py-4 text-sm text-secondary"><p>Saved answers unavailable: {evidenceError}</p>{onRetryEvidence ? <Button variant="outline" onClick={onRetryEvidence}>Retry answers</Button> : null}</div> : <>
        {answerPage(population).items.map(answer => <article key={answer.answerId} className="border-b border-default py-4"><div className="flex flex-wrap items-center gap-3"><strong className="text-sm text-heading">{answer.provider}</strong>{answer.model ? <span className="text-sm text-secondary">{answer.model}</span> : null}<span className="text-sm text-secondary">{answer.location ?? 'No location'}</span><span className="text-sm text-secondary">{new Date(answer.createdAt).toLocaleString()}</span><ToneBadge tone="neutral">{answer.mentioned === null ? 'Mention not checked' : answer.mentioned ? 'Mentioned' : 'Not mentioned'}</ToneBadge><ToneBadge tone="neutral">{answer.cited === null ? 'Citation not checked' : answer.cited ? 'Cited' : 'Not cited'}</ToneBadge></div><h4 className="mt-3 text-sm font-medium text-heading">{answer.query}</h4><p className="mt-3 max-w-prose whitespace-pre-wrap text-sm leading-6 text-primary">{answer.answerText ?? 'Answer text unavailable.'}</p><ul className="mt-3 space-y-2">{answer.sources.map(source => { const url = safeExternalUrl(source); return <li key={source} className="break-all text-sm">{url ? <a href={url} target="_blank" rel="noreferrer" className="text-link hover:underline">{source}</a> : <span className="text-secondary">{source}</span>}</li> })}</ul></article>)}
        {answerPage(population).items.length === 0 ? <p className="py-4 text-sm text-secondary">{answerPage(population).nextCursor ? 'No matching answers on this page. Continue to the next answers.' : 'No matching saved answers on this page.'}</p> : null}
        {answerPage(population).nextCursor && onEvidencePage ? <Button variant="outline" onClick={() => onEvidencePage(answerPage(population).nextCursor!)}>Next answers</Button> : null}
        </>}
      </section> : null}
        </div>
      </details>
      <details className="border-t border-default" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} competitors`}><summary className="min-h-11 cursor-pointer py-5 text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"><span className="font-semibold">Competitors</span><span className="ml-3 text-sm font-normal text-secondary">{population.competitorAvailability.state === 'unavailable' ? 'Not available' : `${population.competitors.length} measured`}</span></summary><div className="pb-5">
        {population.competitorAvailability.state === 'unavailable' ? <p className="text-sm text-secondary">Competitor rates unavailable for this historical definition.</p> : population.competitors.length === 0 ? <p className="text-sm text-secondary">No measured competitors in this selection.</p> : <div className="overflow-x-auto"><table className="evidence-table"><thead><tr><th>Competitor</th><th>Mentioned</th><th>Cited</th></tr></thead><tbody>{population.competitors.map(row => <tr key={row.domain}><td>{row.domain}</td><td><ReportRate value={row.mentionCoverage} /></td><td><ReportRate value={row.citationCoverage} /></td></tr>)}</tbody></table></div>}
        {population.observedCompetitors.length > 0 ? <details className="mt-4 text-sm"><summary className="min-h-11 cursor-pointer py-3 text-heading">Other names in answers</summary><ul className="divide-y divide-default">{population.observedCompetitors.map(row => <li key={row.name} className="flex items-center justify-between gap-4 py-3"><span>{row.name}</span><span className="tabular-nums text-secondary">{row.answerCount} {row.answerCount === 1 ? 'answer' : 'answers'}</span></li>)}</ul><p className="py-2 text-secondary">Observed names, not additions to your tracked competitors.</p></details> : null}
      </div></details>
    </section>})}
  </section>
}

function ReportScopeBreakdown({ population, scope, onSelectionChange }: {
  population: VisibilityReportPopulation
  scope: VisibilityReportResponse['selection']['scope']['kind']
  onSelectionChange: VisibilityReportViewProps['onSelectionChange']
}) {
  const [kind, setKind] = useState<'groups' | 'properties'>(() => scope === 'project' && population.breakdown.groups.length > 0 ? 'groups' : 'properties')
  const table = useClientTable({ rows: population.breakdown[kind], getSearchText: row => row.label })
  return <section className="border-t border-default py-5" aria-label="Scope breakdown">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex gap-2">{(['groups', 'properties'] as const).map(value => <Button key={value} variant={kind === value ? 'secondary' : 'ghost'} onClick={() => { setKind(value); table.setPage(1) }}>{value === 'groups' ? 'Groups' : 'Properties'}</Button>)}</div>
      <input type="search" aria-label="Search breakdown" placeholder="Search" value={table.query} onChange={event => table.setQuery(event.target.value)} className={`${REPORT_CONTROL} max-w-sm`} />
    </div>
    <div className="mt-3 overflow-x-auto"><table className="evidence-table"><thead><tr><th>{kind === 'groups' ? 'Group' : 'Property'}</th><th>Queries</th><th>Mentioned</th><th>Cited</th></tr></thead><tbody>{table.rows.map(row => <tr key={row.id}><td><button className="min-h-11 text-left text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" onClick={() => onSelectionChange({ measurementScope: kind === 'groups' ? 'group' : 'property', measurementScopeKey: row.id })}>{row.label}</button></td><td>{row.queryCount}</td><td><ReportRate value={row.mentionCoverage} /></td><td><ReportRate value={row.citationCoverage} /></td></tr>)}</tbody></table></div>
    {table.rows.length === 0 ? <p className="py-3 text-sm text-secondary">No {kind} match this search.</p> : null}
    <DataTablePagination page={table.page} pageSize={table.pageSize} visibleRows={table.rows.length} totalRows={table.totalRows} itemLabel={kind} onPageChange={table.setPage} />
  </section>
}

export function VisibilityWorkspace({ projectName, selection, onSelectionChange, onManageQueries, fallback, showUnmeasuredFallback = false }: {
  projectName: string
  selection: VisibilitySelectionState
  onSelectionChange: (patch: Record<string, unknown>) => void
  onManageQueries?: () => void
  fallback?: ReactNode
  showUnmeasuredFallback?: boolean
}) {
  const [cursor, setCursor] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const [answerCursor, setAnswerCursor] = useState<{ selection: string; cursor: string }>()
  const sharedQuery = {
    scope: selection.measurementScope, scopeKey: selection.measurementScopeKey, queryClass: selection.queryClass,
    provider: selection.provider, model: selection.model, location: selection.location,
    from: selection.from, to: selection.to, revision: selection.revision, runId: selection.measurementRunId,
  }
  const reportQuery = useQuery({
    ...getApiV1ProjectsByNameVisibilityReportOptions({ client: heyClient, path: { name: projectName }, query: {
      ...sharedQuery, limit: 25, cursor, search: search || undefined,
    } }),
    retry: false,
    // The parent keys this workspace by every aggregate filter, but opening
    // or closing answers does not replace the summary or query search.
    // Placeholder responses never expose another query's answers below.
    placeholderData: keepPreviousData,
  })
  const evidenceQueryParams = {
    ...sharedQuery,
    queryKey: selection.queryKey,
    queryClass: selection.answer?.queryClass ?? selection.queryClass,
    provider: selection.answer?.provider ?? selection.provider,
    model: selection.answer ? selection.answer.model ?? undefined : selection.model,
    location: selection.answer ? selection.answer.location ?? 'none' : selection.location,
    runId: selection.answer?.runId ?? reportQuery.data?.selection.run.id ?? selection.measurementRunId,
    revision: selection.answer?.revision ?? reportQuery.data?.selection.revision ?? selection.revision,
    limit: 50,
  }
  const evidenceIdentity = JSON.stringify(evidenceQueryParams)
  const evidenceQuery = useQuery({
    ...getApiV1ProjectsByNameVisibilityReportOptions({ client: heyClient, path: { name: projectName }, query: {
      ...evidenceQueryParams, cursor: answerCursor?.selection === evidenceIdentity ? answerCursor.cursor : undefined,
    } }),
    enabled: Boolean(selection.queryKey) && Boolean(reportQuery.data) && !reportQuery.isPlaceholderData,
    retry: false,
  })
  if (reportQuery.data?.selection.availability.state === 'unsupported') return <>{fallback}</>
  if (showUnmeasuredFallback && reportQuery.data?.selection.mode === 'simple' && reportQuery.data.selection.measurement.state === 'not-measured') return <>{fallback}</>
  if (reportQuery.error) {
    return <section className="page-section-divider" role="alert"><h2>AI visibility unavailable</h2><p className="my-3 text-sm text-secondary">{describeError(reportQuery.error)}</p><Button variant="outline" onClick={() => { setCursor(undefined); void reportQuery.refetch() }}>Retry</Button></section>
  }
  if (!reportQuery.data) return <section className="page-section-divider" role="status" aria-label="Loading AI visibility"><div className="h-64 animate-pulse rounded-md bg-surface" /></section>
  return <div aria-busy={reportQuery.isFetching}><VisibilityReportView
    report={reportQuery.data}
    isRefreshing={reportQuery.isFetching}
    queryKey={selection.queryKey}
    answerSelection={selection.answer}
    evidenceReport={evidenceQuery.data}
    isEvidenceLoading={evidenceQuery.isFetching || (Boolean(selection.queryKey) && evidenceQuery.isPending)}
    evidenceError={evidenceQuery.error ? describeError(evidenceQuery.error) : undefined}
    onRetryEvidence={() => { void evidenceQuery.refetch() }}
    onEvidencePage={evidenceQuery.isFetching ? undefined : value => setAnswerCursor({ selection: evidenceIdentity, cursor: value })}
    search={search}
    onSearch={value => { setSearch(value); setCursor(undefined) }}
    onPage={reportQuery.isFetching ? undefined : setCursor}
    onSelectionChange={patch => {
      if (!('measurementQueryKey' in patch) || Object.keys(patch).some(key => key !== 'measurementQueryKey' && key !== 'measurementAnswer')) setCursor(undefined)
      setAnswerCursor(undefined)
      onSelectionChange(patch)
    }}
    onManageQueries={onManageQueries}
  /></div>
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
            : isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : 'Run a sweep to start tracking citations and mentions over time.'}
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
