import fs from 'node:fs'
import path from 'node:path'
import { classifyOutcomeError, OutcomeReasonCodes, OutcomeTriggers, type OutcomeReasonCode } from '@ainyc/canonry-contracts'
import { getConfigDir } from './config.js'
import { trackFeatureCompleted } from './outcome-telemetry.js'
import { isTelemetryEnabled } from './telemetry.js'

const CRASH_MARKER = 'crash-telemetry.json'

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
let watching = false

export function watchServerCrashes(configDir: string = getConfigDir(), proc: NodeJS.Process = process): void {
  if (watching || !isTelemetryEnabled()) return
  watching = true
  proc.on('uncaughtExceptionMonitor', (err, origin) => {
    try {
      const { errorName } = classifyOutcomeError(err)
      fs.writeFileSync(markerPath(configDir), JSON.stringify({
        origin: origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException',
        ...(errorName ? { errorName } : {}),
      }))
    } catch {
      // Best effort: the process is already going down.
    }
  })
}

/** Report, then clear, a crash recorded by the previous run. */
export function reportPreviousServerCrash(configDir: string = getConfigDir()): void {
  const file = markerPath(configDir)
  let marker: { origin?: unknown; errorName?: unknown }
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
