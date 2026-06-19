import { showVisibilityStats } from '../commands/visibility-stats.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requireProject,
  stringOption,
} from '../cli-command-helpers.js'

const USAGE =
  'canonry visibility-stats <project> [--since <iso>] [--until <iso>] [--last-runs <n>] [--by-provider] [--format json|jsonl]'

export const VISIBILITY_STATS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['visibility-stats'],
    usage: USAGE,
    options: {
      since: stringOption(),
      until: stringOption(),
      'last-runs': stringOption(),
      'by-provider': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'visibility-stats', USAGE)
      await showVisibilityStats(project, {
        since: getString(input.values, 'since'),
        until: getString(input.values, 'until'),
        lastRuns: parseIntegerOption(input, 'last-runs', {
          command: 'visibility-stats',
          usage: USAGE,
          message: '--last-runs must be an integer',
        }),
        byProvider: getBoolean(input.values, 'by-provider'),
        format: input.format,
      })
    },
  },
]
