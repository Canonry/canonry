import { createElement } from 'react'
import { expect, onTestFinished, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { useQueryTrackingPublish } from '../src/queries/use-query-tracking-publish.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

const workspaceVersion = `qtw_${'a'.repeat(64)}`
const mutation = { expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [{ queryId: 'query-acme' }] }
const commitRequest = { ...mutation, previewToken: `qtp_${'b'.repeat(64)}`, reviewedAt: '2026-09-04T12:15:00.000Z' }
const conflict = () => jsonResponse({ error: { code: 'CONFLICT', message: 'Tracking changed since this review.' } }, 409)

function renderPublish(respond: (path: string) => Response) {
  onTestFinished(mockFetch(url => respond(new URL(url, 'http://localhost').pathname)))
  resetToasts()
  onTestFinished(resetToasts)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  const onCommitted = vi.fn()
  const { result } = renderHook(() => useQueryTrackingPublish('demo', { onCommitted }), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  return { result, onCommitted }
}

const toasts = () => getToasts().map(({ title, tone }) => ({ title, tone }))

test('runs onCommitted once after a successful commit', async () => {
  const { result, onCommitted } = renderPublish(path => {
    if (path === '/api/v1/projects/demo/query-tracking/commit') return jsonResponse({ committed: true, mode: 'advanced' })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  act(() => result.current.commit(commitRequest))
  await waitFor(() => expect(toasts()).toEqual([{ title: 'Tracked queries updated', tone: 'positive' }]))
  expect(onCommitted).toHaveBeenCalledTimes(1)
})

test('reports a failed commit without running onCommitted', async () => {
  const { result, onCommitted } = renderPublish(path => {
    if (path === '/api/v1/projects/demo/query-tracking/commit') return conflict()
    throw new Error(`Unexpected fetch: ${path}`)
  })
  act(() => result.current.commit(commitRequest))
  await waitFor(() => expect(toasts()).toEqual([{ title: 'Could not confirm tracking changes', tone: 'negative' }]))
  expect(result.current.error).toEqual({ title: 'Could not confirm tracking changes', detail: 'Tracking changed since this review.' })
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
