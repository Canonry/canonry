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
  'canonry visibility-stats <project> [--since <iso>] [--until <iso>] [--month <YYYY-MM>] [--last-runs <n>] [--by-provider] [--share-of-voice] [--format json|jsonl]'

export const VISIBILITY_STATS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['visibility-stats'],
    usage: USAGE,
    options: {
      since: stringOption(),
      until: stringOption(),
      month: stringOption(),
      'last-runs': stringOption(),
      'by-provider': { type: 'boolean', default: false },
      'share-of-voice': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'visibility-stats', USAGE)
      await showVisibilityStats(project, {
        since: getString(input.values, 'since'),
        until: getString(input.values, 'until'),
        month: getString(input.values, 'month'),
        lastRuns: parseIntegerOption(input, 'last-runs', {
          command: 'visibility-stats',
          usage: USAGE,
          message: '--last-runs must be an integer',
        }),
        byProvider: getBoolean(input.values, 'by-provider'),
        shareOfVoice: getBoolean(input.values, 'share-of-voice'),
        format: input.format,
      })
    },
  },
]
