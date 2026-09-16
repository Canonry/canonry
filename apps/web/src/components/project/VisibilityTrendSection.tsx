import { REPORT_VISIBILITY_COPY } from '@ainyc/canonry-contracts'
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { buildModelChangeNotice, describeError, formatPointDelta, parseVisibilityReportScopeErrorDetails, VisibilityReportComparisonUnavailableReasons, VisibilityReportRateChangeUnavailableReasons, VisibilityReportScopeErrorReasons } from '@ainyc/canonry-contracts'
import type { BrandMetricsDto, MetricsWindow } from '@ainyc/canonry-contracts'
import type { VisibilityReportComparison, VisibilityReportQueryRow, VisibilityReportResponse, VisibilityReportRate, VisibilityReportPopulation, VisibilityReportSummary } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameVisibilityReportOptions } from '@ainyc/canonry-api-client/react-query'
import { apiErrorDetails, heyClient } from '../../api.js'
import type { VisibilityAnswerSelection, VisibilitySelectionState } from '../../lib/measurement-view-url.js'
import { visibilityReportFirstPageQuery } from '../../lib/measurement-view-url.js'
import { Button } from '../ui/button.js'
import { Check, ChevronRight, Minus, X } from 'lucide-react'
import { AnswerMarkdown, ANSWER_SOURCES_LABEL } from '../shared/AnswerMarkdown.js'
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
  CHART_TOOLTIP_STYLE,
  ComposedChart,
  formatChartDateLabel,
  formatChartDateMonthDay,
  formatObservedInstantLabel,
  formatObservedInstantMonthDay,
  Line,
  observedInstant,
  observedInstantYear,
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
import { DEFAULT_QUERY_STALE_MS, STATIC_VISIBILITY_STALE_MS } from '../../queries/query-client.js'
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

export const VISIBILITY_ANSWERS_LABEL = 'Measured answers'
export const VISIBILITY_CLOSE_ANSWERS_LABEL = 'Close answers'

const REPORT_CLASS_LABEL = { 'non-brand': 'Non-brand queries', branded: 'Branded queries', unknown: 'Unclassified queries' }
export const REPORT_CLASS_NOUN = { 'non-brand': 'non-brand queries', branded: 'branded queries', unknown: 'unclassified queries' } as const

/**
 * Headline words. A tile carries its own metric's movement in short words; the
 * caption names the compared sweep — or the one reason there is nothing to
 * compare — exactly once for the whole strip.
 */
export const REPORT_CHANGE_COPY = {
  up: (magnitude: string) => `Up ${magnitude} pts`,
  down: (magnitude: string) => `Down ${magnitude} pts`,
  none: 'No change',
  previousUnavailable: 'No earlier value',
  comparedWith: (date: string) => `vs ${date} sweep`,
  noPreviousRun: 'No earlier sweep to compare',
  definitionChanged: (date: string | null) => date === null ? 'Not compared: setup changed' : `Not compared: setup changed since ${date}`,
  modelChanged: (date: string | null) => date === null ? 'Not compared: engines or models changed' : `Not compared: engines or models changed since ${date}`,
  legacyUnknown: 'Not compared: older sweep lacks comparison details',
  partialRun: 'Not compared: a sweep was incomplete',
  scopedRun: 'Not compared: this sweep covered part of the project',
  explanation: 'Change compares this sweep with the sweep before it when both completed and used the same setup, engines and models.',
} as const

/**
 * Help for every headline tile label, in every scope. Mention reads the answer
 * text and Cited reads the source links; the two are never described as one
 * signal. Property reach states the server's `propertyReach`: eligible selected
 * Properties named in at least one measured answer, counted once per Property,
 * and unavailable as a whole while any eligible Property stays unmeasured.
 */
export const REPORT_HEADLINE_HELP = {
  simpleMention: 'Mentioned counts answers naming your brand in the answer text, not in the source links.',
  simpleCitation: 'Cited counts answers linking to your site in the sources behind the answer, not in the answer text.',
  advancedMention: 'An answer counts when it mentions any assigned property. This does not mean every property was mentioned.',
  advancedCitation: 'An answer counts when it cites a matching URL for any assigned property. This does not mean every property was cited.',
  propertyReach: 'Selected properties named in at least one measured answer, out of the selected properties that have a name to match on. It counts properties, not answers, and shows no rate while any of those properties is unmeasured.',
} as const
const REPORT_CONTROL = 'min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const reportPercent = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 })

function reportScopeLabel(scope: VisibilityReportResponse['selection']['scope']): string {
  if (scope.kind === 'project') return 'Whole site'
  return scope.kind === 'group' ? `${scope.label} · Group` : scope.kind === 'market' ? `${scope.label} · Market` : scope.label
}

function reportRateReason(value: VisibilityReportRate): string {
  return value.reason === 'identity-ambiguous' ? REPORT_VISIBILITY_COPY.ambiguous : value.reason === 'not-applicable' ? 'Not applicable' : 'Not measured'
}

function ReportRate({ value }: { value: VisibilityReportRate }) {
  if (value.rate === null) return <span className="text-sm text-secondary">{reportRateReason(value)}</span>
  return <span className="inline-flex flex-col gap-1"><strong className="tabular-nums text-heading">{reportPercent.format(value.rate)}</strong><span className="text-sm tabular-nums text-secondary">{value.numerator} of {value.denominator}</span></span>
}

/** A bounded bar at the server rate. The rate text beside it carries the value for assistive tech. */
function ReportRateBar({ value }: { value: VisibilityReportRate }) {
  if (value.rate === null) return null
  return <span className="report-rate-bar" aria-hidden="true"><span className="report-rate-bar-fill progress-fill-neutral" style={{ width: `${value.rate * 100}%` }} /></span>
}

type ReportHeadlineMetric = 'mentionCoverage' | 'citationCoverage' | 'propertyReach'
interface ReportChangeLine { text: string; tone: 'text-positive' | 'text-negative' | 'text-secondary' }

/**
 * One headline metric's movement, in words beside its value. Formats the server
 * delta and computes nothing. A population the server could not compare at all,
 * and a metric whose current value is unavailable or inapplicable, print nothing
 * here — the caption carries the one population-level reason.
 */
function reportChangeLine(comparison: VisibilityReportComparison | undefined, metric: ReportHeadlineMetric): ReportChangeLine | null {
  if (!comparison || comparison.state === 'unavailable') return null
  const change = comparison[metric]
  if (change.state === 'unavailable') {
    switch (change.reason) {
      case VisibilityReportRateChangeUnavailableReasons['previous-unavailable']: return { text: REPORT_CHANGE_COPY.previousUnavailable, tone: 'text-secondary' }
      case VisibilityReportRateChangeUnavailableReasons['current-unavailable']:
      case VisibilityReportRateChangeUnavailableReasons['not-applicable']: return null
    }
  }
  const { direction, magnitude } = formatPointDelta(change.delta)
  switch (direction) {
    case 'up': return { text: REPORT_CHANGE_COPY.up(magnitude), tone: 'text-positive' }
    case 'down': return { text: REPORT_CHANGE_COPY.down(magnitude), tone: 'text-negative' }
    case 'none': return { text: REPORT_CHANGE_COPY.none, tone: 'text-secondary' }
  }
}

/**
 * The compared sweep's date. A sweep time is an OBSERVED INSTANT, so it
 * localizes to the viewer; the year is dropped only when the viewer reads both
 * sweeps in the same year, and kept whenever the comparison crosses one.
 */
function reportComparedDate(previousCreatedAt: string, displayedAt: string | null): string {
  const previous = observedInstant(previousCreatedAt)
  const sameYear = displayedAt !== null && observedInstantYear(previous) === observedInstantYear(observedInstant(displayedAt))
  return sameYear ? formatObservedInstantMonthDay(previous) : formatObservedInstantLabel(previous)
}

/** The sweep the strip describes: the selected run, else the completed measurement, else the newest plotted point. */
function displayedSweepAt(selection: VisibilityReportResponse['selection'], population: VisibilityReportPopulation): string | null {
  const selected = selection.run.id === null ? undefined : population.trend.find(point => point.runId === selection.run.id)
  return selected?.createdAt ?? selection.measurement.completedAt ?? population.trend.at(-1)?.createdAt ?? null
}

/**
 * The one place the comparison is named. An available comparison names the
 * previous sweep; an unavailable one states its reason once, in place of that
 * date; no selected sweep and an absent comparison name nothing at all.
 */
function reportComparisonCaption(comparison: VisibilityReportComparison | undefined, displayedAt: string | null): string | null {
  if (!comparison) return null
  if (comparison.state === 'unavailable') {
    const since = comparison.previousRun ? reportComparedDate(comparison.previousRun.createdAt, displayedAt) : null
    switch (comparison.reason) {
      case VisibilityReportComparisonUnavailableReasons['no-selected-run']: return null
      case VisibilityReportComparisonUnavailableReasons['no-previous-run']: return REPORT_CHANGE_COPY.noPreviousRun
      case VisibilityReportComparisonUnavailableReasons['definition-changed']: return REPORT_CHANGE_COPY.definitionChanged(since)
      case VisibilityReportComparisonUnavailableReasons['model-changed']: return REPORT_CHANGE_COPY.modelChanged(since)
      case VisibilityReportComparisonUnavailableReasons['legacy-unknown']: return REPORT_CHANGE_COPY.legacyUnknown
      case VisibilityReportComparisonUnavailableReasons['partial-run']: return REPORT_CHANGE_COPY.partialRun
      case VisibilityReportComparisonUnavailableReasons['scoped-run']: return REPORT_CHANGE_COPY.scopedRun
    }
  }
  return REPORT_CHANGE_COPY.comparedWith(reportComparedDate(comparison.previousRun.createdAt, displayedAt))
}

/** Population size, then the compared sweep. The class itself is named by the section heading. */
function reportHeadlineCaption(summary: VisibilityReportSummary, comparison: string | null): string {
  const counts = `${summary.queryCount} ${summary.queryCount === 1 ? 'query' : 'queries'} · ${summary.answerCount} ${summary.answerCount === 1 ? 'answer' : 'answers'}`
  return comparison === null ? counts : `${counts} · ${comparison}`
}

/**
 * One headline tile: its own quiet surface, a labelled rate with the change
 * beside it, and one supporting line. The class is visible in the section
 * heading, so each figure repeats it for assistive tech only.
 */
function ReportHeadlineCell({ label, help, value, unit, classNoun, change }: {
  label: string
  help: string
  value: VisibilityReportRate
  unit: 'answers' | 'properties'
  classNoun: string
  change: ReportChangeLine | null
}) {
  const queryClassSuffix = <span className="sr-only">{` · ${classNoun}`}</span>
  return <div className="report-headline-tile">
    <dt className="flex items-center gap-1 text-sm text-secondary"><span>{label}</span><InfoTooltip text={help} /></dt>
    {value.rate === null ? <dd className="text-lg text-secondary">{reportRateReason(value)}{queryClassSuffix}</dd> : <>
      <dd className="report-headline-value">
        <span className="text-3xl font-semibold tabular-nums text-heading">{reportPercent.format(value.rate)}</span>
        {queryClassSuffix}
        {change ? <span className={`text-sm ${change.tone}`}>{change.text}</span> : null}
      </dd>
      <dd className="text-sm tabular-nums text-secondary">{`${value.numerator} of ${value.denominator} ${unit}`}</dd>
    </>}
  </div>
}

export const REPORT_MARKET_COPY = { otherQueries: 'Other queries' }

/** Recovery for a saved scope or market that the displayed measurement no longer has. */
export const VISIBILITY_SCOPE_RECOVERY_COPY = {
  retiredScope: 'This saved scope is unavailable for this measurement. Show the whole site to choose another.',
  retiredMarket: 'This saved market is unavailable for this measurement. Show all markets to choose another.',
  showWholeSite: 'Show whole site',
  showAllMarkets: 'Show all markets',
} as const

export interface VisibilityQueryGroup {
  queryKey: string
  query: string
  rows: VisibilityReportQueryRow[]
  marketLabel?: string
}

/**
 * The report API publishes one row for every observed engine context. Keep
 * those rows intact, but nest them below their one tracked-query identity on
 * the current page so model, location, denominator, and property scope never become an invented
 * query-level aggregate.
 */
export function groupVisibilityQueryRows(rows: readonly VisibilityReportQueryRow[], markets?: Map<string, string>): VisibilityQueryGroup[] {
  const groups = new Map<string, VisibilityQueryGroup>()
  for (const row of rows) {
    const group = groups.get(row.queryKey)
    if (group) group.rows.push(row)
    else groups.set(row.queryKey, { queryKey: row.queryKey, query: row.query, rows: [row] })
  }
  const result = [...groups.values()]
  if (!markets || !rows.some(row => row.marketKeys?.length)) return result
  for (const group of result) {
    const keys = [...new Set(group.rows.flatMap(row => row.marketKeys ?? []))].sort()
    group.marketLabel = keys.map(key => markets.get(key) ?? key).join(' · ') || REPORT_MARKET_COPY.otherQueries
  }
  return result.sort((left, right) => left.marketLabel!.localeCompare(right.marketLabel!) || left.query.localeCompare(right.query))
}

function QueryResultRate({ value, singleAnswer }: { value: VisibilityReportRate; singleAnswer: boolean }) {
  if (singleAnswer && value.denominator === 1 && (value.rate === 0 || value.rate === 1)) {
    const found = value.rate === 1
    return <span className={`inline-flex items-center gap-2 text-sm ${found ? 'text-positive' : 'text-secondary'}`}>
      {found ? <Check size={16} aria-hidden="true" /> : <Minus size={16} aria-hidden="true" />}{found ? 'Yes' : 'No'}
    </span>
  }
  return <span className="inline-flex items-center gap-1"><ReportRate value={value} />{value.reason === 'evidence-incomplete' ? <InfoTooltip text="The saved evidence is incomplete, so this result cannot be measured. It does not mean the answer had no citation." /> : null}</span>
}

function QueryProperties({ targetKeys, labels }: { targetKeys: string[]; labels: Map<string, string> }) {
  if (targetKeys.length === 0) return <span>No assigned properties</span>
  if (targetKeys.length === 1) return <span>{labels.get(targetKeys[0]!) ?? targetKeys[0]}</span>
  return <details>
    <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">{targetKeys.length} properties</summary>
    <ul className="max-h-48 space-y-2 overflow-y-auto pb-3">{targetKeys.map(key => <li key={key}>{labels.get(key) ?? key}</li>)}</ul>
  </details>
}

function QueryResultGroup({ group, advanced, targetLabels, marketHeading, onViewAnswers }: {
  group: VisibilityQueryGroup
  advanced: boolean
  marketHeading?: string
  targetLabels: Map<string, string>
  onViewAnswers: (row: VisibilityReportQueryRow, trigger: HTMLButtonElement) => void
}) {
  const first = group.rows[0]!
  const targetIdentity = (row: VisibilityReportQueryRow) => JSON.stringify([...row.targetKeys].sort())
  const sharedTargets = group.rows.every(row => targetIdentity(row) === targetIdentity(first))
  const sharedLocation = group.rows.every(row => row.location === first.location)
  const locationLabel = (location: string | null) => location === null ? 'No location targeting' : `Search location: ${location}`
  return <tbody data-query-key={group.queryKey}>
    {marketHeading ? <tr><th colSpan={4} className="border-t border-default py-4 text-left"><h3 className="text-base font-semibold text-heading">{marketHeading}</h3></th></tr> : null}
    <tr className="measurement-result-heading"><th scope="rowgroup" colSpan={4}>
      <h3 className="break-words text-base font-medium text-heading">{group.query}</h3>
      <div className="flex flex-wrap items-center gap-x-5 text-sm font-normal text-secondary">
        {advanced && sharedTargets ? <QueryProperties targetKeys={first.targetKeys} labels={targetLabels} /> : null}
        {sharedLocation ? <span>{locationLabel(first.location)}</span> : null}
      </div>
    </th></tr>
    {group.rows.map(row => <tr className="measurement-engine-result" key={JSON.stringify([row.provider, row.model, row.location])}>
      <td className="measurement-result-engine">
        <span className="font-medium text-heading">{providerDisplayName(row.provider)}</span>
        <span className="block break-words text-sm text-secondary">{row.model ?? 'Model not recorded'}</span>
        {advanced && !sharedTargets ? <div className="mt-1 text-sm text-secondary"><QueryProperties targetKeys={row.targetKeys} labels={targetLabels} /></div> : null}
        {!sharedLocation ? <span className="mt-1 block text-sm text-secondary">{locationLabel(row.location)}</span> : null}
      </td>
      <td><span className="measurement-result-mobile-label" aria-hidden="true">Mentioned</span><QueryResultRate value={row.mentionCoverage} singleAnswer={row.answerCount === 1} /></td>
      <td><span className="measurement-result-mobile-label" aria-hidden="true">Cited</span><QueryResultRate value={row.citationCoverage} singleAnswer={row.answerCount === 1} /></td>
      <td className="measurement-result-action"><Button variant="ghost" className="min-h-11" aria-label={`View answers for ${row.query} · ${row.provider}`} onClick={event => onViewAnswers(row, event.currentTarget)}>{row.answerCount === 1 ? 'View answer' : 'View answers'}<ChevronRight size={16} aria-hidden="true" /></Button></td>
    </tr>)}
  </tbody>
}

type ReportTrendSeries = 'mentioned' | 'cited'
const REPORT_TREND_SERIES: ReadonlyArray<{ key: ReportTrendSeries; label: string; color: string; dashed: boolean }> = [
  { key: 'mentioned', label: 'Mentioned', color: CHART_SERIES_COLORS[1]!, dashed: false },
  { key: 'cited', label: 'Cited', color: CHART_TONE.positive, dashed: true },
]
/** Hollow Cited dots take the chart surface color, so the dashed series reads apart from Mentioned in both themes. */
const REPORT_TREND_HOLLOW_DOT = 'var(--chart-tooltip-bg)'

function ReportTrend({ population }: { population: VisibilityReportPopulation }) {
  const descriptionId = useId()
  const [visibleSeries, setVisibleSeries] = useState<Record<ReportTrendSeries, boolean>>({ mentioned: true, cited: true })
  const visibleKeys = REPORT_TREND_SERIES.filter(series => visibleSeries[series.key]).map(series => series.key)
  // The last visible series stays on, so the chart never empties.
  const toggleSeries = (key: ReportTrendSeries) => setVisibleSeries(current => {
    const next = { ...current, [key]: !current[key] }
    return next.mentioned || next.cited ? next : current
  })
  let segment = 0
  const points = population.trend.map((point, index) => {
    if (index > 0 && point.continuity.state !== 'comparable') segment += 1
    return {
      createdAt: Date.parse(point.createdAt),
      [`mentioned-${segment}`]: point.mentionCoverage.rate,
      [`cited-${segment}`]: point.citationCoverage.rate,
    }
  })
  const segments = Array.from({ length: segment + 1 }, (_, index) => index)
  const boundaries = new Set(population.trend.slice(1).map(point => point.continuity.state))
  const notes = [
    ...(points.length === 1 ? ['First measurement. A trend appears after another comparable run.'] : []),
    ...(boundaries.has('definition-changed') ? ['Gaps mark changes to what was measured.'] : []),
    ...(boundaries.has('model-changed') ? ['Gaps mark changes to answer engines or models.'] : []),
    ...(boundaries.has('legacy-unknown') ? ['Older runs lack the details needed for comparison.'] : []),
    ...(population.trend.some(point => point.citationCoverage.reason === 'evidence-incomplete') ? ['Missing citation results mean the saved evidence is incomplete.'] : []),
  ]
  if (points.length === 0) return <p className="py-6 text-sm text-secondary">No measured trend for this selection.</p>
  const hasRates = population.trend.some(point => point.mentionCoverage.rate !== null || point.citationCoverage.rate !== null)
  return <>
    {hasRates ? <>
      <fieldset className="flex flex-wrap gap-x-5 py-1 text-sm text-secondary">
        <legend className="sr-only">Trend legend</legend>
        {REPORT_TREND_SERIES.map(series => <label key={series.key} className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="size-4 accent-mono-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" checked={visibleSeries[series.key]} disabled={visibleSeries[series.key] && visibleKeys.length === 1} onChange={() => toggleSeries(series.key)} />
          <svg aria-hidden="true" className="shrink-0" width="24" height="10" viewBox="0 0 24 10"><line x1="0" y1="5" x2="24" y2="5" stroke={series.color} strokeWidth="2" strokeDasharray={series.dashed ? '6 4' : undefined} /><circle cx="12" cy="5" r="3" fill={series.dashed ? REPORT_TREND_HOLLOW_DOT : series.color} stroke={series.color} strokeWidth="2" /></svg>
          {series.label}
        </label>)}
      </fieldset>
      {notes.length > 0 && <p id={descriptionId} className="pb-3 text-sm text-secondary">{notes.join(' ')}</p>}
      <div className="visibility-trend-chart" role="img" data-visible-series={visibleKeys.join(' ')} aria-describedby={notes.length > 0 ? descriptionId : undefined} aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} mention and citation trend`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
            <XAxis dataKey="createdAt" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={CHART_AXIS_TICK} tickLine={false} axisLine={{ stroke: CHART_AXIS_STROKE }} tickFormatter={value => new Date(Number(value)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} minTickGap={24} />
            <YAxis domain={[0, 1]} tick={CHART_AXIS_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={value => reportPercent.format(Number(value))} />
            <RechartsTooltip {...CHART_TOOLTIP_STYLE} formatter={value => typeof value === 'number' ? reportPercent.format(value) : 'Not measured'} labelFormatter={value => new Date(Number(value)).toLocaleDateString()} />
            {segments.map(index => <Fragment key={index}>
              {visibleSeries.mentioned ? <Line type="linear" dataKey={`mentioned-${index}`} name="Mentioned" stroke={CHART_SERIES_COLORS[1]} strokeWidth={2} connectNulls={false} isAnimationActive={false} dot={{ r: 3, fill: CHART_SERIES_COLORS[1] }} /> : null}
              {/* A dot inherits the line's dash pattern unless it resets it. */}
              {visibleSeries.cited ? <Line type="linear" dataKey={`cited-${index}`} name="Cited" stroke={CHART_TONE.positive} strokeWidth={2} strokeDasharray="6 4" connectNulls={false} isAnimationActive={false} dot={{ r: 3, fill: REPORT_TREND_HOLLOW_DOT, strokeDasharray: 'none' }} /> : null}
            </Fragment>)}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </> : <p className="py-6 text-sm text-secondary">No measured trend for this selection.</p>}
    <div className={hasRates ? 'sr-only' : 'overflow-x-auto'}>
      <table className="evidence-table" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} trend data`}><thead><tr><th>Date</th><th>Mentioned</th><th>Cited</th><th>Comparison</th></tr></thead><tbody>
        {population.trend.map(point => <tr key={point.runId}><td>{new Date(point.createdAt).toLocaleDateString()}</td><td><ReportRate value={point.mentionCoverage} /></td><td><ReportRate value={point.citationCoverage} /></td><td>{point.continuity.state.replaceAll('-', ' ')}</td></tr>)}
      </tbody></table>
    </div>
  </>
}

export interface VisibilityReportViewProps {
  report: VisibilityReportResponse
  isRefreshing?: boolean
  onSelectionChange: (patch: Record<string, unknown>) => void
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

function matchingReportPopulation(report: VisibilityReportResponse | undefined, queryKey?: string) {
  return queryKey ? report?.populations.find(population => [...population.queries.items, ...population.evidence.items].some(row => row.queryKey === queryKey)) : undefined
}

function selectedReportPopulation(report: VisibilityReportResponse, queryKey?: string, answerSelection?: VisibilityAnswerSelection, evidenceReport?: VisibilityReportResponse) {
  const requested = report.selection.queryClass === 'all' ? answerSelection?.queryClass : report.selection.queryClass
  const explicit = report.populations.find(population => population.queryClass === requested)
  if (explicit) return explicit
  const matching = matchingReportPopulation(evidenceReport, queryKey) ?? matchingReportPopulation(report, queryKey)
  const matchingAggregate = report.populations.find(population => population.queryClass === matching?.queryClass)
  if (matchingAggregate) return matchingAggregate
  // Clean URLs request all classes so older, unclassified history remains
  // discoverable. Display a single population without combining its rates.
  const ordered = (['non-brand', 'branded', 'unknown'] as const).map(queryClass => report.populations.find(population => population.queryClass === queryClass))
  return ordered.find(population => population && (population.summary.queryCount > 0 || population.trend.some(point => point.queryCount > 0)))
    ?? ordered.find(population => population !== undefined)
    ?? report.populations[0]!
}

/** Results toolbar copy. A filter token names the URL value it removes. */
export const VISIBILITY_TOOLBAR_COPY = {
  queryType: 'Query type',
  filters: (activeCount: number) => activeCount === 0 ? 'Filters' : `Filters · ${activeCount}`,
  panel: 'Visibility filters',
  clearFilters: 'Clear filters',
  manageQueries: 'Manage queries',
  removeFilter: (label: string) => `Remove filter ${label}`,
  engine: (provider: string) => `Engine: ${provider}`,
  model: (model: string) => `Model: ${model}`,
  location: (location: string) => `Location: ${location}`,
  noLocation: 'No location',
  dateRange: (from: string, to: string) => `${from} to ${to} (UTC)`,
  dateFrom: (from: string) => `From ${from} (UTC)`,
  dateThrough: (to: string) => `Through ${to} (UTC)`,
  resultsFrom: (date: string) => `Results from: ${date}`,
  resultsFromSelectedSweep: 'Results from: selected sweep',
} as const

/** Clear filters empties exactly the panel's filters. Scope, market, class and every other param stay. */
const CLEARED_VISIBILITY_FILTERS = {
  measurementProvider: undefined, measurementModel: undefined, measurementLocation: undefined,
  measurementFrom: undefined, measurementTo: undefined, measurementRunId: undefined,
} as const

/** The toolbar select sizes to its content instead of filling a grid cell. */
const TOOLBAR_SELECT = 'min-h-11 rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'

interface VisibilityFilterChoice { value: string; label: string }

interface VisibilityFilterToken {
  key: 'engine' | 'model' | 'location' | 'dates' | 'run'
  label: string
  /** Removing a token clears only the URL keys it names. */
  patch: Record<string, undefined>
}

/** URL dates are UTC calendar days, so the label reads their prefix and names UTC. */
function dateFilterLabel(from: string | undefined, to: string | undefined): string | null {
  // A range inside one calendar year names that year once.
  if (from && to) return VISIBILITY_TOOLBAR_COPY.dateRange(from.slice(0, 4) === to.slice(0, 4) ? formatChartDateMonthDay(from) : formatChartDateLabel(from), formatChartDateLabel(to))
  if (from) return VISIBILITY_TOOLBAR_COPY.dateFrom(formatChartDateLabel(from))
  if (to) return VISIBILITY_TOOLBAR_COPY.dateThrough(formatChartDateLabel(to))
  return null
}

/** One token per non-default URL filter. Labels read the URL, never the server echo. */
function visibilityFilterTokens(selection: VisibilitySelectionState, report: VisibilityReportResponse): VisibilityFilterToken[] {
  const tokens: VisibilityFilterToken[] = []
  if (selection.provider) tokens.push({ key: 'engine', label: VISIBILITY_TOOLBAR_COPY.engine(selection.provider), patch: { measurementProvider: undefined } })
  if (selection.model) tokens.push({ key: 'model', label: VISIBILITY_TOOLBAR_COPY.model(selection.model), patch: { measurementModel: undefined } })
  if (selection.location) tokens.push({ key: 'location', label: selection.location === 'none' ? VISIBILITY_TOOLBAR_COPY.noLocation : VISIBILITY_TOOLBAR_COPY.location(selection.location), patch: { measurementLocation: undefined } })
  const dates = dateFilterLabel(selection.from, selection.to)
  if (dates) tokens.push({ key: 'dates', label: dates, patch: { measurementFrom: undefined, measurementTo: undefined } })
  if (selection.measurementRunId) {
    // The displayed trend dates the sweep; a report still loading may not include it yet.
    const point = report.populations.flatMap(population => population.trend).find(trendPoint => trendPoint.runId === selection.measurementRunId)
    tokens.push({
      key: 'run',
      label: point ? VISIBILITY_TOOLBAR_COPY.resultsFrom(formatObservedInstantLabel(observedInstant(point.createdAt))) : VISIBILITY_TOOLBAR_COPY.resultsFromSelectedSweep,
      patch: { measurementRunId: undefined },
    })
  }
  return tokens
}

/** Keep the URL value selectable, so a select never shows a value it cannot hold. */
function withSelectedChoice(choices: VisibilityFilterChoice[], value: string, label: string): VisibilityFilterChoice[] {
  return value === '' || choices.some(choice => choice.value === value) ? choices : [...choices, { value, label }]
}

export interface VisibilityResultsToolbarProps {
  /** The displayed report. It supplies the run state and the choice lists. */
  report: VisibilityReportResponse
  /** The URL selection. It supplies every control value and token. */
  selection: VisibilitySelectionState
  onSelectionChange: (patch: Record<string, unknown>) => void
  onManageQueries?: () => void
  /** Rendered only for an Advanced Property scope. The caller owns routing and search preservation. */
  renderPropertyLink?: (property: { id: string; label: string }) => ReactNode
}

/**
 * Query type, run state, active filter tokens and the inline Filters panel.
 * Presentation only: every value comes from the URL selection or the report.
 */
export function VisibilityResultsToolbar({ report, selection, onSelectionChange, onManageQueries, renderPropertyLink }: VisibilityResultsToolbarProps) {
  const [open, setOpen] = useState(false)
  const filtersButton = useRef<HTMLButtonElement>(null)
  const controlId = useId()
  const panelId = `${controlId}-filters`
  const { filterOptions, selection: served } = report
  const measurement = served.measurement
  const population = selectedReportPopulation(report, selection.queryKey, selection.answer)
  // A clean URL asks for every class until normalization records the served one.
  const queryClass = selection.queryClass === 'all' ? population.queryClass : selection.queryClass
  const tokens = visibilityFilterTokens(selection, report)
  const propertyLink = served.mode === 'advanced' && served.scope.kind === 'property' ? renderPropertyLink?.({ id: served.scope.id, label: served.scope.label }) : null
  const provider = selection.provider ?? ''
  const model = selection.model ?? ''
  const location = selection.location ?? ''
  const runId = selection.measurementRunId ?? ''
  const focusFilters = () => filtersButton.current?.focus()
  const filterSelect = (label: string, key: string, value: string, choices: VisibilityFilterChoice[], help?: string) => <div className="min-w-0">
    <div className="mb-1 flex items-center gap-1"><label htmlFor={`${controlId}-${key}`} className="text-sm font-medium text-heading">{label}</label>{help ? <InfoTooltip text={help} /> : null}</div>
    <select id={`${controlId}-${key}`} className={REPORT_CONTROL} value={value} onChange={event => onSelectionChange({ [key]: event.target.value || undefined, measurementQueryKey: undefined })}>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
  </div>
  const dateInput = (label: string, key: 'measurementFrom' | 'measurementTo', value: string | undefined, time: string) => <div className="min-w-0">
    <label htmlFor={`${controlId}-${key}`} className="mb-1 block text-sm font-medium text-heading">{label}</label>
    <input id={`${controlId}-${key}`} type="date" className={REPORT_CONTROL} value={value?.slice(0, 10) ?? ''} onChange={event => onSelectionChange({ [key]: event.target.value ? `${event.target.value}${time}` : undefined })} />
  </div>
  return <div className="visibility-filter-container">
    <div className="visibility-results-toolbar">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2">
          <span className="text-sm font-medium text-heading">{VISIBILITY_TOOLBAR_COPY.queryType}</span>
          <select aria-label={VISIBILITY_TOOLBAR_COPY.queryType} className={TOOLBAR_SELECT} value={queryClass} onChange={event => onSelectionChange({ queryClass: event.target.value, measurementQueryKey: undefined })}>
            <option value="non-brand">Non-brand</option>
            <option value="branded">Branded</option>
            <option value="unknown">Unclassified</option>
          </select>
        </label>
        <div className="flex items-center gap-2">
          <ToneBadge tone={measurement.state === 'measured' ? 'positive' : 'neutral'}>{measurement.state === 'measured' ? 'Complete' : measurement.state === 'partial' ? 'Partial' : 'Not measured'}</ToneBadge>
          {measurement.completedAt ? <span className="text-sm text-secondary">{formatObservedInstantLabel(observedInstant(measurement.completedAt))}</span> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button ref={filtersButton} type="button" variant="outline" className="min-h-11" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>{VISIBILITY_TOOLBAR_COPY.filters(tokens.length)}</Button>
        {tokens.map(token => <Button key={token.key} type="button" variant="outline" className="visibility-filter-token min-h-11 rounded-md text-sm" aria-label={VISIBILITY_TOOLBAR_COPY.removeFilter(token.label)} onClick={() => { onSelectionChange(token.patch); focusFilters() }}>
          <span className="min-w-0 truncate">{token.label}</span><X size={16} className="shrink-0" aria-hidden="true" />
        </Button>)}
        {propertyLink}
        {onManageQueries ? <Button type="button" variant="outline" className="min-h-11" onClick={onManageQueries}>{VISIBILITY_TOOLBAR_COPY.manageQueries}</Button> : null}
      </div>
    </div>
    <div id={panelId} role="group" aria-label={VISIBILITY_TOOLBAR_COPY.panel} hidden={!open} className="border-b border-default" onKeyDown={event => {
      if (event.key !== 'Escape') return
      // An open help tooltip takes the first Escape; the next one closes the panel.
      if (event.target instanceof HTMLElement && event.target.getAttribute('aria-expanded') === 'true') return
      setOpen(false)
      focusFilters()
    }}>
      <div className="visibility-report-filters">
        {filterSelect('Answer engine', 'measurementProvider', provider, withSelectedChoice([{ value: '', label: 'All engines' }, ...filterOptions.providers.map(value => ({ value, label: value }))], provider, provider))}
        {filterSelect('Search location', 'measurementLocation', location, withSelectedChoice([{ value: '', label: 'All locations' }, ...filterOptions.locations.flatMap(option => option.kind === 'exact' ? [{ value: option.value, label: option.value }] : option.kind === 'none' ? [{ value: 'none', label: VISIBILITY_TOOLBAR_COPY.noLocation }] : [])], location, location === 'none' ? VISIBILITY_TOOLBAR_COPY.noLocation : location))}
        {filterSelect('AI model', 'measurementModel', model, withSelectedChoice([{ value: '', label: 'All models' }, ...Array.from(new Set(filterOptions.models.filter(option => !selection.provider || option.provider === selection.provider).map(option => option.model))).map(value => ({ value, label: value }))], model, model), 'Filter by the AI model recorded with each answer. This does not change the model used by future sweeps.')}
        {dateInput('Start date (UTC)', 'measurementFrom', selection.from, 'T00:00:00.000Z')}
        {dateInput('End date (UTC)', 'measurementTo', selection.to, 'T23:59:59.999Z')}
        {filterSelect('Results from', 'measurementRunId', runId, withSelectedChoice([{ value: '', label: 'Latest saved sweep' }, ...[...population.trend].reverse().map(point => ({ value: point.runId, label: new Date(point.createdAt).toLocaleString() }))], runId, 'Selected sweep'), 'Choose a saved AI sweep to view its results. No new sweep starts.')}
      </div>
      <div className="flex justify-end pb-3">
        <Button type="button" variant="ghost" className="min-h-11" disabled={tokens.length === 0} onClick={() => { onSelectionChange({ ...CLEARED_VISIBILITY_FILTERS }); focusFilters() }}>{VISIBILITY_TOOLBAR_COPY.clearFilters}</Button>
      </div>
    </div>
  </div>
}

/** Presentation only: every displayed count, rate and population comes from the report. */
export function VisibilityReportView({ report, isRefreshing = false, onSelectionChange, onPage, onSearch, search = '', queryKey, answerSelection, evidenceReport, isEvidenceLoading = false, evidenceError, onRetryEvidence, onEvidencePage }: VisibilityReportViewProps) {
  const reportElement = useRef<HTMLElement>(null)
  const focusedQueryKey = useRef<string | undefined>(undefined)
  const answerTrigger = useRef<{ row: VisibilityReportQueryRow; element: HTMLButtonElement } | null>(null)
  const selectedPopulation = selectedReportPopulation(report, queryKey, answerSelection, evidenceReport)
  const answerReport = evidenceReport ?? report
  const matchingPopulations = answerReport.populations.filter(population => [...population.queries.items, ...population.evidence.items].some(row => row.queryKey === queryKey))
  const answerClasses = answerSelection ? [answerSelection.queryClass] : (matchingPopulations.length ? matchingPopulations : isEvidenceLoading ? [] : [selectedPopulation]).map(population => population.queryClass)
  const answerFocusKey = queryKey ? JSON.stringify([answerSelection ?? queryKey, answerClasses]) : undefined
  useEffect(() => {
    if (!answerFocusKey) {
      if (!isRefreshing) focusedQueryKey.current = undefined
      return
    }
    if (focusedQueryKey.current === answerFocusKey) return
    const answers = reportElement.current?.querySelectorAll<HTMLElement>(`[aria-label="${VISIBILITY_ANSWERS_LABEL}"]`)
    if (!answers?.length) return
    for (const answer of answers) {
      const results = answer.closest<HTMLDetailsElement>('details[data-query-results]')
      if (results) results.open = true
    }
    answers[0]!.focus({ preventScroll: true })
    answers[0]!.scrollIntoView?.({ block: 'start' })
    focusedQueryKey.current = answerFocusKey
  }, [answerFocusKey, isRefreshing])
  const { selection } = report
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
  const closeAnswers = () => {
    focusedQueryKey.current = undefined
    const trigger = answerTrigger.current
    const matches = trigger !== null && trigger.row.queryKey === queryKey && (!answerSelection || (
      trigger.row.provider === answerSelection.provider && trigger.row.model === answerSelection.model
      && trigger.row.location === answerSelection.location
    ))
    if (matches && trigger?.element.isConnected) trigger.element.focus()
    else reportElement.current?.querySelector<HTMLElement>(`details[data-query-results="${selectedPopulation.queryClass}"] > summary`)?.focus()
    onSelectionChange({ measurementQueryKey: undefined, measurementAnswer: undefined })
  }
  return <section ref={reportElement} className="visibility-report" aria-label="AI visibility results">
    {selection.provenance.kind === 'legacy-simple' && selection.queryClass !== 'unknown' && selection.queryClass !== 'all' ? <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default py-3 text-sm text-secondary"><p>These saved results aren't separated by query type.</p><Button variant="outline" onClick={() => onSelectionChange({ queryClass: 'all', measurementQueryKey: undefined })}>View all saved results</Button></div> : null}
    {[selectedPopulation].map(population => {
      const queryGroups = groupVisibilityQueryRows(population.queries.items, selection.scope.kind === 'property' && !selection.market && population.queryClass === 'non-brand' ? new Map(report.scopeOptions.filter(option => option.kind === 'market').map(option => [option.id, option.label])) : undefined)
      const answers = answerPage(population)
      const answerQuestion = answers.items[0]?.query ?? population.queries.items.find(row => row.queryKey === queryKey)?.query
      const aggregateScope = selection.mode === 'advanced' && selection.scope.kind !== 'property'
      const classNoun = REPORT_CLASS_NOUN[population.queryClass]
      const comparisonCaption = reportComparisonCaption(population.comparison, displayedSweepAt(selection, population))
      return <section key={population.queryClass} aria-label={REPORT_CLASS_LABEL[population.queryClass]} className="py-4">
      <div className="section-head flex-wrap items-center">
        <div className="flex items-center gap-1"><h2>{REPORT_CLASS_LABEL[population.queryClass]}</h2><InfoTooltip text={population.queryClass === 'non-brand' ? 'Queries that do not name the measured identity. Geography alone is not a brand.' : population.queryClass === 'branded' ? 'Queries that name the measured identity.' : 'These queries were not labeled as branded or non-brand when measured. Their saved results remain available here, separate from branded and non-brand rates.'} /></div>
        <div className="report-headline-caption"><span className="tabular-nums">{reportHeadlineCaption(population.summary, comparisonCaption)}</span><InfoTooltip text={REPORT_CHANGE_COPY.explanation} /></div>
      </div>
      <dl className="report-headline mt-3" data-columns={aggregateScope ? 3 : 2} aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} headline results`}>
        <ReportHeadlineCell label={aggregateScope ? 'Answers mentioning a property' : 'Mentioned answers'} help={selection.mode === 'advanced' ? REPORT_HEADLINE_HELP.advancedMention : REPORT_HEADLINE_HELP.simpleMention} value={population.summary.mentionCoverage} unit="answers" classNoun={classNoun} change={reportChangeLine(population.comparison, 'mentionCoverage')} />
        <ReportHeadlineCell label={aggregateScope ? 'Answers citing a property' : 'Cited answers'} help={selection.mode === 'advanced' ? REPORT_HEADLINE_HELP.advancedCitation : REPORT_HEADLINE_HELP.simpleCitation} value={population.summary.citationCoverage} unit="answers" classNoun={classNoun} change={reportChangeLine(population.comparison, 'citationCoverage')} />
        {aggregateScope ? <ReportHeadlineCell label="Properties mentioned" help={REPORT_HEADLINE_HELP.propertyReach} value={population.summary.propertyReach} unit="properties" classNoun={classNoun} change={reportChangeLine(population.comparison, 'propertyReach')} /> : null}
      </dl>
      <ReportTrend population={population} />
      {aggregateScope && (population.breakdown.groups.length > 0 || population.breakdown.properties.length > 0) ? <ReportScopeBreakdown key={`${selection.scope.kind}:${selection.scope.id}`} population={population} scope={selection.scope} scopeOptions={report.scopeOptions} marketKey={selection.market?.id} onSelectionChange={onSelectionChange} /> : null}
      {selection.mode === 'advanced' ? <details className="border-t border-default text-sm text-secondary" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} property outcomes`}><summary className="min-h-11 cursor-pointer py-3">Property outcomes</summary><div className="flex flex-wrap gap-x-8 gap-y-3 pb-4">
        {([['bothSignals', 'mentioned and cited'], ['mentionedOnly', 'mentioned only'], ['citedOnly', 'cited only'], ['neither', 'neither signal'], ['notMeasured', 'not measured']] as const).map(([key, label]) => <div key={key}><strong className="block tabular-nums text-heading">{population.summary.outcomes[key]}</strong><span className="text-sm text-secondary">{label}</span>{key === 'notMeasured' ? <InfoTooltip text="No eligible completed measurement for this selection. This is not the same as a measured answer with neither signal." /> : null}</div>)}
      </div></details> : null}
      <details className="border-t border-default" data-query-results={population.queryClass} aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} query results`}>
        <summary className="min-h-11 cursor-pointer py-5 text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"><span className="font-semibold">Query results</span><span className="ml-3 text-sm font-normal text-secondary">{population.queries.total} {population.queries.total === 1 ? 'result' : 'results'} · {scopeLabel}</span></summary>
        <div className="pb-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">{onSearch ? <input type="search" aria-label={`Search ${REPORT_CLASS_LABEL[population.queryClass]}`} placeholder="Search queries" className={`${REPORT_CONTROL} max-w-sm`} value={search} onChange={event => onSearch(event.target.value)} /> : null}<InfoTooltip text={selection.mode === 'advanced' ? 'Each tracked query is grouped once on this page. Its engine rows retain the recorded model, location, property scope, and answer counts. Mentioned and Cited count answers matching any assigned property, not the percentage of properties found.' : 'Each tracked query is grouped once on this page. Its engine rows retain the recorded model, location, and answer counts. Mentioned counts answers naming your brand. Cited counts answers linking to your site.'} /></div>
        <div className="overflow-x-auto">
          <table className="evidence-table measurement-responsive-table measurement-results-table" aria-label={`${REPORT_CLASS_LABEL[population.queryClass]} engine results`}>
            <thead><tr><th scope="col">Answer engine</th><th scope="col">Mentioned</th><th scope="col">Cited</th><th scope="col"><span className="sr-only">Evidence</span></th></tr></thead>
            {queryGroups.map((group, index) => <QueryResultGroup key={group.queryKey} group={group} marketHeading={group.marketLabel !== queryGroups[index - 1]?.marketLabel ? group.marketLabel : undefined} advanced={selection.mode === 'advanced'} targetLabels={targetLabels} onViewAnswers={(row, trigger) => { answerTrigger.current = { row, element: trigger }; onSelectionChange({ measurementQueryKey: row.queryKey, measurementAnswer: JSON.stringify({ queryKey: row.queryKey, queryClass: population.queryClass, provider: row.provider, model: row.model, location: row.location, runId: selection.run.id, revision: selection.revision } satisfies VisibilityAnswerSelection) }) }} />)}
          </table>
        </div>
        {population.queries.items.length === 0 ? <p className="py-4 text-sm text-secondary">No measured queries match this selection.</p> : <p className="mt-3 text-sm text-secondary">{queryGroups.length} {queryGroups.length === 1 ? 'query' : 'queries'} · {population.queries.items.length} {population.queries.items.length === 1 ? 'engine result' : 'engine results'} shown of {population.queries.total} results</p>}
        {population.queries.nextCursor && onPage ? <Button variant="outline" onClick={() => onPage(population.queries.nextCursor!)}>Next queries</Button> : null}
      {queryKey && answerClasses.includes(population.queryClass) ? <section tabIndex={-1} className="scroll-mt-6 border-t border-default py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" aria-label={VISIBILITY_ANSWERS_LABEL} aria-busy={isEvidenceLoading}><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="min-w-0 flex-1 text-base font-semibold text-heading [overflow-wrap:anywhere]">{answerQuestion ?? 'Answers'}</h3><Button variant="ghost" className="min-h-11" onClick={closeAnswers}>{VISIBILITY_CLOSE_ANSWERS_LABEL}</Button></div>
        {isEvidenceLoading ? <p role="status" className="py-4 text-sm text-secondary">Loading saved answers…</p> : evidenceError ? <div role="alert" className="py-4 text-sm text-secondary"><p>Saved answers unavailable: {evidenceError}</p>{onRetryEvidence ? <Button variant="outline" onClick={onRetryEvidence}>Retry answers</Button> : null}</div> : <>
        {answers.items.map(answer => <article key={answer.answerId} className="border-b border-default py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <strong className="text-sm text-heading">{answer.provider}</strong>
            {answer.model ? <span className="text-[13px] text-secondary">{answer.model}</span> : null}
            <span className="text-[13px] text-secondary">{answer.location ?? 'No location'}</span>
            <span className="text-[13px] text-secondary">{new Date(answer.createdAt).toLocaleDateString()}</span>
            <ToneBadge tone="neutral">{answer.mentioned === null ? answer.mentionUnavailableReason === 'identity-ambiguous' ? REPORT_VISIBILITY_COPY.ambiguous : 'Mention not checked' : answer.mentioned ? 'Mentioned' : 'Not mentioned'}</ToneBadge>
            <ToneBadge tone="neutral">{answer.cited === null ? 'Citation not checked' : answer.cited ? 'Cited' : 'Not cited'}</ToneBadge>
          </div>
          <div className="mt-4"><AnswerMarkdown headingLevel={4} copyable={Boolean(answer.answerText?.trim())}>{answer.answerText ?? 'Answer text unavailable.'}</AnswerMarkdown></div>
          {answer.sources.length > 0 ? <details className="mt-2" data-answer-sources>
            <summary className="min-h-11 cursor-pointer py-3 text-sm text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">{ANSWER_SOURCES_LABEL} ({answer.sources.length})</summary>
            <ul className="space-y-2 pb-3">{answer.sources.map(source => { const url = safeExternalUrl(source); return <li key={source} className="break-all text-sm">{url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-link underline">{source}</a> : <span className="text-secondary">{source}</span>}</li> })}</ul>
          </details> : null}
        </article>)}
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

function ReportScopeBreakdown({ population, scope, scopeOptions, marketKey, onSelectionChange }: {
  population: VisibilityReportPopulation
  scope: VisibilityReportResponse['selection']['scope']
  scopeOptions: VisibilityReportResponse['scopeOptions']
  marketKey?: string
  onSelectionChange: VisibilityReportViewProps['onSelectionChange']
}) {
  const groupOptions = new Map(scopeOptions.filter(option => option.kind === 'group').map(option => [option.id, option]))
  const hasHierarchy = [...groupOptions.values()].some(option => option.parentGroupIds?.length)
  const groups = population.breakdown.groups.filter(group => {
    const parents = groupOptions.get(group.id)?.parentGroupIds ?? []
    if (scope.kind === 'project') return parents.length === 0
    if (scope.kind === 'group' && hasHierarchy) return parents.includes(scope.id)
    return true
  })
  const [kind, setKind] = useState<'groups' | 'properties'>(() => scope.kind === 'project' && groups.length > 0 ? 'groups' : 'properties')
  const table = useClientTable({ rows: kind === 'groups' ? groups : population.breakdown.properties, getSearchText: row => row.label })
  return <section className="border-t border-default py-5" aria-label="Scope breakdown">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex gap-2">{(['groups', 'properties'] as const).map(value => <Button key={value} variant={kind === value ? 'secondary' : 'ghost'} onClick={() => { setKind(value); table.setPage(1) }}>{value === 'groups' ? 'Groups' : 'Properties'}</Button>)}</div>
      <input type="search" aria-label="Search breakdown" placeholder="Search" value={table.query} onChange={event => table.setQuery(event.target.value)} className={`${REPORT_CONTROL} max-w-sm`} />
    </div>
    <div className="mt-3 overflow-x-auto"><table className="evidence-table"><thead><tr><th>{kind === 'groups' ? 'Group' : 'Property'}</th><th>Queries</th><th>Mentioned</th><th>Cited</th></tr></thead><tbody>{table.rows.map(row => <tr key={row.id}><td><button className="min-h-11 text-left text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" onClick={() => onSelectionChange({ measurementScope: kind === 'groups' ? 'group' : 'property', measurementScopeKey: row.id, measurementMarketKey: marketKey })}>{row.label}</button></td><td>{row.queryCount}</td><td><ReportRate value={row.mentionCoverage} /><ReportRateBar value={row.mentionCoverage} /></td><td><ReportRate value={row.citationCoverage} /><ReportRateBar value={row.citationCoverage} /></td></tr>)}</tbody></table></div>
    {table.rows.length === 0 ? <p className="py-3 text-sm text-secondary">No {kind} match this search.</p> : null}
    <DataTablePagination page={table.page} pageSize={table.pageSize} visibleRows={table.rows.length} totalRows={table.totalRows} itemLabel={kind} onPageChange={table.setPage} />
  </section>
}

/**
 * The report's first page for a URL selection. The project context row and the
 * workspace below it read the same key with the same observer options, so a
 * mounted AI Visibility page makes one first-page request.
 */
export function useVisibilityReportFirstPage(projectName: string, selection: VisibilitySelectionState, { enabled }: { enabled: boolean }) {
  return useQuery({
    ...getApiV1ProjectsByNameVisibilityReportOptions({ client: heyClient, path: { name: projectName }, query: visibilityReportFirstPageQuery(selection) }),
    enabled,
    staleTime: DEFAULT_QUERY_STALE_MS,
    retry: false,
    placeholderData: keepPreviousData,
  })
}

interface VisibilityWorkspaceProps {
  projectName: string
  selection: VisibilitySelectionState
  /** `replace` corrects the URL in place instead of adding a history entry. */
  onSelectionChange: (patch: Record<string, unknown>, options?: { replace?: boolean }) => void
  fallback?: ReactNode
  showUnmeasuredFallback?: boolean
}

/** An unmeasured Simple project shows the page's existing overview when the page asks for it. */
function usesUnmeasuredFallback(report: VisibilityReportResponse, showUnmeasuredFallback: boolean): boolean {
  return showUnmeasuredFallback && report.selection.mode === 'simple' && report.selection.measurement.state === 'not-measured'
}

export function VisibilityWorkspace({ projectName, selection, onSelectionChange, fallback, showUnmeasuredFallback = false }: VisibilityWorkspaceProps) {
  const [cursor, setCursor] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const [answerCursor, setAnswerCursor] = useState<{ selection: string; cursor: string }>()
  const queryClient = useQueryClient()
  const sharedQuery = useMemo(() => ({
    scope: selection.measurementScope, scopeKey: selection.measurementScopeKey, marketKey: selection.marketKey, queryClass: selection.queryClass,
    provider: selection.provider, model: selection.model, location: selection.location,
    from: selection.from, to: selection.to, revision: selection.revision, runId: selection.measurementRunId,
  }), [selection.measurementScope, selection.measurementScopeKey, selection.marketKey, selection.queryClass, selection.provider, selection.model, selection.location, selection.from, selection.to, selection.revision, selection.measurementRunId])
  const reportQuery = useQuery({
    ...getApiV1ProjectsByNameVisibilityReportOptions({ client: heyClient, path: { name: projectName }, query: {
      ...visibilityReportFirstPageQuery(selection), cursor, search: search || undefined,
    } }),
    staleTime: DEFAULT_QUERY_STALE_MS,
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
  useEffect(() => {
    if (selection.queryClass !== 'all' || !reportQuery.data || reportQuery.isPlaceholderData || reportQuery.isFetching || reportQuery.isError
      || reportQuery.data.selection.availability.state === 'unsupported' || reportQuery.data.populations.length === 0) return
    // Older links carry only a query key. Wait for its evidence when it is
    // outside the aggregate page, including across a failed request and retry.
    if (selection.queryKey && !selection.answer && !matchingReportPopulation(reportQuery.data, selection.queryKey) && !evidenceQuery.data) return
    const population = selectedReportPopulation(reportQuery.data, selection.queryKey, selection.answer, evidenceQuery.data)
    if (!cursor && !search) {
      // The server's all-class response contains the exact independently paged
      // population. Keep its timestamp so normalization neither repeats the
      // read nor makes old evidence fresh. A changed scope/search still fetches.
      const { queryKey } = getApiV1ProjectsByNameVisibilityReportOptions({ client: heyClient, path: { name: projectName }, query: visibilityReportFirstPageQuery({ ...selection, queryClass: population.queryClass }) })
      queryClient.setQueryData(queryKey, {
        ...reportQuery.data,
        selection: { ...reportQuery.data.selection, queryClass: population.queryClass },
        populations: [population],
      }, { updatedAt: reportQuery.dataUpdatedAt })
    }
    // Normalization corrects a clean URL in place; there is nothing to go Back to.
    onSelectionChange({
      queryClass: population.queryClass,
      ...(selection.queryKey ? { measurementQueryKey: selection.queryKey, measurementAnswer: selection.answer ? JSON.stringify(selection.answer) : undefined } : {}),
    }, { replace: true })
  }, [selection.queryClass, selection.queryKey, selection.answer, reportQuery.data, reportQuery.dataUpdatedAt, reportQuery.isPlaceholderData, reportQuery.isFetching, reportQuery.isError, evidenceQuery.data, onSelectionChange, queryClient, projectName, sharedQuery, cursor, search])
  if (reportQuery.data?.selection.availability.state === 'unsupported') return <>{fallback}</>
  if (reportQuery.data && usesUnmeasuredFallback(reportQuery.data, showUnmeasuredFallback)) return <>{fallback}</>
  if (reportQuery.error) {
    // Recovery follows the server's typed details, never the message text.
    const retired = parseVisibilityReportScopeErrorDetails(apiErrorDetails(reportQuery.error))
    const retiredMarket = retired?.reason === VisibilityReportScopeErrorReasons['retired-market']
    return <section className="page-section-divider" role="alert"><h2>AI visibility unavailable</h2>
      <p className="my-3 text-sm text-secondary">{retiredMarket ? VISIBILITY_SCOPE_RECOVERY_COPY.retiredMarket : retired ? VISIBILITY_SCOPE_RECOVERY_COPY.retiredScope : describeError(reportQuery.error)}</p>
      {retiredMarket ? <Button variant="outline" onClick={() => { setCursor(undefined); onSelectionChange({ measurementMarketKey: undefined }) }}>{VISIBILITY_SCOPE_RECOVERY_COPY.showAllMarkets}</Button>
        : retired ? <Button variant="outline" onClick={() => { setCursor(undefined); onSelectionChange({ measurementScope: 'project', measurementScopeKey: undefined }) }}>{VISIBILITY_SCOPE_RECOVERY_COPY.showWholeSite}</Button>
          : <Button variant="outline" onClick={() => { setCursor(undefined); void reportQuery.refetch() }}>Retry</Button>}
    </section>
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
  /></div>
}

/**
 * The Advanced overview: the results toolbar above the results workspace. The
 * workspace is keyed by the whole selection except the open answer, so a filter
 * change remounts it onto its skeleton. The toolbar reads the same first page
 * through an unkeyed observer that keeps the previous report while the next one
 * loads, so it stays mounted, with its focus and open panel, across the reload.
 */
export function VisibilityOverview({ projectName, selection, onSelectionChange, onManageQueries, renderPropertyLink, fallback, showUnmeasuredFallback = false }: VisibilityWorkspaceProps & Pick<VisibilityResultsToolbarProps, 'onManageQueries' | 'renderPropertyLink'>) {
  const firstPage = useVisibilityReportFirstPage(projectName, selection, { enabled: true })
  // Absent before the first report, on error (the workspace alert owns
  // recovery), and wherever the page's fallback replaces the report.
  const report = firstPage.error ? undefined : firstPage.data
  return <>
    {report && report.selection.availability.state === 'available' && !usesUnmeasuredFallback(report, showUnmeasuredFallback)
      ? <VisibilityResultsToolbar report={report} selection={selection} onSelectionChange={onSelectionChange} onManageQueries={onManageQueries} renderPropertyLink={renderPropertyLink} />
      : null}
    <VisibilityWorkspace
      key={`${projectName}:${JSON.stringify({ ...selection, queryKey: undefined, answer: undefined })}`}
      projectName={projectName}
      selection={selection}
      onSelectionChange={onSelectionChange}
      fallback={fallback}
      showUnmeasuredFallback={showUnmeasuredFallback}
    />
  </>
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
  // The wrapper hides the table, not `sr-only` on the table: a table box never
  // shrinks below its content, so it would ignore the 1px width and its nowrap
  // rows would push the page sideways on narrow screens.
  return (
    <div className="sr-only">
      <table>
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
    </div>
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
