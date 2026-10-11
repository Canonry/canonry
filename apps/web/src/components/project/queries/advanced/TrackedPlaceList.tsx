import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronsUpDown, CircleCheck, FileX, ListFilter, Plus, SearchX } from 'lucide-react'
import type { QueryTrackingViews, QueryTrackingWeakMarkets, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { WriteButton } from '../../../shared/AccessControls.js'
import { DataTablePagination, DataTableSearch, useClientTable } from '../../../shared/DataTableControls.js'
import { useTooltipBubble } from '../../../shared/InfoTooltip.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import { TRACKED_VIEW_LABEL, trackedViewHelp, type TrackedPlaceView } from './TrackedSavedViews.js'
import type { TrackedPlace } from './tracked-actions.js'

type Workspace = Pick<QueryTrackingWorkspaceResponse, 'targets' | 'groups' | 'markets'>

/** One line of a list. Every number is a field of the workspace read, or the length of a list it returned. `listed` is false for a key the workspace no longer lists, which is named by its key. */
type PlaceRow = { kind: 'location' | 'market'; key: string; label: string; listed: boolean; groups: string[]; locations?: number; marketQueries?: number }
/** A pattern's two lists hold market names, by name. */
type PatternRow = { kind: 'pattern'; key: string; label: string; name: string | null; pattern: string; used: string[]; missing: string[] }
type Row = PlaceRow | PatternRow
/** Which of a pattern's two lists of markets: the ones it is asked in, or the ones it is missing from. */
type Side = 'used' | 'missing'
type SortKey = 'name' | 'locations' | 'marketQueries' | Side
type Sort = { key: SortKey; direction: 'asc' | 'desc' }

const PAGE_SIZES = [25, 50, 100] as const
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
// A place's name as the control that opens its queries: the query table's own quiet link. Its focus ring stands 4px clear of the text, which stays on the column's edge.
const NAME = `-mx-1 cursor-pointer rounded-sm px-1 text-left font-medium text-heading underline-offset-[3px] hover:underline focus-visible:underline pointer-coarse:min-w-11 max-md:min-w-11 ${FOCUS} ${TOUCH}`
/** Names sort as a person reads them: case aside, numbers by value. */
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
const whole = (value: number) => value.toLocaleString('en-US')

const NOUN: Record<Row['kind'], [one: string, many: string]> = { location: ['location', 'locations'], market: ['market', 'markets'], pattern: ['pattern', 'patterns'] }
const KIND: Record<TrackedPlaceView, Row['kind']> = { 'no-location-queries': 'location', 'thin-markets': 'market', 'weak-markets': 'market', 'pattern-gaps': 'pattern' }
const EMPTY: Record<TrackedPlaceView, string> = {
  'no-location-queries': 'No location gaps',
  'thin-markets': 'No thin markets',
  'pattern-gaps': 'No pattern gaps',
  'weak-markets': 'No weak markets',
}
/** The columns a list can be put in order by, as their headers name them. */
const SORTS: Record<Row['kind'], readonly (readonly [key: SortKey, text: string])[]> = {
  location: [['name', 'Location'], ['marketQueries', 'Market queries']],
  market: [['name', 'Market'], ['locations', 'Locations'], ['marketQueries', 'Market queries']],
  pattern: [['name', 'Pattern'], ['used', 'Used in'], ['missing', 'Missing in']],
}
const SIDE: Record<Side, string> = { used: 'Used in', missing: 'Missing in' }
const BY_NAME: Sort = { key: 'name', direction: 'asc' }
/** What a row's one action is called. It opens the Add queries sheet on that row's place. */
const ADD = { market: 'Add market query', location: 'Add location query' } as const
const COPY = {
  noLocations: 'A market with no location takes no query.',
  patternDeleted: 'This saved pattern was deleted. Its queries are still tracked.',
}
// Fixed widths in px. The name takes what is left: 508px beside a market's four other columns in the 1152px content column.
const WIDTH = { groups: 220, number: 112, wideNumber: 136, action: 176 } as const
/** As many names as a count's bubble previews. The count is of them all, and a press lists them all. */
const NAMES_SHOWN = 6

// The list is a table in a frame of 52rem or more, where the name keeps 188px beside the other columns. In
// less, each row is a block: the name and its action, then what the other columns held on one line, each
// under its column's name, which the header no longer shows. On a phone the group has a line of its own.
const STACK = {
  table: '@max-[52rem]:block',
  hide: '@max-[52rem]:hidden',
  only: 'hidden @max-[52rem]:flex',
  // An empty box as wide as the row, before the columns' line, breaks it off from the name's.
  row: '@max-[52rem]:flex @max-[52rem]:flex-wrap @max-[52rem]:items-center @max-[52rem]:gap-x-4 @max-[52rem]:border-b @max-[52rem]:border-subtle @max-[52rem]:py-2 @max-[52rem]:before:order-3 @max-[52rem]:before:basis-full',
  cell: '@max-[52rem]:block @max-[52rem]:border-0 @max-[52rem]:bg-transparent @max-[52rem]:p-0',
  name: '@max-[52rem]:order-1 @max-[52rem]:min-w-0 @max-[52rem]:flex-1',
  action: '@max-[52rem]:order-2',
  line: '@max-[52rem]:order-3 @max-[52rem]:basis-full',
  group: '@max-[52rem]:order-3 @max-[30rem]:basis-full',
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

/** The markets behind these keys, each with its own numbers. */
function marketRows(keys: readonly string[], workspace: Workspace): PlaceRow[] {
  const markets = new Map(workspace.markets.map(market => [market.stableKey, market]))
  const groupLabel = labelsOf(workspace.groups)
  return keys.map(key => {
    const market = markets.get(key)
    return {
      kind: 'market' as const,
      key,
      label: market?.label ?? key,
      listed: market !== undefined,
      groups: market?.groupKey ? [groupLabel(market.groupKey)] : [],
      locations: market?.targetKeys?.length,
      marketQueries: market?.counts?.marketQueries,
    }
  })
}

/** The view's lines. They are the keys the server listed: nothing is added, dropped or counted here. */
function rowsOf(view: TrackedPlaceView, workspace: Workspace, views: QueryTrackingViews, weakMarkets: Pick<QueryTrackingWeakMarkets, 'marketKeys'> | undefined): Row[] {
  if (view === 'no-location-queries') {
    const targets = new Map(workspace.targets.map(target => [target.stableKey, target]))
    return views.noPropertyQueries.targetKeys.map(key => ({
      kind: 'location' as const,
      key,
      label: targets.get(key)?.label ?? key,
      listed: targets.has(key),
      groups: workspace.groups.filter(group => group.targetKeys.includes(key)).map(group => group.label),
      marketQueries: targets.get(key)?.counts?.marketQueries,
    }))
  }
  if (view === 'pattern-gaps') {
    const marketLabel = labelsOf(workspace.markets)
    const names = (keys: readonly string[]) => keys.map(marketLabel).sort((left, right) => collator.compare(left, right))
    return views.patternGaps.patterns.map(gap => ({
      kind: 'pattern' as const,
      key: gap.templateId,
      label: gap.name ?? gap.pattern,
      name: gap.name,
      pattern: gap.pattern,
      used: names(gap.usedMarketKeys),
      missing: names(gap.missingMarketKeys),
    }))
  }
  return marketRows(view === 'thin-markets' ? views.thinMarkets.marketKeys : weakMarkets?.marketKeys ?? [], workspace)
}

/** The number a column orders a row by. */
function sortNumber(row: Row, key: SortKey): number | undefined {
  if (row.kind === 'pattern') return key === 'used' ? row.used.length : key === 'missing' ? row.missing.length : undefined
  return key === 'locations' ? row.locations : key === 'marketQueries' ? row.marketQueries : undefined
}

/** By name, or by a number and then by name. A row with no number comes last, whichever way the column runs. */
function sortRows(rows: readonly Row[], sort: Sort): Row[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const byName = (left: Row, right: Row) => collator.compare(left.label, right.label)
  return [...rows].sort((left, right) => {
    if (sort.key === 'name') return sign * byName(left, right)
    const [a, b] = [sortNumber(left, sort.key), sortNumber(right, sort.key)]
    if (a === b) return byName(left, right)
    if (a === undefined) return 1
    if (b === undefined) return -1
    return sign * (a - b)
  })
}

/** A second press on the sorted column flips it; a new column starts ascending. */
const nextSort = (current: Sort, key: SortKey): Sort => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' })

const searchText = (row: Row) => row.kind === 'pattern' ? `${row.name ?? ''} ${row.pattern}` : `${row.label} ${row.groups.join(' ')}`

/**
 * A pattern's count of markets. A press lists them all, each with its own
 * numbers and its Add action. Under the pointer and under focus a bubble
 * previews the first few. A name can hold a comma, so a dot parts two of them.
 */
function MarketCount({ pattern, side, onShow }: { pattern: PatternRow; side: Side; onShow: () => void }) {
  const names = pattern[side]
  const shown = names.slice(0, NAMES_SHOWN)
  const more = names.length > NAMES_SHOWN ? ` and ${whole(names.length - NAMES_SHOWN)} more` : ''
  // In the bubble a short name keeps to one line, and so does "and 21 more", so the end of one is never read with the start of the next.
  const unbroken = (text: string) => text.length > 28 ? text : text.replaceAll(' ', '\u00a0')
  const bubble = useTooltipBubble(`${shown.map(unbroken).join(' · ')}${more && ` ${unbroken(more.trim())}`}`, { placement: 'bottom', align: 'start' })
  return <>
    <button
      type="button"
      data-pattern={pattern.key}
      data-markets={side}
      className={`inline-flex min-w-6 items-center justify-end rounded-sm tabular-nums text-strong underline decoration-current/40 underline-offset-4 hover:text-heading pointer-coarse:min-w-11 max-md:min-w-11 ${FOCUS} ${TOUCH}`}
      aria-label={`Show ${whole(names.length)} ${names.length === 1 ? 'market' : 'markets'} ${side === 'used' ? 'using' : 'missing'} ${pattern.label}: ${shown.join(' · ')}${more}`}
      {...bubble.wrapper}
      {...bubble.trigger}
      // The bubble is only a preview: a press opens the list, and the button says nothing of the bubble's state.
      aria-expanded={undefined}
      onClick={onShow}
    >
      {whole(names.length)}
    </button>
    {bubble.bubble}
  </>
}

/**
 * One list: its search, the open view's name, the way back, its count and its
 * rows, in pages. `total` is the count the read gave for the list. The rows
 * can be put in order by name or by a number, from the headers of the table or,
 * where each row is a block, from a Sort control. The parent keys it, so each
 * list starts on its first page with a clean search.
 */
function PlaceList({ label, kind, rows, total, before, after, empty, defaultSort, token, backLabel, onBack, pending, failed, onRetry, onOpen, onAdd, onShowMarkets }: {
  /** The table's name. */
  label: string
  kind: Row['kind']
  rows: readonly Row[]
  total: number
  /** What the count is of, where the list's name does not say: drawn before and after it. */
  before?: ReactNode
  after?: string
  empty: string
  defaultSort: Sort
  token: ReactNode
  backLabel: string
  onBack: () => void
  pending: boolean
  failed: boolean
  onRetry?: () => void
  onOpen?: (place: TrackedPlace) => void
  onAdd?: (place: TrackedPlace) => void
  onShowMarkets?: (templateId: string, side: Side) => void
}) {
  const [pageSize, setPageSize] = useState<number>(50)
  const [sort, setSort] = useState(defaultSort)
  const root = useRef<HTMLDivElement>(null)
  const sortId = useId()
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort])
  const table = useClientTable({ rows: sorted, getSearchText: searchText, pageSize })
  const [one, many] = NOUN[kind]
  const ready = !pending && !failed
  const columns = kind === 'pattern' ? 3 : (kind === 'market' ? 4 : 3) + (onAdd ? 1 : 0)
  // Clear search takes its own button off the page, so the search holds the focus for it.
  const clearSearch = () => {
    table.setQuery('')
    root.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }
  // Another order starts at the first page.
  const changeSort = (next: Sort) => {
    setSort(next)
    table.setPage(1)
  }
  const count = table.hasQuery && table.totalRows !== rows.length
    ? `${whole(table.totalRows)} of ${whole(total)} ${many}`
    : `${whole(total)} ${total === 1 ? one : many}`
  // With fewer than two rows there is no order to change, so no header is a button.
  const sortable = rows.length > 1
  const header = (key: SortKey, numeric = false) => {
    const text = SORTS[kind].find(([candidate]) => candidate === key)![1]
    if (!sortable) return <th scope="col" className={numeric ? 'text-right' : undefined}>{text}</th>
    const active = sort.key === key
    // A number's header is set to the right, so its mark hangs before the text, inside the column.
    const mark = `tracked-sort-mark ${numeric ? 'left-auto right-[calc(100%+1px)]' : ''}`
    return (
      <th scope="col" className={numeric ? 'text-right' : undefined} aria-sort={!active ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending'}>
        <button type="button" className={`tracked-sort ${FOCUS}`} onClick={() => changeSort(nextSort(sort, key))}>
          {text}
          {active
            ? <ChevronDown aria-hidden="true" className={`${mark} ${sort.direction === 'asc' ? 'rotate-180' : ''}`} />
            : <ChevronsUpDown aria-hidden="true" className={`${mark} tracked-sort-hint`} />}
        </button>
      </th>
    )
  }

  return (
    <div ref={root}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
        {/* With nothing to list there is nothing to search. */}
        {ready && rows.length > 0 ? <DataTableSearch size="sm" value={table.query} onChange={table.setQuery} label={`Search ${many}`} placeholder={`Search ${many}`} className="min-w-[9.5rem] grow basis-full md:max-w-sm md:basis-0" /> : null}
        <div className="flex grow flex-wrap items-center justify-between gap-x-3 gap-y-2 md:ml-auto md:grow-0 md:justify-end">
          {token}
          <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onBack}>
            <ArrowLeft aria-hidden="true" size={14} />
            {backLabel}
          </Button>
        </div>
        {ready && rows.length > 0 ? (
          <p role="status" className="basis-full text-[13px] leading-5 tabular-nums text-secondary">{before}{count}{after}</p>
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
        {/* Blocks have no header to sort from. This line holds what it did. */}
        {sortable ? (
          <div className={`tracked-stack-controls ${STACK.only}`}>
            <div className="tracked-stack-sort">
              <label htmlFor={sortId}>Sort</label>
              <select id={sortId} className={FOCUS} value={sort.key} onChange={event => changeSort(nextSort(sort, event.target.value as SortKey))}>
                {SORTS[kind].map(([key, text]) => <option key={key} value={key}>{text}</option>)}
              </select>
              <Button type="button" variant="outline" size="icon" className="pointer-coarse:size-11 max-md:size-11" aria-label={sort.direction === 'asc' ? 'Ascending' : 'Descending'} onClick={() => changeSort(nextSort(sort, sort.key))}>
                {sort.direction === 'asc' ? <ArrowUp aria-hidden="true" className="size-4" /> : <ArrowDown aria-hidden="true" className="size-4" />}
              </Button>
            </div>
          </div>
        ) : null}
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
              {header('name')}
              {kind === 'pattern' ? <>{header('used', true)}{header('missing', true)}</> : <>
                <th scope="col">Group</th>
                {kind === 'market' ? header('locations', true) : null}
                {header('marketQueries', true)}
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
                {(['used', 'missing'] as const).map(side => (
                  <td key={side} data-label={SIDE[side]} className={`${NUMBER} ${STACK.cell} ${STACK.number} ${STACK.labelled}`}>
                    {/* With no market there is no list to open. */}
                    {row[side].length > 0 && onShowMarkets ? <MarketCount pattern={row} side={side} onShow={() => onShowMarkets(row.key, side)} /> : whole(row[side].length)}
                  </td>
                ))}
              </tr>
            ) : (
              <tr key={row.key} className={`tracked-row ${STACK.row}`}>
                <td className={`break-words font-medium text-strong ${STACK.cell} ${STACK.name}`}>
                  {/* The name is the label, and "Open" is only heard. A key the workspace no longer lists has no queries to open, so it stays text. */}
                  {onOpen && row.listed
                    ? <button type="button" className={NAME} aria-label={`Open ${row.label}`} onClick={() => onOpen({ kind: row.kind, key: row.key, label: row.label })}>{row.label}</button>
                    : row.label}
                </td>
                {/* A name can hold a comma, so a comma cannot part two of them. */}
                <td data-label="Group" className={`break-words text-secondary ${STACK.cell} ${STACK.group} ${STACK.labelled}`}>{row.groups.length > 0 ? row.groups.join(' · ') : 'None'}</td>
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
                    ? <StatusNote icon={CircleCheck} label={empty} />
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

/**
 * A saved view's list, in place of the query table: the locations, markets or
 * patterns the server listed for it, with a search, an order and pages, since
 * a portfolio has hundreds of each. It prints what the reads returned and
 * counts nothing: the count over the table is the read's own `count`, and a
 * row's numbers are its place's own `counts`. Thin markets opens with the
 * fewest market queries first.
 *
 * A location's or a market's name opens the queries of that place (`onOpen`),
 * for a viewer too, since it changes nothing. The name of a key the workspace
 * no longer lists is plain text. A location and a market offer one action,
 * which opens the Add queries sheet on that place (`onAdd`; left out for a
 * viewer, who gets no action column). A market with no location takes no
 * query, so it shows why and offers none. A pattern's two counts each open
 * the markets behind them as that same list of markets, under the pattern's
 * name, with Back to patterns. Weakest markets reads the last sweep's
 * non-brand results, so its count names that type, and it is the one view
 * that can be `pending` (the results are still being read) or `failed` (they
 * did not load).
 */
export function TrackedPlaceList({ view, workspace, views, weakMarkets, pending = false, failed = false, onRetry, onBack, onOpen, onAdd }: {
  view: TrackedPlaceView
  workspace: Workspace
  views: QueryTrackingViews
  weakMarkets?: Pick<QueryTrackingWeakMarkets, 'count' | 'marketKeys'>
  pending?: boolean
  failed?: boolean
  onRetry?: () => void
  onBack: () => void
  onOpen?: (place: TrackedPlace) => void
  onAdd?: (place: TrackedPlace) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  // The pattern whose markets are listed in place of the patterns, and which of its two lists.
  const [opened, setOpened] = useState<{ templateId: string; side: Side } | null>(null)
  const gap = view === 'pattern-gaps' && opened ? views.patternGaps.patterns.find(candidate => candidate.templateId === opened.templateId) : undefined
  const rows = useMemo(() => rowsOf(view, workspace, views, weakMarkets), [view, workspace, views, weakMarkets])
  const markets = useMemo(() => gap && opened ? marketRows(opened.side === 'used' ? gap.usedMarketKeys : gap.missingMarketKeys, workspace) : [], [gap, opened, workspace])
  const token = <StatusNote icon={ListFilter} label={`View: ${TRACKED_VIEW_LABEL[view]}`} detail={trackedViewHelp(view, views.thinMarkets.floor)} />

  // A pattern that a later read no longer lists has no markets to show: the patterns are listed again.
  useEffect(() => {
    if (opened && !gap) setOpened(null)
  }, [opened, gap])

  // A count that opens its markets, and Back to patterns, each take their own button off the page. The search of
  // the markets, or the count that was pressed, holds the focus for it.
  const moved = useRef<{ templateId: string; side: Side } | 'in' | null>(null)
  useEffect(() => {
    const from = moved.current
    moved.current = null
    if (!from || !root.current) return
    const pressed = from === 'in' ? undefined : [...root.current.querySelectorAll<HTMLElement>('button[data-markets]')].find(button => button.dataset.pattern === from.templateId && button.dataset.markets === from.side)
    ;(pressed ?? root.current.querySelector<HTMLElement>('input[type="search"]'))?.focus({ preventScroll: true })
  }, [opened])

  const total = view === 'no-location-queries' ? views.noPropertyQueries.count
    : view === 'thin-markets' ? views.thinMarkets.count
      : view === 'pattern-gaps' ? views.patternGaps.count
        : weakMarkets?.count ?? 0

  return (
    <div ref={root} className="@container">
      {gap && opened ? (
        <PlaceList
          key={`${opened.templateId} ${opened.side}`}
          label={`${gap.name ?? gap.pattern}: ${SIDE[opened.side]}`}
          kind="market"
          rows={markets}
          // The length of the list the read returned for this pattern.
          total={markets.length}
          before={<>{gap.name ? <span className="font-medium text-strong">{gap.name}</span> : <code>{gap.pattern}</code>}{` · ${SIDE[opened.side]} `}</>}
          empty="No markets"
          defaultSort={BY_NAME}
          token={token}
          backLabel="Back to patterns"
          onBack={() => { moved.current = opened; setOpened(null) }}
          pending={false}
          failed={false}
          onOpen={onOpen}
          onAdd={onAdd}
        />
      ) : (
        <PlaceList
          key={view}
          label={TRACKED_VIEW_LABEL[view]}
          kind={KIND[view]}
          rows={rows}
          total={total}
          // The type travels with the count. It is the mentions' type: the Market queries column counts queries of every type.
          after={view === 'weak-markets' ? ' · no non-brand mention' : undefined}
          empty={EMPTY[view]}
          // The thinnest market first.
          defaultSort={view === 'thin-markets' ? { key: 'marketQueries', direction: 'asc' } : BY_NAME}
          token={token}
          backLabel="Back to queries"
          onBack={onBack}
          pending={pending}
          failed={failed}
          onRetry={onRetry}
          onOpen={onOpen}
          onAdd={onAdd}
          onShowMarkets={(templateId, side) => { moved.current = 'in'; setOpened({ templateId, side }) }}
        />
      )}
    </div>
  )
}
