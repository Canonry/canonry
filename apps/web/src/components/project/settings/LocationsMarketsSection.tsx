import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ChevronDown, ChevronsUpDown, Info, SearchX } from 'lucide-react'
import type { MeasurementPlanResponse, MeasurementSetupResponse, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-api-client'
import { getApiV1ProjectsByNameQueryTrackingOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import { useAccount } from '../../../contexts/account-context.js'
import { carryVisibilitySearch, patchVisibilitySelection } from '../../../lib/measurement-view-url.js'
import { ViewOnlyNote } from '../../shared/AccessControls.js'
import { DataTablePagination, DataTableSearch, DEFAULT_TABLE_PAGE_SIZE, useClientTable } from '../../shared/DataTableControls.js'
import { InfoTooltip, useTooltipBubble } from '../../shared/InfoTooltip.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { Button } from '../../ui/button.js'
import { advancedMeasurementSetupActionLabel, resolveAdvancedMeasurementMode } from '../advanced-measurement/model.js'
import {
  nextStructureSort,
  projectStructure,
  sortStructureRows,
  type StructureCompetitor,
  type StructureGroup,
  type StructureLocation,
  type StructureMarket,
  type StructureRow,
  type StructureSort,
} from './structure-view-model.js'

export const LOCATIONS_MARKETS_COPY = {
  heading: 'Locations & markets',
  help: 'Measure individual locations or site sections with separate query sets.',
  addLocations: 'Add locations',
  bulkSetup: 'Bulk setup',
  openDraft: 'Open draft',
  loadError: 'Could not load',
  loadErrorHelp: 'Locations and markets did not load.',
  retry: 'Retry',
  search: 'Search',
  noMatches: 'No matches',
  noLocations: 'No locations',
  noLocationsHelp: 'No location is in this market, so nothing is measured for it.',
  none: 'None',
} as const

// `noun` counts a tab's rows ("1 to 25 of 192 locations"). `minWidth` is the least its table is drawn at: a
// narrower frame scrolls it sideways.
const TABS = [
  { key: 'locations', label: 'Locations', noun: 'locations', minWidth: '45rem' },
  { key: 'markets', label: 'Markets', noun: 'markets', minWidth: '43rem' },
  { key: 'groups', label: 'Groups', noun: 'groups', minWidth: '45rem' },
  { key: 'competitors', label: 'Competitors', noun: 'competitors', minWidth: '20rem' },
] as const
type TabKey = typeof TABS[number]['key']
type Tab = typeof TABS[number]

const whole = (value: number) => value.toLocaleString('en-US')
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
const LINK = `inline-flex items-center rounded-sm font-medium text-link hover:underline ${FOCUS} ${TOUCH}`
// A name too long for its column goes on to a second line, so two names that start alike can be told apart.
const NAME = 'line-clamp-2 break-words'
// As wide as its name and no wider than its cell, so the focus ring is the name's.
const ROW_LINK = `flex w-fit max-w-full min-w-0 items-center rounded-sm font-medium text-heading hover:underline ${FOCUS} ${TOUCH}`

// Every table fits a frame of 45rem, a tablet held upright. From there the frame does not scroll, so the
// header can stick under the topbar (`--settings-stick` is the Settings page's line for it). In a narrower
// frame the table scrolls sideways under its name column, which is opaque and has an edge: the row tint is
// drawn over the page colour, never in place of it.
const FRAME = 'overflow-x-auto @[45rem]:overflow-visible'
const HEAD = 'bg-bg @[45rem]:sticky @[45rem]:top-[var(--settings-stick,var(--topbar-h))] @[45rem]:z-[2]'
const NAME_COLUMN = 'sticky left-0 z-[1] bg-bg @max-[45rem]:border-r @max-[45rem]:border-r-subtle'
// A control that takes focus scrolls clear of what sticks above it: the topbar and the page's select, and for
// a row's control the table's own header too.
const CLEAR = '[&_:is(a,button,input)]:scroll-mt-[calc(var(--settings-stick,var(--topbar-h))+1rem)]'
const CLEAR_HEAD = '[&_tbody_a]:scroll-mt-[calc(var(--settings-stick,var(--topbar-h))+4rem)] [&_tbody_button]:scroll-mt-[calc(var(--settings-stick,var(--topbar-h))+4rem)]'
const ROW_HOVER = 'group-hover/row:bg-[image:linear-gradient(var(--color-surface),var(--color-surface))]'

interface Column<T> {
  key: string
  label: string
  /** A column of numbers: set to the right, and its first sort is largest first. */
  numeric?: boolean
  /** What the column sorts by. A column without it does not sort. */
  sortValue?: (row: T) => string | number | undefined
  cell: (row: T) => ReactNode
  /** Every column but the first has a width; the first takes the rest. */
  width?: string
}

/** A number as the server gave it. One it did not give prints nothing. */
const count = (value: number | undefined) => value === undefined ? null : whole(value)

const TIP = `cursor-help rounded-sm tabular-nums underline decoration-current/40 decoration-dotted underline-offset-4 hover:text-heading ${FOCUS} pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-md:min-h-11 max-md:min-w-11`

/** A list as one run of text: its first 25, a page of rows, then how many more. */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, DEFAULT_TABLE_PAGE_SIZE)
  return `${shown.join(' · ')}${items.length > shown.length ? ` · +${whole(items.length - shown.length)} more` : ''}`
}

/** What stands for a list on the page: a button that opens the whole list on hover, focus and tap, and is named by it. */
function ListButton({ items, one, many, className, children }: { items: readonly string[]; one: string; many: string; className: string; children: ReactNode }) {
  const text = listed(items)
  const bubble = useTooltipBubble(text, { placement: 'bottom' })
  return <>
    <button type="button" className={`${className} ${TIP}`} aria-label={`${whole(items.length)} ${items.length === 1 ? one : many}: ${text}`} {...bubble.wrapper} {...bubble.trigger}>
      {children}
    </button>
    {bubble.bubble}
  </>
}

/** The first name, then how many more: "Uptown +3". The count opens every name. A list the server sent empty says so, and one it did not send prints nothing. */
function NameList({ names, one, many }: { names: readonly string[] | undefined; one: string; many: string }) {
  if (!names) return null
  if (names.length === 0) return <span className="text-muted">{LOCATIONS_MARKETS_COPY.none}</span>
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={NAME}>{names[0]}</span>
      {names.length > 1 ? <ListButton items={names} one={one} many={many} className="inline-flex shrink-0 items-center justify-center text-secondary">+{whole(names.length - 1)}</ListButton> : null}
    </span>
  )
}

/** A count whose list opens on hover, focus and tap, and is read after it. */
function CountWithList({ items, one, many }: { items: readonly string[] | undefined; one: string; many: string }) {
  if (items === undefined) return null
  if (items.length === 0) return <>0</>
  return <ListButton items={items} one={one} many={many} className="inline-flex items-center justify-end">{whole(items.length)}</ListButton>
}

function locationColumns(projectName: string): Column<StructureLocation>[] {
  return [
    {
      key: 'location',
      label: 'Location',
      sortValue: row => row.label,
      cell: row => (
        <Link to="/projects/$projectName/properties/$targetKey" params={{ projectName, targetKey: row.key }} search={carryVisibilitySearch} className={ROW_LINK}>
          <span className={NAME}>{row.label}</span>
        </Link>
      ),
    },
    { key: 'markets', label: 'Markets', sortValue: row => row.markets?.length, cell: row => <NameList names={row.markets} one="market" many="markets" />, width: '21%' },
    { key: 'sitePages', label: 'Site pages', numeric: true, sortValue: row => row.sitePages?.length, cell: row => <CountWithList items={row.sitePages} one="site page" many="site pages" />, width: '6.25rem' },
    { key: 'names', label: 'Names', numeric: true, sortValue: row => row.names, cell: row => count(row.names), width: '5rem' },
    // The two long headers go on two lines, and the width they gave up is the name column's.
    { key: 'locationQueries', label: 'Location queries', numeric: true, sortValue: row => row.locationQueries, cell: row => count(row.locationQueries), width: '6rem' },
    { key: 'marketQueries', label: 'Market queries', numeric: true, sortValue: row => row.marketQueries, cell: row => count(row.marketQueries), width: '6rem' },
  ]
}

function marketColumns(projectName: string): Column<StructureMarket>[] {
  return [
    {
      key: 'market',
      label: 'Market',
      sortValue: row => row.label,
      cell: row => (
        <>
          <Link
            to="/projects/$projectName/queries"
            params={{ projectName }}
            search={previous => patchVisibilitySelection(carryVisibilitySearch(previous), { measurementScope: 'market', measurementScopeKey: row.key, queryWorkspace: 'tracked', trackingQueryId: undefined })}
            className={ROW_LINK}
          >
            <span className={NAME}>{row.label}</span>
          </Link>
          {/* One line of names, cut where the column ends: the Locations count opens them all. */}
          {row.members && row.members.length > 0 ? <p className="truncate text-[13px] text-secondary">{row.members.join(' · ')}</p> : null}
        </>
      ),
    },
    { key: 'group', label: 'Group', cell: row => row.group ? <span className={NAME}>{row.group}</span> : null, width: '14rem' },
    {
      key: 'locations',
      label: 'Locations',
      numeric: true,
      sortValue: row => row.locations,
      cell: row => row.locations === 0
        ? <StatusNote icon={AlertTriangle} tone="caution" label={LOCATIONS_MARKETS_COPY.noLocations} detail={LOCATIONS_MARKETS_COPY.noLocationsHelp} />
        : <CountWithList items={row.members} one="location" many="locations" />,
      width: '8.5rem',
    },
    { key: 'marketQueries', label: 'Market queries', numeric: true, sortValue: row => row.marketQueries, cell: row => count(row.marketQueries), width: '6rem' },
  ]
}

// The counts come before Parent, so the first screen of a narrow frame holds a number. A top-level group has
// no parent: it sorts as the empty name, so one click on Parent brings the top-level groups together, first.
const GROUP_COLUMNS: Column<StructureGroup>[] = [
  { key: 'group', label: 'Group', sortValue: row => row.label, cell: row => <span className={`${NAME} font-medium text-heading`}>{row.label}</span> },
  { key: 'locations', label: 'Locations', numeric: true, sortValue: row => row.locations, cell: row => count(row.locations), width: '6.5rem' },
  { key: 'markets', label: 'Markets', numeric: true, sortValue: row => row.markets, cell: row => count(row.markets), width: '6rem' },
  { key: 'competitors', label: 'Competitors', numeric: true, sortValue: row => row.competitors, cell: row => count(row.competitors), width: '7.5rem' },
  { key: 'parent', label: 'Parent', sortValue: row => row.parent ?? '', cell: row => row.parent ? <span className={NAME}>{row.parent}</span> : null, width: '12rem' },
]

const COMPETITOR_COLUMNS: Column<StructureCompetitor>[] = [
  { key: 'domain', label: 'Domain', sortValue: row => row.domain, cell: row => <span className={`${NAME} font-medium text-heading`}>{row.domain}</span> },
  { key: 'groups', label: 'Groups', numeric: true, sortValue: row => row.groups.length, cell: row => <CountWithList items={row.groups} one="group" many="groups" />, width: '6rem' },
]

/** One tab's rows: sorted by its own column, searched by the shared box, 25 to a page. */
function useStructureTable<T extends StructureRow>(rows: readonly T[], columns: readonly Column<T>[]) {
  const [sort, setSort] = useState<StructureSort>()
  const sorted = useMemo(
    () => sortStructureRows(rows, columns.find(column => column.key === sort?.key)?.sortValue, sort?.direction),
    [rows, columns, sort],
  )
  const table = useClientTable({ rows: sorted, getSearchText: searchOf })
  const sortBy = (column: Column<T>) => {
    setSort(nextStructureSort(sort, column.key, column.numeric === true))
    table.setPage(1)
  }
  return { columns, sort, sortBy, table, total: rows.length }
}
const searchOf = (row: StructureRow) => row.search

function StructureTable<T extends StructureRow>({ view, tab }: { view: ReturnType<typeof useStructureTable<T>>; tab: Tab }) {
  const { columns, sort, sortBy, table } = view
  return (
    <div className={FRAME}>
      <table aria-label={tab.label} className={`w-full table-fixed border-separate border-spacing-0 text-[13.5px] leading-5 text-neutral ${CLEAR_HEAD}`} style={{ minWidth: tab.minWidth }}>
        <colgroup>{columns.map(column => <col key={column.key} style={column.width ? { width: column.width } : undefined} />)}</colgroup>
        <thead>
          <tr>
            {columns.map(column => {
              const active = sort?.key === column.key
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={!column.sortValue ? undefined : !active ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending'}
                  className={`border-b border-default px-2.5 py-2 align-bottom text-[13px] font-medium text-secondary ${HEAD} ${column.numeric ? 'text-right' : 'text-left'} ${column.width ? '' : NAME_COLUMN}`}
                >
                  {column.sortValue ? (
                    // The mark sits on the side away from the column's edge, so a header and its values share that edge.
                    <button type="button" className={`group/sort flex w-fit cursor-pointer items-center gap-1 rounded-sm hover:text-heading ${FOCUS} ${TOUCH} ${column.numeric ? 'ml-auto flex-row-reverse' : ''}`} onClick={() => sortBy(column)}>
                      {column.label}
                      {active
                        ? <ChevronDown aria-hidden="true" className={`size-3 text-heading ${sort.direction === 'asc' ? 'rotate-180' : ''}`} />
                        : <ChevronsUpDown aria-hidden="true" className="size-3 opacity-0 group-hover/sort:opacity-40 group-focus-visible/sort:opacity-40" />}
                    </button>
                  ) : column.label}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="border-b border-subtle px-2.5 py-6">
                {view.total === 0
                  ? <StatusNote icon={Info} label={`No ${tab.noun}`} />
                  : <StatusNote icon={SearchX} label={LOCATIONS_MARKETS_COPY.noMatches} />}
              </td>
            </tr>
          ) : table.rows.map(row => (
            <tr key={row.key} className="group/row">
              {columns.map(column => (
                <td key={column.key} className={`border-b border-subtle px-2.5 py-2 align-middle ${ROW_HOVER} ${column.numeric ? 'text-right tabular-nums' : 'min-w-0'} ${column.width ? '' : NAME_COLUMN}`}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Pairs of cells on a phone, three columns from 36rem and one row from 44rem, by the section's own width.
const STAT_CELLS = [
  '',
  '@max-xl:pl-4 @xl:border-l @xl:pl-4',
  '@max-xl:border-t @xl:border-l @xl:pl-4',
  '@max-xl:border-t @max-xl:pl-4 @xl:@max-[44rem]:border-t @[44rem]:border-l @[44rem]:pl-4',
  '@max-xl:col-span-2 @max-xl:border-t @xl:border-l @xl:border-t @xl:pl-4 @[44rem]:border-t-0',
] as const
const STAT_GRID = 'grid grid-cols-2 border-y border-default @xl:grid-cols-3 @[44rem]:grid-cols-5'
const STAT_CELL = 'min-w-0 border-subtle py-3 pr-4'
const STAT_LABEL = 'text-[13px] leading-5 text-secondary'
const STAT_NUMBER = 'flex min-h-7 flex-wrap items-baseline gap-x-2 text-[19px] font-semibold leading-7 tabular-nums text-heading'
const STAT_ASIDE = 'text-[13px] font-normal text-secondary'

function Stat({ index, label, value, children }: { index: number; label: string; value: number; children?: ReactNode }) {
  return (
    <div className={`${STAT_CELL} ${STAT_CELLS[index]}`}>
      <dt className={STAT_LABEL}>{label}</dt>
      <dd className={STAT_NUMBER}>{whole(value)}{children}</dd>
    </div>
  )
}

function Structure({ projectName, workspace, plan, hasDraft, onOpenSetup }: {
  projectName: string
  workspace: QueryTrackingWorkspaceResponse
  plan: Extract<NonNullable<MeasurementPlanResponse['active']>['plan'], { schemaVersion: 2 }> | null
  hasDraft: boolean
  onOpenSetup?: () => void
}) {
  const [tabKey, setTab] = useState<TabKey>('locations')
  const tab = TABS.find(item => item.key === tabKey)!
  const tabsId = useId()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const structure = useMemo(() => projectStructure(workspace, plan), [workspace, plan])
  const views = {
    locations: useStructureTable(structure.locations, useMemo(() => locationColumns(projectName), [projectName])),
    markets: useStructureTable(structure.markets, useMemo(() => marketColumns(projectName), [projectName])),
    groups: useStructureTable(structure.groups, GROUP_COLUMNS),
    competitors: useStructureTable(structure.competitors, COMPETITOR_COLUMNS),
  }
  // One search box: every tab holds the same text, so a place can be followed from tab to tab.
  const { table } = views[tabKey]
  const setQuery = (value: string) => {
    views.locations.table.setQuery(value)
    views.markets.table.setQuery(value)
    views.groups.table.setQuery(value)
    views.competitors.table.setQuery(value)
  }
  const onTabKeyDown = (event: KeyboardEvent, index: number) => {
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null
    if (next === null) return
    event.preventDefault()
    const target = (next + TABS.length) % TABS.length
    setTab(TABS[target]!.key)
    tabRefs.current[target]?.focus()
  }
  const totals = workspace.summary?.structure

  return (
    <div className="@container mt-3">
      {totals ? (
        <dl className={STAT_GRID}>
          <Stat index={0} label="Locations" value={totals.targets} />
          <Stat index={1} label="Markets" value={totals.markets} />
          <Stat index={2} label="Groups" value={totals.groups}><span className={STAT_ASIDE}>{whole(totals.topLevelGroups)} top-level</span></Stat>
          <Stat index={3} label="Competitors" value={totals.competitors} />
          <Stat index={4} label="Open drafts" value={hasDraft ? 1 : 0}>
            {hasDraft && onOpenSetup ? <button type="button" className={`${LINK} text-[13px]`} onClick={onOpenSetup}>{LOCATIONS_MARKETS_COPY.openDraft}</button> : null}
          </Stat>
        </dl>
      ) : null}
      {/* The tabs sit on the rule and scroll under it, so four tabs never widen a narrow page. */}
      <div className="mt-2 border-b border-default">
        <div className="-mb-px flex overflow-x-auto" role="tablist" aria-label={LOCATIONS_MARKETS_COPY.heading}>
          {TABS.map((item, index) => (
            <button
              key={item.key}
              ref={element => { tabRefs.current[index] = element }}
              type="button"
              role="tab"
              id={`${tabsId}-${item.key}-tab`}
              aria-selected={tabKey === item.key}
              aria-controls={`${tabsId}-panel`}
              tabIndex={tabKey === item.key ? 0 : -1}
              className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${TOUCH} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mono-500 ${tabKey === item.key ? 'border-mono-400 text-heading' : 'border-transparent text-muted hover:border-strong hover:text-strong'}`}
              onClick={() => setTab(item.key)}
              onKeyDown={event => onTabKeyDown(event, index)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tabKey}-tab`}>
        <div className="my-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <DataTableSearch size="sm" value={table.query} onChange={setQuery} label={LOCATIONS_MARKETS_COPY.search} placeholder={LOCATIONS_MARKETS_COPY.search} className="w-full @xl:w-80" />
          {/* Ahead of the table, so the next page is a Tab or two from the search and not a page of rows away. */}
          <DataTablePagination
            page={table.page}
            pageSize={table.pageSize}
            visibleRows={table.rows.length}
            totalRows={table.totalRows}
            onPageChange={table.setPage}
            itemLabel={tab.noun}
            className="mt-0! grow pointer-coarse:[&_button]:min-h-11 max-md:[&_button]:min-h-11"
          />
        </div>
        {tabKey === 'locations' ? <StructureTable view={views.locations} tab={tab} /> : null}
        {tabKey === 'markets' ? <StructureTable view={views.markets} tab={tab} /> : null}
        {tabKey === 'groups' ? <StructureTable view={views.groups} tab={tab} /> : null}
        {tabKey === 'competitors' ? <StructureTable view={views.competitors} tab={tab} /> : null}
      </div>
    </div>
  )
}

/** The section while its reads are out: the number grid and a page of rows where a published setup is known, one line where it is not. */
function StructureSkeleton({ full }: { full: boolean }) {
  return (
    <div role="status" className="@container mt-3">
      <span className="sr-only">Loading</span>
      {full ? (
        <div aria-hidden="true">
          <div className={STAT_GRID}>
            {STAT_CELLS.map((cell, index) => (
              <div key={index} className={`${STAT_CELL} ${cell}`}>
                <div className="flex h-5 items-center"><div className="skeleton-text w-20 max-w-full" /></div>
                <div className="flex h-7 items-center"><div className="skeleton-text h-4 w-10" /></div>
              </div>
            ))}
          </div>
          <div className="mt-2 h-[2.375rem] border-b border-default" />
          <div className="my-3 h-8 max-w-xs skeleton" />
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex h-9 items-center border-b border-subtle px-2.5"><div className="skeleton-text w-1/3" /></div>
          ))}
        </div>
      ) : <div aria-hidden="true" className="h-9 w-32 skeleton" />}
    </div>
  )
}

/**
 * Settings, "Locations & markets": what a project's published setup holds, to
 * read. An advanced project gets its numbers and four tables (locations,
 * markets, groups, competitors); a project with no published setup gets the
 * title and the one button that opens setup, or for a viewer the words that
 * nothing is there. The numbers are fields of the workspace read
 * (`summary.structure`) and of the setup read; the tables join the workspace
 * read and the published plan by stable key. Nothing here writes: a writer's
 * Bulk setup and Open draft open the setup wizard, and a viewer reads the same
 * tables with no button.
 */
export function LocationsMarketsSection({ projectName, setup, plan, setupFailed, planFailed, onRetryReads, onOpenSetup }: {
  projectName: string
  /** The setup read the page holds; `undefined` while it is out. */
  setup: MeasurementSetupResponse | undefined
  /** The published plan the page holds; `undefined` while it is out. */
  plan: MeasurementPlanResponse | undefined
  /** The setup read failed and left nothing to show. */
  setupFailed: boolean
  /** The plan read failed and left nothing to show. */
  planFailed: boolean
  /** Reads the page's two reads again. */
  onRetryReads: () => void
  /** Opens the setup wizard. */
  onOpenSetup: () => void
}) {
  const { canWrite } = useAccount()
  const headingId = useId()
  const advanced = setup?.activeSchemaVersion === 2
  // The same key the Queries tab reads, so the two share one request.
  const workspaceQuery = useQuery({
    ...getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } }),
    enabled: advanced,
  })
  const workspace = workspaceQuery.data
  const workspaceFailed = advanced && workspaceQuery.isError && workspace === undefined
  // Only a published setup is read from the plan: a project without one needs the setup read alone.
  const failed = setupFailed || (advanced && planFailed) || workspaceFailed
  const loading = !failed && (setup === undefined || (advanced && (plan === undefined || workspace === undefined)))
  const activePlan = plan?.active?.plan
  const ready = !failed && !loading && setup !== undefined

  return (
    <section className={`page-section-divider ${CLEAR}`} aria-labelledby={headingId}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* The tooltip is a sibling of the heading, so its sentence stays out of the heading's name. */}
        <div className="flex items-center gap-1.5">
          <h2 id={headingId} className="text-lg font-semibold text-heading">{LOCATIONS_MARKETS_COPY.heading}</h2>
          {ready && !advanced ? <InfoTooltip text={LOCATIONS_MARKETS_COPY.help} /> : null}
        </div>
        {!ready ? null : !canWrite ? <ViewOnlyNote /> : advanced
          ? <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onOpenSetup}>{LOCATIONS_MARKETS_COPY.bulkSetup}</Button>
          : null}
      </div>
      {failed ? (
        <div role="alert" className="mt-3">
          <StatusNote
            icon={AlertTriangle}
            tone="caution"
            label={LOCATIONS_MARKETS_COPY.loadError}
            detail={LOCATIONS_MARKETS_COPY.loadErrorHelp}
            action={(
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={TOUCH}
                onClick={() => {
                  if (setupFailed || planFailed) onRetryReads()
                  if (workspaceFailed) void workspaceQuery.refetch()
                }}
              >
                {LOCATIONS_MARKETS_COPY.retry}
              </Button>
            )}
          />
        </div>
      ) : !ready ? (
        <StructureSkeleton full={advanced} />
      ) : advanced && workspace ? (
        <Structure
          projectName={projectName}
          workspace={workspace}
          plan={activePlan?.schemaVersion === 2 ? activePlan : null}
          hasDraft={setup.draft !== null}
          onOpenSetup={canWrite ? onOpenSetup : undefined}
        />
      ) : canWrite ? (
        <div className="mt-3">
          <Button type="button" variant="outline" className={TOUCH} onClick={onOpenSetup}>
            {setupActionLabel(setup)}
          </Button>
        </div>
      ) : setup.activeSchemaVersion === null ? (
        // Nothing is published, so a viewer has nothing to read here, and the section says so.
        <div className="mt-3"><StatusNote icon={Info} label={LOCATIONS_MARKETS_COPY.noLocations} /></div>
      ) : null}
    </section>
  )
}

/** A project with no published setup keeps the wizard's own words for a draft or a republish; starting one is "Add locations". */
function setupActionLabel(setup: MeasurementSetupResponse): string {
  const action = resolveAdvancedMeasurementMode({ activePlanSchemaVersion: setup.activeSchemaVersion, hasDraft: setup.draft !== null }).setupAction
  return action === 'set-up' ? LOCATIONS_MARKETS_COPY.addLocations : advancedMeasurementSetupActionLabel(action)
}
