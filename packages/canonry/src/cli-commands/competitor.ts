import { addCompetitors, listCompetitors, removeCompetitors, showCompetitorLandscape } from '../commands/competitor.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const LANDSCAPE_USAGE = 'canonry competitor landscape <project> [--window 7d|30d|90d|all] [--group-key <key>|--scope all-markets] [--provider <provider>] [--query-class all|branded|non-brand] [--location <label>] [--run-id <id>] [--format json|jsonl]'

function parseLandscapeScope(value: string | undefined): 'all-markets' | undefined {
  if (value === undefined || value === '') return undefined
  if (value !== 'all-markets') throw usageError(`--scope must be "all-markets" (got "${value}")`, {
    message: '--scope must be "all-markets"',
    details: { command: 'competitor.landscape', usage: LANDSCAPE_USAGE },
  })
  return value
}

export const COMPETITOR_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['competitor', 'add'],
    usage: 'canonry competitor add <project> <domain...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'competitor.add', 'canonry competitor add <project> <domain...> [--format json]')
      const domains = input.positionals.slice(1)
      if (domains.length === 0) {
        throw usageError('Error: project name and at least one domain required\nUsage: canonry competitor add <project> <domain...> [--format json]', {
          message: 'project name and at least one domain required',
          details: {
            command: 'competitor.add',
            usage: 'canonry competitor add <project> <domain...> [--format json]',
          },
        })
      }
      await addCompetitors(project, domains, input.format)
    },
  },
  {
    path: ['competitor', 'remove'],
    usage: 'canonry competitor remove <project> <domain...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'competitor.remove', 'canonry competitor remove <project> <domain...> [--format json]')
      const domains = input.positionals.slice(1)
      if (domains.length === 0) {
        throw usageError('Error: project name and at least one domain required\nUsage: canonry competitor remove <project> <domain...> [--format json]', {
          message: 'project name and at least one domain required',
          details: {
            command: 'competitor.remove',
            usage: 'canonry competitor remove <project> <domain...> [--format json]',
          },
        })
      }
      await removeCompetitors(project, domains, input.format)
    },
  },
  {
    path: ['competitor', 'delete'],
    usage: 'canonry competitor delete <project> <domain...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'competitor.delete', 'canonry competitor delete <project> <domain...> [--format json]')
      const domains = input.positionals.slice(1)
      if (domains.length === 0) {
        throw usageError('Error: project name and at least one domain required\nUsage: canonry competitor delete <project> <domain...> [--format json]', {
          message: 'project name and at least one domain required',
          details: {
            command: 'competitor.delete',
            usage: 'canonry competitor delete <project> <domain...> [--format json]',
          },
        })
      }
      await removeCompetitors(project, domains, input.format)
    },
  },
  {
    path: ['competitor', 'list'],
    usage: 'canonry competitor list <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'competitor.list', 'canonry competitor list <project>')
      await listCompetitors(project, input.format)
    },
  },
  {
    path: ['competitor', 'landscape'],
    usage: LANDSCAPE_USAGE,
    options: {
      window: stringOption(),
      'group-key': stringOption(),
      scope: stringOption(),
      provider: stringOption(),
      'query-class': stringOption(),
      location: stringOption(),
      'run-id': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'competitor.landscape', LANDSCAPE_USAGE)
      const scope = parseLandscapeScope(getString(input.values, 'scope'))
      const groupKey = getString(input.values, 'group-key')
      if (scope === 'all-markets' && groupKey) {
        throw usageError('--group-key cannot be combined with --scope all-markets', {
          message: '--group-key cannot be combined with --scope all-markets',
          details: { command: 'competitor.landscape', usage: LANDSCAPE_USAGE },
        })
      }
      await showCompetitorLandscape(project, {
        window: getString(input.values, 'window') as '7d' | '30d' | '90d' | 'all' | undefined,
        groupKey,
        scope,
        provider: getString(input.values, 'provider'),
        queryClass: getString(input.values, 'query-class') as 'all' | 'branded' | 'non-brand' | undefined,
        location: getString(input.values, 'location'),
        runId: getString(input.values, 'run-id'),
        format: input.format,
      })
    },
  },
  {
    path: ['competitor'],
    usage: 'canonry competitor <add|remove|delete|list|landscape> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'competitor',
        usage: 'canonry competitor <add|remove|delete|list|landscape> <project> [args]',
        available: ['add', 'remove', 'delete', 'list', 'landscape'],
      })
    },
  },
]
