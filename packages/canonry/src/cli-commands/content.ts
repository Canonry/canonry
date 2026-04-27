import {
  listContentTargets,
  listContentSources,
  listContentGaps,
} from '../commands/content.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { requireProject, parseIntegerOption } from '../cli-command-helpers.js'

export const CONTENT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['content', 'targets'],
    usage:
      'canonry content targets <project> [--limit <n>] [--include-in-progress] [--format json]',
    options: {
      limit: { type: 'string' },
      'include-in-progress': { type: 'boolean' },
    },
    run: async (input) => {
      const usage =
        'canonry content targets <project> [--limit <n>] [--include-in-progress] [--format json]'
      const project = requireProject(input, 'content targets', usage)
      const limit = parseIntegerOption(input, 'limit', {
        command: 'content targets',
        usage,
        message: '--limit must be a non-negative integer',
      })
      await listContentTargets(project, {
        limit,
        includeInProgress: input.values['include-in-progress'] === true,
        format: input.format,
      })
    },
  },
  {
    path: ['content', 'sources'],
    usage: 'canonry content sources <project> [--format json]',
    options: {},
    run: async (input) => {
      const usage = 'canonry content sources <project> [--format json]'
      const project = requireProject(input, 'content sources', usage)
      await listContentSources(project, { format: input.format })
    },
  },
  {
    path: ['content', 'gaps'],
    usage: 'canonry content gaps <project> [--format json]',
    options: {},
    run: async (input) => {
      const usage = 'canonry content gaps <project> [--format json]'
      const project = requireProject(input, 'content gaps', usage)
      await listContentGaps(project, { format: input.format })
    },
  },
]
