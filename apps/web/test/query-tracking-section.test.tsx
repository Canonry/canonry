import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { QueriesSection } from '../src/components/project/DiscoverySection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

const workspaceVersion = `qtw_${'a'.repeat(64)}`
const previewToken = `qtp_${'b'.repeat(64)}`
const checksum = 'c'.repeat(64)

const context = {
  providers: ['openai'],
  models: { openai: 'gpt-5' },
  location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
}

const active = { revision: 4, compiledChecksum: checksum }
const selectedContext = { providers: ['openai'], models: { openai: 'gpt-5' }, location: 'New York' }

function workspace() {
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

function preview(overrides: Record<string, unknown> = {}) {
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

function renderWorkspace(props: Partial<React.ComponentProps<typeof QueriesSection>> = {}) {
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
  return all
}

function installWorkspaceApi(
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

function chooseContext(location = 'New York') {
  const control = screen.getByLabelText('Location and engines') as HTMLSelectElement
  const details = control.closest('details')
  if (details && !details.open) fireEvent.click(details.querySelector('summary')!)
  const option = [...control.options].find(candidate => candidate.text.includes(location))
  if (!option) throw new Error(`No ${location} context option was rendered`)
  fireEvent.change(control, { target: { value: option.value } })
}

function installScrollSpy() {
  const scrollIntoView = vi.fn()
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })
  return scrollIntoView
}

test('leaves no audience after the last property is unchecked and requires an explicit whole-site choice', async () => {
  const requests: unknown[] = []
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) {
      requests.push(body)
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'How does Acme compare?' } })
  chooseContext()
  const review = screen.getByRole('button', { name: 'Review changes' })
  expect(review.hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Property' }))
  expect((screen.getByRole('checkbox', { name: 'Whole site' }) as HTMLInputElement).checked).toBe(false)
  expect(screen.getByText('Choose Whole site or at least one property, group, or market.')).toBeTruthy()
  expect(review.hasAttribute('disabled')).toBe(true)
  fireEvent.click(review)
  expect(requests).toEqual([])

  fireEvent.click(screen.getByRole('checkbox', { name: 'Whole site' }))
  expect(review.hasAttribute('disabled')).toBe(false)
  fireEvent.click(review)
  await screen.findByRole('heading', { name: 'Confirm tracked query changes' })
  expect(requests).toEqual([{
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'manual', text: 'How does Acme compare?' }, contexts: [selectedContext] }],
    removals: [],
  }])
})

test('starts with the question, preserves written text across sources, and discloses required measurement options', async () => {
  installWorkspaceApi()
  renderWorkspace()
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  const text = screen.getByLabelText('Question')
  const source = screen.getByLabelText('Query source')
  expect(text.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Write a question' })).toBeTruthy()
  fireEvent.change(text, { target: { value: 'Which platform fits our team?' } })
  fireEvent.change(source, { target: { value: 'research' } })
  fireEvent.change(source, { target: { value: 'manual' } })
  expect((screen.getByLabelText('Question') as HTMLTextAreaElement).value).toBe('Which platform fits our team?')
  const options = screen.getByLabelText('Classification').closest('details')!
  expect(options).not.toBeNull()
  expect(options.open).toBe(false)
  expect(screen.getByText('Choose location and engines (required)', { selector: 'summary' })).toBeTruthy()
  expect(screen.getByLabelText('Location and engines').closest('details')).toBe(options)
  chooseContext()
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(false)
})

test('distinguishes this property from shared assignments and deduplicates group and market names', async () => {
  const data = workspace()
  data.targets.push({ stableKey: 'beta', label: 'Beta' })
  data.groups[0]!.label = 'Metro Alpha'
  data.markets[0]!.label = 'Metro Alpha'
  data.tracked[0]!.assignments.push({ ...data.tracked[0]!.assignments[0]!, targetKey: 'beta' })
  installWorkspaceApi(undefined, [], data)
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  const shared = (await screen.findByText('Acme pricing')).closest('tr')!
  expect(within(shared).getByText('This property · Shared with 1 other property · Metro Alpha (group and market)')).toBeTruthy()
  const direct = screen.getByText('Best AEO platform').closest('tr')!
  expect(within(direct).getByText('This property only')).toBeTruthy()
  fireEvent.click(screen.getByText('Acme', { selector: 'summary' }))
  expect(screen.getByText('Group: properties grouped together. Market: search context.')).toBeTruthy()
})

test('focuses the preview outcome and keeps request counts in a secondary disclosure', async () => {
  const scrollIntoView = installScrollSpy()
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({
      diff: { added: [], removed: [{ queryId: 'query-acme', queryText: 'Acme pricing', assignmentCount: 1 }], reused: [], unchanged: [], noOp: false },
    }))
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Remove Acme pricing' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  const heading = await screen.findByRole('heading', { name: 'Confirm tracked query changes' })
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  expect(screen.getByText('Changes apply to future sweeps. Earlier results stay unchanged.')).toBeTruthy()
  const workload = screen.getByText('Next sweep workload', { selector: 'summary' }).closest('details')!
  expect(workload.open).toBe(false)
  expect(workload.textContent).toContain('3 provider requests')
})

test('clears the previous confirmation while a changed draft awaits a new preview', async () => {
  let requests = 0
  let finishPreview: ((response: Response) => void) | undefined
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) {
      requests += 1
      if (requests === 1) return jsonResponse(preview())
      return new Promise<Response>(resolve => { finishPreview = resolve })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'New question' } })
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByRole('heading', { name: 'Confirm tracked query changes' })

  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Acme pricing' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await waitFor(() => expect(finishPreview).toBeTypeOf('function'))
  expect(screen.queryByRole('button', { name: 'Confirm changes' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Confirm tracked query changes' })).toBeNull()

  finishPreview!(jsonResponse(preview({ diff: { added: [], removed: [], reused: [], unchanged: [], noOp: true } })))
  const noOp = await screen.findByRole('heading', { name: 'No tracking changes' })
  expect(document.activeElement).toBe(noOp)
  expect(screen.getByRole('button', { name: 'Confirm changes' }).hasAttribute('disabled')).toBe(true)
})

test('renders a searchable tracked table and delegates URL-owned workspace and scope selection', async () => {
  installWorkspaceApi()
  const props = renderWorkspace()

  expect(await screen.findByRole('heading', { name: 'Queries' })).toBeTruthy()
  expect(await screen.findByText('Acme pricing')).toBeTruthy()
  expect(screen.getByText('Best AEO platform')).toBeTruthy()
  expect(screen.queryByText('Measurement setup')).toBeNull()
  expect(screen.queryByText('Tracked basket')).toBeNull()
  expect(screen.queryByText('Versioned query assignments')).toBeNull()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter tracked queries' }), { target: { value: 'pricing' } })
  expect(screen.getByText('Acme pricing')).toBeTruthy()
  expect(screen.queryByText('Best AEO platform')).toBeNull()

  fireEvent.click(screen.getByText('Whole site', { selector: 'summary' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: 'New York' } })
  fireEvent.click(screen.getByRole('button', { name: 'New York, Market' }))
  expect(props.onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'market', measurementScopeKey: 'new-york' })

  fireEvent.click(screen.getByRole('tab', { name: 'Research' }))
  expect(props.onQueryWorkspaceChange).toHaveBeenCalledWith('research')
})

test('lets measurement and action columns size to their contents inside the scrollable tracked table', async () => {
  installWorkspaceApi()
  renderWorkspace()

  await screen.findByText('Acme pricing')
  const table = screen.getByRole('table')
  expect(table.classList.contains('table-auto')).toBe(true)
  expect(table.classList.contains('measurement-responsive-table')).toBe(true)
  expect(table.classList.contains('table-fixed')).toBe(false)
  expect(table.querySelector('colgroup')).toBeNull()
  expect(table.parentElement?.classList.contains('overflow-x-auto')).toBe(true)

  for (const row of workspace().tracked) {
    const edit = screen.getByRole('button', { name: `Edit ${row.queryText}` })
    const remove = screen.getByRole('button', { name: `Remove ${row.queryText}` })
    const actionCell = edit.closest('td')!
    const measurementCell = actionCell.previousElementSibling!
    expect(remove.closest('td')).toBe(actionCell)
    expect(actionCell.classList.contains('whitespace-nowrap')).toBe(true)
    expect(actionCell.classList.contains('measurement-table-actions')).toBe(true)
    expect(measurementCell.classList.contains('whitespace-nowrap')).toBe(true)
    expect(edit.parentElement?.classList.contains('min-w-max')).toBe(true)
    expect(measurementCell.textContent).toBe(row.state === 'tracked' ? 'Measured' : 'Awaiting sweep')
  }
})

test('floats the tracked scope picker above the table and closes on Escape or outside interaction', async () => {
  installWorkspaceApi()
  renderWorkspace()

  await screen.findByText('Acme pricing')
  const trigger = screen.getByText('Whole site', { selector: 'summary' })
  const details = trigger.closest('details')!
  fireEvent.click(trigger)
  expect(details.open).toBe(true)

  const search = screen.getByRole('searchbox', { name: 'Search scopes' })
  const popup = search.closest('.visibility-scope-menu')
  expect(details.classList.contains('relative')).toBe(true)
  expect(popup?.parentElement).toBe(details)

  search.focus()
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)

  fireEvent.click(trigger)
  expect(details.open).toBe(true)
  fireEvent.pointerDown(search)
  expect(details.open).toBe(true)
  const querySearch = screen.getByRole('searchbox', { name: 'Filter tracked queries' })
  querySearch.focus()
  fireEvent.pointerDown(querySearch)
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(querySearch)
})

test('returns focus to the tracked scope trigger after selecting a filtered scope', async () => {
  installWorkspaceApi()
  const props = renderWorkspace()

  await screen.findByText('Acme pricing')
  const trigger = screen.getByText('Whole site', { selector: 'summary' })
  const details = trigger.closest('details')!
  fireEvent.click(trigger)
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: 'North East' } })
  expect(screen.queryByRole('button', { name: 'New York, Market' })).toBeNull()
  const option = screen.getByRole('button', { name: 'North East, Group' })
  option.focus()
  fireEvent.click(option)

  expect(props.onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'group', measurementScopeKey: 'north-east' })
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)
})

test('searches large scopes and keeps multi-property assignments compact in the table', async () => {
  const scaled = workspace()
  scaled.targets = Array.from({ length: 225 }, (_, index) => ({ stableKey: `property-${index}`, label: `Property ${index}` }))
  scaled.groups = [{ stableKey: 'metro-alpha', label: 'Metro Alpha', targetKeys: scaled.targets.slice(0, 15).map(target => target.stableKey) }]
  scaled.markets = []
  scaled.tracked[0]!.assignments = scaled.targets.slice(0, 15).map(target => ({
    ...scaled.tracked[0]!.assignments[0]!, targetKey: target.stableKey, groupKeys: ['metro-alpha'], marketKeys: [],
  }))
  installWorkspaceApi(undefined, [], scaled)
  const props = renderWorkspace()

  await screen.findByText('Acme pricing')
  expect(screen.getByText('15 properties · Group: Metro Alpha')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Measurement scope' })).toBeNull()
  fireEvent.click(screen.getByText('Whole site', { selector: 'summary' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: 'Property 224' } })
  expect(screen.queryByRole('button', { name: 'Property 223, Property' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Property 224, Property' }))
  expect(props.onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'property', measurementScopeKey: 'property-224' })
})

test('focuses and scrolls an opened assignment editor without hijacking assignment checkbox focus', async () => {
  installWorkspaceApi()
  const scrollIntoView = installScrollSpy()
  renderWorkspace()

  await screen.findByText('Acme pricing')
  const add = screen.getByRole('button', { name: 'Add query' })
  add.focus()
  fireEvent.click(add)

  const heading = await screen.findByRole('heading', { name: 'Add query' })
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' }))
  expect(heading.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(heading)

  const group = screen.getByRole('checkbox', { name: 'North East, Group' })
  group.focus()
  fireEvent.click(group)
  expect(document.activeElement).toBe(group)
})

test('requires a selected context for an advanced addition, then uses the server preview and keeps no-op confirmation disabled', async () => {
  const requests: Array<{ path: string; body: unknown }> = []
  installWorkspaceApi((path, body) => {
    requests.push({ path, body })
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      return jsonResponse(preview({
        diff: { added: [], removed: [], reused: [], unchanged: [{ queryId: 'query-acme', queryText: 'Acme pricing', assignmentCount: 1 }], noOp: true },
        workload: { existingNodes: 2, existingProviderCalls: 2, nextSweepNodes: 2, nextSweepProviderCalls: 2, addedNodes: 0, addedProviderCalls: 0, removedNodes: 0, removedProviderCalls: 0 },
      }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Acme pricing' } })
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('No tracking changes')
  expect(screen.getByRole('button', { name: 'Confirm changes' }).hasAttribute('disabled')).toBe(true)
  const unchanged = screen.getByText('1 unchanged query').closest('details')
  expect(unchanged?.open).toBe(false)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toEqual({
    path: '/api/v1/projects/demo/query-tracking/preview',
    body: {
      expectedWorkspaceVersion: workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'Acme pricing' }, contexts: [selectedContext] }],
      removals: [],
    },
  })
})

test('sends one explicitly selected context for a new advanced group assignment', async () => {
  let previewBody: Record<string, unknown> | undefined
  const contexts = [
    context,
    { ...context, location: { label: 'Chicago', city: 'Chicago', region: 'IL', country: 'US' } },
  ]
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview({
        diff: { added: [{ queryId: 'query-new-group', queryText: 'New group query', assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false },
        tracked: [{
          queryId: 'query-new-group', queryText: 'New group query', normalizedText: 'new group query',
          provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:15:00.000Z' },
          state: 'awaiting-sweep', lastMeasuredAt: null,
          assignments: [{ targetKey: 'acme', groupKeys: ['north-east'], marketKeys: [], queryClass: 'non-brand', classificationSource: 'server', contexts: [context] }],
        }],
      }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], { ...workspace(), defaultContexts: contexts })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'New group query' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /^North East/ }))
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
  chooseContext('New York')
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(screen.getByText('Acme · Group: North East · New York · openai (gpt-5)')).toBeTruthy()
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: { source: 'manual', text: 'New group query' },
      audience: { groupKeys: ['north-east'] },
      contexts: [selectedContext],
    }],
    removals: [],
  })
})

test('requires an explicit context when a market is combined with a group', async () => {
  let previewBody: Record<string, unknown> | undefined
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Mixed scope query' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'New York, Market' }))
  expect(screen.queryByLabelText('Location and engines')).toBeNull()
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(false)

  fireEvent.click(screen.getByRole('checkbox', { name: 'North East, Group' }))
  expect(screen.getByLabelText('Location and engines')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: { source: 'manual', text: 'Mixed scope query' },
      audience: { groupKeys: ['north-east'], marketKeys: ['new-york'] },
      contexts: [selectedContext],
    }],
    removals: [],
  })
}, 10_000)

test('requires a preview before removing a named tracked query and commits its exact review token', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  installWorkspaceApi((path, body) => {
    requests.push({ path, body: body as Record<string, unknown> })
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      return jsonResponse(preview({
        diff: { added: [], removed: [{ queryId: 'query-acme', queryText: 'Acme pricing', assignmentCount: 1 }], reused: [], unchanged: [], noOp: false },
        workload: { existingNodes: 2, existingProviderCalls: 2, nextSweepNodes: 1, nextSweepProviderCalls: 1, addedNodes: 0, addedProviderCalls: 0, removedNodes: 1, removedProviderCalls: 1 },
      }))
    }
    if (path === '/api/v1/projects/demo/query-tracking/commit') {
      return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, reviewedAt: '2026-09-04T12:15:00.000Z', active, diff: preview().diff, workload: preview().workload })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Remove Acme pricing' }))
  expect(screen.getByText('Remove “Acme pricing” from future tracking?')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('1 removed')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm changes' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[0].body).toEqual({ expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [{ queryId: 'query-acme' }] })
  expect(requests[1].body).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [],
    removals: [{ queryId: 'query-acme' }],
    previewToken,
    reviewedAt: '2026-09-04T12:15:00.000Z',
  })
})

test('keeps removal open when the parent reflects the selected query through URL state', async () => {
  installWorkspaceApi()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function RoutedWorkspace() {
    const [trackingQueryId, setTrackingQueryId] = React.useState<string>()
    return <QueriesSection projectName="demo" trackingQueryId={trackingQueryId} onTrackingQueryIdChange={setTrackingQueryId} />
  }
  render(<QueryClientProvider client={queryClient}><RoutedWorkspace /></QueryClientProvider>)

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Remove Acme pricing' }))
  expect(await screen.findByRole('heading', { name: 'Remove query' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Edit query' })).toBeNull()
})

test('describes removed assignments without attributing the retained Property to the removal', async () => {
  const shared = workspace()
  const retained = { ...shared.tracked[0]!.assignments[0]!, targetKey: 'beta', groupKeys: [], marketKeys: [] }
  shared.targets.push({ stableKey: 'beta', label: 'Beta' })
  shared.tracked[0]!.assignments.push(retained)
  installWorkspaceApi((path) => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({
      tracked: [{ ...shared.tracked[0], assignments: [retained] }],
      diff: { added: [], removed: [{ queryId: 'query-acme', queryText: 'Acme pricing', assignmentCount: 1 }], reused: [], unchanged: [], noOp: false },
    }))
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], shared)
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Remove Acme pricing' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  const removed = await screen.findByRole('region', { name: 'Removed queries' })
  expect(within(removed).getByText('1 assignment removed')).toBeTruthy()
  expect(removed.textContent).not.toContain('Beta')
})

test.each([
  { measurementScope: 'property' as const, measurementScopeKey: 'acme', audience: { targetKeys: ['acme'] } },
  { measurementScope: 'group' as const, measurementScopeKey: 'north-east', audience: { groupKeys: ['north-east'] } },
  { measurementScope: 'market' as const, measurementScopeKey: 'new-york', audience: { marketKeys: ['new-york'] } },
])('removes only the selected $measurementScope audience of a shared query', async ({ measurementScope, measurementScopeKey, audience }) => {
  let previewBody: unknown
  const shared = workspace()
  shared.targets.push({ stableKey: 'beta', label: 'Beta' })
  shared.tracked[0]!.assignments.push({
    targetKey: 'beta', groupKeys: [], marketKeys: [], queryClass: 'non-brand', classificationSource: 'operator',
    contexts: [{ ...context, location: { label: 'Chicago', city: 'Chicago', region: 'IL', country: 'US' } }],
  })
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) {
      previewBody = body
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], shared)
  renderWorkspace({ selection: { measurementScope, measurementScopeKey, queryClass: 'all' } })

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Remove Acme pricing' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({ expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [{ queryId: 'query-acme', audience }] })
})

test.each([
  { measurementScope: 'project' as const, measurementScopeKey: undefined, audience: undefined },
  { measurementScope: 'property' as const, measurementScopeKey: 'acme', audience: { targetKeys: ['acme'] } },
  { measurementScope: 'group' as const, measurementScopeKey: 'north-east', audience: { groupKeys: ['north-east'] } },
  { measurementScope: 'market' as const, measurementScopeKey: 'new-york', audience: { marketKeys: ['new-york'] } },
])('edits shared query text within $measurementScope without reconstructing its classes or contexts', async ({ measurementScope, measurementScopeKey, audience }) => {
  let previewBody: unknown
  const shared = workspace()
  shared.targets.push({ stableKey: 'beta', label: 'Beta' })
  shared.tracked[0]!.assignments.push({
    targetKey: 'beta', groupKeys: [], marketKeys: [], queryClass: 'non-brand', classificationSource: 'operator',
    contexts: [{ ...context, location: { label: 'Chicago', city: 'Chicago', region: 'IL', country: 'US' } }],
  })
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) {
      previewBody = body
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], shared)
  renderWorkspace({ selection: { measurementScope, measurementScopeKey, queryClass: 'all' } })

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Acme pricing' }))
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'Acme fees' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [],
    edits: [{ queryId: 'query-acme', ...(audience ? { audience } : {}), text: 'Acme fees' }],
  })
  expect(screen.queryByLabelText('Query source')).toBeNull()
  expect(screen.queryByLabelText('Location and engines')).toBeNull()
  expect(screen.queryByRole('checkbox', { name: 'Beta, Property' })).toBeNull()
  expect(screen.getByText('Existing locations and engines are preserved. Use Add query to create assignments in another scope.')).toBeTruthy()
})

test('reviews an untouched multi-property edit as a no-op without rewriting classifications', async () => {
  let previewBody: unknown
  const shared = workspace()
  shared.targets.push({ stableKey: 'beta', label: 'Beta' })
  shared.tracked[0]!.assignments.push({
    targetKey: 'beta', groupKeys: [], marketKeys: [], queryClass: 'non-brand', classificationSource: 'operator',
    contexts: [{ ...context, location: { label: 'Chicago', city: 'Chicago', region: 'IL', country: 'US' } }],
  })
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) {
      previewBody = body
      return jsonResponse(preview({ diff: { added: [], removed: [], reused: [], unchanged: [], noOp: true } }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], shared)
  renderWorkspace()
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Acme pricing' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('No tracking changes')
  expect(previewBody).toEqual({ expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [], edits: [{ queryId: 'query-acme', text: 'Acme pricing' }] })
  expect(screen.getByRole('button', { name: 'Confirm changes' }).hasAttribute('disabled')).toBe(true)
})

test('sends an automatic classification edit only after an explicit operator choice', async () => {
  let previewBody: unknown
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) {
      previewBody = body
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Acme pricing' }))
  fireEvent.change(screen.getByLabelText('Classification'), { target: { value: 'auto' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [],
    edits: [{ queryId: 'query-acme', audience: { targetKeys: ['acme'] }, text: 'Acme pricing', queryClass: null }],
  })
})

test.each(['simple', 'advanced'])('commits a resolved template query edit in %s mode without expanding its source', async (mode) => {
  const requests: Array<{ path: string; body: unknown }> = []
  const saved = workspace()
  installWorkspaceApi((path, body) => {
    requests.push({ path, body })
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ mode }))
    if (path.endsWith('/query-tracking/commit')) return jsonResponse({ committed: true, mode, workspaceVersion, reviewedAt: '2026-09-04T12:15:00.000Z', active, diff: preview().diff, workload: preview().workload })
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], {
    ...saved, mode,
    tracked: [{
      ...saved.tracked[0],
      provenance: {
        source: 'template', sourceId: 'template-1', capturedAt: '2026-09-04T12:00:00.000Z',
        template: { templateId: 'template-1', templateVersion: 'v1', template: '{property} pricing', variables: { property: 'Acme' }, output: 'Acme pricing' },
      },
    }],
  })
  renderWorkspace()
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Acme pricing' }))
  expect((screen.getByLabelText('Query text') as HTMLTextAreaElement).value).toBe('Acme pricing')
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'Acme fees' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('Confirm tracked query changes')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm changes' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toEqual({
    path: '/api/v1/projects/demo/query-tracking/commit',
    body: {
      expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'query-acme', text: 'Acme fees' }],
      previewToken, reviewedAt: '2026-09-04T12:15:00.000Z',
    },
  })
})

test('promotes a saved research query as source provenance, never an answer or a sweep request', async () => {
  let previewBody: Record<string, unknown> | undefined
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview({
        diff: { added: [{ queryId: 'query-research', queryText: 'How do teams compare AEO platforms?', assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false },
      }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'research' } })
  fireEvent.change(screen.getByLabelText('Saved research query'), { target: { value: 'research-query-1' } })
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('1 added')
  expect(screen.getByText('Only the saved query is added.')).toBeTruthy()
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'research', researchRunQueryId: 'research-query-1' }, contexts: [selectedContext] }],
    removals: [],
  })
})

test.each(['research', 'discovery'] as const)('tracks a selected saved %s result through Research navigation, assignment, review, and confirmation', async (source) => {
  const writes: Array<{ path: string; body: unknown }> = []
  const data = workspace()
  const queryText = source === 'research' ? 'How do teams compare AEO platforms?' : 'What does Acme cost?'
  const sourceInput = source === 'research'
    ? { source, researchRunQueryId: 'research-query-1' }
    : { source, discoveryProbeId: 'discovery-probe-1' }
  const added = {
    ...data.tracked[1]!, queryId: 'query-promoted', queryText, normalizedText: queryText.toLowerCase(),
    provenance: { source, sourceId: source === 'research' ? 'research-query-1' : 'discovery-probe-1', capturedAt: '2026-09-04T12:00:00.000Z' },
    assignments: [{ ...data.tracked[1]!.assignments[0]!, groupKeys: ['north-east'] }],
  }
  const reviewed = preview({
    tracked: [...data.tracked, added],
    diff: { added: [{ queryId: added.queryId, queryText, assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false },
  })
  const run = {
    id: 'research-run-1', projectId: 'project-demo', status: 'completed', provider: 'openai', requestedModel: 'gpt-5', resolvedModel: 'gpt-5',
    location: context.location, totalQueries: 2, completedQueries: 2, failedQueries: 0, error: null,
    startedAt: '2026-09-04T10:00:00.000Z', finishedAt: '2026-09-04T10:01:00.000Z', createdAt: '2026-09-04T10:00:00.000Z',
  }
  const researchQuery = (id: string, text: string) => ({
    id, query: text, position: 0, status: 'completed', requestedModel: 'gpt-5', resolvedModel: 'gpt-5', servedModel: 'gpt-5',
    answerText: `Saved answer for ${text}`, groundingSources: [{ uri: 'https://rival.example/source', title: 'Saved research source' }],
    citedDomains: ['rival.example'], searchQueries: [], namedCompetitors: ['Rival'], citedCompetitorDomains: ['rival.example'],
    answerMentioned: false, citationState: 'not-cited', error: null,
    startedAt: run.startedAt, finishedAt: run.finishedAt, createdAt: run.createdAt,
  })
  const session = {
    id: 'discovery-session-1', projectId: 'project-demo', status: 'completed', icpDescription: 'Operators comparing AEO services',
    probeCount: 2, citedCount: 1, aspirationalCount: 1, wastedCount: 0, competitorMap: [{ domain: 'rival.example', hits: 2 }],
    createdAt: '2026-09-04T10:00:00.000Z',
  }
  installWorkspaceApi((path, body, method) => {
    if (method !== 'GET') writes.push({ path, body })
    if (path === '/api/v1/projects/demo/discover/sessions' && method === 'GET') return jsonResponse(source === 'discovery' ? [session] : [])
    if (path === '/api/v1/projects/demo/discover/sessions/discovery-session-1' && method === 'GET') {
      return jsonResponse({ ...session, probes: [
        { id: 'discovery-other', sessionId: session.id, projectId: session.projectId, query: 'Another discovery question', bucket: 'cited', citationState: 'cited', citedDomains: ['demo.example'], answerMentioned: true, createdAt: session.createdAt },
        { id: 'discovery-probe-1', sessionId: session.id, projectId: session.projectId, query: queryText, bucket: 'aspirational', citationState: 'not-cited', citedDomains: ['rival.example'], answerMentioned: false, createdAt: session.createdAt },
      ] })
    }
    if (path === '/api/v1/projects/demo/research/runs' && method === 'GET') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/research-run-1' && method === 'GET') {
      return jsonResponse({ ...run, queries: [researchQuery('research-other', 'Another research question'), researchQuery('research-query-1', queryText)] })
    }
    if (path === '/api/v1/projects/demo' && method === 'GET') return jsonResponse({ name: 'demo', locations: [context.location] })
    if (path === '/api/v1/settings' && method === 'GET') return jsonResponse({ providers: [], providerCatalog: [] })
    if (path === '/api/v1/projects/demo/query-tracking/preview' && method === 'POST') return jsonResponse(reviewed)
    if (path === '/api/v1/projects/demo/query-tracking/commit' && method === 'POST') {
      data.tracked.push(added)
      return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, reviewedAt: reviewed.reviewedAt, active, diff: reviewed.diff, workload: reviewed.workload })
    }
    throw new Error(`Unexpected ${method}: ${path}`)
  }, [], data)
  renderWorkspace({ queryWorkspace: undefined, researchMode: undefined })

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('tab', { name: 'Research', exact: true }))
  if (source === 'research') {
    fireEvent.click(screen.getByRole('tab', { name: 'Test queries' }))
    fireEvent.click(await screen.findByRole('button', { name: queryText }))
    expect(await screen.findByText(`Saved answer for ${queryText}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review for tracking' }))
  } else {
    expect(screen.getByRole('tab', { name: 'Find queries', exact: true }).getAttribute('aria-selected')).toBe('true')
    const result = await screen.findByText(queryText)
    fireEvent.click(within(result.closest('tr')!).getByRole('button', { name: 'Review for tracking' }))
  }

  expect(await screen.findByRole('heading', { name: 'Add query' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'Tracked' }).getAttribute('aria-selected')).toBe('true')
  expect((screen.getByLabelText(source === 'research' ? 'Saved research query' : 'Discovery query') as HTMLSelectElement).value).toBe(source === 'research' ? 'research-query-1' : 'discovery-probe-1')
  fireEvent.click(screen.getByRole('checkbox', { name: 'North East, Group' }))
  chooseContext()
  expect(writes).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('1 added')
  expect(writes).toEqual([{
    path: '/api/v1/projects/demo/query-tracking/preview',
    body: { expectedWorkspaceVersion: workspaceVersion, additions: [{ input: sourceInput, audience: { groupKeys: ['north-east'] }, contexts: [selectedContext] }], removals: [] },
  }])
  fireEvent.click(screen.getByRole('button', { name: 'Confirm changes' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(writes[1]).toEqual({
    path: '/api/v1/projects/demo/query-tracking/commit',
    body: { ...(writes[0]!.body as Record<string, unknown>), previewToken, reviewedAt: reviewed.reviewedAt },
  })
  const trackedRow = await screen.findByText(queryText, { selector: 'td' })
  expect(trackedRow.closest('tr')?.textContent).toContain('Awaiting sweep')
}, 15_000)

test('sends an explicit class only when the operator overrides server classification', async () => {
  let previewBody: Record<string, unknown> | undefined
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Enterprise AEO platform' } })
  fireEvent.change(screen.getByLabelText('Classification'), { target: { value: 'non-brand' } })
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'manual', text: 'Enterprise AEO platform' }, contexts: [selectedContext], queryClass: 'non-brand' }],
    removals: [],
  })
})

test('requires a market for a saved market template before sending its identity and pattern for expansion', async () => {
  let previewBody: Record<string, unknown> | undefined
  const template = {
    id: 'template-market', projectId: 'project-demo', name: 'Market comparison', description: null,
    pattern: 'Best {property} provider in {market}', variables: ['property', 'market'],
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-04T12:00:00.000Z',
  }
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [template])
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'template' } })
  fireEvent.change(screen.getByLabelText('Saved template'), { target: { value: 'template-market' } })
  chooseContext()
  const review = screen.getByRole('button', { name: 'Review changes' })
  expect(review.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('Choose a Market under Apply to for this template. A location alone does not select a market.')).toBeTruthy()
  fireEvent.click(review)
  expect(previewBody).toBeUndefined()

  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'manual' } })
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'How does Acme compare?' } })
  expect(review.hasAttribute('disabled')).toBe(false)
  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'template' } })
  expect(review.hasAttribute('disabled')).toBe(true)

  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Property' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'New York, Market' }))
  expect(review.hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: {
        source: 'template', templateId: 'template-market', templateVersion: '2026-09-04T12:00:00.000Z',
        template: 'Best {property} provider in {market}',
      },
      audience: { targetKeys: ['acme'], marketKeys: ['new-york'] },
      contexts: [selectedContext],
    }],
    removals: [],
  })
})

test('keeps simple measurements classifier-only and never submits an operator override', async () => {
  let previewBody: Record<string, unknown> | undefined
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview({ mode: 'simple' }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], { ...workspace(), mode: 'simple' })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  expect(screen.queryByLabelText('Classification')).toBeNull()
  expect(screen.queryByLabelText('Location and engines')).toBeNull()
  expect(screen.getByText('Automatic')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'How does Acme compare?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'manual', text: 'How does Acme compare?' } }],
    removals: [],
  })
})
