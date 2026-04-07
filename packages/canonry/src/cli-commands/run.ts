import { cancelRun, listRuns, showRun, triggerRun, triggerRunAll } from '../commands/run.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, parseIntegerOption, requirePositional, requireProject, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const RUN_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['run', 'show'],
    usage: 'canonry run show <id>',
    run: async (input) => {
      const id = requirePositional(input, 0, {
        command: 'run.show',
        usage: 'canonry run show <id>',
        message: 'run ID is required',
      })
      await showRun(id, input.format)
    },
  },
  {
    path: ['run', 'cancel'],
    usage: 'canonry run cancel <project> [run-id]',
    run: async (input) => {
      const project = requireProject(input, 'run.cancel', 'canonry run cancel <project> [run-id]')
      await cancelRun(project, input.positionals[1], input.format)
    },
  },
  {
    path: ['run'],
    usage: 'canonry run <project|--all> [--provider <name>] [--location <label>] [--all-locations] [--no-location] [--wait] [--format json]',
    options: {
      provider: stringOption(),
      wait: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      location: stringOption(),
      'all-locations': { type: 'boolean', default: false },
      'no-location': { type: 'boolean', default: false },
    },
    run: async (input) => {
      if (getBoolean(input.values, 'all')) {
        if (input.positionals.length > 0) {
          throw usageError('Error: --all cannot be combined with a project name', {
            message: '--all cannot be combined with a project name',
            details: {
              command: 'run',
              usage: 'canonry run --all [--provider <name>] [--wait] [--format json]',
            },
          })
        }
        await triggerRunAll({
          provider: getString(input.values, 'provider'),
          wait: getBoolean(input.values, 'wait'),
          allLocations: getBoolean(input.values, 'all-locations'),
          noLocation: getBoolean(input.values, 'no-location'),
          format: input.format,
        })
        return
      }

      const project = requireProject(
        input,
        'run',
        'canonry run <project> [--provider <name>] [--wait] [--format json]',
        'project name is required (or use --all)',
      )

      await triggerRun(project, {
        provider: getString(input.values, 'provider'),
        wait: getBoolean(input.values, 'wait'),
        location: getString(input.values, 'location'),
        allLocations: getBoolean(input.values, 'all-locations'),
        noLocation: getBoolean(input.values, 'no-location'),
        format: input.format,
      })
    },
  },
  {
    path: ['runs'],
    usage: 'canonry runs <project> [--limit <n>] [--format json]',
    options: {
      limit: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'runs', 'canonry runs <project> [--limit <n>] [--format json]')
      await listRuns(project, {
        format: input.format,
        limit: parseIntegerOption(input, 'limit', {
          command: 'runs',
          usage: 'canonry runs <project> [--limit <n>] [--format json]',
          message: '--limit must be an integer',
        }),
      })
    },
  },
]
