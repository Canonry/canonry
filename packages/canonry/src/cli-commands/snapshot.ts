import { createSnapshotReport } from '../commands/snapshot.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, getStringArray, multiStringOption, requirePositional, requireStringOption, stringOption } from '../cli-command-helpers.js'
import { snapshotProviderModeSchema } from '@ainyc/canonry-contracts'
import { usageError } from '../cli-error.js'

const SNAPSHOT_USAGE = 'canonry snapshot <company-name> --domain <domain> [--provider <name>...] [--provider-mode all|api|browser] [--queries "a,b"] [--phrases "a,b" (legacy alias)] [--competitors "x,y"] [--md] [--output <path>] [--pdf] [--format table|json]'

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
    usage: SNAPSHOT_USAGE,
    options: {
      domain: stringOption(),
      provider: multiStringOption(),
      'provider-mode': stringOption(),
      queries: stringOption(),
      phrases: stringOption(),
      competitors: stringOption(),
      md: { type: 'boolean' },
      pdf: { type: 'boolean' },
      output: stringOption(),
    },
    run: async (input) => {
      const usage = SNAPSHOT_USAGE
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

      const rawMode = getString(input.values, 'provider-mode')
      const mode = snapshotProviderModeSchema.optional().safeParse(rawMode)
      if (!mode.success) {
        throw usageError('Error: --provider-mode must be all, api, or browser', {
          details: { command: 'snapshot', usage },
        })
      }
      const providers = getStringArray(input.values, 'provider')?.map(name => name.trim())
      if (providers?.some(name => !name)) throw usageError('Error: --provider must not be blank')

      const outputPath = getString(input.values, 'output')
      const explicitMd = getBoolean(input.values, 'md')
      const wantsPdf = getBoolean(input.values, 'pdf')
      // --output alone implies --md only when --pdf is not set
      const wantsMd = explicitMd || (!!outputPath && !wantsPdf)

      await createSnapshotReport(companyName, {
        domain,
        providers: providers === undefined ? undefined : [...new Set(providers)],
        providerMode: mode.data,
        queries: parseCsvOption(getString(input.values, 'queries') ?? getString(input.values, 'phrases')),
        competitors: parseCsvOption(getString(input.values, 'competitors')),
        md: wantsMd,
        pdf: wantsPdf,
        outputPath,
        format: input.format,
      })
    },
  },
]
