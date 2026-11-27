/**
 * Recovering from a deploy that replaced the dashboard's code files.
 *
 * Every build names its code files by content hash, and a deploy removes the
 * old ones. A tab opened before the deploy still asks for the old names when
 * it opens a page it has not loaded yet, and that request fails. A reload
 * fetches the current index.html, which names the current files.
 *
 * TanStack Router's lazy routes already reload once on this error, but they
 * remember it per error message for the life of the tab. Safari's message names
 * no file, so after the first deploy every later one ends on the error screen,
 * and any browser does the same when one file fails twice. This guard is
 * time-based instead: one reload, then none for `RELOAD_WINDOW_MS`, so a file
 * that is really missing cannot loop.
 */

/** How each browser (and Vite, for a page's stylesheet) words a missing code file. */
const STALE_BUILD_MESSAGES = [
  'Failed to fetch dynamically imported module', // Chrome, Edge
  'error loading dynamically imported module', // Firefox
  'Importing a module script failed', // Safari
  'Unable to preload CSS for', // Vite
]

const RELOAD_KEY = 'canonry.stale-build-reload.v1'
export const RELOAD_WINDOW_MS = 30_000

export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return STALE_BUILD_MESSAGES.some((phrase) => message.includes(phrase))
}

/**
 * Reload to pick up the current build, at most once per `RELOAD_WINDOW_MS`.
 * Returns whether it reloaded. Without session storage there is no loop guard,
 * so it leaves the reload to the person.
 */
export function reloadForNewBuild(options: { now?: number; reload?: () => void } = {}): boolean {
  const now = options.now ?? Date.now()
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY))
    if (last > 0 && Math.abs(now - last) < RELOAD_WINDOW_MS) return false
    window.sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    return false
  }
  ;(options.reload ?? (() => window.location.reload()))()
  return true
}
