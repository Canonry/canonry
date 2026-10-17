import { Fragment, useId, useMemo, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@canonry/canonry-contracts'

import { formatSweepDay } from '../../../../lib/format-helpers.js'
import { carryVisibilitySearch, patchVisibilitySelection } from '../../../../lib/measurement-view-url.js'
import { DataTablePagination, useClientTable } from '../../../shared/DataTableControls.js'
import { SearchLocationText } from '../../TrackingReview.js'
import { assignmentTypeContexts } from '../tracking-contexts.js'
import type { TrackedRowVm } from './tracked-types.js'
import { sourceDetailLabel, typeLabel } from './tracked-view-model.js'

type Assignment = QueryTrackingTrackedRow['assignments'][number]
/**
 * The distinct search location and engines among some stored contexts, in the caller's words for them.
 * A value with more behind it, such as model ids, gives both: the short `label` shown and the `detail` it opens.
 */
export type TrackedContextLabels = (contexts: Assignment['contexts']) => (string | { label: string; detail: string })[]

const LINKS_PAGE_SIZE = 25
const LINK = 'rounded-sm underline-offset-[3px] hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
/** Queries narrowed to one market, its rows on a clean list. */
const marketSearch = (marketKey: string) => (previous: Record<string, unknown>) =>
  patchVisibilitySelection(carryVisibilitySearch(previous), { measurementScope: 'market', measurementScopeKey: marketKey, queryWorkspace: 'tracked', trackingQueryId: undefined, trackedView: undefined })
// The first column starts at the heading's edge, under "Counts for". In a phone-width frame the columns close up.
const PAD = 'px-2.5 py-1.5 first:pl-0 last:pr-0 @max-[40rem]:px-1.5'
const HEAD = `border-b border-default text-left text-[13px] font-medium leading-5 text-secondary ${PAD}`
const CELL = `border-b border-subtle align-top ${PAD}`

/** A key's name in the workspace, or the key itself for one the workspace no longer lists. */
const nameOf = (items: readonly { stableKey: string; label: string }[]) => {
  const names = new Map(items.map(item => [item.stableKey, item.label]))
  return (key: string) => names.get(key) ?? key
}

/**
 * What a tracked row holds beyond its cells, for every role: each location the
 * query is asked for, with that location's groups, markets and type (25 to a
 * page), then where the query came from and when. It also holds the two
 * columns a narrow table folds away, Source and Last measured. The search
 * location and engines are one fact when every location shares them, and a
 * column only when they differ. A row that is not asked has no locations, so
 * it shows the facts alone.
 */
export function TrackedRowDetail({ row, workspace, contextLabels, answers, actions, projectName, currentTargetKey }: {
  row: TrackedRowVm
  workspace: Pick<QueryTrackingWorkspaceResponse, 'targets' | 'groups' | 'markets'>
  contextLabels: TrackedContextLabels
  /** What each engine answered, first in the row. */
  answers?: ReactNode
  /** What to do next with the query, under its answers. */
  actions?: ReactNode
  /** With it each location links to its page and each market to its queries. */
  projectName?: string
  /** The location whose page the row is on: it is not linked to itself. */
  currentTargetKey?: string
}) {
  const headingId = useId()
  const links = useMemo(() => {
    const target = nameOf(workspace.targets)
    const group = nameOf(workspace.groups)
    const market = nameOf(workspace.markets)
    const listedTargets = new Set(workspace.targets.map(item => item.stableKey))
    const listedMarkets = new Set(workspace.markets.map(item => item.stableKey))
    return row.tracked.assignments
      .map(assignment => ({
        key: assignment.targetKey,
        listed: listedTargets.has(assignment.targetKey),
        location: target(assignment.targetKey),
        groups: assignment.groupKeys.map(group),
        types: assignmentTypeContexts(assignment).map(type => ({
          markets: type.marketKeys.map(key => ({ key, label: market(key), listed: listedMarkets.has(key) })),
          type: typeLabel(type.queryClass ?? 'not-set'),
          searchLocations: contextLabels(type.contexts).map(named => typeof named === 'string' ? { label: named, detail: named } : named),
        })),
      }))
      .sort((left, right) => left.location.localeCompare(right.location, 'en', { sensitivity: 'base', numeric: true }))
  }, [row.tracked.assignments, workspace.targets, workspace.groups, workspace.markets, contextLabels])
  // A key the workspace no longer lists has no page and no queries, so it stays text.
  const locationCell = (link: (typeof links)[number]) => projectName && link.listed && link.key !== currentTargetKey
    ? <Link to="/projects/$projectName/properties/$targetKey" params={{ projectName, targetKey: link.key }} search={carryVisibilitySearch} className={LINK} aria-label={`Location details for ${link.location}`}>{link.location}</Link>
    : link.location
  const marketsCell = (markets: readonly { key: string; label: string; listed: boolean }[]) => markets.length === 0 ? 'None' : markets.map((item, index) => (
    <Fragment key={item.key}>
      {index > 0 ? ' · ' : null}
      {projectName && item.listed
        ? <Link to="/projects/$projectName/queries" params={{ projectName }} search={marketSearch(item.key)} className={LINK} aria-label={`Open market ${item.label}`}>{item.label}</Link>
        : item.label}
    </Fragment>
  ))
  const table = useClientTable({ rows: links, pageSize: LINKS_PAGE_SIZE })
  // One value for every location is said once, under the list.
  const types = links.flatMap(link => link.types)
  const asked = (type: (typeof types)[number]) => type.searchLocations.map(named => named.detail).join('\n')
  const sharedSearch = types.length > 0 && types.every(type => asked(type) === asked(types[0]!))
    ? types[0]!.searchLocations
    : null
  const searchLines = (named: (typeof types)[number]['searchLocations']) => named.map(({ label, detail }) => <span key={detail} className="block"><SearchLocationText label={label} detail={detail} /></span>)
  // Set widths keep the columns in place from one page of locations to the next. A phone-width frame has none to spare, so there each column takes what its words need.
  const width = sharedSearch
    ? { location: '@min-[40rem]:w-[36%]', groups: '@min-[40rem]:w-[26%]', markets: '' }
    : { location: '@min-[40rem]:w-[22%]', groups: '@min-[40rem]:w-[16%]', markets: '@min-[40rem]:w-[18%]' }
  const { source } = row

  return (
    <div>
      {answers}
      {actions ? <div className="flex flex-wrap items-center gap-2 pb-3">{actions}</div> : null}
      {/* The locations the query counts for are one press away, closed by default: the answers lead the row. */}
      {links.length > 0 ? <details className="group/counted">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm py-1 text-[13px] font-medium leading-5 text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:min-h-11 max-md:min-h-11 [&::-webkit-details-marker]:hidden">
          <h4 id={headingId} className="contents">Counted for {links.length.toLocaleString('en-US')} {links.length === 1 ? 'location' : 'locations'}</h4>
          <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open/counted:rotate-90 motion-reduce:transition-none" />
        </summary>
        {/* Five columns are wider than a phone, so with the last one the list scrolls inside its own frame. */}
        <div className="mt-1 overflow-x-auto">
          <table aria-label="Counts for" className={`w-full border-separate border-spacing-0 text-[13px] leading-5 text-neutral ${sharedSearch ? '' : 'min-w-[44rem]'}`}>
            <thead>
              <tr>
                <th scope="col" className={`${HEAD} ${width.location}`}>Location</th>
                <th scope="col" className={`${HEAD} ${width.groups}`}>Groups</th>
                <th scope="col" className={`${HEAD} ${width.markets}`}>Markets</th>
                <th scope="col" className={HEAD}>Type</th>
                {sharedSearch ? null : <th scope="col" className={HEAD}>Search location and engines</th>}
              </tr>
            </thead>
            <tbody>
              {table.rows.map(link => (
                <Fragment key={link.key}>
                  {link.types.map((type, index) => <tr key={type.type}>
                    {index === 0 ? <>
                      <td rowSpan={link.types.length} className={`${CELL} font-medium text-strong`}>{locationCell(link)}</td>
                      {/* A name can hold a comma, so a comma cannot part two of them. */}
                      <td rowSpan={link.types.length} className={`${CELL} text-secondary`}>{link.groups.length > 0 ? link.groups.join(' · ') : 'None'}</td>
                    </> : null}
                    <td className={`${CELL} text-secondary`}>{marketsCell(type.markets)}</td>
                    <td className={`${CELL} whitespace-nowrap`}>{type.type}</td>
                    {sharedSearch ? null : <td className={`${CELL} text-secondary`}>{searchLines(type.searchLocations)}</td>}
                  </tr>)}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {table.totalRows > LINKS_PAGE_SIZE ? (
          <DataTablePagination
            page={table.page}
            pageSize={table.pageSize}
            visibleRows={table.rows.length}
            totalRows={table.totalRows}
            itemLabel="locations"
            onPageChange={table.setPage}
          />
        ) : null}
      </details> : null}
      <dl className={`flex flex-wrap gap-x-6 gap-y-1 text-[13px] leading-5 ${links.length > 0 ? 'mt-3' : ''}`}>
        {sharedSearch ? <Fact label="Search location and engines">{searchLines(sharedSearch)}</Fact> : null}
        <Fact label="Source">
          {sourceDetailLabel(row)}
          {source.kind === 'pattern' && source.pattern ? <code className="ml-2 break-words text-secondary">{source.pattern}</code> : null}
        </Fact>
        <Fact label="Last measured">
          {row.lastMeasuredAt ? <time dateTime={row.lastMeasuredAt}>{formatSweepDay(row.lastMeasuredAt)}</time> : 'Never'}
        </Fact>
        {row.addedAt ? <Fact label="Added"><time dateTime={row.addedAt}>{formatSweepDay(row.addedAt)}</time></Fact> : null}
      </dl>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    // A value too long for the line drops under its label.
    <div className="flex min-w-0 flex-wrap gap-x-2">
      <dt className="shrink-0 text-secondary">{label}</dt>
      <dd className="min-w-0 text-strong">{children}</dd>
    </div>
  )
}
