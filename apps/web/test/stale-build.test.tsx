import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '../src/components/layout/ErrorBoundary.js'
import { RELOAD_WINDOW_MS, isStaleBuildError, reloadForNewBuild } from '../src/lib/stale-build.js'

const KEY = 'canonry.stale-build-reload.v1'

beforeEach(() => sessionStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('recognizes a missing code file in every browser’s wording, and nothing else', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://example.com/canonry/assets/TrafficSourceDetailPage-old.js',
    'error loading dynamically imported module: https://example.com/canonry/assets/TrafficSourceDetailPage-old.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /canonry/assets/TrafficSourceDetailPage-old.css',
  ]) {
    expect(isStaleBuildError(new TypeError(message)), message).toBe(true)
  }
  expect(isStaleBuildError(new Error('Cannot read properties of undefined'))).toBe(false)
  expect(isStaleBuildError(null)).toBe(false)
})

test('reloads once, then not again until the window passes, so a missing file cannot loop', () => {
  const reload = vi.fn()
  const start = 1_800_000_000_000
  expect(reloadForNewBuild({ now: start, reload })).toBe(true)
  // The reload landed on a build that still lacks the file: stay put.
  expect(reloadForNewBuild({ now: start + 5_000, reload })).toBe(false)
  expect(reload).toHaveBeenCalledTimes(1)
  // The next deploy, later in the same tab, reloads again. A per-message guard
  // that never forgets is what left Safari tabs on the error screen.
  expect(reloadForNewBuild({ now: start + RELOAD_WINDOW_MS + 1, reload })).toBe(true)
  expect(reload).toHaveBeenCalledTimes(2)
})

test('does not reload without session storage, since nothing could stop a loop', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('storage disabled')
  })
  const reload = vi.fn()
  expect(reloadForNewBuild({ reload })).toBe(false)
  expect(reload).not.toHaveBeenCalled()
})

function Throws({ error }: { error: Error }): never {
  throw error
}

test('a page from the previous build asks for a reload instead of showing the raw error', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  // A reload already ran moments ago, so the screen stays with its button.
  sessionStorage.setItem(KEY, String(Date.now()))
  render(<ErrorBoundary><Throws error={new TypeError('Failed to fetch dynamically imported module: https://example.com/assets/TrafficSourceDetailPage-old.js')} /></ErrorBoundary>)
  expect(screen.getByRole('heading', { name: 'Canonry was updated' })).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Reload' })).not.toBeNull()
  expect(screen.queryByText(/Failed to fetch dynamically imported module/)).toBeNull()
})

test('a stale page with no recent reload starts one', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  render(<ErrorBoundary><Throws error={new TypeError('Importing a module script failed.')} /></ErrorBoundary>)
  // The guard records the reload it started.
  expect(Number(sessionStorage.getItem(KEY))).toBeGreaterThan(0)
})

test('any other error keeps the usual screen and starts no reload', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  render(<ErrorBoundary><Throws error={new Error('Cannot read properties of undefined')} /></ErrorBoundary>)
  expect(screen.getByRole('heading', { name: 'Something went wrong' })).not.toBeNull()
  expect(screen.getByText('Cannot read properties of undefined')).not.toBeNull()
  expect(sessionStorage.getItem(KEY)).toBeNull()
})
