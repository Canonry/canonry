import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UserRoles } from '@ainyc/canonry-contracts'
import { AccountProvider } from '../src/contexts/account-context.js'
import { AccountPanel } from '../src/components/auth/AccountPanel.js'

const { methods } = vi.hoisted(() => ({ methods: vi.fn() }))
vi.mock('../src/api.js', () => ({
  fetchAuthMethods: methods,
  fetchAccountSessions: async () => ({ sessions: [] }),
  fetchAuthProviders: async () => ({ google: { enabled: true, startUrl: '/api/v1/auth/google/start' } }),
  linkGoogleSignIn: vi.fn(), revokeAllAccountSessions: vi.fn(), unlinkAuthMethod: vi.fn(),
}))
afterEach(cleanup)

test.each([false, true])('account drawer matches available sign-in methods (password=%s)', async hasPassword => {
  const id = crypto.randomUUID()
  const account = { id, name: crypto.randomUUID(), displayName: 'Sample person', role: UserRoles.analyst, authVersion: 0 }
  const google = { id: crypto.randomUUID(), provider: 'google', email: id + '@example.test', createdAt: new Date().toISOString() }
  methods.mockResolvedValue({ methods: [...(hasPassword ? [{ ...google, id: 'password', provider: 'password', email: null }] : []), google] })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={qc}><AccountProvider account={account}><AccountPanel /></AccountProvider></QueryClientProvider>)
  expect(screen.getByText(account.displayName)).toBeTruthy()
  expect(view.container.textContent).not.toContain(account.name)
  fireEvent.click(view.container.querySelector('button[aria-haspopup="dialog"]')!)
  await screen.findByText(new RegExp(google.email.replaceAll('.', '\\.')))
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelector('input[type="password"]') !== null).toBe(hasPassword)
  const methodRow = [...dialog.querySelectorAll('li')].find(row => row.textContent?.includes(google.email))!
  expect(methodRow.querySelector('button')!.disabled).toBe(!hasPassword)
  qc.clear()
})
