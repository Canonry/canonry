import { usageError } from '../cli-error.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, stringOption } from '../cli-command-helpers.js'

const USAGE = 'canonry sitemaps <project> [--engine google|bing] [--format json]'

export const SITEMAPS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['sitemaps'],
    usage: USAGE,
    help: 'Compare the site\'s sitemaps (from the latest Site Health scan) with what Google and Bing list, from stored data. Each engine shows its sitemaps and the ones it is missing: those the site declares or the other engine has. Add a missing one with "canonry google submit-sitemap" or "canonry bing submit-sitemap".',
    options: { engine: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'sitemaps', USAGE)
      const engine = getString(input.values, 'engine')
      if (engine !== undefined && engine !== 'google' && engine !== 'bing') {
        const message = '--engine must be google or bing'
        throw usageError(`Error: ${message}\nUsage: ${USAGE}`, { message, details: { command: 'sitemaps', usage: USAGE, option: 'engine', value: engine } })
      }
      const { sitemapsCommand } = await import('../commands/sitemaps.js')
      await sitemapsCommand(project, { engine, format: input.format })
    },
  },
]
