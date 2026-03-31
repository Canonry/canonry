import { backfillAnswerVisibilityCommand } from '../commands/backfill.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

export const BACKFILL_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['backfill', 'answer-visibility'],
    usage: 'canonry backfill answer-visibility [--project <name>] [--format json]',
    options: {
      project: stringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await backfillAnswerVisibilityCommand({
        project: getString(input.values, 'project'),
        format: input.format,
      })
    },
  },
  {
    path: ['backfill'],
    usage: 'canonry backfill <answer-visibility> [--project <name>] [--format json]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'backfill',
        usage: 'canonry backfill <answer-visibility> [--project <name>] [--format json]',
        available: ['answer-visibility'],
      })
    },
  },
]
