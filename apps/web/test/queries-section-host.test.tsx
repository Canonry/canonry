import React from 'react'
import { createPortal } from 'react-dom'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { QueriesSection, type QueriesSectionProps, type TrackedPageHostProps } from '../src/components/project/DiscoverySection.js'
import { DEFAULT_TRACKED_FILTERS } from '../src/components/project/queries/advanced/tracked-filters.js'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

// What the Queries host hands its pages, whatever each page draws: both pages are stand-ins here.

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

function installWorkspace() {
  const restore = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/query-tracking') {
      return jsonResponse({
        mode: 'advanced', workspaceVersion: `qtw_${'a'.repeat(64)}`, active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
        defaultContexts: [], targets: [], groups: [], markets: [], tracked: [], savedSources: { research: [], discovery: [] },
      })
    }
    if (path === '/api/v1/projects/demo/measurement-query-templates') return jsonResponse({ templates: [] })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
}

function renderSection(props: Partial<QueriesSectionProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const section = (next: Partial<QueriesSectionProps>) => (
    <QueryClientProvider client={queryClient}><QueriesSection projectName="demo" {...next} /></QueryClientProvider>
  )
  const view = render(section(props))
  return { rerender: (next: Partial<QueriesSectionProps>) => view.rerender(section(next)) }
}

const researchMode = () => screen.getByRole('status', { name: 'Research mode' }).textContent
const trackedFilters = async () => JSON.parse((await screen.findByRole('status', { name: 'Tracked filters' })).textContent!) as unknown

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
  renderSection({ trackingChangedAt: '2026-10-09T15:00:00.000Z', nextSweepDate: 'Oct 21' })
  const dates = await screen.findByRole('status', { name: 'Dates' })
  expect(JSON.parse(dates.textContent!)).toEqual({ trackingChangedAt: '2026-10-09T15:00:00.000Z', nextSweepDate: 'Oct 21' })

  // The order a keyboard meets them in: the tabs, the page's actions, then the page.
  const action = await screen.findByRole('button', { name: 'Page action' })
  const tabs = screen.getByRole('tablist', { name: 'Query workspace' })
  expect(tabs.contains(action)).toBe(false)
  expect(tabs.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(action.compareDocumentPosition(dates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
