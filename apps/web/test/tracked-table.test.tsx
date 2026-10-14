import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { TrackedTable, TrackedTableSkeleton } from '../src/components/project/queries/advanced/TrackedTable.js'
import {
  coverageByQuery,
  DEFAULT_TRACKED_SORT,
  marksSubject,
  sortTrackedRows,
  toTrackedRows,
  type TrackedResults,
  type TrackedSort,
} from '../src/components/project/queries/advanced/tracked-view-model.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { compileAppStyles, compiledDeclarations, compiledElementProperty, parseCompiledCss } from './compiled-app-css.js'

beforeEach(() => {
  // Dates print without their year only inside the current one.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-10T12:00:00.000Z') })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type Row = QueryTrackingTrackedRow
type Assignment = Row['assignments'][number]

const context = (location: string | null) => ({
  providers: ['openai', 'gemini'],
  models: { openai: 'model-a', gemini: 'model-b' },
  location: location ? { label: location, city: location, region: 'NY', country: 'US' } : null,
})
const assignment = (targetKey: string, queryClass: Assignment['queryClass'], marketKeys: string[] = [], overrides: Partial<Assignment> = {}): Assignment =>
  ({ targetKey, groupKeys: [], marketKeys, queryClass, classificationSource: 'server', contexts: [context('Lakeshore')], ...overrides })
/**
 * Hand-picked locations in key order, as the server sends them. Their names
 * run the other way (`location-0` is the last Residence), so the order shown
 * is the table's own. The first is in two markets and two groups, the second
 * is asked from two search locations, and the third has no type.
 */
const picked = (count: number) => Array.from({ length: count }, (_, index) => {
  if (index === 0) return assignment('location-0', 'branded', ['uptown', 'downtown'], { groupKeys: ['metro', 'north'] })
  if (index === 1) return assignment('location-1', 'branded', [], { contexts: [context('Lakeshore'), context(null)] })
  return assignment(`location-${index}`, index === 2 ? null : 'branded')
})

const MARKET = 'best apartments in Uptown'
const LOCATION = 'is Acme Homes Harbor Point a good place to live'
const HAND_PICKED = 'Acme Homes reviews across the metro'
const MIXED = 'Acme Homes compared with other communities'
const WAITING = 'apartments near the light rail in Old Mill District'
const NOT_ASKED = 'apartments with a rooftop pool'

function tracked(queryId: string, queryText: string, overrides: Partial<Row>): Row {
  return {
    queryId,
    queryText,
    normalizedText: queryText.toLowerCase(),
    provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z' },
    state: 'tracked',
    lastMeasuredAt: '2026-10-07T12:00:00.000Z',
    assignments: [],
    ...overrides,
  }
}

function workspace(handPicked = 12): QueryTrackingWorkspaceResponse {
  return {
    mode: 'advanced',
    workspaceVersion: `qtw_${'a'.repeat(64)}`,
    active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
    defaultContexts: [context('Lakeshore')],
    targets: [
      { stableKey: 'harbor-point', label: 'Acme Homes Harbor Point' },
      ...Array.from({ length: handPicked }, (_, index) => ({ stableKey: `location-${index}`, label: `Acme Homes Residence ${handPicked - index}` })),
    ],
    groups: [
      // Names hold commas, as real ones do.
      { stableKey: 'metro', label: 'Lakeshore, Metro Area', targetKeys: ['location-0'] },
      { stableKey: 'north', label: 'North side', targetKeys: ['location-0'] },
    ],
    markets: [
      // Three locations in the server's list, one in the row's own links: the count shown is the server's.
      { stableKey: 'uptown', label: 'Uptown', usageEdges: [], targetKeys: ['harbor-point', 'location-0', 'location-1'] },
      { stableKey: 'downtown', label: 'Downtown, Lakeshore metro', usageEdges: [], targetKeys: ['location-0'] },
      { stableKey: 'old-mill', label: 'Old Mill District', usageEdges: [], targetKeys: ['location-2', 'location-3', 'location-4', 'location-5'] },
    ],
    tracked: [
      tracked('market', MARKET, {
        focus: { kind: 'market', key: 'uptown' },
        queryClasses: ['non-brand'],
        assignments: [assignment('harbor-point', 'non-brand', ['uptown'])],
        provenance: {
          source: 'template', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z',
          template: { templateId: 'template-best', templateVersion: '1', template: 'best apartments in {market}', bindings: { market: 'Uptown' }, output: MARKET },
        },
      }),
      tracked('location', LOCATION, { focus: { kind: 'property', key: 'harbor-point' }, queryClasses: ['branded'], assignments: [assignment('harbor-point', 'branded', ['uptown'])] }),
      tracked('hand-picked', HAND_PICKED, { focus: { kind: 'custom' }, queryClasses: ['branded'], assignments: picked(handPicked), provenance: { source: 'research', sourceId: 'run-1', capturedAt: '2026-08-20T12:00:00.000Z' } }),
      tracked('mixed', MIXED, { focus: { kind: 'custom' }, queryClasses: ['branded', 'non-brand'], assignments: [assignment('harbor-point', 'branded'), assignment('location-0', 'non-brand')], provenance: { source: 'discovery', sourceId: 'probe-1', capturedAt: '2026-08-22T12:00:00.000Z' } }),
      tracked('waiting', WAITING, { focus: { kind: 'market', key: 'old-mill' }, queryClasses: ['non-brand'], assignments: [assignment('location-2', 'non-brand', ['old-mill'])], state: 'awaiting-sweep', lastMeasuredAt: null, provenance: { source: 'query-set', sourceId: null, capturedAt: '2026-10-09T12:00:00.000Z' } }),
      tracked('not-asked', NOT_ASKED, { focus: { kind: 'not-asked' }, queryClasses: [], state: 'awaiting-sweep', lastMeasuredAt: null, provenance: null }),
    ],
    savedSources: { research: [], discovery: [] },
  }
}

const RESULTS: TrackedResults = {
  rows: [
    { queryId: 'market', queryClass: 'non-brand', engines: [{ provider: 'openai', mentioned: true, cited: false, answers: 3, mentionedAnswers: 2, citedAnswers: 0 }] },
    // The location row is asked as Branded. This sweep holds it only under the other type.
    { queryId: 'location', queryClass: 'non-brand', engines: [{ provider: 'openai', mentioned: true, cited: true }, { provider: 'gemini', mentioned: true, cited: true }] },
    { queryId: 'mixed', queryClass: 'branded', engines: [{ provider: 'openai', mentioned: true, cited: true }, { provider: 'gemini', mentioned: false, cited: null }] },
    { queryId: 'mixed', queryClass: 'non-brand', engines: [{ provider: 'openai', mentioned: false, cited: false }] },
  ],
}

const contextLabels: ComponentProps<typeof TrackedTable>['contextLabels'] = contexts =>
  contexts.map(item => `${item.location?.label ?? 'No search location'} · ${item.providers.join(', ')}`)

type Props = ComponentProps<typeof TrackedTable>
function setup(props: Partial<Props> = {}, source = workspace()) {
  const rows = toTrackedRows(source, [{ id: 'template-best', name: 'Best' }])
  const all: Props = { rows, engines: ['openai', 'gemini'], coverage: coverageByQuery(RESULTS), workspace: source, contextLabels, nextSweepDate: 'Oct 21', ...props }
  const view = render(<TrackedTable {...all} />)
  return { rows, props: all, rerender: (next: Partial<Props>) => view.rerender(<TrackedTable {...all} {...next} />) }
}

const table = () => screen.getByRole('table', { name: 'Tracked queries' })
const headers = () => within(table()).getAllByRole('columnheader').slice(0, within(table()).getAllByRole('row')[0]!.children.length)
const headerNames = () => headers().map(header => header.textContent)
const query = (text: string) => screen.getByRole('button', { name: text })
const rowOf = (text: string) => query(text).closest('tr')!
const ENGINE_PAIR = /^(OpenAI|Gemini|Claude|Local)[,:]/
/** A row's cells as read, engine cells aside: their chips are read by name. */
const cells = (text: string) => [...rowOf(text).children]
  .filter(cell => !cell.classList.contains('tracked-cell-engine'))
  .map(cell => cell.textContent)
/** A row's engine cells, in column order. */
const engineCells = (text: string) => [...rowOf(text).querySelectorAll<HTMLElement>(':scope > td.tracked-cell-engine')]
/** What a row's engine cells say to a screen reader: each pair by its name, and a cell with no pair by its text. */
const engineCellsRead = (text: string) => engineCells(text).map(cell => {
  const pairs = within(cell).queryAllByRole('button').map(pair => pair.getAttribute('aria-label'))
  return pairs.length > 0 ? pairs.join(' | ') : cell.textContent
})
const queryOrder = () => within(table()).getAllByRole('button', { expanded: false }).filter(button => button.classList.contains('tracked-query')).map(button => button.textContent)
/** Each column's set width in px, in order. Query has none: it takes what the others leave. */
const columnWidths = () => [...table().querySelectorAll('col')].map(column => column.style.width)

/**
 * A frame of this width, as a browser gives it: measured when asked, and
 * reported by the observer only after `observe` has returned. `report` is that
 * later report, of the same width or of a new one. Nothing inside the frame
 * has a size: jsdom lays nothing out (`textLayout` does).
 */
function frameWidth(width: number) {
  let observed: ((entries: { contentRect: { width: number } }[]) => void) | undefined
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return { width: this.classList.contains('tracked-table-frame') ? width : 0 } as DOMRect })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: NonNullable<typeof observed>) { observed = callback }
    observe() {}
    disconnect() {}
  })
  return { report: (next = width) => act(() => observed!([{ contentRect: { width: next } }])) }
}

/**
 * Text as a browser lays it out, which jsdom does not: `char` px a character
 * (7 to start), in a Query column `column` px wide and a Subject cell with
 * `subject` px for its text, inside jsdom's own 1px of cell padding. A closed
 * row of the table holds its query on as many lines as the page gives its
 * rows (`data-lines`), a stacked row on two and an open row on all it needs;
 * a line is 20px. The ruler sets any text on one line, and `ruled` lists each
 * text it was asked for. Edges are reported unrounded and widths in whole
 * pixels, as a browser does both. Call it before the table is drawn and
 * after `frameWidth`, whose measure it keeps.
 */
function textLayout(column: number, subject = 400) {
  const state = { column, subject, char: 7, ruled: [] as string[] }
  const frame = vi.mocked(Element.prototype.getBoundingClientRect).getMockImplementation()!
  const width = (element: Element) => element.textContent!.length * state.char
  const lines = (element: Element, room: number) => Math.max(1, Math.ceil(width(element) / room))
  /** A query's line: the lines it may take and the lines it needs. */
  const set = (element: Element) => {
    if (!element.parentElement?.classList.contains('tracked-query')) return null
    const row = element.closest('tr')!
    const table = row.closest('table')!
    const allowed = row.hasAttribute('data-open') ? Infinity : table.getAttribute('data-layout') === 'stacked' || table.getAttribute('data-lines') === '2' ? 2 : 1
    return { allowed, needed: lines(element, state.column) }
  }
  const oneLine = (element: Element) => set(element)?.allowed === 1 ? width(element) : 0
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.parentElement?.classList.contains('tracked-ruler')) {
      state.ruled.push(this.textContent!)
      // The gap a one-line Subject keeps before its count is 4px.
      return { width: (this as HTMLElement).dataset.face === 'gap' ? 4 : width(this) } as DOMRect
    }
    // The Subject's cell ends where its room for text does.
    if (this.classList.contains('tracked-cell-subject')) return { width: state.subject, right: state.subject } as DOMRect
    return this.classList.contains('tracked-query') ? { width: state.column, right: state.column } as DOMRect : frame.call(this)
  })
  // A Subject that wraps is reported as a browser does it: a box for each piece of each line, here its two halves, 17px tall on lines 20px apart.
  // One held to a line, or to two with its name cut short, is a box of its own.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const wraps = this.parentElement?.classList.contains('tracked-cell-subject') && !this.classList.contains('tracked-subject')
    const pieces = wraps ? 2 * lines(this, state.subject) : 1
    // The last piece is the name's last word with its count, which never wrap apart: it ends where its own width puts it, the others inside the cell.
    const words = this.textContent!.trim().split(' ')
    const tail = (/^\(\d[\d,]*\)$/.test(words.at(-1)!) && words.length > 1 ? `${words.at(-2)} ${words.at(-1)}` : words.at(-1)!).length * state.char
    return Array.from({ length: pieces }, (_, piece) => ({ top: 9 + 20 * Math.floor(piece / 2), height: 17, right: wraps && piece === pieces - 1 ? tail : Math.min(width(this), state.subject) })) as unknown as DOMRectList
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value(this: Range) {
    const line = this.startContainer as Element
    // Wrapped, a line ends at the column's edge or before it.
    return { right: oneLine(line) || Math.min(width(line), state.column) } as DOMRect
  } })
  onTestFinished(() => { Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect') })
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('tracked-query') ? Math.round(state.column) : this.classList.contains('tracked-cell-subject') ? state.subject + 2 : 0
  })
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) { return oneLine(this) })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    const text = set(this)
    return text ? 20 * Math.min(text.needed, text.allowed) : 0
  })
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    const text = set(this)
    return text ? 20 * (text.allowed === 1 ? 1 : text.needed) : 0
  })
  return state
}

function scrollSpy(onScroll?: () => void) {
  const scrollIntoView = vi.fn(onScroll)
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })
  return scrollIntoView
}

describe('TrackedTable', () => {
  it('draws a column per engine and a row per query, with its Subject, Type, last sweep, Status and Source', () => {
    setup()
    expect(headerNames()).toEqual(['Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Last measured', 'Status', 'Source'])
    // The market's count is the server's member list (3), not the one location this row links. Status carries the row's own date.
    expect(cells(MARKET)).toEqual([MARKET, 'Market · Uptown (3)', 'Non-brand', 'Oct 7', 'Measured Oct 7', 'Pattern: Best'])
    expect(cells(LOCATION).slice(1, 3)).toEqual(['Location · Acme Homes Harbor Point', 'Branded'])
    expect(cells(HAND_PICKED)).toEqual([HAND_PICKED, 'Hand-picked · 12 locations', 'Branded', 'Oct 7', 'Measured Oct 7', 'Research'])
    // A row never measured names no date of its own: a waiting one names the next sweep's.
    expect(cells(WAITING)).toEqual([WAITING, 'Market · Old Mill District (4)', 'Non-brand', 'Never', 'First answers Oct 21', 'Setup'])
    expect(cells(NOT_ASKED)).toEqual([NOT_ASKED, 'None', 'Not set', 'Never', 'Not asked', 'Older list'])
    // Under a header, a cell holds the chips alone.
    expect(within(rowOf(MARKET)).queryByText('OpenAI')).toBeNull()
  })

  it('prints a measured row\'s Status as plain text, and keeps the pill for a row waiting on its first answers and one that is not asked', async () => {
    setup()
    const status = (text: string) => rowOf(text).querySelector('.tracked-cell-status')!.firstElementChild!
    const classes = (text: string) => status(text).className.split(' ')
    // Nearly every row is measured: a pill on each would mark nothing.
    expect(status(MARKET).textContent).toBe('Measured Oct 7')
    expect(classes(MARKET).filter(name => /^(?:border|bg-|rounded)/.test(name))).toEqual([])
    expect(classes(MARKET)).toEqual(expect.arrayContaining(['text-secondary', 'truncate']))
    expect(classes(MARKET)).not.toContain('text-positive')
    expect(classes(WAITING)).toEqual(expect.arrayContaining(['rounded-md', 'border', 'border-info-500/30', 'bg-info-500/10', 'text-info-300']))
    expect(classes(WAITING)).not.toContain('text-neutral')
    expect(classes(NOT_ASKED)).toEqual(expect.arrayContaining(['rounded-md', 'border', 'text-neutral']))
    expect(classes(NOT_ASKED)).not.toContain('text-info-300')
    // The text is as tall as the pill, so a page that holds both keeps its rows one height: 16px of line and 3px above and below, the pill's padding and border.
    const rules = parseCompiledCss(await compileAppStyles([...status(MARKET).classList, ...status(WAITING).classList]))
    const height = (text: string) => ['line-height', 'padding-block', 'border-width'].map(property => compiledElementProperty(rules, status(text), property))
    expect(height(MARKET)).toEqual(['calc(var(--spacing) * 4)', '3px', undefined])
    expect(height(WAITING)).toEqual(['calc(var(--spacing) * 4)', 'calc(var(--spacing) * 0.5)', '1px'])
  })

  it('keeps a market\'s count after its name in a closed row, and on the last word of the name where the name wraps', () => {
    setup()
    const count = within(rowOf(WAITING)).getByRole('button', { name: '4 locations' })
    // A closed row is one line: the name is cut short as one piece, and the count stands outside it.
    const name = count.parentElement!.previousElementSibling as HTMLElement
    expect([name.className, name.textContent, name.title]).toEqual(['tracked-subject-name', 'Market · Old Mill District', 'Old Mill District'])
    expect(count.parentElement!.textContent).toBe(' (4)')
    // The open row wraps. The count is the same button, so it keeps the focus that opened the row.
    count.focus()
    fireEvent.click(count)
    expect(document.activeElement).toBe(count)
    expect(count.parentElement!.textContent).toBe('District (4)')
    expect(count.parentElement!.className).toContain('whitespace-nowrap')
    expect(rowOf(WAITING).querySelector('.tracked-subject-name')).toBeNull()
  })

  it('marks the query as something that opens', () => {
    setup()
    expect(query(MARKET).querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it('names no date on a waiting row when no sweep date is known', () => {
    setup({ nextSweepDate: undefined })
    expect(cells(WAITING)[4]).toBe('First answers')
  })

  describe('the date in Status', () => {
    const dated = (dates: Record<string, string | null>) => {
      const source = workspace()
      source.tracked = source.tracked.map(row => row.queryId in dates ? { ...row, lastMeasuredAt: dates[row.queryId]! } : row)
      setup({}, source)
      return [MARKET, LOCATION, HAND_PICKED].map(text => cells(text).slice(3, 5))
    }

    it('is each measured row\'s own: its day for a sweep of this year, its year for an older one', () => {
      // Today is Oct 10, 2026. Nov 15 was eleven months ago: its day alone would read as a day next month.
      expect(dated({ market: '2025-12-28T12:00:00.000Z', location: '2026-01-05T12:00:00.000Z', 'hand-picked': '2025-11-15T12:00:00.000Z', mixed: null })).toEqual([
        // Last measured prints the date whole. Status has room for a month and one part more.
        ['Dec 28, 2025', 'Measured Dec 2025'],
        ['Jan 5', 'Measured Jan 5'],
        ['Nov 15, 2025', 'Measured Nov 2025'],
      ])
      // Tracked, with no sweep on record yet.
      expect(cells(MIXED).at(-2)).toBe('Measured')
      // One label on one line: no second element holds the date.
      const status = rowOf(LOCATION).querySelector('.tracked-cell-status')!
      expect([status.children.length, status.firstElementChild!.children.length]).toEqual([1, 0])
    })

    it('keeps its day across a new year for six months', () => {
      vi.setSystemTime(new Date('2027-01-15T12:00:00.000Z'))
      // Dec 28 and Aug 3 are inside the six months before Jan 15. Jul 10 is five days outside them.
      expect(dated({ market: '2026-12-28T12:00:00.000Z', location: '2026-08-03T12:00:00.000Z', 'hand-picked': '2026-07-10T12:00:00.000Z' })).toEqual([
        ['Dec 28, 2026', 'Measured Dec 28'],
        ['Aug 3, 2026', 'Measured Aug 3'],
        ['Jul 10, 2026', 'Measured Jul 2026'],
      ])
    })
  })

  describe('long text', () => {
    // 73 characters: 511px at 7px each, so one line of a 424px column cannot hold it and two can.
    const LONG = 'apartments with in unit washer dryer Northbridge Heights, Lakeshore metro'
    // 140 characters: 980px, past two lines of 424px.
    const LONGEST = 'two bedroom apartments under 2000 with in unit washer dryer, covered parking and a dog park near the lakefront trail in Northbridge Heights'
    const market = (id: string, text: string) => tracked(id, text, { focus: { kind: 'market', key: 'uptown' }, queryClasses: ['non-brand'], assignments: [assignment('harbor-point', 'non-brand', ['uptown'])] })
    const withRows = (...added: Row[]) => {
      const source = workspace()
      source.tracked = [...source.tracked, ...added]
      return source
    }
    const long = () => withRows(market('long', LONG))
    const FULL = { engines: ['openai', 'gemini', 'claude'], onSelectedIdsChange: vi.fn() }
    const titled = () => within(table()).getAllByRole('button').filter(button => button.hasAttribute('title') && button.classList.contains('tracked-query')).map(button => button.title)
    /** The lines every closed row of the page takes: the table's one answer, which the stylesheet turns into each row's height. */
    const pageLines = () => table().getAttribute('data-lines')
    const subjectOf = (text: string) => rowOf(text).querySelector('.tracked-cell-subject')!.firstElementChild as HTMLElement

    describe('the lines of a page', () => {
      it('are one where every query and Subject fits its column', () => {
        frameWidth(1152)
        // The longest query here is 51 characters, 357px, and the longest Subject 34, 238px.
        const layout = textLayout(424, 240)
        setup(FULL)
        expect(pageLines()).toBe('1')
        // No row has a height of its own, and nothing is cut short.
        expect([...table().querySelectorAll('tr')].filter(row => row.hasAttribute('data-lines') || row.hasAttribute('style'))).toEqual([])
        expect(titled()).toEqual([])
        // Each Subject is on one line, its count after its name.
        expect([subjectOf(WAITING).className, subjectOf(WAITING).textContent]).toEqual(['tracked-subject', 'Market · Old Mill District (4)'])
        // The ruler took each text's width and is gone.
        expect(layout.ruled).toContain(WAITING)
        expect(document.querySelector('.tracked-ruler')).toBeNull()
      })

      it('are two for every row where one query does not fit, and one again when that row leaves the page', () => {
        frameWidth(1152)
        textLayout(424, 240)
        const { rows, rerender } = setup(FULL, long())
        expect(pageLines()).toBe('2')
        // The one answer is the table's: every row reads it, the short ones too, and none carries another.
        expect([...table().querySelectorAll('tr')].filter(row => row.hasAttribute('data-lines') || row.hasAttribute('style'))).toEqual([])
        // Two lines hold the long query whole, so it has no title.
        expect(titled()).toEqual([])
        expect(query(LONG).hasAttribute('data-clipped')).toBe(false)
        // A Subject wraps as the open row's does: the count is on the last word of the name.
        const count = within(rowOf(WAITING)).getByRole('button', { name: '4 locations' })
        expect([subjectOf(WAITING).className, count.parentElement!.textContent, count.parentElement!.className]).toEqual(['', 'District (4)', 'whitespace-nowrap'])
        expect(rowOf(WAITING).querySelector('.tracked-subject-name')).toBeNull()

        // Another page, a filter or a search: the rows shown decide again.
        rerender({ rows: rows.filter(row => row.queryId !== 'long') })
        expect(pageLines()).toBe('1')
        expect(subjectOf(WAITING).className).toBe('tracked-subject')
        rerender({ rows: [...rows].reverse() })
        expect(pageLines()).toBe('2')
      })

      it('are two where a Subject does not fit, though every query does', () => {
        frameWidth(1152)
        // "Location · Acme Homes Harbor Point" is 238px. A line is asked to fit with a pixel to spare, so 238px of room are too few.
        textLayout(424, 238)
        setup(FULL)
        expect(pageLines()).toBe('2')
        // Wrapped, it has no box of its own to clip it.
        expect(subjectOf(LOCATION).className).toBe('')
        // One pixel more and it fits.
        cleanup()
        textLayout(424, 239)
        setup(FULL)
        expect(pageLines()).toBe('1')
      })

      it('stay as they are when a row opens or closes', () => {
        frameWidth(1152)
        textLayout(424, 240)
        const { rerender, rows } = setup(FULL, long())
        // The long row open shows its text whole and no longer needs two lines. The page keeps them all the same.
        fireEvent.click(query(LONG))
        expect([query(LONG).getAttribute('aria-expanded'), pageLines()]).toEqual(['true', '2'])
        fireEvent.click(query(MARKET))
        fireEvent.click(query(LONG))
        expect(pageLines()).toBe('2')
        // A page of one-line rows keeps one line with a row open.
        rerender({ rows: rows.filter(row => row.queryId !== 'long') })
        expect([query(MARKET).getAttribute('aria-expanded'), pageLines()]).toEqual(['true', '1'])
        fireEvent.click(query(WAITING))
        expect(pageLines()).toBe('1')
      })

      it('measure each text once', () => {
        frameWidth(1152)
        const layout = textLayout(424, 240)
        const { rows, rerender } = setup(FULL)
        const first = [...layout.ruled]
        expect(new Set(first).size).toBe(first.length)
        // Six queries, and each Subject's pieces: the kind, the name, the gap before the count and the count.
        expect(first).toEqual(expect.arrayContaining([MARKET, NOT_ASKED, 'Market ·', ' Uptown', '', '(3)', 'Location ·', ' Acme Homes Harbor Point', 'Hand-picked ·', '12 locations']))
        // Opening a row, ticking one and drawing the same rows again measure nothing.
        fireEvent.click(query(MARKET))
        rerender({ selectedIds: new Set(['market']) })
        expect(layout.ruled).toEqual(first)
        // A row new to the page is measured, and only its own text: its Subject's pieces are known.
        rerender({ rows: [...rows, ...toTrackedRows(long(), []).filter(row => row.queryId === 'long')] })
        expect(layout.ruled.slice(first.length)).toEqual([LONG])
      })

      it('are taken again when a font arrives, which changes every width', () => {
        const fonts = new EventTarget()
        Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
        onTestFinished(() => { Reflect.deleteProperty(document, 'fonts') })
        frameWidth(1152)
        const layout = textLayout(424, 400)
        setup(FULL)
        expect(pageLines()).toBe('1')
        // In the font that arrives the 51-character query is 459px.
        layout.char = 9
        act(() => { fonts.dispatchEvent(new Event('loadingdone')) })
        expect(pageLines()).toBe('2')
        expect(layout.ruled.filter(text => text === WAITING)).toHaveLength(2)
      })

      it('hold at two for the same rows in a narrower frame, where a folded column would bring one line back', () => {
        const frame = frameWidth(1152)
        const layout = textLayout(424, 240)
        const { rows, rerender } = setup(FULL, long())
        expect(pageLines()).toBe('2')
        // Taller rows bring a scrollbar, the frame narrows by it, and a column folding there leaves Query more room than before.
        layout.column = 600
        frame.report(1137)
        expect(pageLines()).toBe('2')
        // Other rows decide for themselves, in whatever frame.
        rerender({ rows: rows.slice(0, 3) })
        expect(pageLines()).toBe('1')
        // So does a frame as wide as the one two lines were chosen in.
        layout.column = 424
        rerender({ rows })
        expect(pageLines()).toBe('2')
        layout.column = 600
        frame.report(1137)
        frame.report(1152)
        expect(pageLines()).toBe('1')
      })

      it('are not counted where the rows stack or nothing is laid out', () => {
        setup({}, long())
        // No layout: the rows are one line, as the table draws them before it is measured.
        expect(pageLines()).toBe('1')
        cleanup()
        frameWidth(358)
        textLayout(250)
        setup({}, long())
        expect([table().getAttribute('data-layout'), pageLines()]).toEqual(['stacked', null])
        // A stacked row shows its Subject whole.
        expect(subjectOf(WAITING).className).toBe('')
      })
    })

    describe('a Subject on a page of two-line rows', () => {
      it('is cut short on the second line when it is too long for two, with its count beside it', () => {
        const frame = frameWidth(1152)
        // 100px hold 14 characters: "Market · Old Mill District (4)" needs three lines, "Market · Uptown (3)" two.
        const layout = textLayout(424, 100)
        setup(FULL)
        const count = within(rowOf(WAITING)).getByRole('button', { name: '4 locations' })
        const box = subjectOf(WAITING)
        expect([box.className, box.hasAttribute('data-long')]).toEqual(['tracked-subject', true])
        // The name is one piece again, cut short as one, and the count stands outside it. Its whole text is its title.
        const name = box.firstElementChild as HTMLElement
        expect([name.className, name.textContent, name.title]).toEqual(['tracked-subject-name', 'Market · Old Mill District', 'Old Mill District'])
        expect(count.parentElement!.textContent).toBe(' (4)')
        // One that fits two lines wraps, with nothing to say in a title.
        expect([subjectOf(MARKET).className, subjectOf(MARKET).hasAttribute('data-long'), subjectOf(MARKET).querySelector('[title]')]).toEqual(['', false, null])
        // A location has no count: it is cut short the same way.
        expect([subjectOf(LOCATION).hasAttribute('data-long'), (subjectOf(LOCATION).firstElementChild as HTMLElement).title]).toEqual([true, 'Acme Homes Harbor Point'])

        // It is found again in a column of another width: here one with room for it on two lines.
        count.focus()
        layout.subject = 120
        frame.report(1100)
        expect(columnWidths()[2]).toBe('234px')
        expect([subjectOf(WAITING).className, subjectOf(WAITING).hasAttribute('data-long')]).toEqual(['', false])
        // The count is the same button throughout, so it keeps the focus.
        expect(document.activeElement).toBe(count)
      })
    })

    describe('a Subject whose last word is wider than its column', () => {
      it('is cut short with its count in the cell, so nothing runs into the next one', () => {
        const frame = frameWidth(1152)
        // 68px hold nine characters. "Market · Uptown (3)" takes two lines by length, but "Uptown (3)" cannot wrap and needs 70px.
        const layout = textLayout(424, 68)
        setup(FULL)
        const box = subjectOf(MARKET)
        expect([box.className, box.hasAttribute('data-long')]).toEqual(['tracked-subject', true])
        const count = within(rowOf(MARKET)).getByRole('button', { name: '3 locations' })
        expect(count.parentElement!.textContent).toBe(' (3)')
        expect((box.firstElementChild as HTMLElement).title).toBe('Uptown')

        // With room for the last word it wraps whole again.
        layout.subject = 72
        frame.report(1100)
        expect([subjectOf(MARKET).className, subjectOf(MARKET).hasAttribute('data-long')]).toEqual(['', false])
      })
    })

    describe('a query cut short', () => {
      it('carries its whole text as a title only while it is cut short', () => {
        frameWidth(1152)
        const layout = textLayout(424)
        setup(FULL, withRows(market('long', LONG), market('longest', LONGEST)))
        // Two lines of 424px hold the 511px query whole and cut the 980px one short.
        expect(table().getAttribute('data-lines')).toBe('2')
        expect(titled()).toEqual([LONGEST])
        expect([query(LONGEST), query(LONG), query(WAITING)].map(button => button.hasAttribute('data-clipped'))).toEqual([true, false, false])
        // The name is the text either way, so the title adds nothing to it.
        expect(query(LONGEST).getAttribute('aria-label')).toBeNull()

        // The open row shows the text whole.
        fireEvent.click(query(LONGEST))
        expect(titled()).toEqual([])
        fireEvent.click(query(LONGEST))
        expect(titled()).toEqual([LONGEST])

        // The edge moves with no draw, as when a font arrives: the pointer and the focus each measure again.
        layout.column = 200
        fireEvent.pointerEnter(query(LONG))
        expect(titled()).toEqual([LONG, LONGEST])
        // 357px fit two lines of 200.
        fireEvent.focus(query(WAITING))
        expect(titled()).toEqual([LONG, LONGEST])
        layout.column = 600
        fireEvent.focus(query(LONGEST))
        expect(titled()).toEqual([LONG])
      })

      it('is one that runs a fraction of a pixel past its edge too, where whole pixels call it a fit', () => {
        frameWidth(1152)
        const layout = textLayout(600)
        setup(FULL, long())
        expect([table().getAttribute('data-lines'), titled()]).toEqual(['1', []])
        // The edge moves with no draw. 73 characters end at 511px, 0.3px past the button's edge now. Both round to 511.
        layout.column = 510.7
        fireEvent.pointerEnter(query(LONG))
        expect([query(LONG).firstElementChild!.scrollWidth, query(LONG).clientWidth]).toEqual([511, 511])
        expect(titled()).toEqual([LONG])
        expect(query(LONG).hasAttribute('data-clipped')).toBe(true)
      })

      it('carries it in a stacked row cut short after two lines', () => {
        frameWidth(358)
        textLayout(250)
        setup({}, long())
        expect(table().getAttribute('data-layout')).toBe('stacked')
        // 511px is over two lines of 250px. 51 characters are under them.
        expect(titled()).toEqual([LONG])
      })

      it('has no title where nothing is measured', () => {
        setup({}, long())
        expect(titled()).toEqual([])
      })
    })
  })

  it('joins chips on query and type: a result under the other type draws Not checked', () => {
    setup()
    const market = within(rowOf(MARKET))
    const mentioned = market.getByRole('button', { name: 'OpenAI: Mentioned, Not cited' })
    expect(mentioned.getAttribute('aria-description')).toBe('Mentioned in 2 of 3 answers. Cited in 0 of 3.')
    // The sweep holds no Gemini answer for this query.
    expect(market.getByRole('button', { name: 'Gemini: Not checked' })).toBeTruthy()
    // Asked as Branded, measured only as Non-brand: the other type's result is never borrowed.
    const location = within(rowOf(LOCATION))
    expect(location.getByRole('button', { name: 'OpenAI: Not checked' })).toBeTruthy()
    expect(location.getByRole('button', { name: 'Gemini: Not checked' })).toBeTruthy()
  })

  it('stacks one pair per type on a row asked both ways, each named with its type', () => {
    setup()
    const mixed = within(rowOf(MIXED))
    expect(mixed.getByRole('button', { name: 'OpenAI, Branded: Mentioned, Cited' })).toBeTruthy()
    expect(mixed.getByRole('button', { name: 'OpenAI, Non-brand: Not mentioned, Not cited' })).toBeTruthy()
    // Cited is not checked beside a no: neither chip is read from the other, nor from the other type.
    expect(mixed.getByRole('button', { name: 'Gemini, Branded: Not mentioned, Citation not checked' })).toBeTruthy()
    expect(mixed.getByRole('button', { name: 'Gemini, Non-brand: Not checked' })).toBeTruthy()
    const type = within(rowOf(MIXED).children[2] as HTMLElement)
    expect(type.getByText('Mixed')).toBeTruthy()
    expect([type.getByText('Branded'), type.getByText('Non-brand')].map(label => label.textContent)).toEqual(['Branded', 'Non-brand'])
  })

  it('keeps one tab stop per engine cell, and moves between two pairs with the arrow keys', () => {
    setup()
    const withPairs = [...new Set(screen.getAllByRole('button', { name: ENGINE_PAIR }).map(pair => pair.closest('td')!))]
    // Five rows that are asked, two engines.
    expect(withPairs).toHaveLength(10)
    for (const cell of withPairs) {
      expect(within(cell).getAllByRole('button').filter(button => button.tabIndex >= 0), cell.textContent ?? '').toHaveLength(1)
    }
    // A row that is not asked has no pair, so its engine cells are no stop at all.
    expect(engineCells(NOT_ASKED).map(cell => cell.querySelectorAll('button, a[href], [tabindex]').length)).toEqual([0, 0])

    // The second pair is off the tab order, so the cell says how to reach it.
    const [branded, nonBrand] = within(within(rowOf(MIXED)).getByRole('group', { name: 'OpenAI by type' })).getAllByRole('button')
    expect([branded!.tabIndex, nonBrand!.tabIndex]).toEqual([0, -1])
    expect([branded, nonBrand].map(pair => pair!.getAttribute('aria-keyshortcuts'))).toEqual(['ArrowDown ArrowUp', 'ArrowDown ArrowUp'])
    expect(within(rowOf(MARKET)).queryByRole('group')).toBeNull()
    branded!.focus()
    fireEvent.keyDown(branded!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(nonBrand)
    fireEvent.keyDown(nonBrand!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(nonBrand)
    fireEvent.keyDown(nonBrand!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(branded)
  })

  it('draws a skeleton while results load, and nothing on a row that is not asked', () => {
    setup({ coverage: undefined })
    expect(within(rowOf(MARKET)).queryByRole('button', { name: /^OpenAI/ })).toBeNull()
    expect(within(rowOf(MIXED)).queryByRole('button', { name: /^Gemini/ })).toBeNull()
    // Two skeleton chips in each cell of a row that is asked. A row that is not asked has no result to wait for.
    expect(engineCells(MARKET).map(cell => cell.querySelectorAll('.skeleton').length)).toEqual([2, 2])
    expect(engineCells(NOT_ASKED).map(cell => cell.querySelectorAll('.skeleton').length)).toEqual([0, 0])
    expect(engineCellsRead(NOT_ASKED)).toEqual(['Not asked', 'Not asked'])
  })

  it('draws Not checked on every row that is asked when the results hold nothing', () => {
    setup({ coverage: coverageByQuery({ rows: [] }) })
    // Five rows that are asked on two engines, one of them asked both ways.
    expect(screen.getAllByRole('button', { name: /^(OpenAI|Gemini)(, (Branded|Non-brand))?: Not checked$/ })).toHaveLength(12)
  })

  describe('a query or an engine that is not asked', () => {
    const openaiOnly = { ...context('Lakeshore'), providers: ['openai'], models: { openai: 'model-a' } }
    /** The market row asked on OpenAI alone, and the waiting row on all three engines shown. */
    function partly() {
      const source = workspace()
      source.tracked = source.tracked.map(row => row.queryId === 'market' ? { ...row, assignments: row.assignments.map(link => ({ ...link, contexts: [openaiOnly] })) }
        : row.queryId === 'waiting' ? { ...row, assignments: row.assignments.map(link => ({ ...link, contexts: [{ ...context('Lakeshore'), providers: ['openai', 'gemini', 'claude'] }] })) }
          : row)
      return source
    }
    const THREE = ['openai', 'gemini', 'claude']

    it('draws no pair for a query that is not asked: each engine cell is blank and reads Not asked', () => {
      setup()
      expect(within(rowOf(NOT_ASKED)).queryByRole('button', { name: ENGINE_PAIR })).toBeNull()
      expect(engineCellsRead(NOT_ASKED)).toEqual(['Not asked', 'Not asked'])
      // The words are for a screen reader. The column's header names the engine, and Status says Not asked for all to see.
      expect(engineCells(NOT_ASKED).map(cell => [...cell.children].map(child => child.className))).toEqual([['sr-only'], ['sr-only']])
      expect(rowOf(NOT_ASKED).querySelector('.tracked-cell-status')!.textContent).toBe('Not asked')
    })

    it('draws no pair on an engine a row is not asked on, and keeps Not checked for one it is', () => {
      setup({ engines: THREE }, partly())
      // Asked on OpenAI alone: the sweep holds its OpenAI result, and Gemini and Claude are not a sweep gap.
      expect(engineCellsRead(MARKET)).toEqual(['OpenAI: Mentioned, Not cited', 'Not asked', 'Not asked'])
      // Asked on all three and waiting for its first sweep: three pairs, each not checked.
      expect(engineCellsRead(WAITING)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked', 'Claude: Not checked'])
      // Asked on OpenAI and Gemini, as the fixture's every other row is: no Claude pair.
      expect(engineCellsRead(LOCATION)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked', 'Not asked'])
      expect(engineCellsRead(MIXED)[2]).toBe('Not asked')
    })

    it('still draws a result the sweep holds on an engine the row is no longer asked on', () => {
      const results: TrackedResults = { rows: [
        { queryId: 'market', queryClass: 'non-brand', engines: [{ provider: 'gemini', mentioned: false, cited: false }] },
        // One type of the row asked both ways has an older Claude result, the other none.
        { queryId: 'mixed', queryClass: 'branded', engines: [{ provider: 'claude', mentioned: true, cited: true }] },
      ] }
      setup({ engines: THREE, coverage: coverageByQuery(results) }, partly())
      expect(engineCellsRead(MARKET)).toEqual(['OpenAI: Not checked', 'Gemini: Not mentioned, Not cited', 'Not asked'])
      // The Branded pair is drawn, and the Non-brand line under it is kept, blank, so each type stays level with its own pair.
      const claude = engineCells(MIXED)[2]!
      expect(within(claude).getAllByRole('button').map(pair => pair.getAttribute('aria-label'))).toEqual(['Claude, Branded: Mentioned, Cited'])
      const stack = within(claude).getByRole('group', { name: 'Claude by type' })
      expect([...stack.children].map(line => [line.tagName, line.classList.contains('tracked-pair-label') || line.classList.contains('tracked-pair-lead') ? line.className : 'pair', line.textContent])).toEqual([
        ['SPAN', 'tracked-pair-lead', ''],
        ['BUTTON', 'pair', 'MC'],
        ['SPAN', 'tracked-pair-label', 'Non-brand: Not asked'],
      ])
      expect(stack.lastElementChild!.firstElementChild!.className).toBe('sr-only')
    })

    it('says a pair with no result was not in the last sweep only when a sweep was read', () => {
      const { rerender } = setup()
      // The sweep read holds results, and none for this row on Gemini.
      const gemini = () => within(rowOf(MARKET)).getByRole('button', { name: 'Gemini: Not checked' })
      expect(gemini().getAttribute('aria-description')).toBe('Not in the last sweep.')
      act(() => gemini().focus())
      expect(document.body.textContent).toContain('Not in the last sweep.')
      act(() => gemini().blur())
      // No result read at all (no sweep yet, or a read that failed): nothing here says why, so the pair says only its state.
      rerender({ coverage: coverageByQuery({ rows: [] }) })
      expect(gemini().hasAttribute('aria-description')).toBe(false)
    })
  })

  it('opens each pair\'s bubble with whose result it is, as the caller reads it for the Place', () => {
    const source = workspace()
    const labels = new Map(source.targets.map(target => [target.stableKey, target.label]))
    setup({ marksFor: (row, queryClass) => marksSubject(row, row.tracked.assignments, labels, queryClass) }, source)
    // The market lists three locations and this row is asked for one of them: the marks are that one's.
    expect(within(rowOf(MARKET)).getByRole('button', { name: 'OpenAI: Mentioned, Not cited' }).getAttribute('aria-description')).toBe('Acme Homes Harbor Point. Mentioned in 2 of 3 answers. Cited in 0 of 3.')
    expect(within(rowOf(MARKET)).getByRole('button', { name: 'Gemini: Not checked' }).getAttribute('aria-description')).toBe('Acme Homes Harbor Point. Not in the last sweep.')
    // Twelve hand-picked locations, one of them with no type set: the Branded pair is for the eleven asked as Branded.
    expect(within(rowOf(HAND_PICKED)).getByRole('button', { name: 'OpenAI: Not checked' }).getAttribute('aria-description')).toBe('Any of 11 locations. Not in the last sweep.')
    // A row asked both ways: the type, then the location asked under that type, on each of its two pairs. The two are never read as one.
    expect(within(rowOf(MIXED)).getByRole('button', { name: 'OpenAI, Branded: Mentioned, Cited' }).getAttribute('aria-description')).toBe('Branded. Acme Homes Harbor Point. Mentioned. Cited.')
    expect(within(rowOf(MIXED)).getByRole('button', { name: 'OpenAI, Non-brand: Not mentioned, Not cited' }).getAttribute('aria-description')).toBe('Non-brand. Acme Homes Residence 12. Not mentioned. Not cited.')
  })

  describe('sorting', () => {
    const sortOf = (name: string) => headers().find(header => header.textContent === name)!.getAttribute('aria-sort')

    it('marks the sorted header and asks for the next sort on a click', () => {
      const onSortChange = vi.fn()
      const { rerender } = setup({ sort: DEFAULT_TRACKED_SORT, onSortChange })
      expect(['Query', 'Subject', 'OpenAI', 'Gemini', 'Last measured', 'Status'].map(sortOf)).toEqual(['none', 'ascending', 'none', 'none', 'none', 'none'])
      // Type and Source do not sort.
      expect([sortOf('Type'), sortOf('Source')]).toEqual([null, null])

      const click = (name: string) => fireEvent.click(within(table()).getByRole('button', { name }))
      click('Subject')
      click('Query')
      click('OpenAI')
      click('Last measured')
      click('Status')
      expect(onSortChange.mock.calls.map(([sort]) => sort)).toEqual([
        { key: 'subject', direction: 'desc' },
        { key: 'query', direction: 'asc' },
        { key: 'engine:openai', direction: 'asc' },
        { key: 'lastMeasured', direction: 'asc' },
        { key: 'status', direction: 'asc' },
      ])

      rerender({ sort: { key: 'engine:openai', direction: 'desc' } })
      expect(['Subject', 'OpenAI'].map(sortOf)).toEqual(['none', 'descending'])
      // Every header that sorts carries a mark: its direction when sorted, a hint when not.
      expect(headers().filter(header => header.querySelector('button > svg[aria-hidden="true"]') !== null).map(header => header.textContent)).toEqual(['Query', 'Subject', 'OpenAI', 'Gemini', 'Last measured', 'Status'])
    })

    it('reorders the rows as the caller sorts them, starting from the default order', () => {
      const source = workspace()
      const all = toTrackedRows(source, [])
      const coverage = coverageByQuery(RESULTS)
      function Sorted() {
        const [sort, setSort] = useState<TrackedSort>(DEFAULT_TRACKED_SORT)
        return <TrackedTable rows={sortTrackedRows(all, sort, coverage)} engines={['openai', 'gemini']} coverage={coverage} sort={sort} onSortChange={setSort} workspace={source} contextLabels={contextLabels} />
      }
      render(<Sorted />)
      // Market (by place), Location, Hand-picked (by query text), then None.
      expect(queryOrder()).toEqual([WAITING, MARKET, LOCATION, MIXED, HAND_PICKED, NOT_ASKED])

      fireEvent.click(within(table()).getByRole('button', { name: 'OpenAI' }))
      expect(sortOf('OpenAI')).toBe('ascending')
      // Not mentioned first: the mixed row has a no under one type. Not checked rows follow the mentioned one.
      expect(queryOrder().slice(0, 2)).toEqual([MIXED, MARKET])

      fireEvent.click(within(table()).getByRole('button', { name: 'OpenAI' }))
      expect(sortOf('OpenAI')).toBe('descending')
      expect(queryOrder().slice(0, 2)).toEqual([MARKET, MIXED])
    })

    it('sorts by status and then by date from the Status header, where Last measured is no column', () => {
      const frame = frameWidth(1152)
      const source = workspace()
      source.tracked = source.tracked.map(row => row.queryId === 'market' ? { ...row, lastMeasuredAt: '2026-09-23T12:00:00.000Z' } : row)
      const all = toTrackedRows(source, [])
      function Sorted() {
        const [sort, setSort] = useState<TrackedSort>(DEFAULT_TRACKED_SORT)
        return <TrackedTable rows={sortTrackedRows(all, sort)} engines={['openai', 'gemini', 'claude']} coverage={undefined} sort={sort} onSortChange={setSort} selectedIds={new Set()} onSelectedIdsChange={() => {}} workspace={source} contextLabels={contextLabels} />
      }
      render(<Sorted />)
      expect(headerNames()).toEqual(['', 'Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Claude', 'Status'])

      fireEvent.click(within(table()).getByRole('button', { name: 'Status' }))
      expect(['Subject', 'Status'].map(sortOf)).toEqual(['none', 'ascending'])
      // Measured first, the newest sweep leading: the market row of Sep 23 follows the three of Oct 7 though it leads the default order.
      expect(queryOrder()).toEqual([LOCATION, MIXED, HAND_PICKED, MARKET, WAITING, NOT_ASKED])
      expect(cells(MARKET).at(-1)).toBe('Measured Sep 23')

      fireEvent.click(within(table()).getByRole('button', { name: 'Status' }))
      expect(sortOf('Status')).toBe('descending')
      expect(queryOrder()).toEqual([NOT_ASKED, WAITING, MARKET, LOCATION, MIXED, HAND_PICKED])

      // A sort by last sweep, picked where the rows stack, outlives the stack. Status carries the date, so it shows there.
      frame.report(358)
      fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'lastMeasured' } })
      frame.report(1152)
      expect(['Query', 'Subject', 'OpenAI', 'Gemini', 'Claude', 'Status'].map(sortOf)).toEqual(['none', 'none', 'none', 'none', 'none', 'ascending'])
      expect(headers().find(header => header.textContent === 'Status')!.querySelector('svg')!.classList.contains('tracked-sort-hint')).toBe(false)
      // The oldest sweep first, whatever the status.
      expect(queryOrder()[0]).toBe(MARKET)
      // Where Last measured is a column the sort is its own again.
      frame.report(1400)
      expect(['Last measured', 'Status'].map(sortOf)).toEqual(['ascending', 'none'])
    })

    it('draws plain headers when the caller takes no sort', () => {
      setup()
      expect(headers().every(header => header.getAttribute('aria-sort') === null && within(header).queryByRole('button') === null)).toBe(true)
    })
  })

  describe('selection', () => {
    function Selectable({ initial = [] as string[] }) {
      const source = workspace()
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial))
      return <>
        <TrackedTable rows={toTrackedRows(source, [])} engines={['openai']} coverage={undefined} selectedIds={selected} onSelectedIdsChange={setSelected} workspace={source} contextLabels={contextLabels} />
        <output>{[...selected].sort().join(' ')}</output>
      </>
    }
    const box = (text: string) => screen.getByRole('checkbox', { name: `Select ${text}` }) as HTMLInputElement
    const selection = () => screen.getByRole('status').textContent

    it('shows no checkbox unless the caller takes a selection', () => {
      setup()
      expect(screen.queryByRole('checkbox')).toBeNull()
    })

    it('ticks one row at a time and keeps what is selected on other pages', () => {
      render(<Selectable initial={['on-another-page']} />)
      fireEvent.click(box(LOCATION))
      expect(selection()).toBe('location on-another-page')
      expect(box(LOCATION).checked).toBe(true)
      // The marker on the row's left edge reads this.
      expect([LOCATION, MARKET].map(text => rowOf(text).hasAttribute('data-selected'))).toEqual([true, false])
      fireEvent.click(box(LOCATION))
      expect(selection()).toBe('on-another-page')
    })

    it('selects the range on a shift-click, and clears a range the same way', () => {
      render(<Selectable />)
      fireEvent.click(box(LOCATION))
      fireEvent.click(box(WAITING), { shiftKey: true })
      // Rows two to five as drawn: location, hand-picked, mixed, waiting.
      expect(selection()).toBe('hand-picked location mixed waiting')
      // Shift-click a ticked row: it and every row back to the last one clicked are cleared.
      fireEvent.click(box(HAND_PICKED), { shiftKey: true })
      expect(selection()).toBe('location')
    })

    it('ticks and clears the whole page from the header, which shows a dash for some', () => {
      render(<Selectable initial={['on-another-page']} />)
      const page = screen.getByRole('checkbox', { name: 'Select this page' }) as HTMLInputElement
      expect([page.checked, page.indeterminate]).toEqual([false, false])
      fireEvent.click(box(MARKET))
      expect([page.checked, page.indeterminate]).toEqual([false, true])
      fireEvent.click(page)
      expect(selection()).toBe('hand-picked location market mixed not-asked on-another-page waiting')
      expect([page.checked, page.indeterminate]).toEqual([true, false])
      fireEvent.click(page)
      expect(selection()).toBe('on-another-page')
    })
  })

  describe('row detail', () => {
    const links = () => screen.getByRole('table', { name: 'Location links' })
    const linkRows = () => within(links()).getAllByRole('row').slice(1).map(row => [...row.children].map(cell => cell.textContent))
    const facts = (text: string) => [...rowOf(text).nextElementSibling!.querySelectorAll('dl > div')].map(fact => [...fact.children].map(part => part.textContent))

    it('lets a viewer open a hand-picked row and read its 12 locations', () => {
      const source = workspace()
      render(
        <AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
          <TrackedTable rows={toTrackedRows(source, [])} engines={['openai']} coverage={undefined} workspace={source} contextLabels={contextLabels} />
        </AccountProvider>,
      )
      expect(screen.queryByRole('table', { name: 'Location links' })).toBeNull()
      fireEvent.click(query(HAND_PICKED))
      expect(query(HAND_PICKED).getAttribute('aria-expanded')).toBe('true')
      // One location is asked from two search locations, so each row says its own.
      expect(within(links()).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Location', 'Groups', 'Markets', 'Type', 'Search location and engines'])
      const rows = linkRows()
      expect(rows).toHaveLength(12)
      // Sorted by name with numbers by value, not in the server's key order: `location-0` is the last Residence.
      expect(rows.map(row => row[0])).toEqual(Array.from({ length: 12 }, (_, index) => `Acme Homes Residence ${index + 1}`))
      // In no group and no market.
      expect(rows[0]).toEqual(['Acme Homes Residence 1', 'None', 'None', 'Branded', 'Lakeshore · openai, gemini'])
      // A location with no type of its own, under a row that has one.
      expect(rows[9]).toEqual(['Acme Homes Residence 10', 'None', 'None', 'Not set', 'Lakeshore · openai, gemini'])
      expect(rows[10]![4]).toBe('Lakeshore · openai, geminiNo search location · openai, gemini')
      // Two groups and two markets, each name whole: a name's own comma parts nothing.
      expect(rows[11]).toEqual(['Acme Homes Residence 12', 'Lakeshore, Metro Area · North side', 'Uptown · Downtown, Lakeshore metro', 'Branded', 'Lakeshore · openai, gemini'])
      expect(facts(HAND_PICKED).map(fact => fact[0])).toEqual(['Source', 'Last measured'])
      // Twelve fit one page.
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    })

    it('says each location\'s own type on a row asked both ways', () => {
      setup()
      fireEvent.click(query(MIXED))
      expect(linkRows().map(row => [row[0], row[3]])).toEqual([['Acme Homes Harbor Point', 'Branded'], ['Acme Homes Residence 12', 'Non-brand']])
    })

    it('opens from the Subject count too, and closes from either', () => {
      setup()
      const count = within(rowOf(HAND_PICKED)).getByRole('button', { name: '12 locations' })
      fireEvent.click(count)
      expect(linkRows()).toHaveLength(12)
      expect([count, query(HAND_PICKED)].map(button => button.getAttribute('aria-expanded'))).toEqual(['true', 'true'])
      expect(document.getElementById(count.getAttribute('aria-controls')!)).toBe(rowOf(HAND_PICKED).nextElementSibling)
      fireEvent.click(query(HAND_PICKED))
      expect(screen.queryByRole('table', { name: 'Location links' })).toBeNull()

      // A market's count is named in words for a reader of the page.
      fireEvent.click(within(rowOf(MARKET)).getByRole('button', { name: '3 locations' }))
      expect(linkRows()).toEqual([['Acme Homes Harbor Point', 'None', 'Uptown', 'Non-brand']])
    })

    it('says the search location and engines once when every location shares them', () => {
      setup()
      fireEvent.click(query(MIXED))
      expect(within(links()).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Location', 'Groups', 'Markets', 'Type'])
      expect(facts(MIXED)[0]).toEqual(['Search location and engines', 'Lakeshore · openai, gemini'])
    })

    it('says where the query came from, with the text of its pattern', () => {
      setup()
      fireEvent.click(query(MARKET))
      // A pattern row records when its pattern was last edited, not when the query was added, so it names no Added date.
      expect(facts(MARKET)).toEqual([['Search location and engines', 'Lakeshore · openai, gemini'], ['Source', 'Pattern: Bestbest apartments in {market}'], ['Last measured', 'Oct 7']])
      expect(within(rowOf(MARKET).nextElementSibling as HTMLElement).getByText('best apartments in {market}').tagName).toBe('CODE')
    })

    it('says when a hand-written query was added', () => {
      setup()
      fireEvent.click(query(LOCATION))
      expect(facts(LOCATION).slice(1)).toEqual([['Source', 'Manual'], ['Last measured', 'Oct 7'], ['Added', 'Sep 4']])
    })

    it('names no Added date where the time on record is no real one', () => {
      const source = workspace()
      // Setup writes the epoch for a time it does not have.
      source.tracked = source.tracked.map(row => row.queryId === 'location' ? { ...row, provenance: { source: 'manual' as const, sourceId: null, capturedAt: '1970-01-01T00:00:00.000Z' } } : row)
      setup({}, source)
      fireEvent.click(query(LOCATION))
      expect(facts(LOCATION).slice(1)).toEqual([['Source', 'Manual'], ['Last measured', 'Oct 7']])
      expect(rowOf(LOCATION).nextElementSibling!.textContent).not.toMatch(/Added|1970/)
    })

    it('tells a query found by Find queries from saved research, in the detail only', () => {
      setup()
      expect([cells(MIXED).at(-1), cells(HAND_PICKED).at(-1)]).toEqual(['Research', 'Research'])
      fireEvent.click(query(MIXED))
      expect(facts(MIXED)[1]).toEqual(['Source', 'Research · Find queries'])
      fireEvent.click(query(HAND_PICKED))
      expect(facts(HAND_PICKED)[0]).toEqual(['Source', 'Research'])
    })

    it('shows the facts alone for a row that is not asked', () => {
      setup()
      fireEvent.click(query(NOT_ASKED))
      expect(screen.queryByRole('table', { name: 'Location links' })).toBeNull()
      expect(facts(NOT_ASKED)).toEqual([['Source', 'Older list'], ['Last measured', 'Never']])
    })

    it('pages a long list of locations 25 at a time', () => {
      setup({}, workspace(30))
      fireEvent.click(query(HAND_PICKED))
      expect(linkRows()).toHaveLength(25)
      expect(screen.getByText('1 to 25 of 30 locations')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(linkRows().map(row => row[0])).toEqual(['Acme Homes Residence 26', 'Acme Homes Residence 27', 'Acme Homes Residence 28', 'Acme Homes Residence 29', 'Acme Homes Residence 30'])
    })

    it('marks the row a link points at, opens it and brings it into view', () => {
      const scrollIntoView = scrollSpy()
      const { rerender } = setup({ highlightedId: 'location' })
      expect(rowOf(LOCATION).hasAttribute('data-highlighted')).toBe(true)
      expect(rowOf(MARKET).hasAttribute('data-highlighted')).toBe(false)
      expect(linkRows()).toEqual([['Acme Homes Harbor Point', 'None', 'Uptown', 'Branded']])
      expect(scrollIntoView.mock.contexts).toEqual([rowOf(LOCATION)])

      // Closed by hand, it stays closed until the link changes.
      fireEvent.click(query(LOCATION))
      rerender({ highlightedId: 'location' })
      expect(screen.queryByRole('table', { name: 'Location links' })).toBeNull()
      rerender({ highlightedId: 'not-asked' })
      expect(query(NOT_ASKED).getAttribute('aria-expanded')).toBe('true')
      expect(scrollIntoView.mock.contexts).toEqual([rowOf(LOCATION), rowOf(NOT_ASKED)])
    })

    it('brings a linked row into view only once the frame is measured and the rows are stacked', () => {
      const frame = frameWidth(358)
      const layouts: (string | null)[] = []
      const scrollIntoView = scrollSpy(() => layouts.push(table().getAttribute('data-layout')))
      setup({ highlightedId: 'location' })
      // Scrolled to before the rows stack, the row would be somewhere else by the time they have.
      expect(layouts).toEqual(['stacked'])
      expect(scrollIntoView.mock.contexts).toEqual([rowOf(LOCATION)])
      expect(query(LOCATION).getAttribute('aria-expanded')).toBe('true')

      // The observer's own first report, and a resize after it, scroll nothing.
      frame.report()
      frame.report(1152)
      expect(table().getAttribute('data-layout')).toBe('table')
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })

    it('opens nothing for a linked query that is not on this page', () => {
      const scrollIntoView = scrollSpy()
      setup({ highlightedId: 'on-another-page' })
      expect(screen.queryAllByRole('button', { expanded: true })).toEqual([])
      expect(scrollIntoView).not.toHaveBeenCalled()
    })
  })

  describe('columns', () => {
    const menu = (row: { queryText: string }) => <button type="button">Menu for {row.queryText}</button>

    it('draws only the columns the caller wants, and a menu column only with a menu', () => {
      setup({ columns: ['query', 'type', 'engines', 'lastMeasured', 'menu'], renderRowMenu: menu })
      expect(headerNames()).toEqual(['Query', 'Type', 'OpenAI', 'Gemini', 'Last measured', 'Actions'])
      expect(within(rowOf(MARKET)).getByRole('button', { name: `Menu for ${MARKET}` })).toBeTruthy()
      cleanup()
      setup({ columns: ['query', 'type', 'engines', 'lastMeasured', 'menu'] })
      expect(headerNames()).toEqual(['Query', 'Type', 'OpenAI', 'Gemini', 'Last measured'])
    })

    it('folds Source and Last measured into the row detail in a narrow frame', () => {
      // 900px with two engines and no checkboxes: with both gone and Subject at its 182px floor, Query has 334px.
      frameWidth(900)
      setup({ renderRowMenu: menu })
      expect(table().getAttribute('data-layout')).toBe('table')
      expect(headerNames()).toEqual(['Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Status', 'Actions'])
      expect(columnWidths()).toEqual(['', '182px', '80px', '62px', '62px', '148px', '32px'])
      expect(cells(MARKET)).toEqual([MARKET, 'Market · Uptown (3)', 'Non-brand', 'Measured Oct 7', `Menu for ${MARKET}`])
      fireEvent.click(query(MARKET))
      const detail = within(rowOf(MARKET).nextElementSibling as HTMLElement)
      expect(detail.getByText('Pattern: Best')).toBeTruthy()
      expect(detail.getByText('Last measured').nextElementSibling!.textContent).toBe('Oct 7')
      // The detail spans every column that is left.
      expect((rowOf(MARKET).nextElementSibling!.firstElementChild as HTMLTableCellElement).colSpan).toBe(7)
    })

    it('gives the 1152px content column to Query, Subject, Type, the engines and Status', () => {
      frameWidth(1152)
      setup({ engines: ['openai', 'gemini', 'claude'], renderRowMenu: menu, onSelectedIdsChange: vi.fn() })
      expect(headerNames()).toEqual(['', 'Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Claude', 'Status', 'Actions'])
      // Query takes the 424px the others leave.
      expect(columnWidths()).toEqual(['32px', '', '250px', '80px', '62px', '62px', '62px', '148px', '32px'])
      // Its header takes the cells' padding by their class, so it starts where they do.
      expect(headers()[1]!.classList.contains('tracked-cell-query')).toBe(true)
      expect(cells(MARKET)).toEqual(['', MARKET, 'Market · Uptown (3)', 'Non-brand', 'Measured Oct 7', `Menu for ${MARKET}`])
      // The detail runs under the checkbox column too, and holds the two columns that are not drawn.
      fireEvent.click(query(MARKET))
      const detail = rowOf(MARKET).nextElementSibling as HTMLElement
      expect((detail.firstElementChild as HTMLTableCellElement).colSpan).toBe(9)
      expect([...detail.querySelectorAll('dl > div')].map(fact => fact.textContent)).toEqual(['Search location and enginesLakeshore · openai, gemini', 'SourcePattern: Bestbest apartments in {market}', 'Last measuredOct 7'])
    })

    it('narrows Subject for a fourth engine, before Query', () => {
      frameWidth(1152)
      setup({ engines: ['openai', 'gemini', 'claude', 'local'], renderRowMenu: menu, onSelectedIdsChange: vi.fn() })
      expect(headerNames()).toEqual(['', 'Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Claude', 'Local', 'Status', 'Actions'])
      // The set widths come to 732px, so Query keeps 420.
      expect(columnWidths()).toEqual(['32px', '', '192px', '80px', '62px', '62px', '62px', '62px', '148px', '32px'])
      // Perplexity's header takes 88px. Subject gives 10 of them and is at its floor, so Query is left 404.
      cleanup()
      setup({ engines: ['openai', 'gemini', 'claude', 'perplexity'], renderRowMenu: menu, onSelectedIdsChange: vi.fn() })
      expect(headerNames().slice(4, 8)).toEqual(['OpenAI', 'Gemini', 'Claude', 'Perplexity'])
      expect(columnWidths()).toEqual(['32px', '', '182px', '80px', '62px', '62px', '62px', '88px', '148px', '32px'])
    })

    it('shows Last measured and Source in a frame wide enough for them, and the date in Status all the same', () => {
      frameWidth(1400)
      setup({ engines: ['openai', 'gemini', 'claude'], renderRowMenu: menu, onSelectedIdsChange: vi.fn(), sort: DEFAULT_TRACKED_SORT, onSortChange: vi.fn() })
      expect(headerNames()).toEqual(['', 'Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Claude', 'Last measured', 'Status', 'Source', 'Actions'])
      expect(columnWidths()).toEqual(['32px', '', '250px', '80px', '62px', '62px', '62px', '108px', '148px', '98px', '32px'])
      expect(cells(MARKET)).toEqual(['', MARKET, 'Market · Uptown (3)', 'Non-brand', 'Oct 7', 'Measured Oct 7', 'Pattern: Best', `Menu for ${MARKET}`])
      // Last measured keeps its own sort beside Status.
      expect(['Last measured', 'Status'].map(name => headers().find(header => header.textContent === name)!.getAttribute('aria-sort'))).toEqual(['none', 'none'])
      fireEvent.click(query(MARKET))
      expect((rowOf(MARKET).nextElementSibling!.firstElementChild as HTMLTableCellElement).colSpan).toBe(11)
    })

    it('follows the frame when it is resized', () => {
      const frame = frameWidth(1400)
      setup({ renderRowMenu: menu })
      expect(headerNames()).toContain('Source')
      frame.report(1152)
      expect(headerNames()).toEqual(['Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Status', 'Actions'])
      frame.report(900)
      expect(headerNames()).toEqual(['Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Status', 'Actions'])
      frame.report(358)
      expect(table().getAttribute('data-layout')).toBe('stacked')
    })

    describe('stacked', () => {
      it('stacks each row in a phone-width frame, with every engine named beside its chips', () => {
        frameWidth(358)
        setup({ renderRowMenu: menu })
        // Measured before the first paint: the rows are stacked as soon as they are drawn.
        expect(table().getAttribute('data-layout')).toBe('stacked')
        expect(within(table()).queryAllByRole('columnheader')).toEqual([])
        // The menu follows the query, as it does on the row's first line. Source and Last measured wait in the row detail.
        expect(cells(WAITING)).toEqual([WAITING, `Menu for ${WAITING}`, 'Market · Old Mill District (4)', 'Non-brand', 'First answers Oct 21'])
        // Status carries the date here as it does under a header.
        expect(cells(MARKET).at(-1)).toBe('Measured Oct 7')
        // No header to read an engine from, so each cell carries its name.
        const engine = within(rowOf(WAITING).children[4] as HTMLElement)
        expect(engine.getByText('OpenAI')).toBeTruthy()
        expect(engine.getByRole('button', { name: 'OpenAI: Not checked' })).toBeTruthy()
      })

      it('reads an engine cell with no pair by its engine, and draws nothing for it', () => {
        frameWidth(358)
        setup({ renderRowMenu: menu })
        // No header names the engine here and no chips stand beside a name, so the cell is only read: it takes no room in the row.
        expect(engineCells(NOT_ASKED).map(cell => [cell.classList.contains('sr-only'), cell.textContent])).toEqual([[true, 'OpenAI: Not asked'], [true, 'Gemini: Not asked']])
        expect(engineCells(NOT_ASKED).flatMap(cell => [...cell.querySelectorAll('.tracked-engine-name, button')])).toEqual([])
        expect(cells(NOT_ASKED)).toEqual([NOT_ASKED, `Menu for ${NOT_ASKED}`, 'None', 'Not set', 'Not asked'])
        // A cell with a pair is drawn as before.
        expect(engineCells(WAITING).map(cell => cell.classList.contains('sr-only'))).toEqual([false, false])
      })

      it('names the two types of a row asked both ways once, beside the pairs of every engine', () => {
        frameWidth(358)
        setup({ renderRowMenu: menu })
        const [, , , type, openai, gemini] = [...rowOf(MIXED).children] as HTMLElement[]
        expect(within(type!).getAllByText(/^(Mixed|Branded|Non-brand)$/).map(label => label.textContent)).toEqual(['Mixed', 'Branded', 'Non-brand'])
        // Each engine's name stands over its two pairs, which carry their types in their names alone.
        expect([within(openai!).getByText('OpenAI'), within(gemini!).getByText('Gemini')]).toHaveLength(2)
        expect(within(gemini!).queryByText(/^(Branded|Non-brand)$/)).toBeNull()
        expect(within(gemini!).getAllByRole('button').map(pair => pair.getAttribute('aria-label'))).toEqual(['Gemini, Branded: Not mentioned, Citation not checked', 'Gemini, Non-brand: Not checked'])
      })

      it('holds Select this page and the sort on a line above the rows, which have no header', () => {
        frameWidth(358)
        const onSortChange = vi.fn()
        const onSelectedIdsChange = vi.fn()
        const { rerender } = setup({ sort: DEFAULT_TRACKED_SORT, onSortChange, selectedIds: new Set(['market']), onSelectedIdsChange })
        const page = screen.getByRole('checkbox', { name: 'Select this page' }) as HTMLInputElement
        expect(screen.getByText('Select this page')).toBeTruthy()
        expect([page.checked, page.indeterminate]).toEqual([false, true])
        fireEvent.click(page)
        expect([...onSelectedIdsChange.mock.calls[0]![0]].sort()).toEqual(['hand-picked', 'location', 'market', 'mixed', 'not-asked', 'waiting'])

        const sort = screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement
        expect(within(sort).getAllByRole('option').map(option => option.textContent)).toEqual(['Query', 'Subject', 'OpenAI', 'Gemini', 'Last measured', 'Status'])
        expect(sort.value).toBe('subject')
        fireEvent.change(sort, { target: { value: 'engine:openai' } })
        fireEvent.click(screen.getByRole('button', { name: 'Ascending' }))
        expect(onSortChange.mock.calls.map(([next]) => next)).toEqual([{ key: 'engine:openai', direction: 'asc' }, { key: 'subject', direction: 'desc' }])

        rerender({ sort: { key: 'engine:openai', direction: 'desc' } })
        expect(sort.value).toBe('engine:openai')
        expect(screen.getByRole('button', { name: 'Descending' })).toBeTruthy()
      })

      it('draws no line above the rows for a reader who can neither select nor sort', () => {
        frameWidth(358)
        setup()
        expect(screen.queryByRole('combobox')).toBeNull()
        expect(screen.queryByRole('checkbox')).toBeNull()
        expect(screen.queryByText('Select this page')).toBeNull()
      })
    })
  })

  it('shows the caller\'s empty state under the header when there are no rows', () => {
    setup({ rows: [], emptyState: <p>No queries match</p>, onSelectedIdsChange: vi.fn() })
    expect(headerNames().slice(1, 3)).toEqual(['Query', 'Subject'])
    const empty = within(table()).getByText('No queries match')
    // Across the checkbox column and all eight others.
    expect((empty.closest('td') as HTMLTableCellElement).colSpan).toBe(9)
    expect((screen.getByRole('checkbox', { name: 'Select this page' }) as HTMLInputElement).disabled).toBe(true)
  })

  it('takes its accessible name from the caller', () => {
    setup({ label: 'Queries about this location' })
    expect(screen.getByRole('table', { name: 'Queries about this location' })).toBeTruthy()
  })
})

describe('TrackedTableSkeleton', () => {
  it('stands in for the rows while the workspace loads', () => {
    const { rerender } = render(<TrackedTableSkeleton />)
    expect(screen.getByRole('status', { name: 'Loading queries' }).children).toHaveLength(8)
    rerender(<TrackedTableSkeleton rows={3} />)
    expect(screen.getByRole('status', { name: 'Loading queries' }).children).toHaveLength(3)
  })
})

describe('tracked table styles', () => {
  const compiled = async () => parseCompiledCss(await compileAppStyles(['tracked-table', 'topbar']))
  const PHONE = '@media (width < 48rem)'
  const FINGER = '@media (pointer: coarse)'
  /** Wherever the pointer is not a finger: a mouse, or a keyboard alone. */
  const KEYBOARD = '@media not all and (pointer: coarse)'
  const TOUCH = 'calc(var(--spacing) * 11)'

  it('sticks the header under the topbar by the height the topbar itself is held to', async () => {
    const rules = await compiled()
    const header = compiledDeclarations(rules, '.tracked-table > thead th')
    expect([header.position, header.top]).toEqual(['sticky', 'var(--topbar-h)'])
    expect(compiledDeclarations(rules, '.topbar')['min-height']).toBe('var(--topbar-h)')
    // 40px button, 20px of padding and a 1px border; the button is 36px from md.
    expect(compiledDeclarations(rules, ':root')['--topbar-h']).toBe('3.8125rem')
    expect(compiledDeclarations(rules, ':root', '@media (min-width: 48rem)')['--topbar-h']).toBe('3.5625rem')
    // The setup wizard's topbar is shorter and an embed has none: neither is held to the app's height.
    expect(compiledDeclarations(rules, '.app-shell-focus')['--topbar-h']).toBe('0px')
    expect(compiledDeclarations(rules, '.app-shell-embed')['--topbar-h']).toBe('0px')
    // Columns keep the widths the layout budget gives them.
    expect(compiledDeclarations(rules, '.tracked-table')['table-layout']).toBe('fixed')
  })

  it('scrolls a focused control clear of the sticky header', async () => {
    const rules = await compiled()
    for (const control of ['.tracked-row button', '.tracked-row input', '.tracked-detail-row button', '.tracked-detail-row a']) {
      expect(compiledDeclarations(rules, control)['scroll-margin-top'], control).toBe('calc(var(--topbar-h) + 4rem)')
    }
  })

  it('marks a ticked row on its left edge, clamps the query to two lines and says what can be pressed', async () => {
    const rules = await compiled()
    expect(compiledDeclarations(rules, '.tracked-row[data-selected] > td:first-child')['background-size']).toBe('2px 100%')
    expect(compiledDeclarations(rules, '.tracked-query > span')['-webkit-line-clamp']).toBe('2')
    for (const control of ['.tracked-query', '.tracked-sort', '.tracked-count']) expect(compiledDeclarations(rules, control).cursor, control).toBe('pointer')
    expect(compiledDeclarations(rules, ".tracked-query[aria-expanded='true'] .tracked-query-mark").rotate).toBe('90deg')
    // A header's sort hint shows under the pointer and under focus.
    expect(compiledDeclarations(rules, '.tracked-sort-hint').opacity).toBe('0')
    expect(compiledDeclarations(rules, '.tracked-sort:focus-visible > .tracked-sort-hint').opacity).toBe('0.4')
    // The mark hangs after the name, past a column as narrow as its name. A header that shows one is drawn over the next.
    expect(compiledDeclarations(rules, '.tracked-sort-mark').left).toBe('calc(100% + 1px)')
    expect(compiledDeclarations(rules, '.tracked-table > thead th')['z-index']).toBe('10')
    for (const shown of [':hover', ':focus-within', "[aria-sort='ascending']", "[aria-sort='descending']"]) {
      expect(compiledDeclarations(rules, `.tracked-table > thead th${shown}`)['z-index'], shown).toBe('11')
    }
  })

  it('gives the checkbox and the query a 44px target under a finger and below md', async () => {
    const rules = await compiled()
    for (const context of [PHONE, FINGER]) {
      const check = compiledDeclarations(rules, '.tracked-check', context)
      expect([check.width, check.height], context).toEqual([TOUCH, TOUCH])
      expect(compiledDeclarations(rules, '.tracked-query', context)['min-height'], context).toBe(TOUCH)
    }
  })

  it('sets the table\'s query a size down and closer to its column\'s edges, so 420px hold a long one', async () => {
    const rules = await compiled()
    const TABLE = ".tracked-table[data-layout='table']"
    expect(compiledDeclarations(rules, `${TABLE} .tracked-query`)['font-size']).toBe('13px')
    // Of Query's 424px beside the checkbox column, 4px are padding and 14px the mark's: 406px are the text's.
    expect(compiledDeclarations(rules, `${TABLE} .tracked-cell-query`)['padding-right']).toBe('0.25rem')
    // A finger's 44px checkbox runs 12px past its 32px column, so there Query keeps its 10px on the left.
    expect(compiledDeclarations(rules, `${TABLE}[data-selectable] .tracked-cell-query`, KEYBOARD)['padding-left']).toBe('0')
    expect(rules.filter(rule => rule.selector === `${TABLE}[data-selectable] .tracked-cell-query`).map(rule => rule.context.filter(value => value.startsWith('@media')))).toEqual([[KEYBOARD]])
    const line = compiledDeclarations(rules, `${TABLE} .tracked-query > span`)
    expect([line['padding-left'], line['text-indent']]).toEqual(['0.875rem', '-0.875rem'])
    // The 12px mark and its gap fill that indent.
    expect(compiledDeclarations(rules, `${TABLE} .tracked-query-mark`)['margin-right']).toBe('0.125rem')
    expect(compiledDeclarations(rules, '.tracked-query-mark').width).toBe('calc(var(--spacing) * 3)')
    // Subject runs as close to Type, which is set at the size of the two.
    expect(compiledDeclarations(rules, `${TABLE} .tracked-cell-subject`)['padding-right']).toBe('0.25rem')
    expect([compiledDeclarations(rules, '.tracked-cell-subject')['font-size'], compiledDeclarations(rules, `${TABLE} .tracked-cell-type`)['font-size']]).toEqual(['13px', '13px'])
    // The open row's detail starts where the query does: past the 32px checkbox column, and past the query's 10px too where a finger keeps them.
    const DETAIL = '.tracked-detail-row > td'
    expect(compiledDeclarations(rules, `${TABLE}[data-selectable] ${DETAIL}`, KEYBOARD)['padding-left']).toBe('2rem')
    expect(rules.filter(rule => rule.selector === `${TABLE}[data-selectable] ${DETAIL}`).map(rule => rule.context.filter(value => value.startsWith('@media')))).toEqual([[KEYBOARD]])
    expect(compiledDeclarations(rules, `.tracked-table[data-selectable] ${DETAIL}`)['padding-left']).toBe('2.625rem')
    expect(compiledDeclarations(rules, '.tracked-row > td')['padding-inline']).toBe('calc(var(--spacing) * 2.5)')
    // A stacked row keeps the table's own type size and the mark's 16px: no rule of its own sets either.
    expect(rules.filter(rule => rule.selector.includes('.tracked-query') && rule.declarations.some(([property]) => property === 'font-size' || property === 'text-indent')).map(rule => rule.selector))
      .toEqual(['.tracked-query > span', `${TABLE} .tracked-query`, `${TABLE} .tracked-query > span`])
  })

  it('shows a query cut short whole under keyboard focus, on its line and inside the frame', async () => {
    const rules = await compiled()
    const ROW = ".tracked-table[data-layout='table'] .tracked-row"
    const LINE = '.tracked-query[data-clipped]:focus-visible > span'
    const selector = `${ROW}:not([data-open]) ${LINE}`
    const line = compiledDeclarations(rules, selector, KEYBOARD)
    // Over the cells beside it, so the row keeps its height. The frame is the container the width is taken from.
    expect([line.position, line['z-index'], line.width, line['max-width']]).toEqual(['relative', '1', 'max-content', 'calc(100cqi - 3.5rem)'])
    expect(compiledDeclarations(rules, '.tracked-table-frame').container).toBe('tracked-table / inline-size')
    expect(rules.filter(rule => rule.selector === selector).map(rule => rule.context.filter(value => value.startsWith('@media')))).toEqual([[KEYBOARD]])
    // Its ring stands a cell's 10px off its text.
    expect(line['padding-right']).toBe('0.625rem')
    // A click on the cells it covers reaches them, not the query under the line.
    expect(line['pointer-events']).toBe('none')
    // Its own ground hides the text under it, and a tinted row's tint goes over that ground, so the line is the row's colour.
    expect(line['background-color']).toBe('var(--color-bg)')
    const tint = (color: string) => `linear-gradient(var(${color}), var(${color}))`
    expect(compiledDeclarations(rules, `${ROW}:not([data-open]):hover ${LINE}`, KEYBOARD)['background-image']).toBe(tint('--color-surface'))
    for (const state of ['data-selected', 'data-highlighted']) {
      expect(compiledDeclarations(rules, `${ROW}[${state}]:not([data-open]) ${LINE}`, KEYBOARD)['background-image'], state).toBe(tint('--color-surface-active'))
    }
    // The same two tints the row's cells wear.
    expect([compiledDeclarations(rules, '.tracked-row:hover > td')['background-color'], compiledDeclarations(rules, '.tracked-row[data-selected] > td')['background-color']]).toEqual(['var(--color-surface)', 'var(--color-surface-active)'])
    // On a page of two-line rows the line keeps the height of two, so it covers both lines of the cells it is drawn over.
    expect(compiledDeclarations(rules, `.tracked-table[data-layout='table'][data-lines='2'] .tracked-row:not([data-open]) ${LINE}`, KEYBOARD)['min-height']).toBe('2.5rem')
  })

  it('gives a closed row\'s query two lines under a finger, inside the 44px its button already has', async () => {
    const rules = await compiled()
    const selector = ".tracked-table[data-layout='table'] .tracked-row:not([data-open]) .tracked-query > span"
    // One line under a mouse, so a row is as tall as its text.
    expect(compiledDeclarations(rules, selector)['white-space']).toBe('nowrap')
    const line = compiledDeclarations(rules, selector, FINGER)
    expect([line.display, line['white-space'], line['-webkit-line-clamp']]).toEqual(['-webkit-box', 'normal', '2'])
    // Two lines of the table's 20px.
    expect(compiledDeclarations(rules, '.tracked-table')['line-height']).toBe('calc(var(--spacing) * 5)')
    expect(compiledDeclarations(rules, '.tracked-query', FINGER)['min-height']).toBe(TOUCH)
  })

  it('gives every row of a two-line page one height, with the query and the Subject wrapped on its two lines', async () => {
    const rules = await compiled()
    const PAGE = ".tracked-table[data-layout='table'][data-lines='2']"
    // Two of the table's 20px lines, the cell's 8px above and below them and its 1px border: 57px.
    expect(compiledDeclarations(rules, `${PAGE} .tracked-row > td`).height).toBe('3.5625rem')
    const cell = compiledDeclarations(rules, '.tracked-row > td')
    expect([compiledDeclarations(rules, '.tracked-table')['line-height'], cell['padding-block'], cell['border-bottom-width']]).toEqual(['calc(var(--spacing) * 5)', 'calc(var(--spacing) * 2)', '1px'])
    // It is every row's, the open one's too, and the only height any row is given: the page's one answer sets them all.
    expect(rules.filter(rule => rule.selector.includes('.tracked-row') && rule.declarations.some(([property]) => property === 'height')).map(rule => rule.selector)).toEqual([`${PAGE} .tracked-row > td`])
    // Chips, Status and the menu sit on the middle of the taller row.
    expect(cell['vertical-align']).toBe('middle')

    // The query wraps and stops after the second line.
    const line = compiledDeclarations(rules, `${PAGE} .tracked-row:not([data-open]) .tracked-query > span`)
    expect([line.display, line['white-space'], line['-webkit-line-clamp']]).toEqual(['-webkit-box', 'normal', '2'])
    // So does the Subject, on lines as tall as the query's, so the two read level.
    expect(compiledDeclarations(rules, `${PAGE} .tracked-cell-subject`)['line-height']).toBe('calc(var(--spacing) * 5)')
    // Nothing clips it there: the only Subject boxes that hide what runs over are the name cut short and no other.
    expect(rules.filter(rule => rule.selector.includes('.tracked-subject') && rule.declarations.some(([property, value]) => property === 'overflow' && value !== 'visible')).map(rule => rule.selector)).toEqual(['.tracked-subject-name', '.tracked-subject[data-long] > .tracked-subject-name'])
    // Wrapped, closed or open, neither leaves a word alone on its last line.
    const TABLE = ".tracked-table[data-layout='table']"
    expect(rules.filter(rule => rule.selector.includes('.tracked-') && rule.declarations.some(([property, value]) => property === 'text-wrap' && value === 'pretty')).map(rule => rule.selector)).toEqual([`${TABLE} .tracked-cell-query, ${TABLE} .tracked-cell-subject`])
    // One too long for two lines: its name stops on the second, and its count sits on that line.
    const name = compiledDeclarations(rules, '.tracked-subject[data-long] > .tracked-subject-name')
    expect([name.display, name['-webkit-line-clamp'], name['white-space']]).toEqual(['-webkit-box', '2', 'normal'])
    expect(compiledDeclarations(rules, '.tracked-subject[data-long]')['align-items']).toBe('flex-end')
    expect(compiledDeclarations(rules, '.tracked-subject > :not(.tracked-subject-name)').flex).toBe('none')
  })

  it('sets the ruler in the type of the text it measures, and never draws it', async () => {
    const rules = await compiled()
    const ruler = compiledDeclarations(rules, '.tracked-ruler')
    // Out of the flow, with no box and nothing to see. Each text stays on one line, its spaces counted.
    expect([ruler.position, ruler.width, ruler.height, ruler.overflow, ruler.visibility, ruler['white-space']]).toEqual(['absolute', '0', '0', 'hidden', 'hidden', 'pre'])
    // The size of a query and of a Subject in the table.
    expect([ruler['font-size'], compiledDeclarations(rules, ".tracked-table[data-layout='table'] .tracked-query")['font-size'], compiledDeclarations(rules, '.tracked-cell-subject')['font-size']]).toEqual(['13px', '13px', '13px'])
    // The weight of a query, which a Subject's kind shares, and the figures of a count.
    expect(compiledDeclarations(rules, ".tracked-ruler > [data-face='strong']")['font-weight']).toBe(compiledDeclarations(rules, '.tracked-query')['font-weight'])
    expect(compiledDeclarations(rules, ".tracked-ruler > [data-face='count']")['--tw-numeric-spacing']).toBe(compiledDeclarations(rules, '.tracked-count')['--tw-numeric-spacing'])
    expect(compiledDeclarations(rules, '.tracked-count')['--tw-numeric-spacing']).toBe('tabular-nums')
    // And the gap a one-line Subject keeps before its count: one length, set once on the frame.
    const gap = compiledDeclarations(rules, ".tracked-ruler > [data-face='gap']")
    expect([gap.display, gap.width, compiledDeclarations(rules, '.tracked-subject')['column-gap']]).toEqual(['inline-block', 'var(--tracked-subject-gap)', 'var(--tracked-subject-gap)'])
    expect(compiledDeclarations(rules, '.tracked-table-frame')['--tracked-subject-gap']).toBe('0.25rem')
  })

  it('gives Status a line of its own in a phone-width frame', async () => {
    const rules = await compiled()
    expect(compiledDeclarations(rules, '& .tracked-row > .tracked-cell-status', '@container tracked-table (max-width: 40rem)').flex).toBe('0 0 100%')
  })
})
