import React, { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { ConnectSourceDrawer } from '../src/components/server-traffic/ConnectSourceDrawer.js'

const { navigateMock, connectVercelMock, backfillMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  connectVercelMock: vi.fn(),
  backfillMock: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigateMock,
}))

vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.js')>()),
  connectServerTrafficVercel: connectVercelMock,
  triggerServerTrafficBackfill: backfillMock,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  function Harness() {
    const [open, setOpen] = useState(true)
    return (
      <QueryClientProvider client={queryClient}>
        <button type="button" onClick={() => setOpen(true)}>
          reopen-drawer
        </button>
        <ConnectSourceDrawer open={open} onOpenChange={setOpen} projectName="test-project" />
      </QueryClientProvider>
    )
  }

  return render(<Harness />)
}

test('reopening the drawer after closing from a form step returns to the source picker', () => {
  renderDrawer()

  // Step 1 — the source picker is shown on first open.
  expect(screen.getByText('Connect a traffic source')).toBeTruthy()

  // Pick WordPress — step 2 shows the WordPress form.
  fireEvent.click(screen.getByText('WordPress site'))
  expect(screen.getByText('Connect a WordPress site')).toBeTruthy()

  // Close via the form's own footer Close button (next to Connect).
  const connectButton = screen.getByRole('button', { name: 'Connect' })
  fireEvent.click(within(connectButton.parentElement as HTMLElement).getByRole('button', { name: 'Close' }))
  expect(screen.queryByText('Connect a WordPress site')).toBeNull()

  // Reopen — the wizard is back at the picker, not the stale WordPress form.
  fireEvent.click(screen.getByText('reopen-drawer'))
  expect(screen.getByText('Connect a traffic source')).toBeTruthy()
  expect(screen.queryByText('Connect a WordPress site')).toBeNull()
})

test('choosing a different source returns to the picker without closing the drawer', () => {
  renderDrawer()

  fireEvent.click(screen.getByText('Google Cloud Run'))
  expect(screen.getByText('Connect a Cloud Run service')).toBeTruthy()

  fireEvent.click(screen.getByText('Choose a different source'))
  expect(screen.getByText('Connect a traffic source')).toBeTruthy()
  expect(screen.queryByText('Connect a Cloud Run service')).toBeNull()
})

test('connecting a Vercel source closes the drawer and kicks off a backfill', async () => {
  connectVercelMock.mockResolvedValue({ id: 'src_vercel_1' })
  backfillMock.mockResolvedValue({ sourceId: 'src_vercel_1', runId: 'run_1', status: 'running' })

  renderDrawer()

  fireEvent.click(screen.getByText('Vercel project'))
  expect(screen.getByText('Connect a Vercel project')).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText(/prj_/i), { target: { value: '  prj_abc  ' } })
  fireEvent.change(screen.getByLabelText(/team \/ account id/i), { target: { value: 'org_xyz' } })
  fireEvent.change(screen.getByLabelText(/personal access token/i), { target: { value: 'vcp_secret' } })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  // A backfill is auto-started for the freshly-connected source.
  await waitFor(() => {
    expect(backfillMock).toHaveBeenCalledWith('test-project', 'src_vercel_1')
  })

  // The drawer closes on success.
  await waitFor(() => {
    expect(screen.queryByText('Connect a Vercel project')).toBeNull()
  })

  // And routes to the new source's detail page so the backfill is visible.
  expect(navigateMock).toHaveBeenCalledWith({
    to: '/traffic/$projectName/$sourceId',
    params: { projectName: 'test-project', sourceId: 'src_vercel_1' },
  })

  // The connect request carried trimmed field values.
  expect(connectVercelMock).toHaveBeenCalledWith('test-project', {
    projectId: 'prj_abc',
    teamId: 'org_xyz',
    token: 'vcp_secret',
    environment: 'production',
    displayName: undefined,
  })
})
