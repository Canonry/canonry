/**
 * Shared vitest setup — runs once per worker before any test imports.
 *
 * Wired into every package's `vitest.config.ts` via:
 *   setupFiles: ['../../test-setup/vitest-defaults.ts']
 *
 * Hardens the test environment against accidental side effects:
 *   1. Disables canonry telemetry. Even packages that don't import the
 *      telemetry module benefit — invokeCli-style tests sometimes pull
 *      in code paths that fire `cli.command` events.
 *   2. Replaces `globalThis.fetch` with a guard that throws on any
 *      non-localhost request, so a test that forgets to mock fetch
 *      can't silently hit the real internet.
 *
 * The fetch guard is compatible with the standard save-and-restore
 * pattern (`const orig = globalThis.fetch; globalThis.fetch = mockFn; ...; globalThis.fetch = orig`)
 * — tests capture this guard as `orig`, install their mock, and put
 * the guard back on cleanup. The guard stays in effect between tests.
 */

process.env.CANONRY_TELEMETRY_DISABLED = '1'

const TELEMETRY_HOSTS = new Set([
  'ainyc.ai',
  'www.ainyc.ai',
])

const realFetch = globalThis.fetch

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost')
  )
}

function urlOf(input: string | URL | Request): URL | null {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url)
  } catch {
    return null
  }
  return null
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = urlOf(input)
  if (url) {
    if (TELEMETRY_HOSTS.has(url.hostname)) {
      throw new Error(
        `[test] Blocked telemetry request to ${url.href}. ` +
        `Tests must mock globalThis.fetch when exercising trackEvent — see test-setup/vitest-defaults.ts.`,
      )
    }
    if (!isLocalHost(url.hostname)) {
      throw new Error(
        `[test] Blocked external network request to ${url.href}. ` +
        `Tests must not hit external services. Mock globalThis.fetch or stub the client.`,
      )
    }
  }
  return realFetch(input as Parameters<typeof realFetch>[0], init)
}) as typeof globalThis.fetch
