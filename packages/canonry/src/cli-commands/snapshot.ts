import { createSnapshotReport } from '../commands/snapshot.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, requirePositional, requireStringOption, stringOption } from '../cli-command-helpers.js'

function parseCsvOption(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const parts = value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? [...new Set(parts)] : undefined
}

export const SNAPSHOT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['snapshot'],
    usage: 'canonry snapshot <company-name> --domain <domain> [--phrases "a,b"] [--competitors "x,y"] [--md] [--output <path>] [--pdf] [--format table|json]',
    options: {
      domain: stringOption(),
      phrases: stringOption(),
      competitors: stringOption(),
      md: { type: 'boolean' },
      pdf: { type: 'boolean' },
      output: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry snapshot <company-name> --domain <domain> [--phrases "a,b"] [--competitors "x,y"] [--md] [--output <path>] [--pdf] [--format table|json]'
      const companyName = requirePositional(input, 0, {
        command: 'snapshot',
        usage,
        message: 'company name is required',
      })
      const domain = requireStringOption(input, 'domain', {
        command: 'snapshot',
        usage,
        message: '--domain is required',
      })

      const outputPath = getString(input.values, 'output')
      const explicitMd = getBoolean(input.values, 'md')
      const wantsPdf = getBoolean(input.values, 'pdf')
      // --output alone implies --md only when --pdf is not set
      const wantsMd = explicitMd || (!!outputPath && !wantsPdf)

      await createSnapshotReport(companyName, {
        domain,
        phrases: parseCsvOption(getString(input.values, 'phrases')),
        competitors: parseCsvOption(getString(input.values, 'competitors')),
        md: wantsMd,
        pdf: wantsPdf,
        outputPath,
        format: input.format,
      })
    },
  },
]
