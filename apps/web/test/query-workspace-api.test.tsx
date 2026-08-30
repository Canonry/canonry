import React from 'react'
import { expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { createQueryWorkspaceFixture } from '../../../packages/api-routes/test/query-workspace-fixture.js'
import { DiscoverySection } from '../src/components/project/DiscoverySection.js'
import { AdvancedMeasurementSection } from '../src/components/project/advanced-measurement/AdvancedMeasurementSection.js'
import { mockFetch } from './mock-fetch.js'

function assignmentScope(plan: {
  assignments: Array<{ targetKey: string; queryId: string; queryClass: string; executionNodeKey: string }>
  executionNodes: Array<{ stableKey: string; context: unknown }>
}, queryId: string) {
  const contexts = new Map(plan.executionNodes.map(node => [node.stableKey, node.context]))
  return plan.assignments
    .filter(assignment => assignment.queryId === queryId)
    .map(assignment => ({
      targetKey: assignment.targetKey,
      queryClass: assignment.queryClass,
      context: contexts.get(assignment.executionNodeKey),
    }))
    .sort((left, right) => left.targetKey.localeCompare(right.targetKey))
}

test('Simple query editing works through the real API without relabelling evidence or launching a run', async () => {
  const fixture = await createQueryWorkspaceFixture()
  const { originalText } = fixture
  const replacementText = 'Which apartments in Metro Alder allow pets?'
  const writes: string[] = []
  const restore = mockFetch(async (url, init) => {
    const parsed = new URL(url)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push(`${method} ${parsed.pathname}`)
    const response = await fixture.request(method, `${parsed.pathname}${parsed.search}`, init?.body ? String(init.body) : undefined)
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } })
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(async () => {
    cleanup()
    queryClient.clear()
    restore()
    await fixture.close()
  })
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/', component: () => <DiscoverySection projectName="demo" workspace="tracked" /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router as never} /></QueryClientProvider>)

  fireEvent.click(await screen.findByRole('button', { name: `Edit ${originalText}` }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Query text' }), { target: { value: replacementText } })
  fireEvent.click(screen.getByRole('button', { name: 'Save query' }))
  await screen.findByText(replacementText)

  const current = fixture.catalog()
  expect(current).toHaveLength(2)
  expect(current.find(query => query.id === 'query-sibling')?.query).toBe('Which apartments have a pool?')
  expect(current.find(query => query.query === replacementText)?.id).not.toBe('query-original')
  expect(fixture.snapshot()).toMatchObject({ id: 'snapshot-old', queryId: null, queryText: originalText, answerText: 'Stored original answer.' })
  expect(fixture.runCount()).toBe(1)
  expect(fixture.requestedRuns()).toBe(0)
  expect(writes).toEqual(['POST /api/v1/projects/demo/queries/query-original/replace'])
})

test('Advanced query editing uses the real draft API, preserves frozen scope, and leaves the published report live until review and publish', async () => {
  const fixture = await createQueryWorkspaceFixture({ advanced: true })
  const replacementText = 'Which Metro Alder apartments allow pets?'
  const writes: string[] = []
  const onRetryQueries = vi.fn()
  const restore = mockFetch(async (url, init) => {
    const parsed = new URL(url)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push(`${method} ${parsed.pathname}`)
    const response = await fixture.request(
      method,
      `${parsed.pathname}${parsed.search}`,
      init?.body ? String(init.body) : undefined,
      Object.fromEntries(new Headers(init?.headers).entries()),
    )
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } })
  })
  onTestFinished(async () => {
    cleanup()
    restore()
    await fixture.close()
  })

  const activeBeforeResponse = await fixture.request('GET', '/api/v1/projects/demo/measurement-plan')
  expect(activeBeforeResponse.status).toBe(200)
  const activeBefore = JSON.parse(activeBeforeResponse.body).active
  const reportBeforeResponse = await fixture.request('GET', '/api/v1/projects/demo/measurement-report?revision=1')
  expect(reportBeforeResponse.status, reportBeforeResponse.body).toBe(200)
  const reportBefore = JSON.parse(reportBeforeResponse.body)
  const snapshotsBefore = fixture.snapshots()
  const originalScope = assignmentScope(activeBefore.plan, 'query-original')
  const siblingScope = assignmentScope(activeBefore.plan, 'query-sibling')
  expect(originalScope).toHaveLength(2)
  expect(originalScope.map(scope => scope.targetKey)).toEqual(['metro-alder', 'metro-birch'])
  expect(originalScope.map(scope => scope.queryClass)).toEqual(['non-brand', 'branded'])

  render(
    <AdvancedMeasurementSection
      projectName="demo"
      queries={fixture.catalog().map(({ id, query, createdAt }) => ({ id, query, createdAt }))}
      isQueryLoading={false}
      isQueryError={false}
      initialStep="queries"
      initialQueryId="query-original"
      onRetryQueries={onRetryQueries}
    />,
  )

  const input = await screen.findByLabelText('Query text')
  expect((input as HTMLInputElement).value).toBe(fixture.originalText)
  expect(screen.getByText('2 Properties assigned')).toBeTruthy()
  fireEvent.change(input, { target: { value: replacementText } })
  fireEvent.click(screen.getByRole('button', { name: 'Save to draft' }))
  await waitFor(() => expect(onRetryQueries).toHaveBeenCalledTimes(1))

  const replacement = fixture.catalog().find(query => query.query === replacementText)
  expect(replacement).toBeDefined()
  expect(replacement?.id).not.toBe('query-original')
  expect(fixture.catalog().find(query => query.id === 'query-original')?.query).toBe(fixture.originalText)

  const draftResponse = await fixture.request('GET', '/api/v1/projects/demo/measurement-plan/draft')
  expect(draftResponse.status).toBe(200)
  const draft = JSON.parse(draftResponse.body)
  expect(draft.draft.authoring.assignments
    .filter((assignment: { queryId: string }) => assignment.queryId === replacement!.id)
    .map((assignment: { targetKey: string; queryClass: string; executionContexts: unknown[] }) => ({
      targetKey: assignment.targetKey,
      queryClass: assignment.queryClass,
      executionContexts: assignment.executionContexts,
    }))
    .sort((left: { targetKey: string }, right: { targetKey: string }) => left.targetKey.localeCompare(right.targetKey)))
    .toEqual(originalScope.map(scope => ({
      targetKey: scope.targetKey,
      queryClass: scope.queryClass,
      executionContexts: [scope.context],
    })))
  expect(draft.draft.authoring.groups).toEqual(activeBefore.plan.groups)
  expect(draft.draft.authoring.assignments
    .filter((assignment: { queryId: string }) => assignment.queryId === 'query-sibling')
    .map((assignment: { targetKey: string; queryClass: string; executionContexts: unknown[] }) => ({
      targetKey: assignment.targetKey,
      queryClass: assignment.queryClass,
      executionContexts: assignment.executionContexts,
    })))
    .toEqual(siblingScope.map(scope => ({
      targetKey: scope.targetKey,
      queryClass: scope.queryClass,
      executionContexts: [scope.context],
    })))

  const activeAfterDraft = JSON.parse((await fixture.request('GET', '/api/v1/projects/demo/measurement-plan')).body).active
  const reportAfterDraft = JSON.parse((await fixture.request('GET', '/api/v1/projects/demo/measurement-report?revision=1')).body)
  expect(activeAfterDraft).toEqual(activeBefore)
  expect(reportAfterDraft).toEqual(reportBefore)
  expect(fixture.snapshots()).toEqual(snapshotsBefore)
  expect(fixture.runCount()).toBe(1)
  expect(fixture.requestedRuns()).toBe(0)
  expect(writes).toEqual([
    'POST /api/v1/projects/demo/measurement-plan/draft/actions/create',
    'POST /api/v1/projects/demo/measurement-plan/draft/actions/replace-query',
  ])

  const compiledResponse = await fixture.request('POST', '/api/v1/projects/demo/measurement-plan/draft/actions/compile-preview', '{}')
  expect(compiledResponse.status).toBe(200)
  const compiled = JSON.parse(compiledResponse.body)
  const publishResponse = await fixture.request(
    'POST',
    '/api/v1/projects/demo/measurement-plan/draft/actions/publish',
    JSON.stringify({ expectedActiveRevision: 1, expectedCompiledChecksum: compiled.compiledChecksum }),
    { 'if-match': draft.etag, 'idempotency-key': 'advanced-query-edit-integration-publish' },
  )
  expect(publishResponse.status).toBe(200)
  const published = JSON.parse(publishResponse.body)
  expect(published).toMatchObject({ published: true, active: { revision: 2 } })

  const activeAfterPublish = published.active
  expect(activeAfterPublish.plan.groups).toEqual(activeBefore.plan.groups)
  expect(assignmentScope(activeAfterPublish.plan, replacement!.id)).toEqual(originalScope)
  expect(assignmentScope(activeAfterPublish.plan, 'query-sibling')).toEqual(siblingScope)
  expect(activeAfterPublish.plan.querySnapshots).toEqual(expect.arrayContaining([
    expect.objectContaining({ queryId: replacement!.id, queryText: replacementText }),
  ]))
  expect(activeAfterPublish.plan.querySnapshots.some((snapshot: { queryId: string }) => snapshot.queryId === 'query-original')).toBe(false)
  expect(JSON.parse((await fixture.request('GET', '/api/v1/projects/demo/measurement-report?revision=1')).body)).toEqual(reportBefore)
  expect(fixture.snapshots()).toEqual(snapshotsBefore)
  expect(fixture.runCount()).toBe(1)
  expect(fixture.requestedRuns()).toBe(0)
})
