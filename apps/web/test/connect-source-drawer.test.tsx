import React, { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { ConnectSourceDrawer } from '../src/components/server-traffic/ConnectSourceDrawer.js'

afterEach(cleanup)

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
