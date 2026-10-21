import { Fragment, useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { formatPercent } from '@canonry/canonry-contracts'
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

export function SubHeading({ title, tooltip, meta }: { title: string; tooltip?: string; meta?: ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex flex-wrap items-baseline justify-between gap-2">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-heading">{title}</h3>
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      {meta && <p className="text-xs text-secondary">{meta}</p>}
    </div>
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
