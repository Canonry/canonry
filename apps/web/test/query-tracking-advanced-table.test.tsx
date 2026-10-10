import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { getApiV1ProjectsByNameQueryTrackingQueryKey } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../src/api.js'
import { QueriesSection } from '../src/components/project/DiscoverySection.js'
import { jsonResponse } from './mock-fetch.js'
import {
  active, context, expectNoSentence, installWorkspaceApi, noteButton, preview, previewToken, renderViewerWorkspace, renderWorkspace, workspace, workspaceVersion,
} from './support/query-tracking-fixtures.js'

// The tracked table of an Advanced project: its labels, filters and recovery, and the Edit and Remove row buttons.

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

test('omits the Research workspace for a viewer when paid research is not enabled', async () => {
  installWorkspaceApi()
  renderViewerWorkspace()

  await screen.findByText('Acme pricing')
  expect(screen.queryByRole('tab', { name: 'Research' })).toBeNull()
})

test.each(['group', 'market'] as const)('keeps the selected %s kind in the removal caption and leaves the scope picker to the context row', async kind => {
  const data = workspace()
  data.groups[0]!.label = 'Metro Beta'
  data.markets[0]!.label = 'Metro Beta'
  installWorkspaceApi(undefined, [], data)
  renderWorkspace({ selection: { measurementScope: kind, measurementScopeKey: kind === 'group' ? 'north-east' : 'new-york', queryClass: 'all' } })
  await screen.findByText('Acme pricing')
  const kindLabel = kind === 'group' ? 'Group' : 'Market'
  expect(document.querySelector('.visibility-scope-trigger')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Remove Acme pricing' }))
  // Where the removal applies is a label and its value. That past answers stay is a short note with the sentence behind it.
  const form = screen.getByRole('heading', { name: 'Remove query' }).closest('.surface-card') as HTMLElement
  expect(within(form).getByText('Applies to', { selector: 'dt' }).nextElementSibling?.textContent).toBe(`Only Metro Beta · ${kindLabel}`)
  noteButton('Past answers kept', 'Removal applies to future sweeps. Earlier results stay unchanged.', form)
  expectNoSentence(form)
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
})

test('shows only in-group properties and relationships for a shared query', async () => {
  const data = workspace()
  data.targets = [
    { stableKey: 'acme', label: 'Acme' },
    { stableKey: 'beta', label: 'Beta' },
    { stableKey: 'gamma', label: 'Gamma' },
    { stableKey: 'delta', label: 'Delta' },
  ]
  data.groups = [
    { stableKey: 'uptown', label: 'Uptown', targetKeys: ['acme', 'beta', 'gamma'] },
    { stableKey: 'downtown', label: 'Downtown', targetKeys: ['acme', 'delta'] },
  ]
  data.tracked[0]!.assignments = [
    { ...data.tracked[0]!.assignments[0]!, targetKey: 'acme', groupKeys: ['uptown', 'downtown'], marketKeys: [] },
    { ...data.tracked[0]!.assignments[0]!, targetKey: 'beta', groupKeys: ['uptown'], marketKeys: [] },
    { ...data.tracked[0]!.assignments[0]!, targetKey: 'gamma', groupKeys: ['uptown'], marketKeys: [] },
    { ...data.tracked[0]!.assignments[0]!, targetKey: 'delta', groupKeys: ['downtown'], marketKeys: [] },
  ]
  installWorkspaceApi(undefined, [], data)
  renderWorkspace({ selection: { measurementScope: 'group', measurementScopeKey: 'uptown', queryClass: 'all' } })

  const row = (await screen.findByText('Acme pricing')).closest('tr')!
  const scope = within(row).getByText('3 properties in this group · Shared with 1 other property')
  expect(screen.getByText('Queries belong to properties, so a shared query can also cover other groups.')).toBeTruthy()
  fireEvent.click(scope)
  expect(within(row).getByText('Acme · Groups: Uptown')).toBeTruthy()
  expect(within(row).getByText('Beta · Groups: Uptown')).toBeTruthy()
  expect(within(row).getByText('Gamma · Groups: Uptown')).toBeTruthy()
  expect(within(row).queryByText(/Delta/)).toBeNull()
  expect(within(row).queryByText(/Downtown/)).toBeNull()
})

test('renders a searchable tracked table, delegates the URL-owned workspace, and leaves scope to the context row', async () => {
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

  expect(document.querySelector('.visibility-scope-trigger')).toBeNull()
  expect(screen.queryByRole('searchbox', { name: 'Search places' })).toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Research' }))
  expect(props.onQueryWorkspaceChange).toHaveBeenCalledWith('research')
})

test('filters tracked queries by the URL-owned query type and exposes each assignment relationship', async () => {
  installWorkspaceApi()
  const props = renderWorkspace({ selection: { measurementScope: 'project', queryClass: 'branded' } })

  await screen.findByText('Acme pricing')
  expect(screen.queryByText('Best AEO platform')).toBeNull()
  expect(screen.getByText('1 saved query record in this view. Each record can have more than one property, group, or market assignment.')).toBeTruthy()

  const queryType = screen.getByRole('combobox', { name: 'Query type' })
  expect(queryType).toHaveProperty('value', 'branded')
  expect(within(queryType).getByRole('option', { name: 'All query types' })).toBeTruthy()
  expect(within(queryType).getByRole('option', { name: 'Non-brand' })).toBeTruthy()
  expect(within(queryType).getByRole('option', { name: 'Branded' })).toBeTruthy()
  expect(within(queryType).getByRole('option', { name: 'Unclassified' })).toBeTruthy()

  fireEvent.change(queryType, { target: { value: 'non-brand' } })
  expect(props.onSelectionChange).toHaveBeenCalledWith({ queryClass: 'non-brand' })

  const row = screen.getByText('Acme pricing').closest('tr')!
  const scope = within(row).getByText('Acme · Group: North East · Market: New York')
  fireEvent.click(scope)
  expect(within(row).getByText('Assigned relationships')).toBeTruthy()
  expect(within(row).getByText('Acme · Groups: North East · Markets: New York')).toBeTruthy()
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

test('keeps multi-property assignments compact in a large tracked table without a body scope picker', async () => {
  const scaled = workspace()
  scaled.targets = Array.from({ length: 225 }, (_, index) => ({ stableKey: `property-${index}`, label: `Property ${index}` }))
  scaled.groups = [{ stableKey: 'metro-alpha', label: 'Metro Alpha', targetKeys: scaled.targets.slice(0, 15).map(target => target.stableKey) }]
  scaled.markets = []
  scaled.tracked[0]!.assignments = scaled.targets.slice(0, 15).map(target => ({
    ...scaled.tracked[0]!.assignments[0]!, targetKey: target.stableKey, groupKeys: ['metro-alpha'], marketKeys: [],
  }))
  installWorkspaceApi(undefined, [], scaled)
  renderWorkspace()

  await screen.findByText('Acme pricing')
  expect(screen.getByText('15 properties · Group: Metro Alpha')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Place' })).toBeNull()
  expect(document.querySelector('.visibility-scope-trigger')).toBeNull()
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
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Acme fees' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('Review tracking changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [],
    edits: [{ queryId: 'query-acme', ...(audience ? { audience } : {}), text: 'Acme fees' }],
  })
  expect(screen.queryByLabelText('Query source')).toBeNull()
  expect(screen.queryByLabelText('Search location and engines')).toBeNull()
  expect(screen.queryByRole('checkbox', { name: 'Beta, Location' })).toBeNull()
  const form = screen.getByRole('heading', { name: 'Edit query' }).closest('.surface-card') as HTMLElement
  // Where the edit applies is a label and its value; what it keeps is two short notes.
  expect(within(form).getByText('Applies to', { selector: 'dt' }).nextElementSibling?.textContent).toBe(audience ? `Only ${measurementScope === 'property' ? 'Acme' : measurementScope === 'group' ? 'North East · Group' : 'New York · Market'}` : 'Everywhere')
  noteButton('Past answers kept', 'Changes apply to future sweeps. Earlier results stay unchanged.', form)
  noteButton('Locations and engines kept', "An edit keeps the query's locations and engines. Use Add queries to track it somewhere else.", form)
  expect([...(within(form).getByLabelText('Type') as HTMLSelectElement).options].map(option => option.text)).toEqual(['Keep type', 'Automatic', 'Branded', 'Non-brand'])
  expect(form.textContent).not.toMatch(/question|propert|classif|assign|scope/i)
  expectNoSentence(form)
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
  expect(screen.getByRole('button', { name: 'Publish changes' }).hasAttribute('disabled')).toBe(true)
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
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'auto' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('Review tracking changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [],
    edits: [{ queryId: 'query-acme', audience: { targetKeys: ['acme'] }, text: 'Acme pricing', queryClass: null }],
  })
})

test.each(['advanced'])('commits a resolved template query edit in %s mode without expanding its source', async (mode) => {
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
  expect((screen.getByLabelText('Query') as HTMLTextAreaElement).value).toBe('Acme pricing')
  // The note's help names the button this project has: a simple project keeps Add query.
  noteButton('Locations and engines kept', `An edit keeps the query's locations and engines. Use ${mode === 'simple' ? 'Add query' : 'Add queries'} to track it somewhere else.`)
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Acme fees' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText(mode === 'simple' ? 'Confirm tracked query changes' : 'Review tracking changes')
  fireEvent.click(screen.getByRole('button', { name: mode === 'simple' ? 'Confirm changes' : 'Publish changes' }))
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

test.each([
  ['group', 'north-east'],
  ['property', 'acme'],
  ['market', 'new-york'],
] as const)('offers explicit recovery for a retired tracked-query %s scope', async (measurementScope, measurementScopeKey) => {
  const data = workspace()
  if (measurementScope === 'group') data.groups = []
  if (measurementScope === 'property') data.targets = []
  if (measurementScope === 'market') data.markets = []
  installWorkspaceApi(undefined, [], data)
  const props = renderWorkspace({ selection: { measurementScope, measurementScopeKey, queryClass: 'branded' } })

  expect(await screen.findByText(`This saved ${measurementScope} filter is unavailable in the current measurement.`)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add queries' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit Acme pricing' })).toBeNull()
  expect(props.onTrackingQueryIdChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Show whole site' }))
  expect(props.onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'project', measurementScopeKey: undefined })
})

test('hides an open scoped action when a workspace publication retires its group', async () => {
  const data = workspace()
  installWorkspaceApi(undefined, [], data)
  const props = renderWorkspace({
    selection: { measurementScope: 'group', measurementScopeKey: 'north-east', queryClass: 'branded' },
    trackingQueryId: 'query-acme',
  })

  await screen.findByRole('heading', { name: 'Edit query' })
  data.groups = []
  await props.queryClient.invalidateQueries({
    queryKey: getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: 'demo' } }),
  })

  expect(await screen.findByText('This saved group filter is unavailable in the current measurement.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Edit query' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Add queries' })).toBeNull()
  expect(props.onTrackingQueryIdChange).toHaveBeenCalledWith(undefined)
})

test('unassigned legacy records remain accessible without promising a future portfolio measurement', async () => {
  const data = workspace()
  data.tracked[0]!.assignments = []
  installWorkspaceApi(undefined, [], data)
  renderWorkspace({ selection: { measurementScope: 'project', queryClass: 'unknown' } })
  const row = (await screen.findByText('Acme pricing')).closest('tr')!
  expect(within(row).getByText('Not in current plan')).toBeTruthy()
  expect(within(row).queryByText('Awaiting sweep')).toBeNull()
  expect(screen.queryByText('Best AEO platform')).toBeNull()
})
