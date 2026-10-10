import React from 'react'
import { expect, onTestFinished, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { QueriesSection } from '../../src/components/project/DiscoverySection.js'
import { AccountProvider } from '../../src/contexts/account-context.js'
import { jsonResponse, mockFetch } from '../mock-fetch.js'

// Fixtures and steps shared by the tracked-queries tests, which are split by entry point: query-tracking-simple, -legacy-form, -review and -advanced-table.

export const workspaceVersion = `qtw_${'a'.repeat(64)}`
export const previewToken = `qtp_${'b'.repeat(64)}`
const checksum = 'c'.repeat(64)

export const context = {
  providers: ['openai'],
  models: { openai: 'gpt-5' },
  location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
}

export const active = { revision: 4, compiledChecksum: checksum }
export const selectedContext = { providers: ['openai'], models: { openai: 'gpt-5' }, location: 'New York' }

export function workspace() {
  return {
    mode: 'advanced',
    workspaceVersion,
    active,
    defaultContexts: [context],
    targets: [{ stableKey: 'acme', label: 'Acme' }],
    groups: [{ stableKey: 'north-east', label: 'North East', targetKeys: ['acme'] }],
    markets: [{ stableKey: 'new-york', label: 'New York', usageEdges: [{ executionNodeKey: 'node-acme', targetKey: 'acme', queryId: 'query-acme' }] }],
    tracked: [
      {
        queryId: 'query-acme',
        queryText: 'Acme pricing',
        normalizedText: 'acme pricing',
        provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z' },
        state: 'tracked', lastMeasuredAt: '2026-09-04T12:10:00.000Z',
        assignments: [{
          targetKey: 'acme', groupKeys: ['north-east'], marketKeys: ['new-york'],
          queryClass: 'branded', classificationSource: 'frozen', contexts: [context],
        }],
      },
      {
        queryId: 'query-category',
        queryText: 'Best AEO platform',
        normalizedText: 'best aeo platform',
        provenance: { source: 'research', sourceId: 'research-query-1', capturedAt: '2026-09-04T12:00:00.000Z' },
        state: 'awaiting-sweep', lastMeasuredAt: null,
        assignments: [{
          targetKey: 'acme', groupKeys: [], marketKeys: [],
          queryClass: 'non-brand', classificationSource: 'server', contexts: [context],
        }],
      },
    ],
    savedSources: {
      research: [{ researchRunId: 'research-run-1', researchRunQueryId: 'research-query-1', queryText: 'How do teams compare AEO platforms?', createdAt: '2026-09-04T11:00:00.000Z' }],
      discovery: [{ discoverySessionId: 'discovery-session-1', discoveryProbeId: 'discovery-probe-1', queryText: 'What does Acme cost?', createdAt: '2026-09-04T10:00:00.000Z' }],
    },
  }
}

export function preview(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'advanced', workspaceVersion, previewToken, reviewedAt: '2026-09-04T12:15:00.000Z', active, tracked: workspace().tracked,
    diff: { added: [], removed: [], reused: [], unchanged: [], noOp: false },
    workload: {
      existingNodes: 2, existingProviderCalls: 2,
      nextSweepNodes: 3, nextSweepProviderCalls: 3,
      addedNodes: 1, addedProviderCalls: 1,
      removedNodes: 0, removedProviderCalls: 0,
    },
    ...overrides,
  }
}

export function renderWorkspace(props: Partial<React.ComponentProps<typeof QueriesSection>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const base = {
    projectName: 'demo',
    queryWorkspace: 'tracked' as const,
    onQueryWorkspaceChange: vi.fn(),
    researchMode: 'find' as const,
    onResearchModeChange: vi.fn(),
    selection: { measurementScope: 'project' as const, queryClass: 'all' as const },
    onSelectionChange: vi.fn(),
    onTrackingQueryIdChange: vi.fn(),
  }
  const all = { ...base, ...props }
  render(<QueryClientProvider client={queryClient}><QueriesSection {...all} /></QueryClientProvider>)
  return { ...all, queryClient }
}

export function renderViewerWorkspace(props: Partial<React.ComponentProps<typeof QueriesSection>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const all = {
    projectName: 'demo',
    queryWorkspace: 'tracked' as const,
    researchMode: 'find' as const,
    selection: { measurementScope: 'project' as const, queryClass: 'all' as const },
    ...props,
  }
  render(
    <AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
      <QueryClientProvider client={queryClient}><QueriesSection {...all} /></QueryClientProvider>
    </AccountProvider>,
  )
  return all
}

export function installWorkspaceApi(
  onRequest?: (path: string, body: unknown, method: string) => Response | Promise<Response>,
  templates: unknown[] = [],
  workspaceResponse = workspace(),
) {
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/projects/demo/query-tracking' && method === 'GET') return jsonResponse(workspaceResponse)
    if (path === '/api/v1/projects/demo/measurement-query-templates' && method === 'GET') return jsonResponse({ templates })
    if (onRequest) return onRequest(path, init?.body ? JSON.parse(String(init.body)) : undefined, method)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
}

export function chooseContext(location = 'New York') {
  const control = screen.getByLabelText('Location and engines') as HTMLSelectElement
  const details = control.closest('details')
  if (details && !details.open) fireEvent.click(details.querySelector('summary')!)
  const option = [...control.options].find(candidate => candidate.text.includes(location))
  if (!option) throw new Error(`No ${location} context option was rendered`)
  fireEvent.change(control, { target: { value: option.value } })
}

/** An advanced project opens the Add queries sheet first; its link opens the Add query form the legacy-form tests cover. */
export function openLegacyAdd() {
  fireEvent.click(screen.getByRole('button', { name: 'Add queries' }))
  fireEvent.click(screen.getByRole('button', { name: 'Hand-picked locations, templates or saved research' }))
}

export function installScrollSpy() {
  const scrollIntoView = vi.fn()
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })
  return scrollIntoView
}

export const advancedResetLine = 'New numbers after the next sweep'
export const advancedResetNotice = 'After you publish, AI Visibility keeps showing the last sweep until the next sweep. Location pages and competitor results show no numbers until then. Past answers are kept. Publishing does not run a sweep.'
export const sweepActiveMessage = 'A sweep is queued or running. Publish after it finishes.'
export const removalDiff = { added: [], removed: [{ queryId: 'query-acme', queryText: 'Acme pricing', assignmentCount: 1 }], reused: [], unchanged: [], noOp: false }
// One node asked on three engines is three provider calls, so an answer number read from the node counts would show.
export const removalWorkload = { existingNodes: 2, existingProviderCalls: 6, nextSweepNodes: 1, nextSweepProviderCalls: 3, addedNodes: 0, addedProviderCalls: 0, removedNodes: 1, removedProviderCalls: 3 }
// The preview's `tracked` is the post-change state, so a whole-query removal drops the row.
export const trackedAfterRemoval = workspace().tracked.filter(row => row.queryId !== 'query-acme')

/** Opens the review of a removal on an Advanced project. query-tracking-simple keeps its own steps. */
export async function reviewRemoval() {
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Remove Acme pricing' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  return screen.findByRole('heading', { name: /^(Confirm tracked query changes|Review \d+ changes?|No tracking changes)$/ })
}

/** The advanced review's number grid, as label and value pairs. */
export function reviewNumbers() {
  return Object.fromEntries(screen.getAllByRole('term').map(term => [term.textContent, term.nextElementSibling?.textContent]))
}

/** One row of an advanced review table, by its query. `row` holds the button that lists the query's locations in the row under it. */
export function reviewRow(queryText: string, table = 'Changes') {
  const row = within(screen.getByRole('table', { name: table })).getByText(queryText).closest('tr')!
  const [change, , type, assignments, searchLocation] = [...row.cells].map(cell => cell.textContent)
  return { row, change, type, assignments, searchLocation }
}

/** Open a review row's location list, closed until asked for, and read its lines from the row under it. */
export function listLocations(row: HTMLTableRowElement, name: string) {
  const toggle = within(row).getByRole('button', { name })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  const rowsBefore = row.parentElement!.rows.length
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(row.parentElement!.rows.length).toBe(rowsBefore + 1)
  const list = row.nextElementSibling as HTMLTableRowElement
  expect(list.id).toBe(toggle.getAttribute('aria-controls'))
  return [...list.querySelectorAll('li')].map(line => line.textContent)
}
