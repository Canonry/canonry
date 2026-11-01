import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react'
import { formatPointDelta, type TrendChange, type TrendFigure, type TrendUnit } from '@canonry/canonry-contracts'
import {
  CartesianGrid,
  ComposedChart,
  Line,
  RechartsTooltip,
  ReferenceArea,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_NEUTRAL,
  CHART_SERIES_COLORS,
  formatChartDateLabel,
  formatChartDateMonthDay,
  formatChartDateTick,
  formatObservedInstantLabel,
  formatObservedInstantMonthDay,
  formatObservedInstantTick,
  observedInstant,
  observedInstantYear,
} from './ChartPrimitives.js'
import { InfoTooltip } from './InfoTooltip.js'

/**
 * The trend card every dashboard tab leads with: figures across the top, the
 * chosen one charted below. Every value and change is the API's; the card only
 * lays them out, so a figure reads the same here, in the CLI and over MCP.
 *
 * A change always names what it is measured against ("vs prior 30 days",
 * "since Aug 16"), on its own line or once in its group's header, so one arrow
 * never means two things. The arrow follows the number; the colour follows
 * whether that is good news.
 */

export type TrendCardTone = 'better' | 'worse' | 'neutral'

export type TrendCardChange =
  | { kind: 'delta'; amount: string; direction: 'up' | 'down' | 'flat'; tone: TrendCardTone; basis: string }
  | { kind: 'note'; text: string }

export interface TrendCardPoint {
  date: string
  current: number | null
  previous?: number | null
  /** The previous period's own date for this row, shown in the tooltip. */
  previousDate?: string
}

export interface TrendCardPicker {
  ariaLabel: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}

export interface TrendCardFigure {
  key: string
  label: string
  /** Kept verbatim from the surface the figure came from. */
  help?: string
  /** Display value, already formatted. */
  value: string
  /** The unabbreviated value, offered on hover when `value` is compact. */
  exactValue?: string
  /** What a screen reader hears when `value` is abbreviated ("4,512" for "4.5K"). */
  spokenValue?: string
  /** Quiet words after the value ("of 64", "from 1 return"). */
  detail?: string
  change?: TrendCardChange
  /** Readings to chart. With fewer than two, the figure is a plain number unless `interactive` says otherwise. */
  series?: readonly TrendCardPoint[]
  /** Overrides the readings rule, e.g. a picker slot that stays a tab before its first sync. */
  interactive?: boolean
  /** Compare mode: this figure's line and swatch colour, a chart token. */
  color?: string
  /** Compare mode: nothing to plot, so the toggle is disabled. */
  disabled?: boolean
  /** The value is a state word ("Not measurable"), not a number. */
  stateValue?: boolean
  picker?: TrendCardPicker
  /** Keeps a slot's cell mounted while the figure inside it changes, so a picker keeps focus. */
  slot?: string
  formatValue?: (value: number) => string
  /** Rates and durations take fractional axis ticks; counts never do. */
  allowDecimals?: boolean
}

export interface TrendCardGroup {
  key: string
  label?: string
  help?: string
  /** The comparison every change in this group uses, said once in its header. */
  basis?: string
  figures: readonly TrendCardFigure[]
}

const SM_COLUMNS = ['', 'sm:grid-cols-1', 'sm:grid-cols-2', 'sm:grid-cols-3']
const LG_COLUMNS = ['', 'lg:grid-cols-1', 'lg:grid-cols-2', 'lg:grid-cols-3', 'lg:grid-cols-4', 'lg:grid-cols-5', 'lg:grid-cols-6']
/** Below this many readings a line is drawn straight between dots: a curve would invent bends. */
const DENSE_POINTS = 14
const LINE = CHART_SERIES_COLORS[1]!
const SERIES = { current: 'current', previous: 'previous' } as const
type Series = typeof SERIES[keyof typeof SERIES]

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const recorded = (figure: TrendCardFigure) => figure.series?.filter(point => point.current !== null).length ?? 0
export const isTrendFigureInteractive = (figure: TrendCardFigure) => figure.interactive ?? recorded(figure) >= 2

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** The change as words, for an accessible name: arrows and colours say nothing to a screen reader. */
export function describeTrendChange(change: TrendCardChange | undefined): string {
  if (!change) return ''
  if (change.kind === 'note') return lowerFirst(change.text)
  if (change.direction === 'flat') return `no change ${change.basis}`
  const verdict = change.tone === 'better' ? ', an improvement' : change.tone === 'worse' ? ', a decline' : ''
  return `${change.direction} ${change.amount} ${change.basis}${verdict}`
}

/** A reading's date: a calendar day, plus its moment when it was taken at one (a scan, a query). */
interface ReadingDate {
  date: string
  observedAt?: string | null
}

/** The day a reading names: a moment in the viewer's timezone, a calendar day as written. */
function readingMonthDay({ date, observedAt }: ReadingDate): string {
  return observedAt ? formatObservedInstantMonthDay(observedInstant(observedAt)) : formatChartDateMonthDay(date)
}

function readingYear({ date, observedAt }: ReadingDate): number {
  return observedAt ? observedInstantYear(observedInstant(observedAt)) : Number(date.slice(0, 4))
}

/**
 * A stored level's change from the trends read, in its own unit: a share moves
 * in points, a count or score as itself. The date is the API's first reading
 * in the window.
 */
export function levelTrendChange(change: TrendChange | null, unit: TrendUnit): TrendCardChange | undefined {
  if (!change) return undefined
  const basis = `since ${readingMonthDay(change.basis)}`
  if (change.difference === 0) return { kind: 'delta', amount: unit === 'fraction' ? '0 pts' : '0', direction: 'flat', tone: 'neutral', basis }
  const size = Math.abs(change.difference)
  return {
    kind: 'delta',
    amount: unit === 'fraction' ? `${formatPointDelta(size).magnitude} pts` : size.toLocaleString(),
    direction: change.difference > 0 ? 'up' : 'down',
    tone: change.tone,
    basis,
  }
}

/** The basis every change in a group shares, to say once in its header; none when they differ. */
export function sharedLevelBasis(figures: readonly TrendFigure[]): string | undefined {
  const labels = new Set(figures.map(figure => figure.change ? readingMonthDay(figure.change.basis) : null))
  const [label] = [...labels]
  return labels.size === 1 && label ? `since ${label}` : undefined
}

/** The readings a trend card plots: a moment's own time when the reading has one. */
export function trendCardPoints(figure: TrendFigure): TrendCardPoint[] {
  return figure.series.map(point => ({ date: point.observedAt ?? point.date, current: point.value }))
}

/** "Jul 2 to Oct 5, 2026" from the first and last reading, in the viewer's timezone for moments. */
export function trendSpanLabel(first: ReadingDate, last: ReadingDate): string {
  const day = (point: ReadingDate, withYear: boolean) => withYear ? `${readingMonthDay(point)}, ${readingYear(point)}` : readingMonthDay(point)
  return `${day(first, readingYear(first) !== readingYear(last))} to ${day(last, true)}`
}

function ChangeLine({ change, hideBasis }: { change?: TrendCardChange; hideBasis: boolean }) {
  if (!change) return null
  if (change.kind === 'note') return <span className="block min-h-5 text-label-13 text-secondary">{change.text}</span>
  if (change.direction === 'flat') return <span className="block min-h-5 text-label-13 text-secondary">No change{hideBasis ? '' : ` ${change.basis}`}</span>
  const Icon = change.direction === 'up' ? ArrowUp : ArrowDown
  const tone = change.tone === 'better' ? 'text-positive' : change.tone === 'worse' ? 'text-negative' : 'text-secondary'
  return (
    <span className="flex min-h-5 flex-wrap items-center gap-x-1 text-label-13 tabular-nums">
      <span className={`inline-flex items-center gap-0.5 text-label-13-strong ${tone}`}>
        <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
        {change.amount}
      </span>
      {!hideBasis && <span className="text-secondary">{change.basis}</span>}
    </span>
  )
}

function FigureValue({ figure, active }: { figure: TrendCardFigure; active: boolean }) {
  if (figure.stateValue) return <span className="flex min-h-10 items-center text-label-14 text-secondary">{figure.value}</span>
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span className={`text-heading-32 tabular-nums transition-colors duration-150 ${active ? 'text-primary' : 'text-strong'}`} title={figure.exactValue}>{figure.value}</span>
      {figure.detail && <span className="text-label-13 text-secondary">{figure.detail}</span>}
    </span>
  )
}

function TrendTooltip({ active, payload, figure, previousLabel, dayLabel }: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: TrendCardPoint }>
  figure: TrendCardFigure
  previousLabel?: string
  dayLabel: (value: string) => string
}) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  const format = (value: number | null | undefined) => value === null || value === undefined ? '—' : (figure.formatValue?.(value) ?? value.toLocaleString())
  return (
    <div className="material-tooltip min-w-48 px-3 py-2 text-label-13">
      <p className="mb-1 text-copy-13-strong text-heading">{figure.label}</p>
      <p className="flex items-center justify-between gap-6">
        <span className="text-secondary">{dayLabel(row.date)}</span>
        <span className="tabular-nums text-primary">{row.current === null ? 'Not recorded' : format(row.current)}</span>
      </p>
      {previousLabel && row.previous !== undefined && (
        <p className="flex items-center justify-between gap-6">
          <span className="text-secondary">{row.previousDate ? formatChartDateLabel(row.previousDate) : previousLabel}</span>
          <span className="tabular-nums text-secondary">{format(row.previous)}</span>
        </p>
      )}
    </div>
  )
}

export function TrendCard({
  name,
  groups,
  mode = 'single',
  selected,
  onSelect,
  span,
  cadence = 'day',
  instants = false,
  currentLabel,
  previous,
  notRecordedBefore,
  chart,
  legendExtra,
  controls,
  notice,
  emptyChartMessage,
  refreshing = false,
  chartHeight = 240,
  frame = 'card',
}: {
  /** Accessible name of the card and of its figure tabs. */
  name: string
  groups: readonly TrendCardGroup[]
  /** `single`: one figure charted at a time (tabs). `compare`: several toggled on, each on its own axis (the caller's chart). */
  mode?: 'single' | 'compare'
  selected: readonly string[]
  onSelect: (key: string) => void
  /** The dates the chart covers, always this and nothing else. */
  span?: string
  /** What one reading is, for the chart's accessible name: "per day", "per scan". */
  cadence?: 'day' | 'scan' | 'release'
  /** The points' dates are moments (scans, queries): plot them on a time scale and label them in the viewer's timezone, never as UTC days. */
  instants?: boolean
  currentLabel?: string
  previous?: { label: string; available: boolean }
  /** First recorded date, in the same form as the points' dates: earlier points are hatched as not recorded, never drawn as zero. */
  notRecordedBefore?: string | null
  /** Compare mode: the caller's multi-axis chart for the toggled figures. */
  chart?: ReactNode
  /** Extra legend items after the series checkboxes, such as a trend line toggle. */
  legendExtra?: ReactNode
  /** Controls beside the date span, such as a range picker that moves only the chart. */
  controls?: ReactNode
  /** One line above the chart, such as "These figures fill in after the next sync." */
  notice?: ReactNode
  /** Shown instead of a chart when the selected figure has nothing to draw. */
  emptyChartMessage?: string
  refreshing?: boolean
  chartHeight?: number
  /** `none` sits inside a section card that already frames it: it bleeds to the card's padding instead of nesting a card. */
  frame?: 'card' | 'none'
}) {
  const id = useId().replace(/:/g, '')
  const dayLabel = (value: string) => instants ? formatObservedInstantLabel(observedInstant(value)) : formatChartDateLabel(value)
  // A tick on the time scale is a moment on that scale, so it reads in the
  // viewer's timezone like the readings around it.
  const timeTick = (value: number) => formatObservedInstantTick(observedInstant(new Date(value).toISOString()))
  const [hidden, setHidden] = useState<ReadonlySet<Series>>(new Set())
  const animate = !prefersReducedMotion()
  const figures = groups.flatMap(group => group.figures)
  const lead = mode === 'single' ? figures.find(figure => figure.key === selected[0]) : undefined
  const rows = lead?.series ?? []
  // Moments (scans, releases) come at uneven intervals, so they sit on a time
  // scale: evenly spaced points would misstate how fast a figure moved.
  const chartRows = instants ? rows.map(row => ({ ...row, at: Date.parse(row.date) })) : rows
  const hasPrevious = Boolean(previous?.available) && rows.some(row => row.previous !== null && row.previous !== undefined)
  const drawable = rows.filter(row => row.current !== null).length >= 1
  const lineType = recorded(lead ?? { key: '', label: '', value: '' }) < DENSE_POINTS ? 'linear' : 'monotone'
  const unrecorded = notRecordedBefore ? rows.filter(row => row.date < notRecordedBefore) : []
  const lastUnrecorded = unrecorded.at(-1)?.date
  const bandLabelled = rows.length > 0 && unrecorded.length / rows.length >= 0.2
  const per = cadence === 'day' ? 'per day' : cadence === 'scan' ? 'per scan' : 'per release'
  const summary = lead
    ? `${lead.label} ${per}, ${currentLabel ? lowerFirst(currentLabel) : span ?? ''}${hasPrevious ? ' and the previous period' : ''}${lastUnrecorded ? `, not recorded before ${dayLabel(notRecordedBefore!)}` : ''}`
    : ''

  const interactiveKeys = figures.filter(isTrendFigureInteractive).map(figure => figure.key)
  const focusTab = (key: string) => {
    onSelect(key)
    document.getElementById(`${id}-tab-${key}`)?.focus()
  }
  const onTabKey = (event: KeyboardEvent, key: string) => {
    const index = interactiveKeys.indexOf(key)
    const last = interactiveKeys.length - 1
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null
    if (target === null) return
    event.preventDefault()
    focusTab(interactiveKeys[target]!)
  }
  const toggleSeries = (series: Series) => setHidden(current => {
    const next = new Set(current)
    if (next.has(series)) next.delete(series)
    else next.add(series)
    return next
  })

  const cell = (figure: TrendCardFigure, group: TrendCardGroup) => {
    const interactive = isTrendFigureInteractive(figure)
    const active = selected.includes(figure.key)
    const hideBasis = Boolean(group.basis)
    const spoken = [
      `${figure.label} ${figure.spokenValue ?? figure.value}${figure.detail ? ` ${figure.detail}` : ''}`,
      describeTrendChange(figure.change),
    ].filter(Boolean).join(', ')
    const label = (
      <div className="flex min-h-5 items-center gap-1.5">
        {mode === 'compare' && interactive && (
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: active ? figure.color : 'transparent', border: `1.5px solid ${figure.color}` }}
          />
        )}
        {figure.picker ? (
          <span className="relative inline-flex max-w-full items-center">
            <select
              aria-label={figure.picker.ariaLabel}
              value={figure.picker.value}
              onChange={event => figure.picker!.onChange(event.target.value)}
              className={`max-w-full cursor-pointer appearance-none truncate rounded-sm bg-transparent py-0.5 pr-5 text-label-14-strong [field-sizing:content] transition-colors duration-150 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${active ? 'text-link' : 'text-secondary'}`}
            >
              {figure.picker.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <ChevronDown aria-hidden="true" className={`pointer-events-none absolute right-0 size-3.5 ${active ? 'text-link' : 'text-muted'}`} />
          </span>
        ) : (
          <span className={`text-label-14-strong ${interactive && active ? (mode === 'single' ? 'text-link' : 'text-heading') : 'text-secondary'}`}>{figure.label}</span>
        )}
        {figure.help && <InfoTooltip text={figure.help} />}
      </div>
    )
    if (!interactive) {
      return (
        <div key={figure.slot ?? figure.key} className="flex min-w-0 flex-col px-4 pb-4 pt-3">
          <dt>{label}</dt>
          <dd className="mt-auto pt-1">
            <FigureValue figure={figure} active={false} />
            <ChangeLine change={figure.change} hideBasis={hideBasis} />
            {figure.change && <span className="sr-only">{describeTrendChange(figure.change)}</span>}
          </dd>
        </div>
      )
    }
    return (
      <div
        key={figure.slot ?? figure.key}
        className={`relative flex min-w-0 flex-col px-4 pb-4 pt-3 transition-colors duration-150 ${active ? 'bg-surface-active' : 'hover:bg-surface-hover'}`}
      >
        <span
          aria-hidden="true"
          className={`absolute inset-x-0 top-0 h-[3px] transition-opacity duration-200 ${mode === 'single' ? 'bg-link' : ''} ${active ? 'opacity-100' : 'opacity-0'}`}
          style={mode === 'compare' ? { backgroundColor: figure.color } : undefined}
        />
        {label}
        <button
          type="button"
          id={`${id}-tab-${figure.key}`}
          {...(mode === 'single'
            ? { role: 'tab', 'aria-selected': active, 'aria-controls': `${id}-panel`, tabIndex: active ? 0 : -1, onKeyDown: (event: KeyboardEvent) => onTabKey(event, figure.key) }
            : { 'aria-pressed': active })}
          aria-label={spoken}
          disabled={figure.disabled}
          onClick={() => onSelect(figure.key)}
          className="mt-auto block w-full rounded-sm pt-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FigureValue figure={figure} active={active} />
          <ChangeLine change={figure.change} hideBasis={hideBasis} />
        </button>
      </div>
    )
  }

  return (
    <div className={`${frame === 'card' ? 'overflow-hidden material-base' : '-mx-4'} transition-opacity duration-200 ${refreshing ? 'opacity-60' : ''}`}>
      <div className="flex flex-col lg:flex-row">
        {groups.map((group, index) => {
          const interactive = group.figures.some(isTrendFigureInteractive)
          const labelId = `${id}-group-${group.key}`
          const grid = `grid grid-cols-2 ${SM_COLUMNS[Math.min(group.figures.length, 3)]} ${LG_COLUMNS[Math.min(group.figures.length, 6)]}`
          return (
            <div
              key={group.key}
              role={group.label ? 'group' : undefined}
              aria-labelledby={group.label ? labelId : undefined}
              className={`min-w-0 lg:basis-0 ${index > 0 ? 'border-t border-default lg:border-l lg:border-t-0' : ''}`}
              style={{ flexGrow: group.figures.length }}
            >
              {(group.label || group.basis) && (
                <div className="flex flex-wrap items-center justify-between gap-x-3 px-4 pt-3">
                  <span className="flex items-center gap-1.5">
                    <span id={labelId} className="text-label-13 text-secondary">{group.label}</span>
                    {group.help && <InfoTooltip text={group.help} />}
                  </span>
                  {group.basis && <span className="text-label-13 text-secondary">{group.basis}</span>}
                </div>
              )}
              {interactive ? (
                <div role={mode === 'single' ? 'tablist' : undefined} aria-label={mode === 'single' ? name : undefined} className={grid}>
                  {group.figures.map(figure => cell(figure, group))}
                </div>
              ) : (
                <dl className={grid}>{group.figures.map(figure => cell(figure, group))}</dl>
              )}
            </div>
          )
        })}
      </div>

      <div
        id={`${id}-panel`}
        {...(mode === 'single' && lead ? { role: 'tabpanel', 'aria-labelledby': `${id}-tab-${lead.key}` } : { role: 'region', 'aria-label': `${name} chart` })}
        className="border-t border-default px-4 pb-3 pt-4"
      >
        {notice && <div className="mb-3 text-copy-14 text-secondary">{notice}</div>}
        {mode === 'compare' ? chart : !lead || !drawable ? (
          <p className="flex h-32 items-center justify-center px-6 text-center text-copy-14 text-secondary">{emptyChartMessage}</p>
        ) : (
          <>
            <div role="img" aria-label={summary} style={{ height: chartHeight }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={[...chartRows]} margin={{ top: 8, right: 0, bottom: 0, left: 4 }}>
                  <defs>
                    <pattern id={`${id}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_NEUTRAL.textFaint} strokeWidth="1.25" strokeOpacity="0.5" />
                    </pattern>
                  </defs>
                  <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
                  {lastUnrecorded && (
                    <ReferenceArea
                      x2={instants ? Date.parse(lastUnrecorded) : lastUnrecorded}
                      fill={`url(#${id}-hatch)`}
                      fillOpacity={1}
                      ifOverflow="visible"
                      label={bandLabelled ? { value: 'Not recorded', position: 'insideTopLeft', fill: CHART_NEUTRAL.text, fontSize: 12 } : undefined}
                    />
                  )}
                  {instants ? (
                    <XAxis dataKey="at" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={CHART_AXIS_TICK} tickLine={false} axisLine={{ stroke: CHART_AXIS_STROKE }} tickFormatter={timeTick} minTickGap={32} padding={{ left: lastUnrecorded ? 0 : 12, right: 12 }} />
                  ) : (
                    <XAxis dataKey="date" tick={CHART_AXIS_TICK} tickLine={false} axisLine={{ stroke: CHART_AXIS_STROKE }} tickFormatter={formatChartDateTick} minTickGap={32} padding={{ left: lastUnrecorded ? 0 : 12, right: 12 }} />
                  )}
                  <YAxis
                    orientation="right"
                    tick={CHART_AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={52}
                    allowDecimals={lead.allowDecimals ?? false}
                    tickFormatter={(value: number) => lead.formatValue?.(value) ?? value.toLocaleString()}
                  />
                  <RechartsTooltip
                    cursor={{ stroke: CHART_NEUTRAL.textFaint, strokeWidth: 1 }}
                    wrapperStyle={{ outline: 'none' }}
                    content={<TrendTooltip figure={lead} previousLabel={hasPrevious ? previous?.label : undefined} dayLabel={dayLabel} />}
                  />
                  {hasPrevious && !hidden.has(SERIES.previous) && (
                    <Line type={lineType} dataKey={SERIES.previous} stroke={LINE} strokeOpacity={0.65} strokeWidth={1.5} strokeDasharray="4 4"
                          dot={false} activeDot={{ r: 3, strokeWidth: 0, fill: LINE }} connectNulls={false}
                          isAnimationActive={animate} animationDuration={320} animationEasing="ease-out" />
                  )}
                  {!hidden.has(SERIES.current) && (
                    <Line type={lineType} dataKey={SERIES.current} stroke={LINE} strokeWidth={2.25}
                          dot={lineType === 'linear' ? { r: 3, strokeWidth: 0, fill: LINE } : false}
                          activeDot={{ r: 5, strokeWidth: 2, stroke: LINE, fill: 'var(--color-bg)' }}
                          connectNulls={false} isAnimationActive={animate} animationDuration={320} animationEasing="ease-out" />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="sr-only">
              <table>
                <caption>{summary}</caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">{lead.label}</th>
                    {hasPrevious && <th scope="col">{previous!.label}</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.date}>
                      <th scope="row">{dayLabel(row.date)}</th>
                      <td>{row.current === null ? 'Not recorded' : (lead.formatValue?.(row.current) ?? row.current.toLocaleString())}</td>
                      {hasPrevious && <td>{row.previous === null || row.previous === undefined ? 'No data' : (lead.formatValue?.(row.previous) ?? row.previous.toLocaleString())}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {(mode === 'single' && lead && drawable && currentLabel) || legendExtra || span || controls ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
            <fieldset className="flex flex-wrap gap-x-5 text-label-13 text-secondary">
              <legend className="sr-only">{lead ? `${lead.label} series` : `${name} options`}</legend>
              {mode === 'single' && lead && drawable && currentLabel && previous && (
                <>
                  <SeriesToggle
                    label={currentLabel}
                    checked={!hidden.has(SERIES.current)}
                    disabled={!hasPrevious || (hidden.size === 1 && !hidden.has(SERIES.current))}
                    onChange={() => toggleSeries(SERIES.current)}
                    dash={undefined}
                  />
                  <SeriesToggle
                    label={hasPrevious ? previous.label : `${previous.label}: no earlier data`}
                    checked={hasPrevious && !hidden.has(SERIES.previous)}
                    disabled={!hasPrevious || (hidden.size === 1 && !hidden.has(SERIES.previous))}
                    onChange={() => toggleSeries(SERIES.previous)}
                    dash="4 3"
                  />
                </>
              )}
              {legendExtra}
            </fieldset>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {span && <p className="text-copy-13 text-secondary">{span}</p>}
              {controls}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SeriesToggle({ label, checked, disabled, onChange, dash }: { label: string; checked: boolean; disabled: boolean; onChange: () => void; dash: string | undefined }) {
  return (
    <label className="flex min-h-9 items-center gap-2 pointer-coarse:min-h-11">
      <input
        type="checkbox"
        className="size-4 accent-mono-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <svg aria-hidden="true" width="18" height="10" viewBox="0 0 18 10" className="shrink-0">
        <line x1="0" y1="5" x2="18" y2="5" stroke={LINE} strokeWidth={dash ? 1.5 : 2.5} strokeDasharray={dash} />
      </svg>
      {label}
    </label>
  )
}
