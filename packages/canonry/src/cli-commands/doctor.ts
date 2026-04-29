import { doctorCommand } from '../commands/doctor.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, getStringArray, multiStringOption, stringOption } from '../cli-command-helpers.js'

const USAGE = 'canonry doctor [--project <name>] [--check <id>...] [--format json]'

export const DOCTOR_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['doctor'],
    usage: USAGE,
    options: {
      project: stringOption(),
      check: multiStringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await doctorCommand({
        project: getString(input.values, 'project'),
        checks: getStringArray(input.values, 'check'),
        format: input.format,
      })
    },
  },
]
