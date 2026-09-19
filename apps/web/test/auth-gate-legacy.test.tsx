import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'

import { handleAuthExpired } from '../src/api.js'
import { AUTH_COPY } from '../src/components/auth/auth-copy.js'
import { AuthGate } from '../src/components/auth/AuthGate.js'
import { jsonResponse, mockFetch as installMockFetch } from './mock-fetch.js'

const ACCOUNT_SESSION = '/api/v1/auth/session'
const LEGACY_SESSION = '/api/v1/session'

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

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const restore = installMockFetch(handler)
  onTestFinished(restore)
}

function apiKeyMetadata(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  }
}

function dashboardFallback(url: string) {
  if (url.includes('/api/v1/keys/self')) return jsonResponse(apiKeyMetadata())
  if (/\/api\/v1\/projects(?:\?|$)/.test(url)) return jsonResponse([dashboardProject])
  if (url.includes('/projects/') && url.endsWith('/overview')) return jsonResponse({}, 404)
  if (url.includes('/runs')) return jsonResponse([])
  return jsonResponse({})
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('legacy dashboard access', () => {
  test('renders the shared-password login with browser metadata and accessible errors', async () => {
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION) && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Incorrect password' } }, 401)
      }
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false, setupRequired: false })
      return jsonResponse({})
    })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: AUTH_COPY.signInHeading })

    const password = screen.getByLabelText(AUTH_COPY.passwordLabel) as HTMLInputElement
    expect(password.name).toBe('password')
    expect(password.autocomplete).toBe('current-password')

    fireEvent.change(password, { target: { value: 'incorrect-password' } })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: AUTH_COPY.openDashboard })) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(password.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(password, { target: { value: 'try-again-password' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(password.getAttribute('aria-invalid')).toBe('false')
  })

  test('offers API-key recovery without claiming to reset the password', async () => {
    const requestBodies: unknown[] = []
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION) && init?.method === 'POST') {
        requestBodies.push(JSON.parse(String(init.body)))
        return jsonResponse({ error: { code: 'AUTH_INVALID', message: 'Invalid API key' } }, 401)
      }
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false, setupRequired: false })
      return jsonResponse({})
    })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: AUTH_COPY.signInHeading })
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.recoverWithApiKey }))
    expect(screen.getByText(AUTH_COPY.legacyRecoveryDescription)).toBeTruthy()

    const apiKey = screen.getByLabelText(AUTH_COPY.apiKeyLabel) as HTMLInputElement
    expect(apiKey.name).toBe('apiKey')
    expect(apiKey.autocomplete).toBe('off')
    expect(apiKey.type).toBe('password')

    fireEvent.change(apiKey, { target: { value: 'cnry_recovery_key' } })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: AUTH_COPY.openDashboard })) })
    expect(requestBodies).toContainEqual({ apiKey: 'cnry_recovery_key' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: AUTH_COPY.useDashboardPassword })).toBeTruthy()
  })

  test('hydrates recovered API-key metadata before exposing dashboard access', async () => {
    const requested: string[] = []
    mockFetch((url, init) => {
      const request = String(url)
      requested.push(request)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes('/api/v1/keys/self')) {
        return jsonResponse(apiKeyMetadata({
          id: 'key-read-only',
          name: 'Recovery key',
          keyPrefix: 'cnry_read',
          scopes: ['read'],
          projectId: 'project_auth_gate',
          projectName: 'auth-gate-project',
          readOnly: true,
        }))
      }
      if (request.includes(LEGACY_SESSION) && init?.method === 'POST') return jsonResponse({ authenticated: true })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false, setupRequired: false })
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: AUTH_COPY.signInHeading })
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.recoverWithApiKey }))
    fireEvent.change(screen.getByLabelText(AUTH_COPY.apiKeyLabel), { target: { value: 'cnry_recovery_key' } })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: AUTH_COPY.openDashboard })) })

    expect(await screen.findByRole('main')).toBeTruthy()
    expect(requested.some(url => url.includes('/api/v1/settings'))).toBe(false)
  })

  test('keeps a restored session locked when API-key metadata is unavailable', async () => {
    mockFetch((url) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: true })
      if (request.includes('/api/v1/keys/self')) {
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Metadata unavailable' } }, 503)
      }
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    expect(await screen.findByRole('heading', { name: AUTH_COPY.apiKeyErrorHeading })).toBeTruthy()
    expect(screen.getByRole('button', { name: AUTH_COPY.tryAgain })).toBeTruthy()
    expect(screen.queryByRole('main')).toBeNull()
  })

  test('clears a restored session whose bound API key is invalid', async () => {
    const sessionMethods: string[] = []
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes('/api/v1/keys/self')) {
        return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } }, 401)
      }
      if (request.includes(LEGACY_SESSION)) {
        const method = init?.method ?? 'GET'
        sessionMethods.push(method)
        if (method === 'DELETE') return new Response(null, { status: 204 })
        return jsonResponse({ authenticated: true })
      }
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    expect(await screen.findByRole('heading', { name: AUTH_COPY.signInHeading })).toBeTruthy()
    expect(screen.getByText(AUTH_COPY.legacySessionExpired)).toBeTruthy()
    expect(screen.queryByRole('main')).toBeNull()
    expect(sessionMethods).toContain('DELETE')
  })

  test('shows the connecting state while initial session checks are pending', async () => {
    let resolveAccount!: (value: Response) => void
    mockFetch((url) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return new Promise(resolve => { resolveAccount = resolve })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false, setupRequired: false })
      return jsonResponse({})
    })

    render(<AuthGate />)
    expect(screen.getByText(AUTH_COPY.connecting)).toBeTruthy()
    await waitFor(() => { expect(resolveAccount).toBeTypeOf('function') })
    await act(async () => { resolveAccount(jsonResponse({ authRequired: false, user: null })) })
    expect(await screen.findByRole('heading', { name: AUTH_COPY.signInHeading })).toBeTruthy()
  })

  test('transitions to legacy login immediately on auth expiry', async () => {
    mockFetch((url) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: true })
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    expect(await screen.findByRole('main')).toBeTruthy()
    await act(async () => { handleAuthExpired() })
    expect(await screen.findByRole('heading', { name: AUTH_COPY.signInHeading })).toBeTruthy()
    expect(screen.getByText(AUTH_COPY.legacySessionExpired)).toBeTruthy()
  })

  test('transitions to legacy login when the periodic check confirms expiry', async () => {
    let authenticated = true
    mockFetch((url) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated, setupRequired: false })
      return dashboardFallback(request)
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<AuthGate />)
    expect(await screen.findByRole('main')).toBeTruthy()
    authenticated = false
    await act(async () => { vi.advanceTimersByTime(65_000) })

    expect(await screen.findByRole('heading', { name: AUTH_COPY.signInHeading })).toBeTruthy()
    expect(screen.getByText(AUTH_COPY.legacySessionExpired)).toBeTruthy()
  })

  test('preserves the dashboard when a periodic check has a network failure', async () => {
    let shouldFail = false
    mockFetch((url) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION)) {
        if (shouldFail) throw new Error('Network error')
        return jsonResponse({ authenticated: true, setupRequired: false })
      }
      return dashboardFallback(request)
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<AuthGate />)
    expect(await screen.findByRole('main')).toBeTruthy()
    shouldFail = true
    await act(async () => { vi.advanceTimersByTime(65_000) })

    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: AUTH_COPY.signInHeading })).toBeNull()
  })
})
