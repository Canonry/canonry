import type { SetupState } from './setup-state.js'

/**
 * Page Health, runtime, and provider-config commands must not nag for a
 * provider. Matched on the command root so aliases like `site-health.pages`
 * stay exempt with `technical-aeo`.
 */
const NUDGE_EXEMPT_ROOTS = new Set([
  'init',
  'serve',
  'start',
  'stop',
  'bootstrap',
  'settings',
  'telemetry',
  'project',
  'technical-aeo',
  'site-health',
  'doctor',
  'demo',
  'status',
  'unknown',
])

/**
 * TTY-only stderr line for visibility commands that need an answer-engine
 * provider. Page Health does not.
 */
export function buildSetupNudgeLine(input: {
  /** Resolved registry path, e.g. `status` or `settings.provider`. */
  command: string
  machineFormat: boolean
  stderrIsTTY: boolean
  /**
   * LAZY, and the laziness is a contract. Reading setup state opens config
   * and the database, which the CLI's own tests pin as forbidden for
   * telemetry-control commands and disabled-telemetry runs. The cheap gates
   * above the read make sure it only ever happens for a human-mode command
   * that could actually show the line.
   */
  getSetupState: () => SetupState | undefined
}): string | null {
  if (input.machineFormat || !input.stderrIsTTY) return null
  const [root = input.command] = input.command.split('.')
  if (NUDGE_EXEMPT_ROOTS.has(root)) return null
  // No setup state means no config at all: pre-init, where `init` itself is
  // the guidance and this line would be premature.
  const setupState = input.getSetupState()
  if (!setupState) return null
  if (setupState.provider_count > 0) return null
  return (
    '\n→ AI Visibility needs an answer-engine provider. Page Health does not.\n' +
    '  Add one in the dashboard after `canonry serve`, or:\n' +
    '  canonry settings provider gemini --api-key <key>\n'
  )
}
