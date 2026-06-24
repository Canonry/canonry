import { runReportCommand } from '../commands/report.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import { REPORT_PERIOD_OPTIONS, type ReportAudience, type ReportPeriodDays } from '@ainyc/canonry-contracts'

const USAGE = 'canonry report <project> [--audience agency|client] [--period 7|14|30|90] [--output <path>] [--format json]'

function parseAudience(value: string | undefined): ReportAudience | undefined {
  if (value === undefined) return undefined
  if (value === 'agency' || value === 'client') return value
  throw usageError(`Error: --audience must be "agency" or "client"\n\nUsage: ${USAGE}`)
}

function parsePeriod(value: string | undefined): ReportPeriodDays | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (Number.isInteger(n) && (REPORT_PERIOD_OPTIONS as readonly number[]).includes(n)) {
    return n as ReportPeriodDays
  }
  throw usageError(`Error: --period must be one of ${REPORT_PERIOD_OPTIONS.join(', ')}\n\nUsage: ${USAGE}`)
}

export const REPORT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['report'],
    usage: USAGE,
    options: {
      audience: { type: 'string' },
      period: { type: 'string' },
      output: { type: 'string', short: 'o' },
    },
    run: async (input) => {
      const project = requireProject(input, 'report', USAGE)
      await runReportCommand(project, {
        format: input.format,
        audience: parseAudience(getString(input.values, 'audience')),
        period: parsePeriod(getString(input.values, 'period')),
        output: getString(input.values, 'output'),
      })
    },
  },
]
