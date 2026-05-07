import { runReportCommand } from '../commands/report.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import type { ReportAudience } from '@ainyc/canonry-contracts'

const USAGE = 'canonry report <project> [--audience agency|client] [--output <path>] [--format json]'

function parseAudience(value: string | undefined): ReportAudience | undefined {
  if (value === undefined) return undefined
  if (value === 'agency' || value === 'client') return value
  throw usageError(`Error: --audience must be "agency" or "client"\n\nUsage: ${USAGE}`)
}

export const REPORT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['report'],
    usage: USAGE,
    options: {
      audience: { type: 'string' },
      output: { type: 'string', short: 'o' },
    },
    run: async (input) => {
      const project = requireProject(input, 'report', USAGE)
      await runReportCommand(project, {
        format: input.format,
        audience: parseAudience(getString(input.values, 'audience')),
        output: getString(input.values, 'output'),
      })
    },
  },
]
