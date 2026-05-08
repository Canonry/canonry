import crypto from 'node:crypto'
import os from 'node:os'
import { loadConfig, saveConfigPatch, configExists } from './config.js'

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { version: VERSION } = _require('../package.json') as { version: string }

const TELEMETRY_ENDPOINT = 'https://ainyc.ai/api/telemetry'
const TIMEOUT_MS = 3_000

const ANON_ID_ENV_VAR = 'CANONRY_ANONYMOUS_ID'
const ANON_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TelemetryEvent {
  anonymousId: string
  event: string
  timestamp: string
  version: string
  nodeVersion: string
  os: string
  arch: string
  properties?: Record<string, string | number | boolean | string[]>
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
 * Fire a telemetry event. Non-blocking, fire-and-forget.
 * Never throws, never blocks the CLI.
 */
export function trackEvent(
  event: string,
  properties?: Record<string, string | number | boolean | string[]>,
): void {
  if (!isTelemetryEnabled()) return

  const anonymousId = getOrCreateAnonymousId()
  if (!anonymousId) return

  const payload: TelemetryEvent = {
    anonymousId,
    event,
    timestamp: new Date().toISOString(),
    version: VERSION,
    nodeVersion: process.versions.node,
    os: process.platform,
    arch: process.arch,
    properties,
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
