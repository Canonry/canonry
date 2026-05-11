import { test, expect, onTestFinished, describe, vi, afterEach } from 'vitest'

import React from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'

import { handleAuthExpired } from '../src/api.js'
import { AuthGate } from '../src/components/auth/AuthGate.js'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = handler as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const API_SESSION = '/api/v1/session'

function dashboardFallback(urlStr: string) {
  if (urlStr.includes('/projects')) return jsonResponse([])
  if (urlStr.includes('/runs')) return jsonResponse([])
  return jsonResponse({})
}

afterEach(() => {
  cleanup()
})

describe('AuthGate', () => {
  describe('initial auth state', () => {
    test('renders login form when session is unauthenticated', async () => {
      const restore = mockFetch((url) => {
        if (String(url).includes(API_SESSION)) return jsonResponse({ authenticated: false })
        return jsonResponse({})
      })
      onTestFinished(restore)

      render(<AuthGate />)
      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    })

    test('renders setup form when session returns setupRequired', async () => {
      const restore = mockFetch((url) => {
        if (String(url).includes(API_SESSION)) return jsonResponse({ authenticated: false, setupRequired: true })
        return jsonResponse({})
      })
      onTestFinished(restore)

      render(<AuthGate />)
      expect(await screen.findByText('Create a dashboard password')).toBeTruthy()
    })

    test('renders dashboard when session is authenticated', async () => {
      const restore = mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        return dashboardFallback(urlStr)
      })
      onTestFinished(restore)

      render(<AuthGate />)
      expect(await screen.findByText('Portfolio')).toBeTruthy()
    })

    test('shows connecting state while session check is pending', async () => {
      let resolveSession: (value: Response) => void
      const restore = mockFetch((url) => {
        if (String(url).includes(API_SESSION)) {
          return new Promise((resolve) => { resolveSession = resolve })
        }
        return jsonResponse({})
      })
      onTestFinished(restore)

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
      const restore = mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        return dashboardFallback(urlStr)
      })
      onTestFinished(restore)

      render(<AuthGate />)
      expect(await screen.findByText('Portfolio')).toBeTruthy()

      await act(async () => {
        handleAuthExpired()
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    })
  })

  describe('periodic session re-check', () => {
    test('transitions to login when interval check returns unauthenticated', async () => {
      // Use a mutable object for session so we can change responses mid-test
      const sessionState = { authenticated: true, setupRequired: false }

      const restore = mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse(sessionState)
        return dashboardFallback(urlStr)
      })
      onTestFinished(restore)

      vi.useFakeTimers({ shouldAdvanceTime: true })

      render(<AuthGate />)
      expect(await screen.findByText('Portfolio')).toBeTruthy()

      // Change the session state to unauthenticated
      sessionState.authenticated = false

      // Advance time past the re-check interval (60s)
      await act(async () => {
        vi.advanceTimersByTime(65_000)
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()

      vi.useRealTimers()
    })

    test('transitions to login when interval check fails with network error', async () => {
      const sessionState = { authenticated: true, setupRequired: false }
      let shouldThrow = false

      const restore = mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) {
          if (shouldThrow) throw new Error('Network error')
          return jsonResponse(sessionState)
        }
        return dashboardFallback(urlStr)
      })
      onTestFinished(restore)

      vi.useFakeTimers({ shouldAdvanceTime: true })

      render(<AuthGate />)
      expect(await screen.findByText('Portfolio')).toBeTruthy()

      shouldThrow = true

      await act(async () => {
        vi.advanceTimersByTime(65_000)
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()

      vi.useRealTimers()
    })
  })
})
