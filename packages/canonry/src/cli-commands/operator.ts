import { applyConfigs } from '../commands/apply.js'
import { showAnalytics } from '../commands/analytics.js'
import { showSources } from '../commands/sources.js'
import { showEvidence } from '../commands/evidence.js'
import { exportProject } from '../commands/export-cmd.js'
import { exportResults } from '../commands/results-export.js'
import { showHistory } from '../commands/history.js'
import { showStatus } from '../commands/status.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, parseIntegerOption, requireProject, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const RESULTS_EXPORT_USAGE = 'canonry results export <project> [--format json|csv] [--since <ISO>] [--until <ISO>] [--include-probes] [--output <path>|-]'

function parseResultsExportFormat(value: string | undefined): 'json' | 'csv' {
  if (value === undefined || value === 'json') return 'json'
  if (value === 'csv') return 'csv'
  throw usageError(`Error: --format must be "json" or "csv"\n\nUsage: ${RESULTS_EXPORT_USAGE}`)
}

export const OPERATOR_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['results', 'export'],
    usage: RESULTS_EXPORT_USAGE,
    options: {
      since: stringOption(),
      until: stringOption(),
      'include-probes': { type: 'boolean', default: false },
      output: { type: 'string', short: 'o' },
    },
    run: async (input) => {
      const project = requireProject(input, 'results export', RESULTS_EXPORT_USAGE)
      await exportResults(project, {
        format: parseResultsExportFormat(getString(input.values, 'format')),
        since: getString(input.values, 'since'),
        until: getString(input.values, 'until'),
        includeProbes: getBoolean(input.values, 'include-probes'),
        output: getString(input.values, 'output'),
      })
    },
  },
  {
    path: ['status'],
    usage: 'canonry status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'status', 'canonry status <project> [--format json]')
      await showStatus(project, input.format)
    },
  },
  {
    path: ['evidence'],
    usage: 'canonry evidence <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'evidence', 'canonry evidence <project> [--format json]')
      await showEvidence(project, input.format)
    },
  },
  {
    path: ['history'],
    usage: 'canonry history <project> [--limit <n>] [--since <ISO>] [--action <action>] [--actor <actor>] [--entity-type <type>] [--format json|jsonl]\n       canonry history --all [same filters]',
    options: {
      all: { type: 'boolean', default: false },
      limit: stringOption(),
      since: stringOption(),
      action: stringOption(),
      actor: stringOption(),
      'entity-type': stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry history <project> [--limit <n>] [--since <ISO>] [--action <action>] [--actor <actor>] [--entity-type <type>] [--format json|jsonl]\n       canonry history --all [same filters]'
      const project = getBoolean(input.values, 'all') ? undefined : requireProject(input, 'history', usage)
      await showHistory(project, input.format, {
        limit: parseIntegerOption(input, 'limit', { command: 'history', usage, message: '--limit must be an integer' }),
        since: getString(input.values, 'since'),
        action: getString(input.values, 'action'),
        actor: getString(input.values, 'actor'),
        entityType: getString(input.values, 'entity-type'),
      })
    },
  },
  {
    path: ['export'],
    usage: 'canonry export <project> [--include-results] [--format json]',
    options: {
      'include-results': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'export', 'canonry export <project> [--include-results] [--format json]')
      await exportProject(project, {
        includeResults: getBoolean(input.values, 'include-results'),
        format: input.format,
      })
    },
  },
  {
    path: ['analytics'],
    usage: 'canonry analytics <project> [--feature metrics|gaps|sources] [--window 7d|30d|90d|all] [--format json]',
    options: {
      feature: stringOption(),
      window: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'analytics', 'canonry analytics <project> [--feature metrics|gaps|sources] [--window 7d|30d|90d|all] [--format json]')
      await showAnalytics(project, {
        feature: getString(input.values, 'feature'),
        window: getString(input.values, 'window'),
        format: input.format,
      })
    },
  },
  {
    path: ['sources'],
    usage: 'canonry sources <project> [--rank] [--limit N] [--by-provider] [--window 7d|30d|90d|all] [--format json|jsonl]',
    options: {
      rank: { type: 'boolean', default: false },
      'by-provider': { type: 'boolean', default: false },
      limit: stringOption(),
      window: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry sources <project> [--rank] [--limit N] [--by-provider] [--window 7d|30d|90d|all] [--format json|jsonl]'
      const project = requireProject(input, 'sources', usage)
      await showSources(project, {
        rank: getBoolean(input.values, 'rank'),
        byProvider: getBoolean(input.values, 'by-provider'),
        limit: parseIntegerOption(input, 'limit', {
          message: '--limit must be an integer',
          usage,
          command: 'sources',
        }),
        window: getString(input.values, 'window'),
        format: input.format,
      })
    },
  },
  {
    path: ['apply'],
    usage: 'canonry apply <file...> [--format json]',
    run: async (input) => {
      if (input.positionals.length === 0) {
        throw usageError('Error: at least one file path is required\nUsage: canonry apply <file...> [--format json]', {
          message: 'at least one file path is required',
          details: {
            command: 'apply',
            usage: 'canonry apply <file...> [--format json]',
          },
        })
      }
      await applyConfigs(input.positionals, input.format)
    },
  },
]
