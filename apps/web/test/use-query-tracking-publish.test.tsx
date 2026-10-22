import { createElement } from 'react'
import { expect, onTestFinished, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueryTrackingQueryKey } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'

import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { useQueryTrackingPublish } from '../src/queries/use-query-tracking-publish.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { preview as reviewPreview, workspace } from './support/query-tracking-fixtures.js'

const workspaceVersion = `qtw_${'a'.repeat(64)}`
const mutation = { expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [{ queryId: 'query-acme' }] }
const commitRequest = { ...mutation, previewToken: `qtp_${'b'.repeat(64)}`, reviewedAt: '2026-09-04T12:15:00.000Z' }
const conflict = () => jsonResponse({ error: { code: 'CONFLICT', message: 'Tracking changed since this review.' } }, 409)

function renderPublish(respond: (path: string) => Response | Promise<Response>) {
  onTestFinished(mockFetch(url => respond(new URL(url, 'http://localhost').pathname)))
  resetToasts()
  onTestFinished(resetToasts)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  const onCommitted = vi.fn()
  const { result, unmount } = renderHook(() => useQueryTrackingPublish('demo', { onCommitted }), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  return { result, onCommitted, unmount, client }
}

const toasts = () => getToasts().map(({ title, tone }) => ({ title, tone }))

test('runs onCommitted once after a successful commit, with what the server published', async () => {
  const { result, onCommitted } = renderPublish(path => {
    if (path === '/api/v1/projects/demo/query-tracking/commit') return jsonResponse({ committed: true, mode: 'advanced' })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  act(() => result.current.commit(commitRequest))
  await waitFor(() => expect(toasts()).toEqual([{ title: 'Tracked queries updated', tone: 'positive' }]))
  expect(onCommitted).toHaveBeenCalledTimes(1)
  expect(onCommitted).toHaveBeenCalledWith({ committed: true, mode: 'advanced' })
})

test('reports a failed commit without running onCommitted', async () => {
  const { result, onCommitted } = renderPublish(path => {
    if (path === '/api/v1/projects/demo/query-tracking/commit') return conflict()
    throw new Error(`Unexpected fetch: ${path}`)
  })
  act(() => result.current.commit(commitRequest))
  await waitFor(() => expect(toasts()).toEqual([{ title: 'Could not update tracked queries', tone: 'negative' }]))
  expect(result.current.error).toEqual({ title: 'Could not update tracked queries', detail: 'Tracking changed since this review.' })
  expect(onCommitted).not.toHaveBeenCalled()
})

test('reports a failed review and keeps no pending review', async () => {
  const { result, onCommitted } = renderPublish(path => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') return conflict()
    throw new Error(`Unexpected fetch: ${path}`)
  })
  act(() => result.current.requestPreview(mutation))
  await waitFor(() => expect(toasts()).toEqual([{ title: 'Could not review tracking changes', tone: 'negative' }]))
  expect(result.current.preview).toBeNull()
  expect(result.current.error).toEqual({ title: 'Could not review tracking changes', detail: 'Tracking changed since this review.' })
  expect(onCommitted).not.toHaveBeenCalled()
  // The next request clears the last refusal, so a surface that shows it never shows a stale one.
  act(() => result.current.requestPreview(mutation))
  expect(result.current.error).toBeNull()
  await waitFor(() => expect(toasts()).toHaveLength(2))
})


test.each([
  { kind: 'stopped', count: 1, retained: true, remainingAssignments: 0, revision: 5, title: '1 stopped', detail: 'New numbers next sweep', cta: { queryId: 'query-acme' } },
  { kind: 'stopped', count: 2, retained: true, remainingAssignments: 0, revision: 5, title: '2 stopped', detail: 'New numbers next sweep', cta: { status: 'not-asked' } },
  { kind: 'partially stopped', count: 2, retained: true, remainingAssignments: 1, revision: 5, title: '2 stopped', detail: 'New numbers next sweep', cta: { status: 'all' } },
  { kind: 'removed', count: 1, retained: false, remainingAssignments: 0, revision: 4, title: '1 removed', detail: undefined, cta: undefined },
])('a $count-query $kind notification describes the result and links only to retained rows', async ({ count, retained, remainingAssignments, revision, title, detail, cta }) => {
  const affected = workspace().tracked.slice(0, count)
  const preview = reviewPreview({
    tracked: retained ? affected.map(row => ({ ...row, assignments: row.assignments.slice(0, remainingAssignments) })) : [],
    diff: { added: [], reused: [], removed: affected.map(row => ({ queryId: row.queryId, queryText: row.queryText, assignmentCount: retained ? 1 : 0 })), unchanged: [], noOp: false },
  })
  const { result } = renderPublish(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview)
    if (path.endsWith('/query-tracking/commit')) return jsonResponse({ committed: true, mode: 'advanced', active: { ...workspace().active, revision } })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  act(() => result.current.requestPreview(mutation))
  await waitFor(() => expect(result.current.preview).not.toBeNull())
  act(() => result.current.commit(commitRequest))
  await waitFor(() => expect(getToasts()[0]?.title).toBe(title))
  expect(getToasts()[0]?.detail).toBe(detail)
  expect(getToasts()[0]?.cta).toEqual(cta ? { label: 'View', intent: 'view-tracked-queries', projectName: 'demo', ...cta } : undefined)
})

test('an unchanged match in a batch contributes neither a change nor a second destination to the notification', async () => {
  const [existing, added] = workspace().tracked
  const diffRow = (row: typeof existing) => ({ queryId: row!.queryId, queryText: row!.queryText, assignmentCount: 1 })
  const preview = reviewPreview({
    diff: { added: [diffRow(added)], reused: [diffRow(existing)], removed: [], unchanged: [], noOp: false },
    changes: [{ ...diffRow(existing), change: 'reused', before: { targetKeys: ['acme'], marketKeys: [] }, after: { targetKeys: ['acme'], marketKeys: [] }, altered: false }],
  })
  const { result } = renderPublish(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview)
    if (path.endsWith('/query-tracking/commit')) return jsonResponse({ committed: true, mode: 'advanced', active: { ...workspace().active, revision: 5 } })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  act(() => result.current.requestPreview(mutation))
  await waitFor(() => expect(result.current.preview).not.toBeNull())
  act(() => result.current.commit(commitRequest))
  await waitFor(() => expect(getToasts()[0]?.title).toBe('1 added'))
  expect(getToasts()[0]?.cta).toEqual({ label: 'View', intent: 'view-tracked-queries', projectName: 'demo', queryId: added!.queryId })
})


test('a commit that finishes after unmount refreshes cached data and notifies without dismissing a newer draft', async () => {
  let finish: ((response: Response) => void) | undefined
  const { result, onCommitted, unmount, client } = renderPublish(path => {
    if (path.endsWith('/query-tracking/commit')) return new Promise<Response>(resolve => { finish = resolve })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  const key = getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: 'demo' } })
  client.setQueryData(key, workspace())
  act(() => result.current.commit(commitRequest))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  unmount()
  await act(async () => finish!(jsonResponse({ committed: true, mode: 'advanced' })))
  await waitFor(() => expect(getToasts()[0]?.title).toBe('Tracked queries updated'))
  expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  expect(onCommitted).not.toHaveBeenCalled()
})
