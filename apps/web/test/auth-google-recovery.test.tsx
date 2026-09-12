import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { providerError } from '@ainyc/canonry-contracts'

import { AuthGate } from '../src/components/auth/AuthGate.js'
import { AUTH_COPY } from '../src/components/auth/auth-copy.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

test('a rejected Google start displays one error alongside the Google action', async () => {
  const failure = providerError('google', crypto.randomUUID())
  let attempted = false
  const restore = mockFetch(url => {
    if (url.endsWith('/auth/session')) return jsonResponse({ authRequired: true, user: null })
    if (url.endsWith('/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    if (url.endsWith('/auth/providers')) return jsonResponse({ google: { enabled: true, startUrl: '/api/v1/auth/google/start' } })
    if (url.endsWith('/auth/google/start')) {
      attempted = true
      return jsonResponse(failure.toJSON(), failure.statusCode)
    }
    return jsonResponse({})
  })
  try {
    render(<AuthGate />)
    const button = await screen.findByRole('button', { name: AUTH_COPY.continueWithGoogle })
    await act(async () => { fireEvent.click(button) })
    await waitFor(() => expect(attempted).toBe(true))

    expect(screen.getByRole('button', { name: AUTH_COPY.continueWithGoogle })).toBeTruthy()
    expect(screen.queryByLabelText(AUTH_COPY.passwordLabel)).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toBe(AUTH_COPY.googleStartFailed)
  } finally {
    restore()
  }
})

test('a rejected Google link remains visible to the already signed-in account', async () => {
  window.history.replaceState(null, '', '/?authError=google-sign-in-failed')
  let signOutRequests = 0
  const restore = mockFetch(url => {
    if (url.endsWith('/auth/session')) {
      return jsonResponse({
        authRequired: true,
        user: { id: crypto.randomUUID(), name: 'owner', role: 'admin', authVersion: 0 },
      })
    }
    if (url.endsWith('/auth/logout')) {
      signOutRequests += 1
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/session')) return jsonResponse({ authenticated: false })
    return jsonResponse([])
  })
  try {
    render(<AuthGate />)
    expect(await screen.findByRole('heading', { name: AUTH_COPY.googleLinkFailedHeading })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(AUTH_COPY.googleLinkFailed)
    expect(screen.queryByRole('main')).toBeNull()
    expect(screen.getByRole('button', { name: AUTH_COPY.backToDashboard })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.backToDashboard }))
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('')
    expect(signOutRequests).toBe(0)
  } finally {
    restore()
  }
})

test('a callback failure and a password failure share one accessible alert', async () => {
  window.history.replaceState(null, '', '/?authError=google-sign-in-failed')
  const restore = mockFetch((url, init) => {
    if (url.endsWith('/auth/session')) return jsonResponse({ authRequired: true, user: null })
    if (url.endsWith('/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    if (url.endsWith('/auth/providers')) return jsonResponse({ google: { enabled: true, startUrl: '/api/v1/auth/google/start' } })
    if (url.endsWith('/auth/login') && init?.method === 'POST') {
      return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: AUTH_COPY.incorrectAccountCredentials } }, 401)
    }
    return jsonResponse({})
  })
  try {
    render(<AuthGate />)
    await screen.findByRole('button', { name: AUTH_COPY.continueWithGoogle })
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.usePassword }))
    fireEvent.change(screen.getByLabelText(AUTH_COPY.usernameLabel), { target: { value: 'owner' } })
    const password = screen.getByLabelText(AUTH_COPY.passwordLabel)
    fireEvent.change(password, { target: { value: 'incorrect-password' } })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: AUTH_COPY.signIn })) })

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toBe(AUTH_COPY.incorrectAccountCredentials)
    expect(password.getAttribute('aria-describedby')).toBe('account-login-error')
  } finally {
    restore()
  }
})

test('a successful password fallback clears the callback error and opens the dashboard', async () => {
  window.history.replaceState(null, '', '/?authError=google-sign-in-failed')
  const restore = mockFetch((url, init) => {
    if (url.endsWith('/auth/session')) return jsonResponse({ authRequired: true, user: null })
    if (url.endsWith('/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    if (url.endsWith('/auth/providers')) return jsonResponse({ google: { enabled: true, startUrl: '/api/v1/auth/google/start' } })
    if (url.endsWith('/auth/login') && init?.method === 'POST') {
      return jsonResponse({ authRequired: true, user: { id: 'owner', name: 'owner', role: 'admin', authVersion: 0 } })
    }
    if (/\/api\/v1\/projects(?:\?|$)/.test(url)) return jsonResponse([])
    if (url.includes('/runs')) return jsonResponse([])
    return jsonResponse({})
  })
  try {
    render(<AuthGate />)
    await screen.findByRole('button', { name: AUTH_COPY.continueWithGoogle })
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.usePassword }))
    fireEvent.change(screen.getByLabelText(AUTH_COPY.usernameLabel), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText(AUTH_COPY.passwordLabel), { target: { value: 'a-long-enough-password' } })
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: AUTH_COPY.signIn })) })

    expect(await screen.findByRole('main')).toBeTruthy()
    expect(window.location.search).toBe('')
    expect(screen.queryByRole('heading', { name: AUTH_COPY.googleLinkFailedHeading })).toBeNull()
  } finally {
    restore()
  }
})

test('retrying Google does not preserve a stale callback error in returnTo', async () => {
  window.history.replaceState(null, '', '/?authError=google-sign-in-failed')
  let body: { returnTo?: string } | undefined
  const restore = mockFetch((url, init) => {
    if (url.endsWith('/auth/session')) return jsonResponse({ authRequired: true, user: null })
    if (url.endsWith('/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    if (url.endsWith('/auth/providers')) return jsonResponse({ google: { enabled: true, startUrl: '/api/v1/auth/google/start' } })
    if (url.endsWith('/auth/google/start')) {
      body = JSON.parse(String(init?.body)) as { returnTo?: string }
      return jsonResponse({ redirectUrl: 'https://accounts.example.test/continue' })
    }
    return jsonResponse({})
  })
  try {
    render(<AuthGate />)
    const button = await screen.findByRole('button', { name: AUTH_COPY.continueWithGoogle })
    await act(async () => { fireEvent.click(button) })
    expect(body).toEqual({ returnTo: '/' })
  } finally {
    restore()
  }
})
