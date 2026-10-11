import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import { getApiV1ProjectsByNameQueryTrackingQueryKey } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../src/api.js'
import { DEFAULT_TRACKED_FILTERS } from '../src/components/project/queries/advanced/tracked-filters.js'
import { jsonResponse } from './mock-fetch.js'
import {
  active, addButton, context, expectNoSentence, installWorkspaceApi, noteButton, openRowSheet, preview, previewToken, renderViewerWorkspace, renderWorkspace, workspace, workspaceVersion,
} from './support/query-tracking-fixtures.js'

// The Tracked page of an Advanced project through the Queries section: what it lists, its search and Type
// filter, an edit from a row's menu and the recovery from a retired Place. The table, the row menu and the
// action sheet have their own files; the page as a whole is in advanced-tracked-page.test.tsx.

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const queryRows = () => screen.getAllByRole('button', { name: /^Actions for / }).map(button => button.getAttribute('aria-label')!.slice('Actions for '.length))

test('omits the Research workspace for a viewer when paid research is not enabled', async () => {
  installWorkspaceApi()
  renderViewerWorkspace()

  await screen.findByText('Acme pricing')
  expect(screen.queryByRole('tab', { name: 'Research' })).toBeNull()
})

test('renders a searchable tracked table, delegates the URL-owned workspace, and leaves the Place to the context row', async () => {
  installWorkspaceApi()
  const props = renderWorkspace()

  expect(await screen.findByRole('heading', { name: 'Queries' })).toBeTruthy()
  expect(await screen.findByText('Acme pricing')).toBeTruthy()
  expect(screen.getByText('Best AEO platform')).toBeTruthy()
  expect(screen.queryByText('Measurement setup')).toBeNull()
  expect(screen.queryByText('Tracked basket')).toBeNull()
  expect(screen.queryByText('Versioned query assignments')).toBeNull()

  // The search narrows the list on the page. It is not a URL filter, so the host hears nothing.
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: 'pricing' } })
  expect(queryRows()).toEqual(['Acme pricing'])
  expect(props.onSelectionChange).not.toHaveBeenCalled()

  // The Place is the context row's: the page draws no picker of its own.
  expect(document.querySelector('.visibility-scope-trigger')).toBeNull()
  expect(screen.queryByRole('searchbox', { name: 'Search places' })).toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Research' }))
  expect(props.onQueryWorkspaceChange).toHaveBeenCalledWith('research')
})

test.each([
  ['the whole project', { measurementScope: 'project' as const }],
  // Both queries are asked for Acme: one as Branded, one as Non-brand.
  ['a Place', { measurementScope: 'property' as const, measurementScopeKey: 'acme' }],
])('lists every type in %s whatever query type AI Visibility is set to, and filters by its own Type', async (_where, place) => {
  installWorkspaceApi()
  // The shared `queryClass` is AI Visibility's. The page has its own Type filter, which the host holds.
  const { rerender, ...props } = renderWorkspace({ selection: { ...place, queryClass: 'branded' }, trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange: () => {} })
  await screen.findByText('Acme pricing')
  expect(queryRows()).toEqual(['Acme pricing', 'Best AEO platform'])

  const type = screen.getByRole('combobox', { name: 'Type' }) as HTMLSelectElement
  expect(type.value).toBe('all')
  expect([...type.options].map(option => option.text)).toEqual(['All', 'Non-brand', 'Branded', 'Mixed', 'Not set'])
  expect(props.onSelectionChange).not.toHaveBeenCalled()

  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, type: 'non-brand' } })
  expect(queryRows()).toEqual(['Best AEO platform'])
  expect(type.value).toBe('non-brand')
  // None of the old page's words for a type, a place or a state.
  expect(document.body.textContent).not.toMatch(/Query type|Unclassified|Whole site|Assigned relationships|Awaiting sweep|Not in current plan|Legacy|Template|saved query record/)
})

test.each([
  { measurementScope: 'project' as const, measurementScopeKey: undefined, audience: undefined, only: null },
  { measurementScope: 'property' as const, measurementScopeKey: 'acme', audience: { targetKeys: ['acme'] }, only: 'Only Acme' },
  { measurementScope: 'group' as const, measurementScopeKey: 'north-east', audience: { groupKeys: ['north-east'] }, only: 'Only North East' },
  { measurementScope: 'market' as const, measurementScopeKey: 'new-york', audience: { marketKeys: ['new-york'] }, only: 'Only New York' },
])('edits shared query text within $measurementScope without reconstructing its classes or contexts', async ({ measurementScope, measurementScopeKey, audience, only }) => {
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

  const sheet = await openRowSheet('Acme pricing', 'Edit wording')
  // Where the edit applies is a choice only under a Place: the whole project has nothing to narrow to.
  if (only) expect(sheet.getByRole('radio', { name: only }).getAttribute('aria-checked')).toBe('true')
  else expect(sheet.queryByRole('radiogroup', { name: 'Applies to' })).toBeNull()
  const dialog = screen.getByRole('dialog', { name: 'Edit wording' })
  expect(dialog.textContent).not.toMatch(/question|propert|classif|assign|scope/i)
  expectNoSentence(dialog)
  noteButton('New trend line', 'New wording is tracked as a new query. Its trend starts at the next sweep and its Source becomes Manual. Past answers stay with the old wording.', dialog)

  fireEvent.change(sheet.getByLabelText('Query'), { target: { value: 'Acme fees' } })
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await screen.findByText('Review tracking changes')
  // Only the text: the server keeps each location's type, search location and engines.
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [],
    edits: [{ queryId: 'query-acme', ...(audience ? { audience } : {}), text: 'Acme fees' }],
  })
})

test('commits an edit of a query that came from a pattern without expanding its source', async () => {
  const requests: Array<{ path: string; body: unknown }> = []
  const saved = workspace()
  installWorkspaceApi((path, body) => {
    requests.push({ path, body })
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview())
    if (path.endsWith('/query-tracking/commit')) return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, reviewedAt: '2026-09-04T12:15:00.000Z', active, diff: preview().diff, workload: preview().workload })
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], {
    ...saved,
    tracked: [{
      ...saved.tracked[0]!,
      provenance: {
        source: 'template', sourceId: 'template-1', capturedAt: '2026-09-04T12:00:00.000Z',
        template: { templateId: 'template-1', templateVersion: 'v1', template: '{property} pricing', variables: { property: 'Acme' }, output: 'Acme pricing' },
      },
    }],
  } as ReturnType<typeof workspace>)
  renderWorkspace()

  const sheet = await openRowSheet('Acme pricing', 'Edit wording')
  expect((sheet.getByLabelText('Query') as HTMLTextAreaElement).value).toBe('Acme pricing')
  fireEvent.change(sheet.getByLabelText('Query'), { target: { value: 'Acme fees' } })
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await screen.findByText('Review tracking changes')
  fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toEqual({
    path: '/api/v1/projects/demo/query-tracking/commit',
    body: {
      expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'query-acme', text: 'Acme fees' }],
      previewToken, reviewedAt: '2026-09-04T12:15:00.000Z',
    },
  })
  // A publish closes the sheet.
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test.each([
  ['group', 'north-east'],
  ['property', 'acme'],
  ['market', 'new-york'],
] as const)('offers one way back from a retired %s Place, and no action on its rows', async (measurementScope, measurementScopeKey) => {
  const data = workspace()
  if (measurementScope === 'group') data.groups = []
  if (measurementScope === 'property') data.targets = []
  if (measurementScope === 'market') data.markets = []
  installWorkspaceApi(undefined, [], data)
  const props = renderWorkspace({ selection: { measurementScope, measurementScopeKey, queryClass: 'branded' }, rootLabel: 'All of Demo' })

  // A short label; the sentence is its help. The button's name says all of what.
  const body = (await screen.findByText('Place unavailable')).closest('section')!
  noteButton('Place unavailable', 'This saved place is not in this measurement. Show all of Demo to pick another.', body)
  expectNoSentence(body)
  expect(within(body).getAllByRole('button')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull()
  expect(props.onTrackingQueryIdChange).not.toHaveBeenCalled()
  const showAll = screen.getByRole('button', { name: 'Show all of Demo' })
  expect(showAll.textContent).toBe('Show all')
  fireEvent.click(showAll)
  expect(props.onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'project', measurementScopeKey: undefined })
})

test('closes an open action and drops a linked row when a publication retires the Place', async () => {
  const data = workspace()
  installWorkspaceApi(undefined, [], data)
  const props = renderWorkspace({
    selection: { measurementScope: 'group', measurementScopeKey: 'north-east', queryClass: 'branded' },
    trackingQueryId: 'query-acme',
  })

  await openRowSheet('Acme pricing', 'Stop tracking')
  data.groups = []
  await props.queryClient.invalidateQueries({
    queryKey: getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: 'demo' } }),
  })

  expect(await screen.findByText('Place unavailable')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
  expect(props.onTrackingQueryIdChange).toHaveBeenCalledWith(undefined)
})

test('a query asked nowhere stays reachable under Not asked, and never reads as waiting for a sweep', async () => {
  const data = workspace()
  data.tracked[1]!.assignments = []
  data.summary.notAsked = 1
  installWorkspaceApi(undefined, [], data)
  const { rerender } = renderWorkspace({ trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange: () => {} })
  await screen.findByText('Acme pricing')
  // The clean view lists what is asked.
  expect(queryRows()).toEqual(['Acme pricing'])

  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' } })
  expect(queryRows()).toEqual(['Best AEO platform'])
  const row = screen.getByText('Best AEO platform').closest('tr')!
  expect(within(row).getByText('Not asked')).toBeTruthy()
  expect(within(row).getByText('None')).toBeTruthy()
  expect(row.textContent).not.toMatch(/First answers|Awaiting sweep|Not in current plan/)
  expect(addButton().textContent).toBe('Add queries')
})
