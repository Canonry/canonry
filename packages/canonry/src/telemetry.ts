import crypto from 'node:crypto'
import os from 'node:os'
import { loadConfig, saveConfigPatch, configExists, loadConfigRaw } from './config.js'

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { version: VERSION } = _require('../package.json') as { version: string }

const TELEMETRY_ENDPOINT = 'https://ainyc.ai/api/telemetry'
const TIMEOUT_MS = 3_000

const ANON_ID_ENV_VAR = 'CANONRY_ANONYMOUS_ID'
const ANON_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Surface that emitted the event. Lets us slice metrics by origin instead of
 * inferring from event names. The CLI process defaults to `'cli'`; long-lived
 * `canonry serve` switches itself to `'cli-server'` so dashboard/API-driven
 * runs can be told apart from one-shot `canonry run` invocations.
 *
 * Future surfaces (`'wp-plugin'`, `'mcp-server'`, `'api'`, `'dashboard'`,
 * `'agent-runtime'`) are reserved here so receivers can validate against a
 * stable enum even before each emitter exists.
 */
export type TelemetrySource =
  | 'cli'
  | 'cli-server'
  | 'api'
  | 'mcp-server'
  | 'wp-plugin'
  | 'dashboard'
  | 'agent-runtime'

/**
 * Free-shape JSON-serializable property bag. Nested objects are allowed for
 * grouped fields like `phases` (run.completed) and `setupState` (cli.command).
 * Non-JSON values (functions, symbols) silently drop in `JSON.stringify`.
 */
export type TelemetryProperties = Record<string, unknown>

export interface TelemetryEvent {
  /** Stable per-install UUID stored in `~/.canonry/config.yaml`. */
  anonymousId: string
  /** Per-process UUID — groups the events from one CLI invocation or one
   *  server boot together so a single user-session can be reconstructed. */
  sessionId: string
  /** Origin surface; see `TelemetrySource`. */
  source: TelemetrySource
  /** Optional sub-source ("php/8.2 wp-cron", "claude-desktop"). */
  sourceContext?: string
  /** Event name (`'cli.command'`, `'run.completed'`, …). */
  event: string
  /** ISO-8601 timestamp at emission time. */
  timestamp: string
  /** Canonry CLI version. */
  version: string
  nodeVersion: string
  os: string
  arch: string
  /** Stable error classifier when the event represents a failure. */
  errorCode?: string
  /**
   * Cloud-mode tag (Track 1). Present only when
   * `CANONRY_RUNTIME_MODE=cloud` is set on the tenant container. Lets the
   * telemetry receiver filter cloud-runtime emissions from OSS noise.
   * Absent in OSS deployments.
   */
  runtimeMode?: 'cloud'
  /** Free-shape per-event payload. */
  properties?: TelemetryProperties
}

/**
 * Read at module load so it doesn't change between events in one process —
 * env vars don't mutate at runtime in either deployment shape.
 */
const RUNTIME_MODE_TAG: 'cloud' | undefined =
  process.env.CANONRY_RUNTIME_MODE?.trim().toLowerCase() === 'cloud' ? 'cloud' : undefined

export interface TrackEventOptions {
  /** Override the global default source — used by `canonry serve` to flip
   *  to `'cli-server'` and by tests. */
  source?: TelemetrySource
  /** Free-form sub-source for finer attribution. */
  sourceContext?: string
  /** Stable error classifier (see `RUN_ERROR_CODES` etc. in callers). */
  errorCode?: string
}

// ── Per-process state ──────────────────────────────────────────────────

const SESSION_ID = crypto.randomUUID()
let CURRENT_SOURCE: TelemetrySource = 'cli'

/**
 * Override the global default source for subsequent `trackEvent` calls.
 * Callers can still pass `options.source` to override per-event.
 */
export function setTelemetrySource(source: TelemetrySource): void {
  CURRENT_SOURCE = source
}

/**
 * Check whether telemetry is enabled.
 * Priority: env vars > config file. Disabled in CI by default.
 */
export function isTelemetryEnabled(): boolean {
  if (process.env.CANONRY_TELEMETRY_DISABLED === '1') return false
  if (process.env.DO_NOT_TRACK === '1') return false
  if (process.env.CI) return false

  if (!configExists()) return true

  try {
    const config = loadConfig()
    return config.telemetry !== false
  } catch {
    return true
  }
}

/**
 * Get or create the anonymous install ID.
 *
 * Resolution order:
 *   1. CANONRY_ANONYMOUS_ID env var — lets harnesses (e.g. a WordPress
 *      plugin spawning canonry from PHP) pin a stable ID per install.
 *   2. anonymousId from ~/.canonry/config.yaml — the normal path.
 *   3. A new UUID, persisted back to config.yaml on first run.
 *   4. A deterministic machine-derived fallback — used when config does
 *      not exist or cannot be persisted (no $HOME, ephemeral container,
 *      read-only fs). Without this, every invocation in such an
 *      environment would emit a brand-new UUID and poison telemetry.
 *
 * Returns undefined only if every fallback fails (should not happen in
 * practice — `os.hostname()` always returns something).
 */
export function getOrCreateAnonymousId(): string | undefined {
  const fromEnv = readEnvAnonymousId()
  if (fromEnv) return fromEnv

  if (configExists()) {
    try {
      const config = loadConfig()
      if (config.anonymousId) return config.anonymousId

      const id = crypto.randomUUID()
      config.anonymousId = id
      try {
        saveConfigPatch(config)
      } catch {
        // Config exists but can't be written (read-only fs, permission denied).
        // Fall through to the deterministic fallback so we still emit a stable ID.
        return getDeterministicAnonymousId()
      }
      return id
    } catch {
      return getDeterministicAnonymousId()
    }
  }

  return getDeterministicAnonymousId()
}

function readEnvAnonymousId(): string | undefined {
  const raw = process.env[ANON_ID_ENV_VAR]?.trim()
  if (!raw) return undefined
  if (!ANON_ID_PATTERN.test(raw)) {
    // Invalid format — silently ignore so a typo doesn't poison the dataset
    // with arbitrary strings. UUIDs only.
    return undefined
  }
  return raw.toLowerCase()
}

/**
 * Derive a stable per-machine ID from `os.hostname()` and the first non-internal
 * MAC address. Same machine → same ID, so telemetry from a WP plugin running
 * canonry as a subprocess in an ephemeral container collapses to one ID per
 * host instead of one per invocation.
 *
 * Formatted as a UUIDv5-shaped string (8-4-4-4-12 hex) for compatibility with
 * downstream pipelines that validate UUID shape. Not a real UUID — set the
 * version nibble to "5" (name-based) just to keep parsers happy.
 */
function getDeterministicAnonymousId(): string | undefined {
  try {
    const hostname = os.hostname() || ''
    const mac = firstNonInternalMac()
    const seed = `canonry-anon:${hostname}:${mac}`
    const hex = crypto.createHash('sha256').update(seed).digest('hex')
    // Reformat the first 32 hex chars as 8-4-4-4-12, with the UUID version
    // nibble set to 5 so consumers that validate UUID shape accept it.
    const a = hex.slice(0, 8)
    const b = hex.slice(8, 12)
    const c = '5' + hex.slice(13, 16)
    // Variant nibble (8-b) for RFC 4122 compatibility
    const dHi = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
    const d = dHi + hex.slice(18, 20)
    const e = hex.slice(20, 32)
    return `${a}-${b}-${c}-${d}-${e}`
  } catch {
    return undefined
  }
}

function firstNonInternalMac(): string {
  try {
    const interfaces = os.networkInterfaces()
    for (const ifaces of Object.values(interfaces)) {
      if (!ifaces) continue
      for (const iface of ifaces) {
        if (iface.internal) continue
        if (!iface.mac || iface.mac === '00:00:00:00:00:00') continue
        return iface.mac
      }
    }
  } catch {
    // ignore — fall through to constant
  }
  return 'no-mac'
}

/**
 * Returns true if this is the first time telemetry runs (no anonymousId yet).
 * Used to show the first-run notice.
 */
export function isFirstRun(): boolean {
  if (!configExists()) return false
  try {
    const config = loadConfig()
    return !config.anonymousId
  } catch {
    return false
  }
}

/**
 * Print the first-run telemetry notice to stderr.
 */
export function showFirstRunNotice(): void {
  process.stderr.write(
    '\nCanonry collects anonymous telemetry to prioritize features.\n' +
    'Disable any time: canonry telemetry disable\n' +
    'Learn more: https://ainyc.ai/telemetry\n\n',
  )
}

/**
 * If the on-disk `lastSeenVersion` differs from the current build, emit a
 * `cli.upgraded` event with `{ fromVersion, toVersion }` and persist the new
 * version. No-op when telemetry is disabled, no config exists, or the version
 * is unchanged. Idempotent: subsequent calls in the same process will not
 * re-emit because the config has been updated.
 */
export function detectAndTrackUpgrade(): void {
  if (!isTelemetryEnabled()) return
  if (!configExists()) return

  let lastSeen: string | undefined
  try {
    const raw = loadConfigRaw()
    lastSeen = raw?.lastSeenVersion
  } catch {
    return
  }

  if (lastSeen === VERSION) return

  // Persist the new version first so a thrown trackEvent never reverts state.
  try {
    saveConfigPatch({ lastSeenVersion: VERSION })
  } catch {
    return
  }

  // Skip the event itself on a fresh install (no prior version recorded);
  // we already have `cli.init` for that. Only emit on an actual upgrade.
  if (!lastSeen) return

  trackEvent('cli.upgraded', { fromVersion: lastSeen, toVersion: VERSION })
}

/**
 * Fire a telemetry event. Non-blocking, fire-and-forget.
 * Never throws, never blocks the CLI.
 */
export function trackEvent(
  event: string,
  properties?: TelemetryProperties,
  options?: TrackEventOptions,
): void {
  if (!isTelemetryEnabled()) return

  const anonymousId = getOrCreateAnonymousId()
  if (!anonymousId) return

  const payload: TelemetryEvent = {
    anonymousId,
    sessionId: SESSION_ID,
    source: options?.source ?? CURRENT_SOURCE,
    event,
    timestamp: new Date().toISOString(),
    version: VERSION,
    nodeVersion: process.versions.node,
    os: process.platform,
    arch: process.arch,
    ...(options?.sourceContext ? { sourceContext: options.sourceContext } : {}),
    ...(options?.errorCode ? { errorCode: options.errorCode } : {}),
    ...(RUNTIME_MODE_TAG ? { runtimeMode: RUNTIME_MODE_TAG } : {}),
    ...(properties ? { properties } : {}),
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timeout.unref() // Don't keep the process alive waiting for telemetry

  fetch(TELEMETRY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timeout))
}
