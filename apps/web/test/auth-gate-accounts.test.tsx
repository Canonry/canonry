/**
 * F5 — what a person sees once the install has named accounts.
 *
 * Three states matter: no accounts at all (the dashboard opens, exactly as it
 * always did), signed in as an administrator (everything), and signed in as a
 * viewer (everything readable, nothing changeable, and the difference is
 * visible rather than a surprise 403).
 */
import { test, expect, onTestFinished, describe, afterEach } from 'vitest'

import React from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import { AuthGate } from '../src/components/auth/AuthGate.js'
import { handleAuthExpired } from '../src/api.js'
import { activeQueryCacheKeys } from '../src/queries/query-client.js'
import { mockFetch as installMockFetch, jsonResponse } from './mock-fetch.js'

const ACCOUNT_SESSION = '/api/v1/auth/session'
const ACCOUNT_LOGIN = '/api/v1/auth/login'

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

/** Serve the account-aware session route; everything else is an empty dashboard. */
function serveAccounts(state: { authRequired: boolean; user: { name: string; role: 'admin' | 'viewer' } | null }) {
  mockFetch((url) => {
    const urlStr = String(url)
    if (urlStr.includes(ACCOUNT_SESSION)) return jsonResponse(state)
    if (urlStr.includes('/api/v1/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    return dashboardFallback(urlStr)
  })
}

/**
 * The cached RESULTS the app currently holds. Read through the app's own
 * accessor so the test sees exactly what a component would.
 */
function readQueryCacheKeys(_container: HTMLElement): string[] {
  return activeQueryCacheKeys()
}

afterEach(() => {
  cleanup()
})

describe('an install with no accounts', () => {
  test('never shows a sign-in screen', async () => {
    mockFetch((url) => {
      const urlStr = String(url)
      if (urlStr.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (urlStr.includes('/api/v1/session')) return jsonResponse({ authenticated: true })
      return dashboardFallback(urlStr)
    })

    render(<AuthGate />)
    expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()
    expect(screen.queryByLabelText('Name')).toBeNull()
  })
})

describe('signing in with an account', () => {
  test('asks for a name and a password, in plain words', async () => {
    serveAccounts({ authRequired: true, user: null })

    render(<AuthGate />)
    expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    // The shared-password screen must not be what is offered here.
    expect(screen.queryByText('Create a dashboard password')).toBeNull()
  })

  // This screen is the first thing a client sees, often before they know what
  // the product is. An unbranded name/password box on a black page reads like a
  // staging server, so the product identifies itself here.
  test('identifies the product before asking for credentials', async () => {
    serveAccounts({ authRequired: true, user: null })

    render(<AuthGate />)
    await screen.findByText('Sign in to Canonry')

    const brand = screen.getByTestId('auth-brand')
    expect(brand.textContent).toContain('Canonry')
    expect(brand.querySelector('img')).toBeTruthy()

    // Two labelled fields already say what to type; a sentence repeating it is
    // noise on the one screen that should be shortest.
    expect(screen.queryByText('Enter the name and password for your account.')).toBeNull()
  })

  test('opens the dashboard once the name and password are accepted', async () => {
    let signedIn = false
    mockFetch((url, init) => {
      const urlStr = String(url)
      if (urlStr.includes(ACCOUNT_LOGIN)) {
        const body = JSON.parse(String(init?.body)) as { name: string; password: string }
        expect(body).toEqual({ name: 'owner', password: 'a-long-enough-password' })
        signedIn = true
        return jsonResponse({ authRequired: true, user: { name: 'owner', role: 'admin' } })
      }
      if (urlStr.includes(ACCOUNT_SESSION)) {
        return jsonResponse({ authRequired: true, user: signedIn ? { name: 'owner', role: 'admin' } : null })
      }
      return dashboardFallback(urlStr)
    })

    render(<AuthGate />)
    await screen.findByText('Sign in to Canonry')

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password' } })
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }))
    })

    expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()
  })

  test('says the same thing whatever was wrong, and stays put', async () => {
    mockFetch((url) => {
      const urlStr = String(url)
      if (urlStr.includes(ACCOUNT_LOGIN)) {
        return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Incorrect name or password.' } }, 401)
      }
      if (urlStr.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: true, user: null })
      return dashboardFallback(urlStr)
    })

    render(<AuthGate />)
    await screen.findByText('Sign in to Canonry')

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password-here' } })
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }))
    })

    expect(await screen.findByText('Incorrect name or password.')).toBeTruthy()
    expect(screen.getByText('Sign in to Canonry')).toBeTruthy()
  })
})

describe('what a signed-in person sees', () => {
  test('an administrator sees their name, a way out, and the settings screen', async () => {
    serveAccounts({ authRequired: true, user: { name: 'owner', role: 'admin' } })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: 'Portfolio' })

    expect(screen.getAllByText('owner').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Sign out' }).length).toBe(2)
    expect(screen.getAllByText('Settings').length).toBeGreaterThan(0)
  })

  test('a viewer is told they are read-only and is not shown administrator screens', async () => {
    serveAccounts({ authRequired: true, user: { name: 'watcher', role: 'viewer' } })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: 'Portfolio' })

    expect(screen.getAllByText('watcher').length).toBeGreaterThan(0)
    expect(screen.getAllByText('View only').length).toBeGreaterThan(0)
    // Settings holds provider credentials and API keys — not a viewer's screen.
    expect(screen.queryByText('Settings')).toBeNull()
    expect(screen.queryByText('Setup')).toBeNull()
  })
})

test('a viewer dashboard never asks for the settings it is not allowed to read', async () => {
  const requested: string[] = []
  mockFetch((url) => {
    const urlStr = String(url)
    requested.push(urlStr)
    if (urlStr.includes(ACCOUNT_SESSION)) {
      return jsonResponse({ authRequired: true, user: { name: 'watcher', role: 'viewer' } })
    }
    if (urlStr.includes('/api/v1/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    return dashboardFallback(urlStr)
  })

  render(<AuthGate />)
  await screen.findByRole('heading', { name: 'Portfolio' })

  expect(requested.some(url => url.includes('/api/v1/settings'))).toBe(false)
})

test('P2.7: one account does not inherit the cached data of the one before it', async () => {
  // The admin's dashboard reads /settings, which a viewer is refused. If the
  // query cache outlives the sign-out, the viewer that signs in next renders
  // the administrator's provider settings out of it.
  const state: { authRequired: boolean; user: { name: string; role: 'admin' | 'viewer' } | null } = {
    authRequired: true,
    user: { name: 'owner', role: 'admin' },
  }
  mockFetch((url) => {
    const urlStr = String(url)
    if (urlStr.includes(ACCOUNT_LOGIN)) return jsonResponse(state)
    if (urlStr.includes(ACCOUNT_SESSION)) return jsonResponse(state)
    if (urlStr.includes('/api/v1/settings')) {
      return jsonResponse({ providers: [{ name: 'openai', configured: true }], google: { configured: true }, bing: { configured: false } })
    }
    if (urlStr.includes('/api/v1/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    return dashboardFallback(urlStr)
  })

  const { container } = render(<AuthGate />)
  await screen.findByRole('heading', { name: 'Portfolio' })
  const adminCache = readQueryCacheKeys(container)
  expect(adminCache.some(key => /settings/i.test(key))).toBe(true)

  // The administrator's session ends and a viewer signs in on the same tab.
  state.user = { name: 'watcher', role: 'viewer' }
  await act(async () => {
    handleAuthExpired()
  })
  await screen.findByText('Sign in to Canonry')

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'watcher' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password' } })
  await act(async () => {
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }))
  })
  await screen.findByRole('heading', { name: 'Portfolio' })

  expect(readQueryCacheKeys(container).some(key => /settings/i.test(key))).toBe(false)
})

test('P2.9: identity and a way out exist on the mobile surface too', async () => {
  // The sidebar is hidden below the large breakpoint, so on a phone the only
  // identity and the only sign-out went with it — leaving no way to end a
  // session on the device most likely to be shared or lost.
  serveAccounts({ authRequired: true, user: { name: 'watcher', role: 'viewer' } })

  render(<AuthGate />)
  await screen.findByRole('heading', { name: 'Portfolio' })

  const mobileNav = document.querySelector('.mobile-nav')
  expect(mobileNav).toBeTruthy()
  expect(mobileNav!.textContent).toContain('watcher')
  expect(mobileNav!.querySelector('[data-testid="mobile-sign-out"]')).toBeTruthy()
})
