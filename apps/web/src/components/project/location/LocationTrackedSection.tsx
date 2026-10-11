import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Clock, Info } from 'lucide-react'
import type { QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameQueryTrackingOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import { formatSweepDay } from '../../../lib/format-helpers.js'
import { carryVisibilitySearch, patchVisibilitySelection } from '../../../lib/measurement-view-url.js'
import { addToast } from '../../../lib/toast-store.js'
import { providerDisplayName } from '../../../lib/visibility-trend-helpers.js'
import { formatObservedInstantMonthDay, observedInstant } from '../../shared/ChartPrimitives.js'
import { InfoTooltip, useTooltipBubble } from '../../shared/InfoTooltip.js'
import { SignalLegend } from '../../shared/SignalCells.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { Button } from '../../ui/button.js'
import { VISIBILITY_TOOLBAR_COPY } from '../VisibilityTrendSection.js'
import { TrackedActionSheet, type TrackedSheetAction } from '../queries/advanced/TrackedActionSheet.js'
import type { TrackedContextLabels } from '../queries/advanced/TrackedRowDetail.js'
import { TrackedRowMenu } from '../queries/advanced/TrackedRowMenu.js'
import { TrackedTable, TrackedTableSkeleton } from '../queries/advanced/TrackedTable.js'
import type { TrackedPlace } from '../queries/advanced/tracked-actions.js'
import type { TrackedRowAction, TrackedRowVm, TrackedType } from '../queries/advanced/tracked-types.js'
import { sortTrackedRows, toTrackedRows, type TrackedColumn } from '../queries/advanced/tracked-view-model.js'
import { contextInput, contextLabel, contextLabels, uniqueContextInputs } from '../queries/tracking-contexts.js'
import { useTrackedResults } from '../queries/use-tracked-results.js'

type Workspace = QueryTrackingWorkspaceResponse

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
const LINK = `inline-flex items-center rounded-sm font-medium text-link hover:underline ${FOCUS} ${TOUCH}`
/** The market queries listed before "+ N more". */
const MARKET_ROWS = 8
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
  refreshFailed: 'The latest tracked queries did not load. These are the last ones read.',
  resultsUnavailable: "The last sweep's results did not load, so every chip reads Not checked.",
  // The Tracked strip's own words for this number, when the page is narrowed to one location.
  answersCounted: 'Answers per sweep that count for this location, its market queries included. Locations share answers, so they do not add up to the project total.',
  noLocationQueries: 'No tracked query has this location as its Subject.',
  inNoMarket: 'This location is in no market, so no market query counts for it.',
}

const whole = (value: number) => value.toLocaleString('en-US')

/** The Queries tab's own read and key, so a visit from there makes no new request. */
const workspaceOptions = (projectName: string) => getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } })

/** Queries narrowed to one market, as Settings links to it. */
const marketSearch = (marketKey: string) => (previous: Record<string, unknown>) =>
  patchVisibilitySelection(carryVisibilitySearch(previous), { measurementScope: 'market', measurementScopeKey: marketKey, queryWorkspace: 'tracked', trackingQueryId: undefined })

/**
 * Where a query is asked, as the Tracked page's row detail names it: the
 * search location and its engines by display name, with the Add query form's
 * words, model ids included, behind the value. Two that read alike by display
 * name keep the form's words.
 */
function searchLocationNames(workspace: Workspace): TrackedContextLabels {
  const names = new Map<string, string>()
  const stored = [...workspace.defaultContexts, ...workspace.tracked.flatMap(row => row.assignments.flatMap(assignment => assignment.contexts))]
  for (const context of stored) {
    const detail = contextLabel(contextInput(context))
    if (!names.has(detail)) names.set(detail, `${context.location?.label ?? 'No search location'} · ${context.providers.map(providerDisplayName).join(', ')}`)
  }
  const uses = new Map<string, number>()
  for (const name of names.values()) uses.set(name, (uses.get(name) ?? 0) + 1)
  return contexts => contextLabels(contexts).map(detail => {
    const name = names.get(detail)
    return { label: name !== undefined && uses.get(name) === 1 ? name : detail, detail }
  })
}

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
  const groups = workspace.groups.filter(group => group.targetKeys.includes(targetKey))
  if (marketKeys.length === 0 && groups.length === 0) return null
  return (
    <dl className="contents">
      {marketKeys.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-1.5">
          <dt>{marketKeys.length === 1 ? 'Market:' : 'Markets:'}</dt>
          {/* Each link is an item of the line its label starts, so a long list wraps after the label, not under it. */}
          <dd className="contents">
            {marketKeys.map((key, index) => (
              <span key={key} className="inline-flex items-center gap-x-1.5">
                <Link to="/projects/$projectName/queries" params={{ projectName }} search={marketSearch(key)} className={LINK}>{marketNames.get(key) ?? key}</Link>
                {index < marketKeys.length - 1 ? <span aria-hidden="true">·</span> : null}
              </span>
            ))}
          </dd>
        </div>
      ) : null}
      {groups.length > 0 ? (
        <div className="flex flex-wrap gap-x-1.5">
          <dt>{groups.length === 1 ? 'Group:' : 'Groups:'}</dt>
          <dd className="text-strong">{groups.map(group => group.label).join(' · ')}</dd>
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
  /** When the published setup last changed, for the note beside the legend. */
  trackingChangedAt?: string
}) {
  const workspaceQuery = useQuery(workspaceOptions(projectName))
  const results = useTrackedResults(projectName, { measurementScope: 'property', measurementScopeKey: targetKey })
  const workspace = workspaceQuery.data
  const target = workspace?.targets.find(candidate => candidate.stableKey === targetKey)
  const retry = () => { void workspaceQuery.refetch() }

  if (!workspace && workspaceQuery.isPending) {
    return (
      <div className="min-w-0">
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
        <TrackedTableSkeleton rows={3} />
      </div>
    )
  }
  // A read that left nothing to show, or one the published setup is ahead of: it does not hold this location yet.
  if (!workspace || !target) {
    return (
      <div role="alert" className="min-w-0 py-2">
        <StatusNote
          icon={AlertTriangle}
          tone="negative"
          label="Could not load"
          detail={COPY.loadFailed}
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
  trackingChangedAt?: string
  refreshFailed: boolean
  onRetry: () => void
}) {
  const router = useRouter()
  const root = useRef<HTMLDivElement>(null)
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
      const queryClasses = [...new Set(links.flatMap(link => link.queryClass ?? []))].sort()
      const type: TrackedType = queryClasses.length === 0 ? 'not-set' : queryClasses.length === 1 ? queryClasses[0]! : 'mixed'
      here.push(queryClasses.length === row.queryClasses.length ? row : { ...row, queryClasses, type })
    }
    const sorted = sortTrackedRows(here)
    return {
      whole: wholeRows,
      location: sorted.filter(row => row.subject.kind === 'location'),
      market: sorted.filter(row => row.subject.kind === 'market'),
      picked: sorted.filter(row => row.subject.kind === 'hand-picked'),
    }
  }, [workspace, targetKey])
  const marketRows = useMemo(() => {
    const names = new Map(workspace.targets.map(candidate => [candidate.stableKey, candidate.label]))
    const markets = new Map(workspace.markets.map(market => [market.stableKey, market]))
    let last: string | undefined
    return listed.market.map((row): MarketRow => {
      const key = row.subject.kind === 'market' ? row.subject.key : ''
      const market = markets.get(key)
      const first = key !== last
      last = key
      return {
        row,
        marketKey: key,
        marketLabel: market?.label ?? key,
        // The server's member list, less this location. A list it did not send prints nothing.
        others: market?.targetKeys?.filter(member => member !== targetKey).map(member => names.get(member) ?? member),
        first,
      }
    })
  }, [listed.market, workspace.targets, workspace.markets, targetKey])

  // A sheet hands the focus back to the menu that opened it. When its row has left the page, the section takes it.
  const sheetOpen = sheet !== null
  const sheetWasOpen = useRef(false)
  useEffect(() => {
    const closed = sheetWasOpen.current && !sheetOpen
    sheetWasOpen.current = sheetOpen
    if (!closed) return
    // After the sheet's own hand-back, which waits a tick.
    const timer = setTimeout(() => { if (document.activeElement === document.body) root.current?.querySelector<HTMLElement>('button, a')?.focus({ preventScroll: true }) })
    return () => clearTimeout(timer)
  }, [sheetOpen])

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
      {run && !run.matchesCurrentTracking ? (
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
  const table = (rows: readonly TrackedRowVm[], label: string) => (
    <TrackedTable rows={rows} engines={engines} coverage={results.coverage} renderRowMenu={renderRowMenu} workspace={workspace} contextLabels={rowContextLabels} columns={COLUMNS} label={label} />
  )

  return (
    <div ref={root} className="min-w-0 space-y-6">
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
      <Numbers target={target} />

      <Block title="Queries about this location" count={counts?.propertyQueries} aside={listed.location.length > 0 ? legend : undefined}>
        {listed.location.length > 0
          ? table(listed.location, 'Location queries')
          // A flag, so only where it is true: the server counts none and none is listed.
          : (counts?.propertyQueries ?? 0) === 0 ? <StatusNote icon={AlertTriangle} tone="caution" label="No location queries" detail={COPY.noLocationQueries} /> : null}
      </Block>

      <Block title="From its markets" count={counts?.marketQueries}>
        {marketRows.length > 0
          ? <MarketQueries projectName={projectName} rows={marketRows} />
          : target.marketKeys?.length === 0
            ? <StatusNote icon={AlertTriangle} tone="caution" label="In no market" detail={COPY.inNoMarket} />
            : <StatusNote icon={Info} label="No market queries" />}
      </Block>

      {listed.picked.length > 0 ? (
        <Block title="Hand-picked" count={counts?.customQueries} aside={listed.location.length === 0 ? legend : undefined}>
          {table(listed.picked, 'Hand-picked queries')}
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
function Numbers({ target }: { target: Workspace['targets'][number] }) {
  const { counts, marketKeys } = target
  const stats: { label: string; value: number; help?: string }[] = [
    ...(counts ? [{ label: 'Location queries', value: counts.propertyQueries }, { label: 'Market queries', value: counts.marketQueries }] : []),
    ...(marketKeys ? [{ label: 'Markets', value: marketKeys.length }] : []),
    ...(counts ? [{ label: 'Answers counted', value: counts.answersPerSweep, help: COPY.answersCounted }] : []),
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

/** One list of the section: a heading of a few words, the server's count beside it, and its rows. */
function Block({ title, count, aside, children }: { title: string; count: number | undefined; aside?: ReactNode; children: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {/* The count is a sibling of the heading, so it stays out of the section's name. */}
        <div className="flex items-baseline gap-2">
          <h2 id={headingId} className="text-base font-semibold text-heading">{title}</h2>
          {count === undefined ? null : <span className="text-sm tabular-nums text-secondary">{whole(count)}<span className="sr-only"> queries</span></span>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

interface MarketRow {
  row: TrackedRowVm
  marketKey: string
  marketLabel: string
  /** The market's other locations by name; undefined when the server sent no member list. */
  others: string[] | undefined
  /** The first row of its market, which carries the link to it. */
  first: boolean
}

// In a frame of 40rem or more this is a table whose header sticks under the topbar. In less it is a list with no
// header: a market's name and link over its queries, and each query over its two facts, which then name themselves.
const HEAD = 'whitespace-nowrap border-b border-default bg-bg px-2.5 py-2 text-left text-[13px] font-medium text-secondary @[40rem]:sticky @[40rem]:top-[var(--topbar-h)] @[40rem]:z-10'
const CELL = 'border-subtle align-top @[40rem]:border-b @[40rem]:px-2.5 @[40rem]:py-2'
const FACT = `${CELL} text-secondary @max-[40rem]:inline-flex @max-[40rem]:items-center @max-[40rem]:gap-1.5 @max-[40rem]:pr-5`
const FACT_NAME = 'hidden @max-[40rem]:inline'

/** How many of the rows shown each market's first row stands for. Its Market cell spans them. */
function marketSpans(rows: readonly MarketRow[]): number[] {
  const spans = rows.map(() => 0)
  let start = 0
  rows.forEach((row, index) => {
    if (row.first) start = index
    spans[start]! += 1
  })
  return spans
}

/**
 * The queries this location takes from its markets, in market order: the
 * first eight, then the rest behind "+ N more". A market is named once, in a
 * cell that spans its queries and holds the link to it; down a long market
 * the name follows the page under the header.
 */
function MarketQueries({ projectName, rows }: { projectName: string; rows: readonly MarketRow[] }) {
  const [all, setAll] = useState(false)
  const revealed = useRef<HTMLTableRowElement>(null)
  const shown = all ? rows : rows.slice(0, MARKET_ROWS)
  const spans = marketSpans(shown)
  // The button leaves with the press, so the first row it brought takes the focus.
  useEffect(() => {
    if (all) revealed.current?.focus({ preventScroll: true })
  }, [all])
  return (
    <div className="@container">
      <table aria-label="Market queries" className="w-full table-fixed border-separate border-spacing-0 text-[13.5px] leading-5 text-neutral @max-[40rem]:block">
        <colgroup>
          <col className="w-52" />
          <col />
          <col className="w-[7.25rem]" />
          <col className="w-[6.75rem]" />
        </colgroup>
        <thead className="@max-[40rem]:sr-only">
          <tr>
            <th scope="col" className={HEAD}>Market</th>
            <th scope="col" className={HEAD}>Query</th>
            <th scope="col" className={HEAD}>Other locations</th>
            <th scope="col" className={HEAD}>Last measured</th>
          </tr>
        </thead>
        <tbody className="@max-[40rem]:block">
          {shown.map(({ row, marketKey, marketLabel, others }, index) => (
            <tr
              key={row.queryId}
              ref={index === MARKET_ROWS ? revealed : undefined}
              tabIndex={index === MARKET_ROWS ? -1 : undefined}
              className="focus:outline-none focus-visible:[&>td]:bg-surface @max-[40rem]:flex @max-[40rem]:flex-wrap @max-[40rem]:items-center @max-[40rem]:border-b @max-[40rem]:border-subtle @max-[40rem]:py-2"
            >
              {spans[index]! > 0 ? (
                <td rowSpan={spans[index]} className={`${CELL} @max-[40rem]:block @max-[40rem]:w-full @max-[40rem]:pb-1`}>
                  <div className="@[40rem]:sticky @[40rem]:top-[calc(var(--topbar-h)+2.875rem)] @max-[40rem]:flex @max-[40rem]:items-center @max-[40rem]:justify-between @max-[40rem]:gap-3">
                    <span className="block min-w-0 break-words font-medium text-strong">{marketLabel}</span>
                    <Link to="/projects/$projectName/queries" params={{ projectName }} search={marketSearch(marketKey)} className={`${LINK} shrink-0 whitespace-nowrap text-[13px]`} aria-label={`Open market ${marketLabel}`}>Open market</Link>
                  </div>
                </td>
              ) : null}
              <td className={`${CELL} break-words text-[13px] text-heading @max-[40rem]:block @max-[40rem]:w-full`}>{row.queryText}</td>
              <td className={FACT}>
                {others ? <><span className={FACT_NAME}>Other locations</span><OtherLocations names={others} /></> : null}
              </td>
              <td className={`${FACT} whitespace-nowrap tabular-nums`}>
                <span className={FACT_NAME}>Last measured</span>
                {row.lastMeasuredAt ? <time dateTime={row.lastMeasuredAt}>{formatSweepDay(row.lastMeasuredAt)}</time> : 'Never'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length ? (
        <Button type="button" variant="ghost" size="sm" className={`mt-1 ${TOUCH}`} onClick={() => setAll(true)}>
          + {whole(rows.length - shown.length)} more{' '}<span className="sr-only">market queries</span>
        </Button>
      ) : null}
    </div>
  )
}

/** "+2": how many other locations the market holds. The count opens their names, which are also its accessible name. */
function OtherLocations({ names }: { names: readonly string[] }) {
  if (names.length === 0) return <span className="text-muted">None</span>
  return <OtherLocationsButton names={names} />
}

function OtherLocationsButton({ names }: { names: readonly string[] }) {
  const named = names.slice(0, NAMED)
  const text = `${named.join(' · ')}${names.length > named.length ? ` · +${whole(names.length - named.length)} more` : ''}`
  const bubble = useTooltipBubble(text, { placement: 'bottom' })
  return <>
    <button
      type="button"
      className={`inline-flex cursor-help items-center rounded-sm tabular-nums underline decoration-current/40 decoration-dotted underline-offset-4 hover:text-heading ${FOCUS} pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-md:min-h-11 max-md:min-w-11`}
      aria-label={`${whole(names.length)} other ${names.length === 1 ? 'location' : 'locations'}: ${text}`}
      {...bubble.wrapper}
      {...bubble.trigger}
    >
      +{whole(names.length)}
    </button>
    {bubble.bubble}
  </>
}
