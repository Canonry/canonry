import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, CircleCheck, FileX, ListFilter, Plus, SearchX } from 'lucide-react'
import type { QueryTrackingViews, QueryTrackingWeakMarkets, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { WriteButton } from '../../../shared/AccessControls.js'
import { DataTablePagination, DataTableSearch, useClientTable } from '../../../shared/DataTableControls.js'
import { useTooltipBubble } from '../../../shared/InfoTooltip.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import { TRACKED_VIEW_LABEL, trackedViewHelp, type TrackedPlaceView } from './TrackedSavedViews.js'
import type { TrackedPlace } from './tracked-actions.js'

type Workspace = Pick<QueryTrackingWorkspaceResponse, 'targets' | 'groups' | 'markets'>

/** One line of a view. Every number is a field of the workspace read, or the length of a list it returned. */
type Row =
  | { kind: 'location'; key: string; label: string; groups: string[]; marketQueries?: number }
  | { kind: 'market'; key: string; label: string; groups: string[]; locations?: number; marketQueries?: number }
  | { kind: 'pattern'; key: string; label: string; name: string | null; pattern: string; used: string[]; missing: string[] }

const PAGE_SIZES = [25, 50, 100] as const
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
/** Names sort as a person reads them: case aside, numbers by value. */
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
const byLabel = <T extends { label: string }>(rows: T[]) => rows.sort((left, right) => collator.compare(left.label, right.label))
const whole = (value: number) => value.toLocaleString('en-US')

const NOUN: Record<Row['kind'], [one: string, many: string]> = { location: ['location', 'locations'], market: ['market', 'markets'], pattern: ['pattern', 'patterns'] }
const KIND: Record<TrackedPlaceView, Row['kind']> = { 'no-property-queries': 'location', 'thin-markets': 'market', 'weak-markets': 'market', 'pattern-gaps': 'pattern' }
const EMPTY: Record<TrackedPlaceView, string> = {
  'no-property-queries': 'Every location has queries',
  'thin-markets': 'No thin markets',
  'pattern-gaps': 'No pattern gaps',
  'weak-markets': 'No weak markets',
}
/** What a row's one action is called. It opens the Add queries sheet on that row's place. */
const ADD = { market: 'Add market query', location: 'Add location query' } as const
const COPY = {
  noLocations: 'A market with no location takes no query.',
  patternDeleted: 'This saved pattern was deleted. Its queries are still tracked.',
}
// Fixed widths in px. The name takes what is left: 516px beside a market's four other columns in the 1152px content column.
const WIDTH = { groups: 220, number: 112, wideNumber: 128, action: 176 } as const
/** As many names as a help bubble holds. The count beside it is of them all. */
const NAMES_SHOWN = 12

// The list is a table in a frame of 52rem or more, where the name keeps 196px beside the other columns. In
// less, a tablet or a phone, each row is a block: the name and its action, then the group, then the numbers,
// each under its column's name, which the header no longer shows.
const STACK = {
  table: '@max-[52rem]:block',
  hide: '@max-[52rem]:hidden',
  row: '@max-[52rem]:flex @max-[52rem]:flex-wrap @max-[52rem]:items-center @max-[52rem]:gap-x-4 @max-[52rem]:border-b @max-[52rem]:border-subtle @max-[52rem]:py-2',
  cell: '@max-[52rem]:block @max-[52rem]:border-0 @max-[52rem]:bg-transparent @max-[52rem]:p-0',
  name: '@max-[52rem]:order-1 @max-[52rem]:min-w-0 @max-[52rem]:flex-1',
  action: '@max-[52rem]:order-2',
  line: '@max-[52rem]:order-3 @max-[52rem]:basis-full',
  number: '@max-[52rem]:order-4',
  // The column's name, drawn before the value as generated text, so it is not in the page twice.
  labelled: '@max-[52rem]:text-left @max-[52rem]:before:mr-1.5 @max-[52rem]:before:font-normal @max-[52rem]:before:text-secondary @max-[52rem]:before:content-[attr(data-label)]',
} as const
const NUMBER = 'text-right tabular-nums'

/** A key's name in the workspace, or the key itself for one the workspace no longer lists. */
function labelsOf(items: readonly { stableKey: string; label: string }[]) {
  const labels = new Map(items.map(item => [item.stableKey, item.label]))
  return (key: string) => labels.get(key) ?? key
}

/** The view's lines, by name. They are the keys the server listed: nothing is added, dropped or counted here. */
function rowsOf(view: TrackedPlaceView, workspace: Workspace, views: QueryTrackingViews, weakMarkets: Pick<QueryTrackingWeakMarkets, 'marketKeys'> | undefined): Row[] {
  if (view === 'no-property-queries') {
    const targets = new Map(workspace.targets.map(target => [target.stableKey, target]))
    return byLabel(views.noPropertyQueries.targetKeys.map(key => ({
      kind: 'location' as const,
      key,
      label: targets.get(key)?.label ?? key,
      groups: workspace.groups.filter(group => group.targetKeys.includes(key)).map(group => group.label),
      marketQueries: targets.get(key)?.counts?.marketQueries,
    })))
  }
  const marketLabel = labelsOf(workspace.markets)
  if (view === 'pattern-gaps') {
    const names = (keys: readonly string[]) => keys.map(marketLabel).sort((left, right) => collator.compare(left, right))
    return byLabel(views.patternGaps.patterns.map(gap => ({
      kind: 'pattern' as const,
      key: gap.templateId,
      label: gap.name ?? gap.pattern,
      name: gap.name,
      pattern: gap.pattern,
      used: names(gap.usedMarketKeys),
      missing: names(gap.missingMarketKeys),
    })))
  }
  const markets = new Map(workspace.markets.map(market => [market.stableKey, market]))
  const groupLabel = labelsOf(workspace.groups)
  return byLabel((view === 'thin-markets' ? views.thinMarkets.marketKeys : weakMarkets?.marketKeys ?? []).map(key => {
    const market = markets.get(key)
    return {
      kind: 'market' as const,
      key,
      label: market?.label ?? key,
      groups: market?.groupKey ? [groupLabel(market.groupKey)] : [],
      locations: market?.targetKeys?.length,
      marketQueries: market?.counts?.marketQueries,
    }
  }))
}

const searchText = (row: Row) => row.kind === 'pattern' ? `${row.name ?? ''} ${row.pattern}` : `${row.label} ${row.groups.join(' ')}`

/** A count whose names are one tap or hover away: "17", then the markets behind it. A name can hold a comma, so a dot parts two of them. */
function NamedCount({ names }: { names: readonly string[] }) {
  const shown = names.slice(0, NAMES_SHOWN).join(' · ')
  const text = names.length > NAMES_SHOWN ? `${shown} and ${whole(names.length - NAMES_SHOWN)} more` : shown
  const bubble = useTooltipBubble(text, { placement: 'bottom', align: 'start' })
  return <>
    <button
      type="button"
      className={`inline-flex min-w-6 cursor-help items-center justify-end rounded-sm tabular-nums underline decoration-current/40 decoration-dotted underline-offset-4 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${TOUCH}`}
      aria-label={`${whole(names.length)} ${names.length === 1 ? 'market' : 'markets'}: ${text}`}
      {...bubble.wrapper}
      {...bubble.trigger}
    >
      {whole(names.length)}
    </button>
    {bubble.bubble}
  </>
}

/**
 * A saved view's list, in place of the query table: the locations, markets or
 * patterns the server listed for it, with a search and pages, since a
 * portfolio has hundreds of each. It prints what the reads returned and
 * counts nothing: a row's numbers are its place's own `counts`, and the count
 * over the table is the length of the list shown.
 *
 * A location and a market offer one action, which opens the Add queries sheet
 * on that place (`onAdd`; left out for a viewer, who gets no action column).
 * A market with no location takes no query, so it shows why and offers none.
 * A pattern lists the markets it is asked in and missing from behind each
 * count. Weakest markets reads the last sweep's non-brand results, so its
 * count names that type, and it is the one view that can be `pending` (the
 * results are still being read) or `failed` (they did not load).
 */
export function TrackedPlaceList({ view, workspace, views, weakMarkets, pending = false, failed = false, onRetry, onBack, onAdd }: {
  view: TrackedPlaceView
  workspace: Workspace
  views: QueryTrackingViews
  weakMarkets?: Pick<QueryTrackingWeakMarkets, 'marketKeys'>
  pending?: boolean
  failed?: boolean
  onRetry?: () => void
  onBack: () => void
  onAdd?: (place: TrackedPlace) => void
}) {
  const [pageSize, setPageSize] = useState<number>(50)
  const root = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => rowsOf(view, workspace, views, weakMarkets), [view, workspace, views, weakMarkets])
  const table = useClientTable({ rows, getSearchText: searchText, pageSize })
  const kind = KIND[view]
  const [one, many] = NOUN[kind]
  const ready = !pending && !failed
  const label = TRACKED_VIEW_LABEL[view]
  const columns = kind === 'pattern' ? 3 : (kind === 'market' ? 4 : 3) + (onAdd ? 1 : 0)
  // Clear search takes its own button off the page, so the search holds the focus for it.
  const clearSearch = () => {
    table.setQuery('')
    root.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }
  const count = table.hasQuery && table.totalRows !== rows.length
    ? `${whole(table.totalRows)} of ${whole(rows.length)} ${many}`
    : `${whole(rows.length)} ${rows.length === 1 ? one : many}`

  return (
    <div ref={root} className="@container">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
        {/* With nothing to list there is nothing to search. */}
        {ready && rows.length > 0 ? <DataTableSearch size="sm" value={table.query} onChange={table.setQuery} label={`Search ${many}`} placeholder={`Search ${many}`} className="min-w-[9.5rem] grow basis-full md:max-w-sm md:basis-0" /> : null}
        <div className="flex grow flex-wrap items-center justify-between gap-x-3 gap-y-2 md:ml-auto md:grow-0 md:justify-end">
          <StatusNote icon={ListFilter} label={`View: ${label}`} detail={trackedViewHelp(view, views.thinMarkets.floor)} />
          <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onBack}>
            <ArrowLeft aria-hidden="true" size={14} />
            Back to queries
          </Button>
        </div>
        {ready && rows.length > 0 ? (
          <p role="status" className="basis-full text-[13px] leading-5 tabular-nums text-secondary">
            {count}{view === 'weak-markets' ? ' · non-brand queries' : null}
          </p>
        ) : null}
      </div>
      {pending ? (
        <div role="status" aria-label={`Loading ${many}`} className="tracked-table-skeleton">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} aria-hidden="true">
              <span className="skeleton-text" style={{ width: `${24 + (index * 7) % 19}%` }} />
              <span className="skeleton-text w-28" />
              <span className="skeleton-text w-12" />
              <span className="skeleton-text w-12" />
            </div>
          ))}
        </div>
      ) : failed ? (
        // Centred, as the page's empty states are.
        <div role="alert" className="py-8 text-center">
          <StatusNote
            icon={AlertTriangle}
            tone="negative"
            label="Could not load"
            action={onRetry ? <Button type="button" variant="outline" size="sm" className={TOUCH} aria-label="Retry results" onClick={onRetry}>Retry</Button> : undefined}
          />
        </div>
      ) : <>
        <table aria-label={label} className={`tracked-table ${STACK.table}`}>
          <colgroup>
            <col />
            {kind === 'pattern' ? <><col style={{ width: WIDTH.number }} /><col style={{ width: WIDTH.wideNumber }} /></> : <>
              <col style={{ width: WIDTH.groups }} />
              {kind === 'market' ? <col style={{ width: WIDTH.number }} /> : null}
              <col style={{ width: WIDTH.wideNumber }} />
              {onAdd ? <col style={{ width: WIDTH.action }} /> : null}
            </>}
          </colgroup>
          <thead className={STACK.hide}>
            <tr>
              {kind === 'pattern' ? <>
                <th scope="col">Pattern</th>
                <th scope="col" className="text-right">Used in</th>
                <th scope="col" className="text-right">Missing in</th>
              </> : <>
                <th scope="col">{kind === 'market' ? 'Market' : 'Location'}</th>
                <th scope="col">Group</th>
                {kind === 'market' ? <th scope="col" className="text-right">Locations</th> : null}
                <th scope="col" className="text-right">Market queries</th>
                {onAdd ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
              </>}
            </tr>
          </thead>
          <tbody className={STACK.table}>
            {table.rows.map(row => row.kind === 'pattern' ? (
              <tr key={row.key} className={`tracked-row ${STACK.row}`}>
                <td className={`${STACK.cell} ${STACK.line}`}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {row.name ? <span className="font-medium text-strong">{row.name}</span> : null}
                    <code className="break-words text-secondary">{row.pattern}</code>
                    {row.name ? null : <StatusNote icon={FileX} label="Pattern deleted" detail={COPY.patternDeleted} />}
                  </span>
                </td>
                <td data-label="Used in" className={`${NUMBER} ${STACK.cell} ${STACK.number} ${STACK.labelled}`}><NamedCount names={row.used} /></td>
                <td data-label="Missing in" className={`${NUMBER} ${STACK.cell} ${STACK.number} ${STACK.labelled}`}><NamedCount names={row.missing} /></td>
              </tr>
            ) : (
              <tr key={row.key} className={`tracked-row ${STACK.row}`}>
                <td className={`break-words font-medium text-strong ${STACK.cell} ${STACK.name}`}>{row.label}</td>
                {/* A name can hold a comma, so a comma cannot part two of them. */}
                <td data-label="Group" className={`break-words text-secondary ${STACK.cell} ${STACK.line} ${STACK.labelled}`}>{row.groups.length > 0 ? row.groups.join(' · ') : 'None'}</td>
                {row.kind === 'market' ? <td data-label="Locations" className={`${NUMBER} ${STACK.cell} ${STACK.number} ${STACK.labelled}`}>{row.locations === undefined ? null : whole(row.locations)}</td> : null}
                <td data-label="Market queries" className={`${NUMBER} ${STACK.cell} ${STACK.number} ${STACK.labelled}`}>{row.marketQueries === undefined ? null : whole(row.marketQueries)}</td>
                {onAdd ? (
                  // No padding above or below: a button is taller than a line of text and must not set the row's height with a mouse.
                  <td className={`py-0 text-right ${STACK.cell} ${STACK.action}`}>
                    {row.kind === 'market' && row.locations === 0
                      ? <StatusNote icon={AlertTriangle} tone="caution" label="No locations" detail={COPY.noLocations} />
                      : (
                        <WriteButton type="button" variant="ghost" size="sm" className={`h-7 px-2 text-strong md:h-7 ${TOUCH}`} aria-label={`${ADD[row.kind]} for ${row.label}`} onClick={() => onAdd({ kind: row.kind, key: row.key, label: row.label })}>
                          <Plus aria-hidden="true" size={14} />
                          {ADD[row.kind]}
                        </WriteButton>
                      )}
                  </td>
                ) : null}
              </tr>
            ))}
            {table.rows.length === 0 ? (
              <tr className={STACK.table}>
                <td colSpan={columns} className={`tracked-empty ${STACK.table}`}>
                  {rows.length === 0
                    ? <StatusNote icon={CircleCheck} label={EMPTY[view]} />
                    : <StatusNote icon={SearchX} label={`No ${many} match`} action={<Button type="button" variant="outline" size="sm" className={TOUCH} onClick={clearSearch}>Clear search</Button>} />}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {/* A list that fits the smallest page has no pages to turn: the count over the table says how many there are. */}
        {table.totalRows > PAGE_SIZES[0] ? (
          <DataTablePagination
            page={table.page}
            pageSize={pageSize}
            visibleRows={table.rows.length}
            totalRows={table.totalRows}
            itemLabel={many}
            onPageChange={table.setPage}
            pageSizeOptions={PAGE_SIZES}
            onPageSizeChange={size => { setPageSize(size); table.setPage(1) }}
          />
        ) : null}
      </>}
    </div>
  )
}
