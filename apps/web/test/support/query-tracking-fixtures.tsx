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
    // The server's own totals for the two rows above. The rows carry no `focus`, as an older server sends them.
    summary: {
      asked: 2, notAsked: 0,
      byClass: { branded: 1, nonBrand: 1, mixed: 0, unknown: 0 },
      byFocus: { market: 0, property: 0, company: 0, custom: 2 },
      assignments: { total: 2, branded: 1, nonBrand: 1, unknown: 0 },
      answersPerSweep: 2,
      structure: { targets: 1, markets: 1, groups: 1, topLevelGroups: 1, competitors: 0 },
    },
  }
}

/** The last sweep's results for `workspace()`: it measured Acme pricing, and Best AEO platform still waits for its first answers. */
export function results(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'advanced',
    scope: { kind: 'project', key: null },
    run: { id: 'run-1', createdAt: '2026-09-04T12:00:00.000Z', completedAt: '2026-09-04T12:10:00.000Z', status: 'completed', revision: 4, matchesCurrentTracking: true },
    engines: ['openai'],
    rows: [{
      queryId: 'query-acme', queryText: 'Acme pricing', queryClass: 'branded',
      engines: [{ provider: 'openai', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false }],
    }],
    pendingRows: 1,
    ...overrides,
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
  const section = (next: typeof all) => <QueryClientProvider client={queryClient}><QueriesSection {...next} /></QueryClientProvider>
  const view = render(section(all))
  // `rerender` draws the section again with other props, as the host does when the URL changes.
  return { ...all, queryClient, rerender: (next: Partial<React.ComponentProps<typeof QueriesSection>>) => view.rerender(section({ ...all, ...next })) }
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
  resultsResponse: unknown = results(),
) {
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/projects/demo/query-tracking' && method === 'GET') return jsonResponse(workspaceResponse)
    // The advanced Tracked page reads the last sweep's results beside the workspace.
    if (path === '/api/v1/projects/demo/query-tracking/results' && method === 'GET') return jsonResponse(resultsResponse)
    if (path === '/api/v1/projects/demo/measurement-query-templates' && method === 'GET') return jsonResponse({ templates })
    if (onRequest) return onRequest(path, init?.body ? JSON.parse(String(init.body)) : undefined, method)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
}

export function chooseContext(location = 'New York') {
  const control = screen.getByLabelText('Search location and engines') as HTMLSelectElement
  const details = control.closest('details')
  if (details && !details.open) fireEvent.click(details.querySelector('summary')!)
  const option = [...control.options].find(candidate => candidate.text.includes(location))
  if (!option) throw new Error(`No ${location} context option was rendered`)
  fireEvent.change(control, { target: { value: option.value } })
}

/** The Tracked page's Add button, which names the Place when the page is narrowed to one market or one location. */
export const addButton = () => screen.getByRole('button', { name: /^Add (queries|market query|location query)$/ })

/** An advanced project opens the Add queries sheet first; its link opens the Add query form the legacy-form tests cover. */
export function openLegacyAdd() {
  fireEvent.click(addButton())
  fireEvent.click(screen.getByRole('button', { name: 'More ways to add' }))
}

/** Chooses an action from a Tracked row's menu. The actions that change tracking open a sheet under the action's name. */
export async function chooseRowAction(queryText: string, action: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${queryText}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
}

/** Opens a Tracked row's action sheet from its menu, and gives the sheet to look in. */
export async function openRowSheet(queryText: string, action: string) {
  await chooseRowAction(queryText, action)
  return within(await screen.findByRole('dialog', { name: action }))
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

export const advancedResetLine = 'New numbers next sweep'
export const advancedResetNotice = 'After you publish, location pages and competitor results show no numbers until the next sweep. AI Visibility keeps showing the last sweep. Past answers are kept. Publishing does not run a sweep.'
export const sweepActiveLabel = 'Sweep running'
export const sweepActiveMessage = 'A sweep is queued or running. Publish after it finishes.'

/** A short note's button: its name is the label, then the sentence behind it. Only the label is visible text. */
export function noteButton(label: string, detail: string, container: HTMLElement = document.body) {
  const note = within(container).getByRole('button', { name: `${label}. ${detail}` })
  expect(note.textContent).toBe(label)
  return note
}
/**
 * No sentence in what a surface shows: its sentences sit behind help buttons, in their names. Text a
 * person typed is not copy, a server refusal keeps its sentence, and screen-reader-only text is not shown.
 */
export function expectNoSentence(container: HTMLElement) {
  const shown = container.cloneNode(true) as HTMLElement
  for (const own of shown.querySelectorAll('textarea, [role="alert"], .sr-only')) own.remove()
  // A word, then a full stop that ends it: "kept." at the end, and "kept.Next", where the next element's
  // text follows with no space. Never "example.com": a lowercase letter or a digit after the stop is one word.
  expect(shown.textContent).not.toMatch(/[a-z]{2}\.(?![a-z0-9])/)
}

export const removalDiff = { added: [], removed: [{ queryId: 'query-acme', queryText: 'Acme pricing', assignmentCount: 1 }], reused: [], unchanged: [], noOp: false }
// One node asked on three engines is three provider calls, so an answer number read from the node counts would show.
export const removalWorkload = { existingNodes: 2, existingProviderCalls: 6, nextSweepNodes: 1, nextSweepProviderCalls: 3, addedNodes: 0, addedProviderCalls: 0, removedNodes: 1, removedProviderCalls: 3 }
// The preview's `tracked` is the post-change state, so a whole-query removal drops the row.
export const trackedAfterRemoval = workspace().tracked.filter(row => row.queryId !== 'query-acme')

/**
 * Opens the review of a removal on an Advanced project: Stop tracking in the row's menu, then Review in
 * its sheet. With a Place selected the sheet stops the query there only, where it is asked elsewhere too.
 * query-tracking-simple keeps its own steps.
 */
export async function reviewRemoval() {
  const sheet = await openRowSheet('Acme pricing', 'Stop tracking')
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  return screen.findByRole('heading', { name: /^(Confirm tracked query changes|Review \d+ changes?|No tracking changes)$/ })
}

/** The advanced review's number grid, as label and value pairs. */
export function reviewNumbers() {
  const grid = screen.getByText('Queries', { selector: 'dt' }).closest('dl')!
  return Object.fromEntries(within(grid).getAllByRole('term').map(term => [term.textContent, term.nextElementSibling?.textContent]))
}

/**
 * One row of an advanced review table, by its query, read by column header. `subject` is undefined when
 * the table has no Subject column, and `searchLocation` when every row shares one value, which
 * `sharedSearchLocation` reads. A table with both a Subject and a search location column has one
 * "Subject and type" column: the Subject on its first line and the Type on its second.
 * `row` holds the button that lists the query's locations in the row under it.
 */
export function reviewRow(queryText: string, table = 'Changes') {
  const element = screen.getByRole('table', { name: table })
  const row = within(element).getByText(queryText).closest('tr')!
  const headers = within(element).getAllByRole('columnheader').map(header => header.textContent)
  const cell = (header: string) => headers.includes(header) ? row.cells[headers.indexOf(header)]!.textContent : undefined
  const stacked = headers.includes('Subject and type') ? [...row.cells[headers.indexOf('Subject and type')]!.children].map(line => line.textContent) : null
  if (stacked) expect(stacked).toHaveLength(2)
  return { row, change: cell('Change'), subject: stacked ? stacked[0] : cell('Subject'), type: stacked ? stacked[1] : cell('Type'), assignments: cell('Location links'), searchLocation: cell('Search location and engines') }
}

/**
 * A search location and engines value that is its own help button: it shows `label`, the engines by
 * display name, and its name ends with the caller's words for it, model ids included. Returns those words.
 */
export function searchLocationModels(container: HTMLElement, label: string) {
  const value = within(container).getByRole('button', { name: name => name.startsWith(`${label}. `) })
  expect(value.textContent).toBe(label)
  return value.getAttribute('aria-label')!.slice(label.length + 2)
}

/**
 * The search location and engines every row of a review table shares, said once on the line above the
 * table: the engines by display name, with the model ids behind the value (`models`). A value that
 * already carries the model ids is plain text, and `models` is null. Null when the table keeps the
 * column, or no row names one.
 */
export function sharedSearchLocation(table = 'Changes') {
  const line = screen.getByRole('table', { name: table }).parentElement!.previousElementSibling
  if (!(line instanceof HTMLElement) || line.tagName !== 'DL') return null
  expect(within(line).getByRole('term').textContent).toBe('Search location and engines')
  const value = within(line).getByRole('definition')
  const label = value.textContent
  return { label, models: within(value).queryByRole('button') ? searchLocationModels(value, label) : null }
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
