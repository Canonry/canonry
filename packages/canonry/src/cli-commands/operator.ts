import { applyConfigs } from '../commands/apply.js'
import { showAnalytics } from '../commands/analytics.js'
import { showEvidence } from '../commands/evidence.js'
import { exportProject } from '../commands/export-cmd.js'
import { showHistory } from '../commands/history.js'
import { showStatus } from '../commands/status.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, requireProject, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const OPERATOR_CLI_COMMANDS: readonly CliCommandSpec[] = [
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
    usage: 'canonry history <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'history', 'canonry history <project> [--format json]')
      await showHistory(project, input.format)
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
