import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compareSemver, isStrictSemver } from '@ainyc/canonry-contracts'
import { configExists, loadConfigRaw, saveConfigPatch } from './config.js'

export { compareSemver }

const _require = createRequire(import.meta.url)
const { version: PKG_VERSION } = _require('../package.json') as { version: string }

const PKG_NAME = '@canonry/canonry'
const NPM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PKG_NAME}/dist-tags`
const NPM_PACKAGE_URL = `https://www.npmjs.com/package/${PKG_NAME}`
const FETCH_TIMEOUT_MS = 1_500

export interface UpdateAvailable {
  current: string
  latest: string
  url: string
  /** Tailored to `installMethod`: npm, Homebrew, or a container rebuild. */
  upgradeCommand: string
  installMethod: InstallMethod
}

export type InstallMethod = 'npm' | 'homebrew' | 'docker'

const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv']

/**
 * How this canonry was installed, so the upgrade instruction is one that
 * works. Homebrew installs live under `Cellar/canonry/` (the formula runs
 * `npm install` into its own libexec, so `npm install -g` would leave a second,
 * shadowed copy). Inside a container an in-place `npm install -g` is lost when
 * the container is recreated, so the image has to move instead.
 */
export function detectInstallMethod(opts?: {
  modulePath?: string
  exists?: (path: string) => boolean
}): InstallMethod {
  let modulePath = opts?.modulePath ?? fileURLToPath(import.meta.url)
  try {
    modulePath = fs.realpathSync(modulePath)
  } catch {
    // keep the unresolved path
  }
  if (modulePath.replace(/\\/g, '/').includes('/Cellar/canonry/')) return 'homebrew'
  const exists = opts?.exists ?? fs.existsSync
  if (CONTAINER_MARKERS.some((marker) => exists(marker))) return 'docker'
  return 'npm'
}

export function upgradeCommandFor(method: InstallMethod): string {
  switch (method) {
    case 'npm': return `npm install -g ${PKG_NAME}`
    case 'homebrew': return 'brew upgrade canonry'
    case 'docker': return 'pull or rebuild your canonry image, then recreate the container'
  }
}

let detectedInstallMethod: InstallMethod | undefined

function currentInstallMethod(): InstallMethod {
  detectedInstallMethod ??= detectInstallMethod()
  return detectedInstallMethod
}

export type UpdateCheckDisabledReason = 'CANONRY_DISABLE_UPDATE_CHECK' | 'DO_NOT_TRACK' | 'CI' | 'config'

/**
 * Opt-out gate. Mirrors telemetry's opt-out pattern so users get one mental
 * model for "no outbound calls": env var > config flag.
 *
 * Order: CANONRY_DISABLE_UPDATE_CHECK=1 > DO_NOT_TRACK=1 > CI > config.updateCheck === false
 */
export function isUpdateCheckEnabled(): boolean {
  return updateCheckDisabledReason() === null
}

/** The opt-out that disabled the update check, or null when it is enabled. */
export function updateCheckDisabledReason(): UpdateCheckDisabledReason | null {
  if (process.env.CANONRY_DISABLE_UPDATE_CHECK === '1') return 'CANONRY_DISABLE_UPDATE_CHECK'
  if (process.env.DO_NOT_TRACK === '1') return 'DO_NOT_TRACK'
  if (process.env.CI) return 'CI'

  if (!configExists()) return null

  try {
    return loadConfigRaw()?.updateCheck === false ? 'config' : null
  } catch {
    return null
  }
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
    // Strict shape only: the value is embedded in text agents act on.
    if (typeof data.latest !== 'string' || !isStrictSemver(data.latest)) return null
    return data.latest
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Build an `UpdateAvailable` payload if `latest` is strictly newer than
 * `current`. Returns null when no upgrade is available or inputs are
 * malformed.
 */
export function buildUpdateAvailable(
  current: string,
  latest: string,
  installMethod: InstallMethod = currentInstallMethod(),
): UpdateAvailable | null {
  // Re-validated here because cached values come from config.yaml too.
  if (!isStrictSemver(latest)) return null
  if (compareSemver(latest, current) <= 0) return null
  return {
    current,
    latest,
    url: NPM_PACKAGE_URL,
    upgradeCommand: upgradeCommandFor(installMethod),
    installMethod,
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

/**
 * Synchronous, network-free read of the on-disk cache written by
 * `checkLatestVersionForCli`. Lets the CLI print its update notice before the
 * command runs, so the notice can never interleave with command output.
 */
export function readCachedUpdateAvailable(): UpdateAvailable | null {
  if (!isUpdateCheckEnabled()) return null
  if (!configExists()) return null
  try {
    const cachedLatest = loadConfigRaw()?.lastKnownLatestVersion
    if (typeof cachedLatest !== 'string') return null
    return buildUpdateAvailable(PKG_VERSION, cachedLatest)
  } catch {
    return null
  }
}

/** Stable code agents can branch on, shared by the CLI notice and doctor. */
export const UPDATE_AVAILABLE_NOTICE_CODE = 'UPDATE_AVAILABLE'

/**
 * Render the update notice for stderr.
 *
 * - Interactive text output keeps the human banner.
 * - `--format json|jsonl` gets one compact JSON line, so a caller that merges
 *   stderr into stdout still reads a stream of valid JSON documents.
 * - Non-interactive text output (an agent shelling out) gets one plain line
 *   that names the versions, the upgrade command, and how to silence it.
 */
export function formatUpdateNotice(
  update: UpdateAvailable,
  opts: { format: 'text' | 'json' | 'jsonl'; interactive: boolean },
): string {
  if (opts.format === 'json' || opts.format === 'jsonl') {
    return `${JSON.stringify({
      notice: {
        code: UPDATE_AVAILABLE_NOTICE_CODE,
        current: update.current,
        latest: update.latest,
        installMethod: update.installMethod,
        upgradeCommand: update.upgradeCommand,
        url: update.url,
      },
    })}\n`
  }
  if (opts.interactive) {
    return (
      `\n→ canonry ${update.latest} is available (you have ${update.current}).\n` +
      `  Upgrade: ${update.upgradeCommand}\n\n`
    )
  }
  const upgrade = update.installMethod === 'docker'
    ? `Upgrade: ${update.upgradeCommand}.`
    : `Upgrade with \`${update.upgradeCommand}\`, then restart any running \`canonry serve\`.`
  return (
    `[canonry] ${UPDATE_AVAILABLE_NOTICE_CODE}: canonry ${update.latest} is available (installed ${update.current}). ` +
    `${upgrade} Silence with CANONRY_DISABLE_UPDATE_CHECK=1.\n`
  )
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

export interface UpdateStatus {
  /** False when an opt-out (env, CI, or config) disabled the check. */
  enabled: boolean
  disabledBy?: UpdateCheckDisabledReason
  current: string
  /** Newest published version known to this process, or null when never fetched. */
  latest: string | null
  installMethod: InstallMethod
  upgradeCommand: string
  url: string
}

/**
 * Server-side status for the `canonry.version.current` doctor check.
 * Non-blocking like `checkLatestVersionForServer` (and kicks the same
 * background refresh). Falls back to the CLI's on-disk cache so a doctor call
 * right after boot, before the first registry round-trip lands, still knows
 * the latest version.
 */
export function getServerUpdateStatus(opts?: { ttlMs?: number; now?: () => number }): UpdateStatus {
  const installMethod = currentInstallMethod()
  const base = { current: PKG_VERSION, installMethod, upgradeCommand: upgradeCommandFor(installMethod), url: NPM_PACKAGE_URL }
  const disabledBy = updateCheckDisabledReason()
  if (disabledBy) return { ...base, enabled: false, disabledBy, latest: null }

  checkLatestVersionForServer(opts)
  let latest = memoryCache?.latest ?? null
  if (!latest && configExists()) {
    try {
      const cached = loadConfigRaw()?.lastKnownLatestVersion
      if (typeof cached === 'string') latest = cached
    } catch {
      // best-effort
    }
  }
  return { ...base, enabled: true, latest: latest && isStrictSemver(latest) ? latest : null }
}
