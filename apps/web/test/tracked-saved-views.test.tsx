import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
const PHONE_FRAME = '@container (width < 30rem)'

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
      { templateId: 'template-gone', name: null, pattern: 'luxury apartments {market}', usedMarketKeys: ['downtown', 'uptown'], missingMarketKeys: ['midtown'] },
    ],
  },
}
/** Three locations, one of them in two groups, and four markets, one of them with no location left. */
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
    { stableKey: 'midtown', label: 'Midtown', groupKey: 'metro', usageEdges: [], targetKeys: ['river', 'summit'], counts: { marketQueries: 8, propertyQueries: 0, answersPerSweep: 16 } },
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
    expect(names()).toEqual(['Location gaps, 31', 'Thin markets, 12', 'Pattern gaps, 7', 'Weakest markets, non-brand queries, 4', 'Not asked, 38', 'Hand-picked, 0'])
    // What is drawn is the view and its number. Weakest markets reads non-brand results only, and says so to someone who hears only its button.
    expect(buttons().map(button => button.textContent)).toEqual(['Location gaps31', 'Thin markets12', 'Pattern gaps7', 'Weakest markets4', 'Not asked38', 'Hand-picked0'])
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

  test('a view that is on is marked by its border and ground at the same weight, and focus is a ring clear of the border on either', async () => {
    const { container } = renderViews({ active: ['thin-markets'] })
    const rules = await rulesFor(container)
    const [off, on] = [buttons()[0]!, buttons()[1]!]
    // A heavier weight would widen the button and move every view after it.
    expect([off, on].map(button => compiledElementProperty(rules, button, 'font-weight'))).toEqual([undefined, undefined])
    expect(compiledElementProperty(rules, on, 'border-color')).not.toBe(compiledElementProperty(rules, off, 'border-color'))
    // The same ring on both: 2px, 2px off the button, so it does not merge with the border of a pressed one.
    for (const button of [off, on]) {
      const focus = await compileAppStyles([...button.classList].filter(candidate => candidate.startsWith('focus-visible:')))
      expect(focus).toMatch(/&:focus-visible \{[^}]*--tw-ring-offset-width: 2px/)
      expect(focus).toMatch(/&:focus-visible \{[^}]*--tw-ring-shadow:[^;]*calc\(2px \+ var\(--tw-ring-offset-width\)\)/)
      // Focus changes no border, so the pressed view's own border still shows inside the ring.
      expect([...button.classList].filter(candidate => candidate.startsWith('focus-visible:border'))).toEqual([])
    }
    // The ring is 4px past the button, and the line that scrolls keeps that much room for it.
    expect(compiledElementProperty(rules, row(), 'padding')).toBe('calc(var(--spacing) * 1)')
  })

  test('on a line that scrolls, the view that is on is brought into it and the page is not moved', () => {
    // A phone: the line holds 60px to 350px, and Weakest markets is drawn past its right edge.
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.getAttribute('role') === 'group') return { left: 60, right: 350 } as DOMRect
      return (this.getAttribute('aria-label')?.startsWith('Weakest markets') ? { left: 520, right: 660 } : { left: 70, right: 200 }) as DOMRect
    })
    // jsdom has no scrollIntoView. One is stood in, to show the page's own scroll is never asked for.
    const scrolled = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrolled })
    try {
      const { rerender, onSelect } = renderViews({ active: ['weak-markets'] })
      // Its right edge and 4px for its focus ring.
      expect(row().scrollLeft).toBe(314)
      // A view already in the line moves nothing.
      row().scrollLeft = 0
      rerender(<TrackedSavedViews views={VIEWS} weakMarkets={{ count: 4 }} notAsked={38} handPicked={0} active={['thin-markets']} onSelect={onSelect} />)
      expect(row().scrollLeft).toBe(0)
      expect(scrolled).not.toHaveBeenCalled()
    } finally {
      rect.mockRestore()
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  test('Weakest markets is drawn only with a sweep to read, and holds its place while the results load and after they fail', () => {
    const { rerender, onSelect } = renderViews({ weakMarkets: undefined })
    expect(screen.queryByRole('button', { name: /^Weakest markets/ })).toBeNull()
    expect(buttons()).toHaveLength(5)

    rerender(<TrackedSavedViews views={VIEWS} weakMarkets="pending" notAsked={38} handPicked={0} active={[]} onSelect={onSelect} />)
    // No number yet, and none made up: the name is the view and its type.
    const waiting = screen.getByRole('button', { name: 'Weakest markets, non-brand queries' })
    expect(buttons().indexOf(waiting)).toBe(3)
    expect(waiting.textContent).toBe('Weakest markets')
    expect(waiting.querySelector('.skeleton-text')).not.toBeNull()

    // The read failed: the button stays where it was, so its open view still has a pressed button, with no number and nothing left loading.
    rerender(<TrackedSavedViews views={VIEWS} weakMarkets="failed" notAsked={38} handPicked={0} active={['weak-markets']} onSelect={onSelect} />)
    const failed = screen.getByRole('button', { name: 'Weakest markets, non-brand queries' })
    expect([buttons().indexOf(failed), failed.textContent, failed.getAttribute('aria-pressed')]).toEqual([3, 'Weakest markets', 'true'])
    expect(failed.querySelector('.skeleton-text')).toBeNull()
    fireEvent.click(failed)
    expect(onSelect).toHaveBeenLastCalledWith('weak-markets')
  })

  test('a number the summary did not send is left out, never shown as zero', () => {
    renderViews({ notAsked: undefined, handPicked: undefined })
    expect(names().slice(-2)).toEqual(['Not asked', 'Hand-picked'])
    expect(buttons().slice(-2).map(button => button.textContent)).toEqual(['Not asked', 'Hand-picked'])
  })

  test('what each view lists is one help beside the label, with the server\'s own floor for a thin market', () => {
    const { rerender, onSelect } = renderViews()
    const help = 'Location gaps: no location query. Thin markets: under 6 market queries. Pattern gaps: patterns some markets lack. Weakest markets: no non-brand mention, last sweep. Not asked, Hand-picked: filter the list.'
    const trigger = screen.getByRole('button', { name: help })
    // Beside the label and outside the group, so the group is named "Views" alone and the help is no view.
    expect(row().contains(trigger)).toBe(false)
    expect(trigger.closest('div')!.textContent).toBe('Views')

    // The bubble hangs from the button's own left edge, so it stays inside the page's column: 224px wide from x=300.
    const rect = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 300, right: 316, top: 340, bottom: 356, width: 16, height: 16 } as DOMRect)
    act(() => trigger.focus())
    const bubble = [...document.body.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')].find(candidate => candidate.textContent === help)!
    expect([bubble.style.left, bubble.style.transform]).toEqual(['412px', 'translateX(-50%) translateY(8px)'])
    act(() => trigger.blur())
    rect.mockRestore()

    // With no sweep there is no Weakest markets view to explain.
    rerender(<TrackedSavedViews views={VIEWS} notAsked={38} handPicked={0} active={[]} onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: help.replace(' Weakest markets: no non-brand mention, last sweep.', '') })).toBeTruthy()
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
    // The URL says location, as the page does. The read's own field name, `noPropertyQueries`, is no value of it.
    expect(['no-location-queries', 'thin-markets', 'pattern-gaps', 'weak-markets', 'no-property-queries', 'not-asked', 'hand-picked', 'other', undefined].map(trackedPlaceView))
      .toEqual(['no-location-queries', 'thin-markets', 'pattern-gaps', 'weak-markets', undefined, undefined, undefined, undefined, undefined])
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
  const firstCells = (name: string) => cells(name).map(row => row[0])
  const count = () => screen.getByRole('status').textContent
  /** Each header's order as a screen reader hears it. */
  const sorts = (name: string) => within(table(name)).getAllByRole('columnheader').map(header => header.getAttribute('aria-sort'))
  const sortBy = (name: string, column: string) => fireEvent.click(within(table(name)).getByRole('button', { name: column }))

  test('a market view lists the server\'s markets, the thinnest first, with each market\'s own numbers and one action that names what it adds', () => {
    const { onAdd } = renderList()
    expect(headers('Thin markets')).toEqual(['Market', 'Group', 'Locations', 'Market queries', 'Actions'])
    // The three markets the server listed, by their market queries and then by name. Locations is the length of the market's own list, Market queries its own count.
    expect(cells('Thin markets')).toEqual([
      ['Lakeview', 'Lakeshore Metro', '0', '0', 'No locations'],
      ['Downtown, Lakeshore', 'None', '1', '3', 'Add market query'],
      ['Uptown', 'North, Lakeshore', '2', '5', 'Add market query'],
    ])
    expect(sorts('Thin markets')).toEqual(['none', null, 'none', 'ascending', null])
    // The read's own count, the number on the view's button: the list it sent here holds three.
    expect(count()).toBe('12 markets')
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

  test('a location view lists the server\'s locations by name with their groups and market queries, and a key the workspace no longer lists by its key', () => {
    const { onAdd } = renderList({ view: 'no-location-queries' })
    expect(headers('Location gaps')).toEqual(['Location', 'Group', 'Market queries', 'Actions'])
    expect(cells('Location gaps')).toEqual([
      ['gone', 'None', '', 'Add location query'],
      // A group's name can hold a comma, so a dot parts two groups.
      ['River Point', 'Lakeshore Metro · North, Lakeshore', '7', 'Add location query'],
      ['Summit Lofts', 'Lakeshore Metro', '0', 'Add location query'],
    ])
    expect(sorts('Location gaps')).toEqual(['ascending', null, 'none', null])
    expect(count()).toBe('31 locations')
    noteButton('View: Location gaps', 'Locations with no location query of their own.')
    fireEvent.click(screen.getByRole('button', { name: 'Add location query for River Point' }))
    expect(onAdd.mock.calls).toEqual([[{ kind: 'location', key: 'river', label: 'River Point' }]])
  })

  test('a header puts the list in order by its column, a second press turns it round, and a row with no number stays last', () => {
    // A market the workspace no longer lists has no numbers of its own.
    renderList({ views: { ...VIEWS, thinMarkets: { count: 12, floor: 6, marketKeys: ['uptown', 'retired', 'lakeview', 'downtown'] } } })
    expect(firstCells('Thin markets')).toEqual(['Lakeview', 'Downtown, Lakeshore', 'Uptown', 'retired'])

    sortBy('Thin markets', 'Market queries')
    expect(firstCells('Thin markets')).toEqual(['Uptown', 'Downtown, Lakeshore', 'Lakeview', 'retired'])
    expect(sorts('Thin markets')).toEqual(['none', null, 'none', 'descending', null])

    sortBy('Thin markets', 'Locations')
    expect(firstCells('Thin markets')).toEqual(['Lakeview', 'Downtown, Lakeshore', 'Uptown', 'retired'])
    expect(sorts('Thin markets')).toEqual(['none', null, 'ascending', 'none', null])

    sortBy('Thin markets', 'Market')
    expect(firstCells('Thin markets')).toEqual(['Downtown, Lakeshore', 'Lakeview', 'retired', 'Uptown'])
    sortBy('Thin markets', 'Market')
    expect(firstCells('Thin markets')).toEqual(['Uptown', 'retired', 'Lakeview', 'Downtown, Lakeshore'])
    expect(sorts('Thin markets')).toEqual(['descending', null, 'none', 'none', null])

    // Where each row is a block there is no header, so the same orders are a Sort control's.
    const sort = screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement
    expect([...sort.options].map(option => option.text)).toEqual(['Market', 'Locations', 'Market queries'])
    expect(sort.value).toBe('name')
    fireEvent.change(sort, { target: { value: 'marketQueries' } })
    expect(firstCells('Thin markets')).toEqual(['Lakeview', 'Downtown, Lakeshore', 'Uptown', 'retired'])
    fireEvent.click(screen.getByRole('button', { name: 'Ascending' }))
    expect(firstCells('Thin markets')).toEqual(['Uptown', 'Downtown, Lakeshore', 'Lakeview', 'retired'])
    expect(screen.getByRole('button', { name: 'Descending' })).toBeTruthy()
  })

  test('a viewer reads the same list with no action column and no dead button', () => {
    renderList({ onAdd: undefined })
    expect(headers('Thin markets')).toEqual(['Market', 'Group', 'Locations', 'Market queries'])
    expect(cells('Thin markets').map(row => row.length)).toEqual([4, 4, 4])
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
    expect(screen.queryByText('No locations')).toBeNull()
    expect(screen.getAllByRole('button').filter(button => (button as HTMLButtonElement).disabled)).toEqual([])
  })

  test('a pattern lists how many markets it is asked in and missing from, each count a button that names its markets, and a deleted pattern keeps its text', () => {
    renderList({ view: 'pattern-gaps' })
    expect(headers('Pattern gaps')).toEqual(['Pattern', 'Used in', 'Missing in'])
    expect(cells('Pattern gaps')).toEqual([['Bestbest apartments {market}', '1', '1'], ['luxury apartments {market}Pattern deleted', '2', '1']])
    // The read's own count: the list it sent here holds two.
    expect(count()).toBe('7 patterns')
    const [best, gone] = within(table('Pattern gaps')).getAllByRole('row').slice(1)
    // Each count is the length of the server's list. Its button says what a press shows, and names the markets.
    expect(within(best!).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Show 1 market using Best: Uptown', 'Show 1 market missing Best: Downtown, Lakeshore'])
    noteButton('Pattern deleted', 'This saved pattern was deleted. Its queries are still tracked.', gone!)
    expect(within(gone!).getByRole('button', { name: 'Show 2 markets using luxury apartments {market}: Downtown, Lakeshore · Uptown' }).textContent).toBe('2')
    noteButton('View: Pattern gaps', 'Saved patterns missing from some markets.')
  })

  test('a count opens its markets as a list with a search, pages and the market\'s own Add, under the pattern\'s name, and Back to patterns returns to the count', () => {
    const markets = Array.from({ length: 30 }, (_, index) => ({ stableKey: `m${index}`, label: `Market ${String(index + 1).padStart(2, '0')}`, groupKey: index % 2 ? 'north' : undefined, usageEdges: [], targetKeys: index === 4 ? [] : ['harbor'], counts: { marketQueries: index, propertyQueries: 0, answersPerSweep: 3 } }))
    const views = { ...VIEWS, patternGaps: { count: 1, patterns: [{ templateId: 'template-best', name: 'Best', pattern: 'best apartments {market}', usedMarketKeys: ['m0', 'm1'], missingMarketKeys: markets.slice(2).map(market => market.stableKey).reverse() }] } }
    const { onAdd, onBack } = renderList({ view: 'pattern-gaps', views, workspace: { ...WORKSPACE, markets } as never })
    // The bubble previews six names, each kept whole on its line, and says how many more a press lists.
    const preview = Array.from({ length: 6 }, (_, index) => `Market ${String(index + 3).padStart(2, '0')}`)
    const missing = screen.getByRole('button', { name: `Show 28 markets missing Best: ${preview.join(' · ')} and 22 more` })
    expect(missing.textContent).toBe('28')
    act(() => missing.focus())
    expect(document.body.textContent).toContain(`${preview.map(name => name.replace(' ', '\u00a0')).join(' · ')} and\u00a022\u00a0more`)

    fireEvent.click(missing)
    // All twenty-eight, not the six of the preview: the list the read returned, by name, with each market's own numbers.
    expect(screen.queryByRole('table', { name: 'Pattern gaps' })).toBeNull()
    expect(headers('Best: Missing in')).toEqual(['Market', 'Group', 'Locations', 'Market queries', 'Actions'])
    expect(cells('Best: Missing in')).toHaveLength(28)
    expect(cells('Best: Missing in').slice(0, 3)).toEqual([
      ['Market 03', 'None', '1', '2', 'Add market query'],
      ['Market 04', 'North, Lakeshore', '1', '3', 'Add market query'],
      ['Market 05', 'None', '0', '4', 'No locations'],
    ])
    expect(count()).toBe('Best · Missing in 28 markets')
    // Still the Pattern gaps view, with the way back to its patterns in place of the way back to the queries.
    noteButton('View: Pattern gaps', 'Saved patterns missing from some markets.')
    expect(screen.queryByRole('button', { name: 'Back to queries' })).toBeNull()
    // The count went with the patterns, so the search of the markets holds the focus.
    const search = screen.getByRole('searchbox', { name: 'Search markets' }) as HTMLInputElement
    expect(document.activeElement).toBe(search)
    expect(screen.getByText('1 to 28 of 28 markets')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'market 12' } })
    expect(count()).toBe('Best · Missing in 1 of 28 markets')
    fireEvent.click(screen.getByRole('button', { name: 'Add market query for Market 12' }))
    expect(onAdd.mock.calls).toEqual([[{ kind: 'market', key: 'm11', label: 'Market 12' }]])

    const back = screen.getByRole('button', { name: 'Back to patterns' })
    back.focus()
    fireEvent.click(back)
    expect(onBack).not.toHaveBeenCalled()
    expect(cells('Pattern gaps')).toEqual([['Bestbest apartments {market}', '2', '28']])
    expect(screen.getByRole('button', { name: 'Back to queries' })).toBeTruthy()
    // Back went with the markets, so the count that opened them holds the focus.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Show 28 markets missing Best/ }))

    // The other count opens the markets the pattern is asked in.
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 markets using Best: Market 01 · Market 02' }))
    expect(firstCells('Best: Used in')).toEqual(['Market 01', 'Market 02'])
    expect(count()).toBe('Best · Used in 2 markets')
  })

  test('a deleted pattern\'s markets are listed under its text, and a pattern a later read no longer lists gives way to the patterns', () => {
    const { rerender, onBack, onAdd } = renderList({ view: 'pattern-gaps' })
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 market missing luxury apartments {market}: Midtown' }))
    expect(cells('luxury apartments {market}: Missing in')).toEqual([['Midtown', 'Lakeshore Metro', '2', '8', 'Add market query']])
    expect(count()).toBe('luxury apartments {market} · Missing in 1 market')

    // The gap was filled: the next read lists one pattern, and not this one.
    rerender(<TrackedPlaceList view="pattern-gaps" workspace={WORKSPACE} views={{ ...VIEWS, patternGaps: { count: 1, patterns: VIEWS.patternGaps.patterns.slice(0, 1) } }} onBack={onBack} onAdd={onAdd} />)
    expect(cells('Pattern gaps')).toEqual([['Bestbest apartments {market}', '1', '1']])
    expect(screen.getByRole('button', { name: 'Back to queries' })).toBeTruthy()
  })

  test('the search narrows the list by name and group, counts it against the read\'s count, and a search that finds none offers to clear it', () => {
    renderList()
    const search = screen.getByRole('searchbox', { name: 'Search markets' }) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'north' } })
    expect(firstCells('Thin markets')).toEqual(['Uptown'])
    expect(count()).toBe('1 of 12 markets')

    fireEvent.change(search, { target: { value: 'no such market' } })
    const none = screen.getByText('No markets match').closest('td')!
    expect(count()).toBe('0 of 12 markets')
    fireEvent.click(within(none).getByRole('button', { name: 'Clear search' }))
    expect(search.value).toBe('')
    expect(cells('Thin markets')).toHaveLength(3)
    // Its button went with the empty list, so the search holds the focus.
    expect(document.activeElement).toBe(search)
  })

  test('a long list is paged, fifty rows first, another order starts at the first page, and a short one has no pages to turn', () => {
    const markets = Array.from({ length: 60 }, (_, index) => ({ stableKey: `m${index}`, label: `Market ${String(index + 1).padStart(2, '0')}`, usageEdges: [], targetKeys: ['harbor'], counts: { marketQueries: 1, propertyQueries: 0, answersPerSweep: 3 } }))
    const { unmount } = renderList({ workspace: { ...WORKSPACE, markets } as never, views: { ...VIEWS, thinMarkets: { count: 60, floor: 6, marketKeys: markets.map(market => market.stableKey) } } })
    expect(cells('Thin markets')).toHaveLength(50)
    expect(screen.getByText('1 to 50 of 60 markets')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(firstCells('Thin markets')).toEqual(Array.from({ length: 10 }, (_, index) => `Market ${index + 51}`))
    sortBy('Thin markets', 'Market')
    expect(screen.getByText('1 to 50 of 60 markets')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    // Another page size starts at the first page.
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows' }), { target: { value: '25' } })
    expect(screen.getByText('1 to 25 of 60 markets')).toBeTruthy()
    expect(cells('Thin markets')[0]![0]).toBe('Market 01')
    unmount()

    renderList()
    expect(screen.queryByRole('combobox', { name: 'Rows' })).toBeNull()
    expect(screen.queryByText(/^1 to /)).toBeNull()
  })

  test('Weakest markets names the type of the mentions its count is of, waits for the results and says when they did not load', () => {
    const onRetry = vi.fn()
    // The results count four weak markets and list one here.
    const { rerender, onBack, onAdd } = renderList({ view: 'weak-markets', weakMarkets: { count: 4, marketKeys: ['uptown'] } })
    const list = (props: Partial<Parameters<typeof TrackedPlaceList>[0]>) => <TrackedPlaceList view="weak-markets" workspace={WORKSPACE} views={VIEWS} onBack={onBack} onAdd={onAdd} onRetry={onRetry} {...props} />
    expect(cells('Weakest markets')).toEqual([['Uptown', 'North, Lakeshore', '2', '5', 'Add market query']])
    // The type is the mentions': the Market queries column beside it counts queries of every type.
    expect(count()).toBe('4 markets · no non-brand mention')
    noteButton('View: Weakest markets', 'Markets with no mention on the last sweep. Non-brand market queries only.')

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
    ['no-location-queries', 'Location gaps', 'No location gaps'],
    ['pattern-gaps', 'Pattern gaps', 'No pattern gaps'],
    ['weak-markets', 'Weakest markets', 'No weak markets'],
  ] as const)('with none to list, %s says so under its header and leaves the way back', (view, label, empty) => {
    const none: QueryTrackingViews = { noPropertyQueries: { count: 0, targetKeys: [] }, thinMarkets: { count: 0, floor: 6, marketKeys: [] }, patternGaps: { count: 0, patterns: [] } }
    const { onBack } = renderList({ view, views: none, weakMarkets: { count: 0, marketKeys: [] } })
    expect(within(table(label)).getByText(empty).closest('td')!.textContent).toBe(empty)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    // With nothing to put in order no header is a button, and there is no Sort control.
    expect(within(table(label)).queryAllByRole('button')).toEqual([])
    expect(within(table(label)).getAllByRole('columnheader').map(header => header.getAttribute('aria-sort'))).not.toContain('none')
    expect(screen.queryByRole('combobox', { name: 'Sort' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to queries' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('in a frame under 52rem each row is a block with its column names, two lines of it from 30rem up, and the header gives way to a Sort control', async () => {
    const { container } = renderList()
    const rules = await rulesFor(container)
    const [head, body] = [table('Thin markets').querySelector('thead')!, table('Thin markets').querySelector('tbody')!]
    const row = body.rows[1]!
    expect(compiledElementProperty(rules, head, 'display', NARROW_FRAME)).toBe('none')
    expect([table('Thin markets'), body, row].map(element => compiledElementProperty(rules, element, 'display', NARROW_FRAME))).toEqual(['block', 'block', 'flex'])
    const sort = screen.getByRole('combobox', { name: 'Sort' }).closest('.tracked-stack-controls')!
    expect([compiledElementProperty(rules, sort, 'display'), compiledElementProperty(rules, sort, 'display', NARROW_FRAME)]).toEqual(['none', 'flex'])
    // The name and its action share the first line, then the group and the numbers.
    expect([...row.cells].map(cell => compiledElementProperty(rules, cell, 'order', NARROW_FRAME))).toEqual(['1', '3', '4', '4', '2'])
    expect([...row.cells].map(cell => cell.getAttribute('data-label'))).toEqual([null, 'Group', 'Locations', 'Market queries', null])
    // An empty box as wide as the row sits before the group, so the group starts the second line and the numbers follow on it.
    const breaker = [...row.classList].filter(candidate => candidate.includes(':before:'))
    const breakerCss = await compileAppStyles(breaker)
    expect(breakerCss).toMatch(/@container \(width < 52rem\) \{\s*&::before \{\s*content: var\(--tw-content\);\s*order: 3;/)
    expect(breakerCss).toMatch(/@container \(width < 52rem\) \{\s*&::before \{\s*content: var\(--tw-content\);\s*flex-basis: 100%;/)
    expect(compiledElementProperty(rules, row.cells[1]!, 'flex-basis', NARROW_FRAME)).toBeUndefined()
    // On a phone the group has a line of its own, and the numbers the next.
    expect(compiledElementProperty(rules, row.cells[1]!, 'flex-basis', PHONE_FRAME)).toBe('100%')
    // Each column's name is drawn before its value as generated text, so the page holds it once.
    const generated = [...row.cells[1]!.classList].filter(candidate => candidate.includes('attr(data-label)'))
    expect(generated).toHaveLength(1)
    expect(await compileAppStyles(generated)).toMatch(/@container \(width < 52rem\) \{\s*&::before \{\s*--tw-content: attr\(data-label\);/)
    // Where a finger is the pointer, and below md, the row's action is a 44px target.
    expect(compiledElementProperty(rules, within(row).getByRole('button'), 'min-height', BELOW_MD)).toBe('calc(var(--spacing) * 11)')
  })

  test('a pattern\'s counts are 44px targets where a finger is the pointer and below md', async () => {
    const { container } = renderList({ view: 'pattern-gaps' })
    const rules = await rulesFor(container)
    const button = screen.getByRole('button', { name: /^Show 1 market missing Best/ })
    expect([compiledElementProperty(rules, button, 'min-height', BELOW_MD), compiledElementProperty(rules, button, 'min-width', BELOW_MD)]).toEqual(['calc(var(--spacing) * 11)', 'calc(var(--spacing) * 11)'])
  })
})
