import { useId, useState, type ReactNode } from 'react'
import { AlertTriangle, Ban, ChevronRight, Loader } from 'lucide-react'
import type { QueryTrackingGroup, QueryTrackingLimits, QueryTrackingMarket, QueryTrackingSummary, QueryTrackingTarget } from '@ainyc/canonry-contracts'

import { formatObservedInstantMonthDay, observedInstant } from '../../../shared/ChartPrimitives.js'
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

/** Subject and type first, then the links. Company, Mixed type and Not set are rare, so each shows only above zero. */
function detailStats(summary: QueryTrackingSummary): Stat[] {
  return cells([
    { label: 'Market', value: summary.byFocus.market },
    { label: 'Location', value: summary.byFocus.property },
    { label: 'Hand-picked', value: summary.byFocus.custom },
    summary.byFocus.company > 0 && { label: 'Company', value: summary.byFocus.company },
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
      counts.customQueries > 0 && { label: 'Hand-picked', value: counts.customQueries },
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

// One row where the strip is 52rem wide or more, hairlines between cells, and no cell narrower than its own
// label and number. In less room the cells pair up over row hairlines. The strip's own width decides, not the
// window's: the sidebar takes its share of a window.
const STRIP = 'grid grid-cols-2 border-y border-default @[52rem]:flex'
const CELL = 'min-w-0 border-subtle py-3 @[52rem]:min-w-max @[52rem]:flex-1 @[52rem]:px-4'
const LAST_CELL = 'col-span-2 flex min-w-0 flex-col justify-center gap-y-1 border-subtle py-3 text-[13px] leading-5 text-secondary @max-[52rem]:border-t @[52rem]:flex-[2] @[52rem]:border-l @[52rem]:pl-4'
/**
 * A cell's hairlines. One row: a line on its left. Pairs: a line above every row but the first, unbroken
 * because the right-hand cell is set in by padding, not a gap; an odd count gives the first cell a row of
 * its own, so no cell sits beside an empty one.
 */
function cellClass(index: number, count: number): string {
  const odd = count % 2 === 1
  const firstRow = index === 0 || (index === 1 && !odd)
  const rightColumn = odd ? index > 0 && index % 2 === 0 : index % 2 === 1
  return `${CELL}${index === 0 ? ' @[52rem]:pl-0' : ' @[52rem]:border-l'}${firstRow ? '' : ' @max-[52rem]:border-t'}${rightColumn ? ' @max-[52rem]:pl-4' : ''}${index === 0 && odd ? ' @max-[52rem]:col-span-2' : ''}`
}
const LABEL = 'flex items-center text-[13px] leading-5 text-secondary'
const NUMBER = 'text-[19px] font-semibold leading-7 tabular-nums text-heading'
const LINK = 'inline-flex items-center gap-1 rounded-sm font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:min-h-11 max-md:min-h-11'

function StatCell({ stat, className, numberClassName = NUMBER }: { stat: Stat; className: string; numberClassName?: string }) {
  return (
    <div className={className}>
      <dt className={LABEL}>{stat.label}{stat.help ? <InfoTooltip text={stat.help} /> : null}</dt>
      <dd className={numberClassName}>
        {/* The limit is spent: the note stands where the number was, on the number's own line. */}
        {stat.of !== undefined && stat.value === 0
          ? <span className="flex min-h-7 items-center"><StatusNote icon={Ban} tone="negative" label="Limit reached" detail={`The limit is ${whole(stat.of)} queries. Stop tracking one to add another.`} /></span>
          : <>{whole(stat.value)}{stat.of !== undefined ? <span className="text-[13px] font-normal text-secondary"> of {whole(stat.of)}</span> : null}</>}
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
  const sweep: ReactNode[] = []
  if (lastSweepAt !== undefined) sweep.push(<span key="last" className="whitespace-nowrap">{lastSweepAt ? `Last sweep ${formatObservedInstantMonthDay(observedInstant(lastSweepAt))}` : 'Last sweep: none'}</span>)
  if (sweepActive) sweep.push(<StatusNote key="next" icon={Loader} label="Sweep running" detail="Answers are being collected now. Numbers update when the sweep finishes." />)
  else if (nextSweepDate) sweep.push(<span key="next" className="whitespace-nowrap">Next {nextSweepDate}</span>)

  return (
    <div className="@container">
      <div className={STRIP}>
        {stats ? (
          <dl className="contents">
            {stats.map((stat, index) => <StatCell key={stat.label} stat={stat} className={cellClass(index, stats.length)} />)}
          </dl>
        ) : (
          <div className="col-span-2 flex min-h-[4.5rem] min-w-0 items-center py-3 @[52rem]:flex-[5] @[52rem]:pr-4">
            <StatusNote
              icon={AlertTriangle}
              tone="caution"
              label="Numbers unavailable"
              detail="The server sent no numbers for this view."
              action={onRetry ? <Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-md:min-h-11" onClick={onRetry}>Retry</Button> : undefined}
            />
          </div>
        )}
        {details || sweep.length > 0 ? (
          <div className={LAST_CELL}>
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
              <p className="flex flex-wrap items-center gap-x-1.5">
                {sweep.flatMap((part, index) => index === 0 ? [part] : [<span key={`dot-${index}`} aria-hidden="true">·</span>, part])}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {details ? (
        <div id={detailsId} hidden={!open}>
          {/* Three columns in a narrow strip. In a wider one each number takes its own width, so the rare ones fit the same row. */}
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3 border-b border-default py-3 @lg:flex @lg:flex-wrap @lg:gap-x-8">
            {details.map(stat => <StatCell key={stat.label} stat={stat} className="min-w-0" numberClassName="text-[15px] font-semibold leading-6 tabular-nums text-heading" />)}
          </dl>
        </div>
      ) : null}
    </div>
  )
}

/** The strip while the workspace loads: the same row and height, so nothing jumps when the numbers land. */
export function TrackedSummaryGridSkeleton({ cells = 5 }: { cells?: number }) {
  return (
    <div className="@container" aria-hidden="true"><div className={STRIP}>
      {Array.from({ length: cells }, (_, index) => (
        <div key={index} className={cellClass(index, cells)}>
          <div className="flex h-5 items-center"><div className="skeleton-text w-24 max-w-full" /></div>
          <div className="flex h-7 items-center"><div className="skeleton-text h-4 w-12" /></div>
        </div>
      ))}
      <div className={LAST_CELL}><div className="skeleton-text w-40 max-w-full" /></div>
    </div></div>
  )
}
