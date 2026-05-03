import { runReportCommand } from '../commands/report.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject } from '../cli-command-helpers.js'

const USAGE = 'canonry report <project> [--output <path>] [--format json]'

export const REPORT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['report'],
    usage: USAGE,
    options: {
      output: { type: 'string', short: 'o' },
    },
    run: async (input) => {
      const project = requireProject(input, 'report', USAGE)
      await runReportCommand(project, {
        format: input.format,
        output: getString(input.values, 'output'),
      })
    },
  },
]
