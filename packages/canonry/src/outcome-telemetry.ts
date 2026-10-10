import {
  bucketDuration,
  classifyOutcomeError,
  featureCompletedPropertiesSchema,
  installStatePropertiesSchema,
  integrationConnectionPropertiesSchema,
  normalizeAgentSlug,
  OutcomeSurfaces,
  type FeatureCompletedProperties,
  type InstallStateProperties,
  type IntegrationConnectionProperties,
  type OutcomeReasonCode,
  type OutcomeSurface,
  type OutcomeTrigger,
} from '@ainyc/canonry-contracts'
import type { OutcomeAttribution, OutcomeTelemetryEvent } from '@ainyc/canonry-api-routes'
import { currentOutcomeAttribution } from '@ainyc/canonry-api-routes/request-context'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'
import { isTelemetryEnabled, trackEvent } from './telemetry.js'
import { classifyUsageSurface } from './usage-telemetry.js'

/**
 * Outcome telemetry: `integration.connection`, `feature.completed` and
 * `install.state` (contracts `outcome-telemetry.ts`). Every payload is
 * validated against the contracts schema before it is sent. In tests an
 * invalid payload throws so schema drift fails loudly; in production it is
 * dropped, because telemetry must never change what the product does.
 */

const STRICT = Boolean(process.env.VITEST)

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function send(
  event: 'integration.connection' | 'feature.completed' | 'install.state',
  schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } },
  properties: object,
  errorCode?: string,
): void {
  const parsed = schema.safeParse(withoutUndefined(properties))
  if (!parsed.success) {
    if (STRICT) throw new Error(`invalid ${event} telemetry: ${JSON.stringify(parsed.error)}`)
    return
  }
  trackEvent(event, parsed.data as Record<string, unknown>, errorCode ? { errorCode } : undefined)
}

/** Classify a request's raw labels with the same rules as `api.request`; no request, or the scheduler client's `system` label, means the server acted alone. */
export function outcomeAttribution(attribution: OutcomeAttribution | undefined): { surface: OutcomeSurface; agent?: string } {
  if (!attribution || attribution.surfaceLabel === OutcomeSurfaces.system) return { surface: OutcomeSurfaces.system }
  const surface = classifyUsageSurface({ userAgent: attribution.userAgent, usageLabels: { surface: attribution.surfaceLabel } })
  const agent = normalizeAgentSlug(attribution.agentLabel) ?? undefined
  return agent ? { surface, agent } : { surface }
}

const MILESTONES_DIR = 'telemetry-milestones'
const claimed = new Set<string>()

/**
 * Whether this is the install's first success of a kind. Each kind is one
 * file created with an exclusive open, so the CLI and the server claiming the
 * same first at once cannot both win, and neither can erase the other's
 * claims. Lets milestone funnels survive sampling and the collector's
 * one-year retention. Never consulted when telemetry is off.
 */
function isFirstSuccess(key: string): boolean {
  try {
    if (!isTelemetryEnabled() || claimed.has(key)) return false
    const dir = path.join(getConfigDir(), MILESTONES_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const name = key.replace(/[^\w.-]/g, c => `~${c.charCodeAt(0).toString(16)}`)
    claimed.add(key)
    fs.closeSync(fs.openSync(path.join(dir, name), 'wx'))
    return true
  } catch {
    return false
  }
}

/** Forget what this process has claimed; tests stand in for a second process. */
export function resetOutcomeMilestonesForTest(): void {
  claimed.clear()
}

export function trackIntegrationConnection(properties: IntegrationConnectionProperties, options: { errorCode?: string } = {}): void {
  const succeeded = properties.status === 'succeeded' && (properties.action === 'connect' || properties.action === 'reauth')
  const key = `connection:${properties.integration}${properties.provider ? `:${properties.provider}` : ''}`
  const first = succeeded && isFirstSuccess(key)
  send('integration.connection', integrationConnectionPropertiesSchema, first ? { ...properties, first: true } : properties, options.errorCode ?? properties.reasonCode)
}

export function trackFeatureCompleted(properties: FeatureCompletedProperties, options: { errorCode?: string } = {}): void {
  const first = properties.status === 'succeeded' && isFirstSuccess(`feature:${properties.feature}.${properties.operation}`)
  send('feature.completed', featureCompletedPropertiesSchema, first ? { ...properties, first: true } : properties, options.errorCode ?? properties.reasonCode)
}

export function trackInstallState(properties: InstallStateProperties): void {
  send('install.state', installStatePropertiesSchema, properties)
}

/** The sink `apiRoutes({ onOutcome })` calls for every outcome reported from route code. */
export function handleRouteOutcome(event: OutcomeTelemetryEvent): void {
  const attributed = outcomeAttribution(event.attribution)
  const properties = {
    ...event.properties,
    surface: event.properties.surface ?? attributed.surface,
    ...(event.properties.agent ?? attributed.agent ? { agent: event.properties.agent ?? attributed.agent } : {}),
  }
  if (event.event === 'integration.connection') {
    trackIntegrationConnection(properties as IntegrationConnectionProperties, { errorCode: event.errorCode })
  } else {
    const trigger = event.properties.trigger ?? (event.attribution ? outcomeTriggerFor(event.attribution) : undefined)
    trackFeatureCompleted({ ...properties, ...(trigger ? { trigger } : {}) } as FeatureCompletedProperties, { errorCode: event.errorCode })
  }
}

/** What started work a request asked for: the server's scheduler, an agent surface, or a person. */
export function outcomeTriggerFor(attribution: OutcomeAttribution): NonNullable<FeatureCompletedProperties['trigger']> {
  if (attribution.surfaceLabel === OutcomeSurfaces.system) return 'scheduled'
  const { surface } = outcomeAttribution(attribution)
  const agentSurface = surface === OutcomeSurfaces['mcp-stdio'] || surface === OutcomeSurfaces['mcp-http'] || surface === OutcomeSurfaces.aero
  return agentSurface ? 'agent' : 'manual'
}

/**
 * Who asked for the current work, read from the active HTTP request; undefined
 * outside one. Work that finishes after its request reads this before its
 * first await, while the request is still active.
 */
export function currentOutcomeOrigin(): { trigger: OutcomeTrigger; surface: OutcomeSurface; agent?: string } | undefined {
  try {
    const attribution = currentOutcomeAttribution()
    return attribution ? { trigger: outcomeTriggerFor(attribution), ...outcomeAttribution(attribution) } : undefined
  } catch {
    return undefined
  }
}

/**
 * The failure half of an outcome from a caught error: a reason code and
 * error class name, never the message. Pass `reasonCode` when the caller
 * knows better than the classifier (a refused gate, an OAuth denial).
 */
export function outcomeFailure(err: unknown, reasonCode?: OutcomeReasonCode): { reasonCode: OutcomeReasonCode; errorName?: string } {
  const classified = classifyOutcomeError(err)
  return reasonCode ? { ...classified, reasonCode } : classified
}

/** Time an operation for its `durationBucket`. */
export function startOutcomeTimer(now: () => number = Date.now): () => FeatureCompletedProperties['durationBucket'] {
  const started = now()
  return () => bucketDuration(now() - started)
}

/**
 * A per-key token bucket for high-volume outcomes (webhook deliveries,
 * traffic push ingest). Suppressed events are counted and reported as
 * `droppedBefore` on the next one sent, so totals stay reconstructable while
 * the per-IP collector budget is protected. Defaults match `api.request`:
 * a burst of 20, then one per 10 seconds per key.
 */
export function createOutcomeSampler(options: { burst?: number; refillMs?: number; now?: () => number } = {}) {
  const burst = options.burst ?? 20
  const refillMs = options.refillMs ?? 10_000
  const now = options.now ?? Date.now
  const buckets = new Map<string, { tokens: number; at: number; dropped: number }>()
  return (key: string): { send: boolean; droppedBefore?: number } => {
    const t = now()
    const bucket = buckets.get(key) ?? { tokens: burst, at: t, dropped: 0 }
    bucket.tokens = Math.min(burst, bucket.tokens + (t - bucket.at) / refillMs)
    bucket.at = t
    buckets.set(key, bucket)
    if (bucket.tokens < 1) {
      bucket.dropped += 1
      return { send: false }
    }
    bucket.tokens -= 1
    const droppedBefore = bucket.dropped
    bucket.dropped = 0
    return droppedBefore > 0 ? { send: true, droppedBefore } : { send: true }
  }
}
