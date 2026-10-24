import { Fragment, useId, useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react'
import {
  formatGaOverviewValue,
  formatPercent,
  gaOverviewChangeTone,
  isGaOverviewWindow,
  GA_OVERVIEW_METRICS,
  GA_OVERVIEW_METRIC_ORDER,
  GA_OVERVIEW_WINDOW_DAYS,
  GaOverviewChangeTones,
  GaOverviewUnits,
  RatioUnits,
  type GaOverviewMetricKey,
  type GaOverviewResponse,
} from '@canonry/canonry-contracts'
import {
  Area,
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
  CHART_NEUTRAL,
  CHART_SERIES_COLORS,
  CHART_TOOLTIP_STYLE,
  formatChartDateLabel,
  formatChartDateTick,
} from '../shared/ChartPrimitives.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import {
  BASELINE_DATA_KEY,
  buildStackedChartRows,
  type StackedSeriesInput,
} from '../../lib/stacked-chart-rows.js'

/**
 * Shared pieces of the Activity tab: one heading per section, flat rows of
 * figures instead of card grids, one table-header style, grouped tables whose
 * raw rows open in place, and stacked charts with a checkbox legend.
 */

export type SortDir = 'asc' | 'desc'

/** Every Activity table header, sortable or not, renders in this one style. */
export const TABLE_HEAD_TEXT = 'text-[11px] font-medium uppercase tracking-wider text-muted'

export function SectionHeading({ id, title, tooltip, meta, actions }: {
  id?: string
  title: string
  tooltip?: string
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        {/* The tooltip is the heading's sibling: a button inside the heading
            would become part of its accessible name. */}
        <div className="flex items-center gap-1.5">
          <h2 id={id} className="text-base font-semibold text-primary">{title}</h2>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        {meta && <p className="mt-1 text-xs text-secondary">{meta}</p>}
      </div>
      {actions}
    </div>
  )
}

/**
 * Rows of collapsed detail under a row of figures. The figures' bottom rule
 * already divides them from the first row, so that row draws no rule of its own.
 */
export function DisclosureRows({ children }: { children: ReactNode }) {
  return <div className="[&>details:first-child]:border-t-0">{children}</div>
}

/**
 * One collapsed row of detail, closed by default: its label and one summary
 * figure in the row, the chart or table in place once opened. These are the
 * shared `.visibility-disclosure` rows, so Activity reads like AI Visibility.
 * The detail mounts only while open: a chart drawn into a closed row has no size.
 * Help never goes in the row: a button inside a summary toggles the disclosure
 * and joins its accessible name.
 */
export function DisclosureRow({ label, meta, children }: { label: string; meta: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="visibility-disclosure" aria-label={label} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="visibility-disclosure-summary">
        <span className="visibility-disclosure-label">{label}</span>
        <span className="visibility-disclosure-meta">{meta}</span>
      </summary>
      {open && <div className="visibility-disclosure-panel">{children}</div>}
    </details>
  )
}

export interface KpiItem {
  label: string
  value: string
  detail?: string
  tooltip?: string
}

const KPI_COLUMNS: Record<number, string> = {
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
}

/** A flat row of figures. Totals and shares have no bounded scale, so no gauges or cards. */
export function KpiRow({ items, label }: { items: readonly KpiItem[]; label: string }) {
  // A bare <dl> takes no accessible name, so the named group carries it.
  return (
    <div role="group" aria-label={label}>
      <dl className={`grid grid-cols-2 gap-x-6 gap-y-4 border-y border-default py-4 sm:grid-cols-3 ${KPI_COLUMNS[items.length] ?? 'lg:grid-cols-4'}`}>
        {items.map(item => (
          <div key={item.label} className="min-w-0">
            <dt className="flex items-center gap-1 text-[13px] text-secondary">
              {item.label}
              {item.tooltip && <InfoTooltip text={item.tooltip} />}
            </dt>
            <dd className="mt-1 truncate text-xl font-semibold text-primary tabular-nums" title={item.value}>{item.value}</dd>
            {item.detail && <dd className="mt-0.5 text-[13px] text-secondary tabular-nums">{item.detail}</dd>}
          </div>
        ))}
      </dl>
    </div>
  )
}

export function SortHeader<K extends string>({ label, sortKey, current, dir, onSort, align }: {
  label: string
  sortKey: K
  current: K
  dir: SortDir
  onSort: (key: K) => void
  align: 'left' | 'right'
}) {
  const active = current === sortKey
  return (
    <th
      className={`py-2 ${align === 'right' ? 'pl-4 text-right' : 'text-left'}`}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      {/* A button does not inherit text-transform, so it repeats the header
          style; otherwise sortable headers render in mixed case. */}
      <button
        type="button"
        className={`${TABLE_HEAD_TEXT} cursor-pointer select-none rounded transition-colors hover:text-neutral focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mono-400`}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {active && <span aria-hidden="true" className="ml-0.5">{dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  )
}

export function PlainHeader({ label, align }: { label: string; align: 'left' | 'right' }) {
  // Same structure as SortHeader (sized text inside an unsized cell), so plain
  // and sortable headers share one baseline.
  return (
    <th className={`py-2 ${align === 'right' ? 'pl-4 text-right' : 'text-left'}`}>
      <span className={TABLE_HEAD_TEXT}>{label}</span>
    </th>
  )
}

export function nextSort<K extends string>(current: { key: K; dir: SortDir }, key: K, firstDir: SortDir = 'desc'): { key: K; dir: SortDir } {
  if (current.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
  return { key, dir: firstDir }
}

export function compareBy<T>(key: keyof T, dir: SortDir) {
  return (a: T, b: T): number => {
    const av = a[key]
    const bv = b[key]
    const order = typeof av === 'string' && typeof bv === 'string'
      ? av.localeCompare(bv)
      : Number(av) - Number(bv)
    return dir === 'asc' ? order : -order
  }
}

export interface ReferralGroup<Row> {
  label: string
  sessions: number
  organicSessions: number
  paidSessions: number
  share: number
  sources: readonly Row[]
}

type GroupSortKey = 'label' | 'sessions' | 'organicSessions' | 'paidSessions'

/**
 * Groups (engines, platforms) with their raw source rows behind a disclosure.
 * Every figure is the API's; sorting only reorders the groups it sent.
 */
export function GroupedReferralTable<Group extends ReferralGroup<unknown>>({
  groups,
  groupLabel,
  caption,
  childColumns,
  childRowKey,
  renderChildCells,
  pinLast,
}: {
  groups: readonly Group[]
  groupLabel: string
  caption: string
  childColumns: ReadonlyArray<{ label: string; align: 'left' | 'right' }>
  childRowKey: (row: Group['sources'][number]) => string
  renderChildCells: (row: Group['sources'][number]) => ReactNode
  /** Groups kept at the bottom under every sort, as the API orders them (the unattributed AI group). */
  pinLast?: (group: Group) => boolean
}) {
  const baseId = useId()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [sort, setSort] = useState<{ key: GroupSortKey; dir: SortDir }>({ key: 'sessions', dir: 'desc' })
  const sorted = useMemo(() => {
    const byColumn = compareBy<Group>(sort.key, sort.dir)
    return [...groups].sort((a, b) => (
      Number(pinLast?.(a) ?? false) - Number(pinLast?.(b) ?? false) || byColumn(a, b)
    ))
  }, [groups, sort, pinLast])
  const onSort = (key: GroupSortKey) => setSort(current => nextSort(current, key, key === 'label' ? 'asc' : 'desc'))
  const toggle = (label: string) => setExpanded(current => {
    const next = new Set(current)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    return next
  })

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-default">
            <SortHeader label={groupLabel} sortKey="label" current={sort.key} dir={sort.dir} onSort={onSort} align="left" />
            <SortHeader label="Sessions" sortKey="sessions" current={sort.key} dir={sort.dir} onSort={onSort} align="right" />
            <SortHeader label="Organic" sortKey="organicSessions" current={sort.key} dir={sort.dir} onSort={onSort} align="right" />
            <SortHeader label="Paid" sortKey="paidSessions" current={sort.key} dir={sort.dir} onSort={onSort} align="right" />
            <PlainHeader label="Share" align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((group, index) => {
            const open = expanded.has(group.label)
            const panelId = `${baseId}-group-${index}`
            const count = group.sources.length
            return (
              <Fragment key={group.label}>
                <tr className="border-t border-subtle">
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={open ? panelId : undefined}
                      onClick={() => toggle(group.label)}
                      className="inline-flex min-h-8 max-w-full items-center gap-2 rounded text-left text-strong hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mono-400"
                    >
                      {open
                        ? <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-secondary" />
                        : <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted" />}
                      <span className="truncate" title={group.label}>{group.label}</span>
                      <span className="shrink-0 text-xs text-secondary tabular-nums">{count} {count === 1 ? 'source' : 'sources'}</span>
                    </button>
                  </td>
                  <td className="py-2 pl-4 text-right text-primary tabular-nums">{group.sessions.toLocaleString()}</td>
                  <td className="py-2 pl-4 text-right text-secondary tabular-nums">{group.organicSessions.toLocaleString()}</td>
                  <td className="py-2 pl-4 text-right text-secondary tabular-nums">{group.paidSessions.toLocaleString()}</td>
                  <td className="py-2 pl-4 text-right text-secondary tabular-nums">{formatPercent(group.share)}</td>
                </tr>
                {open && (
                  <tr id={panelId}>
                    <td colSpan={5} className="pb-3 pl-6">
                      <div className="overflow-x-auto rounded-md border border-subtle bg-bg/40 px-3 pb-1">
                        <table className="w-full min-w-[32rem] text-[13px]">
                          <caption className="sr-only">{`${group.label} sources`}</caption>
                          <thead>
                            <tr>
                              {childColumns.map(column => <PlainHeader key={column.label} label={column.label} align={column.align} />)}
                            </tr>
                          </thead>
                          <tbody>
                            {group.sources.map(row => (
                              <tr key={childRowKey(row)} className="border-t border-subtle">{renderChildCells(row)}</tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Series colours in stacking order; `other` is always the neutral grey. */
function seriesColor(key: string, index: number): string {
  return key === 'other' ? CHART_NEUTRAL.textDim : CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]!
}

/**
 * A stacked daily chart of server-built series, with a checkbox legend that
 * shows and hides each series. `baseline` is an optional reference line
 * (total sessions), off by default so the stack keeps its own scale.
 */
export function StackedSeriesChart({ input, baseline, baselineLabel, label, height = 224 }: {
  input: StackedSeriesInput | undefined
  baseline?: ReadonlyArray<{ date: string; value: number }>
  baselineLabel?: string
  label: string
  height?: number
}) {
  const { rows, series } = useMemo(() => buildStackedChartRows(input, baseline), [input, baseline])
  // Hidden series by their stable `key`, never by `dataKey`: dataKeys follow
  // rank (`s0` is the largest), and a new range can reorder the series.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [showBaseline, setShowBaseline] = useState(false)
  if (rows.length === 0) return null
  const visible = series.filter(entry => !hidden.has(entry.key))
  const labels = new Map(series.map(entry => [entry.dataKey, entry.label]))
  const toggle = (key: string) => setHidden(current => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return (
    <div>
      <div role="img" aria-label={label} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
            <XAxis dataKey="date" tick={CHART_AXIS_TICK} tickLine={false} axisLine={{ stroke: CHART_AXIS_STROKE }} tickFormatter={formatChartDateTick} minTickGap={24} />
            <YAxis tick={CHART_AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={36} />
            <RechartsTooltip
              {...CHART_TOOLTIP_STYLE}
              labelFormatter={formatChartDateLabel}
              formatter={(value, name) => [
                typeof value === 'number' ? value.toLocaleString() : String(value ?? 0),
                name === BASELINE_DATA_KEY ? (baselineLabel ?? 'Total') : (labels.get(String(name)) ?? String(name)),
              ]}
            />
            {visible.map(entry => {
              const color = seriesColor(entry.key, series.indexOf(entry))
              return (
                <Area key={entry.dataKey} type="monotone" dataKey={entry.dataKey} name={entry.dataKey} stackId="stack"
                      stroke={color} fill={color} fillOpacity={0.35} strokeWidth={1.5} />
              )
            })}
            {showBaseline && baselineLabel && (
              <Line type="monotone" dataKey={BASELINE_DATA_KEY} name={BASELINE_DATA_KEY} stroke={CHART_NEUTRAL.textFaint}
                    strokeWidth={1.5} strokeDasharray="5 4" dot={false} connectNulls={false} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <fieldset className="mt-2 flex flex-wrap gap-x-5 text-[13px] text-secondary">
        <legend className="sr-only">{`${label} series`}</legend>
        {series.map((entry, index) => (
          <label key={entry.key} className="flex min-h-9 items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-mono-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
              checked={!hidden.has(entry.key)}
              onChange={() => toggle(entry.key)}
            />
            <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: seriesColor(entry.key, index) }} />
            {entry.label}
          </label>
        ))}
        {baselineLabel && (
          <label className="flex min-h-9 items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-mono-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
              checked={showBaseline}
              onChange={() => setShowBaseline(value => !value)}
            />
            <svg aria-hidden="true" width="18" height="10" viewBox="0 0 18 10" className="shrink-0">
              <line x1="0" y1="5" x2="18" y2="5" stroke={CHART_NEUTRAL.textFaint} strokeWidth="2" strokeDasharray="5 3" />
            </svg>
            {baselineLabel}
          </label>
        )}
      </fieldset>
    </div>
  )
}

/** The figures the Site traffic card shows first: GA4's headline pair, then what Canonry reads most. */
export const SITE_TRAFFIC_DEFAULT_SLOTS: readonly GaOverviewMetricKey[] = ['sessions', 'activeUsers', 'organicSessions', 'engagementRate', 'keyEvents']
const SITE_TRAFFIC_SLOTS_KEY = 'canonry.siteTraffic.slots'
const OVERVIEW_LINE_COLOR = CHART_SERIES_COLORS[1]!
const OVERVIEW_SERIES = { current: 'current', previous: 'previous' } as const
type OverviewSeries = typeof OVERVIEW_SERIES[keyof typeof OVERVIEW_SERIES]

function isOverviewMetric(value: unknown): value is GaOverviewMetricKey {
  return typeof value === 'string' && GA_OVERVIEW_METRIC_ORDER.some(key => key === value)
}

/** The viewer's own choice of figures, kept in this browser only. Defaults when storage is unavailable or stale. */
function readSlots(): GaOverviewMetricKey[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SITE_TRAFFIC_SLOTS_KEY) ?? 'null')
    if (Array.isArray(parsed) && parsed.length === SITE_TRAFFIC_DEFAULT_SLOTS.length && parsed.every(isOverviewMetric)) {
      return [...parsed]
    }
  } catch {
    // Storage blocked or unreadable: the defaults are the whole fallback.
  }
  return [...SITE_TRAFFIC_DEFAULT_SLOTS]
}

function writeSlots(slots: readonly GaOverviewMetricKey[]): void {
  try {
    window.localStorage.setItem(SITE_TRAFFIC_SLOTS_KEY, JSON.stringify(slots))
  } catch {
    // A per-viewer convenience: without storage the choice lasts this visit.
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The change as words, for the figure's accessible name: the arrow alone says nothing to a screen reader. */
function describeChange(change: number | null): string {
  if (change === null) return 'no earlier data'
  if (change === 0) return 'no change on the previous period'
  return `${change > 0 ? 'up' : 'down'} ${formatPercent(Math.abs(change), RatioUnits.percent)} on the previous period`
}

/** The server's change against the previous period, coloured by whether it is good news for this figure. */
function OverviewChange({ metric, change }: { metric: GaOverviewMetricKey; change: number | null }) {
  const tone = gaOverviewChangeTone(metric, change)
  if (tone === null || change === null) {
    return <span className="block text-[13px] text-secondary">No earlier data</span>
  }
  const color = tone === GaOverviewChangeTones.better ? 'text-positive' : tone === GaOverviewChangeTones.worse ? 'text-negative' : 'text-secondary'
  const Icon = change > 0 ? ArrowUp : change < 0 ? ArrowDown : null
  return (
    <span className={`inline-flex items-center gap-0.5 text-[13px] font-medium tabular-nums ${color}`}>
      {Icon && <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.5} />}
      {formatPercent(Math.abs(change), RatioUnits.percent)}
    </span>
  )
}

interface OverviewRow {
  date: string
  previousDate: string
  current: number | null
  previous: number | null
}

function OverviewTooltip({ active, payload, metric }: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: OverviewRow }>
  metric: GaOverviewMetricKey
}) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  return (
    <div className="min-w-48 rounded-md border border-default bg-bg-elevated px-3 py-2 text-[13px] shadow-lg">
      <p className="mb-1 font-medium text-heading">{GA_OVERVIEW_METRICS[metric].label}</p>
      <p className="flex items-center justify-between gap-6">
        <span className="flex items-center gap-2 text-secondary">
          <svg aria-hidden="true" width="14" height="6" className="shrink-0"><line x1="0" y1="3" x2="14" y2="3" stroke={OVERVIEW_LINE_COLOR} strokeWidth="2.5" /></svg>
          {formatChartDateLabel(row.date)}
        </span>
        <span className="tabular-nums text-primary">{formatGaOverviewValue(metric, row.current)}</span>
      </p>
      <p className="flex items-center justify-between gap-6">
        <span className="flex items-center gap-2 text-secondary">
          <svg aria-hidden="true" width="14" height="6" className="shrink-0"><line x1="0" y1="3" x2="14" y2="3" stroke={OVERVIEW_LINE_COLOR} strokeWidth="1.5" strokeDasharray="3 2" /></svg>
          {formatChartDateLabel(row.previousDate)}
        </span>
        <span className="tabular-nums text-secondary">{formatGaOverviewValue(metric, row.previous)}</span>
      </p>
    </div>
  )
}

/**
 * GA4's overview card: a row of figures, each with its change against the
 * previous period, and the chosen figure by day with the previous period
 * dashed behind it. Each figure's label is a picker, as in GA4; picking a
 * figure already shown swaps the two. Every number is the API's.
 */
export function SiteTrafficCard({ overview, refreshing = false }: { overview: GaOverviewResponse; refreshing?: boolean }) {
  const baseId = useId()
  const [slots, setSlots] = useState<GaOverviewMetricKey[]>(readSlots)
  const [selected, setSelected] = useState(0)
  const [hidden, setHidden] = useState<ReadonlySet<OverviewSeries>>(new Set())
  const animate = !prefersReducedMotion()
  const metric = slots[selected] ?? SITE_TRAFFIC_DEFAULT_SLOTS[0]!
  const rows = useMemo<OverviewRow[]>(() => overview.days.map(day => ({
    date: day.date,
    previousDate: day.previousDate,
    current: day.values[metric],
    previous: day.previousValues[metric],
  })), [overview.days, metric])
  const hasDays = rows.some(row => row.current !== null || row.previous !== null)
  const windowDays = isGaOverviewWindow(overview.window) ? GA_OVERVIEW_WINDOW_DAYS[overview.window] : null
  const currentLabel = windowDays === null ? 'This period' : `Last ${windowDays} days`

  const chooseMetric = (index: number, key: GaOverviewMetricKey) => setSlots(current => {
    const next = [...current]
    const already = next.indexOf(key)
    if (already !== -1 && already !== index) next[already] = next[index]!
    next[index] = key
    writeSlots(next)
    return next
  })
  const focusTab = (index: number) => {
    setSelected(index)
    document.getElementById(`${baseId}-tab-${index}`)?.focus()
  }
  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    const last = slots.length - 1
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null
    if (target === null) return
    event.preventDefault()
    focusTab(target)
  }
  const toggleSeries = (series: OverviewSeries) => setHidden(current => {
    const next = new Set(current)
    if (next.has(series)) next.delete(series)
    else next.add(series)
    return next
  })

  return (
    <div className={`overflow-hidden rounded-lg border border-default transition-opacity duration-200 ${refreshing ? 'opacity-60' : ''}`}>
      <div role="tablist" aria-label="Site traffic figures" className="grid grid-cols-2 border-b border-default sm:grid-cols-3 lg:grid-cols-5">
        {slots.map((key, index) => {
          const active = index === selected
          const value = formatGaOverviewValue(key, overview.totals[key], { compact: true })
          // Keyed by slot, not figure: picking a figure re-renders the slot in
          // place, so its picker keeps keyboard focus.
          return (
            <div key={index} className="relative min-w-0 px-4 pb-4 pt-4">
              <span aria-hidden="true" className={`absolute inset-x-4 top-0 h-[3px] rounded-b-sm bg-link transition-opacity duration-200 ${active ? 'opacity-100' : 'opacity-0'}`} />
              <div className="relative inline-flex max-w-full items-center">
                <select
                  aria-label={`Figure ${index + 1}`}
                  value={key}
                  onChange={event => { if (isOverviewMetric(event.target.value)) chooseMetric(index, event.target.value) }}
                  className={`max-w-full cursor-pointer appearance-none truncate rounded-sm bg-transparent py-0.5 pr-5 text-sm font-medium [field-sizing:content] transition-colors duration-150 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${active ? 'text-link' : 'text-secondary'}`}
                >
                  {GA_OVERVIEW_METRIC_ORDER.map(option => (
                    <option key={option} value={option}>{GA_OVERVIEW_METRICS[option].label}</option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" className={`pointer-events-none absolute right-0 size-3.5 ${active ? 'text-link' : 'text-muted'}`} />
              </div>
              <button
                type="button"
                role="tab"
                id={`${baseId}-tab-${index}`}
                aria-selected={active}
                aria-controls={`${baseId}-panel`}
                aria-label={`${GA_OVERVIEW_METRICS[key].label} ${value}, ${describeChange(overview.changePct[key])}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setSelected(index)}
                onKeyDown={event => onTabKey(event, index)}
                className="mt-1 block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
              >
                <span className={`block truncate text-[26px] font-semibold leading-tight tabular-nums transition-colors duration-150 ${active ? 'text-primary' : 'text-strong'}`} title={formatGaOverviewValue(key, overview.totals[key])}>
                  {value}
                </span>
                <OverviewChange metric={key} change={overview.changePct[key]} />
              </button>
            </div>
          )
        })}
      </div>

      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${selected}`} className="px-4 pb-3 pt-4">
        {overview.syncedAt === null && (
          <p className="mb-3 text-sm text-secondary">These figures fill in after the next GA4 sync.</p>
        )}
        {hasDays ? (
          <div role="img" aria-label={`${GA_OVERVIEW_METRICS[metric].label} per day, ${currentLabel.toLowerCase()} and the previous period`} style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: 4 }}>
                <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
                <XAxis dataKey="date" tick={CHART_AXIS_TICK} tickLine={false} axisLine={{ stroke: CHART_AXIS_STROKE }} tickFormatter={formatChartDateTick} minTickGap={32} />
                <YAxis
                  orientation="right"
                  tick={CHART_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  allowDecimals={GA_OVERVIEW_METRICS[metric].unit !== GaOverviewUnits.count}
                  tickFormatter={(value: number) => formatGaOverviewValue(metric, value, { compact: true })}
                />
                <RechartsTooltip
                  cursor={{ stroke: CHART_NEUTRAL.textFaint, strokeWidth: 1 }}
                  wrapperStyle={{ outline: 'none' }}
                  content={<OverviewTooltip metric={metric} />}
                />
                {!hidden.has(OVERVIEW_SERIES.previous) && (
                  <Line type="monotone" dataKey={OVERVIEW_SERIES.previous} stroke={OVERVIEW_LINE_COLOR} strokeOpacity={0.65}
                        strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={{ r: 3, strokeWidth: 0, fill: OVERVIEW_LINE_COLOR }}
                        connectNulls={false} isAnimationActive={animate} animationDuration={320} animationEasing="ease-out" />
                )}
                {!hidden.has(OVERVIEW_SERIES.current) && (
                  <Line type="monotone" dataKey={OVERVIEW_SERIES.current} stroke={OVERVIEW_LINE_COLOR} strokeWidth={2.25} dot={false}
                        activeDot={{ r: 5, strokeWidth: 2, stroke: OVERVIEW_LINE_COLOR, fill: 'var(--color-bg)' }}
                        connectNulls={false} isAnimationActive={animate} animationDuration={320} animationEasing="ease-out" />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="py-8 text-sm text-secondary">No daily {GA_OVERVIEW_METRICS[metric].label.toLowerCase()} yet.</p>
        )}

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
          <fieldset className="flex flex-wrap gap-x-5 text-[13px] text-secondary">
            <legend className="sr-only">{`${GA_OVERVIEW_METRICS[metric].label} series`}</legend>
            {([
              [OVERVIEW_SERIES.current, currentLabel, ''],
              [OVERVIEW_SERIES.previous, 'Previous period', '4 3'],
            ] as const).map(([series, label, dash]) => {
              const checked = !hidden.has(series)
              const lastVisible = checked && hidden.size === 1
              return (
                <label key={series} className="flex min-h-9 items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-mono-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                    checked={checked}
                    disabled={lastVisible}
                    onChange={() => toggleSeries(series)}
                  />
                  <svg aria-hidden="true" width="18" height="10" viewBox="0 0 18 10" className="shrink-0">
                    <line x1="0" y1="5" x2="18" y2="5" stroke={OVERVIEW_LINE_COLOR} strokeWidth={series === OVERVIEW_SERIES.current ? 2.5 : 1.5} strokeDasharray={dash || undefined} />
                  </svg>
                  {label}
                </label>
              )
            })}
          </fieldset>
          {overview.current.startDate && overview.current.endDate && overview.previous.startDate && overview.previous.endDate && (
            <p className="text-[13px] text-secondary">
              {formatDateSpan(overview.current.startDate, overview.current.endDate, true)} vs {formatDateSpan(overview.previous.startDate, overview.previous.endDate, false)}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** "Sep 23 to Oct 22, 2026" for an inclusive span of calendar dates; the year only where asked. */
function formatDateSpan(start: string, end: string, withYear: boolean): string {
  const short = (iso: string, year: boolean) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  })
  return `${short(start, false)} to ${short(end, withYear)}`
}
