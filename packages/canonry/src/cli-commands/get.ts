import { getCommand, GET_SOURCES } from '../commands/get.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requirePositional, requireProject, stringOption } from '../cli-command-helpers.js'

const USAGE = `canonry get <project> <path> [--from ${GET_SOURCES.join('|')}] [--format json]`

export const GET_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['get'],
    usage: USAGE,
    options: {
      from: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'get', USAGE)
      const path = requirePositional(input, 1, {
        command: 'get',
        usage: USAGE,
        message: 'path is required (e.g. "scores.mentionShare.value")',
      })
      const from = getString(input.values, 'from')
      await getCommand({ project, path, from, format: input.format })
    },
  },
]
