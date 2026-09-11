import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AuthGate } from '../src/components/auth/AuthGate.js'
import { AUTH_COPY } from '../src/components/auth/auth-copy.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/') })

test.each([true, false])('invitation callback failure stays visible with an existing session: %s', async signedIn => {
  const user = { id: crypto.randomUUID(), name: crypto.randomUUID(), role: 'admin', authVersion: 0 }
  window.history.replaceState(null, '', '/?authError=google-invitation-failed')
  const restore = mockFetch(url => {
    if (url.endsWith('/auth/session')) return jsonResponse({ authRequired: true, user: signedIn ? user : null })
    if (url.endsWith('/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    if (url.endsWith('/auth/providers')) return jsonResponse({ google: { enabled: true, startUrl: '/api/v1/auth/google/start' } })
    return jsonResponse([])
  })
  try {
    render(<AuthGate />)
    expect((await screen.findByRole('alert')).textContent).toBe(AUTH_COPY.invitationFailed)
    expect(screen.queryByRole('main')).toBeNull()
    expect(screen.queryByLabelText(AUTH_COPY.passwordLabel)).toBeNull()
    expect(screen.queryByRole('button', { name: AUTH_COPY.continueWithGoogle })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  } finally { restore() }
})
