import type {
  FeatureCompletedProperties,
  IntegrationConnectionProperties,
} from '@ainyc/canonry-contracts'
import { currentOutcomeAttribution } from './request-context.js'

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

/** What route code reports. `attribution` defaults to the current request's; work that reports after its request passes the one it captured. */
export type OutcomeTelemetryInput = OutcomeTelemetryEvent

/**
 * Bind route code to the host's outcome sink. Attaches the current request's
 * attribution unless the event carries one; an event with neither came from
 * the server itself. Never throws: telemetry must not change a response.
 */
export function createOutcomeEmitter(sink: ((event: OutcomeTelemetryEvent) => void) | undefined): (event: OutcomeTelemetryInput) => void {
  return (event) => {
    if (!sink) return
    try {
      sink({ ...event, attribution: event.attribution ?? currentOutcomeAttribution() } as OutcomeTelemetryEvent)
    } catch {
      // Outcome telemetry is best effort.
    }
  }
}
