import React, { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { ConnectSourceDrawer } from '../src/components/server-traffic/ConnectSourceDrawer.js'

const { navigateMock, connectVercelMock, connectWordpressMock, connectCloudRunMock, backfillMock } =
  vi.hoisted(() => ({
    navigateMock: vi.fn(),
    connectVercelMock: vi.fn(),
    connectWordpressMock: vi.fn(),
    connectCloudRunMock: vi.fn(),
    backfillMock: vi.fn(),
  }))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigateMock,
}))

vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api.js')>()),
  connectServerTrafficVercel: connectVercelMock,
  connectServerTrafficWordpress: connectWordpressMock,
  connectServerTrafficCloudRun: connectCloudRunMock,
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

test('connecting a WordPress source closes the drawer and kicks off a backfill', async () => {
  connectWordpressMock.mockResolvedValue({ id: 'src_wp_1' })
  backfillMock.mockResolvedValue({ sourceId: 'src_wp_1', runId: 'run_1', status: 'running' })

  renderDrawer()

  fireEvent.click(screen.getByText('WordPress site'))
  expect(screen.getByText('Connect a WordPress site')).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText('https://example.com'), {
    target: { value: 'https://wp.example.com' },
  })
  fireEvent.change(screen.getByLabelText(/^username/i), { target: { value: 'bot' } })
  fireEvent.change(screen.getByLabelText(/^application password/i), {
    target: { value: 'abcd efgh ijkl' },
  })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  await waitFor(() => {
    expect(backfillMock).toHaveBeenCalledWith('test-project', 'src_wp_1')
  })
  await waitFor(() => {
    expect(screen.queryByText('Connect a WordPress site')).toBeNull()
  })
  expect(navigateMock).toHaveBeenCalledWith({
    to: '/traffic/$projectName/$sourceId',
    params: { projectName: 'test-project', sourceId: 'src_wp_1' },
  })
})

test('connecting a Cloud Run source closes the drawer and kicks off a backfill', async () => {
  connectCloudRunMock.mockResolvedValue({ id: 'src_cr_1' })
  backfillMock.mockResolvedValue({ sourceId: 'src_cr_1', runId: 'run_1', status: 'running' })

  renderDrawer()

  fireEvent.click(screen.getByText('Google Cloud Run'))
  expect(screen.getByText('Connect a Cloud Run service')).toBeTruthy()

  fireEvent.change(screen.getByLabelText(/^GCP project ID/i), {
    target: { value: 'my-prod-foo' },
  })
  fireEvent.change(screen.getByPlaceholderText(/service_account/i), {
    target: { value: '{"type":"service_account"}' },
  })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  await waitFor(() => {
    expect(backfillMock).toHaveBeenCalledWith('test-project', 'src_cr_1')
  })
  await waitFor(() => {
    expect(screen.queryByText('Connect a Cloud Run service')).toBeNull()
  })
  expect(navigateMock).toHaveBeenCalledWith({
    to: '/traffic/$projectName/$sourceId',
    params: { projectName: 'test-project', sourceId: 'src_cr_1' },
  })
})

test('a failed connect keeps the drawer open and surfaces the error', async () => {
  connectVercelMock.mockRejectedValue(new Error('bad token'))

  renderDrawer()

  fireEvent.click(screen.getByText('Vercel project'))
  fireEvent.change(screen.getByPlaceholderText(/prj_/i), { target: { value: 'prj_abc' } })
  fireEvent.change(screen.getByLabelText(/team \/ account id/i), { target: { value: 'org_xyz' } })
  fireEvent.change(screen.getByLabelText(/personal access token/i), { target: { value: 'vcp_secret' } })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  // The error message surfaces in the form.
  await waitFor(() => {
    expect(screen.getByText('bad token')).toBeTruthy()
  })
  // The drawer stays open; no backfill or navigation happened.
  expect(screen.getByText('Connect a Vercel project')).toBeTruthy()
  expect(backfillMock).not.toHaveBeenCalled()
  expect(navigateMock).not.toHaveBeenCalled()
})

test('a whitespace-only required field shows a validation error without connecting', async () => {
  renderDrawer()

  fireEvent.click(screen.getByText('Vercel project'))
  // Whitespace passes the HTML `required` attribute but fails the trimmed check.
  fireEvent.change(screen.getByPlaceholderText(/prj_/i), { target: { value: '   ' } })
  fireEvent.change(screen.getByLabelText(/team \/ account id/i), { target: { value: 'org_xyz' } })
  fireEvent.change(screen.getByLabelText(/personal access token/i), { target: { value: 'vcp_secret' } })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  await waitFor(() => {
    expect(screen.getByText('Vercel project ID is required.')).toBeTruthy()
  })
  expect(connectVercelMock).not.toHaveBeenCalled()
})

test('a whitespace-only team ID is caught by the validation chain', async () => {
  renderDrawer()

  fireEvent.click(screen.getByText('Vercel project'))
  fireEvent.change(screen.getByPlaceholderText(/prj_/i), { target: { value: 'prj_abc' } })
  // teamId is whitespace-only; projectId is valid, so this exercises the
  // second link in the validation chain.
  fireEvent.change(screen.getByLabelText(/team \/ account id/i), { target: { value: '   ' } })
  fireEvent.change(screen.getByLabelText(/personal access token/i), { target: { value: 'vcp_secret' } })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  await waitFor(() => {
    expect(screen.getByText('Vercel team / account ID is required.')).toBeTruthy()
  })
  expect(connectVercelMock).not.toHaveBeenCalled()
})

test('a backfill kickoff failure keeps the drawer open and surfaces the error', async () => {
  connectVercelMock.mockResolvedValue({ id: 'src_vercel_1' })
  backfillMock.mockRejectedValue(new Error('500 internal'))

  renderDrawer()

  fireEvent.click(screen.getByText('Vercel project'))
  fireEvent.change(screen.getByPlaceholderText(/prj_/i), { target: { value: 'prj_abc' } })
  fireEvent.change(screen.getByLabelText(/team \/ account id/i), { target: { value: 'org_xyz' } })
  fireEvent.change(screen.getByLabelText(/personal access token/i), { target: { value: 'vcp_secret' } })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  // The connect succeeded but the backfill kickoff failed. The error
  // surfaces and the drawer stays open instead of routing to an empty
  // detail page.
  await waitFor(() => {
    expect(screen.getByText(/starting the initial backfill failed: 500 internal/i)).toBeTruthy()
  })
  expect(screen.getByText('Connect a Vercel project')).toBeTruthy()
  expect(navigateMock).not.toHaveBeenCalled()
})
