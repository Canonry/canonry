import type { IntegrationConnectionProperties } from '@ainyc/canonry-contracts'
import { trackIntegrationConnection } from './outcome-telemetry.js'
import { cliRuntimeContext } from './runtime-context.js'

/**
 * `integration.connection` for a connection the CLI makes without the API
 * (a provider key written by `bootstrap` or `init`, a CDP endpoint saved
 * locally) or settles without calling it (an agent webhook already attached).
 */
export function trackCliConnection(properties: Omit<IntegrationConnectionProperties, 'surface' | 'agent'>): void {
  trackIntegrationConnection({ ...properties, surface: 'cli', agent: cliRuntimeContext().agent } as IntegrationConnectionProperties)
}
