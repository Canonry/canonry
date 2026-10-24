import type { CliCommandSpec, CliCommandInput } from '../cli-dispatch.js'
import { getString, parseIntegerOption, requirePositional, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const SUMMARY_USAGE = 'canonry journeys summary <project> [--since <ISO>] [--until <ISO>] [--format json]'
const LIST_USAGE = 'canonry journeys list <project> [--since <ISO>] [--until <ISO>] [--engine <name>] [--returned true|false] [--limit 50] [--offset 0] [--format json|jsonl]'
const SHOW_USAGE = 'canonry journeys show <project> <visitor-key> [--format json]'

function parseReturned(input: CliCommandInput): boolean | undefined {
  const value = getString(input.values, 'returned')
  if (value === undefined || value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw usageError(`Error: --returned must be "true" or "false"\nUsage: ${LIST_USAGE}`, {
    message: '--returned must be "true" or "false"',
    details: { command: 'journeys.list', usage: LIST_USAGE },
  })
}

export const JOURNEYS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['journeys', 'summary'],
    usage: SUMMARY_USAGE,
    help: 'Stored AI visitor journeys: visitors whose first AI visit fell in the window and how many came back. No provider calls.',
    options: { since: stringOption(), until: stringOption() },
    run: async input => {
      const { journeysSummary } = await import('../commands/journeys.js')
      const project = requireProject(input, 'journeys.summary', SUMMARY_USAGE)
      await journeysSummary(project, { since: getString(input.values, 'since'), until: getString(input.values, 'until'), format: input.format })
    },
  },
  {
    path: ['journeys', 'list'],
    usage: LIST_USAGE,
    help: 'Stored AI visitors, newest first AI visit first, with their visits. No provider calls.',
    options: { since: stringOption(), until: stringOption(), engine: stringOption(), returned: stringOption(), limit: stringOption(), offset: stringOption() },
    run: async input => {
      const { journeysList } = await import('../commands/journeys.js')
      const project = requireProject(input, 'journeys.list', LIST_USAGE)
      const integer = (name: string) => parseIntegerOption(input, name, { command: 'journeys.list', usage: LIST_USAGE, message: `--${name} must be an integer` })
      await journeysList(project, {
        since: getString(input.values, 'since'),
        until: getString(input.values, 'until'),
        engine: getString(input.values, 'engine'),
        returned: parseReturned(input),
        limit: integer('limit'),
        offset: integer('offset'),
        format: input.format,
      })
    },
  },
  {
    path: ['journeys', 'show'],
    usage: SHOW_USAGE,
    help: 'Every stored visit and request for one AI visitor. No provider calls.',
    run: async input => {
      const { journeyShow } = await import('../commands/journeys.js')
      const project = requireProject(input, 'journeys.show', SHOW_USAGE)
      const visitorKey = requirePositional(input, 1, { command: 'journeys.show', usage: SHOW_USAGE, message: 'visitor key is required' })
      await journeyShow(project, visitorKey, { format: input.format })
    },
  },
  {
    path: ['journeys'],
    usage: 'canonry journeys <subcommand> <project> [args]',
    run: async input => {
      unknownSubcommand(input.positionals[0], {
        command: 'journeys',
        usage: 'canonry journeys <subcommand> <project> [args]',
        available: ['summary', 'list', 'show'],
      })
    },
  },
]
