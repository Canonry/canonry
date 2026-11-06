import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({
  fetchCdpStatus: vi.fn(),
  configureCdp: vi.fn(),
}))

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>()
  return { ...actual, ...api }
})

import { CdpConfigCard } from '../src/components/settings/CdpConfigCard.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('shows a Chrome status error and recovery path outside Advanced', async () => {
  api.fetchCdpStatus.mockRejectedValueOnce(new Error('Connection refused'))

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><CdpConfigCard /></QueryClientProvider>)

  const error = await screen.findByRole('alert')
  expect(error.textContent).toContain('Could not check Chrome: Connection refused.')
  expect(error.textContent).toContain('Check that Chrome is running with remote debugging, then configure the endpoint.')
  expect(error.closest('details')).toBeNull()
  expect(screen.getByRole('button', { name: 'Configure' })).toBeTruthy()
})
