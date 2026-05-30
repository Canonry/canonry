import { doctorCommand } from '../commands/doctor.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, getStringArray, multiStringOption, stringOption } from '../cli-command-helpers.js'

const USAGE = 'canonry doctor [--project <name>|--all] [--check <id>...] [--format json|jsonl]'

export const DOCTOR_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['doctor'],
    usage: USAGE,
    options: {
      project: stringOption(),
      check: multiStringOption(),
      all: { type: 'boolean' },
    },
    allowPositionals: false,
    run: async (input) => {
      await doctorCommand({
        project: getString(input.values, 'project'),
        all: getBoolean(input.values, 'all'),
        checks: getStringArray(input.values, 'check'),
        format: input.format,
      })
    },
  },
]
