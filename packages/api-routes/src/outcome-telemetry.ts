import type {
  FeatureCompletedProperties,
  IntegrationConnectionProperties,
} from '@ainyc/canonry-contracts'
import { getRequestContext } from './request-context.js'

/**
 * Who made the request an outcome came from, as the raw, caller-controlled
 * labels. api-routes cannot import telemetry, so the host (canonry's server)
 * classifies these into a surface and agent with the same rules it uses for
 * `api.request`, and validates the whole event against the contracts schema.
 */
export interface OutcomeAttribution {
  userAgent?: string
  surfaceLabel?: string
  agentLabel?: string
}

type Attributed<P> = Omit<P, 'surface' | 'agent'> & Partial<Pick<IntegrationConnectionProperties, 'surface' | 'agent'>>

/** An outcome reported from route code. `errorCode` is the envelope classifier, never a message. */
export type OutcomeTelemetryEvent =
  | {
      event: 'integration.connection'
      properties: Attributed<IntegrationConnectionProperties>
      errorCode?: string
      attribution?: OutcomeAttribution
    }
  | {
      event: 'feature.completed'
      properties: Attributed<FeatureCompletedProperties>
      errorCode?: string
      attribution?: OutcomeAttribution
    }

export type OutcomeTelemetryInput = OutcomeTelemetryEvent extends infer E
  ? E extends OutcomeTelemetryEvent ? Omit<E, 'attribution'> : never
  : never

/** The current request's raw attribution labels, or undefined outside a request. */
export function currentOutcomeAttribution(): OutcomeAttribution | undefined {
  const context = getRequestContext()
  return context
    ? { userAgent: context.userAgent, surfaceLabel: context.usageSurface, agentLabel: context.usageAgent }
    : undefined
}

/**
 * Bind route code to the host's outcome sink. Attaches the current request's
 * attribution when there is one; background work started by a request but
 * finishing later reports `surface: 'system'` unless it passes its own. Never
 * throws: telemetry must not change a response.
 */
export function createOutcomeEmitter(sink: ((event: OutcomeTelemetryEvent) => void) | undefined): (event: OutcomeTelemetryInput) => void {
  return (event) => {
    if (!sink) return
    try {
      sink({ ...event, attribution: currentOutcomeAttribution() } as OutcomeTelemetryEvent)
    } catch {
      // Outcome telemetry is best effort.
    }
  }
}
