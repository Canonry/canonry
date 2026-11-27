import { afterEach, expect, onTestFinished, test, vi } from 'vitest'

import {
  GOOGLE_OAUTH_COMPLETE_MESSAGE,
  UNEXPECTED_OAUTH_URL_MESSAGE,
  startGoogleOAuthPopup,
} from '../src/lib/google-oauth-popup.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test'
const CALLBACK_ORIGIN = 'http://localhost:4100'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mockConnect(response: { authUrl: string; redirectUri?: string }) {
  const bodies: unknown[] = []
  const restore = mockFetch((url, init) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/google/connect') && init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)))
      return jsonResponse(response)
    }
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restore)
  return bodies
}

function post(source: unknown, origin: string, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { source: source as Window, origin, data }))
}

const complete = (connectionType: string) => ({ type: GOOGLE_OAUTH_COMPLETE_MESSAGE, connectionType })

test('accepts only the matching message from the opened popup at the callback origin, once', async () => {
  const bodies = mockConnect({ authUrl: AUTH_URL, redirectUri: `${CALLBACK_ORIGIN}/api/v1/google/callback` })
  const popup = { closed: false }
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const onFinished = vi.fn()

  await expect(startGoogleOAuthPopup('test-project', 'gbp', onFinished)).resolves.toBe('popup')
  expect(open).toHaveBeenCalledWith(AUTH_URL, '_blank', 'width=600,height=700')
  expect(bodies).toEqual([expect.objectContaining({ type: 'gbp' })])

  // Each of these differs from a valid completion in exactly one check.
  post({ closed: false }, CALLBACK_ORIGIN, complete('gbp')) // another window
  post(popup, 'https://evil.example', complete('gbp')) // another origin
  post(popup, CALLBACK_ORIGIN, complete('gsc')) // another connection type
  post(popup, CALLBACK_ORIGIN, { type: 'something-else', connectionType: 'gbp' }) // another message
  post(popup, CALLBACK_ORIGIN, GOOGLE_OAUTH_COMPLETE_MESSAGE) // not an object
  post(popup, CALLBACK_ORIGIN, null)
  expect(onFinished).not.toHaveBeenCalled()

  post(popup, CALLBACK_ORIGIN, complete('gbp'))
  expect(onFinished).toHaveBeenCalledTimes(1)
  expect(onFinished).toHaveBeenCalledWith(true)

  // The listener is gone once finished.
  post(popup, CALLBACK_ORIGIN, complete('gbp'))
  expect(onFinished).toHaveBeenCalledTimes(1)
})

test("falls back to the page's own origin when the server sends no redirect URI", async () => {
  mockConnect({ authUrl: AUTH_URL })
  const popup = { closed: false }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const onFinished = vi.fn()

  await startGoogleOAuthPopup('test-project', 'gsc', onFinished)
  post(popup, CALLBACK_ORIGIN, complete('gsc'))
  expect(onFinished).not.toHaveBeenCalled()
  post(popup, window.location.origin, complete('gsc'))
  expect(onFinished).toHaveBeenCalledWith(true)
})

test('refuses an auth URL that is not Google and opens nothing', async () => {
  mockConnect({ authUrl: 'https://accounts.google.com.evil.example/o/oauth2/v2/auth', redirectUri: `${CALLBACK_ORIGIN}/cb` })
  const open = vi.spyOn(window, 'open')
  const onFinished = vi.fn()

  await expect(startGoogleOAuthPopup('test-project', 'gbp', onFinished)).rejects.toThrow(UNEXPECTED_OAUTH_URL_MESSAGE)
  expect(open).not.toHaveBeenCalled()
  expect(onFinished).not.toHaveBeenCalled()
})

test('a blocked popup navigates this page to Google and listens for nothing', async () => {
  mockConnect({ authUrl: AUTH_URL, redirectUri: `${CALLBACK_ORIGIN}/cb` })
  vi.spyOn(window, 'open').mockReturnValue(null)
  const addListener = vi.spyOn(window, 'addEventListener')
  const onFinished = vi.fn()

  // jsdom cannot follow the cross-origin navigation (and `location.assign`
  // cannot be spied on), so this pins the result and the absent listener.
  await expect(startGoogleOAuthPopup('test-project', 'gbp', onFinished)).resolves.toBe('redirect')
  expect(addListener).not.toHaveBeenCalledWith('message', expect.anything())
  expect(onFinished).not.toHaveBeenCalled()
})

test('a popup closed without completing reports false once and stops listening', async () => {
  mockConnect({ authUrl: AUTH_URL, redirectUri: `${CALLBACK_ORIGIN}/cb` })
  const popup = { closed: false }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const onFinished = vi.fn()

  // Only the closed-popup poll is faked; the connect fetch stays real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

  await startGoogleOAuthPopup('test-project', 'gbp', onFinished)
  vi.advanceTimersByTime(1000)
  expect(onFinished).not.toHaveBeenCalled()

  popup.closed = true
  vi.advanceTimersByTime(1000)
  expect(onFinished).toHaveBeenCalledTimes(1)
  expect(onFinished).toHaveBeenCalledWith(false)

  vi.advanceTimersByTime(5000)
  post(popup, CALLBACK_ORIGIN, complete('gbp'))
  expect(onFinished).toHaveBeenCalledTimes(1)
})
