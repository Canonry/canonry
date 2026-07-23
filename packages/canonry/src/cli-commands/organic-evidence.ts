import { showOrganicEvidence } from '../commands/organic-evidence.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import type { OrganicEvidencePeriodDays } from '@ainyc/canonry-contracts'

const USAGE = 'canonry organic-evidence <project> [--period 60|90] [--format json|jsonl]'

function parsePeriod(value: string | undefined): OrganicEvidencePeriodDays | undefined {
  if (value === undefined) return undefined
  if (value === '60' || value === '90') return Number(value) as OrganicEvidencePeriodDays
  throw usageError(`Error: --period must be 60 or 90\n\nUsage: ${USAGE}`)
}

export const ORGANIC_EVIDENCE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['organic-evidence'],
    usage: USAGE,
    options: { period: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'organic-evidence', USAGE)
      await showOrganicEvidence(project, {
        period: parsePeriod(getString(input.values, 'period')),
        format: input.format,
      })
    },
  },
]
