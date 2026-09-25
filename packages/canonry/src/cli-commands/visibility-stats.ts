import { visibilityCompareSelectionSchema } from '@ainyc/canonry-contracts'
import { showVisibilityStats, showVisibilityCompare } from '../commands/visibility-stats.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requireProject,
  stringOption,
} from '../cli-command-helpers.js'

const USAGE =
  'canonry visibility-stats <project> [--since <iso>] [--until <iso>] [--month <YYYY-MM>] [--last-runs <n>] [--by-provider] [--share-of-voice] [--query-class branded|non-brand] [--format json|jsonl]'

/** Branded and non-brand are the only classes; there is deliberately no "all" — pooling them is the bug this option exists to prevent. */
function parseQueryClass(value: string | undefined): 'branded' | 'non-brand' | undefined {
  if (value === undefined || value === '') return undefined
  if (value !== 'branded' && value !== 'non-brand') {
    throw new Error(`--query-class must be "branded" or "non-brand" (got "${value}")`)
  }
  return value
}

const COMPARE_USAGE = 'canonry visibility-compare <project> --from <YYYY-MM> --to <YYYY-MM> [--scope project|group|market|property] [--scope-key <key>] [--market-key <key>] [--provider <engine>] [--location <label|none>] [--format json]'

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
      'query-class': stringOption(),
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
        queryClass: parseQueryClass(getString(input.values, 'query-class')),
        format: input.format,
      })
    },
  },
  {
    path: ['visibility-compare'],
    usage: COMPARE_USAGE,
    options: {
      from: stringOption(),
      to: stringOption(),
      scope: stringOption(),
      'scope-key': stringOption(),
      'market-key': stringOption(),
      provider: stringOption(),
      location: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'visibility-compare', COMPARE_USAGE)
      await showVisibilityCompare(project, {
        from: getString(input.values, 'from'),
        to: getString(input.values, 'to'),
        ...visibilityCompareSelectionSchema.parse({ scope: getString(input.values, 'scope'), scopeKey: getString(input.values, 'scope-key'), marketKey: getString(input.values, 'market-key'), provider: getString(input.values, 'provider'), location: getString(input.values, 'location') }),
        format: input.format,
      })
    },
  },
]
