import React from 'react'
import { createPortal } from 'react-dom'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { AccountProvider } from '../src/contexts/account-context.js'
import { QueriesSection, type QueriesSectionProps, type TrackedPageHostProps } from '../src/components/project/DiscoverySection.js'
import { DEFAULT_TRACKED_FILTERS } from '../src/components/project/queries/advanced/tracked-filters.js'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

// What the Queries host hands its pages, whatever each page draws: the research and the advanced page are stand-ins here.

vi.mock('../src/components/project/queries/QueryResearchWorkspace.js', () => ({
  QueryResearchWorkspace: ({ mode, onModeChange }: { mode?: string; onModeChange: (mode: string) => void }) => (
    <div>
      <output aria-label="Research mode">{mode ?? 'none'}</output>
      <button type="button" onClick={() => onModeChange('pattern')}>Choose pattern</button>
    </div>
  ),
}))

vi.mock('../src/components/project/queries/advanced/AdvancedTrackedPage.js', () => ({
  AdvancedTrackedPage: ({ trackedFilters, onTrackedFiltersChange, trackingChangedAt, nextSweepDate, actionsSlot }: TrackedPageHostProps) => (
    <div>
      <output aria-label="Tracked filters">{JSON.stringify(trackedFilters)}</output>
      <output aria-label="Dates">{JSON.stringify({ trackingChangedAt, nextSweepDate })}</output>
      <button type="button" onClick={() => onTrackedFiltersChange({ type: 'branded' })}>Choose branded</button>
      {actionsSlot ? createPortal(<button type="button">Page action</button>, actionsSlot) : null}
    </div>
  ),
}))

afterEach(cleanup)

function installWorkspace(mode: 'simple' | 'advanced' = 'advanced') {
  const restore = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/query-tracking') {
      return jsonResponse({
        mode, workspaceVersion: `qtw_${'a'.repeat(64)}`, active: mode === 'advanced' ? { revision: 4, compiledChecksum: 'c'.repeat(64) } : null,
        defaultContexts: [], targets: [], groups: [], markets: [], tracked: [], savedSources: { research: [], discovery: [] },
      })
    }
    if (path === '/api/v1/projects/demo/measurement-query-templates') return jsonResponse({ templates: [] })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
}

function renderSection(props: Partial<QueriesSectionProps> = {}, role?: 'viewer') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const section = (next: Partial<QueriesSectionProps>) => (
    <AccountProvider account={role ? { name: role, role } : null}>
      <QueryClientProvider client={queryClient}><QueriesSection projectName="demo" {...next} /></QueryClientProvider>
    </AccountProvider>
  )
  const view = render(section(props))
  return { rerender: (next: Partial<QueriesSectionProps>) => view.rerender(section(next)) }
}

const researchMode = () => screen.getByRole('status', { name: 'Research mode' }).textContent
const trackedFilters = async () => JSON.parse((await screen.findByRole('status', { name: 'Tracked filters' })).textContent!) as unknown
const HOST_DATES = { trackingChangedAt: '2026-10-09T15:00:00.000Z', nextSweepDate: 'Oct 21' }
const hostDates = async () => JSON.parse((await screen.findByRole('status', { name: 'Dates' })).textContent!) as unknown
/** Where a page's actions are drawn: the element after the tabs, in their row. */
const actionsSlot = () => screen.getByRole('tablist', { name: 'Query workspace' }).nextElementSibling as HTMLElement

test('the research page gets the mode the host names, and none when the host names none', () => {
  const { rerender } = renderSection({ queryWorkspace: 'research' })
  expect(researchMode()).toBe('none')
  for (const mode of ['write', 'pattern', 'find'] as const) {
    rerender({ queryWorkspace: 'research', researchMode: mode })
    expect(researchMode()).toBe(mode)
  }
})

test('a mode chosen with no host mode shows at once, and stops counting once the host has named one', () => {
  const onResearchModeChange = vi.fn()
  const { rerender } = renderSection({ queryWorkspace: 'research', onResearchModeChange })
  fireEvent.click(screen.getByRole('button', { name: 'Choose pattern' }))
  expect(onResearchModeChange).toHaveBeenCalledWith('pattern')
  expect(researchMode()).toBe('pattern')

  // The host writes the choice to the URL, then Back returns to a URL with none: the page's own default shows again.
  rerender({ queryWorkspace: 'research', researchMode: 'pattern', onResearchModeChange })
  expect(researchMode()).toBe('pattern')
  rerender({ queryWorkspace: 'research', onResearchModeChange })
  expect(researchMode()).toBe('none')
})

test('the Tracked page gets the host filters, or the section keeps them when the host holds none', async () => {
  installWorkspace()
  const onTrackedFiltersChange = vi.fn()
  const { rerender } = renderSection({ onTrackedFiltersChange })
  expect(await trackedFilters()).toEqual(DEFAULT_TRACKED_FILTERS)
  fireEvent.click(screen.getByRole('button', { name: 'Choose branded' }))
  expect(onTrackedFiltersChange).toHaveBeenCalledWith({ type: 'branded' })
  expect(await trackedFilters()).toEqual({ ...DEFAULT_TRACKED_FILTERS, type: 'branded' })

  // A host that holds the filters decides them: a change is reported and shows only once the host passes it back.
  const held = { ...DEFAULT_TRACKED_FILTERS, subject: 'market' as const, status: 'all' as const }
  rerender({ trackedFilters: held, onTrackedFiltersChange })
  expect(await trackedFilters()).toEqual(held)
  fireEvent.click(screen.getByRole('button', { name: 'Choose branded' }))
  expect(onTrackedFiltersChange).toHaveBeenCalledTimes(2)
  expect(await trackedFilters()).toEqual(held)
})

test('the Tracked page gets both dates, and its actions sit between the tabs and the page', async () => {
  installWorkspace()
  renderSection(HOST_DATES)
  expect(await hostDates()).toEqual(HOST_DATES)

  // The order a keyboard meets them in: the tabs, the page's actions, then the page.
  const action = await screen.findByRole('button', { name: 'Page action' })
  const tabs = screen.getByRole('tablist', { name: 'Query workspace' })
  expect(tabs.contains(action)).toBe(false)
  expect(tabs.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(action.compareDocumentPosition(screen.getByRole('status', { name: 'Dates' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('the actions share the tab row at its right, and take the line under the tabs in a narrow frame', async () => {
  installWorkspace()
  renderSection()
  const action = await screen.findByRole('button', { name: 'Page action' })
  const tabs = screen.getByRole('tablist', { name: 'Query workspace' })
  const slot = actionsSlot()
  const row = tabs.parentElement!
  expect(slot.contains(action)).toBe(true)
  expect(slot.parentElement).toBe(row)

  const rules = parseCompiledCss(await compileAppStyles([row, tabs, slot].flatMap(element => [...element.classList])))
  const wide = '@container (width >= 36rem)'
  // One column until the frame holds both: the slot follows the tabs, so it lands under them.
  expect(compiledElementProperty(rules, row, 'display')).toBe('grid')
  expect(compiledElementProperty(rules, row, 'grid-template-columns')).toBeUndefined()
  expect(compiledElementProperty(rules, row, 'grid-template-columns', wide)).toBe('1fr auto')
  expect(compiledElementProperty(rules, slot, 'justify-content')).toBe('flex-end')
  // The tabs hold the row's height at every width, and in the shared row the slot adds none: a 44px control fits.
  expect(cssLengthPx(compiledElementProperty(rules, tabs, 'min-height')!, rules)).toBe(48)
  expect(compiledElementProperty(rules, tabs, 'align-items')).toBe('flex-end')
  expect(cssLengthPx(compiledElementProperty(rules, slot, 'padding-top', wide)!, rules)).toBe(0)
})

test('a simple project keeps its own page, and the actions slot stays empty', async () => {
  installWorkspace('simple')
  renderSection(HOST_DATES)
  expect(await screen.findByRole('region', { name: 'Tracked queries' })).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Dates' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Page action' })).toBeNull()
  expect(actionsSlot().childElementCount).toBe(0)
})

test('a viewer gets the dates the host names, and no Research tab', async () => {
  installWorkspace()
  renderSection(HOST_DATES, 'viewer')
  expect(await hostDates()).toEqual(HOST_DATES)
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Tracked'])
})

test('a failed workspace read keeps the tabs and offers one action, which reads again and mounts the page', async () => {
  let reads = 0
  const restore = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/measurement-query-templates') return jsonResponse({ templates: [] })
    if (path !== '/api/v1/projects/demo/query-tracking') throw new Error(`Unexpected fetch: ${path}`)
    reads += 1
    if (reads === 1) return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500)
    return jsonResponse({
      mode: 'advanced', workspaceVersion: `qtw_${'a'.repeat(64)}`, active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
      defaultContexts: [], targets: [], groups: [], markets: [], tracked: [], savedSources: { research: [], discovery: [] },
    })
  })
  onTestFinished(restore)
  renderSection()
  // Found by its place, not its words: the body under the tab row holds the one action of the failed state.
  const body = screen.getByRole('region', { name: 'Queries' }).lastElementChild as HTMLElement
  const retry = await within(body).findByRole('button')
  expect(within(body).getAllByRole('button')).toEqual([retry])
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Tracked', 'Research'])
  expect(screen.queryByRole('status', { name: 'Tracked filters' })).toBeNull()
  expect(actionsSlot().childElementCount).toBe(0)
  expect(reads).toBe(1)

  fireEvent.click(retry)
  expect(await trackedFilters()).toEqual(DEFAULT_TRACKED_FILTERS)
  expect(reads).toBe(2)
})

test.each([
  // The host knows the mode from a plan it already read: the skeleton has the advanced page's strip and toolbar.
  ['an advanced project the host knows', 'advanced' as const, 2],
  // Until any read says which page this is, a plain list of rows stands for both.
  ['a project whose mode is not known yet', undefined, 0],
])('while the workspace loads, %s gets a skeleton and no words', async (_label, trackedMode, above) => {
  onTestFinished(mockFetch(() => new Promise<Response>(() => {})))
  renderSection({ trackedMode })
  const rows = await screen.findByRole('status', { name: 'Loading queries' })
  expect(rows.children).toHaveLength(8)
  // What stands above the rows is drawing only: nothing to read and nothing to reach.
  const before = [...rows.parentElement!.children].slice(0, -1)
  expect(before).toHaveLength(above)
  for (const block of before) expect(block.getAttribute('aria-hidden')).toBe('true')
  const body = screen.getByRole('region', { name: 'Queries' }).lastElementChild as HTMLElement
  expect(body.textContent).toBe('')
  expect(within(body).queryAllByRole('button')).toEqual([])
  expect(actionsSlot().childElementCount).toBe(0)
})

test.each(['advanced', undefined] as const)('a failed workspace read says Could not load with one Retry, whatever the mode (hint: %s)', async trackedMode => {
  onTestFinished(mockFetch(() => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500)))
  renderSection({ trackedMode })
  // An icon, a label and one action. The button reads Retry and its name says what it reads again.
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Could not loadRetry')
  expect(alert.querySelector('svg')).not.toBeNull()
  const retry = within(alert).getByRole('button', { name: 'Retry tracked queries' })
  expect(retry.textContent).toBe('Retry')
  expect(within(alert).getAllByRole('button')).toEqual([retry])
})

test('the Queries heading names the section and is drawn for assistive tech only', async () => {
  renderSection({ queryWorkspace: 'research' })
  const heading = screen.getByRole('heading', { name: 'Queries' })
  expect(screen.getByRole('region', { name: 'Queries' }).contains(heading)).toBe(true)
  const rules = parseCompiledCss(await compileAppStyles([...heading.classList]))
  expect(compiledElementProperty(rules, heading, 'position')).toBe('absolute')
  expect(cssLengthPx(compiledElementProperty(rules, heading, 'width')!, rules)).toBe(1)
  expect(cssLengthPx(compiledElementProperty(rules, heading, 'height')!, rules)).toBe(1)
  expect(compiledElementProperty(rules, heading, 'overflow')).toBe('hidden')
})
