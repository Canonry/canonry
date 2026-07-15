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
