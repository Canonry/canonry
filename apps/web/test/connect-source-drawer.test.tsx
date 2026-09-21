import React, { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ConnectSourceDrawer,
  WORDPRESS_PLUGIN_VERSION,
  WORDPRESS_PLUGIN_ZIP_URL,
  cloudRunGuide,
  cloudflareGuide,
  vercelGuide,
  wordpressGuide,
} from '../src/components/server-traffic/ConnectSourceDrawer.js'

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
  fireEvent.click(screen.getByText('WordPress'))
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

test('connecting a Vercel source closes the drawer without implicitly backfilling history', async () => {
  connectVercelMock.mockResolvedValue({ id: 'src_vercel_1' })

  renderDrawer()

  fireEvent.click(screen.getByText('Vercel'))
  expect(screen.getByText('Connect a Vercel project')).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText(/prj_/i), { target: { value: '  prj_abc  ' } })
  fireEvent.change(screen.getByLabelText(/team \/ account id/i), { target: { value: 'org_xyz' } })
  fireEvent.change(screen.getByLabelText(/personal access token/i), { target: { value: 'vcp_secret' } })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  // The drawer closes on success without starting a retention-limited history
  // pull. Vercel captures forward traffic until an operator requests history.
  await waitFor(() => {
    expect(screen.queryByText('Connect a Vercel project')).toBeNull()
  })
  expect(backfillMock).not.toHaveBeenCalled()

  // And routes to the new source's detail page.
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

  fireEvent.click(screen.getByText('WordPress'))
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

  fireEvent.click(screen.getByText('Vercel'))
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

  fireEvent.click(screen.getByText('Vercel'))
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

  fireEvent.click(screen.getByText('Vercel'))
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
  connectCloudRunMock.mockResolvedValue({ id: 'src_cr_1' })
  backfillMock.mockRejectedValue(new Error('500 internal'))

  renderDrawer()

  fireEvent.click(screen.getByText('Google Cloud Run'))
  fireEvent.change(screen.getByLabelText(/^GCP project ID/i), {
    target: { value: 'my-prod-foo' },
  })
  fireEvent.change(screen.getByPlaceholderText(/service_account/i), {
    target: { value: '{"type":"service_account"}' },
  })

  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  // The connect succeeded but the backfill kickoff failed. The error
  // surfaces and the drawer stays open instead of routing to an empty
  // detail page.
  await waitFor(() => {
    expect(screen.getByText(/starting the initial backfill failed: 500 internal/i)).toBeTruthy()
  })
  expect(screen.getByText('Connect a Cloud Run service')).toBeTruthy()
  expect(navigateMock).not.toHaveBeenCalled()
})

test('the plugin download link tracks the version the plugin itself declares', () => {
  // The link points at a release asset. If the plugin is bumped without this,
  // the download 404s for every operator who follows it.
  const header = readFileSync(
    resolve(import.meta.dirname, '../../../packages/wordpress-traffic-logger-plugin/plugin/canonry-traffic-logger.php'),
    'utf8',
  )
  const declared = /^\s*\*\s*Version:\s*(\S+)/m.exec(header)?.[1]
  expect(WORDPRESS_PLUGIN_VERSION).toBe(declared)
  expect(WORDPRESS_PLUGIN_ZIP_URL).toBe(
    `https://github.com/Canonry/canonry/releases/download/wp-traffic-logger-v${declared}/canonry-traffic-logger-${declared}.zip`,
  )
})

test('the WordPress form says the plugin is required and links straight to it', () => {
  renderDrawer()
  fireEvent.click(screen.getByText('WordPress'))

  const steps = screen.getByRole('region', { name: 'Or do it yourself' })
  expect(within(steps).getByText('Download the Canonry Traffic Logger plugin')).toBeTruthy()
  expect(within(steps).getByRole('link', { name: /Download v/ }).getAttribute('href')).toBe(WORDPRESS_PLUGIN_ZIP_URL)
  // No site URL yet, so there is no wp-admin page to point at.
  expect(within(steps).queryByRole('link', { name: /Open the upload page/ })).toBeNull()

  // Once the operator types their site, the steps link to its own admin pages.
  fireEvent.change(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://wp.example.com/blog' } })
  expect(within(steps).getByRole('link', { name: /Open the upload page/ }).getAttribute('href'))
    .toBe('https://wp.example.com/wp-admin/plugin-install.php?tab=upload')
  expect(within(steps).getByRole('link', { name: /Open your profile/ }).getAttribute('href'))
    .toBe('https://wp.example.com/wp-admin/profile.php#application-passwords-section')
})

test('every source hands the whole setup to an agent, with the real command and no secrets in chat', () => {
  const guides = {
    wordpress: wordpressGuide('acme', ''),
    vercel: vercelGuide('acme'),
    'cloud-run': cloudRunGuide('acme', ''),
    cloudflare: cloudflareGuide('acme'),
  }
  for (const [type, guide] of Object.entries(guides)) {
    expect(guide.agentRequest).toContain(`cnry traffic connect ${type} acme`)
    expect(guide.agentRequest).toContain(guide.docsUrl.split('#')[0])
    expect(guide.agentRequest).toContain('Never ask me to paste a password, token, or key into this chat.')
  }
  // Vercel reads the token from a file rather than a flag in shell history.
  expect(guides.vercel.agentRequest).toContain('--token-file')
})

test('the agent request can be copied from a source form', async () => {
  const writeText = vi.fn(async () => {})
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  try {
    renderDrawer()
    fireEvent.click(screen.getByText('Vercel'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup request' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(vercelGuide('test-project').agentRequest)
    })
    expect(await screen.findByText('Copied')).toBeTruthy()
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('Cloudflare is offered as a guided terminal setup, not a form', () => {
  renderDrawer()
  fireEvent.click(screen.getByText('Cloudflare'))

  expect(screen.getByText('Connect a Cloudflare zone')).toBeTruthy()
  // Deploying a Worker is CLI-only, so there is nothing to submit here.
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  expect(screen.getByText('cnry traffic connect cloudflare test-project --zone-id <zone-id> --account-id <account-id>')).toBeTruthy()
  expect(screen.getByRole('link', { name: /Open the setup guide/ }).getAttribute('href'))
    .toBe('https://github.com/Canonry/canonry/blob/main/docs/cloudflare-traffic-setup.md')
})

test('optional fields stay out of the way until asked for', () => {
  renderDrawer()
  fireEvent.click(screen.getByText('Google Cloud Run'))

  const summary = screen.getByText('Show more options')
  const details = summary.closest('details')
  expect(details?.open).toBe(false)
  expect(within(details as HTMLElement).getByLabelText(/^Service name/i)).toBeTruthy()
})
