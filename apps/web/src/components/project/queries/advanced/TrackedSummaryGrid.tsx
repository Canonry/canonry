import { forwardRef, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, Ban, ChevronRight, Loader, type LucideProps } from 'lucide-react'
import type { QueryTrackingGroup, QueryTrackingLimits, QueryTrackingMarket, QueryTrackingSummary, QueryTrackingTarget } from '@ainyc/canonry-contracts'

import { formatObservedInstantLabel, formatObservedInstantMonthDay, observedInstant, observedInstantYear } from '../../../shared/ChartPrimitives.js'
import { InfoTooltip } from '../../../shared/InfoTooltip.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'

/** The place the Tracked page is narrowed to: its entry as the workspace read returned it, server counts and all. */
export type TrackedSummaryPlace =
  | { kind: 'market'; market: QueryTrackingMarket }
  | { kind: 'location'; target: QueryTrackingTarget }
  | { kind: 'group'; group: QueryTrackingGroup }

interface Stat { label: string; value: number; of?: number; help?: string }

const whole = (value: number) => value.toLocaleString('en-US')
/** The cells that have a number to print, in order. */
const cells = (stats: readonly (Stat | false | undefined)[]): Stat[] => stats.filter((stat): stat is Stat => Boolean(stat))

const HELP = {
  answers: 'Answers one sweep collects: each query on every engine and search location it is asked on.',
  placeAnswers: 'Answers one sweep collects for this place. Places share answers, so they do not add up to the project total.',
  locationAnswers: 'Answers per sweep that count for this location, its market queries included. Locations share answers, so they do not add up to the project total.',
  links: 'One link for each query, location and search location it is asked for.',
}

/** A list the server returned gives its length; one it left out gives no cell. Nothing is counted in its place. */
const listed = (label: string, list: readonly unknown[] | undefined): Stat | false => list !== undefined && { label, value: list.length }

function projectStats(summary: QueryTrackingSummary, limits: QueryTrackingLimits | undefined): Stat[] {
  const queries = limits?.queries
  return cells([
    { label: 'Queries asked', value: summary.asked },
    { label: 'Non-brand', value: summary.byClass.nonBrand },
    { label: 'Branded', value: summary.byClass.branded },
    { label: 'Answers per sweep', value: summary.answersPerSweep, help: HELP.answers },
    queries?.left && { label: 'Left under limit', value: queries.left.current, of: queries.max },
  ])
}

/**
 * Subject and type first, then the links. Company, Mixed type and Not set are rare, so each shows only above
 * zero. A Subject's count is named as queries, as a place's strip names it, so it never reads as a count of
 * markets or locations.
 */
function detailStats(summary: QueryTrackingSummary): Stat[] {
  return cells([
    { label: 'Market queries', value: summary.byFocus.market },
    { label: 'Location queries', value: summary.byFocus.property },
    { label: 'Hand-picked queries', value: summary.byFocus.custom },
    summary.byFocus.company > 0 && { label: 'Company queries', value: summary.byFocus.company },
    summary.byClass.mixed > 0 && { label: 'Mixed type', value: summary.byClass.mixed },
    summary.byClass.unknown > 0 && { label: 'Not set', value: summary.byClass.unknown },
    { label: 'Not asked', value: summary.notAsked },
    { label: 'Location links', value: summary.assignments.total, help: HELP.links },
    { label: 'Non-brand links', value: summary.assignments.nonBrand },
    { label: 'Branded links', value: summary.assignments.branded },
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
      { label: 'Answers counted', value: counts.answersPerSweep, help: HELP.locationAnswers },
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
// Details stands on the strip's own columns, so each number is under one of the strip's: two and three columns
// as the strip has them, and from 62rem the columns of the row. From there each number's cell keeps room for the
// labels that open under it, unseen and as generated text, so opening Details moves no column. A row narrower
// than that cannot hold every label on its own columns, so there Details is four columns of its own.
const DETAILS = 'col-span-full grid grid-cols-subgrid border-t border-subtle @[52rem]:@max-[62rem]:grid-cols-4'
const DETAIL_CELL = 'min-w-0 border-subtle py-3 @xl:pr-4'
const RESERVE = 'invisible hidden h-0 whitespace-nowrap text-[13px] font-normal before:content-[attr(data-reserve)] @[62rem]:block'

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

/** A Details cell is set in from every column but the first, behind a hairline wherever the strip draws one. */
function detailCellClass(index: number, columns: number): string {
  return `${DETAIL_CELL}${index % 2 ? ' @max-xl:pl-4' : ''}${index % 3 ? ' @xl:@max-[52rem]:border-l @xl:@max-[52rem]:pl-4' : ''}${index % 4 ? ' @[52rem]:@max-[62rem]:border-l @[52rem]:@max-[62rem]:pl-4' : ''}${index % columns ? ' @[62rem]:border-l @[62rem]:pl-4' : ''}`
}

const LABEL = 'flex items-center text-[13px] leading-5 text-secondary'
const NUMBER = 'text-[19px] font-semibold leading-7 tabular-nums text-heading'
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

function StatCell({ stat, className, numberClassName = NUMBER, reserve }: { stat: Stat; className: string; numberClassName?: string; reserve?: readonly Stat[] }) {
  return (
    <div className={className}>
      <dt className={LABEL}>{stat.label}{stat.help ? <InfoTooltip text={stat.help} /> : null}</dt>
      <dd className={numberClassName}>
        {/* The limit is spent: the note stands where the number was, on the number's own line. */}
        {stat.of !== undefined && stat.value === 0
          ? <span className="flex min-h-7 items-center"><StatusNote icon={Ban} tone="negative" label="Limit reached" detail={`The limit is ${whole(stat.of)} queries. Stop tracking one to add another.`} /></span>
          : <>{whole(stat.value)}{stat.of !== undefined ? <span className="text-[13px] font-normal text-secondary"> of {whole(stat.of)}</span> : null}</>}
        {/* Room for each label that opens under this number, and for its help icon. */}
        {reserve?.map(below => <span key={below.label} aria-hidden="true" data-reserve={below.label} className={`${RESERVE}${below.help ? ' pr-5' : ''}`} />)}
      </dd>
    </div>
  )
}

/**
 * The number strip above the Tracked table: the project's totals, or one
 * place's. Every number is a field of the workspace read, or the length of a
 * list it returned; nothing is recounted here, so the strip cannot disagree
 * with the server. Branded and non-brand stay separate cells. The project
 * strip keeps its rarer numbers behind Details, closed by default.
 * `lastSweepAt` is `null` when no sweep has finished and left out while that
 * is not known yet. `nextSweepDate` is the schedule's own date ("Oct 21"); a
 * sweep under way (`sweepActive`) takes its place.
 */
export function TrackedSummaryGrid({ summary, limits, place, lastSweepAt, nextSweepDate, sweepActive = false, onShowNotAsked, onRetry }: {
  summary: QueryTrackingSummary | undefined
  limits?: QueryTrackingLimits
  place?: TrackedSummaryPlace
  lastSweepAt?: string | null
  nextSweepDate?: string
  sweepActive?: boolean
  /** Sets Status to Not asked. */
  onShowNotAsked?: () => void
  /** Reads the workspace again, for a strip whose numbers did not come. */
  onRetry?: () => void
}) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const stats = place ? placeStats(place) : summary ? projectStats(summary, limits) : null
  const details = !place && summary ? detailStats(summary) : null
  const notAsked = !place && summary ? summary.notAsked : 0
  // Without its numbers the strip is one note over the full row of three.
  const count = stats?.length ?? 3
  const shape = shapeOf(count, place !== undefined)
  const sweep: ReactNode[] = []
  if (lastSweepAt !== undefined) sweep.push(<span key="last">{lastSweepAt ? `Last sweep ${sweepDate(lastSweepAt)}` : 'Last sweep: none'}</span>)
  if (sweepActive) sweep.push(<StatusNote key="next" icon={Turning} label="Sweep running" detail="Answers are being collected now. Numbers update when the sweep finishes." />)
  else if (nextSweepDate) sweep.push(<span key="next">Next {nextSweepDate}</span>)

  return (
    <div className="@container">
      <div className={`${STRIP} ${ROW[shape].strip}`} style={stripStyle(count)}>
        {stats ? (
          <dl className="contents">
            {stats.map((stat, index) => <StatCell key={stat.label} stat={stat} className={cellClass(index, count, shape)} reserve={details?.filter((_, below) => below % (count + 2) === index)} />)}
          </dl>
        ) : (
          <div className="col-span-2 flex min-h-[4.5rem] min-w-0 items-center py-3 @xl:col-span-3 @xl:pr-4">
            <StatusNote
              icon={AlertTriangle}
              tone="caution"
              label="Numbers unavailable"
              detail="These numbers did not load."
              action={onRetry ? <Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-md:min-h-11" onClick={onRetry}>Retry</Button> : undefined}
            />
          </div>
        )}
        {details || sweep.length > 0 ? (
          <div className={lastCellClass(count, shape)}>
            {details ? (
              <div className="flex flex-wrap items-center gap-x-3">
                <button type="button" className={LINK} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}>
                  Details
                  <ChevronRight aria-hidden="true" className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
                </button>
                {notAsked > 0 ? (onShowNotAsked
                  ? <button type="button" className={`${LINK} tabular-nums`} onClick={onShowNotAsked}>{whole(notAsked)} not asked</button>
                  : <span className="tabular-nums">{whole(notAsked)} not asked</span>) : null}
              </div>
            ) : null}
            {sweep.length > 0 ? (
              <div className={SWEEP_BOX}>
                <p className={SWEEP}>
                  {sweep.map((part, index) => <span key={index} className={SWEEP_PART}><span aria-hidden="true" className={SWEEP_DOT}>{index > 0 ? '·' : null}</span>{part}</span>)}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        {details ? (
          <div id={detailsId} hidden={!open} className={DETAILS}>
            <dl className="contents">
              {details.map((stat, index) => <StatCell key={stat.label} stat={stat} className={detailCellClass(index, count + 2)} numberClassName="text-[15px] font-semibold leading-6 tabular-nums text-heading" />)}
            </dl>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The strip while the workspace loads: the same cells at the same height, so nothing jumps when the numbers land. A place has four numbers, the project five. */
export function TrackedSummaryGridSkeleton({ cells = 5 }: { cells?: number }) {
  const shape = shapeOf(cells, true)
  return (
    <div className="@container" aria-hidden="true"><div className={`${STRIP} ${ROW[shape].strip}`} style={stripStyle(cells)}>
      {Array.from({ length: cells }, (_, index) => (
        <div key={index} className={cellClass(index, cells, shape)}>
          <div className="flex h-5 items-center"><div className="skeleton-text w-24 max-w-full" /></div>
          <div className="flex h-7 items-center"><div className="skeleton-text h-4 w-12" /></div>
        </div>
      ))}
      <div className={lastCellClass(cells, shape)}><div className="skeleton-text w-40 max-w-full" /></div>
    </div></div>
  )
}
