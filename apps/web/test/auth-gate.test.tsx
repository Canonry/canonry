import { afterEach, describe, expect, onTestFinished, test } from 'vitest'

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { USER_PASSWORD_MIN_LENGTH, userNameSchema } from '@ainyc/canonry-contracts'

import { AuthGate } from '../src/components/auth/AuthGate.js'
import { AUTH_COPY } from '../src/components/auth/auth-copy.js'
import { accountStateForApiKey } from '../src/contexts/account-context.js'
import { mockFetch as installMockFetch, jsonResponse } from './mock-fetch.js'

const ACCOUNT_SESSION = '/api/v1/auth/session'
const LEGACY_SESSION = '/api/v1/session'
const ACCOUNT_LOGIN = '/api/v1/auth/login'
const USERS = '/api/v1/users'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const restore = installMockFetch(handler)
  onTestFinished(restore)
}

function dashboardFallback(url: string) {
  if (url.includes('/api/v1/keys/self')) {
    return jsonResponse({
      id: 'key-root', name: 'Default key', keyPrefix: 'cnry_root', scopes: ['*'],
      projectId: null, projectName: null, readOnly: false, createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null,
    })
  }
  if (/\/api\/v1\/projects(?:\?|$)/.test(url)) return jsonResponse([])
  if (url.includes('/runs')) return jsonResponse([])
  return jsonResponse({})
}

function serveNamedAccounts(googleEnabled: boolean) {
  mockFetch((url) => {
    const request = String(url)
    if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: true, user: null })
    if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false, setupRequired: false })
    if (request.includes('/api/v1/auth/providers')) {
      return jsonResponse({ google: { enabled: googleEnabled, startUrl: googleEnabled ? '/api/v1/auth/google/start' : null } })
    }
    return dashboardFallback(request)
  })
}

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
  window.localStorage.clear()
  window.sessionStorage.clear()
})

test('maps API-key metadata to conservative dashboard capabilities', () => {
  const access = (scopes: string[], projectId: string | null, readOnly: boolean) =>
    accountStateForApiKey({ id: 'key-1', scopes, projectId, readOnly })

  expect(access(['*'], null, false)).toMatchObject({ canWrite: true, isAdmin: true })
  expect(access(['*'], 'project-1', false)).toMatchObject({ canWrite: true, isAdmin: false })
  expect(access(['read'], null, true)).toMatchObject({ canWrite: false, isAdmin: false })
  expect(access(['ads.write'], null, false)).toMatchObject({ canWrite: false, isAdmin: false })
})

describe('named-account sign-in', () => {
  test('does not flash password sign-in while Google availability is loading', async () => {
    let resolveProviders!: (value: Response) => void
    mockFetch((url) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: true, user: null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false, setupRequired: false })
      if (request.includes('/api/v1/auth/providers')) return new Promise(resolve => { resolveProviders = resolve })
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    expect((await screen.findByRole('status')).textContent).toBe(AUTH_COPY.checkingSignInOptions)
    expect(screen.queryByLabelText(AUTH_COPY.usernameLabel)).toBeNull()
    expect(screen.queryByLabelText(AUTH_COPY.passwordLabel)).toBeNull()

    await waitFor(() => { expect(resolveProviders).toBeTypeOf('function') })
    await act(async () => { resolveProviders(jsonResponse({ google: { enabled: false, startUrl: null } })) })
    expect(await screen.findByLabelText(AUTH_COPY.usernameLabel)).toBeTruthy()
  })

  test('makes Google primary and reveals password sign-in only on request', async () => {
    serveNamedAccounts(true)
    render(<AuthGate />)

    expect(await screen.findByRole('button', { name: AUTH_COPY.continueWithGoogle })).toBeTruthy()
    expect(screen.queryByLabelText(AUTH_COPY.usernameLabel)).toBeNull()
    expect(screen.queryByLabelText(AUTH_COPY.passwordLabel)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.usePassword }))
    expect(screen.getByLabelText(AUTH_COPY.usernameLabel)).toBeTruthy()
    expect(screen.getByLabelText(AUTH_COPY.passwordLabel)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.useGoogle }))
    expect(screen.queryByLabelText(AUTH_COPY.passwordLabel)).toBeNull()
  })

  test('keeps password sign-in available when Google is not configured', async () => {
    serveNamedAccounts(false)
    render(<AuthGate />)

    expect(await screen.findByLabelText(AUTH_COPY.usernameLabel)).toBeTruthy()
    expect(screen.getByLabelText(AUTH_COPY.passwordLabel)).toBeTruthy()
    expect(screen.queryByRole('button', { name: AUTH_COPY.continueWithGoogle })).toBeNull()
  })

  test('continues to the dashboard after a password sign-in', async () => {
    let signedIn = false
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_LOGIN)) {
        expect(JSON.parse(String(init?.body))).toEqual({ name: 'owner', password: 'a-long-enough-password' })
        signedIn = true
        return jsonResponse({ authRequired: true, user: { name: 'owner', role: 'admin' } })
      }
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: true, user: signedIn ? { name: 'owner', role: 'admin' } : null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false })
      if (request.includes('/api/v1/auth/providers')) return jsonResponse({ google: { enabled: false, startUrl: null } })
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    await screen.findByLabelText(AUTH_COPY.usernameLabel)
    fireEvent.change(screen.getByLabelText(AUTH_COPY.usernameLabel), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.passwordLabel), { target: { value: 'a-long-enough-password' } })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: AUTH_COPY.signIn })) })

    expect(await screen.findByRole('main')).toBeTruthy()
  })
})

describe('invitation sign-in', () => {
  test('keeps an invitation token in memory for Google only, then removes it from the address', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    window.history.replaceState({}, '', '/#invitation=invite-secret')
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: true, user: null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false })
      if (request.includes('/api/v1/auth/providers')) return jsonResponse({ google: { enabled: true, startUrl: '/api/v1/auth/google/start' } })
      if (request.includes('/api/v1/auth/google/start')) {
        requests.push({ url: request, body: JSON.parse(String(init?.body)) })
        return jsonResponse({ redirectUrl: 'https://accounts.example.test/continue' })
      }
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    expect(await screen.findByRole('heading', { name: AUTH_COPY.invitationHeading })).toBeTruthy()
    expect(screen.queryByLabelText(AUTH_COPY.usernameLabel)).toBeNull()
    expect(screen.queryByLabelText(AUTH_COPY.passwordLabel)).toBeNull()
    expect(window.location.hash).toBe('')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.continueWithGoogle })) })
    expect(requests).toEqual([{
      url: expect.not.stringContaining('invite-secret'),
      body: { invitationToken: 'invite-secret', returnTo: '/' },
    }])
    expect([...Object.values(window.localStorage), ...Object.values(window.sessionStorage)]).not.toContain('invite-secret')
  })

  test('does not let a current account bypass an invitation', async () => {
    window.history.replaceState({}, '', '/#invitation=invite-secret')
    let signOutRequests = 0
    mockFetch((url) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: true, user: { name: 'owner', role: 'admin' } })
      if (request.includes('/api/v1/auth/logout')) {
        signOutRequests += 1
        return new Response(null, { status: 204 })
      }
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: false })
      if (request.includes('/api/v1/auth/providers')) return jsonResponse({ google: { enabled: true, startUrl: '/api/v1/auth/google/start' } })
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    expect(await screen.findByRole('heading', { name: AUTH_COPY.invitationHeading })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Portfolio' })).toBeNull()
    expect(screen.queryByRole('button', { name: AUTH_COPY.continueWithGoogle })).toBeNull()
    expect(screen.getByText(AUTH_COPY.invitationSignedInInstruction)).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.signOutToAcceptInvitation })) })
    expect(await screen.findByRole('button', { name: AUTH_COPY.continueWithGoogle })).toBeTruthy()
    expect(signOutRequests).toBe(1)
  })
})

describe('first administrator setup', () => {
  test('requires a key, sends it once only as authorization, and establishes the named session', async () => {
    const setupRequests: Array<{ body: unknown; authorization: string | null }> = []
    let loginRequests = 0
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
      if (request.includes(USERS) && init?.method === 'POST') {
        setupRequests.push({ body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get('authorization') })
        return jsonResponse({ id: 'user_owner', name: 'owner', displayName: null, email: null, role: 'admin', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: null, lastSeenAt: null, authVersion: 0, hasPassword: true })
      }
      if (request.includes(ACCOUNT_LOGIN)) {
        loginRequests += 1
        return jsonResponse({ authRequired: true, user: { name: 'owner', role: 'admin' } })
      }
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: AUTH_COPY.createAdministratorHeading })
    const submit = screen.getByRole('button', { name: AUTH_COPY.createAdministrator }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect((screen.getByLabelText(AUTH_COPY.passwordLabel) as HTMLInputElement).minLength).toBe(USER_PASSWORD_MIN_LENGTH)

    fireEvent.change(screen.getByLabelText(AUTH_COPY.usernameLabel), { target: { value: 'not a valid name' } })
    const invalidName = userNameSchema.safeParse('not a valid name')
    expect(invalidName.success).toBe(false)
    if (!invalidName.success) expect(screen.getByText(invalidName.error.issues[0]!.message)).toBeTruthy()
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(AUTH_COPY.usernameLabel), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.passwordLabel), { target: { value: 'a-long-enough-password' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.confirmPasswordLabel), { target: { value: 'a-long-enough-password' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(AUTH_COPY.setupKeyLabel), { target: { value: 'cnry_setup_secret' } })
    expect(submit.disabled).toBe(false)

    await act(async () => { fireEvent.click(submit) })
    expect(setupRequests).toEqual([{
      body: { name: 'owner', password: 'a-long-enough-password', role: 'admin', onlyIfFirstAdmin: true },
      authorization: 'Bearer cnry_setup_secret',
    }])
    expect(loginRequests).toBe(1)
    expect([...Object.values(window.localStorage), ...Object.values(window.sessionStorage)]).not.toContain('cnry_setup_secret')
    expect(window.location.pathname).toBe('/settings')
    expect(window.location.search).toBe('?section=sign-in')
  })

  test('does not create an account when the setup request fails', async () => {
    let attempts = 0
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
      if (request.includes(USERS) && init?.method === 'POST') {
        attempts += 1
        return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } }, 401)
      }
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: AUTH_COPY.createAdministratorHeading })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.usernameLabel), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.setupKeyLabel), { target: { value: 'wrong-key' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.passwordLabel), { target: { value: 'a-long-enough-password' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.confirmPasswordLabel), { target: { value: 'a-long-enough-password' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.createAdministrator })) })

    expect(attempts).toBe(1)
    expect(screen.getByLabelText(AUTH_COPY.setupKeyLabel)).toBeTruthy()
  })

  test('returns to ordinary sign-in without replaying creation when the post-create login fails', async () => {
    let creates = 0
    let logins = 0
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
      if (request.includes(USERS) && init?.method === 'POST') {
        creates += 1
        return jsonResponse({ id: 'user_owner', name: 'owner', displayName: null, email: null, role: 'admin', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: null, lastSeenAt: null, authVersion: 0, hasPassword: true })
      }
      if (request.includes(ACCOUNT_LOGIN)) {
        logins += 1
        return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Incorrect name or password.' } }, 401)
      }
      if (request.includes('/api/v1/auth/providers')) return jsonResponse({ google: { enabled: false, startUrl: null } })
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: AUTH_COPY.createAdministratorHeading })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.usernameLabel), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.setupKeyLabel), { target: { value: 'cnry_setup_secret' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.passwordLabel), { target: { value: 'a-long-enough-password' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.confirmPasswordLabel), { target: { value: 'a-long-enough-password' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.createAdministrator })) })

    expect(await screen.findByText(AUTH_COPY.administratorCreatedSignIn)).toBeTruthy()
    expect(creates).toBe(1)
    expect(logins).toBe(1)
    expect(screen.getByLabelText(AUTH_COPY.usernameLabel)).toBeTruthy()
    expect(screen.queryByLabelText(AUTH_COPY.setupKeyLabel)).toBeNull()
  })

  test('closes setup when account creation committed but its response was lost', async () => {
    let protectedInstance = false
    let creates = 0
    mockFetch((url, init) => {
      const request = String(url)
      if (request.includes(ACCOUNT_SESSION)) {
        return jsonResponse({ authRequired: protectedInstance, user: null })
      }
      if (request.includes(LEGACY_SESSION)) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
      if (request.includes(USERS) && init?.method === 'POST') {
        creates += 1
        protectedInstance = true
        throw new Error('Connection closed after commit')
      }
      if (request.includes('/api/v1/auth/providers')) return jsonResponse({ google: { enabled: false, startUrl: null } })
      return dashboardFallback(request)
    })

    render(<AuthGate />)
    await screen.findByRole('heading', { name: AUTH_COPY.createAdministratorHeading })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.usernameLabel), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.setupKeyLabel), { target: { value: 'cnry_setup_secret' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.passwordLabel), { target: { value: 'a-long-enough-password' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.confirmPasswordLabel), { target: { value: 'a-long-enough-password' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.createAdministrator })) })

    expect(await screen.findByText(AUTH_COPY.administratorSetupCompleteSignIn)).toBeTruthy()
    expect(screen.queryByLabelText(AUTH_COPY.setupKeyLabel)).toBeNull()
    expect(creates).toBe(1)
  })
})

test('keeps an existing legacy browser session fail-closed until its API key is verified', async () => {
  mockFetch((url) => {
    const request = String(url)
    if (request.includes(ACCOUNT_SESSION)) return jsonResponse({ authRequired: false, user: null })
    if (request.includes(LEGACY_SESSION)) return jsonResponse({ authenticated: true })
    if (request.includes('/api/v1/keys/self')) {
      return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Temporary metadata failure' } }, 503)
    }
    return dashboardFallback(request)
  })

  render(<AuthGate />)
  expect(await screen.findByRole('heading', { name: AUTH_COPY.apiKeyErrorHeading })).toBeTruthy()
  expect(screen.queryByRole('main')).toBeNull()
})
