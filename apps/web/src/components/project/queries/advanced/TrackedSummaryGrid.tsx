import { forwardRef, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight, Info, Loader, Triangle, type LucideProps } from 'lucide-react'
import { formatPercent, formatPointDelta } from '@canonry/canonry-contracts'
import type { QueryTrackingGroup, QueryTrackingLimits, QueryTrackingMarket, QueryTrackingResultTotals, QueryTrackingSummary, QueryTrackingTarget } from '@canonry/canonry-contracts'

import { excludedAnswersLabel } from '../../../../lib/format-helpers.js'
import { formatObservedInstantLabel, formatObservedInstantMonthDay, observedInstant, observedInstantYear } from '../../../shared/ChartPrimitives.js'
import { InfoTooltip, useTooltipBubble } from '../../../shared/InfoTooltip.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'

/** The place the Tracked page is narrowed to: its entry as the workspace read returned it, server counts and all. */
export type TrackedSummaryPlace =
  | { kind: 'market'; market: QueryTrackingMarket }
  | { kind: 'location'; target: QueryTrackingTarget }
  | { kind: 'group'; group: QueryTrackingGroup }

interface Stat { label: string; value: number; help?: string }

const whole = (value: number) => value.toLocaleString('en-US')
/** The cells that have a number to print, in order. */
const cells = (stats: readonly (Stat | false | undefined)[]): Stat[] => stats.filter((stat): stat is Stat => Boolean(stat))

const HELP = {
  answers: 'Answers one sweep collects: each query on every engine and search location it is asked on.',
  placeAnswers: 'Answers one sweep collects for this place. Places share answers, so they do not add up to the project total.',
  locationAnswers: 'Answers one sweep collects for this location, its market queries included. Locations share answers, so they do not add up to the project total.',
  links: 'One for each location a query counts for, on each search location.',
}

/** A list the server returned gives its length; one it left out gives no cell. Nothing is counted in its place. */
const listed = (label: string, list: readonly unknown[] | undefined): Stat | false => list !== undefined && { label, value: list.length }

/**
 * Every count of the project's queries, for Details: what is asked and of
 * which type, then by Subject, then the links. Company, Mixed type and Not set
 * are rare, so each shows only above zero. A count is named as queries, as a
 * place's strip names it, so it never reads as a count of markets or locations.
 */
function detailStats(summary: QueryTrackingSummary): Stat[] {
  return cells([
    { label: 'Queries asked', value: summary.asked },
    { label: 'Non-brand queries', value: summary.byClass.nonBrand },
    { label: 'Branded queries', value: summary.byClass.branded },
    { label: 'Answers per sweep', value: summary.answersPerSweep, help: HELP.answers },
    { label: 'Market queries', value: summary.byFocus.market },
    { label: 'Location queries', value: summary.byFocus.property },
    { label: 'Hand-picked queries', value: summary.byFocus.custom },
    summary.byFocus.company > 0 && { label: 'Company queries', value: summary.byFocus.company },
    summary.byClass.mixed > 0 && { label: 'Mixed type', value: summary.byClass.mixed },
    summary.byClass.unknown > 0 && { label: 'Not set', value: summary.byClass.unknown },
    { label: 'Not asked', value: summary.notAsked },
    { label: 'Query-location pairs', value: summary.assignments.total, help: HELP.links },
    { label: 'Non-brand pairs', value: summary.assignments.nonBrand },
    { label: 'Branded pairs', value: summary.assignments.branded },
  ])
}

/** A place's numbers are its own server `counts`; null when this server sent none. */
function placeStats(place: TrackedSummaryPlace): Stat[] | null {
  if (place.kind === 'market') {
    const counts = place.market.counts
    return counts ? cells([
      { label: 'Market queries', value: counts.marketQueries },
      { label: 'Location queries', value: counts.propertyQueries },
      listed('Locations', place.market.targetKeys),
      { label: 'Answers per sweep', value: counts.answersPerSweep, help: HELP.placeAnswers },
    ]) : null
  }
  if (place.kind === 'location') {
    const counts = place.target.counts
    return counts ? cells([
      { label: 'Location queries', value: counts.propertyQueries },
      { label: 'Market queries', value: counts.marketQueries },
      counts.customQueries > 0 && { label: 'Hand-picked queries', value: counts.customQueries },
      listed('Markets', place.target.marketKeys),
      { label: 'Answers per sweep', value: counts.answersPerSweep, help: HELP.locationAnswers },
    ]) : null
  }
  const counts = place.group.counts
  return counts ? cells([
    { label: 'Queries', value: counts.queries },
    listed('Locations', place.group.targetKeys),
    { label: 'Markets', value: counts.markets },
    { label: 'Answers per sweep', value: counts.answersPerSweep, help: HELP.placeAnswers },
  ]) : null
}

/**
 * What the results read says about the listed queries: `loading` while it is in flight, `none` before the
 * first sweep, `error` after a failed read, otherwise `ready` with the server's totals.
 */
export type TrackedResultsState =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'error' }
  | { state: 'ready'; totals: readonly QueryTrackingResultTotals[] | undefined }

/** Non-brand leads, as every report does; the two types are never one number. */
const TYPE_ORDER = ['non-brand', 'branded', 'unknown'] as const
const TYPE_LABEL: Record<(typeof TYPE_ORDER)[number], string> = { 'non-brand': 'Non-brand', branded: 'Branded', unknown: 'Not set' }
const RATE_REASON: Record<string, string> = {
  'no-population': 'No answer in the last sweep for these queries.',
  incomplete: 'The last sweep did not finish for these queries.',
  'evidence-incomplete': 'Sources were not saved for these answers.',
  'identity-ambiguous': 'No answer could be tied to one location.',
  'not-applicable': 'Not counted for this place.',
}

type Rate = QueryTrackingResultTotals['mentionCoverage']
type Comparison = NonNullable<QueryTrackingResultTotals['comparison']>

/**
 * The rate's own sentences: its two counts, the answers it left out, and with
 * a comparison both sweeps' rates over the queries both measured. Every
 * figure is the server's.
 */
function rateDetail(rate: Rate, signal: 'mentioned' | 'cited', comparison: Comparison | undefined): string {
  const sentences: string[] = []
  if (rate.rate === null || rate.numerator === null || rate.denominator === null) sentences.push(RATE_REASON[rate.reason ?? ''] ?? 'Not measured in the last sweep.')
  else {
    const verb = signal === 'mentioned' ? 'mention' : 'cite'
    sentences.push(`${whole(rate.numerator)} of ${whole(rate.denominator)} answers in the last sweep ${verb} a location the query is asked for.`)
    const left = excludedAnswersLabel(rate, signal)
    if (left) sentences.push(`${left}.`)
  }
  if (comparison) {
    const [now, before] = signal === 'mentioned'
      ? [comparison.mentionCoverage.rate, comparison.previousMentionCoverage.rate]
      : [comparison.citationCoverage.rate, comparison.previousCitationCoverage.rate]
    const queries = `${whole(comparison.queries)} ${comparison.queries === 1 ? 'query' : 'queries'}`
    if (now !== null && before !== null) sentences.push(`The same ${queries} in the previous sweep: ${formatPercent(before)}, now ${formatPercent(now)}.`)
  }
  return sentences.join(' ')
}

const CHANGE_TONE = { up: 'text-positive-400', down: 'text-negative-400', none: 'text-muted' } as const

/** The server's change since the previous sweep, in points: "▲ 4.1". No change and no comparison draw nothing. */
function PointChange({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined) return null
  const { direction, magnitude } = formatPointDelta(delta)
  if (direction === 'none') return null
  return (
    <span className={`inline-flex items-center gap-0.5 text-[13px] font-medium leading-5 tabular-nums ${CHANGE_TONE[direction]}`}>
      <Triangle aria-hidden="true" className={`size-2.5 fill-current ${direction === 'down' ? 'rotate-180' : ''}`} />
      {magnitude}
      <span className="sr-only">{` points ${direction} vs previous sweep`}</span>
    </span>
  )
}

/**
 * One rate of the grid: the server's share, and beside it the server's change
 * since the previous sweep. The figure is the trigger of its own bubble, which
 * holds its counts, the answers it left out and both sweeps' rates over the
 * same queries, so the grid draws no help icon. Its name says the type, the
 * signal and the figure, so it is never heard as a bare number.
 */
function RateCell({ rate, signal, type, comparison }: { rate: Rate; signal: 'mentioned' | 'cited'; type: string; comparison: Comparison | undefined }) {
  const measured = rate.rate !== null
  const figure = measured ? formatPercent(rate.rate) : 'Not measured'
  const delta = comparison === undefined ? undefined : signal === 'mentioned' ? comparison.mentionDelta : comparison.citationDelta
  const detail = rateDetail(rate, signal, comparison)
  // Four figures share a row, so a pointer on its way across opens nothing until it rests on one.
  const bubble = useTooltipBubble(detail, { placement: 'bottom', align: 'start', hoverDelay: 300 })
  return (
    <td className={FIGURE_CELL}>
      <span className="inline-flex items-baseline gap-2">
        <button type="button" className={`${measured ? NUMBER : UNMEASURED} ${FIGURE}`} aria-label={`${type} ${signal}: ${figure}`} aria-description={detail} {...bubble.wrapper} {...bubble.trigger}>
          {figure}
        </button>
        {bubble.bubble}
        <PointChange delta={delta} />
      </span>
    </td>
  )
}

/**
 * The last sweep's result for the listed queries as one small grid, a row per
 * type (Non-brand first) and a column per signal: how many queries of the
 * type were measured, and the share of their answers that mention and that
 * cite a location the query is asked for. Each label is said once, and the
 * two types are never one number. Every figure is a field of the results read.
 */
export function TrackedResultFigures({ results }: { results: TrackedResultsState }) {
  if (results.state === 'none') return null
  if (results.state === 'loading') return (
    <div role="status" aria-label="Loading results" className="grid w-fit grid-cols-[auto_auto_auto_auto] items-center gap-x-8 gap-y-2">
      {[0, 1, 2].map(row => <div key={row} aria-hidden="true" className="contents">
        <div className="skeleton-text w-16" /><div className="skeleton-text w-8" /><div className={`skeleton-text w-20 ${row > 0 ? 'h-5' : ''}`} /><div className={`skeleton-text w-20 ${row > 0 ? 'h-5' : ''}`} />
      </div>)}
    </div>
  )
  if (results.state === 'error') return <StatusNote icon={AlertTriangle} tone="caution" label="Results unavailable" detail="The last sweep's results did not load." />
  const totals = TYPE_ORDER.flatMap(type => results.totals?.filter(total => total.queryClass === type) ?? [])
  if (totals.length === 0) return <StatusNote icon={Info} label="Not measured" detail="No query listed here was in the last sweep." />
  return (
    <table aria-label="Last sweep results" className="w-fit border-separate border-spacing-0 text-[13px] leading-5">
      <thead>
        <tr>
          <th scope="col" className={HEAD}><span className="sr-only">Type</span></th>
          <th scope="col" className={`${HEAD} ${QUERIES} text-right`}>Queries</th>
          <th scope="col" className={HEAD}>Mentioned</th>
          <th scope="col" className={HEAD}>Cited</th>
        </tr>
      </thead>
      <tbody>
        {totals.map(total => (
          <tr key={total.queryClass}>
            <th scope="row" className={`${BODY} ${GAP} whitespace-nowrap text-left font-medium text-strong`}>{TYPE_LABEL[total.queryClass]}</th>
            <td className={`${BODY} ${GAP} ${QUERIES} text-right tabular-nums text-secondary`}>{whole(total.queries)}</td>
            <RateCell rate={total.mentionCoverage} signal="mentioned" type={TYPE_LABEL[total.queryClass]} comparison={total.comparison} />
            <RateCell rate={total.citationCoverage} signal="cited" type={TYPE_LABEL[total.queryClass]} comparison={total.comparison} />
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// The strip has three shapes, decided by its own width, not the window's: the sidebar takes its share of a
// window. Pairs of cells on a phone. Three columns from 36rem, so a laptop beside the sidebar reads two rows.
// One row from the width every cell fits at its own label and number: a place's few numbers from 44rem, five
// numbers from 52rem. In the row no column is narrower than its number's label, and the last cell spans two
// columns, so Details opens under the row on the same columns.
type Shape = 'few' | 'many'
const ROW: Record<Shape, { strip: string; inset: string; flat: string; wide: string }> = {
  few: {
    strip: '@[44rem]:grid-cols-[repeat(var(--tracked-strip-columns),minmax(max-content,1fr))]',
    inset: '@[44rem]:border-l @[44rem]:pl-4',
    flat: '@[44rem]:border-t-0',
    wide: '@[44rem]:col-span-2',
  },
  many: {
    strip: '@[52rem]:grid-cols-[repeat(var(--tracked-strip-columns),minmax(max-content,1fr))]',
    inset: '@[52rem]:border-l @[52rem]:pl-4',
    flat: '@[52rem]:border-t-0',
    wide: '@[52rem]:col-span-2',
  },
}
const STRIP = 'grid grid-cols-2 border-y border-default @xl:grid-cols-3'
const CELL = 'min-w-0 border-subtle py-3 @xl:pr-4'
// On a phone the last cell is a row: the links, and the sweep dates beside them where they fit. From three columns up it is a cell, the links over the dates.
const LAST = 'col-span-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-subtle py-3 text-[13px] leading-5 text-secondary @xl:flex-col @xl:flex-nowrap @xl:items-stretch @xl:justify-center'
// The sweep dates are one line where the cell holds both and two lines in less; they never widen the cell. Each
// carries the dot before it in a gutter that hangs out on the left, where it is cut off: a dot shows between
// two dates on a line, and never at the end or the start of one.
const SWEEP_BOX = 'min-w-[10rem] flex-1 contain-inline-size [clip-path:inset(-0.25rem_-0.25rem_-0.25rem_0)] @xl:flex-none'
const SWEEP = '-ml-4 flex flex-wrap items-center'
const SWEEP_PART = 'flex items-center whitespace-nowrap'
const SWEEP_DOT = 'w-4 shrink-0 text-center'
/** A place's four numbers or fewer fit one row sooner than five do. */
const shapeOf = (count: number, place: boolean): Shape => place && count <= 4 ? 'few' : 'many'
/** The row's columns: one for each number and two for the last cell. */
const stripStyle = (count: number) => ({ '--tracked-strip-columns': count + 2 }) as CSSProperties

/**
 * A number's cell. Pairs and three columns put a hairline over every row but the first; the right-hand cell
 * of a pair is set in by padding, not a gap, so that line is unbroken. An odd count gives the first cell a
 * row of the pairs to itself, so no cell sits beside an empty one. In three columns and in the row a cell is
 * set in, behind a hairline, from every column but the first.
 */
function cellClass(index: number, count: number, shape: Shape): string {
  const alone = count % 2 === 1
  const pair = alone && index > 0 ? index + 1 : index
  const below = index >= 3 ? ` border-t ${ROW[shape].flat}` : pair >= 2 ? ' @max-xl:border-t' : ''
  const inset = index % 3 ? ' @xl:border-l @xl:pl-4' : index > 0 ? ` ${ROW[shape].inset}` : ''
  return `${CELL}${alone && index === 0 ? ' @max-xl:col-span-2' : ''}${below}${pair % 2 ? ' @max-xl:pl-4' : ''}${inset}`
}

/** The last cell takes what the numbers leave of a row of three: with five it is the sixth cell. In the row it spans two columns. */
function lastCellClass(count: number, shape: Shape): string {
  const over = count % 3
  const three = over === 2 ? ' @xl:col-span-1 @xl:border-l @xl:pl-4' : over === 1 ? ' @xl:border-l @xl:pl-4' : ' @xl:col-span-3'
  const row = over === 2 ? ` ${ROW[shape].wide}` : over === 0 ? ` ${ROW[shape].wide} ${ROW[shape].inset}` : ''
  return `${LAST}${three}${row} ${ROW[shape].flat}`
}

const LABEL = 'flex items-center text-[13px] leading-5 text-secondary'
const NUMBER = 'text-[19px] font-semibold leading-7 tabular-nums text-heading'
// The result grid: headers in the label's voice, a row's cells level on the figures' baseline. A narrow strip
// closes the columns up and leaves out Queries, whose counts Details holds, so the grid never runs off a phone.
const GAP = 'pr-4 @md:pr-8 last:pr-0'
const HEAD = `pb-0.5 text-left font-normal text-secondary ${GAP}`
const BODY = 'align-baseline'
const FIGURE_CELL = `${BODY} whitespace-nowrap ${GAP}`
const QUERIES = '@max-md:hidden'
const UNMEASURED = 'text-[13px] font-medium leading-7 text-secondary'
// The figure opens its own bubble: a dotted underline under a resting pointer, a ring under keyboard focus, and a
// 44px target under a finger, as a pair of chips has.
const FIGURE = 'cursor-help rounded-sm decoration-mono-500 decoration-dotted underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:min-h-11 max-md:min-h-11'
const LINK = 'inline-flex items-center gap-1 rounded-sm font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:min-h-11 max-md:min-h-11'

/** The running sweep's icon turns, so it does not read as stalled. It holds still where motion is reduced. */
const Turning = forwardRef<SVGSVGElement, LucideProps>(function Turning({ className, ...props }, ref) {
  return <Loader ref={ref} {...props} className={`${className ?? ''} motion-safe:animate-spin`} />
})

/** A sweep from another year keeps its year, so last year's "Oct 7" never reads as this year's. */
function sweepDate(at: string): string {
  const instant = observedInstant(at)
  return observedInstantYear(instant) === new Date().getFullYear() ? formatObservedInstantMonthDay(instant) : formatObservedInstantLabel(instant)
}

function StatCell({ stat, className, numberClassName = NUMBER, onClick }: { stat: Stat; className: string; numberClassName?: string; onClick?: () => void }) {
  return (
    <div className={className}>
      <dt className={LABEL}>{stat.label}{stat.help ? <InfoTooltip text={stat.help} /> : null}</dt>
      <dd className={numberClassName}>
        {onClick ? <button type="button" className={LINK} aria-label={`${whole(stat.value)} not asked`} onClick={onClick}>{whole(stat.value)}</button> : whole(stat.value)}
      </dd>
    </div>
  )
}

/**
 * The number strip above the Tracked table. The project's is the last sweep's
 * result grid (`TrackedResultFigures`) and one line of sweep dates, with every
 * count of its queries behind Details, closed by default. A place's is that
 * grid over the place's own counts. Every number is a field of the results or
 * the workspace read, or the length of a list it returned; nothing is
 * recounted here, so the strip cannot disagree with the server. Branded and
 * non-brand stay separate rows and cells.
 * `lastSweepAt` is `null` when no sweep has finished and left out while that
 * is not known yet. `nextSweepDate` is the schedule's own date ("Oct 21"); a
 * sweep under way (`sweepActive`) takes its place.
 */
export function TrackedSummaryGrid({ summary, place, results, lastSweepAt, compared = false, nextSweepDate, sweepActive = false, onShowNotAsked, onRetry }: {
  summary: QueryTrackingSummary | undefined
  limits?: QueryTrackingLimits
  place?: TrackedSummaryPlace
  /** The last sweep's result for the listed queries. Left out, the strip shows counts only. */
  results?: TrackedResultsState
  lastSweepAt?: string | null
  /** The figures carry each rate's change since the previous sweep, which the counts line names. */
  compared?: boolean
  nextSweepDate?: string
  sweepActive?: boolean
  /** Sets Status to Not asked. */
  onShowNotAsked?: () => void
  /** Reads the workspace again, for a strip whose numbers did not come. */
  onRetry?: () => void
}) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const stats = place ? placeStats(place) : null
  const details = !place && summary ? detailStats(summary) : null
  // Without its numbers the strip is one note over the full row of three.
  const count = stats?.length ?? 3
  const shape = shapeOf(count, place !== undefined)
  const sweep: ReactNode[] = []
  if (lastSweepAt !== undefined) sweep.push(<span key="last">{lastSweepAt ? <>Last sweep <span className="font-medium text-strong">{sweepDate(lastSweepAt)}</span></> : 'Last sweep: none'}</span>)
  // The changes beside the rates are against the sweep before, named by its place and not by a date.
  if (compared && lastSweepAt) sweep.push(<span key="compared">vs previous sweep</span>)
  if (sweepActive) sweep.push(<StatusNote key="next" icon={Turning} label="Sweep running" detail="Answers are being collected now. Numbers update when the sweep finishes." />)
  else if (nextSweepDate) sweep.push(<span key="next">Next {nextSweepDate}</span>)

  const sweepDates = sweep.length > 0 ? (
    <div className={SWEEP_BOX}>
      <p className={SWEEP}>
        {sweep.map((part, index) => <span key={index} className={SWEEP_PART}><span aria-hidden="true" className={SWEEP_DOT}>{index > 0 ? '·' : null}</span>{part}</span>)}
      </p>
    </div>
  ) : null
  const unavailable = <StatusNote
    icon={AlertTriangle}
    tone="caution"
    label="Numbers unavailable"
    detail="These numbers did not load."
    action={onRetry ? <Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-md:min-h-11" onClick={onRetry}>Retry</Button> : undefined}
  />
  // The result leads the strip.
  const figures = results && results.state !== 'none' ? <TrackedResultFigures results={results} /> : null

  // The project's strip is the result grid, then one line: the sweep dates, and Details, which holds every count of queries.
  if (!place) return (
    <div className="@container border-b border-default">
      <div className="min-w-0 space-y-2 py-3">
        {figures}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-1 text-[13px] leading-5 text-secondary">
          {summary ? null : unavailable}
          {sweep.length > 0 ? (
            <p className="flex min-w-0 flex-wrap items-baseline">
              {sweep.map((part, index) => <span key={index} className="flex items-baseline whitespace-nowrap">{index > 0 ? <span aria-hidden="true" className="mx-1.5 text-muted">·</span> : null}{part}</span>)}
            </p>
          ) : null}
          {details ? <button type="button" className={`${LINK} ml-auto text-[13px] leading-5`} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}>
            Details
            <ChevronRight aria-hidden="true" className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
          </button> : null}
        </div>
      </div>
      {details ? <div id={detailsId} hidden={!open} className="border-t border-subtle py-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 @lg:grid-cols-3 @3xl:grid-cols-4">
          {details.map(stat => <StatCell key={stat.label} stat={stat} className="min-w-0" numberClassName="text-[15px] font-medium leading-6 tabular-nums text-heading" onClick={stat.label === 'Not asked' && stat.value > 0 ? onShowNotAsked : undefined} />)}
        </dl>
      </div> : null}
    </div>
  )

  return (
    <div className="@container">
      {figures ? <div className="border-t border-default py-3">{figures}</div> : null}
      <div className={`${STRIP} ${ROW[shape].strip}`} style={stripStyle(count)}>
        {stats ? <dl className="contents">
          {stats.map((stat, index) => <StatCell key={stat.label} stat={stat} className={cellClass(index, count, shape)} />)}
        </dl> : <div className="col-span-2 flex min-h-[4.5rem] min-w-0 items-center py-3 @xl:col-span-3 @xl:pr-4">{unavailable}</div>}
        {sweepDates ? <div className={lastCellClass(count, shape)}>{sweepDates}</div> : null}
      </div>
    </div>
  )
}

/** Loading space for the compact project summary (the default) or a place’s number strip. */
export function TrackedSummaryGridSkeleton({ cells = 5 }: { cells?: number }) {
  const shape = shapeOf(cells, true)
  // The project's: the result grid's three lines, then the sweep dates and Details.
  if (cells === 5) return (
    <div className="@container border-b border-default" aria-hidden="true">
      <div className="space-y-2 py-3">
        <div className="grid w-fit grid-cols-[auto_auto_auto_auto] items-center gap-x-8 gap-y-2">
          {[0, 1, 2].map(row => <div key={row} className="contents"><div className="skeleton-text w-16" /><div className="skeleton-text w-8" /><div className={`skeleton-text w-20 ${row > 0 ? 'h-5' : ''}`} /><div className={`skeleton-text w-20 ${row > 0 ? 'h-5' : ''}`} /></div>)}
        </div>
        <div className="flex items-center justify-between pointer-coarse:min-h-11 max-md:min-h-11"><div className="skeleton-text w-40" /><div className="skeleton-text w-14" /></div>
      </div>
    </div>
  )
  return (
    <div className="@container" aria-hidden="true"><div className={`${STRIP} ${ROW[shape].strip}`} style={stripStyle(cells)}>
      {Array.from({ length: cells }, (_, index) => (
        <div key={index} className={cellClass(index, cells, shape)}>
          <div className="flex h-5 items-center"><div className="skeleton-text w-24 max-w-full" /></div>
          <div className="flex h-7 items-center"><div className="skeleton-text h-4 w-12" /></div>
        </div>
      ))}
      {/* The project's strip ends on links, 44px under a finger; a place's ends on plain text. */}
      <div className={lastCellClass(cells, shape)}><div className={`flex items-center ${cells > 4 ? 'pointer-coarse:min-h-11 max-md:min-h-11' : ''}`}><div className="skeleton-text w-40 max-w-full" /></div></div>
    </div></div>
  )
}
