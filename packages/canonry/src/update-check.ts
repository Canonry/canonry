import { createRequire } from 'node:module'
import { configExists, loadConfigRaw, saveConfigPatch } from './config.js'

const _require = createRequire(import.meta.url)
const { version: PKG_VERSION } = _require('../package.json') as { version: string }

const PKG_NAME = '@ainyc/canonry'
const NPM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PKG_NAME}/dist-tags`
const NPM_PACKAGE_URL = `https://www.npmjs.com/package/${PKG_NAME}`
const FETCH_TIMEOUT_MS = 1_500

export interface UpdateAvailable {
  current: string
  latest: string
  url: string
  upgradeCommand: string
}

/**
 * Opt-out gate. Mirrors telemetry's opt-out pattern so users get one mental
 * model for "no outbound calls": env var > config flag.
 *
 * Order: CANONRY_DISABLE_UPDATE_CHECK=1 > DO_NOT_TRACK=1 > CI > config.updateCheck === false
 */
export function isUpdateCheckEnabled(): boolean {
  if (process.env.CANONRY_DISABLE_UPDATE_CHECK === '1') return false
  if (process.env.DO_NOT_TRACK === '1') return false
  if (process.env.CI) return false

  if (!configExists()) return true

  try {
    const raw = loadConfigRaw()
    return raw?.updateCheck !== false
  } catch {
    return true
  }
}

/**
 * Compare two semver-shaped strings ("major.minor.patch" with optional
 * pre-release / build metadata which we ignore). Returns 1 if a > b,
 * -1 if a < b, 0 if equal. Anything we can't parse compares as equal so
 * we never falsely advertise an "upgrade" from a malformed registry response.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] | null => {
    const core = v.split(/[-+]/)[0]
    if (!core) return null
    const parts = core.split('.')
    if (parts.length < 3) return null
    const nums: number[] = []
    for (let i = 0; i < 3; i++) {
      const n = Number(parts[i])
      if (!Number.isInteger(n) || n < 0) return null
      nums.push(n)
    }
    return [nums[0]!, nums[1]!, nums[2]!]
  }

  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0

  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1
    if (pa[i]! < pb[i]!) return -1
  }
  return 0
}

/**
 * Fetch the latest published version from the npm registry's dist-tags
 * endpoint. Lightweight (returns just `{ latest, ... }`), no auth, no
 * rate limit for normal usage. Returns null on any failure — callers
 * must never block on this.
 */
export async function fetchLatestVersion(opts?: { timeoutMs?: number }): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? FETCH_TIMEOUT_MS)
  timeout.unref()

  try {
    const res = await fetch(NPM_DIST_TAGS_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { latest?: unknown }
    if (typeof data.latest !== 'string') return null
    return data.latest
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Returns the running CLI/server's package version. Single source of truth so
 * callers don't each re-import `package.json`.
 */
export function getCurrentVersion(): string {
  return PKG_VERSION
}

/**
 * Build an `UpdateAvailable` payload if `latest` is strictly newer than
 * `current`. Returns null when no upgrade is available or inputs are
 * malformed.
 */
export function buildUpdateAvailable(current: string, latest: string): UpdateAvailable | null {
  if (compareSemver(latest, current) <= 0) return null
  return {
    current,
    latest,
    url: NPM_PACKAGE_URL,
    upgradeCommand: `npm install -g ${PKG_NAME}`,
  }
}

/**
 * CLI-side check with on-disk TTL cache. Hits the npm registry at most once
 * per `ttlHours` (default 24). Returns `null` when disabled, cached as
 * up-to-date, or the registry call failed.
 *
 * Persists `lastUpdateCheckAt` (ISO timestamp) and `lastKnownLatestVersion`
 * to `~/.canonry/config.yaml`. The cached version is also returned (without
 * a fresh fetch) for in-cache windows so the banner stays consistent
 * between invocations.
 */
export async function checkLatestVersionForCli(opts?: {
  ttlHours?: number
  now?: () => Date
}): Promise<UpdateAvailable | null> {
  if (!isUpdateCheckEnabled()) return null
  if (!configExists()) return null

  const now = opts?.now ? opts.now() : new Date()
  const ttlMs = (opts?.ttlHours ?? 24) * 60 * 60 * 1000

  let raw
  try {
    raw = loadConfigRaw()
  } catch {
    return null
  }
  if (!raw) return null

  const lastCheckedAt = raw.lastUpdateCheckAt ? Date.parse(raw.lastUpdateCheckAt) : NaN
  const cachedLatest = typeof raw.lastKnownLatestVersion === 'string' ? raw.lastKnownLatestVersion : undefined

  if (Number.isFinite(lastCheckedAt) && now.getTime() - lastCheckedAt < ttlMs) {
    if (!cachedLatest) return null
    return buildUpdateAvailable(PKG_VERSION, cachedLatest)
  }

  const latest = await fetchLatestVersion()
  if (!latest) {
    // Refresh `lastUpdateCheckAt` even on failure so we don't hammer the
    // registry from a long-running process. Re-tries on the next interval.
    try {
      saveConfigPatch({ lastUpdateCheckAt: now.toISOString() })
    } catch {
      // best-effort
    }
    return null
  }

  try {
    saveConfigPatch({
      lastUpdateCheckAt: now.toISOString(),
      lastKnownLatestVersion: latest,
    })
  } catch {
    // best-effort
  }

  return buildUpdateAvailable(PKG_VERSION, latest)
}

interface MemoryCacheEntry {
  fetchedAt: number
  latest: string | null
}

let memoryCache: MemoryCacheEntry | null = null
let inFlight: Promise<void> | null = null

/**
 * For tests — flush any in-flight refresh, then wipe the in-memory cache used
 * by `checkLatestVersionForServer`. Async because pending refreshes may still
 * be writing to `memoryCache` and would otherwise pollute the next test.
 */
export async function resetServerUpdateCheckCache(): Promise<void> {
  if (inFlight) await inFlight
  memoryCache = null
  inFlight = null
}

/**
 * For tests — await the currently in-flight refresh (if any). Resolves
 * immediately when no refresh is running.
 */
export function awaitPendingServerRefresh(): Promise<void> {
  return inFlight ?? Promise.resolve()
}

function startBackgroundRefresh(getNow: () => number): void {
  if (inFlight) return
  inFlight = (async () => {
    try {
      const latest = await fetchLatestVersion()
      memoryCache = { fetchedAt: getNow(), latest }
    } catch {
      // fetchLatestVersion already swallows errors and returns null, but be
      // defensive — still mark the cache as fetched so we don't immediately
      // re-queue another attempt on the next call.
      memoryCache = { fetchedAt: getNow(), latest: null }
    } finally {
      inFlight = null
    }
  })()
}

/**
 * Server-side check used by the `/health` endpoint. Synchronous and
 * non-blocking — never awaits a network call, so it cannot exceed
 * load-balancer / Kubernetes probe budgets:
 *
 *   - Cold cache (server boot): returns `null` immediately, kicks off a
 *     background fetch. The next call (after the npm round-trip completes)
 *     will see the cached result. /health responses include `updateAvailable`
 *     once the cache warms up, typically within a second of boot.
 *   - Stale cache (>= TTL old): returns the cached value immediately, kicks
 *     off a background refresh. Subsequent calls see the new value.
 *   - Fresh cache: returns the cached value immediately, no I/O.
 *
 * Concurrent refresh attempts are deduplicated via an in-flight promise, so
 * a burst of /health probes during cold boot triggers a single npm call.
 */
export function checkLatestVersionForServer(opts?: {
  ttlMs?: number
  now?: () => number
}): UpdateAvailable | null {
  if (!isUpdateCheckEnabled()) return null

  const getNow = opts?.now ?? Date.now
  const ttl = opts?.ttlMs ?? 60 * 60 * 1000
  const now = getNow()

  if (!memoryCache || now - memoryCache.fetchedAt >= ttl) {
    startBackgroundRefresh(getNow)
  }

  if (!memoryCache || !memoryCache.latest) return null
  return buildUpdateAvailable(PKG_VERSION, memoryCache.latest)
}
