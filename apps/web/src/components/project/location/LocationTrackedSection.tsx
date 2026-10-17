import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Clock, Info } from 'lucide-react'
import type { QueryTrackingWorkspaceResponse } from '@canonry/canonry-contracts'
import { getApiV1ProjectsByNameQueryTrackingOptions } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import { formatSweepDay } from '../../../lib/format-helpers.js'
import { providerDisplayName } from '../../../lib/visibility-trend-helpers.js'
import { carryVisibilitySearch, patchVisibilitySelection } from '../../../lib/measurement-view-url.js'
import { addToast } from '../../../lib/toast-store.js'
import { formatObservedInstantMonthDay, observedInstant } from '../../shared/ChartPrimitives.js'
import { InfoTooltip, useTooltipBubble } from '../../shared/InfoTooltip.js'
import { SignalLegend, SignalPair } from '../../shared/SignalCells.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { Button } from '../../ui/button.js'
import { MARKET_SCOPE_COPY } from '../VisibilityScopePicker.js'
import { VISIBILITY_TOOLBAR_COPY } from '../VisibilityTrendSection.js'
import { TrackedActionSheet, type TrackedSheetAction } from '../queries/advanced/TrackedActionSheet.js'
import { TrackedRowMenu } from '../queries/advanced/TrackedRowMenu.js'
import { TrackedTable } from '../queries/advanced/TrackedTable.js'
import type { TrackedPlace } from '../queries/advanced/tracked-actions.js'
import type { TrackedRowAction, TrackedRowVm, TrackedType } from '../queries/advanced/tracked-types.js'
import { NOT_ASKED, rowSignal, locationCountLabel, resultClasses, sortTrackedRows, toTrackedRows, trackedEngineColumnWidth, typeLabel, type TrackedColumn, type TrackedCoverage } from '../queries/advanced/tracked-view-model.js'
import { contextInput, contextLabel, searchLocationNames, uniqueContextInputs } from '../queries/tracking-contexts.js'
import { useTrackedResults } from '../queries/use-tracked-results.js'

type Workspace = QueryTrackingWorkspaceResponse

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
const LINK = `inline-flex items-center rounded-sm font-medium text-link hover:underline ${FOCUS} ${TOUCH}`
/** The market queries listed before any "+ N more", shared out between the markets. */
const MARKET_ROWS = 8
/** A market lists at least this many of its queries, however many markets share the eight. */
const MARKET_MIN = 2
/** The rows a table of queries lists at first, and the most one press of "+ N more" brings to any list. */
const PAGE = 50
/** A list behind a count names this many, then counts the rest. */
const NAMED = 25
/**
 * The columns that fit beside the side panel. Status carries each row's date
 * ("Measured Oct 7"), and the open row lists Last measured and Source.
 */
const COLUMNS: readonly TrackedColumn[] = ['query', 'type', 'engines', 'status', 'menu']
/** Pattern names are a read of their own, which this page does not make: a pattern row's detail says Pattern. */
const NO_TEMPLATES: readonly never[] = []
const COPY = {
  loadFailed: 'Tracked queries did not load.',
  notFound: 'This location was not found in tracked queries.',
  refreshFailed: 'The latest tracked queries did not load. These are the last ones read.',
  resultsUnavailable: "The last sweep's results did not load, so every chip reads Not checked.",
  // The Tracked strip's own words for this number, when the page is narrowed to one location.
  answersPerSweep: 'Answers one sweep collects for this location, its market queries included. Locations share answers, so they do not add up to the project total.',
  // While the last sweep ran before the tracking changed, the number is the tracking's and the rates beside it are that sweep's.
  answersNextSweep: 'Answers the next sweep collects for this location, its market queries included. The rates on this page are from the last sweep, before tracking changed.',
  noLocationQueries: 'No tracked query has this location as its Subject.',
  inNoMarket: 'This location is in no market, so no market query counts for it.',
}

const whole = (value: number) => value.toLocaleString('en-US')

/** The Queries tab's own read and key, so a visit from there makes no new request. */
const workspaceOptions = (projectName: string) => getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } })

/** Queries narrowed to one market, as Settings links to it. */
const marketSearch = (marketKey: string) => (previous: Record<string, unknown>) =>
  patchVisibilitySelection(carryVisibilitySearch(previous), { measurementScope: 'market', measurementScopeKey: marketKey, queryWorkspace: 'tracked', trackingQueryId: undefined })

const PLACES_LINE = '-ml-4 flex min-w-0 flex-wrap items-center [clip-path:inset(-0.75rem_-0.25rem_-0.75rem_0.8125rem)]'
// Where a finger is the pointer a link is a 44px target on a 28px line: it reaches over the lines above and below it.
const PLACE_LINK = `${LINK} min-w-0 break-words pointer-coarse:-my-2 max-md:-my-2`

/**
 * The header line under a location's name: its markets, each a link to
 * Queries narrowed to that market, and its groups. Both are the workspace
 * read's own lists. Names hold commas, so a dot parts two of them. Nothing is
 * drawn for a read that failed: the tracked section below says so.
 */
export function LocationPlaces({ projectName, targetKey }: { projectName: string; targetKey: string }) {
  const { data: workspace, isPending } = useQuery(workspaceOptions(projectName))
  if (!workspace) return isPending ? <span aria-hidden="true" className="skeleton-text w-56 max-w-full" /> : null
  const marketNames = new Map(workspace.markets.map(market => [market.stableKey, market.label]))
  const marketKeys = workspace.targets.find(target => target.stableKey === targetKey)?.marketKeys ?? []
  // A market keeps its name. The group that holds a market of the same name reads "Locations in {name}", as the Place picker calls it.
  const groups = workspace.groups.filter(group => group.targetKeys.includes(targetKey)).map(group => (
    workspace.markets.some(market => market.groupKey === group.stableKey && market.label === group.label) ? MARKET_SCOPE_COPY.locationsIn(group.label) : group.label
  ))
  if (marketKeys.length === 0 && groups.length === 0) return null
  return (
    <dl className="contents">
      {marketKeys.length > 0 ? (
        // Each link is an item of the line its label starts, so a long list wraps after the label, not under it.
        // A link carries the dot before it in a gutter that hangs out on the left, where it is cut off: a dot shows
        // between two markets on a line, never at the end or the start of one. The cut leaves a link's focus ring whole.
        <div className={PLACES_LINE}>
          <dt className="-mr-2.5 pl-4">{marketKeys.length === 1 ? 'Market:' : 'Markets:'}</dt>
          <dd className="contents">
            {marketKeys.map((key, index) => (
              <span key={key} className="flex min-w-0 items-center">
                <span aria-hidden="true" className="w-4 shrink-0 text-center">{index > 0 ? '·' : null}</span>
                <Link to="/projects/$projectName/queries" params={{ projectName }} search={marketSearch(key)} className={PLACE_LINK}>{marketNames.get(key) ?? key}</Link>
              </span>
            ))}
          </dd>
        </div>
      ) : null}
      {groups.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-1.5 pointer-coarse:min-h-7 max-md:min-h-7">
          <dt>{groups.length === 1 ? 'Group:' : 'Groups:'}</dt>
          <dd className="text-strong">{groups.join(' · ')}</dd>
        </div>
      ) : null}
    </dl>
  )
}

/**
 * What one location is tracked for: its numbers, the queries about it, the
 * queries of its markets and any hand-picked ones, both types together with a
 * Type column.
 *
 * It makes two reads. The workspace is the Queries tab's read, under its key.
 * The results are the last sweep's Mentioned and Cited for this location
 * (`scope=property`). Every number printed is a field of this location's
 * `targets[]` entry, or the length of a list the workspace returned; rows are
 * only listed and sorted. A query added since the last sweep has no result,
 * so its chips read Not checked.
 *
 * A writer's row menu opens `TrackedActionSheet` with this location as the
 * place, so a stop, an edit or a type change starts on this location only. A
 * viewer gets no menu and no sheet; a row's detail opens for everyone.
 */
export function LocationTrackedSection({ projectName, targetKey, canWrite, trackingChangedAt }: {
  projectName: string
  targetKey: string
  canWrite: boolean
  /**
   * When the published setup last changed, for the "Tracking changed" note
   * beside the legend. Left out, the note has no date. `null` leaves the note
   * out, for a page that says so itself.
   */
  trackingChangedAt?: string | null
}) {
  const workspaceQuery = useQuery(workspaceOptions(projectName))
  const results = useTrackedResults(projectName, { measurementScope: 'property', measurementScopeKey: targetKey })
  const workspace = workspaceQuery.data
  const target = workspace?.targets.find(candidate => candidate.stableKey === targetKey)
  const retry = () => { void workspaceQuery.refetch() }

  if (!workspace && workspaceQuery.isPending) {
    // The two lists every location has, at the sizes they usually are, so the results below hardly move when the read lands.
    return (
      <div className="min-w-0 space-y-6">
        <div aria-hidden="true" className="@container">
          <div className={NUMBERS}>
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className={numberCell(index)}>
                <div className="flex h-5 items-center"><div className="skeleton-text w-24 max-w-full" /></div>
                <div className="flex h-7 items-center"><div className="skeleton-text h-4 w-12" /></div>
              </div>
            ))}
          </div>
        </div>
        <Block title="Queries about this location" count={undefined}><SkeletonRows rows={2} label="Loading queries" tall /></Block>
        <Block title="From its markets" count={undefined}><SkeletonRows rows={8} /></Block>
      </div>
    )
  }
  if (!workspace || !target) {
    // A read that left nothing to show, or one the published setup is ahead of: it does not hold this location
    // yet, and a later read can.
    return (
      <div role="alert" className="min-w-0 py-2">
        <StatusNote
          icon={AlertTriangle}
          tone="negative"
          label={workspace ? 'Location not found' : 'Could not load'}
          detail={workspace ? COPY.notFound : COPY.loadFailed}
          action={<Button type="button" variant="outline" size="sm" className={TOUCH} aria-label="Retry tracked queries" onClick={retry}>Retry</Button>}
        />
      </div>
    )
  }
  return (
    <TrackedFor
      projectName={projectName}
      workspace={workspace}
      target={target}
      results={results}
      canWrite={canWrite}
      trackingChangedAt={trackingChangedAt}
      refreshFailed={workspaceQuery.isRefetchError}
      onRetry={retry}
    />
  )
}

function TrackedFor({ projectName, workspace, target, results, canWrite, trackingChangedAt, refreshFailed, onRetry }: {
  projectName: string
  workspace: Workspace
  target: Workspace['targets'][number]
  results: ReturnType<typeof useTrackedResults>
  canWrite: boolean
  trackingChangedAt?: string | null
  refreshFailed: boolean
  onRetry: () => void
}) {
  const router = useRouter()
  const ownHeading = useRef<HTMLHeadingElement>(null)
  const pickedHeading = useRef<HTMLHeadingElement>(null)
  const targetKey = target.stableKey
  const [sheet, setSheet] = useState<{ action: TrackedSheetAction; row: TrackedRowVm } | null>(null)

  const engines = useMemo(() => [...new Set([...workspace.defaultContexts.flatMap(context => context.providers), ...results.engines])], [workspace.defaultContexts, results.engines])
  const rowContextLabels = useMemo(() => searchLocationNames(workspace), [workspace])
  // The queries asked for this location, each under the types it is asked under here, as the results for the
  // location hold them. `whole` keeps the row as the project has it: a sheet changes the query, not this reading of it.
  const listed = useMemo(() => {
    const wholeRows = new Map<string, TrackedRowVm>()
    const here: TrackedRowVm[] = []
    for (const row of toTrackedRows(workspace, NO_TEMPLATES)) {
      const links = row.tracked.assignments.filter(assignment => assignment.targetKey === targetKey)
      if (links.length === 0) continue
      wholeRows.set(row.queryId, row)
      const queryClasses = [...new Set(links.flatMap(link => link.classifiedContexts?.map(context => context.queryClass) ?? link.queryClass ?? []))].sort()
      const type: TrackedType = queryClasses.length === 0 ? 'not-set' : queryClasses.length === 1 ? queryClasses[0]! : 'mixed'
      here.push({ ...row, queryClasses, type, displayAssignments: links })
    }
    const sorted = sortTrackedRows(here)
    return {
      whole: wholeRows,
      location: sorted.filter(row => row.subject.kind === 'location'),
      market: sorted.filter(row => row.subject.kind === 'market'),
      picked: sorted.filter(row => row.subject.kind === 'hand-picked'),
    }
  }, [workspace, targetKey])
  const marketGroups = useMemo(() => {
    const names = new Map(workspace.targets.map(candidate => [candidate.stableKey, candidate.label]))
    const markets = new Map(workspace.markets.map(market => [market.stableKey, market]))
    const groups = new Map<string, MarketGroup>()
    for (const row of listed.market) {
      const key = row.subject.kind === 'market' ? row.subject.key : ''
      const market = markets.get(key)
      const group = groups.get(key) ?? {
        key,
        label: market?.label ?? key,
        // The server's member list, less this location. A list it did not send prints nothing.
        others: market?.targetKeys?.filter(member => member !== targetKey).map(member => names.get(member) ?? member),
        rows: [],
      }
      group.rows.push(row)
      groups.set(key, group)
    }
    return [...groups.values()]
  }, [listed.market, workspace.targets, workspace.markets, targetKey])

  // A sheet hands the focus back to the menu that opened it. A publish that takes the row off this page (a stop,
  // a move, a new Subject, new wording) takes that menu with it, on the read that follows the publish, and would
  // leave the focus on nothing. The heading of the row's list takes it then.
  const published = useRef<{ row: TrackedRowVm; lists: typeof listed } | null>(null)
  const sheetOpen = sheet !== null
  useEffect(() => {
    const last = published.current
    // Not before the sheet has closed and the read after its publish has landed.
    if (!last || sheetOpen || last.lists === listed) return
    published.current = null
    if (listed.whole.has(last.row.queryId)) return
    const heading = (last.row.subject.kind === 'hand-picked' ? pickedHeading.current : null) ?? ownHeading.current
    // After the sheet's own hand-back, which waits a tick. Never cancelled: the lists can be read again within it.
    setTimeout(() => { if (heading?.isConnected && document.activeElement === document.body) heading.focus({ preventScroll: true }) })
  }, [sheetOpen, listed])

  /** The row's link opens Queries on this location, where the row is marked. */
  async function copyLink(row: TrackedRowVm) {
    const { publicHref } = router.buildLocation({
      to: '/projects/$projectName/queries',
      params: { projectName },
      search: previous => patchVisibilitySelection(carryVisibilitySearch(previous), { measurementScope: 'property', measurementScopeKey: targetKey, queryWorkspace: 'tracked', trackingQueryId: row.queryId }),
    })
    try {
      await navigator.clipboard.writeText(new URL(router.history.createHref(publicHref), window.location.origin).toString())
      addToast({ title: 'Link copied', tone: 'positive', dedupeKey: 'tracked-query:copy-link', dedupeMode: 'replace' })
    } catch {
      addToast({ title: 'Could not copy', tone: 'negative', dedupeKey: 'tracked-query:copy-link', dedupeMode: 'replace' })
    }
  }

  function act(action: TrackedRowAction, row: TrackedRowVm) {
    if (action === 'copy-link') void copyLink(row)
    // Track is for a query asked nowhere, and every query listed here is asked for this location.
    else if (action !== 'track') setSheet({ action, row: listed.whole.get(row.queryId) ?? row })
  }

  const place: TrackedPlace = { kind: 'location', key: targetKey, label: target.label }
  const renderRowMenu = canWrite ? (row: TrackedRowVm) => <TrackedRowMenu row={row} workspace={workspace} onAction={act} /> : undefined
  const { run } = results
  const counts = target.counts
  const legend = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 md:justify-end">
      {results.isError ? (
        <div role="status">
          <StatusNote
            icon={AlertTriangle}
            tone="caution"
            label="Results unavailable"
            detail={COPY.resultsUnavailable}
            // Set into the legend's line with a mouse, so a failed read does not move the table.
            action={<Button type="button" variant="outline" size="sm" className={`-my-1.5 pointer-coarse:my-0 max-md:my-0 ${TOUCH}`} aria-label="Retry results" onClick={() => { void results.refetch() }}>Retry</Button>}
          />
        </div>
      ) : null}
      {/* The chips are the last sweep's: a query changed since has none until the next one. */}
      {run && !run.matchesCurrentTracking && trackingChangedAt !== null ? (
        <StatusNote
          icon={Clock}
          tone="caution"
          label={VISIBILITY_TOOLBAR_COPY.trackingChangedLabel(trackingChangedAt ? formatObservedInstantMonthDay(observedInstant(trackingChangedAt)) : null)}
          detail={VISIBILITY_TOOLBAR_COPY.trackingChangedDetail(formatObservedInstantMonthDay(observedInstant(run.completedAt ?? run.createdAt)), null)}
        />
      ) : null}
      <SignalLegend />
    </div>
  )
  // The legend goes with the first list that draws chips.
  const legendAt = listed.location.length > 0 ? 'location' : marketGroups.length > 0 ? 'market' : 'picked'
  const table = (rows: readonly TrackedRowVm[], label: string) => (
    <TrackedTable rows={rows} engines={engines} coverage={results.coverage} renderRowMenu={renderRowMenu} workspace={workspace} contextLabels={rowContextLabels} columns={COLUMNS} label={label} />
  )

  return (
    <div className="min-w-0 space-y-6">
      {refreshFailed ? (
        <div role="status">
          <StatusNote
            icon={AlertTriangle}
            tone="caution"
            label="Refresh failed"
            detail={COPY.refreshFailed}
            action={<Button type="button" variant="outline" size="sm" className={TOUCH} aria-label="Retry tracked queries" onClick={onRetry}>Retry</Button>}
          />
        </div>
      ) : null}
      {/* The workspace's number is the tracking's as it is now. A last sweep that ran before a change did not collect it. */}
      <Numbers target={target} nextSweep={run != null && !run.matchesCurrentTracking} />

      <Block title="Queries about this location" count={counts?.propertyQueries} aside={legendAt === 'location' ? legend : undefined} headingRef={ownHeading}>
        {listed.location.length > 0
          ? <FirstRows rows={listed.location} of="location queries">{rows => table(rows, 'Location queries')}</FirstRows>
          // A flag, so only where it is true: the server counts none and none is listed.
          : (counts?.propertyQueries ?? 0) === 0 ? <StatusNote icon={AlertTriangle} tone="caution" label="No location queries" detail={COPY.noLocationQueries} /> : null}
      </Block>

      <Block title="From its markets" count={counts?.marketQueries} aside={legendAt === 'market' ? legend : undefined}>
        {marketGroups.length > 0
          ? <MarketQueries projectName={projectName} targetLabel={target.label} groups={marketGroups} engines={engines} coverage={results.coverage} />
          : target.marketKeys?.length === 0
            ? <StatusNote icon={AlertTriangle} tone="caution" label="In no market" detail={COPY.inNoMarket} />
            : <StatusNote icon={Info} label="No market queries" />}
      </Block>

      {listed.picked.length > 0 ? (
        <Block title="Hand-picked" count={counts?.customQueries} aside={legendAt === 'picked' ? legend : undefined} headingRef={pickedHeading}>
          <FirstRows rows={listed.picked} of="hand-picked queries">{rows => table(rows, 'Hand-picked queries')}</FirstRows>
        </Block>
      ) : null}

      {sheet ? (
        <TrackedActionSheet
          projectName={projectName}
          workspace={workspace}
          action={sheet.action}
          rows={[sheet.row]}
          place={place}
          contextChoices={uniqueContextInputs(workspace.defaultContexts.map(contextInput)).map(input => ({ label: contextLabel(input), input }))}
          // This page reads no runs: the server refuses a publish during a sweep, and the sheet shows why.
          sweepActive={false}
          onPublished={() => { published.current = { row: sheet.row, lists: listed } }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  )
}

// Pairs of cells on a phone, one row from a frame of 36rem, with a hairline between rows and between cells.
const NUMBERS = 'grid grid-cols-2 border-y border-default @xl:grid-cols-4'
const numberCell = (index: number) => `min-w-0 border-subtle py-3 pr-4${index >= 2 ? ' @max-xl:border-t' : ''}${index % 2 ? ' @max-xl:pl-4' : ''}${index > 0 ? ' @xl:border-l @xl:pl-4' : ''}`

/**
 * The location's four numbers, in the Tracked strip's words for a location.
 * Each is a field of its `targets[]` entry, or the length of its market list.
 * One the server left out has no cell: nothing is counted in its place.
 */
function Numbers({ target, nextSweep }: { target: Workspace['targets'][number]; nextSweep: boolean }) {
  const { counts, marketKeys } = target
  const stats: { label: string; value: number; help?: string }[] = [
    ...(counts ? [{ label: 'Location queries', value: counts.propertyQueries }, { label: 'Market queries', value: counts.marketQueries }] : []),
    ...(marketKeys ? [{ label: 'Markets', value: marketKeys.length }] : []),
    ...(counts ? [nextSweep
      ? { label: 'Answers next sweep', value: counts.answersPerSweep, help: COPY.answersNextSweep }
      : { label: 'Answers per sweep', value: counts.answersPerSweep, help: COPY.answersPerSweep }] : []),
  ]
  if (stats.length === 0) return null
  return (
    <div className="@container">
      <dl className={NUMBERS}>
        {stats.map((stat, index) => (
          <div key={stat.label} className={numberCell(index)}>
            {/* The help opens below, which keeps its bubble inside a phone's screen. */}
            <dt className="flex items-center text-[13px] leading-5 text-secondary">{stat.label}{stat.help ? <InfoTooltip placement="bottom" text={stat.help} /> : null}</dt>
            <dd className="text-[19px] font-semibold leading-7 tabular-nums text-heading">{whole(stat.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * One list of the section: a heading of a few words, the server's count beside
 * it, and its rows. The heading can be handed the focus, by the page and never
 * by Tab, when the row that held it leaves.
 */
function Block({ title, count, aside, headingRef, children }: { title: string; count: number | undefined; aside?: ReactNode; headingRef?: Ref<HTMLHeadingElement>; children: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {/* The count is a sibling of the heading, so it stays out of the section's name. */}
        <div className="flex items-baseline gap-2">
          <h2 id={headingId} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className={`rounded-sm text-base font-semibold text-heading ${FOCUS}`}>{title}</h2>
          {count === undefined ? null : <span className="text-sm tabular-nums text-secondary">{whole(count)}<span className="sr-only"> queries</span></span>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/**
 * Rows standing in for a list while the workspace loads, under the room its
 * header takes: a query, its type and its status, which fit a frame of any
 * width. `tall` rows are a query on two lines.
 */
function SkeletonRows({ rows, label, tall = false }: { rows: number; label?: string; tall?: boolean }) {
  return (
    <div role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <div className="h-[38px] border-b border-default" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className={`flex items-center gap-6 border-b border-subtle px-2.5 ${tall ? 'h-[57px]' : 'h-[37px]'}`}>
          <span className="skeleton-text mr-auto block min-w-0" style={{ width: `${32 + (index * 7) % 23}%` }} />
          <span className="skeleton-text block w-16 shrink-0" />
          <span className="skeleton-text block w-24 shrink-0" />
        </div>
      ))}
    </div>
  )
}

/**
 * Under a list cut short. "+ N more" lists the next rows, at most fifty a
 * press, and "Show fewer" cuts the list again. It is one button either way,
 * so a press leaves the focus where it was.
 */
function MoreButton({ hidden, of, className = '', onMore, onFewer }: { hidden: number; of: string; className?: string; onMore: () => void; onFewer: () => void }) {
  const label = hidden > 0 ? `+ ${whole(Math.min(hidden, PAGE))} more` : 'Show fewer'
  return <Button type="button" variant="ghost" size="sm" className={`${TOUCH} ${className}`} aria-label={`${label} ${of}`} onClick={hidden > 0 ? onMore : onFewer}>{label}</Button>
}

/** A table of tracked queries, its first fifty rows, with the rest one press away. Few locations have that many. */
function FirstRows({ rows, of, children }: { rows: readonly TrackedRowVm[]; of: string; children: (rows: readonly TrackedRowVm[]) => ReactNode }) {
  const [count, setCount] = useState(PAGE)
  const shown = rows.length > count ? rows.slice(0, count) : rows
  return <>
    {children(shown)}
    {rows.length > PAGE ? <div className="mt-1"><MoreButton hidden={rows.length - shown.length} of={of} onMore={() => setCount(count + PAGE)} onFewer={() => setCount(PAGE)} /></div> : null}
  </>
}

interface MarketGroup {
  key: string
  label: string
  /** The market's other locations by name; undefined when the server sent no member list. */
  others: string[] | undefined
  /** Its queries this location takes, in the order they are listed. */
  rows: TrackedRowVm[]
}

// In a frame of 40rem or more this is a table whose header sticks under the topbar. In less it is a list with no
// header: a market's name and links over its queries, and each query over its facts, which then name themselves.
const HEAD_CELL = 'whitespace-nowrap border-b border-default bg-bg py-2 text-[13px] font-medium text-secondary @[40rem]:sticky @[40rem]:top-[var(--topbar-h)] @[40rem]:z-10'
const HEAD = `${HEAD_CELL} px-2.5 text-left`
const CELL_LINES = 'border-subtle align-top @[40rem]:border-b @[40rem]:py-2'
const CELL = `${CELL_LINES} @[40rem]:px-2.5`
const FACT_LINE = 'whitespace-nowrap @max-[40rem]:inline-flex @max-[40rem]:items-center @max-[40rem]:gap-1.5 @max-[40rem]:pr-5'
const FACT = `${CELL} ${FACT_LINE}`
const FACT_NAME = 'hidden text-secondary @max-[40rem]:inline'
// An engine's chips, centred under its name in the table, in a column as narrow as the Tracked table's. In the list
// they are a fact like the others, named by the engine.
const ENGINE_HEAD = `${HEAD_CELL} px-1 text-center`
const ENGINE_FACT = `${CELL_LINES} ${FACT_LINE} @[40rem]:px-1 @[40rem]:text-center`
const LINE = '@max-[40rem]:flex @max-[40rem]:flex-wrap @max-[40rem]:items-center @max-[40rem]:border-b @max-[40rem]:border-subtle'

/**
 * The queries this location takes from its markets, market by market. Every
 * market is in view with its link: the first eight rows are shared out
 * between the markets, at least two each, and a market with more says how many
 * under its own. One query over a market's share is listed, since the button
 * would take its line. A market is named once, in a cell that spans its
 * queries and holds its other locations and the link to it; down a long market
 * the name follows the page under the header.
 *
 * Each query has the last sweep's Mentioned and Cited per engine, read for
 * this location as the chips of the lists beside this one are: the page's one
 * results read, joined by query and type. A query added since that sweep has
 * no result, so its chips read Not checked.
 */
function MarketQueries({ projectName, targetLabel, groups, engines, coverage }: {
  projectName: string
  targetLabel: string
  groups: readonly MarketGroup[]
  engines: readonly string[]
  /** Undefined while the results load, so the chips draw their skeleton. */
  coverage: TrackedCoverage | undefined
}) {
  // How many queries a market lists, once the reader has asked it for more.
  const [opened, setOpened] = useState<Readonly<Record<string, number>>>({})
  const share = Math.max(MARKET_MIN, Math.floor(MARKET_ROWS / groups.length))
  const engineColumns = engines.map(key => ({ key, label: providerDisplayName(key) }))
  return (
    <div className="@container">
      <table aria-label="Market queries" className="w-full table-fixed border-separate border-spacing-0 text-[13.5px] leading-5 text-neutral @max-[40rem]:block">
        <colgroup>
          <col className="w-40" />
          <col />
          {engineColumns.map(engine => <col key={engine.key} style={{ width: trackedEngineColumnWidth(engine.label) }} />)}
          <col className="w-[5.5rem]" />
          <col className="w-[6.75rem]" />
        </colgroup>
        <thead className="@max-[40rem]:sr-only">
          <tr>
            <th scope="col" className={HEAD}>Market</th>
            <th scope="col" className={HEAD}>Query</th>
            {engineColumns.map(engine => <th key={engine.key} scope="col" className={ENGINE_HEAD}>{engine.label}</th>)}
            <th scope="col" className={HEAD}>Type</th>
            <th scope="col" className={HEAD}>Last measured</th>
          </tr>
        </thead>
        {groups.map(group => {
          const total = group.rows.length
          const closed = total > share + 1 ? share : total
          const count = Math.min(total, opened[group.key] ?? closed)
          const cut = total > closed
          return (
            <tbody key={group.key} className="@max-[40rem]:block">
              {group.rows.slice(0, count).map((row, index) => (
                <tr key={row.queryId} className={`${LINE} @max-[40rem]:py-2`}>
                  {index === 0 ? (
                    <td rowSpan={count + (cut ? 1 : 0)} className={`${CELL} @max-[40rem]:block @max-[40rem]:w-full`}>
                      <div className="@[40rem]:sticky @[40rem]:top-[calc(var(--topbar-h)+2.875rem)]">
                        <span className="block min-w-0 break-words font-medium text-strong">{group.label}</span>
                        <div className="flex flex-wrap items-center gap-x-3 text-[13px]">
                          {group.others ? <OtherLocations names={group.others} /> : null}
                          <Link to="/projects/$projectName/queries" params={{ projectName }} search={marketSearch(group.key)} className={`${LINK} whitespace-nowrap`} aria-label={`Open market ${group.label}`}>Open market</Link>
                        </div>
                      </div>
                    </td>
                  ) : null}
                  <td className={`${CELL} break-words text-[13px] text-heading @max-[40rem]:block @max-[40rem]:w-full`}>{row.queryText}</td>
                  {engineColumns.map(engine => {
                    const classes = resultClasses(row)
                    return (
                      <td key={engine.key} className={ENGINE_FACT}>
                        <span className={FACT_NAME}>{engine.label}</span>
                        {/* Branded and non-brand results are never combined: a query asked both ways has a pair per type, each named by its type. */}
                        <span className={classes.length > 1 ? 'inline-flex flex-col items-center gap-1 align-middle' : 'contents'}>
                          {classes.map(queryClass => {
                            const signal = rowSignal(row, coverage, queryClass, engine.key)
                            return signal === NOT_ASKED ? (
                              <span key={queryClass} className={classes.length > 1 ? 'tracked-pair-label' : undefined}><span className="sr-only">{classes.length > 1 ? `${typeLabel(queryClass as TrackedType)}: ` : ''}Not asked</span></span>
                            ) : (
                              <SignalPair
                                key={queryClass}
                                signal={signal}
                                subject={targetLabel}
                                engineLabel={engine.label}
                                classLabel={classes.length > 1 ? typeLabel(queryClass as TrackedType) : undefined}
                              />
                            )
                          })}
                        </span>
                      </td>
                    )
                  })}
                  {/* The type the query counts as for this location, set as the Type of the tables beside this one is. */}
                  <td className={`${FACT} text-[13px]`}><span className={FACT_NAME}>Type</span>{typeLabel(row.type)}</td>
                  <td className={`${FACT} tabular-nums text-secondary`}>
                    <span className={FACT_NAME}>Last measured</span>
                    {row.lastMeasuredAt ? <time dateTime={row.lastMeasuredAt}>{formatSweepDay(row.lastMeasuredAt)}</time> : 'Never'}
                  </td>
                </tr>
              ))}
              {cut ? (
                <tr className={LINE}>
                  <td colSpan={3 + engineColumns.length} className="border-subtle @[40rem]:border-b @[40rem]:py-0.5 @max-[40rem]:block @max-[40rem]:w-full">
                    {/* Its words stand under the queries' own. */}
                    <MoreButton
                      hidden={total - count}
                      of={`queries in ${group.label}`}
                      className="-ml-3 @[40rem]:-ml-0.5"
                      onMore={() => setOpened(previous => ({ ...previous, [group.key]: count + PAGE }))}
                      onFewer={() => setOpened(({ [group.key]: _closed, ...rest }) => rest)}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          )
        })}
      </table>
    </div>
  )
}

/**
 * "+2 locations": how many other locations the market holds. The count opens
 * their names, which are also its accessible name. A market this location has
 * to itself says so in plain text.
 */
function OtherLocations({ names }: { names: readonly string[] }) {
  if (names.length === 0) return <span className="text-muted">No other locations</span>
  return <OtherLocationsButton names={names} />
}

function OtherLocationsButton({ names }: { names: readonly string[] }) {
  const named = names.slice(0, NAMED)
  const text = `${named.join(' · ')}${names.length > named.length ? ` · +${whole(names.length - named.length)} more` : ''}`
  const bubble = useTooltipBubble(text, { placement: 'bottom', align: 'start' })
  return <>
    <button
      type="button"
      className={`inline-flex cursor-help items-center whitespace-nowrap rounded-sm tabular-nums text-secondary underline decoration-current/40 decoration-dotted underline-offset-4 hover:text-heading ${FOCUS} ${TOUCH}`}
      aria-label={`${whole(names.length)} other ${names.length === 1 ? 'location' : 'locations'}: ${text}`}
      {...bubble.wrapper}
      {...bubble.trigger}
    >
      +{locationCountLabel(names.length)}
    </button>
    {bubble.bubble}
  </>
}
