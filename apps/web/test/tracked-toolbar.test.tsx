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

  test('counts the queries listed against all of them', () => {
    const { rerender, onFiltersChange, onSearchChange } = renderToolbar({ shown: 92, total: 932 })
    const toolbar = (props: { shown?: number; total?: number }) => <TrackedToolbar search="" onSearchChange={onSearchChange} filters={DEFAULT_TRACKED_FILTERS} onFiltersChange={onFiltersChange} {...props} />
    expect(screen.getByRole('status').textContent).toBe('92 of 932 queries')
    rerender(toolbar({ shown: 1204, total: 12480 }))
    expect(screen.getByRole('status').textContent).toBe('1,204 of 12,480 queries')
    // Nothing is filtered out: one number says it.
    rerender(toolbar({ shown: 932, total: 932 }))
    expect(screen.getByRole('status').textContent).toBe('932 queries')
    rerender(toolbar({ shown: 1, total: 1 }))
    expect(screen.getByRole('status').textContent).toBe('1 query')
    rerender(toolbar({ shown: 0, total: 0 }))
    expect(screen.getByRole('status').textContent).toBe('0 queries')
    // While the rows load there is no count to give.
    rerender(toolbar({}))
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('shows the legend it is given', () => {
    renderToolbar({ shown: 3, total: 3, legend: <ul aria-label="Chips"><li>Mentioned</li></ul> })
    expect(screen.getByRole('list', { name: 'Chips' }).textContent).toBe('Mentioned')
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
})

describe('TrackedBulkBar', () => {
  function renderBar(props: Partial<Parameters<typeof TrackedBulkBar>[0]> = {}) {
    const handlers = { onAction: vi.fn(), onSelectAll: vi.fn(), onClear: vi.fn() }
    const view = render(<TrackedBulkBar selectedCount={4} maxRows={50} actions={['change-type', 'stop']} selectAllCount={92} {...handlers} {...props} />)
    return { ...view, ...handlers, bar: screen.getByRole('region', { name: 'Selected queries' }) }
  }
  const buttons = (bar: HTMLElement) => within(bar).getAllByRole('button').map(button => button.textContent)

  test('says how many rows are selected and offers only the actions it is given', () => {
    const { bar, onAction, rerender } = renderBar()
    expect(within(bar).getByRole('status').textContent).toBe('4 selected')
    expect(buttons(bar)).toEqual(['Change type', 'Stop tracking', 'Select all 92', 'Clear'])
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

  test('Select all names how many rows it would select, until they all are; Clear clears', () => {
    const { bar, onSelectAll, onClear, onAction, rerender } = renderBar({ selectedCount: 1204, selectAllCount: 12480, maxRows: 20000 })
    expect(within(bar).getByRole('status').textContent).toBe('1,204 selected')
    fireEvent.click(within(bar).getByRole('button', { name: 'Select all 12,480' }))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)

    rerender(<TrackedBulkBar selectedCount={92} maxRows={100} actions={['stop']} selectAllCount={92} onAction={onAction} onSelectAll={onSelectAll} onClear={onClear} />)
    expect(buttons(bar)).toEqual(['Stop tracking', 'Clear'])
    // No way to select all: no offer.
    rerender(<TrackedBulkBar selectedCount={4} maxRows={100} actions={['stop']} selectAllCount={92} onAction={onAction} onClear={onClear} />)
    expect(buttons(bar)).toEqual(['Stop tracking', 'Clear'])
  })

  test('at the most rows one change holds the actions work; one more turns them off and says why', () => {
    const { bar, onAction, onSelectAll, onClear, rerender } = renderBar({ selectedCount: 50 })
    expect(within(bar).getAllByRole<HTMLButtonElement>('button').filter(button => button.disabled)).toEqual([])
    expect(within(bar).queryByText(/^Max/)).toBeNull()

    rerender(<TrackedBulkBar selectedCount={51} maxRows={50} actions={['change-type', 'stop']} selectAllCount={92} onAction={onAction} onSelectAll={onSelectAll} onClear={onClear} />)
    expect(within(bar).getAllByRole<HTMLButtonElement>('button').filter(button => button.disabled).map(button => button.textContent)).toEqual(['Change type', 'Stop tracking'])
    expect(within(bar).getByRole('button', { name: 'Max 50 rows. One change holds at most 50 queries. Clear some rows to continue.' }).textContent).toBe('Max 50 rows')
    fireEvent.click(within(bar).getByRole('button', { name: 'Stop tracking' }))
    expect(onAction).not.toHaveBeenCalled()
    // The way out stays on.
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  test('shows the caller\'s note where the actions would be', () => {
    const { bar } = renderBar({ actions: [], note: <span>Mixed selection</span> })
    expect(bar.textContent).toBe('4 selectedMixed selectionSelect all 92Clear')
  })

  test('a view-only account is offered no action', () => {
    render(<AccountProvider account={{ name: 'viewer', role: 'viewer' }}><TrackedBulkBar selectedCount={4} maxRows={50} actions={['change-type', 'stop']} onAction={() => {}} onClear={() => {}} /></AccountProvider>)
    expect(buttons(screen.getByRole('region', { name: 'Selected queries' }))).toEqual(['Clear'])
  })

  test('rides the bottom of the page in the flow, clear of the bar at the bottom edge, with 44px buttons under a finger', async () => {
    const { container, bar } = renderBar()
    const rules = await rulesFor(container)
    // Sticky, not fixed: a fixed box inside a size container would be placed against the container.
    expect([compiledElementProperty(rules, bar, 'position'), cssLengthPx(compiledElementProperty(rules, bar, 'bottom')!, rules)]).toEqual(['sticky', 80])
    expect([compiledElementProperty(rules, bar, 'margin-inline'), compiledElementProperty(rules, bar, 'width'), compiledElementProperty(rules, bar, 'max-width')]).toEqual(['auto', 'fit-content', '100%'])
    for (const button of within(bar).getAllByRole('button')) {
      for (const context of [COARSE, BELOW_MD]) expect(cssLengthPx(compiledElementProperty(rules, button, 'min-height', context)!, rules), `${button.textContent} ${context}`).toBe(44)
    }
  })
})
