import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CirclePause, Clock, Inbox, Info, MapPinOff, Plus, SearchX } from 'lucide-react'
import type { QueryClass, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameQueryTrackingQueryKey } from '@ainyc/canonry-api-client/react-query'

import { heyClient, isAeroPreview, isEmbed, shouldShowDashboardAgentBar } from '../../../../api.js'
import { useAccount } from '../../../../contexts/account-context.js'
import { addToast } from '../../../../lib/toast-store.js'
import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { WriteButton } from '../../../shared/AccessControls.js'
import { aeroAllowedFor } from '../../../shared/AeroBar.js'
import { formatObservedInstantMonthDay, observedInstant } from '../../../shared/ChartPrimitives.js'
import { DataTablePagination } from '../../../shared/DataTableControls.js'
import { SignalLegend } from '../../../shared/SignalCells.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import { Card } from '../../../ui/card.js'
import type { TrackedPageHostProps } from '../../DiscoverySection.js'
import { TrackingReview } from '../../TrackingReview.js'
import { MARKET_SCOPE_COPY } from '../../VisibilityScopePicker.js'
import { VISIBILITY_SCOPE_RECOVERY_COPY, VISIBILITY_TOOLBAR_COPY } from '../../VisibilityTrendSection.js'
import { TrackingAddQueriesSheet } from '../AddQueriesEntry.js'
import { TrackingComposer } from '../TrackingComposer.js'
import { assignmentMatchesSelection } from '../tracked-rows.js'
import { contextInput, contextLabel, contextLabels, uniqueContextInputs } from '../tracking-contexts.js'
import { useTrackedResults } from '../use-tracked-results.js'
import type { TrackedQueriesPageProps, TrackingComposerState } from '../use-tracking-composer.js'
import { TrackedActionSheet, type TrackedSheetAction } from './TrackedActionSheet.js'
import { TrackedBulkBar, type TrackedBulkAction } from './TrackedBulkBar.js'
import type { TrackedContextLabels } from './TrackedRowDetail.js'
import { TrackedRowMenu } from './TrackedRowMenu.js'
import { TrackedSummaryGrid, type TrackedSummaryPlace } from './TrackedSummaryGrid.js'
import { TrackedTable, TrackedTableSkeleton } from './TrackedTable.js'
import { TrackedToolbar } from './TrackedToolbar.js'
import { TRACKED_BULK_MAX, type TrackedPlace } from './tracked-actions.js'
import { activeFilterCount, DEFAULT_TRACKED_FILTERS, matchesTrackedFilters, type TrackedResultCell } from './tracked-filters.js'
import type { TrackedFilters, TrackedRowAction, TrackedRowVm, TrackedType } from './tracked-types.js'
import { DEFAULT_TRACKED_SORT, engineSignal, resultClasses, sortTrackedRows, toTrackedRows, type TrackedCoverage, type TrackedSort } from './tracked-view-model.js'

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

/**
 * Where a query is asked, as the row detail names it: the search location and
 * its engines by display name, with the Add query form's words for them, model
 * ids included, behind the value. Two that read alike by display name anywhere
 * in the table (one engine on two models) keep the form's words.
 */
function searchLocationNames(workspace: QueryTrackingWorkspaceResponse): TrackedContextLabels {
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

/** A row's engine cells for the Result filter, one per engine and type. A row that is not asked has no result to wait for. */
function resultCells(row: TrackedRowVm, engines: readonly string[], coverage: TrackedCoverage | undefined): TrackedResultCell[] {
  return engines.flatMap(engine => resultClasses(row).map(queryClass => ({
    queryClass: queryClass as QueryClass,
    signal: row.status === 'not-asked' ? null : engineSignal(coverage, row.queryId, queryClass, engine),
  })))
}

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
 * Tracked queries on an advanced project: the number strip, the toolbar, the
 * table with its row menu, the bulk bar, and the sheets every change goes
 * through. The Add query form and its review stay below the table, reached
 * from the Add queries sheet and from a saved Research result.
 *
 * Rows come from the workspace the gate read. The last sweep's Mentioned and
 * Cited come from one results read for the Place. Every number in the strip is
 * a server field; here rows are only listed, searched, sorted and paged. The
 * filters are the URL's own keys, so the query type AI Visibility is set to
 * never narrows this list. A `trackingQueryId` in the URL marks a row: the
 * table opens on its page with its detail open. It never opens a form.
 */
export function AdvancedTrackedPage(props: PageProps) {
  const { onSelectionChange, rootLabel = MARKET_SCOPE_COPY.allLocations } = props
  // "Show all" takes its own button off the page, so it leaves word for the list that follows to take the focus.
  const showingAll = useRef(false)
  const showAll = () => {
    showingAll.current = true
    onSelectionChange?.({ measurementScope: 'project', measurementScopeKey: undefined })
  }
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
  trackedFilters: filters, onTrackedFiltersChange, trackingChangedAt, nextSweepDate, rootLabel, actionsSlot, composer, showAll, showingAll,
}: PageProps & { rootLabel: string; showAll: () => void; showingAll: RefObject<boolean> }) {
  const { action, draft, setDraft, reviewedMutation, setReviewedMutation, addSheetOpen, setAddSheetOpen, editorHeadingRef, openAdd, closeAction, mutation, canReview, sweepActive, commitReviewed } = composer
  const { canWrite, isAdmin, account } = useAccount()
  const queryClient = useQueryClient()
  const embedded = isEmbed()
  const canEdit = canWrite && !embedded
  const { measurementScope, measurementScopeKey } = selection
  const place = useMemo(() => placeOf(workspace, measurementScope, measurementScopeKey), [workspace, measurementScope, measurementScopeKey])
  const results = useTrackedResults(projectName, selection)

  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<TrackedSort>(DEFAULT_TRACKED_SORT)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [sheet, setSheet] = useState<{ action: TrackedSheetAction; rows: readonly TrackedRowVm[] } | null>(null)
  // The lines the Add queries sheet opens with, when Track opened it.
  const [addText, setAddText] = useState<string>()
  const toolbar = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const bulkBarId = useId()
  const searchField = () => toolbar.current?.querySelector<HTMLInputElement>('input[type="search"]')
  // The list's first control: Select this page, or the first header where there is nothing to select. The page stays where it is scrolled to.
  const focusList = () => list.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true })

  const engines = useMemo(() => [...new Set([...workspace.defaultContexts.flatMap(context => context.providers), ...results.engines])], [workspace.defaultContexts, results.engines])
  const rowContextLabels = useMemo(() => searchLocationNames(workspace), [workspace])
  const allRows = useMemo(() => toTrackedRows(workspace, templates), [workspace, templates])
  // A place lists the queries asked for it. One that is asked nowhere belongs to no place, so it shows for the whole project only.
  // Each is listed under the types it is asked under there, as the results for the place hold them: a query asked both ways
  // across the project and one way here has one pair of chips here, not a second pair no sweep will fill.
  const placeRows = useMemo(() => {
    if (!place) return allRows
    const within = { measurementScope, measurementScopeKey, queryClass: 'all' as const }
    return allRows.flatMap(row => {
      const here = row.tracked.assignments.filter(assignment => assignmentMatchesSelection(assignment, within))
      if (here.length === 0) return []
      const queryClasses = [...new Set(here.flatMap(assignment => assignment.queryClass ?? []))].sort()
      if (queryClasses.length === row.queryClasses.length) return [row]
      const type: TrackedType = queryClasses.length === 0 ? 'not-set' : queryClasses.length === 1 ? queryClasses[0]! : 'mixed'
      return [{ ...row, queryClasses, type }]
    })
  }, [allRows, place, measurementScope, measurementScopeKey])
  const tokens = useMemo(() => search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean), [search])
  // A Result filter lists by the chips, so until the results are read there is no list yet: neither rows nor an empty state.
  const awaitingResults = filters.result !== 'any' && results.coverage === undefined
  const listed = useMemo(() => {
    const matches = (row: TrackedRowVm, by: TrackedFilters) => matchesTrackedFilters(row, by, by.result === 'any' ? [] : resultCells(row, engines, results.coverage))
      && (tokens.length === 0 || tokens.every(token => searchText(row).includes(token)))
    return {
      rows: placeRows.filter(row => matches(row, filters)),
      // Rows the default Status leaves out that the search and the other filters would list.
      hiddenNotAsked: filters.status === 'asked' && placeRows.some(row => row.status === 'not-asked' && matches(row, { ...filters, status: 'not-asked' })),
    }
  }, [placeRows, filters, tokens, engines, results.coverage])
  const sorted = useMemo(() => sortTrackedRows(listed.rows, sort, results.coverage), [listed.rows, sort, results.coverage])

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
    onTrackedFiltersChange({ ...DEFAULT_TRACKED_FILTERS, status: linked.status === 'not-asked' ? 'all' : DEFAULT_TRACKED_FILTERS.status })
    if (!placeRows.some(row => row.queryId === trackingQueryId)) onSelectionChange?.({ measurementScope: 'project', measurementScopeKey: undefined })
  }, [trackingQueryId, linkedIndex, listKey, pageSize, awaitingResults, allRows, placeRows, onTrackedFiltersChange, onSelectionChange])

  // A row the search or the filters no longer list leaves the selection, so no change reaches a row out of sight.
  // While a Result filter waits for the results nothing is listed yet, and the selection waits with it.
  const selectedRows = useMemo(() => sorted.filter(row => selectedIds.has(row.queryId)), [sorted, selectedIds])
  useEffect(() => {
    if (!awaitingResults && selectedRows.length !== selectedIds.size) setSelectedIds(new Set(selectedRows.map(row => row.queryId)))
  }, [awaitingResults, selectedRows, selectedIds])

  // "Show all" took its own button off the page: once the place has changed, the search takes the focus it dropped.
  useEffect(() => {
    if (!showingAll.current) return
    showingAll.current = false
    if (document.activeElement === document.body) searchField()?.focus()
  }, [showingAll, measurementScope, measurementScopeKey])

  // A sheet hands the focus back to what opened it. When that has left the page, as the bar does once its rows are changed, the list takes it.
  const sheetOpen = sheet !== null || addSheetOpen
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

  // The sheet opens on the Place when it is one market or one location. A market with no location left takes no query, so it is not offered.
  const addTo = place?.summary.kind === 'location' || (place?.summary.kind === 'market' && place.summary.market.targetKeys?.length !== 0) ? place.narrow : undefined
  const addLabel = addTo?.kind === 'market' ? 'Add market query' : addTo?.kind === 'location' ? 'Add location query' : 'Add queries'
  const adding = action?.kind === 'add'
  // The Add query form and the sheet are two ways in to one change, so the sheet takes the form's place.
  function openAddSheet(text?: string) {
    if (adding) closeAction()
    setAddText(text)
    setAddSheetOpen(true)
  }

  async function copyLink(row: TrackedRowVm) {
    const url = new URL(window.location.href)
    url.searchParams.set('trackingQueryId', searchParamValue(row.queryId))
    try {
      await navigator.clipboard.writeText(url.toString())
      addToast({ title: 'Link copied', tone: 'positive', dedupeKey: 'tracked-query:copy-link', dedupeMode: 'replace' })
    } catch {
      addToast({ title: 'Could not copy', tone: 'negative', dedupeKey: 'tracked-query:copy-link', dedupeMode: 'replace' })
    }
  }

  function act(rowAction: TrackedRowAction, rows: readonly TrackedRowVm[]) {
    const first = rows.at(0)
    if (!first) return
    if (rowAction === 'copy-link') void copyLink(first)
    else if (rowAction === 'track') openAddSheet(rows.map(row => row.queryText).join('\n'))
    // A sheet changes the query, so it takes the whole row, with every type it is asked under, not the place's reading of it.
    else setSheet({ action: rowAction, rows: rows.map(row => allRows.find(whole => whole.queryId === row.queryId) ?? row) })
  }

  const barShown = canEdit && selectedRows.length > 0
  /** A button of the bar that can take the focus: the first is its first action, the last is Clear. */
  const bulkBarButton = (index: number) => [...document.getElementById(bulkBarId)?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []].at(index)
  // The bar offers what applies to every selected row. Asked and not asked rows share no action.
  const askedSelected = selectedRows.filter(row => row.subject.kind !== 'none').length
  const bulkActions: TrackedBulkAction[] = selectedRows.length === 0 ? [] : askedSelected === selectedRows.length ? ['change-type', 'stop'] : askedSelected === 0 ? ['track', 'remove'] : []

  const setFilters = (next: TrackedFilters) => onTrackedFiltersChange(next)
  const narrowed = tokens.length > 0 || activeFilterCount(filters) > 0
  // An empty state's action takes its own button off the page, so the search holds the focus for it.
  const clearAll = () => {
    setSearch('')
    setFilters(DEFAULT_TRACKED_FILTERS)
    searchField()?.focus()
  }
  const showHidden = () => {
    setFilters({ ...filters, status: 'not-asked' })
    searchField()?.focus()
  }
  // The rows that are not asked, whatever else was filtered: the strip's count of them is for the whole project.
  const showNotAsked = () => {
    setSearch('')
    setFilters({ ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' })
  }

  const { run } = results
  // The Add button beside the tabs is the page's one primary action, so this one is outlined.
  const emptyState = workspace.tracked.length === 0 ? (
    <StatusNote icon={Inbox} label="No queries yet" action={canEdit ? <WriteButton type="button" variant="outline" size="sm" className={TOUCH} onClick={() => openAddSheet()}>{addLabel}</WriteButton> : undefined} />
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
      <SignalLegend />
    </div>
  )

  return (
    <div className="query-tracking-workspace space-y-4">
      {/* A view-only account is offered no way to add: the slot stays empty and closes up. */}
      {actionsSlot && canEdit ? createPortal(
        <WriteButton type="button" size="sm" className={TOUCH} onClick={() => openAddSheet()}>
          <Plus aria-hidden="true" size={14} />
          {addLabel}
        </WriteButton>,
        actionsSlot,
      ) : null}

      <section aria-label="Tracked queries">
        <TrackedSummaryGrid
          summary={workspace.summary}
          limits={workspace.limits}
          place={place?.summary}
          lastSweepAt={run === undefined ? undefined : run ? run.completedAt ?? run.createdAt : null}
          nextSweepDate={nextSweepDate}
          sweepActive={sweepActive}
          onShowNotAsked={showNotAsked}
          onRetry={() => { void queryClient.invalidateQueries({ queryKey: getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: projectName } }) }) }}
        />
        {/* With nothing to list there is nothing to search or filter. */}
        {placeRows.length > 0 ? (
          <div ref={toolbar}>
            <TrackedToolbar search={search} onSearchChange={setSearch} filters={filters} onFiltersChange={setFilters} shown={awaitingResults ? undefined : sorted.length} total={placeRows.length} legend={legend} />
          </div>
        ) : null}
        {/* The bar follows the list and its pages, a long way off by keyboard. This is the way there, drawn only under focus. */}
        {barShown ? (
          <div className="relative">
            <a href={`#${bulkBarId}`} className="tracked-skip" onClick={event => { event.preventDefault(); bulkBarButton(0)?.focus() }}>Selected actions</a>
          </div>
        ) : null}
        {awaitingResults ? <TrackedTableSkeleton /> : (
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
              // The section is Tracked queries, so the table inside it has a name of its own.
              label="Queries"
              emptyState={emptyState}
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

      {addSheetOpen && (
        <TrackingAddQueriesSheet
          projectName={projectName}
          workspace={workspace}
          sweepActive={sweepActive}
          defaultMarketKey={addTo?.kind === 'market' ? addTo.key : undefined}
          defaultLocationKey={addTo?.kind === 'location' ? addTo.key : undefined}
          defaultText={addText}
          onOpenComposer={({ text }) => { setAddSheetOpen(false); openAdd('manual', text) }}
          onPublished={() => setSelectedIds(new Set<string>())}
          onClose={() => setAddSheetOpen(false)}
        />
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
