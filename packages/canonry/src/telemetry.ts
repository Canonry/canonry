import crypto from 'node:crypto'
import os from 'node:os'
import {
  isGhostTelemetryEvent,
  maskTelemetryAnonymousId,
  type TelemetryStatusDto,
} from '@ainyc/canonry-contracts'
import { loadConfig, saveConfigPatch, configExists, loadConfigRaw } from './config.js'
import type { SetupState } from './setup-state.js'
import { cliRuntimeContext } from './runtime-context.js'

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { version: VERSION } = _require('../package.json') as { version: string }

const TELEMETRY_ENDPOINT = 'https://canonry.ai/api/telemetry'
const TIMEOUT_MS = 3_000

const ANON_ID_ENV_VAR = 'CANONRY_ANONYMOUS_ID'
const ANON_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Surface that emitted the event. Lets us slice metrics by origin instead of
 * inferring from event names. The CLI process defaults to `'cli'`; long-lived
 * `canonry serve` switches itself to `'cli-server'` so dashboard/API-driven
 * runs can be told apart from one-shot `canonry run` invocations.
 *
 * Dashboard setup events are forwarded through the local API with an explicit
 * `'dashboard'` override. The other future surfaces remain reserved so
 * receivers can validate against a stable enum before each emitter exists.
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
 * grouped fields like `phases` (run.completed) and `setup_state` (cli.command).
 * Non-JSON values (functions, symbols) silently drop in `JSON.stringify`.
 */
export type TelemetryProperties = Record<string, unknown>

export interface TelemetryEvent {
  /** Unique UUID for receiver-side retry/deduplication. */
  eventId: string
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
  /** Free-shape per-event payload. */
  properties?: TelemetryProperties
}

export interface TrackEventOptions {
  /** Caller-generated idempotency key, used by forwarded browser events. */
  eventId?: string
  /** Override the global default source — used by `canonry serve` to flip
   *  to `'cli-server'` and by tests. */
  source?: TelemetrySource
  /** Free-form sub-source for finer attribution. */
  sourceContext?: string
  /** Stable error classifier (see `RUN_ERROR_CODES` etc. in callers). */
  errorCode?: string
}

export type CliCommandDurationBucket =
  | 'under_1s'
  | '1s_to_10s'
  | '10s_to_1m'
  | '1m_to_5m'
  | '5m_to_30m'
  | '30m_or_more'

export interface CliCommandFinishedInput {
  /** Registered command path (`wordpress.schema.deploy`), never raw argv. */
  command: string
  success: boolean
  durationMs: number
  setupState?: SetupState
  /** Stable `CliError.code`; raw error text must never be sent. */
  errorCode?: string
}

export function shouldDropTelemetryEvent(
  event: string,
  properties?: TelemetryProperties,
): boolean {
  return isGhostTelemetryEvent(event, properties)
}

/**
 * Low-cardinality command duration. Buckets preserve enough resolution to
 * distinguish fast reads, setup friction, and long-running jobs without
 * transmitting an exact behavioral timestamp.
 */
export function bucketCliCommandDuration(durationMs: number): CliCommandDurationBucket {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
  if (duration < 1_000) return 'under_1s'
  if (duration < 10_000) return '1s_to_10s'
  if (duration < 60_000) return '10s_to_1m'
  if (duration < 300_000) return '1m_to_5m'
  if (duration < 1_800_000) return '5m_to_30m'
  return '30m_or_more'
}

/**
 * Emit the terminal half of a CLI command lifecycle. The caller builds setup
 * state after command execution so successful and partially-applied commands
 * can be distinguished from no-progress failures.
 */
export function trackCliCommandFinished(input: CliCommandFinishedInput): void {
  trackEvent(
    'cli.command.finished',
    {
      command: input.command,
      success: input.success,
      duration_bucket: bucketCliCommandDuration(input.durationMs),
      ...(input.setupState ? { setup_state: input.setupState } : {}),
      ...cliRuntimeContext(),
    },
    input.errorCode ? { errorCode: input.errorCode } : undefined,
  )
}

// ── Per-process state ──────────────────────────────────────────────────

const SESSION_ID = crypto.randomUUID()
let CURRENT_SOURCE: TelemetrySource = 'cli'

const TELEMETRY_SOURCE_VALUES: ReadonlySet<string> = new Set([
  'cli', 'cli-server', 'api', 'mcp-server', 'wp-plugin', 'dashboard', 'agent-runtime',
] satisfies TelemetrySource[])

/**
 * Harness-declared source, e.g. `CANONRY_TELEMETRY_SOURCE=wp-plugin` set by a
 * hosting automation that spawns this CLI.
 *
 * WHY AN ENV VAR: the biggest pollution in the install metrics is subprocess
 * invocations minting install IDs that look human. The spawn site is outside
 * this repo (a WordPress host's cron, a CI harness), so the only lever we can
 * offer it is self-identification, the same way `CANONRY_ANONYMOUS_ID` already
 * lets a harness pin a stable install ID. A tagged source lets the pipeline
 * exclude that traffic exactly instead of guessing from behavior.
 *
 * Validated against the enum and read at event time, so an unknown value is
 * ignored rather than poisoning the receiver's source field. It wins over the
 * process default AND over `setTelemetrySource`, because what spawned the
 * process outranks what the process believes it is: a wp-plugin harness that
 * runs `canonry serve` is still wp-plugin traffic.
 */
function envSourceOverride(): TelemetrySource | undefined {
  const raw = process.env.CANONRY_TELEMETRY_SOURCE?.trim()
  return raw && TELEMETRY_SOURCE_VALUES.has(raw) ? (raw as TelemetrySource) : undefined
}

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
export interface TelemetryStatusResolutionInput {
  canonryTelemetryDisabled?: string
  doNotTrack?: string
  ci?: string
  configuredEnabled: boolean
  configState: 'present' | 'absent' | 'unavailable'
  anonymousId?: string
}

/**
 * Resolve environment policy and persisted preference without performing I/O.
 * Environment opt-outs deliberately win in the same order used by event
 * emission, so status and collection cannot disagree.
 */
export function resolveTelemetryStatus(input: TelemetryStatusResolutionInput): TelemetryStatusDto {
  const base = {
    configuredEnabled: input.configuredEnabled,
    ...(input.anonymousId ? { anonymousId: maskAnonymousId(input.anonymousId) } : {}),
    target: 'local' as const,
  }
  if (input.canonryTelemetryDisabled === '1') {
    return { ...base, enabled: false, reason: 'CANONRY_TELEMETRY_DISABLED' }
  }
  if (input.doNotTrack === '1') {
    return { ...base, enabled: false, reason: 'DO_NOT_TRACK' }
  }
  if (input.ci) return { ...base, enabled: false, reason: 'CI' }
  if (!input.configuredEnabled) return { ...base, enabled: false, reason: 'configured_disabled' }
  if (input.configState === 'absent') return { ...base, enabled: true, reason: 'NO_CONFIG' }
  if (input.configState === 'unavailable') return { ...base, enabled: true, reason: 'CONFIG_UNAVAILABLE' }
  return { ...base, enabled: true, reason: 'enabled' }
}

/** Mask an install identifier before it can reach a status response or CLI. */
export function maskAnonymousId(value: string | undefined): string | undefined {
  return maskTelemetryAnonymousId(value)
}

/**
 * Inspect telemetry state without generating or persisting an anonymous ID.
 * A missing preference retains the legacy local default of enabled.
 */
export function getTelemetryStatus(): TelemetryStatusDto {
  const env = {
    canonryTelemetryDisabled: process.env.CANONRY_TELEMETRY_DISABLED,
    doNotTrack: process.env.DO_NOT_TRACK,
    ci: process.env.CI,
  }
  if (!configExists()) {
    return resolveTelemetryStatus({ ...env, configuredEnabled: true, configState: 'absent' })
  }
  try {
    const config = loadConfig()
    return resolveTelemetryStatus({
      ...env,
      configuredEnabled: config.telemetry !== false,
      configState: 'present',
      anonymousId: config.anonymousId,
    })
  } catch {
    return resolveTelemetryStatus({ ...env, configuredEnabled: true, configState: 'unavailable' })
  }
}

export function isTelemetryEnabled(): boolean {
  return getTelemetryStatus().enabled
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
    'Learn more: https://canonry.ai/telemetry\n\n',
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
  void deliverEvent(event, properties, options)
}

export type TelemetryPreferenceMethod = 'cli' | 'api'

/**
 * Persist the telemetry preference, announcing an opt-out first.
 *
 * `telemetry.disabled` is the last event an install sends. Without it an
 * opt-out is indistinguishable from a user who stopped using Canonry, so the
 * opt-out rate cannot be measured and every retention figure silently absorbs
 * it. Whether to announce is decided while telemetry is still on, before the
 * preference is written; the event is sent only after the write succeeds, so an
 * opt-out that could not be persisted (read-only config) is never announced and
 * a retry cannot announce it twice. It carries only how the preference changed.
 *
 * Nothing is sent when telemetry is already effectively off, including when an
 * environment override (CI, DO_NOT_TRACK, CANONRY_TELEMETRY_DISABLED) wins, so
 * re-running `disable` never counts twice.
 *
 * The write is synchronous; the returned promise tracks only delivery. The
 * server ignores it, and the CLI awaits it so process exit cannot drop the one
 * event that can never be retried.
 */
export function setTelemetryPreference(enabled: boolean, method: TelemetryPreferenceMethod): Promise<void> {
  const announce = !enabled && isTelemetryEnabled()
  saveConfigPatch({ telemetry: enabled })
  return announce
    ? deliverEvent('telemetry.disabled', { method }, undefined, { preferenceChecked: true })
    : Promise.resolve()
}

/** Compose and send one event. Settles when the collector answers or the timeout aborts; never rejects. */
function deliverEvent(
  event: string,
  properties?: TelemetryProperties,
  options?: TrackEventOptions,
  delivery: { preferenceChecked?: boolean } = {},
): Promise<void> {
  // `preferenceChecked`: the caller already confirmed telemetry was on before
  // it wrote the opt-out that would otherwise suppress this final event.
  if (!delivery.preferenceChecked && !isTelemetryEnabled()) return Promise.resolve()
  if (shouldDropTelemetryEvent(event, properties)) return Promise.resolve()

  const anonymousId = getOrCreateAnonymousId()
  if (!anonymousId) return Promise.resolve()

  const payload: TelemetryEvent = {
    eventId: options?.eventId ?? crypto.randomUUID(),
    anonymousId,
    sessionId: SESSION_ID,
    source: options?.source ?? envSourceOverride() ?? CURRENT_SOURCE,
    event,
    timestamp: new Date().toISOString(),
    version: VERSION,
    nodeVersion: process.versions.node,
    os: process.platform,
    arch: process.arch,
    ...(options?.sourceContext ? { sourceContext: options.sourceContext } : {}),
    ...(options?.errorCode ? { errorCode: options.errorCode } : {}),
    ...(properties ? { properties } : {}),
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timeout.unref() // Don't keep the process alive waiting for telemetry

  try {
    return fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(() => undefined, () => undefined)
      .finally(() => clearTimeout(timeout))
  } catch {
    // A custom fetch implementation can throw synchronously. Telemetry must
    // still never affect the command's result or keep its timeout alive.
    clearTimeout(timeout)
    return Promise.resolve()
  }
}
