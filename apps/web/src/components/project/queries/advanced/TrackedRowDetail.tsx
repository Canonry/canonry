import { useId, useMemo, type ReactNode } from 'react'
import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { formatSweepDay } from '../../../../lib/format-helpers.js'
import { DataTablePagination, useClientTable } from '../../../shared/DataTableControls.js'
import { SearchLocationText } from '../../TrackingReview.js'
import type { TrackedRowVm } from './tracked-types.js'
import { sourceDetailLabel, typeLabel } from './tracked-view-model.js'

type Assignment = QueryTrackingTrackedRow['assignments'][number]
/**
 * The distinct search location and engines among some stored contexts, in the caller's words for them.
 * A value with more behind it, such as model ids, gives both: the short `label` shown and the `detail` it opens.
 */
export type TrackedContextLabels = (contexts: Assignment['contexts']) => (string | { label: string; detail: string })[]

const LINKS_PAGE_SIZE = 25
// The first column starts at the heading's edge, under "Location links". In a phone-width frame the columns close up.
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
export function TrackedRowDetail({ row, workspace, contextLabels }: {
  row: TrackedRowVm
  workspace: Pick<QueryTrackingWorkspaceResponse, 'targets' | 'groups' | 'markets'>
  contextLabels: TrackedContextLabels
}) {
  const headingId = useId()
  const links = useMemo(() => {
    const target = nameOf(workspace.targets)
    const group = nameOf(workspace.groups)
    const market = nameOf(workspace.markets)
    return row.tracked.assignments
      .map(assignment => ({
        key: assignment.targetKey,
        location: target(assignment.targetKey),
        groups: assignment.groupKeys.map(group),
        markets: assignment.marketKeys.map(market),
        type: typeLabel(assignment.queryClass ?? 'not-set'),
        searchLocations: contextLabels(assignment.contexts).map(named => typeof named === 'string' ? { label: named, detail: named } : named),
      }))
      .sort((left, right) => left.location.localeCompare(right.location, 'en', { sensitivity: 'base', numeric: true }))
  }, [row.tracked.assignments, workspace.targets, workspace.groups, workspace.markets, contextLabels])
  const table = useClientTable({ rows: links, pageSize: LINKS_PAGE_SIZE })
  // One value for every location is said once, under the list.
  const asked = (link: (typeof links)[number]) => link.searchLocations.map(named => named.detail).join('\n')
  const sharedSearch = links.length > 0 && links.every(link => asked(link) === asked(links[0]!))
    ? links[0]!.searchLocations
    : null
  const searchLines = (named: (typeof links)[number]['searchLocations']) => named.map(({ label, detail }) => <span key={detail} className="block"><SearchLocationText label={label} detail={detail} /></span>)
  // Set widths keep the columns in place from one page of locations to the next. A phone-width frame has none to spare, so there each column takes what its words need.
  const width = sharedSearch
    ? { location: '@min-[40rem]:w-[36%]', groups: '@min-[40rem]:w-[26%]', markets: '' }
    : { location: '@min-[40rem]:w-[22%]', groups: '@min-[40rem]:w-[16%]', markets: '@min-[40rem]:w-[18%]' }
  const { source } = row

  return (
    <div>
      {links.length > 0 ? <>
        <h4 id={headingId} className="text-[13px] font-medium leading-5 text-strong">Location links</h4>
        {/* Five columns are wider than a phone, so with the last one the list scrolls inside its own frame. */}
        <div className="mt-1 overflow-x-auto">
          <table aria-labelledby={headingId} className={`w-full border-separate border-spacing-0 text-[13px] leading-5 text-neutral ${sharedSearch ? '' : 'min-w-[44rem]'}`}>
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
                <tr key={link.key}>
                  <td className={`${CELL} font-medium text-strong`}>{link.location}</td>
                  <td className={`${CELL} text-secondary`}>{link.groups.length > 0 ? link.groups.join(', ') : 'None'}</td>
                  <td className={`${CELL} text-secondary`}>{link.markets.length > 0 ? link.markets.join(', ') : 'None'}</td>
                  <td className={`${CELL} whitespace-nowrap`}>{link.type}</td>
                  {sharedSearch ? null : <td className={`${CELL} text-secondary`}>{searchLines(link.searchLocations)}</td>}
                </tr>
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
      </> : null}
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
