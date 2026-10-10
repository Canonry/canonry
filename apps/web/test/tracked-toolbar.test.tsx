import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { AccountProvider } from '../src/contexts/account-context.js'
import { TrackedBulkBar } from '../src/components/project/queries/advanced/TrackedBulkBar.js'
import { TrackedToolbar } from '../src/components/project/queries/advanced/TrackedToolbar.js'
import { DEFAULT_TRACKED_FILTERS } from '../src/components/project/queries/advanced/tracked-filters.js'
import type { TrackedFilters } from '../src/components/project/queries/advanced/tracked-types.js'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'

afterEach(cleanup)

const COARSE = '@media (pointer: coarse)'
const BELOW_MD = '@media (width < 48rem)'
const rulesFor = async (container: HTMLElement) => parseCompiledCss(await compileAppStyles([...container.querySelectorAll('*')].flatMap(element => [...element.classList])))
/**
 * What an element's classes set in one state, such as holding the focused control. Read from the compiled rule
 * text: the shared parser keeps a nested state rule but not the class it belongs to.
 */
async function stateStyle(element: Element, variant: string): Promise<Record<string, string>> {
  const classes = [...element.classList].filter(candidate => candidate.startsWith(`${variant}:`))
  const css = await compileAppStyles(classes)
  expect(classes.length, variant).toBeGreaterThan(0)
  return Object.fromEntries(classes.flatMap(candidate => {
    const start = css.indexOf(`.${candidate.replace(/([^\w-])/g, '\\$1')} {`)
    const rule = css.slice(start, css.indexOf('}', start))
    expect(start >= 0 && rule.includes('&:'), candidate).toBe(true)
    return [...rule.slice(rule.lastIndexOf('{') + 1).matchAll(/([\w-]+):([^;]+);/g)].map(([, property, value]) => [property!, value!.trim()])
  }))
}

function renderToolbar(props: Partial<Parameters<typeof TrackedToolbar>[0]> = {}) {
  const onFiltersChange = vi.fn()
  const onSearchChange = vi.fn()
  const view = render(<TrackedToolbar search="" onSearchChange={onSearchChange} filters={DEFAULT_TRACKED_FILTERS} onFiltersChange={onFiltersChange} {...props} />)
  return { ...view, onFiltersChange, onSearchChange }
}
const select = (name: string) => screen.getByRole<HTMLSelectElement>('combobox', { name })
const choices = (name: string) => [...select(name).options].map(option => option.textContent)
const chosen = (name: string) => select(name).selectedOptions[0]!.textContent
const filtersButton = () => screen.getByRole('button', { name: /^Filters/ })

describe('TrackedToolbar', () => {
  test('each filter is a labelled select holding its choices, on its default', () => {
    renderToolbar()
    expect(within(screen.getByRole('group', { name: 'Filters' })).getAllByRole('combobox').map(control => control.getAttribute('aria-label'))).toEqual(['Subject', 'Type', 'Status', 'Source', 'Result'])
    expect(choices('Subject')).toEqual(['Any', 'Market', 'Location', 'Company', 'Hand-picked', 'None'])
    expect(choices('Type')).toEqual(['All', 'Non-brand', 'Branded', 'Mixed', 'Not set'])
    expect(choices('Status')).toEqual(['Measured + First answers', 'Measured', 'First answers', 'Not asked', 'All'])
    expect(choices('Source')).toEqual(['Any', 'Pattern', 'Manual', 'Research', 'Setup', 'Older list'])
    expect(choices('Result')).toEqual(['Any', 'Not mentioned', 'Not cited', 'Not checked'])
    expect(['Subject', 'Type', 'Status', 'Source', 'Result'].map(chosen)).toEqual(['Any', 'All', 'Measured + First answers', 'Any', 'Any'])
  })

  test('the control reads as its label and its current choice, drawn once and spoken by the select', () => {
    renderToolbar({ filters: { ...DEFAULT_TRACKED_FILTERS, subject: 'hand-picked', result: 'not-cited' } })
    const drawn = (name: string) => [...select(name).parentElement!.querySelectorAll('span[aria-hidden="true"]')].map(part => part.textContent)
    expect(drawn('Subject')).toEqual(['Subject', 'Hand-picked'])
    expect(drawn('Result')).toEqual(['Result', 'Not cited'])
    expect(drawn('Status')).toEqual(['Status', 'Measured + First answers'])
    expect([chosen('Subject'), chosen('Result'), chosen('Status')]).toEqual(['Hand-picked', 'Not cited', 'Measured + First answers'])
  })

  test('beside a mouse a control is as wide as its widest choice, so choosing never moves the row', async () => {
    const { container } = renderToolbar({ filters: { ...DEFAULT_TRACKED_FILTERS, subject: 'hand-picked' } })
    const rules = await rulesFor(container)
    // Every choice is set under the current one as generated text: nothing to read, to find or to announce.
    const rooms = (name: string) => [...select(name).parentElement!.querySelectorAll<HTMLElement>('[data-choice]')]
    for (const name of ['Subject', 'Type', 'Status', 'Source', 'Result']) expect(rooms(name).map(room => room.dataset.choice), name).toEqual(choices(name))
    const room = rooms('Subject')[0]!
    const current = room.parentElement!.lastElementChild!
    expect([room.textContent, room.parentElement!.getAttribute('aria-hidden'), current.textContent]).toEqual(['', 'true', 'Hand-picked'])
    expect([compiledElementProperty(rules, room, 'visibility'), compiledElementProperty(rules, room, 'white-space')]).toEqual(['hidden', 'nowrap'])
    expect(cssLengthPx(compiledElementProperty(rules, room, 'height')!, rules)).toBe(0)
    // One cell of a grid holds them all, so its width is the widest and its height the current choice's.
    expect(compiledElementProperty(rules, room.parentElement!, 'display')).toBe('grid')
    for (const part of [room, current]) expect([compiledElementProperty(rules, part, 'grid-column-start'), compiledElementProperty(rules, part, 'grid-row-start')]).toEqual(['1', '1'])
    // In the phone panel the grid sets the width, and a long choice is cut short, not pushed out of its cell.
    expect(compiledElementProperty(rules, room, 'display', BELOW_MD)).toBe('none')
    expect([compiledElementProperty(rules, current, 'overflow'), compiledElementProperty(rules, current, 'text-overflow')]).toEqual(['hidden', 'ellipsis'])
  })

  test('choosing changes that filter and no other', () => {
    const { onFiltersChange } = renderToolbar({ filters: { ...DEFAULT_TRACKED_FILTERS, type: 'branded' } })
    fireEvent.change(select('Status'), { target: { value: 'not-asked' } })
    expect(onFiltersChange).toHaveBeenLastCalledWith({ subject: 'any', type: 'branded', status: 'not-asked', source: 'any', result: 'any' })
    fireEvent.change(select('Type'), { target: { value: 'all' } })
    expect(onFiltersChange).toHaveBeenLastCalledWith(DEFAULT_TRACKED_FILTERS)
  })

  test('the search is labelled and reports what is typed', () => {
    const { onSearchChange } = renderToolbar({ search: 'harbor' })
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search queries' })
    expect([search.value, search.placeholder]).toEqual(['harbor', 'Search queries'])
    fireEvent.change(search, { target: { value: 'harbor point' } })
    expect(onSearchChange).toHaveBeenLastCalledWith('harbor point')
  })

  test('a clean view says how many queries it lists; a narrowed one counts them against every tracked query', () => {
    const { rerender, onFiltersChange, onSearchChange } = renderToolbar({ shown: 932, total: 970 })
    const toolbar = (props: Partial<Parameters<typeof TrackedToolbar>[0]>) => <TrackedToolbar search="" onSearchChange={onSearchChange} filters={DEFAULT_TRACKED_FILTERS} onFiltersChange={onFiltersChange} {...props} />
    // No search and no filter: the 38 the default Status leaves out are not a filter the reader set, so no "of".
    expect(screen.getByRole('status').textContent).toBe('932 queries')
    // A filter, or text in the search, narrows the list: the count is read against every tracked query.
    rerender(toolbar({ shown: 92, total: 970, filters: { ...DEFAULT_TRACKED_FILTERS, type: 'branded' } }))
    expect(screen.getByRole('status').textContent).toBe('92 of 970 queries')
    rerender(toolbar({ shown: 1204, total: 12480, search: 'harbor' }))
    expect(screen.getByRole('status').textContent).toBe('1,204 of 12,480 queries')
    // Spaces alone are not a search.
    rerender(toolbar({ shown: 932, total: 970, search: '  ' }))
    expect(screen.getByRole('status').textContent).toBe('932 queries')
    // A filter that leaves nothing out: one number says it.
    rerender(toolbar({ shown: 970, total: 970, filters: { ...DEFAULT_TRACKED_FILTERS, status: 'all' } }))
    expect(screen.getByRole('status').textContent).toBe('970 queries')
    rerender(toolbar({ shown: 1, total: 1 }))
    expect(screen.getByRole('status').textContent).toBe('1 query')
    rerender(toolbar({ shown: 0, total: 0 }))
    expect(screen.getByRole('status').textContent).toBe('0 queries')
    // No total to count against: the listed number alone.
    rerender(toolbar({ shown: 92, filters: { ...DEFAULT_TRACKED_FILTERS, type: 'branded' } }))
    expect(screen.getByRole('status').textContent).toBe('92 queries')
    // While the rows load there is no count to give.
    rerender(toolbar({}))
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('shows the legend it is given, with or without a count beside it', () => {
    const legend = <ul aria-label="Chips"><li>Mentioned</li></ul>
    const { unmount } = renderToolbar({ shown: 3, total: 3, legend })
    expect(screen.getByRole('list', { name: 'Chips' }).textContent).toBe('Mentioned')
    unmount()
    // While the rows load there is no count, and the chips still need their legend.
    renderToolbar({ legend })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('list', { name: 'Chips' }).textContent).toBe('Mentioned')
  })

  test('Clear filters shows only while a filter is set, resets them all in one step and moves focus on', () => {
    function Host() {
      const [filters, setFilters] = useState<TrackedFilters>({ subject: 'market', type: 'non-brand', status: 'asked', source: 'pattern', result: 'not-mentioned' })
      return <TrackedToolbar search="harbor" onSearchChange={() => {}} filters={filters} onFiltersChange={setFilters} shown={40} total={970} />
    }
    render(<Host />)
    const clear = screen.getByRole('button', { name: 'Clear filters' })
    // It sits with the count, outside the panel, so a phone reaches it without opening Filters.
    expect(clear.parentElement).toBe(screen.getByRole('status').parentElement)
    expect(screen.getByRole('group', { name: 'Filters' }).contains(clear)).toBe(false)
    clear.focus()
    fireEvent.click(clear)
    expect(['Subject', 'Type', 'Status', 'Source', 'Result'].map(chosen)).toEqual(['Any', 'All', 'Measured + First answers', 'Any', 'Any'])
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    // The button went with the last filter: focus is on the way back to the filters, not lost. The search is left as it was.
    expect(document.activeElement).toBe(filtersButton())
    expect([screen.getByRole<HTMLInputElement>('searchbox').value, screen.getByRole('status').textContent]).toEqual(['harbor', '40 of 970 queries'])
  })

  test('with no filter set there is no Clear filters, whatever the search holds', () => {
    renderToolbar({ search: 'harbor', shown: 12, total: 970 })
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  test('where the Filters button is not shown, Clear filters moves focus to the first filter', () => {
    function Host() {
      const [filters, setFilters] = useState<TrackedFilters>({ ...DEFAULT_TRACKED_FILTERS, result: 'not-cited' })
      return <TrackedToolbar search="" onSearchChange={() => {}} filters={filters} onFiltersChange={setFilters} />
    }
    render(<Host />)
    // With a mouse from md up the button is not drawn, and a control that is not drawn takes no focus.
    filtersButton().focus = () => {}
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(document.activeElement).toBe(select('Subject'))
  })

  test('Filters says how many filters are set, opens the panel, and Escape closes it back to the button', () => {
    function Host() {
      const [filters, setFilters] = useState<TrackedFilters>({ ...DEFAULT_TRACKED_FILTERS, subject: 'market', result: 'not-mentioned' })
      return <TrackedToolbar search="" onSearchChange={() => {}} filters={filters} onFiltersChange={setFilters} />
    }
    render(<Host />)
    const panel = screen.getByRole('group', { name: 'Filters' })
    expect(filtersButton().textContent).toBe('Filters · 2')
    expect([filtersButton().getAttribute('aria-expanded'), filtersButton().getAttribute('aria-controls')]).toEqual(['false', panel.id])

    fireEvent.click(filtersButton())
    expect(filtersButton().getAttribute('aria-expanded')).toBe('true')
    // Choosing keeps the panel open, and the button counts the change.
    fireEvent.change(select('Subject'), { target: { value: 'any' } })
    expect([filtersButton().textContent, filtersButton().getAttribute('aria-expanded')]).toEqual(['Filters · 1', 'true'])

    select('Source').focus()
    fireEvent.keyDown(select('Source'), { key: 'Escape' })
    expect(filtersButton().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(filtersButton())

    // Escape on the button itself closes an open panel too.
    fireEvent.click(filtersButton())
    fireEvent.keyDown(filtersButton(), { key: 'Escape' })
    expect(filtersButton().getAttribute('aria-expanded')).toBe('false')
  })

  test('with the panel closed, Escape in a select leaves focus where it is', () => {
    renderToolbar()
    expect(filtersButton().textContent).toBe('Filters')
    select('Type').focus()
    fireEvent.keyDown(select('Type'), { key: 'Escape' })
    expect(document.activeElement).toBe(select('Type'))
  })

  test('with a mouse from md up the selects sit in the row; below md or under a finger they sit behind Filters at 44px', async () => {
    const { container } = renderToolbar()
    const panel = screen.getByRole('group', { name: 'Filters' })
    const control = select('Status').parentElement!
    const search = screen.getByRole('searchbox')
    const display = (rules: Awaited<ReturnType<typeof rulesFor>>, element: Element) => [undefined, BELOW_MD, COARSE].map(context => compiledElementProperty(rules, element, 'display', context))
    const height = (rules: Awaited<ReturnType<typeof rulesFor>>, element: Element) => [undefined, BELOW_MD, COARSE].map(context => cssLengthPx(compiledElementProperty(rules, element, 'height', context)!, rules))

    const closed = await rulesFor(container)
    // Closed: the selects are items of the toolbar row with a mouse, and not drawn at all otherwise.
    expect(display(closed, panel)).toEqual(['contents', 'none', 'none'])
    expect(display(closed, filtersButton())).toEqual(['none', 'inline-flex', 'inline-flex'])
    // The search and a filter share one height: 32px with a mouse, 44px under a finger.
    expect(height(closed, control)).toEqual([32, 44, 44])
    expect(height(closed, search)).toEqual([32, 44, 44])
    expect(cssLengthPx(compiledElementProperty(closed, filtersButton(), 'min-height')!, closed)).toBe(44)
    // The select lies unseen over the whole of its control, so a click or a tap anywhere on it opens the choices.
    expect(compiledElementProperty(closed, control, 'position')).toBe('relative')
    expect(['position', 'inset', 'width', 'height', 'opacity'].map(property => compiledElementProperty(closed, select('Status'), property))).toEqual(['absolute', 'calc(var(--spacing) * 0)', '100%', '100%', '0%'])

    fireEvent.click(filtersButton())
    const open = await rulesFor(container)
    // Open: a panel on a row of its own; with a mouse it is still the same row of selects.
    expect(display(open, panel)).toEqual(['contents', 'grid', 'grid'])
    expect(compiledElementProperty(open, panel, 'flex-basis')).toBe('100%')
  })

  test('the select is unseen, so its control shows keyboard focus: a ring and a brighter border', async () => {
    renderToolbar()
    for (const name of ['Subject', 'Type', 'Status', 'Source', 'Result']) {
      const focus = await stateStyle(select(name).parentElement!, 'has-[:focus-visible]')
      expect(focus, name).toMatchObject({ 'border-color': 'var(--color-mono-500)', '--tw-ring-color': 'var(--color-mono-500)' })
      expect(focus['--tw-ring-shadow'], name).toContain('calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color')
      expect(focus['box-shadow'], name).toContain('var(--tw-ring-shadow)')
    }
  })

  test('the toolbar\'s width decides its rows: the search joins the selects from 66rem, where they fit at their widest', async () => {
    const { container } = renderToolbar()
    const rules = await rulesFor(container)
    const searchRow = screen.getByRole('searchbox').parentElement!.parentElement!
    expect(compiledElementProperty(rules, container.firstElementChild!, 'container-type')).toBe('inline-size')
    expect([compiledElementProperty(rules, searchRow, 'flex-basis'), compiledElementProperty(rules, searchRow, 'flex-basis', '@container (width >= 66rem)')]).toEqual(['100%', 'calc(var(--spacing) * 0)'])
    // No control is pushed past the page: each can shrink, and the row wraps.
    expect(compiledElementProperty(rules, searchRow.parentElement!, 'flex-wrap')).toBe('wrap')
    for (const control of [...screen.getAllByRole('combobox').map(control => control.parentElement!), screen.getByRole('searchbox').parentElement!]) expect(cssLengthPx(compiledElementProperty(rules, control, 'min-width')!, rules)).toBe(0)
  })

  test('Clear filters is set into the count\'s line beside a mouse, and is a 44px target under a finger', async () => {
    const { container } = renderToolbar({ filters: { ...DEFAULT_TRACKED_FILTERS, type: 'mixed' }, shown: 5, total: 970 })
    const rules = await rulesFor(container)
    const clear = screen.getByRole('button', { name: 'Clear filters' })
    // 32px tall in a 20px line: it gives back the 6px above and below, so the first filter set does not move the table.
    expect([undefined, BELOW_MD, COARSE].map(context => cssLengthPx(compiledElementProperty(rules, clear, 'margin-block', context)!, rules))).toEqual([-6, 0, 0])
    for (const context of [BELOW_MD, COARSE]) expect(cssLengthPx(compiledElementProperty(rules, clear, 'min-height', context)!, rules)).toBe(44)
  })
})

describe('TrackedBulkBar', () => {
  function renderBar(props: Partial<Parameters<typeof TrackedBulkBar>[0]> = {}) {
    const handlers = { onAction: vi.fn(), onSelectAll: vi.fn(), onClear: vi.fn() }
    const view = render(<TrackedBulkBar selectedCount={4} maxRows={50} actions={['change-type', 'stop']} selectAllCount={40} {...handlers} {...props} />)
    return { ...view, ...handlers, bar: screen.getByRole('region', { name: 'Selected queries' }) }
  }
  const buttons = (bar: HTMLElement) => within(bar).getAllByRole('button').map(button => button.textContent)
  const MAX_ROWS = 'Max 50 rows. One change takes at most 50 rows. Clear some to continue.'

  test('says how many rows are selected and offers only the actions it is given', () => {
    const { bar, onAction, rerender } = renderBar()
    expect(within(bar).getByRole('status').textContent).toBe('4 selected')
    expect(buttons(bar)).toEqual(['Change type', 'Stop tracking', 'Select all 40', 'Clear'])
    fireEvent.click(within(bar).getByRole('button', { name: 'Stop tracking' }))
    expect(onAction).toHaveBeenLastCalledWith('stop')
    fireEvent.click(within(bar).getByRole('button', { name: 'Change type' }))
    expect(onAction).toHaveBeenLastCalledWith('change-type')

    // Rows that are not asked take the other two.
    rerender(<TrackedBulkBar selectedCount={2} maxRows={50} actions={['track', 'remove']} onAction={onAction} onClear={() => {}} />)
    expect(buttons(bar)).toEqual(['Track', 'Remove query', 'Clear'])
    fireEvent.click(within(bar).getByRole('button', { name: 'Remove query' }))
    expect(onAction).toHaveBeenLastCalledWith('remove')
  })

  test('Select all names how many rows it would select, for as long as the caller offers it; Clear clears', () => {
    const { bar, onSelectAll, onClear, onAction, rerender } = renderBar({ selectedCount: 1204, selectAllCount: 12480, maxRows: 20000 })
    const bulk = (props: Partial<Parameters<typeof TrackedBulkBar>[0]>) => <TrackedBulkBar selectedCount={4} maxRows={50} actions={['stop']} onAction={onAction} onClear={onClear} {...props} />
    expect(within(bar).getByRole('status').textContent).toBe('1,204 selected')
    fireEvent.click(within(bar).getByRole('button', { name: 'Select all 12,480' }))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)

    // The selection can hold rows the filters no longer list, so the two counts say nothing about whether the listed rows are selected: 50 selected and 40 others listed is still an offer.
    rerender(bulk({ selectedCount: 50, selectAllCount: 40, onSelectAll }))
    expect(buttons(bar)).toEqual(['Stop tracking', 'Select all 40', 'Clear'])
    // Every listed row is selected: the caller leaves the offer out.
    rerender(bulk({ selectedCount: 40 }))
    expect(buttons(bar)).toEqual(['Stop tracking', 'Clear'])
    // A count with no way to select them: no offer.
    rerender(bulk({ selectAllCount: 40 }))
    expect(buttons(bar)).toEqual(['Stop tracking', 'Clear'])
  })

  test('never offers to select more rows than one change takes', () => {
    const { bar, onAction, onSelectAll, onClear, rerender } = renderBar({ selectAllCount: 932 })
    const bulk = (props: Partial<Parameters<typeof TrackedBulkBar>[0]>) => <TrackedBulkBar selectedCount={4} maxRows={50} actions={['stop']} onAction={onAction} onSelectAll={onSelectAll} onClear={onClear} {...props} />
    // It would only land on Max 50 rows with every action off.
    expect(buttons(bar)).toEqual(['Change type', 'Stop tracking', 'Clear'])
    rerender(bulk({ selectAllCount: 51 }))
    expect(buttons(bar)).toEqual(['Stop tracking', 'Clear'])
    // A list that fits is offered whole, at the most rows exactly too.
    rerender(bulk({ selectAllCount: 50 }))
    expect(buttons(bar)).toEqual(['Stop tracking', 'Select all 50', 'Clear'])
    // Over the most already: selecting a list that fits is a way back under it.
    rerender(bulk({ selectedCount: 51, selectAllCount: 40 }))
    expect(within(bar).getByRole('button', { name: 'Select all 40' })).toBeTruthy()
  })

  test('at the most rows one change takes the actions work; one more turns them off and says why', () => {
    const { bar, onAction, onSelectAll, onClear, rerender } = renderBar({ selectedCount: 50 })
    expect(within(bar).getAllByRole<HTMLButtonElement>('button').filter(button => button.disabled)).toEqual([])
    expect(within(bar).queryByText(/^Max/)).toBeNull()

    rerender(<TrackedBulkBar selectedCount={51} maxRows={50} actions={['change-type', 'stop']} selectAllCount={40} onAction={onAction} onSelectAll={onSelectAll} onClear={onClear} />)
    expect(within(bar).getAllByRole<HTMLButtonElement>('button').filter(button => button.disabled).map(button => button.textContent)).toEqual(['Change type', 'Stop tracking'])
    expect(within(bar).getByRole('button', { name: MAX_ROWS }).textContent).toBe('Max 50 rows')
    fireEvent.click(within(bar).getByRole('button', { name: 'Stop tracking' }))
    expect(onAction).not.toHaveBeenCalled()
    // The way out stays on.
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  test('shows the caller\'s note where the actions would be; over the most rows that comes first', () => {
    const { bar, onAction, onSelectAll, onClear, rerender } = renderBar({ actions: [], note: <span>Mixed selection</span> })
    expect(bar.textContent).toBe('4 selectedMixed selectionSelect all 40Clear')

    rerender(<TrackedBulkBar selectedCount={51} maxRows={50} actions={[]} note={<span>Mixed selection</span>} selectAllCount={40} onAction={onAction} onSelectAll={onSelectAll} onClear={onClear} />)
    expect(bar.textContent).toBe('51 selectedMax 50 rowsSelect all 40Clear')
  })

  test('a view-only account is offered no action, and no word on how many rows one takes', () => {
    const { rerender } = render(<AccountProvider account={{ name: 'viewer', role: 'viewer' }}><TrackedBulkBar selectedCount={4} maxRows={50} actions={['change-type', 'stop']} onAction={() => {}} onClear={() => {}} /></AccountProvider>)
    const bar = screen.getByRole('region', { name: 'Selected queries' })
    expect(buttons(bar)).toEqual(['Clear'])

    // Over the most rows there is still nothing a viewer could do with fewer.
    rerender(<AccountProvider account={{ name: 'viewer', role: 'viewer' }}><TrackedBulkBar selectedCount={51} maxRows={50} actions={['change-type', 'stop']} onAction={() => {}} onClear={() => {}} /></AccountProvider>)
    expect(bar.textContent).toBe('51 selectedClear')
    expect(buttons(bar)).toEqual(['Clear'])
  })

  test('rides the bottom of the page in the flow, clear of the Aero bar where there is one, with 44px buttons under a finger', async () => {
    const { container, bar, onAction, onClear, rerender } = renderBar()
    const rules = await rulesFor(container)
    // Sticky, not fixed: a fixed box inside a size container would be placed against the container.
    expect([compiledElementProperty(rules, bar, 'position'), cssLengthPx(compiledElementProperty(rules, bar, 'bottom')!, rules)]).toEqual(['sticky', 80])
    expect([compiledElementProperty(rules, bar, 'margin-inline'), compiledElementProperty(rules, bar, 'width'), compiledElementProperty(rules, bar, 'max-width')]).toEqual(['auto', 'fit-content', '100%'])
    for (const button of within(bar).getAllByRole('button')) {
      for (const context of [COARSE, BELOW_MD]) expect(cssLengthPx(compiledElementProperty(rules, button, 'min-height', context)!, rules), `${button.textContent} ${context}`).toBe(44)
    }

    // No Aero bar at the bottom edge: the bar rides just above that edge, not 80px up over the rows.
    rerender(<TrackedBulkBar selectedCount={4} maxRows={50} actions={['stop']} onAction={onAction} onClear={onClear} aeroBarVisible={false} />)
    expect(cssLengthPx(compiledElementProperty(await rulesFor(container), bar, 'bottom')!, rules)).toBe(16)
  })

  test('Select all and Clear stay together, and below md the actions take the row under them', async () => {
    const { container, bar } = renderBar()
    const rules = await rulesFor(container)
    const [selectAll, clear, stop] = ['Select all 40', 'Clear', 'Stop tracking'].map(name => within(bar).getByRole('button', { name }))
    // One group that does not wrap, so Clear is never left alone on a row.
    expect(selectAll!.parentElement).toBe(clear!.parentElement)
    expect([compiledElementProperty(rules, clear!.parentElement!, 'display'), compiledElementProperty(rules, clear!.parentElement!, 'flex-wrap')]).toEqual(['flex', undefined])
    // A phone has no room for the count, two actions and Clear on one row: the actions take a full row, last.
    const actions = stop!.parentElement!
    expect(actions.parentElement).toBe(bar)
    expect([compiledElementProperty(rules, actions, 'flex-basis'), compiledElementProperty(rules, actions, 'flex-basis', BELOW_MD), compiledElementProperty(rules, actions, 'order', BELOW_MD)]).toEqual([undefined, '100%', '9999'])
    // In the page they come before Select all and Clear, as they read from md up.
    expect(buttons(bar)).toEqual(['Change type', 'Stop tracking', 'Select all 40', 'Clear'])
  })

  test('takes an id, so a link by the table can jump to it', () => {
    const { bar } = renderBar({ id: 'tracked-selected-actions' })
    expect(bar.id).toBe('tracked-selected-actions')
  })
})
