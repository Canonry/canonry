import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  onRequest?: (path: string, body: unknown) => Response,
  templates: unknown[] = [],
  workspaceResponse = workspace(),
) {
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/projects/demo/query-tracking' && method === 'GET') return jsonResponse(workspaceResponse)
    if (path === '/api/v1/projects/demo/measurement-query-templates' && method === 'GET') return jsonResponse({ templates })
    if (onRequest) return onRequest(path, init?.body ? JSON.parse(String(init.body)) : undefined)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
}

function chooseContext(location = 'New York') {
  const control = screen.getByLabelText('Location and engines') as HTMLSelectElement
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
  expect(screen.getByText('15 properties · Metro Alpha')).toBeTruthy()
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
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'Acme pricing' } })
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
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'New group query' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /^North East/ }))
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
  chooseContext('New York')
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(screen.getByText('Acme · North East · New York · openai (gpt-5)')).toBeTruthy()
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
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'Mixed scope query' } })
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
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'Enterprise AEO platform' } })
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

test('sends a saved template id, version, and pattern for server-side expansion', async () => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: {
        source: 'template', templateId: 'template-market', templateVersion: '2026-09-04T12:00:00.000Z',
        template: 'Best {property} provider in {market}',
      },
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
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'How does Acme compare?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'manual', text: 'How does Acme compare?' } }],
    removals: [],
  })
})
