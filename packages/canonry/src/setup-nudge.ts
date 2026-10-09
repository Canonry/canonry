import type { ErrorCode } from '@ainyc/canonry-contracts'
import { isMachineFormat, type CliFormat } from './cli-error.js'
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
 * The Page Health commands that start a scan or read its headline result.
 * This is where the dashboard onboarding hands off to AI Visibility, so the
 * CLI makes the same handoff here, in every output mode: most provider-less
 * installs never open the dashboard, and the agents driving them run with
 * `--format json` or captured stderr, where every other nudge is silent.
 * Exact paths, not roots: the rest of the Page Health path stays quiet, and
 * `technical-aeo progress` is polled, so it would repeat the line per poll.
 */
const PAGE_HEALTH_HANDOFF_COMMANDS = new Set([
  'technical-aeo.run',
  'technical-aeo.score',
  'technical-aeo.crawl',
  'site-health.overview',
])

/** Stable code agents can branch on; the same condition a run refuses with. */
export const NO_PROVIDER_NOTICE_CODE = 'NO_PROVIDER' satisfies ErrorCode

const PROVIDER_SETUP_COMMAND = 'canonry settings provider gemini --api-key <key>'
const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey'

/**
 * The stalled-setup stderr line for a provider-less install. Visibility
 * commands get it on a terminal only. Page Health handoff commands get it in
 * every mode, shaped like the update notice: the human lines on a terminal,
 * one plain `[canonry] NO_PROVIDER: ...` line when stderr is captured, and one
 * compact `{"notice":{...}}` line for `--format json|jsonl`. stdout is never
 * touched, so a JSON document on stdout stays exactly that.
 */
export function buildSetupNudgeLine(input: {
  /** Resolved registry path, e.g. `status` or `settings.provider`. */
  command: string
  format: CliFormat
  stderrIsTTY: boolean
  /**
   * LAZY, and the laziness is a contract. Reading setup state opens config
   * and the database, which the CLI's own tests pin as forbidden for
   * telemetry-control commands and disabled-telemetry runs. The cheap gates
   * above the read make sure it only ever happens for a command that could
   * actually show the line.
   */
  getSetupState: () => SetupState | undefined
}): string | null {
  const machineFormat = isMachineFormat(input.format)
  const handoff = PAGE_HEALTH_HANDOFF_COMMANDS.has(input.command)
  if (!handoff) {
    if (machineFormat || !input.stderrIsTTY) return null
    const [root = input.command] = input.command.split('.')
    if (NUDGE_EXEMPT_ROOTS.has(root)) return null
  }
  // No setup state means no config at all: pre-init, where `init` itself is
  // the guidance and this line would be premature.
  const setupState = input.getSetupState()
  if (!setupState) return null
  if (setupState.provider_count > 0) return null
  if (machineFormat) {
    return `${JSON.stringify({
      notice: {
        code: NO_PROVIDER_NOTICE_CODE,
        message: 'AI Visibility needs an answer-engine provider. Page Health does not.',
        setupCommand: PROVIDER_SETUP_COMMAND,
        keyUrl: GEMINI_KEY_URL,
        note: 'A provider key is the operator\'s credential: they add it in the dashboard, or run the setup command in their own terminal while the server is running. Never ask for it in chat.',
      },
    })}\n`
  }
  if (!input.stderrIsTTY) {
    return (
      `[canonry] ${NO_PROVIDER_NOTICE_CODE}: AI Visibility needs an answer-engine provider. Page Health does not. ` +
      `The operator adds a key in the dashboard, or runs \`${PROVIDER_SETUP_COMMAND}\` in their own terminal while the server is running ` +
      `(free key at ${GEMINI_KEY_URL}). Never ask for the key in chat.\n`
    )
  }
  return (
    '\n→ AI Visibility needs an answer-engine provider. Page Health does not.\n' +
    '  Add one in the dashboard after `canonry serve`, or while the server is running:\n' +
    `  ${PROVIDER_SETUP_COMMAND}   (free key at aistudio.google.com)\n`
  )
}
