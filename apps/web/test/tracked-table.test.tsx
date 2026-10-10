import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { TrackedTable, TrackedTableSkeleton } from '../src/components/project/queries/advanced/TrackedTable.js'
import {
  coverageByQuery,
  DEFAULT_TRACKED_SORT,
  sortTrackedRows,
  toTrackedRows,
  type TrackedResults,
  type TrackedSort,
} from '../src/components/project/queries/advanced/tracked-view-model.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { compileAppStyles, compiledDeclarations, parseCompiledCss } from './compiled-app-css.js'

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
const assignment = (targetKey: string, queryClass: Assignment['queryClass'], marketKeys: string[] = []): Assignment =>
  ({ targetKey, groupKeys: [], marketKeys, queryClass, classificationSource: 'server', contexts: [context('Lakeshore')] })
const picked = (count: number) => Array.from({ length: count }, (_, index) => assignment(`location-${index}`, 'branded', index === 0 ? ['uptown', 'downtown'] : []))

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
      ...Array.from({ length: handPicked }, (_, index) => ({ stableKey: `location-${index}`, label: `Acme Homes Residence ${index + 1}` })),
    ],
    groups: [],
    markets: [
      // Three locations in the server's list, one in the row's own links: the count shown is the server's.
      { stableKey: 'uptown', label: 'Uptown', usageEdges: [], targetKeys: ['harbor-point', 'location-0', 'location-1'] },
      { stableKey: 'downtown', label: 'Downtown', usageEdges: [], targetKeys: ['location-0'] },
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
      tracked('mixed', MIXED, { focus: { kind: 'custom' }, queryClasses: ['branded', 'non-brand'], assignments: [assignment('harbor-point', 'branded'), assignment('location-0', 'non-brand')] }),
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
const ENGINE_PAIR = /^(OpenAI|Gemini)[,:]/
/** A row's cells as read, engine cells aside: their chips are read by name. */
const cells = (text: string) => [...rowOf(text).children]
  .filter(cell => within(cell as HTMLElement).queryByRole('button', { name: ENGINE_PAIR }) === null)
  .map(cell => cell.textContent)
const queryOrder = () => within(table()).getAllByRole('button', { expanded: false }).filter(button => button.title !== '').map(button => button.title)

/** A frame of this width, reported the way the browser reports it: once, when it is first observed. */
function frameWidth(width: number) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
    observe() { this.callback([{ contentRect: { width } }]) }
    disconnect() {}
  })
}

function scrollSpy() {
  const scrollIntoView = vi.fn()
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
    // The market's count is the server's member list (3), not the one location this row links.
    expect(cells(MARKET)).toEqual([MARKET, 'Market · Uptown (3)', 'Non-brand', 'Oct 7', 'Measured', 'Pattern: Best'])
    expect(cells(LOCATION).slice(1, 3)).toEqual(['Location · Acme Homes Harbor Point', 'Branded'])
    expect(cells(HAND_PICKED)).toEqual([HAND_PICKED, 'Hand-picked · 12 locations', 'Branded', 'Oct 7', 'Measured', 'Research'])
    expect(cells(WAITING)).toEqual([WAITING, 'Market · Old Mill District (4)', 'Non-brand', 'Never', 'First answers Oct 21', 'Setup'])
    expect(cells(NOT_ASKED)).toEqual([NOT_ASKED, 'None', 'Not set', 'Never', 'Not asked', 'Older list'])
    // Under a header, a cell holds the chips alone.
    expect(within(rowOf(MARKET)).queryByText('OpenAI')).toBeNull()
  })

  it('names no date on a waiting row when no sweep date is known', () => {
    setup({ nextSweepDate: undefined })
    expect(cells(WAITING)[4]).toBe('First answers')
  })

  it('joins chips on query and type: a result under the other type draws Not checked', () => {
    setup()
    const market = within(rowOf(MARKET))
    const mentioned = market.getByRole('button', { name: 'OpenAI: Mentioned, Not cited' })
    expect(mentioned.getAttribute('aria-description')).toBe('2 of 3 answers mention it. 0 of 3 cite it.')
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
    const engineCells = [...new Set(screen.getAllByRole('button', { name: ENGINE_PAIR }).map(pair => pair.closest('td')!))]
    // Six rows, two engines.
    expect(engineCells).toHaveLength(12)
    for (const cell of engineCells) {
      expect(within(cell).getAllByRole('button').filter(button => button.tabIndex >= 0), cell.textContent ?? '').toHaveLength(1)
    }

    const [branded, nonBrand] = within(rowOf(MIXED).children[3] as HTMLElement).getAllByRole('button')
    expect([branded!.tabIndex, nonBrand!.tabIndex]).toEqual([0, -1])
    branded!.focus()
    fireEvent.keyDown(branded!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(nonBrand)
    fireEvent.keyDown(nonBrand!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(nonBrand)
    fireEvent.keyDown(nonBrand!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(branded)
  })

  it('draws no result while results load, except on a row that is not asked', () => {
    setup({ coverage: undefined })
    expect(within(rowOf(MARKET)).queryByRole('button', { name: /^OpenAI/ })).toBeNull()
    expect(within(rowOf(MIXED)).queryByRole('button', { name: /^Gemini/ })).toBeNull()
    expect(within(rowOf(NOT_ASKED)).getByRole('button', { name: 'OpenAI: Not checked' })).toBeTruthy()
  })

  it('draws Not checked everywhere when the results hold nothing', () => {
    setup({ coverage: coverageByQuery({ rows: [] }) })
    expect(screen.getAllByRole('button', { name: /^(OpenAI|Gemini)(, (Branded|Non-brand))?: Not checked$/ })).toHaveLength(14)
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
      expect(within(links()).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Location', 'Markets', 'Type', 'Search location and engines'])
      const rows = linkRows()
      expect(rows).toHaveLength(12)
      expect(rows[0]).toEqual(['Acme Homes Residence 1', 'Uptown, Downtown', 'Branded', 'Lakeshore · openai, gemini'])
      // A location in no market, sorted by name with numbers by value.
      expect(rows[1]).toEqual(['Acme Homes Residence 2', 'None', 'Branded', 'Lakeshore · openai, gemini'])
      expect(rows.at(-1)![0]).toBe('Acme Homes Residence 12')
      // Twelve fit one page.
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
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
      expect(linkRows()).toEqual([['Acme Homes Harbor Point', 'Uptown', 'Non-brand', 'Lakeshore · openai, gemini']])
    })

    it('says where the query came from and when, with the text of its pattern', () => {
      setup()
      fireEvent.click(query(MARKET))
      expect(facts(MARKET)).toEqual([['Source', 'Pattern: Bestbest apartments in {market}'], ['Last measured', 'Oct 7'], ['Added', 'Sep 4']])
      expect(within(rowOf(MARKET).nextElementSibling as HTMLElement).getByText('best apartments in {market}').tagName).toBe('CODE')
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
      expect(linkRows()).toEqual([['Acme Homes Harbor Point', 'Uptown', 'Branded', 'Lakeshore · openai, gemini']])
      expect(scrollIntoView.mock.contexts).toEqual([rowOf(LOCATION)])

      // Closed by hand, it stays closed until the link changes.
      fireEvent.click(query(LOCATION))
      rerender({ highlightedId: 'location' })
      expect(screen.queryByRole('table', { name: 'Location links' })).toBeNull()
      rerender({ highlightedId: 'not-asked' })
      expect(query(NOT_ASKED).getAttribute('aria-expanded')).toBe('true')
      expect(scrollIntoView.mock.contexts).toEqual([rowOf(LOCATION), rowOf(NOT_ASKED)])
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
      // 900px with two engines and no checkboxes leaves Query 230px with Source gone, and 338px with both gone.
      frameWidth(900)
      setup({ renderRowMenu: menu })
      expect(table().getAttribute('data-layout')).toBe('table')
      expect(headerNames()).toEqual(['Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Status', 'Actions'])
      expect(cells(MARKET)).toEqual([MARKET, 'Market · Uptown (3)', 'Non-brand', 'Measured', `Menu for ${MARKET}`])
      fireEvent.click(query(MARKET))
      const detail = within(rowOf(MARKET).nextElementSibling as HTMLElement)
      expect(detail.getByText('Pattern: Best')).toBeTruthy()
      expect(detail.getByText('Last measured').nextElementSibling!.textContent).toBe('Oct 7')
      // The detail spans every column that is left.
      expect((rowOf(MARKET).nextElementSibling!.firstElementChild as HTMLTableCellElement).colSpan).toBe(7)
    })

    it('shows every column in the full-width frame', () => {
      frameWidth(1152)
      setup({ renderRowMenu: menu, onSelectedIdsChange: vi.fn() })
      expect(headerNames()).toEqual(['', 'Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Last measured', 'Status', 'Source', 'Actions'])
    })

    it('stacks each row in a phone-width frame, with every engine named beside its chips', () => {
      frameWidth(358)
      setup({ renderRowMenu: menu })
      expect(table().getAttribute('data-layout')).toBe('stacked')
      // Source and Last measured wait in the row detail.
      expect(cells(WAITING)).toEqual([WAITING, 'Market · Old Mill District (4)', 'Non-brand', 'First answers Oct 21', `Menu for ${WAITING}`])
      // No header to read an engine from, so each cell carries its name.
      const engine = within(rowOf(WAITING).children[3] as HTMLElement)
      expect(engine.getByText('OpenAI')).toBeTruthy()
      expect(engine.getByRole('button', { name: 'OpenAI: Not checked' })).toBeTruthy()
      // No Type cell lines up with the pairs of a row asked both ways, so each pair carries its type.
      expect(within(rowOf(MIXED).children[4] as HTMLElement).getAllByText(/^(Gemini|Branded|Non-brand)$/).map(label => label.textContent)).toEqual(['Gemini', 'Branded', 'Non-brand'])
    })
  })

  it('shows the caller\'s empty state under the header when there are no rows', () => {
    setup({ rows: [], emptyState: <p>No queries match</p>, onSelectedIdsChange: vi.fn() })
    expect(headerNames().slice(1, 3)).toEqual(['Query', 'Subject'])
    expect(within(table()).getByText('No queries match')).toBeTruthy()
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
  it('sticks the header under the topbar by the height the topbar itself is held to', async () => {
    const rules = parseCompiledCss(await compileAppStyles(['tracked-table', 'topbar']))
    const header = compiledDeclarations(rules, '.tracked-table > thead th')
    expect([header.position, header.top]).toEqual(['sticky', 'var(--topbar-h)'])
    expect(compiledDeclarations(rules, '.topbar')['min-height']).toBe('var(--topbar-h)')
    // 40px button, 20px of padding and a 1px border; the button is 36px from md.
    expect(compiledDeclarations(rules, ':root')['--topbar-h']).toBe('3.8125rem')
    expect(compiledDeclarations(rules, ':root', '@media (min-width: 48rem)')['--topbar-h']).toBe('3.5625rem')
    // Columns keep the widths the layout budget gives them.
    expect(compiledDeclarations(rules, '.tracked-table')['table-layout']).toBe('fixed')
  })
})
