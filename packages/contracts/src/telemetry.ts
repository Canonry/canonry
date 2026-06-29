/**
 * Shared telemetry classification helpers.
 *
 * A "ghost" telemetry event is an operator / CI test sweep that would otherwise
 * pollute the onboarding funnel: a `run.completed` / `run.aborted` event with
 * no providers configured (`providerCount === 0`) originating from one of the
 * known test locations. The CLI drops these before sending and the cloud
 * collector drops them again as a backstop for older CLIs that still send, so
 * both surfaces classify with this one predicate and can never drift.
 */

const GHOST_TELEMETRY_TEST_LOCATIONS = new Set(['nyc', 'lax', 'chi'])

/** Minimal property shape the ghost-event predicate reads. */
export interface GhostTelemetryProperties {
  providerCount?: unknown
  location?: unknown
}

/**
 * True when an event name + property bag describes a no-provider test-location
 * run sweep that should be kept out of funnel analytics. The location match is
 * case-insensitive and whitespace-trimmed; `providerCount` must be exactly `0`.
 */
export function isGhostTelemetryEvent(
  eventName: unknown,
  properties?: GhostTelemetryProperties | null,
): boolean {
  if (eventName !== 'run.completed' && eventName !== 'run.aborted') return false
  if (!properties) return false
  if (properties.providerCount !== 0) return false
  const location = typeof properties.location === 'string'
    ? properties.location.trim().toLowerCase()
    : ''
  return GHOST_TELEMETRY_TEST_LOCATIONS.has(location)
}
