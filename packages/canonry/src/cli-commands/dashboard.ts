import { resetDashboardPassword } from '../commands/dashboard.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { unknownSubcommand } from '../cli-command-helpers.js'

export const DASHBOARD_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['dashboard', 'reset-password'],
    usage: 'canonry dashboard reset-password [--format json]',
    run: async (input) => {
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
