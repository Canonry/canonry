import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UiTelemetryEvent } from '@ainyc/canonry-contracts'
import { uiTelemetryEventSchema } from '@ainyc/canonry-contracts'
import {
  configureUiTelemetry,
  recordUiSearchParamsChange,
  resetUiTelemetryForTests,
  setUiPageFromRoute,
  trackUiFilterChange,
  trackUiSearchInput,
  UI_FILTER_DEBOUNCE_MS,
  UI_SEARCH_DEBOUNCE_MS,
} from '../src/lib/ui-telemetry.js'
import { attachUiTelemetryRouter } from '../src/lib/ui-telemetry-install.js'
import { MetricsWindowPicker } from '../src/components/shared/MetricsWindowPicker.js'
import { DataTableSearch } from '../src/components/shared/DataTableControls.js'

let sent: UiTelemetryEvent[]

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  configureUiTelemetry({ send: async (event) => { sent.push(event); return { accepted: true } } })
  setUiPageFromRoute('/projects/$projectName/')
})

afterEach(() => {
  cleanup()
  resetUiTelemetryForTests()
  vi.useRealTimers()
})

const actions = () => sent.flatMap(e => e.event === 'ui.action' ? [[e.action, e.filter]] : [])

describe('filter.change', () => {
  it('debounces each dimension into one event and never sends the value', () => {
    trackUiFilterChange('provider')
    trackUiFilterChange('provider')
    trackUiFilterChange('provider')
    trackUiFilterChange('window')
    expect(actions()).toEqual([])
    vi.advanceTimersByTime(UI_FILTER_DEBOUNCE_MS)
    expect(actions()).toEqual([['filter.change', 'provider'], ['filter.change', 'window']])
    for (const event of sent) expect(uiTelemetryEventSchema.safeParse(event).success).toBe(true)
  })

  it('maps changed URL filter params to dimensions, ignoring non-filter params', () => {
    recordUiSearchParamsChange(
      { measurementProvider: 'gemini', queryClass: 'all', runId: 'r1', class: 'branded' },
      { measurementProvider: 'openai', queryClass: 'branded', runId: 'r2', measurementLocation: 'nyc' },
    )
    vi.advanceTimersByTime(UI_FILTER_DEBOUNCE_MS)
    expect(actions()).toEqual([
      ['filter.change', 'provider'],
      ['filter.change', 'location'],
      ['filter.change', 'query_class'],
    ])
    const text = JSON.stringify(sent)
    for (const value of ['gemini', 'openai', 'nyc', 'branded']) expect(text).not.toContain(value)
  })

  it('counts a filter change only on the same page, from the router', () => {
    type Loc = { pathname: string; search: Record<string, unknown> }
    let onResolved = () => {}
    const router = {
      state: { matches: [{ fullPath: '/projects/$projectName/' }], location: { pathname: '/projects/acme', search: {} } as Loc },
      subscribe: (_event: 'onResolved', fn: () => void) => { onResolved = fn; return () => {} },
    }
    attachUiTelemetryRouter(router)
    router.state.location = { pathname: '/projects/acme', search: { measurementModel: 'gpt-x' } }
    onResolved()
    router.state.matches = [{ fullPath: '/projects/$projectName/report' }]
    router.state.location = { pathname: '/projects/acme/report', search: { measurementModel: 'gpt-y' } }
    onResolved()
    vi.advanceTimersByTime(UI_FILTER_DEBOUNCE_MS)
    expect(actions()).toEqual([['filter.change', 'model']])
  })

  it('the shared window picker reports a change, not a re-click of the current window', () => {
    const onChange = vi.fn()
    render(<MetricsWindowPicker windows={['7d', '30d']} value="7d" onChange={onChange} label="Window" />)
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    fireEvent.click(screen.getByRole('button', { name: '30d' }))
    vi.advanceTimersByTime(UI_FILTER_DEBOUNCE_MS)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(actions()).toEqual([['filter.change', 'window']])
  })
})

describe('search.submit', () => {
  it('counts a settled non-empty query once and never sends the text', () => {
    render(<DataTableSearch value="" onChange={() => {}} label="Filter queries" />)
    const input = screen.getByRole('searchbox', { name: 'Filter queries' })
    fireEvent.change(input, { target: { value: 'dent' } })
    fireEvent.change(input, { target: { value: 'dentist brooklyn' } })
    vi.advanceTimersByTime(UI_SEARCH_DEBOUNCE_MS)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(actions()).toEqual([['search.submit', undefined]])
    expect(JSON.stringify(sent)).not.toContain('dentist')
  })

  it('Enter counts immediately; clearing the box is not a search', () => {
    trackUiSearchInput('acme', true)
    trackUiSearchInput('')
    vi.advanceTimersByTime(UI_SEARCH_DEBOUNCE_MS)
    trackUiSearchInput('acme', true)
    expect(actions()).toEqual([['search.submit', undefined], ['search.submit', undefined]])
  })
})
