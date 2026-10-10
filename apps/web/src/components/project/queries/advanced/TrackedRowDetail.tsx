import { useId, useMemo, type ReactNode } from 'react'
import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { formatSweepDay } from '../../../../lib/format-helpers.js'
import { DataTablePagination, useClientTable } from '../../../shared/DataTableControls.js'
import type { TrackedRowVm } from './tracked-types.js'
import { sourceLabel, typeLabel } from './tracked-view-model.js'

type Assignment = QueryTrackingTrackedRow['assignments'][number]
/** The distinct search location and engines among some stored contexts, in the caller's words for them. */
export type TrackedContextLabels = (contexts: Assignment['contexts']) => string[]

const LINKS_PAGE_SIZE = 25
const HEAD = 'border-b border-default px-2.5 py-1.5 text-left text-[13px] font-medium leading-5 text-secondary'
const CELL = 'border-b border-subtle px-2.5 py-1.5 align-top'

/**
 * What a tracked row holds beyond its cells, for every role: each location the
 * query is asked for, with that location's markets, type, search locations
 * and engines (25 to a page), then where the query came from and when. It
 * also holds the two columns a narrow table folds away, Source and Last
 * measured. A row that is not asked has no locations, so it shows the facts
 * alone.
 */
export function TrackedRowDetail({ row, workspace, contextLabels }: {
  row: TrackedRowVm
  workspace: Pick<QueryTrackingWorkspaceResponse, 'targets' | 'markets'>
  contextLabels: TrackedContextLabels
}) {
  const headingId = useId()
  const links = useMemo(() => {
    const targets = new Map(workspace.targets.map(target => [target.stableKey, target.label]))
    const markets = new Map(workspace.markets.map(market => [market.stableKey, market.label]))
    return row.tracked.assignments
      .map(assignment => ({
        key: assignment.targetKey,
        location: targets.get(assignment.targetKey) ?? assignment.targetKey,
        markets: assignment.marketKeys.map(key => markets.get(key) ?? key),
        type: typeLabel(assignment.queryClass ?? 'not-set'),
        searchLocations: contextLabels(assignment.contexts),
      }))
      .sort((left, right) => left.location.localeCompare(right.location, 'en', { sensitivity: 'base', numeric: true }))
  }, [row.tracked.assignments, workspace.targets, workspace.markets, contextLabels])
  const table = useClientTable({ rows: links, pageSize: LINKS_PAGE_SIZE })
  const { source } = row

  return (
    <div>
      {links.length > 0 ? <>
        <h4 id={headingId} className="text-[13px] font-medium leading-5 text-strong">Location links</h4>
        {/* Four columns are wider than a phone, so the list scrolls inside its own frame. */}
        <div className="mt-1 overflow-x-auto">
          <table aria-labelledby={headingId} className="w-full min-w-[36rem] border-separate border-spacing-0 text-[13px] leading-5 text-neutral">
            <thead>
              <tr>
                <th scope="col" className={`${HEAD} w-[24%]`}>Location</th>
                <th scope="col" className={`${HEAD} w-[22%]`}>Markets</th>
                <th scope="col" className={`${HEAD} w-[5.5rem]`}>Type</th>
                <th scope="col" className={HEAD}>Search location and engines</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map(link => (
                <tr key={link.key}>
                  <td className={`${CELL} font-medium text-strong`}>{link.location}</td>
                  <td className={`${CELL} text-secondary`}>{link.markets.length > 0 ? link.markets.join(', ') : 'None'}</td>
                  <td className={`${CELL} whitespace-nowrap`}>{link.type}</td>
                  <td className={`${CELL} text-secondary`}>
                    {link.searchLocations.map(label => <span key={label} className="block">{label}</span>)}
                  </td>
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
        <Fact label="Source">
          {sourceLabel(source)}
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
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-secondary">{label}</dt>
      <dd className="min-w-0 text-strong">{children}</dd>
    </div>
  )
}
