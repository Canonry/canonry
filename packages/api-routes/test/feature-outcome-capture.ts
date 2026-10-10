import { featureCompletedPropertiesSchema } from '@ainyc/canonry-contracts'
import type { OutcomeTelemetryEvent } from '../src/outcome-telemetry.js'

/**
 * The `feature.completed` properties route code reported through
 * `apiRoutes({ onOutcome })`, each parsed with the schema the host enforces
 * before sending, so an outcome the host would drop fails the test.
 */
export function featureOutcomes(events: readonly OutcomeTelemetryEvent[]) {
  return events.flatMap(event => event.event === 'feature.completed'
    ? [featureCompletedPropertiesSchema.parse(event.properties)]
    : [])
}
