import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CirclePause, Clock, Copy, Download, Inbox, Info, MapPinOff, Plus, SearchX } from 'lucide-react'
import type { QueryClass, QueryTrackingWorkspaceResponse } from '@canonry/canonry-contracts'
import { getApiV1ProjectsByNameQueryTrackingQueryKey } from '@canonry/canonry-api-client/react-query'

import { heyClient, isAeroPreview, isEmbed, shouldShowDashboardAgentBar } from '../../../../api.js'
import { useAccount } from '../../../../contexts/account-context.js'
import { usePublishAeroView } from '../../../../contexts/aero-view-context.js'
import { addToast } from '../../../../lib/toast-store.js'
import { trackUiAction } from '../../../../lib/ui-telemetry.js'
import { WriteButton } from '../../../shared/AccessControls.js'
import { aeroAllowedFor } from '../../../shared/AeroBar.js'
import { formatObservedInstantMonthDay, observedInstant } from '../../../shared/ChartPrimitives.js'
import { DataTablePagination } from '../../../shared/DataTableControls.js'
import { SignalLetterLegend } from '../../../shared/SignalCells.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import { Card } from '../../../ui/card.js'
import type { TrackedPageHostProps } from '../../DiscoverySection.js'
import { expectedSubject, TrackingReview } from '../../TrackingReview.js'
import { MARKET_SCOPE_COPY } from '../../VisibilityScopePicker.js'
import { VISIBILITY_SCOPE_RECOVERY_COPY, VISIBILITY_TOOLBAR_COPY } from '../../VisibilityTrendSection.js'
import { useAddQueriesNavigation } from '../AddQueriesEntry.js'
import { AddTrackedQueriesPage } from './AddTrackedQueriesPage.js'
import { TrackingComposer } from '../TrackingComposer.js'
import { assignmentMatchesSelection } from '../tracked-rows.js'
import { contextInput, contextLabel, contextLabels, searchLocationNames, uniqueContextInputs } from '../tracking-contexts.js'
import { useTrackedGroups, useTrackedResults } from '../use-tracked-results.js'
import type { TrackedQueriesPageProps, TrackingComposerState } from '../use-tracking-composer.js'
import { TrackedActionSheet, type TrackedSheetAction } from './TrackedActionSheet.js'
import { TrackedBulkBar, type TrackedBulkAction } from './TrackedBulkBar.js'
import { TrackedMarkets, type TrackedMarketOrder } from './TrackedMarkets.js'
import { TrackedPlaceList } from './TrackedPlaceList.js'
import { TrackedRowAnswers } from './TrackedRowAnswers.js'
import { TrackedRowMenu } from './TrackedRowMenu.js'
import { TrackedSavedViews, trackedPlaceView, type TrackedSavedView } from './TrackedSavedViews.js'
import { TrackedSummaryGrid, type TrackedResultsState, type TrackedSummaryPlace } from './TrackedSummaryGrid.js'
import { TrackedTable, TrackedTableSkeleton } from './TrackedTable.js'
import { TrackedToolbar } from './TrackedToolbar.js'
import { canChangeType, TRACKED_BULK_MAX, type TrackedPlace } from './tracked-actions.js'
import { downloadTrackedCsv, trackedMarketsCsv, trackedRowsCsv } from './tracked-export.js'
import { activeFilterCount, clearedTrackedFilters, matchesTrackedFilters, trackedFiltersPatch, type TrackedResultCell } from './tracked-filters.js'
import type { TrackedFilters, TrackedRowAction, TrackedRowVm, TrackedType } from './tracked-types.js'
import { DEFAULT_TRACKED_SORT, marksSubject, NOT_ASKED, resultClasses, resultSortOrder, rowSignal, sortTrackedRows, toTrackedRows, type TrackedCoverage, type TrackedSort } from './tracked-view-model.js'

type PageProps = TrackedQueriesPageProps & TrackedPageHostProps & { composer: TrackingComposerState }

const PAGE_SIZES = [25, 50, 100] as const
/** One page is as many rows as one change takes, so "Select this page" never passes the limit. */
const DEFAULT_PAGE_SIZE = TRACKED_BULK_MAX
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
const COPY = {
  resultsUnavailable: "The last sweep's results did not load, so every chip reads Not checked.",
  mixedSelection: 'Queries that are asked and queries that are not take different actions. Select one kind.',
}

/** The Place as the strip reads it (the workspace entry, server counts and all) and as an action narrows to it. */
type Place = { summary: TrackedSummaryPlace; narrow: TrackedPlace }

function placeOf(workspace: QueryTrackingWorkspaceResponse, scope: string, key: string | undefined): Place | undefined {
  if (scope === 'market') {
    const market = workspace.markets.find(candidate => candidate.stableKey === key)
    return market && { summary: { kind: 'market', market }, narrow: { kind: 'market', key: market.stableKey, label: market.label } }
  }
  if (scope === 'property') {
    const target = workspace.targets.find(candidate => candidate.stableKey === key)
    return target && { summary: { kind: 'location', target }, narrow: { kind: 'location', key: target.stableKey, label: target.label } }
  }
  if (scope === 'group') {
    const group = workspace.groups.find(candidate => candidate.stableKey === key)
    return group && { summary: { kind: 'group', group }, narrow: { kind: 'group', key: group.stableKey, label: group.label } }
  }
  return undefined
}

/** A row's engine cells for the Result and Change filters, one per engine and type it is asked on. A query that is not asked has none. */
function resultCells(row: TrackedRowVm, engines: readonly string[], coverage: TrackedCoverage | undefined): TrackedResultCell[] {
  return engines.flatMap(engine => resultClasses(row).flatMap(queryClass => {
    const signal = rowSignal(row, coverage, queryClass, engine)
    return signal === NOT_ASKED ? [] : [{ queryClass: queryClass as QueryClass, provider: engine, signal }]
  }))
}

/** The ways a portfolio's page can list, as the Group control names them. */
const GROUPINGS = {
  market: { value: 'market', label: 'Market' },
  group: { value: 'group', label: 'Market group' },
  none: { value: 'none', label: 'None' },
} as const
/** The orders of the query list. A header sort is the last, named for what it is. */
const LIST_ORDERS = [{ value: 'winning', label: 'Winning first' }, { value: 'losing', label: 'Losing first' }, { value: 'query', label: 'Query' }, { value: 'subject', label: 'Subject' }] as const
const MARKET_ORDERS = [{ value: 'losing', label: 'Losing first' }, { value: 'winning', label: 'Winning first' }, { value: 'name', label: 'Name' }] as const
/** The query list's sort as a Sort choice, and back. */
function orderOf(sort: TrackedSort): string {
  if (sort.key === 'result') return sort.direction === 'desc' ? 'winning' : 'losing'
  if ((sort.key === 'query' || sort.key === 'subject') && sort.direction === 'asc') return sort.key
  return 'column'
}
function sortOf(order: string, current: TrackedSort): TrackedSort {
  if (order === 'winning') return { key: 'result', direction: 'desc' }
  if (order === 'losing') return { key: 'result', direction: 'asc' }
  if (order === 'query' || order === 'subject') return { key: order, direction: 'asc' }
  return current
}

/** The Place control in the project's header, which is outside this page. Choosing a place from it leaves the focus on it. */
const placeControl = () => document.querySelector<HTMLElement>('summary.visibility-scope-trigger')

/** The search reads the query and the place it is about, so a market or a location finds its queries by name. */
const searchText = (row: TrackedRowVm) => `${row.queryText} ${row.subject.kind === 'market' || row.subject.kind === 'location' ? row.subject.label : ''}`.toLocaleLowerCase()

/** The router reads a search value as JSON where it parses as JSON, so an id that would is quoted, as the router writes it. */
function searchParamValue(value: string): string {
  try {
    JSON.parse(value)
    return JSON.stringify(value)
  } catch {
    return value
  }
}

/**
 * Tracked queries on an advanced project: the number strip, the saved views,
 * the toolbar, the table with its row menu, the bulk bar, and the sheets every
 * change goes through. Add queries has its own route; saved Research hand-offs may still open the
 * existing composer below the table.
 *
 * Rows come from the workspace the gate read. The last sweep's Mentioned and
 * Cited come from one results read for the Place. Every number in the strip is
 * a server field; here rows are only listed, searched, sorted and paged. The
 * filters are the URL's own keys, so the query type AI Visibility is set to
 * never narrows this list. A `trackingQueryId` in the URL marks a row: the
 * table opens on its page with its detail open. It never opens a form.
 *
 * The saved views are the whole project's, so they show with no Place chosen.
 * Each prints the server's count. Four of them (the URL's `trackedView`) list
 * locations, markets or patterns in place of the queries; two set a filter.
 * A market's or a location's name in such a list opens its queries: the
 * Place, on a clean list. A link to a row and a view are never both drawn:
 * the link wins, and choosing a view drops the link.
 */
export function AdvancedTrackedPage(props: PageProps) {
  const { onSelectionChange, rootLabel = MARKET_SCOPE_COPY.allLocations } = props
  // "Show all" takes its own button off the page, so it leaves word for the list that follows to take the focus.
  const showingAll = useRef(false)
  const showAll = () => {
    showingAll.current = true
    onSelectionChange?.({ measurementScope: 'project', measurementScopeKey: undefined })
  }
  if (props.addQueriesPage) return <AddTrackedQueriesPage {...props} />
  if (props.composer.unavailableScope) {
    return (
      // Centred, as the page's empty states are.
      <div className="query-tracking-workspace"><section aria-label="Tracked queries" className="py-8 text-center">
        <StatusNote
          icon={AlertTriangle}
          tone="caution"
          label={VISIBILITY_SCOPE_RECOVERY_COPY.retiredScope}
          detail={VISIBILITY_SCOPE_RECOVERY_COPY.retiredScopeHelp(rootLabel)}
          action={<Button type="button" variant="outline" size="sm" className={TOUCH} aria-label={VISIBILITY_SCOPE_RECOVERY_COPY.showRoot(rootLabel)} onClick={showAll}>{VISIBILITY_SCOPE_RECOVERY_COPY.showWholeSite}</Button>}
        />
      </section></div>
    )
  }
  return <TrackedPage {...props} rootLabel={rootLabel} showAll={showAll} showingAll={showingAll} />
}

function TrackedPage({
  projectName, workspace, selection, onSelectionChange, trackingQueryId, templates, preview, publishError, isPreviewing, isCommitting, onPreview,
  trackedFilters: filters, onTrackedFiltersChange, trackedView, trackingChangedAt, nextSweepDate, rootLabel, actionsSlot, composer, showAll, showingAll,
}: PageProps & { rootLabel: string; showAll: () => void; showingAll: RefObject<boolean> }) {
  const { action, draft, setDraft, reviewedMutation, setReviewedMutation, editorHeadingRef, closeAction, mutation, canReview, sweepActive, commitReviewed } = composer
  // A market selected in the full composer is just as explicit as one selected
  // in the sheet. Use expanded preview text so templates and saved ideas also
  // keep that Subject when the classifier recognises a location name.
  const expectedSubjects = preview && !draft.wholeSite && draft.targetKeys.length === 0 && draft.groupKeys.length === 0 && draft.marketKeys.length === 1
    ? [...preview.diff.added, ...preview.diff.reused].map(row => expectedSubject(row.queryText, { kind: 'market', key: draft.marketKeys[0]! }, workspace))
    : undefined
  const { canWrite, isAdmin, account } = useAccount()
  const queryClient = useQueryClient()
  const embedded = isEmbed()
  const canEdit = canWrite && !embedded
  const { measurementScope, measurementScopeKey } = selection
  const place = useMemo(() => placeOf(workspace, measurementScope, measurementScopeKey), [workspace, measurementScope, measurementScopeKey])
  const { signal } = filters

  const [search, setSearch] = useState('')
  const [sort, setSortState] = useState<TrackedSort>(DEFAULT_TRACKED_SORT)
  // The read keeps the last Result order it was asked for, so a sort by a header reorders the rows already read.
  const [readOrder, setReadOrder] = useState<'winning' | 'losing'>('winning')
  const setSort = (next: TrackedSort) => {
    setSortState(next)
    const order = resultSortOrder(next)
    if (order) setReadOrder(order)
  }
  const [marketOrder, setMarketOrder] = useState<TrackedMarketOrder>('losing')
  const [openedMarket, setOpenedMarket] = useState<{ kind: 'market' | 'group'; key: string } | null>(null)
  // Markets are listed for the whole project or one group; a market or a location lists its queries. A linked row is in the query list.
  const marketsHere = workspace.markets.length > 0 && (measurementScope === 'project' || measurementScope === 'group')
  const groupsOfMarkets = measurementScope === 'project' && workspace.markets.some(market => market.groupKey !== undefined)
  const linkedRow = trackingQueryId !== undefined && workspace.tracked.some(row => row.queryId === trackingQueryId)
  const wanted = filters.group === 'auto' ? 'market' : filters.group
  const grouping = !marketsHere || linkedRow || wanted === 'none' ? 'none' : wanted === 'group' && !groupsOfMarkets ? 'market' : wanted
  const listing = grouping === 'none'
  const results = useTrackedResults(projectName, selection, { signal, sort: readOrder, compare: true, enabled: listing })
  const grouped = useTrackedGroups(projectName, selection, { grouping: grouping === 'none' ? 'market' : grouping, signal, sort: marketOrder === 'name' ? undefined : marketOrder, enabled: !listing })
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [sheet, setSheet] = useState<{ action: TrackedSheetAction; rows: readonly TrackedRowVm[] } | null>(null)
  const { openAddPage: navigateToAdd } = useAddQueriesNavigation(projectName)
  const toolbar = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const bulkBarId = useId()
  // The search of whichever list is up: the queries', or a saved view's own.
  const searchField = () => (toolbar.current ?? list.current)?.querySelector<HTMLInputElement>('input[type="search"]')
  // The list's first control: Select this page, or the first header where there is nothing to select. The page stays where it is scrolled to.
  const focusList = () => list.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true })

  // The engines the project asks and the engines the read swept, from whichever read is up.
  const sweptEngines = listing ? results.engines : grouped.data?.engines
  const engines = useMemo(() => [...new Set([...workspace.defaultContexts.flatMap(context => context.providers), ...sweptEngines ?? []])], [workspace.defaultContexts, sweptEngines])
  const rowContextLabels = useMemo(() => searchLocationNames(workspace), [workspace])
  const allRows = useMemo(() => toTrackedRows(workspace, templates), [workspace, templates])

  // A link opens the table on its row, so no view is drawn over a row the URL names.
  const linked = trackingQueryId !== undefined && allRows.some(row => row.queryId === trackingQueryId)
  // The saved views are the whole project's: the server lists them for no place, and a place has its own strip and list.
  const views = place ? undefined : workspace.views
  const view = views && !linked ? trackedPlaceView(trackedView) : undefined
  // A place lists the queries asked for it. One that is asked nowhere belongs to no place, so it shows for the whole project only.
  // Each is listed under the types it is asked under there, as the results for the place hold them: a query asked both ways
  // across the project and one way here has one pair of chips here, not a second pair no sweep will fill.
  const placeRows = useMemo(() => {
    if (!place) return allRows
    const within = { measurementScope, measurementScopeKey, queryClass: 'all' as const }
    return allRows.flatMap(row => {
      const here = row.tracked.assignments.filter(assignment => assignmentMatchesSelection(assignment, within)).map(assignment =>
        measurementScope === 'market' && assignment.classifiedContexts
          ? { ...assignment, classifiedContexts: assignment.classifiedContexts.filter(context => context.marketKeys.includes(measurementScopeKey ?? '')) }
          : assignment,
      )
      if (here.length === 0) return []
      const queryClasses = [...new Set(here.flatMap(assignment => assignment.classifiedContexts?.map(context => context.queryClass) ?? assignment.queryClass ?? []))].sort()
      const type: TrackedType = queryClasses.length === 0 ? 'not-set' : queryClasses.length === 1 ? queryClasses[0]! : 'mixed'
      return [{ ...row, queryClasses, type, displayAssignments: here }]
    })
  }, [allRows, place, measurementScope, measurementScopeKey])
  const tokens = useMemo(() => search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean), [search])
  // A Result filter lists by the chips, so until the results are read there is no list yet: neither rows nor an empty state.
  const awaitingResults = (filters.result !== 'any' || filters.change !== 'any') && results.coverage === undefined
  const listed = useMemo(() => {
    const matches = (row: TrackedRowVm, by: TrackedFilters) => matchesTrackedFilters(row, by, by.result === 'any' && by.change === 'any' ? [] : resultCells(row, engines, results.coverage))
      && (tokens.length === 0 || tokens.every(token => searchText(row).includes(token)))
    return {
      rows: placeRows.filter(row => matches(row, filters)),
      // Rows the default Status leaves out that the search and the other filters would list.
      hiddenNotAsked: filters.status === 'asked' && placeRows.some(row => row.status === 'not-asked' && matches(row, { ...filters, status: 'not-asked' })),
    }
  }, [placeRows, filters, tokens, engines, results.coverage])
  const sorted = useMemo(() => sortTrackedRows(listed.rows, sort, results.coverage, results.rank, signal), [listed.rows, sort, results.coverage, results.rank, signal])
  // Whose mention or citation a row's marks are here: the locations it is asked for in the Place, as the results read them.
  const marksFor = useMemo(() => {
    const targetLabels = new Map(workspace.targets.map(target => [target.stableKey, target.label]))
    return (row: TrackedRowVm, queryClass: string) => marksSubject(row, row.displayAssignments ?? row.tracked.assignments, targetLabels, queryClass)
  }, [workspace.targets])
  // A location's name by its key, for the locations an answer mentions.
  const targetLabel = useMemo(() => {
    const labels = new Map(workspace.targets.map(target => [target.stableKey, target.label]))
    return (key: string) => labels.get(key) ?? key
  }, [workspace.targets])

  // The page number belongs to one list: another search, filter, place, order or page size starts at the first page.
  const listKey = JSON.stringify([filters, search, measurementScope, measurementScopeKey, sort, pageSize])
  const [paging, setPaging] = useState({ key: listKey, page: 1 })
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const page = Math.min(paging.key === listKey ? paging.page : 1, totalPages)
  const pageRows = useMemo(() => sorted.slice((page - 1) * pageSize, page * pageSize), [sorted, page, pageSize])

  // A linked row opens on its own page, once per link: after that the pages are the reader's.
  // A link to a row the place, the filters or the search leave out widens them first, once per link, so the row is listed:
  // a copied link outlives the status its row had.
  const linkedIndex = trackingQueryId ? sorted.findIndex(row => row.queryId === trackingQueryId) : -1
  const shownLink = useRef<string | null>(null)
  const widenedLink = useRef<string | null>(null)
  useEffect(() => {
    if (!trackingQueryId) {
      shownLink.current = null
      widenedLink.current = null
      return
    }
    if (shownLink.current === trackingQueryId) return
    if (linkedIndex >= 0) {
      shownLink.current = trackingQueryId
      setPaging({ key: listKey, page: Math.floor(linkedIndex / pageSize) + 1 })
      return
    }
    if (awaitingResults || widenedLink.current === trackingQueryId) return
    const linked = allRows.find(row => row.queryId === trackingQueryId)
    if (!linked) return
    widenedLink.current = trackingQueryId
    setSearch('')
    onTrackedFiltersChange(clearedTrackedFilters(filters, linked.status === 'not-asked' ? { status: 'all' } : {}))
    if (!placeRows.some(row => row.queryId === trackingQueryId)) onSelectionChange?.({ measurementScope: 'project', measurementScopeKey: undefined })
  }, [trackingQueryId, linkedIndex, listKey, pageSize, awaitingResults, allRows, placeRows, filters, onTrackedFiltersChange, onSelectionChange])

  // A row the search or the filters no longer list leaves the selection, so no change reaches a row out of sight.
  // While a Result filter waits for the results nothing is listed yet, and the selection waits with it.
  const selectedRows = useMemo(() => sorted.filter(row => selectedIds.has(row.queryId)), [sorted, selectedIds])
  useEffect(() => {
    if (!awaitingResults && selectedRows.length !== selectedIds.size) setSelectedIds(new Set(selectedRows.map(row => row.queryId)))
  }, [awaitingResults, selectedRows, selectedIds])

  // The view leaves the URL too, so it is not waiting behind the linked row. The address with both was never a page
  // of its own, so its history entry is replaced: Back leaves the page, and is not sent forward from it again.
  useEffect(() => {
    if (linked && trackedView !== undefined) onSelectionChange?.({ trackedView: undefined }, { replace: true })
  }, [linked, trackedView, onSelectionChange])

  // A view lists places in place of the queries, so no query stays ticked behind it.
  useEffect(() => {
    if (view) setSelectedIds(previous => previous.size === 0 ? previous : new Set<string>())
  }, [view])

  // "Back to queries" takes its own button off the page: once the queries are back, their search takes the focus it dropped.
  const closingView = useRef(false)
  const closeView = () => {
    closingView.current = true
    onSelectionChange?.({ trackedView: undefined })
  }
  useEffect(() => {
    if (!closingView.current || view) return
    closingView.current = false
    if (document.activeElement === document.body) (searchField() ?? list.current?.querySelector<HTMLElement>('input, button'))?.focus({ preventScroll: true })
  }, [view])

  // A name in a view's list opens the queries of that market or location: the Place picker's own patch, which also
  // closes the view and clears the filters, the URL's own keys. It is one patch, so the browser's Back returns to
  // the view's list. The name goes with its list: once the place is up, the Place control takes the focus, where
  // choosing a place from it leaves it.
  const openingPlace = useRef(false)
  const openPlace = (to: TrackedPlace) => {
    openingPlace.current = true
    setSearch('')
    onSelectionChange?.({ measurementScope: to.kind === 'location' ? 'property' : to.kind, measurementScopeKey: to.key, trackedView: undefined, ...trackedFiltersPatch(clearedTrackedFilters(filters)) })
  }
  useEffect(() => {
    if (!openingPlace.current || view || measurementScope === 'project') return
    openingPlace.current = false
    if (document.activeElement === document.body) (placeControl() ?? searchField() ?? list.current?.querySelector<HTMLElement>('input, button'))?.focus()
  }, [view, measurementScope, measurementScopeKey])

  // "Show all" took its own button off the page: once the place has changed, the search takes the focus it dropped.
  useEffect(() => {
    if (!showingAll.current) return
    showingAll.current = false
    if (document.activeElement === document.body) searchField()?.focus()
  }, [showingAll, measurementScope, measurementScopeKey])

  // A sheet hands the focus back to what opened it. When that has left the page, as the bar does once its rows are changed, the list takes it.
  const sheetOpen = sheet !== null
  const sheetWasOpen = useRef(false)
  useEffect(() => {
    const closed = sheetWasOpen.current && !sheetOpen
    sheetWasOpen.current = sheetOpen
    if (!closed) return
    // After the sheet's own hand-back, which waits a tick.
    const timer = setTimeout(() => { if (document.activeElement === document.body) focusList() })
    return () => clearTimeout(timer)
  }, [sheetOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      // A key typed into a field, or pressed in a sheet or a menu, is theirs.
      if (target?.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      if (event.key === '/') {
        const field = searchField()
        if (!field) return
        event.preventDefault()
        field.focus()
      }
      // Escape in the toolbar closes its filters panel.
      if (event.key === 'Escape' && !toolbar.current?.contains(target)) {
        // The bar goes with the selection, so focus inside it moves to the list.
        if (target && document.getElementById(bulkBarId)?.contains(target)) focusList()
        setSelectedIds(previous => previous.size === 0 ? previous : new Set<string>())
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [bulkBarId])

  // The Add queries page starts on the Place when it is one market or one location. A market with no location left takes no query, so it is not offered.
  const addTo = place?.summary.kind === 'location' || (place?.summary.kind === 'market' && place.summary.market.targetKeys?.length !== 0) ? place.narrow : undefined
  const addLabel = addTo?.kind === 'market' ? 'Add market query' : addTo?.kind === 'location' ? 'Add location query' : 'Add queries'
  const adding = action?.kind === 'add'
  function openAddPage(rows?: readonly TrackedRowVm[], to = addTo) {
    if (isCommitting) return
    navigateToAdd({ market: to?.kind === 'market' ? to.key : undefined, location: to?.kind === 'location' ? to.key : undefined, queryIds: rows?.map(row => row.queryId) })
  }

  // The list as it is filtered, searched and sorted, over every page, and named for what narrowed it.
  // Telemetry hears that a file was taken, and none of its text.
  function exportCsv() {
    if (listing) downloadTrackedCsv(projectName, trackedRowsCsv(sorted, engines, results.coverage, marksFor), { placeKey: place?.narrow.key, filtered: narrowed })
    else if (grouped.data?.groups) downloadTrackedCsv(projectName, trackedMarketsCsv(grouped.data.groups, engines), { placeKey: place?.narrow.key, filtered: tokens.length > 0, kind: grouping === 'group' ? 'market-groups' : 'markets' })
    trackUiAction('export.download', { format: 'csv' })
  }

  async function copyLink(row: TrackedRowVm) {
    const url = new URL(window.location.href)
    // The link is to the row, so a view the address still holds is left out of it.
    url.searchParams.delete('trackedView')
    url.searchParams.set('trackingQueryId', searchParamValue(row.queryId))
    try {
      await navigator.clipboard.writeText(url.toString())
      addToast({ title: 'Link copied', tone: 'positive', dedupeKey: 'tracked-query:copy-link', dedupeMode: 'replace' })
    } catch {
      addToast({ title: 'Could not copy', tone: 'negative', dedupeKey: 'tracked-query:copy-link', dedupeMode: 'replace' })
    }
  }

  function act(rowAction: TrackedRowAction, rows: readonly TrackedRowVm[]) {
    if (isCommitting) return
    const first = rows.at(0)
    if (!first) return
    if (rowAction === 'copy-link') void copyLink(first)
    else if (rowAction === 'track') openAddPage(rows)
    // A sheet changes the query, so it takes the whole row, with every type it is asked under, not the place's reading of it.
    else setSheet({ action: rowAction, rows: rows.map(row => allRows.find(whole => whole.queryId === row.queryId) ?? row) })
  }

  // Never over a view's list, not even for the frame before the selection clears.
  const barShown = canEdit && !view && selectedRows.length > 0
  /** A button of the bar that can take the focus: the first is its first action, the last is Clear. */
  const bulkBarButton = (index: number) => [...document.getElementById(bulkBarId)?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []].at(index)
  // The bar offers what applies to every selected row. Asked and not asked rows share no action.
  const askedSelected = selectedRows.filter(row => row.subject.kind !== 'none').length
  const bulkActions: TrackedBulkAction[] = selectedRows.length === 0 ? [] : askedSelected === selectedRows.length ? [...(selectedRows.some(row => canChangeType(row, workspace)) ? ['change-type' as const] : []), 'stop'] : askedSelected === 0 ? ['track', 'remove'] : []

  const setFilters = (next: TrackedFilters) => onTrackedFiltersChange(next)
  const narrowed = tokens.length > 0 || activeFilterCount(filters) > 0
  // An empty state's action takes its own button off the page, so the search holds the focus for it.
  const clearAll = () => {
    setSearch('')
    setFilters(clearedTrackedFilters(filters))
    searchField()?.focus()
  }
  const showHidden = () => {
    setFilters({ ...filters, status: 'not-asked' })
    searchField()?.focus()
  }
  // The rows that are not asked, whatever else was filtered: the strip's count of them is for the whole project.
  // They are queries, so an open view closes for them.
  // Queries, so they are listed as queries: the grouping goes to None, and an open view closes for them.
  const showNotAsked = () => {
    if (view) onSelectionChange?.({ trackedView: undefined })
    setSearch('')
    setFilters(clearedTrackedFilters(filters, { status: 'not-asked', group: 'none' }))
  }

  // The views that are on: the open one, or each one that is a filter while its filter is set.
  const activeViews: TrackedSavedView[] = view ? [view] : [
    ...(filters.change === 'lost' ? ['lost' as const] : filters.change === 'won' ? ['won' as const] : []),
    ...(filters.status === 'not-asked' ? ['not-asked' as const] : []),
    ...(filters.subject === 'hand-picked' ? ['hand-picked' as const] : []),
  ]
  /** The filter a filter view sets, and the patch that takes it off again. */
  const VIEW_FILTERS = {
    lost: [{ change: 'lost' }, { change: 'any' }],
    won: [{ change: 'won' }, { change: 'any' }],
    'not-asked': [{ status: 'not-asked' }, { status: 'asked' }],
    'hand-picked': [{ subject: 'hand-picked' }, { subject: 'any' }],
  } as const satisfies Record<string, readonly [Partial<TrackedFilters>, Partial<TrackedFilters>]>
  // The view is a key of the URL, which the host patches through `onSelectionChange`. A second press closes a view.
  function selectView(next: TrackedSavedView) {
    if (!(next in VIEW_FILTERS)) {
      // A linked row is not on a view's list, so the link goes as the view opens.
      onSelectionChange?.({ trackedView: next === view ? undefined : next, ...(trackingQueryId === undefined ? {} : { trackingQueryId: undefined }) })
      return
    }
    const [on, off] = VIEW_FILTERS[next as keyof typeof VIEW_FILTERS]
    // A second press takes its own filter off and leaves the search and the other filters as they are.
    if (activeViews.includes(next)) {
      setFilters({ ...filters, ...off })
      return
    }
    // These list queries, on clean filters and a clean search, so their counts are the list's. An open view closes for them.
    if (view) onSelectionChange?.({ trackedView: undefined })
    setSearch('')
    setFilters(clearedTrackedFilters(filters, { ...on, group: 'none' }))
  }

  // The sweep the page reads, and the one it compares with, from whichever read is up.
  const run = listing ? results.run : grouped.data?.run
  const compareRun = listing ? results.compareRun : grouped.data?.compareRun
  // How many queries listed here won or lost the switch's signal: lengths of the lists the comparison returned.
  // While the comparison is read its place is held, but only where the workspace already knows of a sweep.
  const swept = useMemo(() => workspace.tracked.some(row => row.lastMeasuredAt !== null), [workspace.tracked])
  const comparisonFailed = listing ? results.isError : grouped.isError
  const changeCounts = useMemo(() => {
    if (comparisonFailed || compareRun === null) return undefined
    if (compareRun === undefined) return swept && run !== null ? 'pending' as const : undefined
    if (!listing) return { won: undefined, lost: undefined }
    const field = signal === 'cited' ? 'citationChange' : 'mentionChange'
    const count = (change: 'won' | 'lost') => placeRows.filter(row => resultCells(row, engines, results.coverage).some(cell => cell.signal?.[field] === change)).length
    return { won: count('won'), lost: count('lost') }
  }, [comparisonFailed, compareRun, swept, run, listing, signal, placeRows, engines, results.coverage])
  // The strip reads the same response as the list under it.
  const stripResults: TrackedResultsState = listing
    ? results.isError ? { state: 'error' } : results.coverage === undefined || run === undefined ? { state: 'loading' } : run === null ? { state: 'none' } : { state: 'ready', totals: results.totals }
    : grouped.isError ? { state: 'error' } : grouped.data === undefined ? { state: 'loading' } : grouped.data.run === null ? { state: 'none' } : { state: 'ready', totals: grouped.data.totals }
  const marketsCount = grouped.data?.groups ? <><span className="font-medium text-strong">{grouped.data.groups.length.toLocaleString('en-US')}</span> {grouping === 'group' ? (grouped.data.groups.length === 1 ? 'market group' : 'market groups') : grouped.data.groups.length === 1 ? 'market' : 'markets'}</> : undefined
  // A market's arrow lists its queries; a group's lists its markets. Either is the Place, on clean filters.
  const openMarketQueries = (to: { kind: 'market' | 'group'; key: string }) => {
    setSearch('')
    onSelectionChange?.({ measurementScope: to.kind, measurementScopeKey: to.key, trackedView: undefined, trackingQueryId: undefined, ...trackedFiltersPatch(clearedTrackedFilters(filters, { group: 'auto' })) })
  }

  // Aero reads what the page shows: the same results read, and what is opened in it. The page's own filters
  // (Subject, Type, Status, Source) are lists of the workspace, so only the server's filters go with it.
  const serverResult = filters.result === 'mentioned' || filters.result === 'not-mentioned' || filters.result === 'cited' || filters.result === 'not-cited' ? filters.result : undefined
  const aeroRead = listing ? {
    ...(place ? { scope: measurementScope, scopeKey: measurementScopeKey } : { scope: 'project' as const }),
    ...(signal === 'cited' ? { signal } : {}),
    sort: readOrder,
    compare: 'previous' as const,
    ...(serverResult ? { result: serverResult } : {}),
    ...(filters.change !== 'any' ? { change: filters.change } : {}),
    ...(filters.engine !== 'any' && (serverResult || filters.change !== 'any') ? { engine: filters.engine } : {}),
  } : { scope: 'project' as const, ...grouped.read }
  const opened = listing
    ? linkedRow ? { kind: 'query' as const, key: trackingQueryId! } : undefined
    : openedMarket ?? undefined
  usePublishAeroView(projectName, { view: 'queries', results: aeroRead, ...(opened ? { opened } : {}) })
  // The Add button beside the tabs is the page's one primary action, so this one is outlined.
  const emptyState = workspace.tracked.length === 0 ? (
    <StatusNote icon={Inbox} label="No queries yet" action={canEdit ? <WriteButton type="button" variant="outline" size="sm" className={TOUCH} disabled={isCommitting} onClick={() => openAddPage()}>{addLabel}</WriteButton> : undefined} />
  ) : placeRows.length === 0 ? (
    <StatusNote icon={MapPinOff} label="No queries here" action={<Button type="button" variant="outline" size="sm" className={TOUCH} aria-label={VISIBILITY_SCOPE_RECOVERY_COPY.showRoot(rootLabel)} onClick={showAll}>{VISIBILITY_SCOPE_RECOVERY_COPY.showWholeSite}</Button>} />
  ) : !narrowed ? (
    // Nothing is narrowed, so every query here is one the clean Status leaves out.
    <StatusNote icon={CirclePause} label="None asked" action={<Button type="button" variant="outline" size="sm" className={TOUCH} onClick={showHidden}>Show not asked</Button>} />
  ) : (
    <StatusNote
      icon={SearchX}
      label="No queries match"
      // Both in one box, so on a phone they wrap under the label together. Clear all clears the search too, which the toolbar's Clear filters does not.
      action={<span className="inline-flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={clearAll}>Clear all</Button>
        {listed.hiddenNotAsked ? <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={showHidden}>Show not asked</Button> : null}
      </span>}
    />
  )
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
          detail={VISIBILITY_TOOLBAR_COPY.trackingChangedDetail(formatObservedInstantMonthDay(observedInstant(run.completedAt ?? run.createdAt)), nextSweepDate ?? null)}
        />
      ) : null}
      {listing ? <SignalLetterLegend which={signal} /> : null}
    </div>
  )

  const savedViews = views ? (
    <TrackedSavedViews
      views={views}
      changes={changeCounts}
      notAsked={workspace.summary?.notAsked}
      handPicked={workspace.summary?.byFocus.custom}
      active={activeViews}
      onSelect={selectView}
    />
  ) : null

  return (
    <div className="query-tracking-workspace space-y-4">
      {/* Every role reads the list, so every role can take it away as a file. A view-only account is offered no way to add. With neither, the slot stays empty and closes up. */}
      {actionsSlot && !embedded ? createPortal(
        <>
          {/* The file holds queries, so it is offered while they are what is listed. Its chips are the results', so it waits for them, and with none read there is no file: the legend says why and offers Retry. */}
          {workspace.tracked.length > 0 && !view ? (
            <Button type="button" variant="outline" size="sm" className={TOUCH} disabled={listing ? results.coverage === undefined || results.isError : grouped.data?.groups === undefined} onClick={exportCsv}>
              <Download aria-hidden="true" size={14} />
              Export CSV
            </Button>
          ) : null}
          {canEdit ? (
            <WriteButton type="button" size="sm" className={TOUCH} disabled={isCommitting} onClick={() => openAddPage()}>
              <Plus aria-hidden="true" size={14} />
              {addLabel}
            </WriteButton>
          ) : null}
        </>,
        actionsSlot,
      ) : null}

      <section aria-label="Tracked queries">
        <TrackedSummaryGrid
          summary={workspace.summary}
          limits={workspace.limits}
          place={place?.summary}
          results={stripResults}
          lastSweepAt={run === undefined ? undefined : run ? run.completedAt ?? run.createdAt : null}
          compared={compareRun !== undefined && compareRun !== null}
          nextSweepDate={nextSweepDate}
          sweepActive={sweepActive}
          onShowNotAsked={showNotAsked}
          onRetry={() => { void queryClient.invalidateQueries({ queryKey: getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: projectName } }) }) }}
        />
        {view || placeRows.length === 0 ? <div className="flex justify-end">{savedViews}</div> : null}
        {view && views ? (
          <div ref={list}>
            <TrackedPlaceList
              view={view}
              workspace={workspace}
              views={views}
              onBack={closeView}
              onOpen={openPlace}
              // The page starts on the row's market or location, whatever the Place.
              onAdd={canEdit ? to => openAddPage(undefined, to) : undefined}
            />
          </div>
        ) : null}
        {/* With nothing to list there is nothing to search or filter. A view has its own search. */}
        {!view && placeRows.length > 0 ? (
          <div ref={toolbar}>
            <TrackedToolbar
              views={savedViews}
              search={search}
              onSearchChange={setSearch}
              searchLabel={listing ? 'Search queries' : grouping === 'group' ? 'Search market groups' : 'Search markets'}
              filters={filters}
              onFiltersChange={setFilters}
              engines={engines}
              groupings={marketsHere ? [GROUPINGS.market, ...(groupsOfMarkets ? [GROUPINGS.group] : []), GROUPINGS.none] : undefined}
              grouping={grouping}
              onGroupingChange={next => setFilters({ ...filters, group: next })}
              orders={listing ? [...LIST_ORDERS, ...(orderOf(sort) === 'column' ? [{ value: 'column', label: 'By column' }] : [])] : MARKET_ORDERS}
              order={listing ? orderOf(sort) : marketOrder}
              onOrderChange={next => listing ? setSort(sortOf(next, sort)) : setMarketOrder(next as TrackedMarketOrder)}
              count={listing ? undefined : marketsCount}
              notAsked={workspace.summary?.notAsked}
              onShowNotAsked={showNotAsked}
              shown={awaitingResults ? undefined : sorted.length}
              total={filters.status === 'asked' ? placeRows.filter(row => row.status !== 'not-asked').length : placeRows.length}
              legend={legend}
            />
          </div>
        ) : null}
        {/* The bar follows the list and its pages, a long way off by keyboard. This is the way there, drawn only under focus. */}
        {barShown ? (
          <div className="relative">
            <a href={`#${bulkBarId}`} className="tracked-skip" onClick={event => { event.preventDefault(); bulkBarButton(0)?.focus() }}>Selected actions</a>
          </div>
        ) : null}
        {view ? null : !listing ? (
          <div ref={list}>
            <TrackedMarkets
              projectName={projectName}
              results={grouped}
              grouping={grouping}
              signal={signal}
              order={marketOrder}
              search={search}
              engines={engines}
              onOpenQueries={openMarketQueries}
              onOpenedChange={setOpenedMarket}
            />
          </div>
        ) : awaitingResults ? <TrackedTableSkeleton /> : (
          <div ref={list}>
            <TrackedTable
              rows={pageRows}
              engines={engines}
              coverage={results.coverage}
              sort={sort}
              onSortChange={setSort}
              // With no row to tick there is no box to draw.
              selectedIds={canEdit && sorted.length > 0 ? selectedIds : undefined}
              onSelectedIdsChange={canEdit && sorted.length > 0 ? setSelectedIds : undefined}
              highlightedId={trackingQueryId}
              renderRowMenu={embedded ? undefined : row => <TrackedRowMenu row={row} workspace={workspace} onAction={(rowAction, chosen) => act(rowAction, [chosen])} />}
              nextSweepDate={nextSweepDate}
              workspace={workspace}
              contextLabels={rowContextLabels}
              projectName={embedded ? undefined : projectName}
              // A query no sweep asks has no answers to read.
              renderRowAnswers={row => row.tracked.assignments.length === 0 ? null : <TrackedRowAnswers projectName={projectName} selection={selection} queryId={row.queryId} runId={run?.id} targetLabel={targetLabel} engines={engines} />}
              renderRowActions={embedded ? undefined : row => (
                <Button type="button" variant="outline" size="sm" className={`gap-1.5 ${TOUCH}`} onClick={() => { void copyLink(row) }}>
                  <Copy aria-hidden="true" className="size-3.5" />
                  Copy link
                </Button>
              )}
              signal={signal}
              changes={compareRun !== undefined && compareRun !== null}
              // The section is Tracked queries, so the table inside it has a name of its own.
              label="Queries"
              emptyState={emptyState}
              marksFor={marksFor}
            />
            <DataTablePagination
              page={page}
              pageSize={pageSize}
              visibleRows={pageRows.length}
              totalRows={sorted.length}
              itemLabel="queries"
              onPageChange={next => setPaging({ key: listKey, page: next })}
              pageSizeOptions={PAGE_SIZES}
              onPageSizeChange={setPageSize}
            />
          </div>
        )}
        {barShown ? (
          <TrackedBulkBar
            id={bulkBarId}
            selectedCount={selectedRows.length}
            maxRows={TRACKED_BULK_MAX}
            actions={bulkActions}
            onAction={bulkAction => act(bulkAction, selectedRows)}
            note={bulkActions.length === 0 ? <StatusNote icon={Info} label="Mixed selection" detail={COPY.mixedSelection} /> : undefined}
            selectAllCount={sorted.length}
            // Select all leaves the bar once every row is ticked, and Clear takes the bar with it: each hands its focus on.
            onSelectAll={selectedRows.length < sorted.length ? () => { setSelectedIds(new Set(sorted.map(row => row.queryId))); bulkBarButton(-1)?.focus() } : undefined}
            onClear={() => { setSelectedIds(new Set<string>()); focusList() }}
            aeroBarVisible={isAeroPreview() || (shouldShowDashboardAgentBar() && aeroAllowedFor({ isAdmin, account }))}
          />
        ) : null}
      </section>

      {/* A link's row opens the composer's Edit form in the gate. This page marks that row instead, so only the Add query form is drawn. */}
      {adding && !embedded && (
        <TrackingComposer
          workspace={workspace}
          templates={templates}
          action={action}
          draft={draft}
          onDraftChange={(next) => { setDraft(next); setReviewedMutation(null) }}
          onClose={closeAction}
          canReview={canReview}
          isPreviewing={isPreviewing}
          isCommitting={isCommitting}
          editorHeadingRef={editorHeadingRef}
          onReview={() => {
            if (!mutation) return
            setReviewedMutation(mutation)
            onPreview(mutation)
          }}
        />
      )}

      {/* An advanced review stays up after a refusal, to show the server's message and offer another review. */}
      {reviewedMutation && adding && (preview || publishError) && (
        <Card className="surface-card">
          <TrackingReview
            preview={preview}
            expectedSubjects={expectedSubjects}
            error={publishError}
            workspace={workspace}
            contextLabels={contextLabels}
            isCommitting={isCommitting}
            sweepActive={sweepActive}
            nextSweepDate={nextSweepDate}
            onPublish={() => commitReviewed(reviewedMutation)}
            onReviewAgain={() => onPreview(reviewedMutation)}
          />
        </Card>
      )}

      {sheet && (
        <TrackedActionSheet
          projectName={projectName}
          workspace={workspace}
          action={sheet.action}
          rows={sheet.rows}
          place={place?.narrow}
          contextChoices={uniqueContextInputs(workspace.defaultContexts.map(contextInput)).map(input => ({ label: contextLabel(input), input }))}
          sweepActive={sweepActive}
          nextSweepDate={nextSweepDate}
          onPublished={() => setSelectedIds(new Set<string>())}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  )
}
