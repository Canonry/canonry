import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { MeasurementPortfolioSummaryResponse } from '@ainyc/canonry-api-client'
import type { MetricTone } from '../../../view-models.js'

import { InfoTooltip } from '../../shared/InfoTooltip.js'
import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'
import { PortfolioPulse } from './PortfolioPulse.js'

/**
 * `all` is what the API has always accepted and the dashboard never offered, so
 * the only way to see both lanes at once was to read one and add the other.
 */
export type AdvancedMeasurementClass = 'all' | 'non-brand' | 'branded'

/** The six tokens the API accepts. Unmeasured sorts FIRST either way: unknown is not zero. */
export type AdvancedMeasurementSort =
  | 'label-asc' | 'label-desc'
  | 'citationCoverage-asc' | 'citationCoverage-desc'
  | 'mentionCoverage-asc' | 'mentionCoverage-desc'

export type AdvancedMeasurementEvidenceKind =
  | 'this-property'
  | 'another-property'
  | 'owned-unassigned'
  | 'external'
  | 'multiple-properties'
  | 'invalid-url'

export type AdvancedMeasurementMetric =
  | { numerator: number; denominator: number; reason?: never }
  | { numerator: null; denominator: null; reason: string }

export interface AdvancedMeasurementPropertyProvider {
  provider: string
  mentionCoverage: AdvancedMeasurementMetric
  citationCoverage: AdvancedMeasurementMetric
}

export interface AdvancedMeasurementProperty {
  id: string
  name: string
  mentionCoverage: AdvancedMeasurementMetric
  citationCoverage: AdvancedMeasurementMetric
  /**
   * The same population split by answer engine. Rendered as sub-rows under the
   * SAME columns as the parent, so the split is read down a column and visibly
   * adds up to it — the numbers reconcile or the discrepancy is obvious.
   */
  providers?: readonly AdvancedMeasurementPropertyProvider[]
  /** The market this Property sits in. Absent when it belongs to no group. */
  market?: string
  status: { label: string; tone: MetricTone }
  assignedQueries: readonly string[]
  urls: readonly string[]
  evidence: readonly AdvancedMeasurementEvidence[]
  /** The server count can exceed the pages loaded for this expanded Property. */
  evidenceTotal?: number
  hasMoreEvidence?: boolean
  evidenceState?: 'ready' | 'loading' | 'error'
  historical?: boolean
}

export interface AdvancedMeasurementEvidence {
  id: string
  kind: AdvancedMeasurementEvidenceKind
  query: string
  provider?: string
  location?: string | null
  url: string
  tone: MetricTone
  historical?: boolean
}

export interface AdvancedMeasurementAggregate {
  metrics: {
    propertiesMentioned: AdvancedMeasurementMetric
    mentionCoverage: AdvancedMeasurementMetric
    citationCoverage: AdvancedMeasurementMetric
  }
  /** Properties excluded from a complete measurement, shown alongside the property headline. */
  unavailablePropertyCount?: number
  properties: readonly AdvancedMeasurementProperty[]
  shareOfVoice?: readonly AdvancedMeasurementShareOfVoice[]
}

export interface AdvancedMeasurementShareOfVoice {
  name: string
  coverage: AdvancedMeasurementMetric
}

export interface AdvancedMeasurementGroup {
  id: string
  label: string
  confirmedCompetitorCount: number
  aggregate: AdvancedMeasurementAggregate
}

export interface AdvancedMeasurementScope {
  aggregate: AdvancedMeasurementAggregate
  groups: readonly AdvancedMeasurementGroup[]
}

export interface AdvancedMeasurementFlaggedResult {
  id: string
  property: string
  summary: string
  tone: MetricTone
  /** Number of underlying results represented by this Property-level summary. */
  count?: number
}

export interface AdvancedMeasurementOverviewReport {
  /** `plan-v1` has an active plan but cannot split results by query class yet. */
  classReporting: 'available' | 'plan-v1'
  latestMeasurement: {
    status: { label: string; tone: MetricTone }
    completedSlots: number
    totalSlots: number
    includesBridgedHistory?: boolean
    /** Already formatted by the caller for the viewer's locale. */
    date: string
  }
  /** The active plan's aggregate, used for the version-one fallback. */
  overall?: AdvancedMeasurementScope
  /** Each scope is calculated upstream. The component never recomputes an aggregate. */
  classScopes?: {
    nonBrand: AdvancedMeasurementScope
    branded: AdvancedMeasurementScope
  }
  /** One server-computed scope/class view. Other views must be fetched, never reconstructed here. */
  currentView?: {
    scope: { kind: 'all' | 'group'; key?: string }
    queryClass: AdvancedMeasurementClass
    aggregate: AdvancedMeasurementAggregate
    propertyTotal: number
    nextCursor: string | null
    /** The ordering the server applied. Absent means the default, label-asc. */
    sort?: AdvancedMeasurementSort
    /**
     * Scope-wide outcome split, counted by the server over every Property in
     * scope. Absent when the server predates the field — the row then renders
     * nothing rather than a set of zeroes, which would read as a finding.
     */
    outcomes?: {
      bothSignals: number
      mentionedOnly: number
      citedOnly: number
      neither: number
      notMeasured: number
      total: number
    }
  }
  availableGroups?: readonly { id: string; label: string }[]
  nextActionText?: string
  /** Server total, including results on Property pages that are not loaded yet. */
  flaggedResultsTotal?: number
  flaggedResults: readonly AdvancedMeasurementFlaggedResult[]
}

export interface AdvancedMeasurementViewRequest {
  scope: 'all' | 'group'
  groupKey?: string
  queryClass: AdvancedMeasurementClass
  search?: string
  sort?: AdvancedMeasurementSort
}

export interface AdvancedMeasurementOverviewProps {
  report: AdvancedMeasurementOverviewReport
  /** Editors see the one safe action appropriate to the active setup. */
  canEdit: boolean
  onRunMeasurement?: () => void | Promise<void>
  onRepublishSetup?: () => void | Promise<void>
  isRunningMeasurement?: boolean
  isRepublishingSetup?: boolean
  isViewLoading?: boolean
  isLoadingMore?: boolean
  /** A later server-view page failed; retain the loaded page and offer a scoped retry. */
  isLoadMoreError?: boolean
  viewSearch?: string
  onViewChange?: (view: AdvancedMeasurementViewRequest) => void
  onLoadMore?: (cursor: string) => void
  onPropertyExpand?: (propertyId: string) => void
  onRetryEvidence?: () => void
  onLoadMoreEvidence?: () => void
  /** Compact portfolio/group roll-up, pinned to the same displayed run as `report`. */
  portfolioSummary?: MeasurementPortfolioSummaryResponse
  portfolioSummaryState?: 'loading' | 'ready' | 'error'
  onRetryPortfolioSummary?: () => void
  projectTrend?: ReactNode
  /** Group continuity for the exact overview run; hidden while a Property search changes the population. */
  changesRail?: ReactNode
  renderGroupLink?: (group: { id: string; name: string }) => ReactNode
  renderPortfolioLink?: () => ReactNode
  /**
   * Renders the Property name as a link to its own page. The caller owns
   * routing so this component stays presentational; without it the name is
   * plain text and the row still expands in place.
   */
  renderPropertyLink?: (property: { id: string; name: string }) => ReactNode
}

const SORTABLE_COLUMNS: readonly { key: 'label' | 'mentionCoverage' | 'citationCoverage'; label: string; numeric: boolean }[] = [
  { key: 'label', label: 'Property', numeric: false },
  { key: 'mentionCoverage', label: 'Mention', numeric: true },
  { key: 'citationCoverage', label: 'Citation', numeric: true },
]

/**
 * Whether a row's status is worth the reader's attention.
 *
 * "Complete" is the unremarkable case and it is most rows, so badging it fills
 * a column with a constant. Only the exceptions earn a badge.
 */
function isRemarkableStatus(status: AdvancedMeasurementProperty['status']): boolean {
  return status.label !== 'Complete'
}

const ALL_PROPERTIES = '__all_properties__'
const PROPERTY_LIST_LIMIT = 50
const DETAIL_LIST_LIMIT = 50
const FLAGGED_RESULTS_INITIAL_LIMIT = 20
const FLAGGED_RESULTS_INCREMENT = 50
const SEARCH_DEBOUNCE_MS = 250
/** Above this many groups a segmented control gets unwieldy; fall back to a select. */
const GROUP_SEGMENTED_CONTROL_LIMIT = 5

const QUERY_CLASS_OPTIONS: readonly { value: AdvancedMeasurementClass; label: string }[] = [
  { value: 'all', label: 'All queries' },
  { value: 'non-brand', label: 'Non-brand' },
  { value: 'branded', label: 'Branded' },
]

const evidenceLabels: Record<AdvancedMeasurementEvidenceKind, string> = {
  'this-property': 'Matches this Property',
  'another-property': 'Matches another Property',
  'owned-unassigned': 'Site URL not included in a Property',
  external: 'External URL',
  'multiple-properties': 'Matches multiple Properties',
  'invalid-url': 'Invalid URL',
}

const metricReasons: Record<string, string> = {
  plan_v1: 'Setup update required.',
  no_completed_run: 'Not measured yet.',
  no_population: 'No matching queries.',
  evidence_incomplete: 'Evidence incomplete.',
  not_applicable: 'Not applicable.',
  incomplete: 'The latest measurement is incomplete.',
  'evidence-incomplete': 'Some source evidence is incomplete.',
  'no-population': 'No measurements are available for this selection.',
  unavailable: 'This measurement is unavailable.',
}

const planV1Metric: AdvancedMeasurementMetric = {
  numerator: null,
  denominator: null,
  reason: 'plan_v1',
}

function isMeasured(metric: AdvancedMeasurementMetric): metric is Extract<AdvancedMeasurementMetric, { numerator: number }> {
  if (metric.numerator === null) return false
  return Number.isFinite(metric.numerator)
    && Number.isFinite(metric.denominator)
    && metric.numerator >= 0
    && metric.denominator > 0
    && metric.numerator <= metric.denominator
}

function metricLabel(metric: AdvancedMeasurementMetric): string {
  if (!isMeasured(metric)) return 'N/A'
  return `${metric.numerator} of ${metric.denominator} (${Math.round((metric.numerator / metric.denominator) * 100)}%)`
}

function metricReason(metric: AdvancedMeasurementMetric): string {
  if (isMeasured(metric)) return ''
  const reason = (metric as { reason?: string }).reason ?? 'unavailable'
  return metricReasons[reason] ?? reason
}

/**
 * The market and URL count under a Property's name. Both are plan facts, not
 * measurements, so an absent group leaves the market out rather than inventing
 * one — and a Property with no configured URL says nothing at all instead of
 * claiming "0 URLs", which reads as a finding.
 */
function propertySubtitle(property: AdvancedMeasurementProperty): string {
  const parts: string[] = []
  if (property.market) parts.push(property.market)
  if (property.urls.length > 0) parts.push(`${property.urls.length} ${property.urls.length === 1 ? 'URL' : 'URLs'}`)
  return parts.join(' · ')
}

function slotProgressLabel(completed: number, total: number): string | null {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || completed < 0 || total <= 0 || completed > total) {
    return null
  }
  return `${completed} of ${total}`
}

function availableLabel(value: string): string | null {
  const trimmed = value.trim()
  return trimmed && !trimmed.toLocaleLowerCase().includes('unavailable') ? trimmed : null
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => Element | null } | null
  return element?.closest?.('button, a, input, select, textarea, [role="button"]') != null
}

function MetricValue({
  metric,
  compact = false,
}: {
  metric: AdvancedMeasurementMetric
  compact?: boolean
}) {
  const valueClassName = compact
    ? isMeasured(metric) ? 'text-sm font-medium text-primary' : 'text-sm font-medium text-secondary'
    : isMeasured(metric) ? 'text-lg font-semibold text-heading' : 'text-lg font-semibold text-secondary'
  return (
    <span
      className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-1 tabular-nums"
      {...(!isMeasured(metric) ? { title: metricReason(metric) } : {})}
    >
      <span className={valueClassName}>{metricLabel(metric)}</span>
    </span>
  )
}

function Truncation({
  shown,
  total,
  onShowAll,
  itemLabel,
  actionLabel,
}: {
  shown: number
  total: number
  onShowAll: () => void
  itemLabel: string
  actionLabel?: string
}) {
  if (shown >= total) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-secondary">
      <span>Showing {shown} of {total}</span>
      <Button size="sm" variant="outline" onClick={onShowAll}>{actionLabel ?? `Show all ${total} ${itemLabel}`}</Button>
    </div>
  )
}

function CappedStringList({
  title,
  values,
  emptyLabel,
  valueClassName = 'text-secondary',
}: {
  title: string
  values: readonly string[]
  emptyLabel: string
  valueClassName?: string
}) {
  const [limit, setLimit] = useState(DETAIL_LIST_LIMIT)
  const shown = values.slice(0, limit)

  return (
    <section aria-label={title}>
      <h4 className="text-sm font-medium text-heading">{title}</h4>
      {values.length === 0 ? <p className="mt-2 text-sm text-secondary">{emptyLabel}</p> : (
        <>
          <ul className="mt-2 space-y-1.5 text-sm">
            {shown.map((value, index) => <li key={`${value}:${index}`} className={valueClassName}>{value}</li>)}
          </ul>
          <Truncation
            shown={shown.length}
            total={values.length}
            itemLabel={title.toLocaleLowerCase()}
            onShowAll={() => setLimit(Number.MAX_SAFE_INTEGER)}
          />
        </>
      )}
    </section>
  )
}

function CappedEvidenceList({
  evidence,
  evidenceTotal,
  state = 'ready',
  onRetry,
  onLoadMore,
}: {
  evidence: readonly AdvancedMeasurementEvidence[]
  evidenceTotal?: number
  state?: 'ready' | 'loading' | 'error'
  onRetry?: () => void
  onLoadMore?: () => void
}) {
  const [limit, setLimit] = useState(DETAIL_LIST_LIMIT)
  const shown = evidence.slice(0, limit)
  const total = evidenceTotal ?? evidence.length

  return (
    <section aria-label="Evidence">
      <h4 className="text-sm font-medium text-heading">Evidence</h4>
      {state === 'loading' ? <p className="mt-2 text-sm text-secondary">Loading evidence…</p>
        : state === 'error' ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-secondary">
              <span>Evidence could not be loaded.</span>
              {onRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry evidence</Button> : null}
            </div>
          )
          : evidence.length === 0 ? <p className="mt-2 text-sm text-secondary">No source evidence is available.</p> : (
        <>
          <div className="mt-2 overflow-x-auto rounded-md border border-default">
            <table className="evidence-table min-w-[640px]">
              <thead><tr><th>Status</th><th>Query</th><th>URL</th></tr></thead>
              <tbody>{shown.map(item => (
                <tr key={item.id}>
                  <td>
                    <span className="flex flex-wrap items-center gap-1">
                      <ToneBadge tone={item.tone}>{evidenceLabels[item.kind]}</ToneBadge>
                      {item.historical ? <ToneBadge tone="caution">Historical</ToneBadge> : null}
                    </span>
                  </td>
                  <td className="text-secondary">
                    <span className="block">{item.query}</span>
                    {item.provider || item.location ? (
                      <span className="mt-1 block text-xs text-muted">
                        {[item.provider, item.location].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                  </td>
                  <td className="break-all text-secondary">{item.url}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Truncation
            shown={shown.length}
            total={total}
            itemLabel="evidence items"
            actionLabel={onLoadMore && evidence.length < total ? 'Show more evidence items' : undefined}
            onShowAll={() => {
              setLimit(Number.MAX_SAFE_INTEGER)
              if (evidence.length < total) onLoadMore?.()
            }}
          />
        </>
      )}
    </section>
  )
}

function PropertyDetails({
  property,
  onRetryEvidence,
  onLoadMoreEvidence,
}: {
  property: AdvancedMeasurementProperty
  onRetryEvidence?: () => void
  onLoadMoreEvidence?: () => void
}) {
  return (
    <div className="space-y-5 py-2">
      <CappedStringList title="Assigned queries" values={property.assignedQueries} emptyLabel="No queries are assigned." />
      <CappedStringList title="URLs" values={property.urls} emptyLabel="No URLs are assigned." valueClassName="break-all text-secondary" />
      <CappedEvidenceList
        evidence={property.evidence}
        evidenceTotal={property.evidenceTotal}
        state={property.evidenceState}
        onRetry={onRetryEvidence}
        onLoadMore={property.hasMoreEvidence ? onLoadMoreEvidence : undefined}
      />
    </div>
  )
}

function CompetitorShareOfVoice({ values }: { values: readonly AdvancedMeasurementShareOfVoice[] }) {
  return (
    <section aria-labelledby="advanced-measurement-share-of-voice" className="border-y border-default py-4">
      <h2 id="advanced-measurement-share-of-voice" className="text-sm font-medium text-heading">Brand share of voice</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="evidence-table min-w-[420px]">
          <thead><tr><th>Name</th><th>Share of voice</th></tr></thead>
          <tbody>{values.map(value => (
            <tr key={value.name}>
              <td className="font-medium text-heading">{value.name}</td>
              <td className="text-secondary"><MetricValue metric={value.coverage} compact /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  )
}

interface SegmentedControlOption<T extends string> {
  value: T
  label: string
}

/**
 * A real ARIA radiogroup, not a select: every option is visible at once so the
 * current state reads without a click, and arrow keys move both focus and
 * selection like a native radio group (roving tabindex on the checked option).
 *
 * Wears the house `.segmented` skin so it is visually identical to the five
 * segmented controls already in the dashboard (GSC, Activity, Visibility trend,
 * Technical AEO). The SEMANTICS deliberately differ from `VisibilityTrendSection`'s
 * `Segmented`, which is a `role="group"` of `aria-pressed` toggles: these options
 * are mutually exclusive filters, and radiogroup is the WAI-ARIA pattern for
 * "choose exactly one", giving arrow-key navigation a toggle group does not.
 * Same paint, stricter semantics — not a second visual language.
 */
function SegmentedControl<T extends string>({
  ariaLabelledBy,
  value,
  options,
  onChange,
  disabled = false,
}: {
  ariaLabelledBy: string
  value: T
  options: readonly SegmentedControlOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    const currentIndex = options.findIndex(option => option.value === value)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = options.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextOption = options[nextIndex]
    onChange(nextOption.value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex].focus()
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={ariaLabelledBy}
      aria-disabled={disabled}
      className="segmented flex-wrap"
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`segmented-option disabled:cursor-not-allowed disabled:opacity-50 ${
              checked ? 'segmented-option-active' : ''
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * How many Properties got which signal.
 *
 * FIVE named states, not four. "one signal" pooled `mentionedOnly` with
 * `citedOnly` and hid the split on a tooltip — but those two have OPPOSITE
 * fixes. Cited-but-not-mentioned means the engine read the page and then
 * recommended somebody else; mentioned-but-not-cited means the opposite. A
 * label that averages them tells the reader nothing they can act on.
 *
 * The unit is stated ONCE, as "N properties" on the heading line this row sits
 * under, and every number here counts the same thing — so there is nothing to
 * reconcile. That is why the assignment-denominated rates were removed: two
 * populations side by side, with the unit printed on neither, is what made the
 * section unreadable.
 *
 * `notMeasured` renders only when it is non-zero: it is the exception bucket,
 * and a rendered 0 reads as a measured finding rather than an absence.
 */
function OutcomeCounts({ outcomes }: {
  outcomes: NonNullable<NonNullable<AdvancedMeasurementOverviewReport['currentView']>['outcomes']>
}) {
  const entries: readonly { key: string; count: number; label: string; tone: string }[] = [
    { key: 'both', count: outcomes.bothSignals, label: 'mentioned and cited', tone: 'text-primary' },
    { key: 'mentioned-only', count: outcomes.mentionedOnly, label: 'mentioned only', tone: 'text-primary' },
    { key: 'cited-only', count: outcomes.citedOnly, label: 'cited only', tone: 'text-primary' },
    // Colour carries exactly one meaning here. Ranking mentioned-only against
    // cited-only with a tone ramp would assert an ordering the copy refuses.
    { key: 'neither', count: outcomes.neither, label: 'neither signal', tone: 'text-negative' },
    ...(outcomes.notMeasured > 0
      ? [{ key: 'not-measured', count: outcomes.notMeasured, label: 'not measured', tone: 'text-faint' }]
      : []),
  ]
  return (
    <div aria-label="Property outcomes" className="flex flex-wrap gap-x-8 gap-y-3 py-3">
      {entries.map(entry => (
        <div key={entry.key} className="whitespace-nowrap">
          <p className={`font-mono text-xl font-semibold leading-none tabular-nums ${entry.tone}`}>{entry.count}</p>
          <p className="mt-1 text-[13px] text-secondary">
            {entry.label}
            {entry.key === 'not-measured' ? (
              <InfoTooltip text="One or both signals missing. Not the same as neither." />
            ) : null}
          </p>
        </div>
      ))}
    </div>
  )
}

export function AdvancedMeasurementOverview({
  report,
  canEdit,
  onRunMeasurement,
  onRepublishSetup,
  isRunningMeasurement = false,
  isRepublishingSetup = false,
  isViewLoading = false,
  isLoadingMore = false,
  isLoadMoreError = false,
  viewSearch,
  onViewChange,
  onLoadMore,
  onPropertyExpand,
  onRetryEvidence,
  onLoadMoreEvidence,
  portfolioSummary,
  portfolioSummaryState,
  onRetryPortfolioSummary,
  projectTrend,
  changesRail,
  renderGroupLink,
  renderPortfolioLink,
  renderPropertyLink,
}: AdvancedMeasurementOverviewProps) {
  const usesServerView = report.currentView != null
  const classReportingAvailable = report.classReporting === 'available' && (usesServerView || report.classScopes != null)
  const [selectedClass, setSelectedClass] = useState<AdvancedMeasurementClass>(report.currentView?.queryClass ?? 'all')
  const [selectedView, setSelectedView] = useState(report.currentView?.scope.key ?? ALL_PROPERTIES)
  const [search, setSearch] = useState(viewSearch ?? '')
  const [propertyLimit, setPropertyLimit] = useState(PROPERTY_LIST_LIMIT)
  const [flaggedLimit, setFlaggedLimit] = useState(FLAGGED_RESULTS_INITIAL_LIMIT)
  // One id, not a set: each expansion adds an engine sub-row per provider plus a
  // details panel, so two open at once push the rest of a several-hundred-row
  // table off screen. Opening a Property closes whichever one was open.
  const [selectedSort, setSelectedSort] = useState<AdvancedMeasurementSort>(report.currentView?.sort ?? 'label-asc')
  const [expandedPropertyId, setExpandedPropertyId] = useState<string | null>(null)
  const lastRequestedSearch = useRef(viewSearch ?? '')

  const legacyScope = classReportingAvailable && !usesServerView && selectedClass !== 'all'
    ? selectedClass === 'non-brand' ? report.classScopes!.nonBrand : report.classScopes!.branded
    : report.overall
  const scope: AdvancedMeasurementScope = usesServerView
    ? { aggregate: report.currentView!.aggregate, groups: [] }
    : legacyScope!

  const requestView = useCallback((next: Partial<AdvancedMeasurementViewRequest>) => {
    if (!usesServerView || !onViewChange) return
    const nextScope = next.scope ?? (selectedView === ALL_PROPERTIES ? 'all' : 'group')
    const nextSearch = next.search ?? search
    lastRequestedSearch.current = nextSearch
    onViewChange({
      scope: nextScope,
      ...(nextScope === 'group' ? { groupKey: next.groupKey ?? selectedView } : {}),
      queryClass: next.queryClass ?? selectedClass,
      ...(nextSearch ? { search: nextSearch } : {}),
      ...(next.sort ? { sort: next.sort } : {}),
    })
  }, [onViewChange, search, selectedClass, selectedView, usesServerView])

  useEffect(() => {
    if (!report.currentView || isViewLoading) return
    setSelectedClass(report.currentView.queryClass)
    setSelectedView(report.currentView.scope.key ?? ALL_PROPERTIES)
    if (report.currentView.sort) setSelectedSort(report.currentView.sort)
  }, [isViewLoading, report.currentView])

  useEffect(() => {
    if (viewSearch === undefined) return
    lastRequestedSearch.current = viewSearch
    // The parent trims before storing, so what echoes back after a pause can
    // be the same term minus the space just typed. Writing that into the
    // controlled input deletes the space and merges the next word onto the
    // last one. An echo that differs only by surrounding whitespace is this
    // round trip, not a new term from elsewhere, so the box is left alone.
    setSearch(current => (current.trim() === viewSearch.trim() ? current : viewSearch))
  }, [viewSearch])

  useEffect(() => {
    if (!usesServerView || !onViewChange || search === lastRequestedSearch.current) return
    const timer = window.setTimeout(() => requestView({ search }), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [onViewChange, requestView, search, usesServerView])

  const groupOptions = report.availableGroups ?? scope.groups

  useEffect(() => {
    if (selectedView === ALL_PROPERTIES || groupOptions.some(group => group.id === selectedView)) return
    setSelectedView(ALL_PROPERTIES)
  }, [groupOptions, selectedView])

  const selectedGroup = usesServerView ? undefined : scope.groups.find(group => group.id === selectedView)
  const aggregate = selectedGroup?.aggregate ?? scope.aggregate
  const classMetric = (metric: AdvancedMeasurementMetric): AdvancedMeasurementMetric => (
    classReportingAvailable ? metric : planV1Metric
  )
  const activeSort: AdvancedMeasurementSort = selectedSort
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const hasPendingOrAppliedSearch = normalizedSearch.length > 0 || Boolean(viewSearch?.trim())
  // Search narrows the server overview's outcomes but not the portfolio
  // summary endpoint. Hide the rollup while searching so one filtered
  // Property is never presented beside a full-portfolio denominator. Both the
  // local draft and the last parent-applied term matter: when a term is cleared,
  // the parent remains filtered until the debounce completes.
  const usesPortfolioPulse = usesServerView && portfolioSummaryState !== undefined && !hasPendingOrAppliedSearch
  const portfolioPulseShowsOutcomes = usesPortfolioPulse
    && portfolioSummaryState === 'ready'
    && portfolioSummary !== undefined
  const filteredProperties = useMemo(() => (
    !usesServerView && normalizedSearch
      ? aggregate.properties.filter(property => property.name.toLocaleLowerCase().includes(normalizedSearch))
      : aggregate.properties
  ), [aggregate.properties, normalizedSearch, usesServerView])
  const shownProperties = usesServerView ? filteredProperties : filteredProperties.slice(0, propertyLimit)
  const showShareOfVoice = (usesServerView ? report.currentView?.scope.kind === 'group' : selectedGroup != null)
    && selectedClass === 'non-brand'
    && classReportingAvailable
    && (usesServerView || selectedGroup!.confirmedCompetitorCount > 0)
    && (aggregate.shareOfVoice?.length ?? 0) > 0
  const unavailableProperties = classReportingAvailable ? aggregate.unavailablePropertyCount ?? 0 : 0
  const loadedFlaggedCount = report.flaggedResults.reduce((total, result) => total + (result.count ?? 1), 0)
  const flaggedResultsTotal = report.flaggedResultsTotal ?? loadedFlaggedCount
  const headlineUnavailableReason = [
    classMetric(aggregate.metrics.propertiesMentioned),
    classMetric(aggregate.metrics.mentionCoverage),
    classMetric(aggregate.metrics.citationCoverage),
  ].map(metricReason).find(Boolean)
  const statusMessage = !classReportingAvailable
    ? metricReasons.plan_v1
    : report.nextActionText ?? headlineUnavailableReason
      ?? (unavailableProperties > 0
        ? `${unavailableProperties} ${unavailableProperties === 1 ? 'property is' : 'properties are'} unavailable.`
        : flaggedResultsTotal > 0
          ? `${flaggedResultsTotal} ambiguous source-to-Property ${flaggedResultsTotal === 1 ? 'match' : 'matches'}.`
          : null)
  // Slot progress is only informative while the measurement hasn't reached a
  // terminal state — a completed run always has completedSlots === totalSlots,
  // so "32 of 32" would be true (and useless) on every finished measurement.
  // Two independent guards, because neither alone is right.
  //
  // The slot comparison is what keeps the label from ever being a constant: a
  // finished run has completedSlots === totalSlots, so "32 of 32" cannot render.
  // Tone alone would miss this — a run that finished but carries a warning is
  // toned `caution`, which is neither positive nor negative, and would print the
  // very constant this removes.
  //
  // Failure is a separate question from progress, and tone is the only signal
  // for it the report carries (`status` is just a label and a tone). A failed
  // run's partial count is not progress toward anything, so it stays hidden.
  const measurementFailed = report.latestMeasurement.status.tone === 'negative'
  const measurementInProgress = !measurementFailed
    && report.latestMeasurement.completedSlots < report.latestMeasurement.totalSlots
  const progressLabel = measurementInProgress
    ? slotProgressLabel(report.latestMeasurement.completedSlots, report.latestMeasurement.totalSlots)
    : null
  const measurementDate = availableLabel(report.latestMeasurement.date)
  const groupSegmentOptions = [
    { value: ALL_PROPERTIES, label: 'All properties' },
    ...groupOptions.map(group => ({ value: group.id, label: group.label })),
  ]
  const useGroupSelect = groupOptions.length > GROUP_SEGMENTED_CONTROL_LIMIT

  function handleGroupChange(value: string) {
    setSelectedView(value)
    requestView(value === ALL_PROPERTIES ? { scope: 'all' } : { scope: 'group', groupKey: value })
  }

  function handleClassChange(value: AdvancedMeasurementClass) {
    setSelectedClass(value)
    requestView({ queryClass: value })
  }

  function toggleProperty(propertyId: string) {
    const willExpand = expandedPropertyId !== propertyId
    setExpandedPropertyId(willExpand ? propertyId : null)
    if (willExpand) onPropertyExpand?.(propertyId)
  }

  return (
    <section aria-label="Advanced measurement overview" aria-busy={isViewLoading} className="space-y-5">
      <header className="border-b border-default pb-4">
        <div role="status" aria-label="Measurement status and next action" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {isViewLoading ? <span className="text-sm text-secondary">Updating results…</span> : (
            <>
              <ToneBadge tone={report.latestMeasurement.status.tone}>{report.latestMeasurement.status.label}</ToneBadge>
              {report.latestMeasurement.includesBridgedHistory ? <ToneBadge tone="caution">Includes historical data</ToneBadge> : null}
              {progressLabel ? <span className="text-sm text-secondary tabular-nums">{progressLabel}</span> : null}
              {measurementDate ? <span className="text-sm text-secondary">{measurementDate}</span> : null}
              {statusMessage ? <span className="text-sm text-secondary">{statusMessage}</span> : null}
              {canEdit && classReportingAvailable && onRunMeasurement ? (
                <Button className="ml-auto" size="sm" onClick={() => { void onRunMeasurement() }} disabled={isRunningMeasurement}>
                  {isRunningMeasurement ? 'Starting measurement…' : 'Run measurement'}
                </Button>
              ) : canEdit && !classReportingAvailable ? (
                <Button className="ml-auto" size="sm" onClick={() => { void onRepublishSetup?.() }} disabled={!onRepublishSetup || isRepublishingSetup}>
                  {isRepublishingSetup ? 'Opening setup…' : 'Republish setup'}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-4 border-b border-default pb-4">
        <div className="space-y-1">
          <label
            id="advanced-measurement-group-label"
            htmlFor={useGroupSelect ? 'advanced-measurement-group' : undefined}
            className="block text-sm font-medium text-heading"
          >
            Group
          </label>
          {useGroupSelect ? (
            <select
              id="advanced-measurement-group"
              value={selectedView}
              onChange={event => handleGroupChange(event.target.value)}
              className="h-9 rounded-md border border-default bg-surface px-3 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-mono-400"
            >
              {groupSegmentOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : (
            <SegmentedControl
              ariaLabelledBy="advanced-measurement-group-label"
              value={selectedView}
              options={groupSegmentOptions}
              onChange={handleGroupChange}
            />
          )}
        </div>
        <div className="space-y-1">
          <label id="advanced-measurement-class-label" className="block text-sm font-medium text-heading">Query type</label>
          <SegmentedControl
            ariaLabelledBy="advanced-measurement-class-label"
            value={selectedClass}
            options={QUERY_CLASS_OPTIONS}
            onChange={handleClassChange}
            disabled={!classReportingAvailable}
          />
        </div>
        <div className="ml-auto min-w-52 max-w-xs flex-1 space-y-1">
          <label htmlFor="advanced-measurement-search" className="block text-sm font-medium text-heading">Search properties</label>
          <input
            id="advanced-measurement-search"
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search properties"
            className="h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-primary placeholder-mono-600 focus:outline-none focus:ring-2 focus:ring-mono-400"
          />
        </div>
      </div>

      {usesPortfolioPulse ? (
        <PortfolioPulse
          summary={isViewLoading ? undefined : portfolioSummary}
          state={isViewLoading ? 'loading' : portfolioSummaryState}
          outcomes={isViewLoading ? undefined : report.currentView?.outcomes}
          projectTrend={report.currentView?.scope.kind === 'all' ? projectTrend : undefined}
          onRetry={onRetryPortfolioSummary}
          onSelectGroup={groupKey => handleGroupChange(groupKey)}
          onOpenPortfolio={() => handleGroupChange(ALL_PROPERTIES)}
          renderGroupLink={renderGroupLink}
          renderPortfolioLink={renderPortfolioLink}
        />
      ) : null}

      {!hasPendingOrAppliedSearch ? changesRail : null}

      {!isViewLoading && showShareOfVoice ? <CompetitorShareOfVoice values={aggregate.shareOfVoice ?? []} /> : null}

      {!isViewLoading ? <section aria-labelledby="advanced-measurement-properties-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="advanced-measurement-properties-title" className="text-base font-semibold text-heading">
            Properties
            <InfoTooltip text="Mentioned = brand in the answer. Cited = domain in the sources. Neither implies the other." />
          </h2>
          <span className="text-sm text-secondary">{report.currentView?.propertyTotal ?? filteredProperties.length} {(report.currentView?.propertyTotal ?? filteredProperties.length) === 1 ? 'property' : 'properties'}</span>
        </div>
        {/* Directly under the count it partitions, so the unit is stated once
            and the row visibly sums to it. */}
        {!portfolioPulseShowsOutcomes && report.currentView?.outcomes ? <OutcomeCounts outcomes={report.currentView.outcomes} /> : null}
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table min-w-[720px]">
            <caption className="sr-only">Property measurement results</caption>
            <thead>
              <tr>
                {SORTABLE_COLUMNS.map(column => {
                  const active = activeSort.startsWith(`${column.key}-`)
                  const direction = active && activeSort.endsWith('-desc') ? 'descending' : active ? 'ascending' : 'none'
                  return (
                    <th key={column.key} aria-sort={direction} className={column.numeric ? undefined : undefined}>
                      {onViewChange ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-inherit hover:text-heading"
                          // Second click on the same column flips direction; a new
                          // column starts ascending, which for a coverage metric
                          // puts the worst Properties first — the reason to sort.
                          onClick={() => {
                            const next = `${column.key}-${active && activeSort.endsWith('-asc') ? 'desc' : 'asc'}` as AdvancedMeasurementSort
                            setSelectedSort(next)
                            requestView({ sort: next })
                          }}
                          aria-label={`Sort by ${column.label.toLowerCase()}`}
                        >
                          {column.label}
                          <ChevronDown
                            className={`h-3 w-3 transition-transform ${active ? 'opacity-100' : 'opacity-0'} ${direction === 'ascending' ? 'rotate-180' : ''}`}
                            aria-hidden="true"
                          />
                        </button>
                      ) : column.label}
                    </th>
                  )
                })}
                <th><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {shownProperties.map(property => {
                const expanded = expandedPropertyId === property.id
                return (
                  <Fragment key={property.id}>
                    <tr
                      key={property.id}
                      className="cursor-pointer transition-colors hover:bg-surface-subtle"
                      onClick={event => {
                        if (!isInteractiveTarget(event.target)) toggleProperty(property.id)
                      }}
                    >
                      <td className="font-medium text-heading">
                        {renderPropertyLink
                          ? renderPropertyLink({ id: property.id, name: property.name })
                          : property.name}
                        {/* A name alone does not identify a row in a portfolio of
                            hundreds. Market and URL count are what let a reader
                            tell two similarly-named Properties apart. */}
                        {/* Exceptions only. A column of identical "Complete"
                            badges spends portfolio width saying nothing; what a
                            reader needs is the row that is NOT fine. */}
                        {isRemarkableStatus(property.status) || property.historical ? (
                          <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
                            {isRemarkableStatus(property.status)
                              ? <ToneBadge tone={property.status.tone}>{property.status.label}</ToneBadge>
                              : null}
                            {property.historical ? <ToneBadge tone="caution">Historical</ToneBadge> : null}
                          </span>
                        ) : null}
                        {propertySubtitle(property) ? (
                          <div className="mt-0.5 text-xs font-normal text-faint">{propertySubtitle(property)}</div>
                        ) : null}
                      </td>
                      <td className="text-secondary"><MetricValue metric={property.mentionCoverage} compact /></td>
                      <td className="text-secondary"><MetricValue metric={property.citationCoverage} compact /></td>
                      <td className="text-right"><Button size="icon" variant="ghost" aria-expanded={expanded} aria-label={expanded ? `Hide details for ${property.name}` : `Show details for ${property.name}`} onClick={() => toggleProperty(property.id)}><ChevronDown className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" /></Button></td>
                    </tr>
                    {expanded ? (property.providers ?? []).map(engine => (
                      <tr key={`${property.id}:${engine.provider}`} className="measurement-subrow">
                        <td className="measurement-subrow-name">{engine.provider}</td>
                        <td className="text-secondary"><MetricValue metric={engine.mentionCoverage} compact /></td>
                        <td className="text-secondary"><MetricValue metric={engine.citationCoverage} compact /></td>
                        <td />
                      </tr>
                    )) : null}
                    {expanded ? <tr key={`${property.id}:details`}><td colSpan={4} className="bg-surface-subtle px-4"><PropertyDetails property={property} onRetryEvidence={onRetryEvidence} onLoadMoreEvidence={onLoadMoreEvidence} /></td></tr> : null}
                  </Fragment>
                )
              })}
              {shownProperties.length === 0 ? <tr><td colSpan={4} className="py-8 text-center text-sm text-secondary">No properties match this search.</td></tr> : null}
            </tbody>
          </table>
        </div>
        {usesServerView && report.currentView!.nextCursor && onLoadMore ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-secondary">
            <span>Showing {shownProperties.length} of {report.currentView!.propertyTotal}</span>
            {isLoadMoreError ? <span role="alert">Could not load more properties.</span> : null}
            <Button size="sm" variant="outline" disabled={isLoadingMore} onClick={() => onLoadMore(report.currentView!.nextCursor!)}>
              {isLoadingMore ? 'Loading…' : isLoadMoreError ? 'Retry loading more properties' : 'Show 50 more'}
            </Button>
          </div>
        ) : usesServerView ? (
          shownProperties.length < report.currentView!.propertyTotal
            ? <p className="mt-2 text-sm text-secondary">Showing {shownProperties.length} of {report.currentView!.propertyTotal}</p>
            : null
        ) : (
          <Truncation
            shown={shownProperties.length}
            total={filteredProperties.length}
            itemLabel="properties"
            onShowAll={() => setPropertyLimit(Number.MAX_SAFE_INTEGER)}
          />
        )}
      </section> : <div className="h-44 animate-pulse rounded-md bg-surface-subtle" aria-label="Updating Property results" />}

      {!isViewLoading && !normalizedSearch && flaggedResultsTotal > 0 ? (
        <section aria-label="Ambiguous source-to-Property matches" className="border-t border-default pt-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium text-heading">Ambiguous matches ({flaggedResultsTotal})</summary>
            <ul className="mt-3 space-y-3">
              {report.flaggedResults.slice(0, flaggedLimit).map(result => (
                <li key={result.id} className="flex flex-wrap items-start gap-2 text-sm">
                  <ToneBadge tone={result.tone}>Ambiguous</ToneBadge>
                  <span className="font-medium text-heading">{result.property}</span>
                  <span className="text-secondary">{result.summary}</span>
                </li>
              ))}
            </ul>
            {flaggedLimit < report.flaggedResults.length ? (
              <div className="mt-3 flex items-center gap-3 text-sm text-secondary">
                <span>Showing details for {report.flaggedResults.slice(0, flaggedLimit).reduce((total, result) => total + (result.count ?? 1), 0)} of {flaggedResultsTotal} ambiguous matches</span>
                <Button size="sm" variant="outline" onClick={() => setFlaggedLimit(limit => Math.min(report.flaggedResults.length, limit + FLAGGED_RESULTS_INCREMENT))}>Show 50 more</Button>
              </div>
            ) : loadedFlaggedCount < flaggedResultsTotal ? (
              <div className="mt-3 flex items-center gap-3 text-sm text-secondary">
                <span>Showing details for {loadedFlaggedCount} of {flaggedResultsTotal} ambiguous matches</span>
                {usesServerView && report.currentView!.nextCursor && onLoadMore ? (
                  <Button size="sm" variant="outline" disabled={isLoadingMore} onClick={() => onLoadMore(report.currentView!.nextCursor!)}>
                    {isLoadingMore ? 'Loading…' : isLoadMoreError ? 'Retry loading more Properties' : 'Load more Properties'}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </details>
        </section>
      ) : null}
    </section>
  )
}
