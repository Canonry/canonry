import crypto from 'node:crypto'
import { loadConfig, saveConfig, configExists } from './config.js'

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { version: VERSION } = _require('../package.json') as { version: string }

const TELEMETRY_ENDPOINT = 'https://ainyc.ai/api/telemetry'
const TIMEOUT_MS = 3_000

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
 * Returns undefined if config doesn't exist yet (pre-init).
 */
export function getOrCreateAnonymousId(): string | undefined {
  if (!configExists()) return undefined

  try {
    const config = loadConfig()
    if (config.anonymousId) return config.anonymousId

    const id = crypto.randomUUID()
    config.anonymousId = id
    saveConfig(config)
    return id
  } catch {
    return undefined
  }
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
