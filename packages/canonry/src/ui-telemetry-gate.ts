import type { UiTelemetryEvent } from '@ainyc/canonry-contracts'
import { isTelemetryEnabled, recordDashboardEvent } from './telemetry.js'

/** Burst of 60, refilling one per second. */
export const UI_EVENT_MINUTE_CAPACITY = 60
/** At most 600 per hour, refilling evenly. */
export const UI_EVENT_HOUR_CAPACITY = 600

export interface UiTelemetryGateOptions {
  now?: () => number
  enabled?: () => boolean
  record?: (event: UiTelemetryEvent) => void
}

/**
 * The host side of `POST /api/v1/telemetry/ui`: forward one dashboard event and
 * say whether it was accepted. Answers `false` while telemetry is effectively
 * off (config, DO_NOT_TRACK, CI, env), so the dashboard stops sending for the
 * session, and past a per-process cap of two token buckets, so a misbehaving
 * tab cannot flood the collector.
 */
export function createUiTelemetryGate(options: UiTelemetryGateOptions = {}): (event: UiTelemetryEvent) => boolean {
  const now = options.now ?? Date.now
  const enabled = options.enabled ?? isTelemetryEnabled
  const record = options.record ?? recordDashboardEvent
  const buckets = [
    { capacity: UI_EVENT_MINUTE_CAPACITY, perMs: UI_EVENT_MINUTE_CAPACITY / 60_000, tokens: UI_EVENT_MINUTE_CAPACITY },
    { capacity: UI_EVENT_HOUR_CAPACITY, perMs: UI_EVENT_HOUR_CAPACITY / 3_600_000, tokens: UI_EVENT_HOUR_CAPACITY },
  ]
  let refilledAt = now()

  return (event) => {
    if (!enabled()) return false
    const at = now()
    const elapsed = Math.max(0, at - refilledAt)
    refilledAt = at
    for (const bucket of buckets) bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.perMs)
    if (buckets.some(bucket => bucket.tokens < 1)) return false
    for (const bucket of buckets) bucket.tokens -= 1
    record(event)
    return true
  }
}
