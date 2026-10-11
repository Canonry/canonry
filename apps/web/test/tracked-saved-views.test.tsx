import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { QueryTrackingViews, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { TrackedPlaceList } from '../src/components/project/queries/advanced/TrackedPlaceList.js'
import { TrackedSavedViews, trackedPlaceView } from '../src/components/project/queries/advanced/TrackedSavedViews.js'
import { compileAppStyles, compiledElementProperty, parseCompiledCss } from './compiled-app-css.js'
import { expectNoSentence, noteButton } from './support/query-tracking-fixtures.js'

// The Views row of the Tracked page and the list a view opens in place of the queries.

afterEach(cleanup)

const BELOW_MD = '@media (width < 48rem)'
const FROM_MD = '@media (width >= 48rem)'
const NARROW_FRAME = '@container (width < 52rem)'

/**
 * The views as the workspace read lists them. Each count is the server's own and differs from the length of
 * its list, so a number worked out from the keys would show.
 */
const VIEWS: QueryTrackingViews = {
  noPropertyQueries: { count: 31, targetKeys: ['summit', 'river', 'gone'] },
  thinMarkets: { count: 12, floor: 6, marketKeys: ['uptown', 'lakeview', 'downtown'] },
  patternGaps: {
    count: 7,
    patterns: [
      { templateId: 'template-best', name: 'Best', pattern: 'best apartments {market}', usedMarketKeys: ['uptown'], missingMarketKeys: ['downtown'] },
      { templateId: 'template-gone', name: null, pattern: 'luxury apartments {market}', usedMarketKeys: ['downtown', 'uptown'], missingMarketKeys: [] },
    ],
  },
}
/** Three locations, one of them in two groups, and three markets, one of them with no location left. */
const WORKSPACE = {
  targets: [
    { stableKey: 'harbor', label: 'Harbor Point', counts: { propertyQueries: 2, marketQueries: 9, customQueries: 0, answersPerSweep: 30 } },
    { stableKey: 'river', label: 'River Point', counts: { propertyQueries: 0, marketQueries: 7, customQueries: 0, answersPerSweep: 21 } },
    { stableKey: 'summit', label: 'Summit Lofts', counts: { propertyQueries: 0, marketQueries: 0, customQueries: 1, answersPerSweep: 3 } },
  ],
  groups: [
    { stableKey: 'metro', label: 'Lakeshore Metro', targetKeys: ['harbor', 'river', 'summit'] },
    { stableKey: 'north', label: 'North, Lakeshore', targetKeys: ['river'] },
  ],
  markets: [
    { stableKey: 'uptown', label: 'Uptown', groupKey: 'north', usageEdges: [], targetKeys: ['harbor', 'river'], counts: { marketQueries: 5, propertyQueries: 2, answersPerSweep: 24 } },
    { stableKey: 'downtown', label: 'Downtown, Lakeshore', usageEdges: [], targetKeys: ['harbor'], counts: { marketQueries: 3, propertyQueries: 2, answersPerSweep: 9 } },
    { stableKey: 'lakeview', label: 'Lakeview', groupKey: 'metro', usageEdges: [], targetKeys: [], counts: { marketQueries: 0, propertyQueries: 0, answersPerSweep: 0 } },
  ],
} as unknown as Pick<QueryTrackingWorkspaceResponse, 'targets' | 'groups' | 'markets'>

const rulesFor = async (container: HTMLElement) => parseCompiledCss(await compileAppStyles([...container.querySelectorAll('*')].flatMap(element => [...element.classList])))

describe('TrackedSavedViews', () => {
  function renderViews(props: Partial<Parameters<typeof TrackedSavedViews>[0]> = {}) {
    const onSelect = vi.fn()
    const view = render(<TrackedSavedViews views={VIEWS} weakMarkets={{ count: 4 }} notAsked={38} handPicked={0} active={[]} onSelect={onSelect} {...props} />)
    return { ...view, onSelect }
  }
  const row = () => screen.getByRole('group', { name: 'Views' })
  const buttons = () => within(row()).getAllByRole('button')
  /** Each button by its name: the view, the type its number is of where it has one, and the number. */
  const names = () => buttons().map(button => button.getAttribute('aria-label'))

  test('each view is a button with the server\'s own count, in one group named Views', () => {
    renderViews()
    // 31, 12 and 7 are the read's counts: the lists hold 3, 3 and 2.
    expect(names()).toEqual(['Locations without queries, 31', 'Thin markets, 12', 'Pattern gaps, 7', 'Weakest markets, non-brand queries, 4', 'Not asked, 38', 'Hand-picked, 0'])
    // What is drawn is the view and its number. Weakest markets reads non-brand results only, and says so to someone who hears only its button.
    expect(buttons().map(button => button.textContent)).toEqual(['Locations without queries31', 'Thin markets12', 'Pattern gaps7', 'Weakest markets4', 'Not asked38', 'Hand-picked0'])
    expect(buttons().map(button => button.getAttribute('aria-pressed'))).toEqual(Array(6).fill('false'))
    expectNoSentence(row())
  })

  test('a view with none still opens, and choosing a view reports which', () => {
    const { onSelect } = renderViews({ views: { ...VIEWS, thinMarkets: { count: 0, floor: 6, marketKeys: [] } } })
    const thin = screen.getByRole('button', { name: 'Thin markets, 0' }) as HTMLButtonElement
    expect(thin.disabled).toBe(false)
    fireEvent.click(thin)
    fireEvent.click(screen.getByRole('button', { name: 'Hand-picked, 0' }))
    expect(onSelect.mock.calls).toEqual([['thin-markets'], ['hand-picked']])
  })

  test('the views that are on read as pressed', () => {
    const { rerender, onSelect } = renderViews({ active: ['thin-markets'] })
    const pressed = () => buttons().filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.getAttribute('aria-label'))
    expect(pressed()).toEqual(['Thin markets, 12'])
    rerender(<TrackedSavedViews views={VIEWS} notAsked={38} handPicked={0} active={['not-asked', 'hand-picked']} onSelect={onSelect} />)
    expect(pressed()).toEqual(['Not asked, 38', 'Hand-picked, 0'])
  })

  test('Weakest markets is drawn only with a sweep to read, and holds its place while the results load', () => {
    const { rerender, onSelect } = renderViews({ weakMarkets: undefined })
    expect(screen.queryByRole('button', { name: /^Weakest markets/ })).toBeNull()
    expect(buttons()).toHaveLength(5)

    rerender(<TrackedSavedViews views={VIEWS} weakMarkets="pending" notAsked={38} handPicked={0} active={[]} onSelect={onSelect} />)
    // No number yet, and none made up: the name is the view and its type.
    const waiting = screen.getByRole('button', { name: 'Weakest markets, non-brand queries' })
    expect(buttons().indexOf(waiting)).toBe(3)
    expect(waiting.textContent).toBe('Weakest markets')
  })

  test('a number the summary did not send is left out, never shown as zero', () => {
    renderViews({ notAsked: undefined, handPicked: undefined })
    expect(names().slice(-2)).toEqual(['Not asked', 'Hand-picked'])
    expect(buttons().slice(-2).map(button => button.textContent)).toEqual(['Not asked', 'Hand-picked'])
  })

  test('what each view lists is one help beside the label, with the server\'s own floor for a thin market', () => {
    const { rerender, onSelect } = renderViews()
    const help = 'Locations without queries: no location query of their own. Thin markets: fewer than 6 market queries. Pattern gaps: saved patterns missing from some markets. Weakest markets: no mention on the last sweep, non-brand market queries only. Not asked and Hand-picked filter the queries.'
    const trigger = screen.getByRole('button', { name: help })
    // Beside the label and outside the group, so the group is named "Views" alone and the help is no view.
    expect(row().contains(trigger)).toBe(false)
    expect(trigger.closest('div')!.textContent).toBe('Views')

    // With no sweep there is no Weakest markets view to explain.
    rerender(<TrackedSavedViews views={VIEWS} notAsked={38} handPicked={0} active={[]} onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: help.replace(' Weakest markets: no mention on the last sweep, non-brand market queries only.', '') })).toBeTruthy()
  })

  test('on a phone the buttons are one line that scrolls inside the row, each a 44px target, and from md they wrap', async () => {
    const { container } = renderViews()
    const rules = await rulesFor(container)
    expect(compiledElementProperty(rules, row(), 'overflow-x')).toBe('auto')
    expect(compiledElementProperty(rules, row(), 'flex-wrap')).toBeUndefined()
    expect(compiledElementProperty(rules, row(), 'flex-wrap', FROM_MD)).toBe('wrap')
    const button = buttons()[0]!
    expect([compiledElementProperty(rules, button, 'flex-shrink'), compiledElementProperty(rules, button, 'white-space')]).toEqual(['0', 'nowrap'])
    expect(compiledElementProperty(rules, button, 'height', BELOW_MD)).toBe('calc(var(--spacing) * 11)')
  })

  test('only the four views that list places are values of the URL', () => {
    expect(['no-property-queries', 'thin-markets', 'pattern-gaps', 'weak-markets', 'not-asked', 'hand-picked', 'other', undefined].map(trackedPlaceView))
      .toEqual(['no-property-queries', 'thin-markets', 'pattern-gaps', 'weak-markets', undefined, undefined, undefined, undefined])
  })
})

describe('TrackedPlaceList', () => {
  function renderList(props: Partial<Parameters<typeof TrackedPlaceList>[0]> = {}) {
    const onBack = vi.fn()
    const onAdd = vi.fn()
    const all = { view: 'thin-markets' as const, workspace: WORKSPACE, views: VIEWS, onBack, onAdd, ...props }
    const view = render(<TrackedPlaceList {...all} />)
    return { ...view, onBack, onAdd }
  }
  const table = (name: string) => screen.getByRole('table', { name })
  const headers = (name: string) => within(table(name)).getAllByRole('columnheader').map(header => header.textContent)
  /** Each row's cells as text, the action cell as its button's or its note's text. */
  const cells = (name: string) => within(table(name)).getAllByRole('row').slice(1).map(row => [...(row as HTMLTableRowElement).cells].map(cell => cell.textContent))
  const count = () => screen.getByRole('status').textContent

  test('a market view lists the server\'s markets by name with each market\'s own numbers, and one action that names what it adds', () => {
    const { onAdd } = renderList()
    expect(headers('Thin markets')).toEqual(['Market', 'Group', 'Locations', 'Market queries', 'Actions'])
    // The three markets the server listed, by name. Locations is the length of the market's own list, Market queries its own count.
    expect(cells('Thin markets')).toEqual([
      ['Downtown, Lakeshore', 'None', '1', '3', 'Add market query'],
      ['Lakeview', 'Lakeshore Metro', '0', '0', 'No locations'],
      ['Uptown', 'North, Lakeshore', '2', '5', 'Add market query'],
    ])
    // The length of the list shown: the read's own count, 12, is the button's.
    expect(count()).toBe('3 markets')
    noteButton('View: Thin markets', 'Markets with fewer than 6 market queries.')

    fireEvent.click(screen.getByRole('button', { name: 'Add market query for Uptown' }))
    expect(onAdd.mock.calls).toEqual([[{ kind: 'market', key: 'uptown', label: 'Uptown' }]])
    expectNoSentence(table('Thin markets'))
  })

  test('a market with no location left says why and offers no add', () => {
    renderList()
    const emptied = within(table('Thin markets')).getByText('Lakeview').closest('tr')!
    noteButton('No locations', 'A market with no location takes no query.', emptied)
    expect(within(emptied).queryByRole('button', { name: /^Add / })).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Add market query for / })).toHaveLength(2)
  })

  test('a location view lists the server\'s locations with their groups and market queries, and a key the workspace no longer lists by its key', () => {
    const { onAdd } = renderList({ view: 'no-property-queries' })
    expect(headers('Locations without queries')).toEqual(['Location', 'Group', 'Market queries', 'Actions'])
    expect(cells('Locations without queries')).toEqual([
      ['gone', 'None', '', 'Add location query'],
      // A group's name can hold a comma, so a dot parts two groups.
      ['River Point', 'Lakeshore Metro · North, Lakeshore', '7', 'Add location query'],
      ['Summit Lofts', 'Lakeshore Metro', '0', 'Add location query'],
    ])
    expect(count()).toBe('3 locations')
    noteButton('View: Locations without queries', 'Locations with no location query of their own.')
    fireEvent.click(screen.getByRole('button', { name: 'Add location query for River Point' }))
    expect(onAdd.mock.calls).toEqual([[{ kind: 'location', key: 'river', label: 'River Point' }]])
  })

  test('a viewer reads the same list with no action column and no dead button', () => {
    renderList({ onAdd: undefined })
    expect(headers('Thin markets')).toEqual(['Market', 'Group', 'Locations', 'Market queries'])
    expect(cells('Thin markets').map(row => row.length)).toEqual([4, 4, 4])
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
    expect(screen.queryByText('No locations')).toBeNull()
    expect(screen.getAllByRole('button').filter(button => (button as HTMLButtonElement).disabled)).toEqual([])
  })

  test('a pattern lists the markets it is asked in and missing from behind each count, and a deleted pattern keeps its text', () => {
    renderList({ view: 'pattern-gaps' })
    expect(headers('Pattern gaps')).toEqual(['Pattern', 'Used in', 'Missing in'])
    expect(cells('Pattern gaps')).toEqual([['Bestbest apartments {market}', '1', '1'], ['luxury apartments {market}Pattern deleted', '2', '0']])
    expect(count()).toBe('2 patterns')
    const [best, gone] = within(table('Pattern gaps')).getAllByRole('row').slice(1)
    // Each count is the length of the server's list, and its markets are in the button's name.
    expect(within(best!).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['1 market: Uptown', '1 market: Downtown, Lakeshore'])
    noteButton('Pattern deleted', 'This saved pattern was deleted. Its queries are still tracked.', gone!)
    expect(within(gone!).getByRole('button', { name: '2 markets: Downtown, Lakeshore · Uptown' }).textContent).toBe('2')
    noteButton('View: Pattern gaps', 'Saved patterns missing from some markets.')
  })

  test('a count behind many markets names the first twelve and says how many more', () => {
    const markets = Array.from({ length: 15 }, (_, index) => ({ stableKey: `m${index}`, label: `Market ${String(index + 1).padStart(2, '0')}`, usageEdges: [], targetKeys: ['harbor'] }))
    const views = { ...VIEWS, patternGaps: { count: 1, patterns: [{ templateId: 'template-best', name: 'Best', pattern: 'best apartments {market}', usedMarketKeys: ['m0'], missingMarketKeys: markets.slice(1).map(market => market.stableKey).reverse() }] } }
    renderList({ view: 'pattern-gaps', views, workspace: { ...WORKSPACE, markets } as never })
    const names = Array.from({ length: 12 }, (_, index) => `Market ${String(index + 2).padStart(2, '0')}`).join(' · ')
    expect(screen.getByRole('button', { name: `14 markets: ${names} and 2 more` }).textContent).toBe('14')
  })

  test('the search narrows the list by name and group, counts it against the whole list, and a search that finds none offers to clear it', () => {
    renderList()
    const search = screen.getByRole('searchbox', { name: 'Search markets' }) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'north' } })
    expect(cells('Thin markets').map(row => row[0])).toEqual(['Uptown'])
    expect(count()).toBe('1 of 3 markets')

    fireEvent.change(search, { target: { value: 'no such market' } })
    const none = screen.getByText('No markets match').closest('td')!
    expect(count()).toBe('0 of 3 markets')
    fireEvent.click(within(none).getByRole('button', { name: 'Clear search' }))
    expect(search.value).toBe('')
    expect(cells('Thin markets')).toHaveLength(3)
    // Its button went with the empty list, so the search holds the focus.
    expect(document.activeElement).toBe(search)
  })

  test('a long list is paged, fifty rows first, and a short one has no pages to turn', () => {
    const markets = Array.from({ length: 60 }, (_, index) => ({ stableKey: `m${index}`, label: `Market ${String(index + 1).padStart(2, '0')}`, usageEdges: [], targetKeys: ['harbor'], counts: { marketQueries: 1, propertyQueries: 0, answersPerSweep: 3 } }))
    const { unmount } = renderList({ workspace: { ...WORKSPACE, markets } as never, views: { ...VIEWS, thinMarkets: { count: 60, floor: 6, marketKeys: markets.map(market => market.stableKey) } } })
    expect(cells('Thin markets')).toHaveLength(50)
    expect(screen.getByText('1 to 50 of 60 markets')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(cells('Thin markets').map(row => row[0])).toEqual(Array.from({ length: 10 }, (_, index) => `Market ${index + 51}`))
    // Another page size starts at the first page.
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows' }), { target: { value: '25' } })
    expect(screen.getByText('1 to 25 of 60 markets')).toBeTruthy()
    expect(cells('Thin markets')[0]![0]).toBe('Market 01')
    unmount()

    renderList()
    expect(screen.queryByRole('combobox', { name: 'Rows' })).toBeNull()
    expect(screen.queryByText(/^1 to /)).toBeNull()
  })

  test('Weakest markets names the type its count is of, waits for the results and says when they did not load', () => {
    const onRetry = vi.fn()
    const { rerender, onBack, onAdd } = renderList({ view: 'weak-markets', weakMarkets: { marketKeys: ['uptown'] } })
    const list = (props: Partial<Parameters<typeof TrackedPlaceList>[0]>) => <TrackedPlaceList view="weak-markets" workspace={WORKSPACE} views={VIEWS} onBack={onBack} onAdd={onAdd} onRetry={onRetry} {...props} />
    expect(cells('Weakest markets')).toEqual([['Uptown', 'North, Lakeshore', '2', '5', 'Add market query']])
    expect(count()).toBe('1 market · non-brand queries')
    noteButton('View: Weakest markets', 'Markets no answer mentioned on the last sweep. Non-brand market queries only.')

    // The results are still being read: rows stand in, with no count and nothing to search.
    rerender(list({ pending: true }))
    expect(screen.getByRole('status', { name: 'Loading markets' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to queries' })).toBeTruthy()

    rerender(list({ failed: true }))
    const failed = screen.getByRole('alert')
    expect(failed.textContent).toBe('Could not loadRetry')
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry results' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('table')).toBeNull()
  })

  test.each([
    ['thin-markets', 'Thin markets', 'No thin markets'],
    ['no-property-queries', 'Locations without queries', 'Every location has queries'],
    ['pattern-gaps', 'Pattern gaps', 'No pattern gaps'],
    ['weak-markets', 'Weakest markets', 'No weak markets'],
  ] as const)('with none to list, %s says so under its header and leaves the way back', (view, label, empty) => {
    const none: QueryTrackingViews = { noPropertyQueries: { count: 0, targetKeys: [] }, thinMarkets: { count: 0, floor: 6, marketKeys: [] }, patternGaps: { count: 0, patterns: [] } }
    const { onBack } = renderList({ view, views: none, weakMarkets: { marketKeys: [] } })
    expect(within(table(label)).getByText(empty).closest('td')!.textContent).toBe(empty)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to queries' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('in a frame under 52rem each row is a block with its column names, and the header is not drawn', async () => {
    const { container } = renderList()
    const rules = await rulesFor(container)
    const [head, body] = [table('Thin markets').querySelector('thead')!, table('Thin markets').querySelector('tbody')!]
    const row = body.rows[0]!
    expect(compiledElementProperty(rules, head, 'display', NARROW_FRAME)).toBe('none')
    expect([table('Thin markets'), body, row].map(element => compiledElementProperty(rules, element, 'display', NARROW_FRAME))).toEqual(['block', 'block', 'flex'])
    // The name and its action share the first line, then the group, then the numbers.
    expect([...row.cells].map(cell => compiledElementProperty(rules, cell, 'order', NARROW_FRAME))).toEqual(['1', '3', '4', '4', '2'])
    expect([...row.cells].map(cell => cell.getAttribute('data-label'))).toEqual([null, 'Group', 'Locations', 'Market queries', null])
    // Each column's name is drawn before its value as generated text, so the page holds it once.
    const generated = [...row.cells[1]!.classList].filter(candidate => candidate.includes('attr(data-label)'))
    expect(generated).toHaveLength(1)
    expect(await compileAppStyles(generated)).toMatch(/@container \(width < 52rem\) \{\s*&::before \{\s*--tw-content: attr\(data-label\);/)
    // Where a finger is the pointer, and below md, the row's action is a 44px target.
    expect(compiledElementProperty(rules, within(row).getByRole('button'), 'min-height', BELOW_MD)).toBe('calc(var(--spacing) * 11)')
  })
})
