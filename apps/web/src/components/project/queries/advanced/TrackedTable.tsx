import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsUpDown, Triangle } from 'lucide-react'
import type { QueryClass, QueryTrackingWorkspaceResponse } from '@canonry/canonry-contracts'

import { formatMonthDay, formatSweepDay } from '../../../../lib/format-helpers.js'
import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { SignalLetter, SignalPair } from '../../../shared/SignalCells.js'
import { ToneBadge } from '../../../shared/ToneBadge.js'
import { Button } from '../../../ui/button.js'
import { TrackedRowDetail, type TrackedContextLabels } from './TrackedRowDetail.js'
import type { TrackedRowVm, TrackedSignal, TrackedSubject, TrackedType } from './tracked-types.js'
import {
  engineSignal,
  engineSortKey,
  locationCountLabel,
  nextTrackedSort,
  NOT_ASKED,
  resultClasses,
  rowSignal,
  sourceLabel,
  statusLabel,
  subjectKindLabel,
  subjectLabel,
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

/** Counts the page's font loads: text measured before a font arrives is measured again after it. */
function useFontLoads() {
  const [loads, setLoads] = useState(0)
  useEffect(() => {
    // Typed as optional: a DOM without layout has no font set.
    const page: { fonts?: FontFaceSet } = document
    const fonts = page.fonts
    if (!fonts) return
    const loaded = () => setLoads(count => count + 1)
    fonts.addEventListener('loadingdone', loaded)
    return () => fonts.removeEventListener('loadingdone', loaded)
  }, [])
  return loads
}

/**
 * A piece of a line as the ruler sets it: text in the weight of a query and a
 * Subject's kind, in a name's or in a count's figures, or the gap a one-line
 * Subject keeps before its count.
 */
type Ruled = readonly [face: 'strong' | 'plain' | 'count' | 'gap', text: string]
const ruledKey = ([face, text]: Ruled) => `${face}\n${text}`
const px = (length: string) => Number.parseFloat(length) || 0

/** A closed row's Subject on one line, in the pieces `SubjectCell` draws it in. Company and None are one word and always fit. */
function subjectLine(subject: TrackedSubject): Ruled[] {
  const kind: Ruled = ['strong', `${subjectKindLabel(subject.kind)} ·`]
  const gap: Ruled = ['gap', '']
  switch (subject.kind) {
    case 'market': return [kind, ['plain', ` ${subject.label}`], gap, ['count', `(${subject.locationCount.toLocaleString('en-US')})`]]
    case 'location': return [kind, ['plain', ` ${subject.label}`]]
    case 'hand-picked': return [kind, gap, ['count', locationCountLabel(subject.locationCount)]]
    case 'company':
    case 'none': return []
  }
}

/**
 * Measures each text not yet in `widths`: set on one line of a ruler in the
 * frame, in the table's own type, and never drawn (`.tracked-ruler`). A text
 * is set once, and its width does not depend on how the rows are laid out.
 */
function rule(frame: HTMLElement, texts: readonly Ruled[], widths: Map<string, number>) {
  const fresh = new Map(texts.filter(text => !widths.has(ruledKey(text))).map(text => [ruledKey(text), text]))
  if (fresh.size === 0) return
  const ruler = document.createElement('div')
  ruler.className = 'tracked-ruler'
  for (const [face, text] of fresh.values()) {
    const line = document.createElement('span')
    line.dataset.face = face
    line.textContent = text
    ruler.append(line)
  }
  frame.append(ruler)
  ;[...fresh.keys()].forEach((key, index) => widths.set(key, ruler.children[index]!.getBoundingClientRect().width))
  ruler.remove()
}

/**
 * The lines every closed row of the page takes: 1 where each row's query and
 * Subject fit their columns on one line, and 2 where any does not. It is one
 * answer for the rows shown, so they keep one height, and it is taken again
 * when the rows, the frame or the fonts change. It is taken before the paint,
 * from each text's width on one line (`rule`) against the room its column
 * has, and neither depends on the answer, so it cannot go back and forth.
 * `page` names the rows and the columns wanted. Undecided, where the rows
 * stack or nothing is laid out, it stays as it was.
 */
function useRowLines(frameRef: RefObject<HTMLDivElement | null>, rows: readonly TrackedRowVm[], page: string, frameWidth: number | undefined, active: boolean, fontLoads: number): 1 | 2 {
  const [lines, setLines] = useState<1 | 2>(1)
  const measured = useRef({ fontLoads, widths: new Map<string, number>() })
  const held = useRef<{ page: string; width: number }>(undefined)
  useLayoutEffect(() => {
    const frame = frameRef.current
    const button = frame?.querySelector('.tracked-query')
    const line = button?.firstElementChild
    if (!frame || !active || !button || !line) return
    const column = button.getBoundingClientRect().width
    // A DOM without layout has no room to compare with.
    if (column <= 0) return
    // Query's room is its button less the indent its mark hangs in, and Subject's is its cell less the padding. Both are the same at either height.
    const queryRoom = column - px(getComputedStyle(line).paddingLeft)
    const cell = frame.querySelector('td.tracked-cell-subject')
    const padding = cell ? getComputedStyle(cell) : undefined
    const subjectRoom = cell && padding ? cell.clientWidth - px(padding.paddingLeft) - px(padding.paddingRight) : 0
    if (measured.current.fontLoads !== fontLoads) measured.current = { fontLoads, widths: new Map() }
    const { widths } = measured.current
    const texts = rows.map(row => ({ query: [['strong', row.queryText]] as Ruled[], subject: subjectRoom > 0 ? subjectLine(row.subject) : [] }))
    rule(frame, texts.flatMap(text => [...text.query, ...text.subject]), widths)
    // A line fits with a pixel to spare, so one the ruler and the cell round a fraction apart is never cut short.
    const past = (line: Ruled[], room: number) => line.length > 0 && line.reduce((width, text) => width + widths.get(ruledKey(text))!, 1) > room
    const two = texts.some(text => past(text.query, queryRoom) || past(text.subject, subjectRoom))
    // Two lines make the page taller, and a scrollbar that brings narrows the frame. Where that folds a column away the
    // rows could fit one line again, which would bring the column back. So two lines hold for the same page in a narrower frame.
    const width = frameWidth ?? 0
    const chosen = held.current?.page === page ? held.current.width : undefined
    const holds = chosen !== undefined && width < chosen
    if (two) held.current = { page, width: holds ? chosen : width }
    else if (!holds) held.current = undefined
    setLines(two || holds ? 2 : 1)
  })
  return lines
}

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'

/**
 * A row's last sweep as its Status names it. The badge holds a month and one
 * part more: the day for a sweep of this year or of the last six months,
 * where a month and a day name one date, and the year for an older one ("Dec
 * 2025"). Last measured and the row detail print the date whole.
 */
function measuredDay(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const halfYearAgo = new Date(now)
  halfYearAgo.setMonth(now.getMonth() - 6)
  if (date.getFullYear() === now.getFullYear() || date > halfYearAgo) return formatMonthDay(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

/**
 * The Tracked queries table: one row per query with its Subject, Type, one
 * `SignalPair` per engine and a Status that carries the row's date. The caller
 * sorts, filters and pages the rows; this draws them in the order given and
 * reports a header click through `onSortChange`.
 *
 * Results join on query and type. A row asked both ways stacks one pair per
 * type in each engine cell, each named with its type, and a result under the
 * other type is never borrowed: a missing one draws Not checked. `coverage`
 * undefined is still loading. A query that is not asked, and an engine a row
 * is not asked on, draw no pair (`rowSignal`): the cell is blank and reads
 * "Not asked" to a screen reader, so Not checked always means a sweep gap.
 * Each pair's bubble opens with whose result it is (`marksFor`). A measured
 * row's Status is plain text; the pill is for the rows that are not measured.
 *
 * The query text and the Subject count open the row detail, for every role.
 * The checkbox column shows only when `onSelectedIdsChange` is given, and a
 * shift-click selects the range from the last row clicked. `highlightedId` is
 * the row a link points at: it is marked, opened and, once the frame is
 * measured and the rows are in their layout, scrolled into view.
 *
 * The frame's width decides the layout (`trackedLayout`). The query is the
 * row's identity, so Query keeps the width of a long one: Last measured and
 * Source are columns only in a frame wide enough for that and stay in the row
 * detail otherwise, then Subject narrows, and a frame too narrow for a table
 * stacks each row. A sort by last sweep shows on Status where Last measured
 * is no column. Nothing scrolls sideways, so the header can stick under the
 * topbar. Stacked rows have no header, so while there are rows a line above
 * them holds what the header did: Select this page and the sort.
 *
 * The rows of a page are one height (`data-lines`, from `useRowLines`). Where
 * every query and Subject shown fits its column, each closed row is one line.
 * Where any does not, each takes two: the query and the Subject's name wrap,
 * and a row with less to say is as tall as the rest. A row asked both ways is
 * taller in either. Text too long for two lines is cut short on the second,
 * and a query cut short carries its whole text as its `title`.
 */
export function TrackedTable({
  rows, engines, coverage, sort, onSortChange, selectedIds, onSelectedIdsChange, highlightedId, renderRowMenu, nextSweepDate, workspace, contextLabels,
  columns, label = 'Tracked queries', emptyState, marksFor, renderRowAnswers, renderRowActions, projectName, currentTargetKey, signal, changes = false,
}: {
  rows: readonly TrackedRowVm[]
  /** Engine keys, one column each, in this order. */
  engines: readonly string[]
  /**
   * Results by query and type. Undefined while they load; a result that is
   * missing draws Not checked. After a failed read pass a map with no result,
   * so every chip reads Not checked, and say so beside the table.
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
  /**
   * The columns the caller wants, all of them by default. `status` carries the
   * row's date ("Measured Oct 7"). `lastMeasured` and `source` are wide-only:
   * wanted or not, they show only in a frame that keeps Query at its full
   * width beside them, and the row detail lists both at any width.
   */
  columns?: readonly TrackedColumn[]
  /** The table's accessible name. */
  label?: string
  /** Shown under the header when there are no rows. */
  emptyState?: ReactNode
  /** Whose mention or citation a row's marks of one type are in the Place shown (`marksSubject`). Each pair's bubble opens with it. */
  marksFor?: (row: TrackedRowVm, queryClass: string) => string | undefined
  /** What each engine answered for an opened row, drawn first in it. */
  renderRowAnswers?: (row: TrackedRowVm) => ReactNode
  /** What to do next with an opened row's query, under its answers. */
  renderRowActions?: (row: TrackedRowVm) => ReactNode
  /** With it, an opened row links each location to its page and each market to its queries. */
  projectName?: string
  /** The location whose page the table is on: its own name is not a link. */
  currentTargetKey?: string
  /** The switch's signal: each engine cell is that one letter. Left out, each is the pair of both. */
  signal?: TrackedSignal
  /** The read compares with the sweep before, so a Change column says what each engine won or lost of `signal`. */
  changes?: boolean
}) {
  const tableId = useId()
  const [frameRef, frameWidth] = useFrameWidth()
  // Where there is an observer the width arrives one render late, and until then the rows are not in their layout.
  const measured = frameWidth !== undefined || typeof ResizeObserver === 'undefined'
  const fontLoads = useFontLoads()
  const selectable = onSelectedIdsChange !== undefined
  const engineColumns: Engine[] = engines.map(key => {
    const name = providerDisplayName(key)
    return { key, label: name, width: trackedEngineColumnWidth(name) }
  })
  // Without a menu to draw, its column gives its width back to Query.
  const wanted = (columns ?? TRACKED_COLUMNS)
    .flatMap((column): TrackedColumn[] => column === 'engines' && changes ? [column, 'change'] : column === 'change' ? [] : [column])
    .filter(column => column !== 'menu' || renderRowMenu !== undefined)
  const layout = trackedLayout(frameWidth, engineColumns.map(engine => engine.width), { columns: wanted, selectable })
  const shown = new Set(layout.columns)
  const lines = useRowLines(frameRef, rows, JSON.stringify([rows.map(row => row.queryId), engineColumns.map(engine => engine.width), wanted, selectable]), frameWidth, measured && !layout.stacked, fontLoads)
  const columnCount = (selectable ? 1 : 0) + [...shown].reduce((count, column) => count + (column === 'engines' ? engineColumns.length : 1), 0)
  // With a result read, a pair that has none was left out of that sweep. With none read, nothing says why.
  const noResult = coverage && coverage.size > 0 ? 'Not in the last sweep.' : undefined
  // What a header sorts by, in header order. Stacked rows have no header, so their Sort select lists the same.
  const sortChoices = [...(sort?.key === 'result' ? [['result', 'Result'] as [TrackedSortKey, string]] : []), ...wanted.flatMap((column): [TrackedSortKey, string][] => {
    switch (column) {
      case 'query': return [['query', 'Query']]
      case 'subject': return [['subject', 'Subject']]
      case 'engines': return engineColumns.map(engine => [engineSortKey(engine.key), engine.label])
      case 'lastMeasured': return [['lastMeasured', 'Last measured']]
      case 'status': return [['status', 'Status']]
      case 'type':
      case 'change':
      case 'source':
      case 'menu': return []
    }
  })]

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
    // Status carries the date: where Last measured is no column, a sort by last sweep shows on Status.
    const active = sort?.key === column || (column === 'status' && sort?.key === 'lastMeasured' && !shown.has('lastMeasured'))
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
      <table aria-label={label} className="tracked-table" data-layout={layout.stacked ? 'stacked' : 'table'} data-lines={layout.stacked ? undefined : lines} data-selectable={selectable ? '' : undefined}>
        {layout.stacked ? null : (
          <colgroup>
            {selectable ? <col style={{ width: TRACKED_COLUMN_WIDTH.select }} /> : null}
            <col />
            {shown.has('subject') ? <col style={{ width: layout.subjectWidth }} /> : null}
            {shown.has('type') ? <col style={{ width: TRACKED_COLUMN_WIDTH.type }} /> : null}
            {shown.has('engines') ? engineColumns.map(engine => <col key={engine.key} style={{ width: engine.width }} />) : null}
            {shown.has('change') ? <col style={{ width: TRACKED_COLUMN_WIDTH.change }} /> : null}
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
              {header('query', 'Query', 'tracked-cell-query')}
              {shown.has('subject') ? header('subject', 'Subject') : null}
              {shown.has('type') ? <th scope="col">Type</th> : null}
              {shown.has('engines') ? engineColumns.map(engine => <Fragment key={engine.key}>{header(engineSortKey(engine.key), engine.label, 'tracked-cell-engine')}</Fragment>) : null}
              {shown.has('change') ? <th scope="col" className="tracked-cell-change">Change<span className="block text-[11px] font-normal leading-4 text-muted">vs previous sweep</span></th> : null}
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
            const status = statusLabel(row.status, nextSweepDate, row.lastMeasuredAt ? measuredDay(row.lastMeasuredAt) : undefined)
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
                  <td className="tracked-cell-query"><QueryButton text={row.queryText} discloses={discloses} /></td>
                  {/* Stacked, the menu is on the first line beside the query, so it is the next stop after it. */}
                  {layout.stacked ? menuCell : null}
                  {shown.has('subject') ? <td className="tracked-cell-subject"><SubjectCell subject={row.subject} discloses={discloses} fit={layout.stacked || open ? 'whole' : lines === 2 ? 'lines' : 'line'} room={`${layout.subjectWidth}:${fontLoads}`} /></td> : null}
                  {shown.has('type') ? <td className="tracked-cell-type"><TypeCell type={row.type} classes={row.queryClasses} /></td> : null}
                  {shown.has('engines') ? engineColumns.map(engine => {
                    const pairs = resultClasses(row).map(queryClass => ({ queryClass, signal: rowSignal(row, coverage, queryClass, engine.key) }))
                    // No pair to draw. Under a header the cell is blank. Stacked, its engine's name goes with the chips, so the cell is only read.
                    if (pairs.every(pair => pair.signal === NOT_ASKED)) {
                      return <td key={engine.key} className={`tracked-cell-engine${layout.stacked ? ' sr-only' : ''}`}><span className="sr-only">{layout.stacked ? `${engine.label}: ` : ''}Not asked</span></td>
                    }
                    return (
                      <td key={engine.key} className="tracked-cell-engine">
                        {/* A stacked row has no header to read the engine from, so each cell names its own. */}
                        {layout.stacked && !mixed ? <span className="tracked-engine-name" aria-hidden="true">{engine.label}</span> : null}
                        <PairStack mixed={mixed} engineLabel={engine.label} named={layout.stacked}>
                          {pairs.map(({ queryClass, signal: result }) => result === NOT_ASKED ? (
                            // One type of a row asked both ways has a result here from before its engines changed: the other keeps its line.
                            <span key={queryClass} className="tracked-pair-label"><span className="sr-only">{typeLabel(queryClass as QueryClass)}: Not asked</span></span>
                          ) : signal ? (
                            <SignalLetter
                              key={queryClass}
                              signal={result}
                              which={signal}
                              engineLabel={engine.label}
                              classLabel={mixed ? typeLabel(queryClass as QueryClass) : undefined}
                              subject={marksFor?.(row, queryClass)}
                              noResult={noResult}
                            />
                          ) : (
                            <SignalPair
                              key={queryClass}
                              signal={result}
                              engineLabel={engine.label}
                              classLabel={mixed ? typeLabel(queryClass as QueryClass) : undefined}
                              subject={marksFor?.(row, queryClass)}
                              noResult={noResult}
                            />
                          ))}
                        </PairStack>
                      </td>
                    )
                  }) : null}
                  {shown.has('change') ? <td className="tracked-cell-change"><ChangeCell row={row} engines={engineColumns} coverage={coverage} signal={signal ?? 'mentioned'} /></td> : null}
                  {shown.has('lastMeasured') ? (
                    <td className="tracked-cell-date">
                      {row.lastMeasuredAt ? <time dateTime={row.lastMeasuredAt}>{formatSweepDay(row.lastMeasuredAt)}</time> : 'Never'}
                    </td>
                  ) : null}
                  {shown.has('status') ? (
                    <td className="tracked-cell-status">
                      {row.status === 'measured' ? (
                        // Most rows are measured, so the column marks only the rows that are not; a measured one is said, not drawn.
                        <span className="sr-only">{status}</span>
                      ) : (
                        <ToneBadge
                          tone="neutral"
                          // One line of 16px, so a one-line row is as tall as its text. A label too long for the column is cut short, never drawn over Source.
                          className={`block w-fit max-w-full truncate leading-4 ${row.status === 'first-answers' ? 'border-info-500/30 bg-info-500/10 text-info-300' : ''}`}
                        >
                          {status}
                        </ToneBadge>
                      )}
                    </td>
                  ) : null}
                  {shown.has('source') ? <td className="tracked-cell-source"><span title={sourceLabel(row.source)}>{sourceLabel(row.source)}</span></td> : null}
                  {layout.stacked ? null : menuCell}
                </tr>
                {open ? (
                  <tr id={detailId} className="tracked-detail-row" data-highlighted={row.queryId === highlightedId ? '' : undefined}>
                    <td colSpan={columnCount}><TrackedRowDetail row={row} workspace={workspace} contextLabels={contextLabels} answers={renderRowAnswers?.(row)} actions={renderRowActions?.(row)} projectName={projectName} currentTargetKey={currentTargetKey} /></td>
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

/**
 * What each engine won or lost of the signal since the previous sweep, as the
 * read marks it: "▲ Claude ▼ Gemini". Blank when nothing changed, or when the
 * row is new or not measured both times. Each type of a row asked both ways
 * is read, and an engine is named once per change.
 */
function ChangeCell({ row, engines, coverage, signal }: { row: TrackedRowVm; engines: readonly Engine[]; coverage: TrackedCoverage | undefined; signal: TrackedSignal }) {
  const field = signal === 'cited' ? 'citationChange' : 'mentionChange'
  const marks = engines.flatMap(engine => {
    const changes = new Set(resultClasses(row).map(queryClass => engineSignal(coverage, row.queryId, queryClass, engine.key)?.[field]).filter(change => change !== undefined))
    return [...changes].map(change => ({ engine: engine.label, change: change! }))
  })
  if (marks.length === 0) return null
  const verb = signal === 'cited' ? 'citation' : 'mention'
  return (
    <span className="flex flex-wrap gap-x-2 text-[13px] leading-5">
      {marks.map(({ engine, change }) => (
        <span key={`${engine}:${change}`} className={`inline-flex items-center gap-1 whitespace-nowrap font-medium ${change === 'won' ? 'text-positive-400' : 'text-negative-400'}`}>
          <Triangle aria-hidden="true" className={`size-2.5 fill-current ${change === 'lost' ? 'rotate-180' : ''}`} />
          {engine}
          <span className="sr-only">{` ${change} the ${verb}`}</span>
        </span>
      ))}
    </span>
  )
}

type Discloses = { 'aria-expanded': boolean; 'aria-controls': string | undefined; onClick: () => void }

/**
 * The query, which opens its row. A closed row cuts a long one short: at the
 * column's edge on a page of one-line rows, and after two lines on a page of
 * two-line rows, where it stacks or under a finger. Only then is the whole
 * text the button's `title`, and under keyboard focus the stylesheet shows
 * the line whole (`data-clipped`). The line is measured against the button,
 * whose width that leaves alone, after each draw and again under the pointer
 * and on focus: a late font moves the edge without a draw. The edges are
 * unrounded: a line a fraction of a pixel too long is cut short too, and in
 * whole pixels it fits.
 */
function QueryButton({ text, discloses }: { text: string; discloses: Discloses }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [clipped, setClipped] = useState(false)
  const measure = () => {
    const button = ref.current
    const line = button?.firstElementChild
    if (!button || !line) return
    const range = document.createRange()
    range.selectNodeContents(line)
    // Typed as optional: a DOM without layout has no such method, and whole pixels are all it has.
    const drawn: { getBoundingClientRect?: () => DOMRect } = range
    const past = drawn.getBoundingClientRect ? drawn.getBoundingClientRect().right > button.getBoundingClientRect().right : line.scrollWidth > button.clientWidth
    setClipped(past || line.scrollHeight > line.clientHeight)
  }
  useLayoutEffect(measure)
  return (
    <button ref={ref} type="button" className={`tracked-query ${FOCUS}`} title={clipped ? text : undefined} data-clipped={clipped ? '' : undefined} onPointerEnter={measure} onFocus={measure} {...discloses}>
      <span><ChevronRight aria-hidden="true" className="tracked-query-mark" />{text}</span>
    </button>
  )
}

/**
 * The lines a wrapped inline box is drawn on. A browser reports a box for
 * each piece of each line, so the lines are counted by where they start: the
 * pieces of one line start level, and the next line a line's height under.
 */
function lineCount(box: Element): number {
  let lines = 0
  let top = Number.NEGATIVE_INFINITY
  for (const piece of [...box.getClientRects()].sort((first, second) => first.top - second.top)) {
    if (piece.top - top <= piece.height / 2) continue
    lines += 1
    top = piece.top
  }
  return lines
}

/** Whether a wrapped inline box runs past its cell: a last word wider than the column cannot wrap, as its count holds to it. */
function pastCell(box: Element): boolean {
  const edge = box.parentElement?.getBoundingClientRect().right
  return edge !== undefined && [...box.getClientRects()].some(piece => piece.right > edge)
}

/**
 * "Market · Uptown (3)": the kind stays on the first line, and the count stays
 * on the last word of the name however the name wraps. The count opens the
 * row detail, which lists the locations it counts. `fit` is how a closed row
 * of the table holds it. On one `line`, a name too long for the column is cut
 * short and the count after it never is. On two `lines`, on a page of
 * two-line rows, it wraps as the open row's does, and nothing clips it or the
 * wider target a finger gets on its count. One that wraps past two lines, or
 * whose last word is wider than the column and so runs past the cell, is found
 * by the boxes it is drawn in, once for its text and `room`, and is then cut
 * short on the second line with its count beside it. An open or stacked
 * row shows the name `whole`. All are one tree of elements, so the count that
 * opens a row keeps the focus.
 */
function SubjectCell({ subject, discloses, fit, room }: { subject: TrackedSubject; discloses: Discloses; fit: 'line' | 'lines' | 'whole'; room: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const here = `${room}:${subjectLabel(subject)}`
  const [longAt, setLongAt] = useState<string>()
  const long = fit === 'lines' && longAt === here
  // This runs before the paint, so a third line is never seen.
  useLayoutEffect(() => {
    if (fit === 'lines' && !long && ref.current && (lineCount(ref.current) > 2 || pastCell(ref.current))) setLongAt(here)
  })
  const cut = fit === 'line' || long
  const kind = <span className="font-medium text-strong">{subjectKindLabel(subject.kind)}</span>
  // The dot stays with the kind, so a line never starts with it.
  const lead = <><span className="whitespace-nowrap">{kind} <span aria-hidden="true">·</span></span>{' '}</>
  const box = { ref, className: cut ? 'tracked-subject' : undefined, 'data-long': long ? '' : undefined }
  const name = cut ? 'tracked-subject-name' : undefined
  switch (subject.kind) {
    case 'market': {
      const split = cut ? subject.label.length : subject.label.lastIndexOf(' ') + 1
      return (
        <span {...box}>
          <span className={name} title={cut ? subject.label : undefined}>{lead}{subject.label.slice(0, split)}</span>
          <span className="whitespace-nowrap">
            {subject.label.slice(split)}{' '}
            <button type="button" className={`tracked-count ${FOCUS}`} aria-label={locationCountLabel(subject.locationCount)} {...discloses}>({subject.locationCount.toLocaleString('en-US')})</button>
          </span>
        </span>
      )
    }
    case 'location': return <span {...box}><span className={name} title={cut ? subject.label : undefined}>{lead}{subject.label}</span></span>
    case 'hand-picked': return (
      <span {...box}>
        <span className={name}>{lead}</span>
        <button type="button" className={`tracked-count whitespace-nowrap ${FOCUS}`} {...discloses}>{locationCountLabel(subject.locationCount)}</button>
      </span>
    )
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
