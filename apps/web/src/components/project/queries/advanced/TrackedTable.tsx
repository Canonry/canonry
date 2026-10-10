import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsUpDown } from 'lucide-react'
import type { QueryClass, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { formatSweepDay } from '../../../../lib/format-helpers.js'
import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { SignalPair } from '../../../shared/SignalCells.js'
import { ToneBadge } from '../../../shared/ToneBadge.js'
import { Button } from '../../../ui/button.js'
import { TrackedRowDetail, type TrackedContextLabels } from './TrackedRowDetail.js'
import type { TrackedRowVm, TrackedSubject, TrackedType } from './tracked-types.js'
import {
  engineSignal,
  engineSortKey,
  locationCountLabel,
  nextTrackedSort,
  resultClasses,
  sourceLabel,
  statusLabel,
  subjectKindLabel,
  TRACKED_COLUMN_WIDTH,
  TRACKED_COLUMNS,
  trackedEngineColumnWidth,
  trackedLayout,
  typeLabel,
  type TrackedColumn,
  type TrackedCoverage,
  type TrackedSort,
  type TrackedSortKey,
} from './tracked-view-model.js'

type Engine = { key: string; label: string; width: number }

/**
 * The frame's width. Measured before the first paint, so the rows are never
 * drawn in a layout the frame cannot hold; a `ResizeObserver` follows it from
 * there. Undefined where there is no observer.
 */
function useFrameWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number>()
  useLayoutEffect(() => {
    const frame = ref.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    setWidth(frame.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'

/**
 * The Tracked queries table: one row per query with its Subject, Type, one
 * `SignalPair` per engine, Last measured, Status and Source. The caller sorts,
 * filters and pages the rows; this draws them in the order given and reports
 * a header click through `onSortChange`.
 *
 * Results join on query and type. A row asked both ways stacks one pair per
 * type in each engine cell, each named with its type, and a result under the
 * other type is never borrowed: a missing one draws Not checked. `coverage`
 * undefined is still loading.
 *
 * The query text and the Subject count open the row detail, for every role.
 * The checkbox column shows only when `onSelectedIdsChange` is given, and a
 * shift-click selects the range from the last row clicked. `highlightedId` is
 * the row a link points at: it is marked, opened and, once the frame is
 * measured and the rows are in their layout, scrolled into view.
 *
 * The frame's width decides the layout (`trackedLayout`): Source and then Last
 * measured fold into the row detail before Query gets narrow, and a frame too
 * narrow for a table stacks each row. Nothing scrolls sideways, so the header
 * can stick under the topbar. Stacked rows have no header, so while there are
 * rows a line above them holds what the header did: Select this page and the
 * sort.
 */
export function TrackedTable({
  rows, engines, coverage, sort, onSortChange, selectedIds, onSelectedIdsChange, highlightedId, renderRowMenu, nextSweepDate, workspace, contextLabels,
  columns, label = 'Tracked queries', emptyState,
}: {
  rows: readonly TrackedRowVm[]
  /** Engine keys, one column each, in this order. */
  engines: readonly string[]
  /**
   * Results by query and type. Undefined while they load; a result that is
   * missing draws Not checked. After a failed read pass undefined too, and say
   * so beside the table: an empty map would name every chip Not checked.
   */
  coverage: TrackedCoverage | undefined
  sort?: TrackedSort
  /** Headers sort only when given. */
  onSortChange?: (sort: TrackedSort) => void
  selectedIds?: ReadonlySet<string>
  onSelectedIdsChange?: (ids: ReadonlySet<string>) => void
  highlightedId?: string
  renderRowMenu?: (row: TrackedRowVm) => ReactNode
  /** The next sweep's date as shown, month and day only ("Oct 21"): the Status column is sized for that, and a longer label is cut short. Absent when none is coming or one is running. */
  nextSweepDate?: string
  workspace: Pick<QueryTrackingWorkspaceResponse, 'targets' | 'groups' | 'markets'>
  contextLabels: TrackedContextLabels
  /** The columns the caller wants, all of them by default. A narrow frame can still fold Source and Last measured away. */
  columns?: readonly TrackedColumn[]
  /** The table's accessible name. */
  label?: string
  /** Shown under the header when there are no rows. */
  emptyState?: ReactNode
}) {
  const tableId = useId()
  const [frameRef, frameWidth] = useFrameWidth()
  // Where there is an observer the width arrives one render late, and until then the rows are not in their layout.
  const measured = frameWidth !== undefined || typeof ResizeObserver === 'undefined'
  const selectable = onSelectedIdsChange !== undefined
  const engineColumns: Engine[] = engines.map(key => {
    const name = providerDisplayName(key)
    return { key, label: name, width: trackedEngineColumnWidth(name) }
  })
  // Without a menu to draw, its column gives its width back to Query.
  const wanted = (columns ?? TRACKED_COLUMNS).filter(column => column !== 'menu' || renderRowMenu !== undefined)
  const layout = trackedLayout(frameWidth, engineColumns.map(engine => engine.width), { columns: wanted, selectable })
  const shown = new Set(layout.columns)
  const columnCount = (selectable ? 1 : 0) + [...shown].reduce((count, column) => count + (column === 'engines' ? engineColumns.length : 1), 0)
  // What a header sorts by, in header order. Stacked rows have no header, so their Sort select lists the same.
  const sortChoices = wanted.flatMap((column): [TrackedSortKey, string][] => {
    switch (column) {
      case 'query': return [['query', 'Query']]
      case 'subject': return [['subject', 'Subject']]
      case 'engines': return engineColumns.map(engine => [engineSortKey(engine.key), engine.label])
      case 'lastMeasured': return [['lastMeasured', 'Last measured']]
      case 'status': return [['status', 'Status']]
      case 'type':
      case 'source':
      case 'menu': return []
    }
  })

  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set<string>())
  const toggleOpen = (queryId: string) => setOpenIds(previous => {
    const next = new Set(previous)
    if (!next.delete(queryId)) next.add(queryId)
    return next
  })
  const highlightedRow = useRef<HTMLTableRowElement>(null)
  const onPage = highlightedId !== undefined && rows.some(row => row.queryId === highlightedId)
  // A linked row opens and comes into view when it arrives, and again when the link changes. Closing it by hand sticks.
  // It waits for the measure: a row scrolled to before the rows stack is somewhere else once they have.
  useEffect(() => {
    if (!onPage || !measured) return
    setOpenIds(previous => previous.has(highlightedId) ? previous : new Set(previous).add(highlightedId))
    // Typed as optional: a DOM without layout has no such method.
    const row: { scrollIntoView?: (options: ScrollIntoViewOptions) => void } | null = highlightedRow.current
    row?.scrollIntoView?.({ block: 'center' })
  }, [highlightedId, onPage, measured])

  const selected = selectedIds ?? new Set<string>()
  const selectedOnPage = rows.filter(row => selected.has(row.queryId)).length
  const anchorId = useRef<string | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  // The box is drawn anew when the rows stack or unstack.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedOnPage > 0 && selectedOnPage < rows.length
  }, [selectedOnPage, rows.length, layout.stacked])
  const toggleRow = (row: TrackedRowVm, index: number, shiftKey: boolean) => {
    if (!onSelectedIdsChange) return
    const checked = !selected.has(row.queryId)
    // A shift-click carries the clicked row's new state over every row from the last one clicked.
    const anchor = shiftKey && anchorId.current !== null ? rows.findIndex(candidate => candidate.queryId === anchorId.current) : -1
    const range = anchor < 0 ? [row] : rows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
    const next = new Set(selected)
    for (const item of range) {
      if (checked) next.add(item.queryId)
      else next.delete(item.queryId)
    }
    anchorId.current = row.queryId
    onSelectedIdsChange(next)
  }
  const togglePage = () => {
    if (!onSelectedIdsChange) return
    const next = new Set(selected)
    for (const row of rows) {
      if (selectedOnPage === rows.length) next.delete(row.queryId)
      else next.add(row.queryId)
    }
    onSelectedIdsChange(next)
  }

  const header = (column: TrackedSortKey, text: string, className?: string) => {
    const active = sort?.key === column
    return (
      <th scope="col" className={className} aria-sort={!onSortChange ? undefined : !active ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending'}>
        {onSortChange ? (
          <button type="button" className={`tracked-sort ${FOCUS}`} onClick={() => onSortChange(nextTrackedSort(sort, column))}>
            {text}
            {active
              ? <ChevronDown aria-hidden="true" className={`tracked-sort-mark ${sort.direction === 'asc' ? 'rotate-180' : ''}`} />
              : <ChevronsUpDown aria-hidden="true" className="tracked-sort-mark tracked-sort-hint" />}
          </button>
        ) : text}
      </th>
    )
  }
  const pageBox = (
    <input
      ref={selectAllRef}
      type="checkbox"
      className={FOCUS}
      // Stacked, its label is on the page.
      aria-label={layout.stacked ? undefined : 'Select this page'}
      disabled={rows.length === 0}
      checked={rows.length > 0 && selectedOnPage === rows.length}
      onChange={togglePage}
    />
  )

  return (
    <div ref={frameRef} className="tracked-table-frame">
      {layout.stacked && rows.length > 0 && (selectable || onSortChange) ? (
        <div className="tracked-stack-controls">
          {selectable ? <label className="tracked-check-all"><span className="tracked-check">{pageBox}</span>Select this page</label> : null}
          {onSortChange ? (
            <div className="tracked-stack-sort">
              <label htmlFor={`${tableId}-sort`}>Sort</label>
              <select id={`${tableId}-sort`} className={FOCUS} value={sort?.key ?? ''} onChange={event => onSortChange(nextTrackedSort(sort, event.target.value as TrackedSortKey))}>
                {sort ? null : <option value="" disabled hidden />}
                {sortChoices.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
              </select>
              {sort ? (
                <Button type="button" variant="outline" size="icon" className="pointer-coarse:size-11 max-md:size-11" aria-label={sort.direction === 'asc' ? 'Ascending' : 'Descending'} onClick={() => onSortChange(nextTrackedSort(sort, sort.key))}>
                  {sort.direction === 'asc' ? <ArrowUp aria-hidden="true" className="size-4" /> : <ArrowDown aria-hidden="true" className="size-4" />}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <table aria-label={label} className="tracked-table" data-layout={layout.stacked ? 'stacked' : 'table'} data-selectable={selectable ? '' : undefined}>
        {layout.stacked ? null : (
          <colgroup>
            {selectable ? <col style={{ width: TRACKED_COLUMN_WIDTH.select }} /> : null}
            <col />
            {shown.has('subject') ? <col style={{ width: TRACKED_COLUMN_WIDTH.subject }} /> : null}
            {shown.has('type') ? <col style={{ width: TRACKED_COLUMN_WIDTH.type }} /> : null}
            {shown.has('engines') ? engineColumns.map(engine => <col key={engine.key} style={{ width: engine.width }} />) : null}
            {shown.has('lastMeasured') ? <col style={{ width: TRACKED_COLUMN_WIDTH.lastMeasured }} /> : null}
            {shown.has('status') ? <col style={{ width: TRACKED_COLUMN_WIDTH.status }} /> : null}
            {shown.has('source') ? <col style={{ width: TRACKED_COLUMN_WIDTH.source }} /> : null}
            {shown.has('menu') ? <col style={{ width: TRACKED_COLUMN_WIDTH.menu }} /> : null}
          </colgroup>
        )}
        {layout.stacked ? null : (
          <thead>
            <tr>
              {selectable ? <th scope="col" className="tracked-cell-select"><label className="tracked-check">{pageBox}</label></th> : null}
              {header('query', 'Query')}
              {shown.has('subject') ? header('subject', 'Subject') : null}
              {shown.has('type') ? <th scope="col">Type</th> : null}
              {shown.has('engines') ? engineColumns.map(engine => <Fragment key={engine.key}>{header(engineSortKey(engine.key), engine.label, 'tracked-cell-engine')}</Fragment>) : null}
              {shown.has('lastMeasured') ? header('lastMeasured', 'Last measured') : null}
              {shown.has('status') ? header('status', 'Status') : null}
              {shown.has('source') ? <th scope="col">Source</th> : null}
              {shown.has('menu') ? <th scope="col" className="tracked-cell-menu"><span className="sr-only">Actions</span></th> : null}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.length === 0 && emptyState ? <tr><td colSpan={columnCount} className="tracked-empty">{emptyState}</td></tr> : null}
          {rows.map((row, index) => {
            const open = openIds.has(row.queryId)
            // By position: a query id is free text, and an id reference cannot hold a space.
            const detailId = `${tableId}-detail-${index}`
            const discloses = { 'aria-expanded': open, 'aria-controls': open ? detailId : undefined, onClick: () => toggleOpen(row.queryId) }
            const mixed = row.type === 'mixed'
            const menuCell = shown.has('menu') ? <td className="tracked-cell-menu">{renderRowMenu?.(row)}</td> : null
            return (
              <Fragment key={row.queryId}>
                <tr
                  ref={row.queryId === highlightedId ? highlightedRow : undefined}
                  className="tracked-row"
                  data-selected={selected.has(row.queryId) ? '' : undefined}
                  data-highlighted={row.queryId === highlightedId ? '' : undefined}
                  data-open={open ? '' : undefined}
                  data-mixed={mixed ? '' : undefined}
                >
                  {selectable ? (
                    <td className="tracked-cell-select">
                      <label className="tracked-check">
                        <input
                          type="checkbox"
                          className={FOCUS}
                          aria-label={`Select ${row.queryText}`}
                          checked={selected.has(row.queryId)}
                          onChange={event => toggleRow(row, index, (event.nativeEvent as MouseEvent).shiftKey)}
                        />
                      </label>
                    </td>
                  ) : null}
                  <td className="tracked-cell-query">
                    <button type="button" className={`tracked-query ${FOCUS}`} title={row.queryText} {...discloses}>
                      <span><ChevronRight aria-hidden="true" className="tracked-query-mark" />{row.queryText}</span>
                    </button>
                  </td>
                  {/* Stacked, the menu is on the first line beside the query, so it is the next stop after it. */}
                  {layout.stacked ? menuCell : null}
                  {shown.has('subject') ? <td className="tracked-cell-subject"><SubjectCell subject={row.subject} discloses={discloses} /></td> : null}
                  {shown.has('type') ? <td className="tracked-cell-type"><TypeCell type={row.type} classes={row.queryClasses} /></td> : null}
                  {shown.has('engines') ? engineColumns.map(engine => (
                    <td key={engine.key} className="tracked-cell-engine">
                      {/* A stacked row has no header to read the engine from, so each cell names its own. */}
                      {layout.stacked && !mixed ? <span className="tracked-engine-name" aria-hidden="true">{engine.label}</span> : null}
                      <PairStack mixed={mixed} engineLabel={engine.label} named={layout.stacked}>
                        {resultClasses(row).map(queryClass => (
                          <SignalPair
                            key={queryClass}
                            // A row that is not asked has no result to wait for.
                            signal={row.status === 'not-asked' ? null : engineSignal(coverage, row.queryId, queryClass, engine.key)}
                            engineLabel={engine.label}
                            classLabel={mixed ? typeLabel(queryClass as QueryClass) : undefined}
                          />
                        ))}
                      </PairStack>
                    </td>
                  )) : null}
                  {shown.has('lastMeasured') ? (
                    <td className="tracked-cell-date">
                      {row.lastMeasuredAt ? <time dateTime={row.lastMeasuredAt}>{formatSweepDay(row.lastMeasuredAt)}</time> : 'Never'}
                    </td>
                  ) : null}
                  {shown.has('status') ? (
                    <td className="tracked-cell-status">
                      <ToneBadge
                        tone={row.status === 'measured' ? 'positive' : 'neutral'}
                        // One line of 16px, so a one-line row is as tall as its text. A label too long for the column is cut short, never drawn over Source.
                        className={`block w-fit max-w-full truncate leading-4 ${row.status === 'first-answers' ? 'border-info-500/30 bg-info-500/10 text-info-300' : ''}`}
                      >
                        {statusLabel(row.status, nextSweepDate)}
                      </ToneBadge>
                    </td>
                  ) : null}
                  {shown.has('source') ? <td className="tracked-cell-source"><span>{sourceLabel(row.source)}</span></td> : null}
                  {layout.stacked ? null : menuCell}
                </tr>
                {open ? (
                  <tr id={detailId} className="tracked-detail-row" data-highlighted={row.queryId === highlightedId ? '' : undefined}>
                    <td colSpan={columnCount}><TrackedRowDetail row={row} workspace={workspace} contextLabels={contextLabels} /></td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

type Discloses = { 'aria-expanded': boolean; 'aria-controls': string | undefined; onClick: () => void }

/**
 * "Market · Uptown (3)": the kind stays on the first line, and the count stays
 * on the last word of the name however the name wraps. The count opens the
 * row detail, which lists the locations it counts.
 */
function SubjectCell({ subject, discloses }: { subject: TrackedSubject; discloses: Discloses }) {
  const kind = <span className="font-medium text-strong">{subjectKindLabel(subject.kind)}</span>
  // The dot stays with the kind, so a line never starts with it.
  const lead = <><span className="whitespace-nowrap">{kind} <span aria-hidden="true">·</span></span>{' '}</>
  switch (subject.kind) {
    case 'market': {
      const cut = subject.label.lastIndexOf(' ') + 1
      return <>
        {lead}{subject.label.slice(0, cut)}
        <span className="whitespace-nowrap">
          {subject.label.slice(cut)}{' '}
          <button type="button" className={`tracked-count ${FOCUS}`} aria-label={locationCountLabel(subject.locationCount)} {...discloses}>({subject.locationCount.toLocaleString('en-US')})</button>
        </span>
      </>
    }
    case 'location': return <>{lead}{subject.label}</>
    case 'hand-picked': return <>
      {lead}
      <button type="button" className={`tracked-count whitespace-nowrap ${FOCUS}`} {...discloses}>{locationCountLabel(subject.locationCount)}</button>
    </>
    case 'company': return kind
    case 'none': return subjectKindLabel(subject.kind)
  }
}

/** A row asked both ways names its two types on the lines of the two pairs beside it, in every layout. */
function TypeCell({ type, classes }: { type: TrackedType; classes: readonly TrackedType[] }) {
  if (type !== 'mixed') return typeLabel(type)
  return (
    <span className="tracked-pair-stack">
      <span className="tracked-pair-lead">{typeLabel(type)}</span>
      {classes.map(queryClass => <span key={queryClass} className="tracked-pair-label">{typeLabel(queryClass)}</span>)}
    </span>
  )
}

/**
 * The pairs of one engine cell. A row asked both ways has two, under a first
 * line that keeps them level with their types in the Type cell: blank under a
 * header, the engine's name (`named`) in a stacked row. The cell stays one tab
 * stop: Tab reaches the first pair and the arrow keys move between them, which
 * the group's name and each pair's shortcuts say.
 */
function PairStack({ mixed, engineLabel, named, children }: { mixed: boolean; engineLabel: string; named: boolean; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!mixed) return
    ref.current?.querySelectorAll('button').forEach((button, index) => {
      button.tabIndex = index === 0 ? 0 : -1
      button.setAttribute('aria-keyshortcuts', 'ArrowDown ArrowUp')
    })
  })
  if (!mixed) return <>{children}</>
  return (
    <span
      ref={ref}
      role="group"
      aria-label={`${engineLabel} by type`}
      className="tracked-pair-stack"
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const pairs = [...event.currentTarget.querySelectorAll('button')]
        const next = pairs.findIndex(pair => pair === event.target) + (event.key === 'ArrowDown' ? 1 : -1)
        if (next < 0 || next >= pairs.length) return
        event.preventDefault()
        pairs[next].focus()
      }}
    >
      <span className="tracked-pair-lead" aria-hidden="true">{named ? engineLabel : null}</span>
      {children}
    </span>
  )
}

/** Rows standing in for the table while the workspace loads. */
export function TrackedTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading queries" className="tracked-table-skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true">
          <span className="skeleton-text" style={{ width: `${32 + (index * 7) % 23}%` }} />
          <span className="skeleton-text w-28" />
          <span className="skeleton-text w-16" />
          <span className="skeleton-text w-36" />
          <span className="skeleton-text w-20" />
        </div>
      ))}
    </div>
  )
}
