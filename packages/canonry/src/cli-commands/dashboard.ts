import type { CliCommandSpec } from '../cli-dispatch.js'
import { unknownSubcommand } from '../cli-command-helpers.js'

export const DASHBOARD_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['dashboard', 'reset-password'],
    usage: 'canonry dashboard reset-password [--format json]',
    help: 'Clears the dashboard password from config.yaml, so the dashboard asks for a new one after a restart.\n'
      + 'Local only: it edits the config file under CANONRY_CONFIG_DIR and does not call the server.',
    run: async (input) => {
      const { resetDashboardPassword } = await import('../commands/dashboard.js')
      await resetDashboardPassword({ format: input.format })
    },
  },
  {
    path: ['dashboard'],
    usage: 'canonry dashboard <reset-password>',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'dashboard',
        usage: 'canonry dashboard <reset-password>',
        available: ['reset-password'],
      })
    },
  },
]
