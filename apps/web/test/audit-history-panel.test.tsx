import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { AuditHistoryPanel } from '../src/components/shared/AuditHistoryPanel.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('shows retained deleted-project evidence, client attribution, session, and field diff', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/api/v1/history')) {
      return jsonResponse([{
        id: 'audit-1',
        projectId: 'deleted-project-id',
        actor: 'api',
        action: 'project.updated',
        entityType: 'project',
        entityId: 'deleted-project-id',
        diff: { displayName: { before: 'Old', after: 'New' } },
        userAgent: 'Mozilla/5.0',
        actorSession: 'session-123',
        createdAt: '2026-07-14T18:16:33.000Z',
      }])
    }
    if (url.includes('/api/v1/projects')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AuditHistoryPanel />
    </QueryClientProvider>,
  )

  await waitFor(() => expect(screen.getByText(/Deleted project · deleted-project-id/)).not.toBeNull())
  expect(screen.getByText('Dashboard')).not.toBeNull()
  expect(screen.getByText('Session session-123')).not.toBeNull()

  fireEvent.click(screen.getByText('View diff'))
  expect(screen.getByText(/"before": "Old"/)).not.toBeNull()

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  cleanup()
  queryClient.clear()
})

test('tracking history names the actual queries and distinguishes stopped from deleted', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{
    id: 'tracking-publish', projectId: 'demo', actor: 'api', action: 'query-tracking.published', entityType: 'query-tracking', entityId: 'demo',
    diff: { queries: { counts: { added: 2, stopped: 1, removed: 1, changed: 1 }, added: ['apartments uptown'], stopped: ['old market query'], removed: ['deleted catalog query'], changed: ['reworded query'], truncated: true } },
    userAgent: 'Mozilla/5.0', actorSession: null, createdAt: '2026-10-15T12:00:00.000Z',
  }])))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><AuditHistoryPanel projectName="demo" /></QueryClientProvider>)
  await screen.findByText('2 added · 1 stopped · 1 removed · 1 changed')
  expect(screen.queryByText('View diff')).toBeNull()
  fireEvent.click(screen.getByText('View queries'))
  for (const text of ['Added · apartments uptown', 'Stopped · old market query', 'Removed · deleted catalog query', 'Changed · reworded query']) expect(screen.getByText(text)).toBeTruthy()
  expect(screen.getByText('More queries changed.')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search change history' }), { target: { value: 'old market query' } })
  expect(screen.getByText('2 added · 1 stopped · 1 removed · 1 changed')).toBeTruthy()
  cleanup()
  queryClient.clear()
})

test.each([
  ['query-tracking.published', '1 added · 2 stopped · 3 matched'],
  ['query-tracking.updated', '1 added · 2 removed · 3 matched'],
])('reads older %s history without inventing query texts', async (action, summary) => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{
    id: 'tracking-old', projectId: 'demo', actor: 'cli', action, entityType: 'query-tracking', entityId: 'demo',
    diff: { added: 1, removed: 2, reused: 3 }, userAgent: null, actorSession: null, createdAt: '2026-10-15T12:00:00.000Z',
  }])))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><AuditHistoryPanel projectName="demo" /></QueryClientProvider>)
  await screen.findByText(summary)
  expect(screen.queryByText('View queries')).toBeNull()
  expect(screen.queryByText('View diff')).toBeNull()
  cleanup()
  queryClient.clear()
})
