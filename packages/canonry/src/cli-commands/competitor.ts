import { addCompetitors, listCompetitors } from '../commands/competitor.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { requireProject, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

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
    path: ['competitor', 'list'],
    usage: 'canonry competitor list <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'competitor.list', 'canonry competitor list <project>')
      await listCompetitors(project, input.format)
    },
  },
  {
    path: ['competitor'],
    usage: 'canonry competitor <add|list> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'competitor',
        usage: 'canonry competitor <add|list> <project> [args]',
        available: ['add', 'list'],
      })
    },
  },
]
