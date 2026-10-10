import fs from 'node:fs'
import path from 'node:path'
import { classifyOutcomeError, OutcomeReasonCodes, OutcomeTriggers, type OutcomeReasonCode } from '@ainyc/canonry-contracts'
import { getConfigDir } from './config.js'
import { trackFeatureCompleted } from './outcome-telemetry.js'
import { isTelemetryEnabled } from './telemetry.js'

const CRASH_MARKER = 'crash-telemetry.json'
const MAX_MARKER_AGE_MS = 7 * 24 * 60 * 60 * 1000

function telemetryAllowed(): boolean {
  try {
    return isTelemetryEnabled()
  } catch {
    return false
  }
}

function markerPath(configDir: string): string {
  return path.join(configDir, CRASH_MARKER)
}

/** Why the server failed to start, from the error that stopped it; never its message. */
export function trackServerStartFailure(err: unknown, reasonCode?: OutcomeReasonCode): void {
  try {
    const classified = classifyOutcomeError(err)
    const code = (err as { code?: unknown } | null)?.code
    const reason = reasonCode ?? (code === 'EADDRINUSE' ? OutcomeReasonCodes.PORT_IN_USE : classified.reasonCode)
    trackFeatureCompleted({
      feature: 'server',
      operation: 'start',
      status: 'failed',
      trigger: OutcomeTriggers.startup,
      reasonCode: reason,
      ...(classified.errorName ? { errorName: classified.errorName } : {}),
    })
  } catch {
    // Telemetry must never mask the startup error.
  }
}

/**
 * Record an uncaught crash so the next start can report it. A crash kills
 * the process before a network request could finish, so the error class is
 * written to a marker file instead. `uncaughtExceptionMonitor` observes the
 * crash without changing Node's default exit behavior.
 */
const watched = new WeakSet<NodeJS.Process>()

export function watchServerCrashes(configDir: string = getConfigDir(), proc: NodeJS.Process = process, now: () => number = Date.now): void {
  if (watched.has(proc)) return
  watched.add(proc)
  proc.on('uncaughtExceptionMonitor', (err, origin) => {
    // Consent is read at the moment of the crash: telemetry can be turned off
    // while the server runs, and then nothing may be written.
    if (!telemetryAllowed()) return
    try {
      const { errorName } = classifyOutcomeError(err)
      fs.writeFileSync(markerPath(configDir), JSON.stringify({
        origin: origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException',
        at: now(),
        ...(errorName ? { errorName } : {}),
      }))
    } catch {
      // Best effort: the process is already going down.
    }
  })
}

/** Report, then clear, a crash recorded by the previous run. Does nothing at all while telemetry is off. */
export function reportPreviousServerCrash(configDir: string = getConfigDir(), now: () => number = Date.now): void {
  if (!telemetryAllowed()) return
  const file = markerPath(configDir)
  let marker: { origin?: unknown; errorName?: unknown; at?: unknown }
  try {
    marker = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof marker
  } catch {
    return
  }
  try {
    fs.rmSync(file, { force: true })
  } catch {
    return
  }
  // A marker left while telemetry was off and found long after says nothing about this release.
  if (typeof marker.at !== 'number' || now() - marker.at > MAX_MARKER_AGE_MS) return
  const errorName = typeof marker.errorName === 'string' && /^[A-Z_$][\w$]{0,39}$/i.test(marker.errorName) ? marker.errorName : undefined
  trackFeatureCompleted({
    feature: 'server',
    operation: 'crash',
    status: 'failed',
    trigger: OutcomeTriggers.startup,
    reasonCode: marker.origin === 'unhandledRejection' ? OutcomeReasonCodes.UNHANDLED_REJECTION : OutcomeReasonCodes.UNCAUGHT_EXCEPTION,
    ...(errorName ? { errorName } : {}),
  })
}
