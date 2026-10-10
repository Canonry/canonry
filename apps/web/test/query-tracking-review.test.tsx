import { afterEach, expect, onTestFinished, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getApiV1ProjectsByNameVisibilityReportQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementSetupQueryKey,
  getApiV1ProjectsByNameQueriesQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../src/api.js'
import { QueriesSection } from '../src/components/project/DiscoverySection.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { createQueryClient } from '../src/queries/query-client.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import {
  active, advancedResetLine, advancedResetNotice, context, installScrollSpy, installWorkspaceApi, listLocations, noteButton, openRowSheet, preview, previewToken,
  removalDiff, removalWorkload, renderWorkspace, results, reviewNumbers, reviewRemoval, reviewRow, searchLocationModels, sharedSearchLocation, sweepActiveLabel, sweepActiveMessage,
  trackedAfterRemoval, workspace, workspaceVersion,
} from './support/query-tracking-fixtures.js'

// The review and publish of an Advanced tracking change, reached through Stop tracking in a row's menu (`reviewRemoval`, or its steps).

/** Acme pricing asked for Acme and for Beta, so a Place that holds only Acme narrows a change to it. */
function sharedWorkspace() {
  const shared = workspace()
  shared.targets.push({ stableKey: 'beta', label: 'Beta' })
  shared.tracked[0]!.assignments.push({
    targetKey: 'beta', groupKeys: [], marketKeys: [], queryClass: 'non-brand', classificationSource: 'operator',
    contexts: [{ ...context, location: { label: 'Chicago', city: 'Chicago', region: 'IL', country: 'US' } }],
  })
  return shared
}

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

test('focuses the preview outcome and shows the before and after numbers under the heading', async () => {
  const scrollIntoView = installScrollSpy()
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ tracked: trackedAfterRemoval, diff: removalDiff, workload: removalWorkload }))
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()
  const heading = await reviewRemoval()
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  // Visible under the heading, not folded into a disclosure.
  expect(heading.textContent).toBe('Review 1 change')
  expect(reviewNumbers()).toEqual({ Queries: '2 → 1', 'Answers per sweep': '6 → 3', 'Answers added': '0', 'Answers removed': '−3' })
  expect(screen.getByText('Queries', { selector: 'dt' }).closest('details')).toBeNull()
  // One short caution note; the full notice, sweep sentence included, is the note's own help and not visible text.
  expect(noteButton(advancedResetLine, advancedResetNotice, heading.parentElement!).classList.contains('text-caution')).toBe(true)
  expect(screen.queryByText(/AI Visibility keeps showing the last sweep/)).toBeNull()
  expect(within(heading.parentElement!).queryByText('Publishing does not run a sweep.')).toBeNull()
})

test('keeps added and removed queries and answers separate in the review numbers', async () => {
  const added = [
    { queryId: 'query-new-1', queryText: 'Acme hours', assignmentCount: 1 },
    { queryId: 'query-new-2', queryText: 'Acme parking', assignmentCount: 1 },
  ]
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({
      // Post-change: the removed query is gone and the two new ones are in.
      tracked: [...trackedAfterRemoval, ...added.map(row => ({ ...trackedAfterRemoval[0]!, queryId: row.queryId, queryText: row.queryText, normalizedText: row.queryText.toLowerCase() }))],
      diff: { ...removalDiff, added },
      workload: { existingNodes: 614, existingProviderCalls: 1228, nextSweepNodes: 618, nextSweepProviderCalls: 1236, addedNodes: 6, addedProviderCalls: 12, removedNodes: 2, removedProviderCalls: 4 },
    }))
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()
  await reviewRemoval()
  expect(reviewNumbers()).toEqual({ Queries: '2 → 3', 'Answers per sweep': '1,228 → 1,236', 'Answers added': '+12', 'Answers removed': '−4' })
  expect(screen.getByText('2 added · 1 removed')).toBeTruthy()
})

test('counts a location-scoped removal as answers, not as a query leaving tracking', async () => {
  let previewBody: unknown
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) {
      previewBody = body
      // The server lists the query as removed while it stays tracked for its other assignments.
      return jsonResponse(preview({ diff: removalDiff, workload: removalWorkload }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], sharedWorkspace())
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  await reviewRemoval()
  expect(previewBody).toEqual({ expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [{ queryId: 'query-acme', audience: { targetKeys: ['acme'] } }] })
  expect(reviewNumbers()).toEqual({ Queries: '2 → 2', 'Answers per sweep': '6 → 3', 'Answers added': '0', 'Answers removed': '−3' })
})

test('reads the query count from the server when a scoped removal takes the last assignment of a query', async () => {
  installWorkspaceApi(path => {
    // The row stays, outside the plan, so the tracked rows alone would read 2 → 2.
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({
      tracked: workspace().tracked.map(row => row.queryId === 'query-acme' ? { ...row, assignments: [] } : row),
      diff: removalDiff, workload: removalWorkload, limits: { queries: { current: 2, next: 1, max: 1_000 } },
    }))
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  await reviewRemoval()
  expect(reviewNumbers()).toMatchObject({ Queries: '2 → 1' })
})

test('lists each added, reused and removed query in one table, with unchanged queries behind a disclosure', async () => {
  const data = workspace()
  data.targets.push({ stableKey: 'beta', label: 'Beta' })
  const [pricing, category] = data.tracked
  const reviews = { ...pricing!, queryId: 'query-reviews', queryText: 'Acme reviews', normalizedText: 'acme reviews' }
  data.tracked.push(reviews)
  const chicago = { ...context, location: { label: 'Chicago', city: 'Chicago', region: 'IL', country: 'US' } }
  const hours = {
    ...category!, queryId: 'query-hours', queryText: 'Acme hours', normalizedText: 'acme hours',
    // Acme is asked from two search locations and Beta from one: three assignments on two locations.
    assignments: [
      { ...pricing!.assignments[0]!, queryClass: 'non-brand', classificationSource: 'server', contexts: [context, chicago] },
      { ...category!.assignments[0]!, targetKey: 'beta', contexts: [chicago] },
    ],
  }
  const row = (query: { queryId: string; queryText: string }, assignmentCount: number) => ({ queryId: query.queryId, queryText: query.queryText, assignmentCount })
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({
      tracked: [category, hours, reviews],
      diff: { added: [row(hours, 3)], removed: [row(pricing!, 1)], reused: [row(category!, 1)], unchanged: [row(reviews, 1)], noOp: false },
      workload: { existingNodes: 3, existingProviderCalls: 6, nextSweepNodes: 4, nextSweepProviderCalls: 8, addedNodes: 2, addedProviderCalls: 4, removedNodes: 1, removedProviderCalls: 2 },
    }))
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], data)
  renderWorkspace()
  const heading = await reviewRemoval()

  expect(heading.textContent).toBe('Review 3 changes')
  expect(reviewNumbers()).toEqual({ Queries: '3 → 3', 'Answers per sweep': '6 → 8', 'Answers added': '+4', 'Answers removed': '−2' })
  expect(screen.getByText('1 added · 1 reused · 1 removed')).toBeTruthy()
  const changes = screen.getByRole('table', { name: 'Changes' })
  expect(within(changes).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Change', 'Query', 'Type', 'Location links', 'Search location and engines'])
  expect([...changes.querySelectorAll('tbody tr')].map(line => line.firstElementChild?.textContent)).toEqual(['Added', 'Reused', 'Removed'])
  const added = reviewRow('Acme hours')
  // The server's link count, which passes the two locations the row lists.
  expect(added).toMatchObject({ change: 'Added', type: 'Non-brand', assignments: '3', searchLocation: '2 combinations' })
  // The rows differ, so each names its own: the engine by its display name, with the model id behind the value.
  expect(sharedSearchLocation()).toBeNull()
  expect(reviewRow('Best AEO platform')).toMatchObject({ change: 'Reused', type: 'Non-brand', assignments: '1', searchLocation: 'New York · OpenAI' })
  expect(searchLocationModels(reviewRow('Best AEO platform').row, 'New York · OpenAI')).toBe('New York · openai (gpt-5)')
  expect(searchLocationModels(added.row, '2 combinations')).toBe('New York · openai (gpt-5); Chicago · openai (gpt-5)')
  // A removed row reads the type the query has now, as its Subject does.
  expect(reviewRow('Acme pricing')).toMatchObject({ change: 'Removed', type: 'Branded', assignments: '−1', searchLocation: '' })
  // A removed row lists no locations: the post-change state holds only what survives.
  expect(within(reviewRow('Acme pricing').row).queryByRole('button')).toBeNull()
  expect(listLocations(added.row, '2 locations')).toEqual([
    'Acme · Non-brand · Groups: North East · Markets: New York · New York · OpenAI; Chicago · OpenAI',
    'Beta · Non-brand · Chicago · OpenAI',
  ])
  // The list is its own row, the table's full width, and closes again.
  expect((added.row.nextElementSibling as HTMLTableRowElement).cells[0]!.colSpan).toBe(5)
  fireEvent.click(within(added.row).getByRole('button', { name: '2 locations' }))
  expect(changes.querySelectorAll('tbody tr')).toHaveLength(3)

  const unchanged = screen.getByText('1 unchanged query').closest('details')!
  expect(unchanged.open).toBe(false)
  // Every other tracked query is in this list, so its table is drawn only once it is opened.
  expect(screen.queryByRole('table', { name: 'Unchanged queries' })).toBeNull()
  expect(unchanged.textContent).toBe('1 unchanged query')
  fireEvent.click(screen.getByText('1 unchanged query'))
  await screen.findByRole('table', { name: 'Unchanged queries' })
  const kept = reviewRow('Acme reviews', 'Unchanged queries')
  expect(unchanged.contains(kept.row)).toBe(true)
  // Every unchanged row is asked the same way, so that is said once above the table, in place of a column.
  expect(kept).toMatchObject({ change: 'Unchanged', type: 'Branded', assignments: '1', searchLocation: undefined })
  expect(sharedSearchLocation('Unchanged queries')).toEqual({ label: 'New York · OpenAI', models: 'New York · openai (gpt-5)' })
  expect(within(screen.getByRole('table', { name: 'Unchanged queries' })).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Change', 'Query', 'Type', 'Location links'])
  // An unchanged query still names its location, group and market. Where it is asked is on the line above the table.
  expect(listLocations(kept.row, '1 location')).toEqual(['Acme · Branded · Groups: North East · Markets: New York'])
  expect((screen.getByRole('button', { name: 'Publish 3 changes' }) as HTMLButtonElement).disabled).toBe(false)
  // The review says location and query, with no em dash.
  expect(heading.parentElement!.textContent).not.toMatch(/propert|question|—/i)
})

test.each([
  // The advanced heading already says it, so a no-op adds no sentence under the numbers.
  { name: 'an advanced no-op preview', mode: 'advanced', noOp: true, heading: 'No tracking changes', subcopy: null },
])('shows no reset notice for $name', async ({ mode, noOp, heading, subcopy }) => {
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ mode, diff: noOp ? { ...removalDiff, removed: [], noOp } : removalDiff }))
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], { ...workspace(), mode })
  renderWorkspace()
  expect((await reviewRemoval()).textContent).toBe(heading)
  if (subcopy) expect(screen.getByText(subcopy)).toBeTruthy()
  else expect(screen.queryByText('This request leaves tracking unchanged.')).toBeNull()
  expect(screen.queryByText(/AI Visibility keeps showing the last sweep/)).toBeNull()
  expect(screen.queryByText(advancedResetLine)).toBeNull()
  expect(screen.queryByRole('button', { name: `${advancedResetLine}. ${advancedResetNotice}` })).toBeNull()
})

test.each([
  { name: 'an advanced commit', mode: 'advanced', committed: true, title: 'Tracked queries updated', detail: 'New numbers after the next sweep.' },
  { name: 'a no-op commit', mode: 'advanced', committed: false, title: 'No tracked-query change', detail: undefined },
])('names when new numbers arrive only after $name', async ({ mode, committed, title, detail }) => {
  resetToasts()
  onTestFinished(resetToasts)
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ mode, diff: removalDiff }))
    if (path.endsWith('/query-tracking/commit')) return jsonResponse({ committed, mode, workspaceVersion, reviewedAt: '2026-09-04T12:15:00.000Z', active, diff: removalDiff, workload: removalWorkload })
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], { ...workspace(), mode })
  renderWorkspace()
  await reviewRemoval()
  fireEvent.click(screen.getByRole('button', { name: mode === 'simple' ? 'Confirm changes' : 'Publish 1 change' }))
  await waitFor(() => expect(getToasts().map(toast => toast.title)).toEqual([title]))
  expect(getToasts()[0]!.detail).toBe(detail)
})

test.each([
  {
    name: 'a commit that meets a sweep', operation: 'commit', title: 'Could not confirm tracking changes', status: 409,
    error: {
      code: 'RUN_IN_PROGRESS',
      message: "Sweep run run_1 is running for 'demo'. Publish tracked query and setup changes after it finishes, or cancel it first: canonry run cancel demo run_1",
      details: { projectName: 'demo', kind: 'answer-visibility', activeRunId: 'run_1', reason: 'sweep-in-progress' },
    },
  },
  {
    name: 'a commit past the query limit', operation: 'commit', title: 'Could not confirm tracking changes', status: 400,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'This change would track 1,001 queries, over the 1,000-query limit. Remove queries or add fewer, then preview the change again.',
      details: { check: 'query-limit-exceeded', current: 1_000, next: 1_001, max: 1_000, displayToOperator: true },
    },
  },
  {
    name: 'a refused preview', operation: 'preview', title: 'Could not review tracking changes', status: 409,
    error: { code: 'QUERY_TRACKING_PREVIEW_STALE', message: 'Workspace changed. Review again.' },
  },
])('shows the server message in one toast and in the review for $name', async ({ operation, title, status, error }) => {
  resetToasts()
  onTestFinished(resetToasts)
  installWorkspaceApi(path => {
    if (path.endsWith(`/query-tracking/${operation}`)) return jsonResponse({ error }, status)
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ diff: removalDiff, workload: removalWorkload }))
    throw new Error(`Unexpected fetch: ${path}`)
  })
  // The app's client adds a fallback toast to any mutation error that is not marked as handled.
  const queryClient = createQueryClient()
  onTestFinished(() => queryClient.clear())
  render(<QueryClientProvider client={queryClient}><QueriesSection projectName="demo" /></QueryClientProvider>)
  fireEvent.click((await openRowSheet('Acme pricing', 'Stop tracking')).getByRole('button', { name: 'Review' }))
  if (operation === 'commit') fireEvent.click(await screen.findByRole('button', { name: 'Publish 1 change' }))
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.detail])).toEqual([[title, error.message]]))
  // The review stays up with the same refusal and a way to review the change again.
  expect(screen.getByRole('alert').textContent).toBe(`${title}. ${error.message}`)
  // Focus moves to the refusal; the button that held it left with the review.
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')))
  expect(screen.getByRole('button', { name: 'Review again' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Publish/ })).toBeNull()
})

test('keeps the fallback copy when a refused commit carries no Canonry error', async () => {
  resetToasts()
  onTestFinished(resetToasts)
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ diff: removalDiff, workload: removalWorkload }))
    if (path.endsWith('/query-tracking/commit')) return new Response('<html>Bad Gateway</html>', { status: 502 })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()
  await reviewRemoval()
  fireEvent.click(screen.getByRole('button', { name: 'Publish 1 change' }))
  await waitFor(() => expect(getToasts().map(toast => toast.detail)).toEqual(['The review may be stale. Review the changes again.']))
})

test.each([true, false])('pauses publishing while a sweep is queued or running (sweepActive=%s)', async (sweepActive) => {
  const commits: unknown[] = []
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ diff: removalDiff, workload: removalWorkload }))
    if (path.endsWith('/query-tracking/commit')) {
      commits.push(body)
      return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, reviewedAt: '2026-09-04T12:15:00.000Z', active, diff: removalDiff, workload: removalWorkload })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace({ publishGuard: { sweepActive } })
  await reviewRemoval()
  const confirm = screen.getByRole('button', { name: 'Publish 1 change' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(sweepActive)
  if (sweepActive) {
    // A short status; the sentence is its help.
    const status = screen.getByRole('status')
    expect(status.textContent).toBe(sweepActiveLabel)
    noteButton(sweepActiveLabel, sweepActiveMessage, status)
    fireEvent.click(confirm)
    // A commit reaches fetch only after the mutation's async onMutate, so let a task pass before asserting none went out.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))
    expect(commits).toEqual([])
  } else {
    expect(screen.queryByText(sweepActiveLabel)).toBeNull()
    fireEvent.click(confirm)
    await waitFor(() => expect(commits).toHaveLength(1))
  }
})

test('shows no sweep pause on a review that changes nothing', async () => {
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ diff: { ...removalDiff, removed: [], noOp: true } }))
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace({ publishGuard: { sweepActive: true } })
  await reviewRemoval()
  expect(screen.getByRole('button', { name: 'Publish changes' }).hasAttribute('disabled')).toBe(true)
  // The page's strip says a sweep is running. The review, which has nothing to publish, does not.
  expect(within(screen.getByRole('dialog')).queryByText(sweepActiveLabel)).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

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

  // The sheet names the query. It is asked for the whole project here, so there is no place to narrow to.
  const sheet = await openRowSheet('Acme pricing', 'Stop tracking')
  expect(sheet.getByText('Acme pricing')).toBeTruthy()
  expect(sheet.queryByRole('radiogroup', { name: 'Applies to' })).toBeNull()
  expect(requests).toEqual([])
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))

  await screen.findByText('1 removed')
  fireEvent.click(screen.getByRole('button', { name: 'Publish 1 change' }))
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
  await reviewRemoval()
  await screen.findByText('1 removed')
  const removed = reviewRow('Acme pricing')
  // The post-change row holds only what survives (Beta), so the removal names no search location. Its type is the query's own, now.
  expect(removed).toMatchObject({ change: 'Removed', type: 'Branded', assignments: '−1', searchLocation: undefined })
  expect(sharedSearchLocation()).toBeNull()
  expect(removed.row.textContent).not.toContain('Beta')
})

test.each([
  { measurementScope: 'property' as const, measurementScopeKey: 'acme', audience: { targetKeys: ['acme'] } },
  { measurementScope: 'group' as const, measurementScopeKey: 'north-east', audience: { groupKeys: ['north-east'] } },
  { measurementScope: 'market' as const, measurementScopeKey: 'new-york', audience: { marketKeys: ['new-york'] } },
])('removes only the selected $measurementScope audience of a shared query', async ({ measurementScope, measurementScopeKey, audience }) => {
  const previewBodies: unknown[] = []
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) {
      previewBodies.push(body)
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], sharedWorkspace())
  renderWorkspace({ selection: { measurementScope, measurementScopeKey, queryClass: 'all' } })

  // The sheet opens on the Place, and says so: the query is asked for Beta too.
  const sheet = await openRowSheet('Acme pricing', 'Stop tracking')
  const appliesTo = within(sheet.getByRole('radiogroup', { name: 'Applies to' })).getAllByRole('radio')
  expect(appliesTo.map(choice => [choice.textContent, choice.getAttribute('aria-checked')])).toEqual([
    [`Only ${measurementScope === 'property' ? 'Acme' : measurementScope === 'group' ? 'North East' : 'New York'}`, 'true'],
    ['Everywhere', 'false'],
  ])
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await screen.findByText('Review tracking changes')
  expect(previewBodies).toEqual([{ expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [{ queryId: 'query-acme', audience }] }])

  // Everywhere is the whole query: the same removal with no place.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(sheet.getByRole('radio', { name: 'Everywhere' }))
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await screen.findByText('Review tracking changes')
  expect(previewBodies[1]).toEqual({ expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [{ queryId: 'query-acme' }] })
})

test('refreshes cached measurement and query state for the published project', async () => {
  installWorkspaceApi((path) => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview())
    if (path.endsWith('/query-tracking/commit')) return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, reviewedAt: '2026-09-04T12:15:00.000Z', active: { ...active, revision: 5 }, diff: preview().diff, workload: preview().workload })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300_000 } } })
  const options = { client: heyClient, path: { name: 'demo' } }
  const changedKeys = [
    getApiV1ProjectsByNameVisibilityReportQueryKey({ ...options, query: { scope: 'property', scopeKey: 'acme' } }),
    getApiV1ProjectsByNameMeasurementPlanQueryKey(options),
    getApiV1ProjectsByNameMeasurementSetupQueryKey(options),
    getApiV1ProjectsByNameQueriesQueryKey(options),
  ]
  const unrelatedKey = getApiV1ProjectsByNameVisibilityReportQueryKey({ client: heyClient, path: { name: 'another-project' } })
  for (const key of [...changedKeys, unrelatedKey]) queryClient.setQueryData(key, { cached: true })
  render(<QueryClientProvider client={queryClient}><QueriesSection projectName="demo" /></QueryClientProvider>)
  fireEvent.click((await openRowSheet('Acme pricing', 'Stop tracking')).getByRole('button', { name: 'Review' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Publish changes' }))
  await waitFor(() => {
    for (const key of changedKeys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
  })
  expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false)
})

test.each([
  // Back returns to the sheet's form, whose Review sends the same change.
  { failedOperation: 'preview', again: 'Review' },
  { failedOperation: 'commit', again: 'Review' },
  { failedOperation: 'preview', again: 'Review again' },
  { failedOperation: 'commit', again: 'Review again' },
] as const)('refreshes a stale workspace after $failedOperation fails so $again reviews the same draft', async ({ failedOperation, again }) => {
  const refreshedVersion = `qtw_${'d'.repeat(64)}`
  let stale = false
  let refused = false
  const reviewedVersions: unknown[] = []
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/query-tracking')) return jsonResponse({ ...workspace(), workspaceVersion: stale ? refreshedVersion : workspaceVersion })
    if (path.endsWith('/query-tracking/results')) return jsonResponse(results())
    if (path.endsWith('/measurement-query-templates')) return jsonResponse({ templates: [] })
    if (path.endsWith('/query-tracking/preview')) {
      reviewedVersions.push(JSON.parse(String(init?.body)).expectedWorkspaceVersion)
      if (failedOperation !== 'preview' || refused) return jsonResponse(preview({ workspaceVersion: stale ? refreshedVersion : workspaceVersion }))
    }
    if (path.endsWith(`/query-tracking/${failedOperation}`)) {
      stale = true
      refused = true
      return jsonResponse({ error: { code: 'QUERY_TRACKING_PREVIEW_STALE', message: 'Workspace changed. Review again.' } }, 409)
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300_000 } } })
  render(<QueryClientProvider client={queryClient}><QueriesSection projectName="demo" /></QueryClientProvider>)
  fireEvent.click((await openRowSheet('Acme pricing', 'Stop tracking')).getByRole('button', { name: 'Review' }))
  if (failedOperation === 'commit') fireEvent.click(await screen.findByRole('button', { name: 'Publish changes' }))
  await waitFor(() => expect(refused).toBe(true))
  await waitFor(() => expect(queryClient.getQueryCache().getAll().some(query => (query.state.data as { workspaceVersion?: string } | undefined)?.workspaceVersion === refreshedVersion)).toBe(true))
  const refusal = `Could not ${failedOperation === 'preview' ? 'review' : 'confirm'} tracking changes. Workspace changed. Review again.`
  expect((await screen.findByRole('alert')).textContent).toBe(refusal)
  // The refusal follows the change back to the form, until the next request.
  if (again === 'Review') {
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('alert').textContent).toBe(refusal)
  }
  fireEvent.click(screen.getByRole('button', { name: again }))
  await screen.findByRole('button', { name: 'Publish changes' })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reviewedVersions).toEqual([workspaceVersion, refreshedVersion])
})
