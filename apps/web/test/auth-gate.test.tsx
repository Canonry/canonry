import { test, expect, onTestFinished, describe, vi, afterEach } from 'vitest'

import React from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'

import { handleAuthExpired } from '../src/api.js'
import { AuthGate } from '../src/components/auth/AuthGate.js'
import { accountStateForApiKey } from '../src/contexts/account-context.js'
import { mockFetch as installMockFetch, jsonResponse } from './mock-fetch.js'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const restore = installMockFetch(handler)
  onTestFinished(restore)
}

const API_SESSION = '/api/v1/session'

const dashboardProject = {
  id: 'project_auth_gate',
  name: 'auth-gate-project',
  displayName: 'Auth gate project',
  canonicalDomain: 'auth-gate.example',
  ownedDomains: [],
  aliases: [],
  country: 'US',
  language: 'en',
  tags: [],
  labels: {},
  providers: [],
  providerModels: {},
  locations: [],
  defaultLocation: null,
  measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
  autoExtractBacklinks: false,
  configSource: 'api',
  configRevision: 1,
}

function dashboardFallback(urlStr: string) {
  if (urlStr.includes('/api/v1/keys/self')) {
    return jsonResponse({
      id: 'key-root',
      name: 'Default key',
      keyPrefix: 'cnry_root',
      scopes: ['*'],
      projectId: null,
      projectName: null,
      readOnly: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    })
  }
  if (/\/api\/v1\/projects(?:\?|$)/.test(urlStr)) return jsonResponse([dashboardProject])
  if (urlStr.includes('/projects/') && urlStr.endsWith('/overview')) return jsonResponse({}, 404)
  if (urlStr.includes('/runs')) return jsonResponse([])
  return jsonResponse({})
}

afterEach(() => {
  cleanup()
})

test('maps API-key metadata to conservative dashboard capabilities', () => {
  const access = (scopes: string[], projectId: string | null, readOnly: boolean) =>
    accountStateForApiKey({ id: 'key-1', scopes, projectId, readOnly })

  expect(access(['*'], null, false)).toMatchObject({ canWrite: true, isAdmin: true })
  expect(access(['*'], 'project-1', false)).toMatchObject({ canWrite: true, isAdmin: false })
  expect(access(['read'], null, true)).toMatchObject({ canWrite: false, isAdmin: false })
  expect(access(['ads.write'], null, false)).toMatchObject({ canWrite: false, isAdmin: false })
  expect(access(['write'], null, false)).toMatchObject({ canWrite: false, isAdmin: false })
})

describe('AuthGate', () => {
  describe('initial auth state', () => {
    test('renders login form when session is unauthenticated', async () => {
      mockFetch((url) => {
        if (String(url).includes(API_SESSION)) return jsonResponse({ authenticated: false })
        return jsonResponse({})
      })

      render(<AuthGate />)
      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    })

    test('renders setup form when session returns setupRequired', async () => {
      mockFetch((url) => {
        if (String(url).includes(API_SESSION)) return jsonResponse({ authenticated: false, setupRequired: true })
        return jsonResponse({})
      })

      render(<AuthGate />)
      expect(await screen.findByText('Create a dashboard password')).toBeTruthy()
      expect(screen.getByText('Stored on this Canonry install as a salted, one-way hash. Canonry cannot recover it.')).toBeTruthy()
      expect(screen.queryByText(/future visits/i)).toBeNull()
    })

    test('keeps password setup disabled until both fields are valid and matching', async () => {
      mockFetch((url) => {
        if (String(url).includes(API_SESSION)) return jsonResponse({ authenticated: false, setupRequired: true })
        return jsonResponse({})
      })

      render(<AuthGate />)
      await screen.findByRole('heading', { name: 'Create a dashboard password' })

      const password = screen.getByLabelText('Password') as HTMLInputElement
      const confirmation = screen.getByLabelText('Confirm password') as HTMLInputElement
      const submit = screen.getByRole('button', { name: 'Create password and continue' }) as HTMLButtonElement

      expect(password.name).toBe('new-password')
      expect(password.autocomplete).toBe('new-password')
      expect(password.minLength).toBe(8)
      expect(confirmation.autocomplete).toBe('new-password')
      expect(submit.disabled).toBe(true)

      fireEvent.change(password, { target: { value: 'short' } })
      expect(screen.getByText('Enter at least 8 characters.')).toBeTruthy()
      expect(password.getAttribute('aria-invalid')).toBe('true')

      fireEvent.change(password, { target: { value: 'long-enough' } })
      fireEvent.change(confirmation, { target: { value: 'different' } })
      expect(screen.getByText('Passwords do not match.')).toBeTruthy()
      expect(confirmation.getAttribute('aria-invalid')).toBe('true')
      expect(submit.disabled).toBe(true)

      fireEvent.change(confirmation, { target: { value: 'long-enough' } })
      expect(submit.disabled).toBe(false)
      expect(confirmation.getAttribute('aria-invalid')).toBe('false')

      fireEvent.click(screen.getByLabelText('Show passwords'))
      expect(password.type).toBe('text')
      expect(confirmation.type).toBe('text')
    })

    test('gives the shared-password login browser metadata and an accessible error', async () => {
      mockFetch((url, init) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION) && init?.method === 'POST') {
          return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Incorrect password' } }, 401)
        }
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: false })
        return jsonResponse({})
      })

      render(<AuthGate />)
      await screen.findByRole('heading', { name: 'Sign in to Canonry' })

      const password = screen.getByLabelText('Password') as HTMLInputElement
      expect(password.name).toBe('password')
      expect(password.autocomplete).toBe('current-password')

      fireEvent.change(password, { target: { value: 'incorrect-password' } })
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Open dashboard' }))
      })

      expect(await screen.findByRole('alert')).toBeTruthy()
      expect(password.getAttribute('aria-invalid')).toBe('true')

      fireEvent.change(password, { target: { value: 'try-again-password' } })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(password.getAttribute('aria-invalid')).toBe('false')
    })

    test('offers the server-supported API key recovery without claiming to reset the password', async () => {
      const requestBodies: unknown[] = []
      mockFetch((url, init) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION) && init?.method === 'POST') {
          requestBodies.push(JSON.parse(String(init.body)))
          return jsonResponse({ error: { code: 'AUTH_INVALID', message: 'Invalid API key' } }, 401)
        }
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: false })
        return jsonResponse({})
      })

      render(<AuthGate />)
      await screen.findByRole('heading', { name: 'Sign in to Canonry' })

      fireEvent.click(screen.getByRole('button', { name: 'Forgot password? Use API key' }))
      expect(screen.getByText('Enter an API key from this Canonry install. This opens the dashboard with that key’s access and does not change the password.')).toBeTruthy()

      const apiKey = screen.getByLabelText('Canonry API key') as HTMLInputElement
      expect(apiKey.name).toBe('apiKey')
      expect(apiKey.autocomplete).toBe('off')
      expect(apiKey.type).toBe('password')

      fireEvent.change(apiKey, { target: { value: 'cnry_recovery_key' } })
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Open dashboard' }))
      })

      expect(requestBodies).toContainEqual({ apiKey: 'cnry_recovery_key' })
      expect((await screen.findByRole('alert')).textContent).toBe('Invalid API key')
      expect(screen.getByRole('button', { name: 'Use dashboard password instead' })).toBeTruthy()
    })

    test('hydrates recovered API-key access before exposing dashboard controls', async () => {
      const requested: string[] = []
      mockFetch((url, init) => {
        const urlStr = String(url)
        requested.push(urlStr)
        if (urlStr.includes('/api/v1/keys/self')) {
          return jsonResponse({
            id: 'key-read-only',
            name: 'Recovery key',
            keyPrefix: 'cnry_read',
            scopes: ['read'],
            projectId: 'project_auth_gate',
            projectName: 'auth-gate-project',
            readOnly: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: null,
            revokedAt: null,
          })
        }
        if (urlStr.includes(API_SESSION) && init?.method === 'POST') {
          return jsonResponse({ authenticated: true })
        }
        if (urlStr.includes(API_SESSION)) {
          return jsonResponse({ authenticated: false, setupRequired: false })
        }
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)
      await screen.findByRole('heading', { name: 'Sign in to Canonry' })
      fireEvent.click(screen.getByRole('button', { name: 'Forgot password? Use API key' }))
      fireEvent.change(screen.getByLabelText('Canonry API key'), {
        target: { value: 'cnry_recovery_key' },
      })
      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: 'Open dashboard' }))
      })

      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()
      expect(screen.queryByText('Settings')).toBeNull()
      expect(requested.some(url => url.includes('/api/v1/settings'))).toBe(false)
    })

    test('renders dashboard when session is authenticated', async () => {
      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()
    })

    test('keeps a restored session locked when its API-key access cannot be verified', async () => {
      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        if (urlStr.includes('/api/v1/keys/self')) {
          return jsonResponse({
            error: { code: 'INTERNAL_ERROR', message: 'API-key metadata is temporarily unavailable.' },
          }, 503)
        }
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)

      expect(await screen.findByRole('heading', { name: 'Could not verify API key access' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Portfolio' })).toBeNull()
    })

    test('clears a restored session whose bound API key is no longer valid', async () => {
      const sessionMethods: string[] = []
      mockFetch((url, init) => {
        const urlStr = String(url)
        if (urlStr.includes('/api/v1/keys/self')) {
          return jsonResponse({
            error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
          }, 401)
        }
        if (urlStr.includes(API_SESSION)) {
          const method = init?.method ?? 'GET'
          sessionMethods.push(method)
          if (method === 'DELETE') return new Response(null, { status: 204 })
          return jsonResponse({ authenticated: true })
        }
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)

      expect(await screen.findByRole('heading', { name: 'Sign in to Canonry' })).toBeTruthy()
      expect(screen.getByText(/Your session expired/i)).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Could not verify API key access' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Portfolio' })).toBeNull()
      expect(sessionMethods).toContain('DELETE')
    })

    test('shows connecting state while session check is pending', async () => {
      let resolveSession: (value: Response) => void
      mockFetch((url) => {
        if (String(url).includes(API_SESSION)) {
          return new Promise((resolve) => { resolveSession = resolve })
        }
        return jsonResponse({})
      })

      render(<AuthGate />)
      expect(screen.getByText('Connecting to Canonry…')).toBeTruthy()

      await act(async () => {
        resolveSession!(jsonResponse({ authenticated: false }))
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    })
  })

  describe('auth expiry callback', () => {
    test('transitions to login immediately when handleAuthExpired fires', async () => {
      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()

      await act(async () => {
        handleAuthExpired()
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    })

    test('shows session-expired message when bounced back to login', async () => {
      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()

      await act(async () => {
        handleAuthExpired()
      })

      expect(await screen.findByText(/Your session expired/i)).toBeTruthy()
    })
  })

  describe('periodic session re-check', () => {
    test('transitions to login when interval check returns unauthenticated', async () => {
      // Use a mutable object for session so we can change responses mid-test
      const sessionState = { authenticated: true, setupRequired: false }

      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse(sessionState)
        return dashboardFallback(urlStr)
      })

      vi.useFakeTimers({ shouldAdvanceTime: true })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()

      // Change the session state to unauthenticated
      sessionState.authenticated = false

      // Advance time past the re-check interval (60s)
      await act(async () => {
        vi.advanceTimersByTime(65_000)
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()

      vi.useRealTimers()
    })

    test('stays on dashboard when interval check fails with a network error', async () => {
      // Transient network errors during the periodic re-check must NOT log
      // the user out — they'll be kicked by the apiFetch 401 interceptor
      // the next time a real request fails. A brief Wi-Fi blip shouldn't
      // strand the user on a login form.
      const sessionState = { authenticated: true, setupRequired: false }
      let shouldThrow = false

      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) {
          if (shouldThrow) throw new Error('Network error')
          return jsonResponse(sessionState)
        }
        return dashboardFallback(urlStr)
      })

      vi.useFakeTimers({ shouldAdvanceTime: true })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()

      shouldThrow = true

      await act(async () => {
        vi.advanceTimersByTime(65_000)
      })

      // User is still on the dashboard, not kicked to login
      expect(screen.queryByText('Sign in to Canonry')).toBeNull()
      expect(screen.getAllByText('Portfolio').length).toBeGreaterThan(0)

      vi.useRealTimers()
    })
  })
})
