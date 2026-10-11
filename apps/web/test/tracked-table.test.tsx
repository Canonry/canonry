import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
      { stableKey: 'metro', label: 'Lakeshore Metro Area', targetKeys: ['location-0'] },
      { stableKey: 'north', label: 'North side', targetKeys: ['location-0'] },
    ],
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
const ENGINE_PAIR = /^(OpenAI|Gemini)[,:]/
/** A row's cells as read, engine cells aside: their chips are read by name. */
const cells = (text: string) => [...rowOf(text).children]
  .filter(cell => within(cell as HTMLElement).queryAllByRole('button', { name: ENGINE_PAIR }).length === 0)
  .map(cell => cell.textContent)
const queryOrder = () => within(table()).getAllByRole('button', { expanded: false }).filter(button => button.title !== '').map(button => button.title)

/**
 * A frame of this width, as a browser gives it: measured when asked, and
 * reported by the observer only after `observe` has returned. `report` is that
 * later report, of the same width or of a new one.
 */
function frameWidth(width: number) {
  let observed: ((entries: { contentRect: { width: number } }[]) => void) | undefined
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: NonNullable<typeof observed>) { observed = callback }
    observe() {}
    disconnect() {}
  })
  return { report: (next = width) => act(() => observed!([{ contentRect: { width: next } }])) }
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
    // The market's count is the server's member list (3), not the one location this row links.
    expect(cells(MARKET)).toEqual([MARKET, 'Market · Uptown (3)', 'Non-brand', 'Oct 7', 'Measured', 'Pattern: Best'])
    expect(cells(LOCATION).slice(1, 3)).toEqual(['Location · Acme Homes Harbor Point', 'Branded'])
    expect(cells(HAND_PICKED)).toEqual([HAND_PICKED, 'Hand-picked · 12 locations', 'Branded', 'Oct 7', 'Measured', 'Research'])
    expect(cells(WAITING)).toEqual([WAITING, 'Market · Old Mill District (4)', 'Non-brand', 'Never', 'First answers Oct 21', 'Setup'])
    expect(cells(NOT_ASKED)).toEqual([NOT_ASKED, 'None', 'Not set', 'Never', 'Not asked', 'Older list'])
    // Under a header, a cell holds the chips alone.
    expect(within(rowOf(MARKET)).queryByText('OpenAI')).toBeNull()
  })

  it('tones the Status badge by status', () => {
    setup()
    const badge = (text: string, label: string) => within(rowOf(text)).getByText(label).className.split(' ')
    expect(badge(MARKET, 'Measured')).toContain('text-positive')
    expect(badge(WAITING, 'First answers Oct 21')).toEqual(expect.arrayContaining(['border-info-500/30', 'bg-info-500/10', 'text-info-300']))
    expect(badge(WAITING, 'First answers Oct 21')).not.toContain('text-neutral')
    expect(badge(NOT_ASKED, 'Not asked')).toContain('text-neutral')
    expect(badge(NOT_ASKED, 'Not asked')).not.toContain('text-info-300')
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
      expect(rows[11]).toEqual(['Acme Homes Residence 12', 'Lakeshore Metro Area, North side', 'Uptown, Downtown', 'Branded', 'Lakeshore · openai, gemini'])
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
      // 900px with two engines and no checkboxes leaves Query 228px with Source gone, and 336px with both gone.
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
      // The detail runs under the checkbox column too.
      fireEvent.click(query(MARKET))
      expect((rowOf(MARKET).nextElementSibling!.firstElementChild as HTMLTableCellElement).colSpan).toBe(10)
    })

    it('follows the frame when it is resized', () => {
      const frame = frameWidth(1152)
      setup({ renderRowMenu: menu })
      expect(headerNames()).toContain('Source')
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
        // No header to read an engine from, so each cell carries its name.
        const engine = within(rowOf(WAITING).children[4] as HTMLElement)
        expect(engine.getByText('OpenAI')).toBeTruthy()
        expect(engine.getByRole('button', { name: 'OpenAI: Not checked' })).toBeTruthy()
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
  })

  it('gives the checkbox and the query a 44px target under a finger and below md', async () => {
    const rules = await compiled()
    for (const context of [PHONE, FINGER]) {
      const check = compiledDeclarations(rules, '.tracked-check', context)
      expect([check.width, check.height], context).toEqual([TOUCH, TOUCH])
      expect(compiledDeclarations(rules, '.tracked-query', context)['min-height'], context).toBe(TOUCH)
    }
  })

  it('gives Status a line of its own in a phone-width frame', async () => {
    const rules = await compiled()
    expect(compiledDeclarations(rules, '& .tracked-row > .tracked-cell-status', '@container tracked-table (max-width: 40rem)').flex).toBe('0 0 100%')
  })
})
