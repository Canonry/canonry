import { WINDOW_SETS } from '@ainyc/canonry-contracts'
import { showOrganicEvidence } from '../commands/organic-evidence.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, stringOption } from '../cli-command-helpers.js'
import { parseOrganicEvidencePeriod } from '@ainyc/canonry-contracts'
import type { OrganicEvidencePeriodDays } from '@ainyc/canonry-contracts'

const USAGE = 'canonry organic-evidence <project> [--period 60|90] [--format json|jsonl]'

function parsePeriod(value: string | undefined): OrganicEvidencePeriodDays | undefined {
  return value === undefined ? undefined : parseOrganicEvidencePeriod(value)
}

export const ORGANIC_EVIDENCE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['organic-evidence'],
    windows: WINDOW_SETS.organicEvidence,
    windowAliases: { window: 'period' },
    usage: USAGE,
    options: { period: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'organic-evidence', USAGE)
      await showOrganicEvidence(project, {
        period: parsePeriod(getString(input.values, 'window') ?? getString(input.values, 'period')),
        format: input.format,
      })
    },
  },
]
