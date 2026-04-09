import { listInsights, dismissInsight } from '../commands/insights.js'
import { showHealth } from '../commands/health-cmd.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { requireProject, requirePositional, getString, parseIntegerOption } from '../cli-command-helpers.js'

export const INTELLIGENCE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['insights'],
    usage: 'canonry insights <project> [--dismissed] [--run-id <id>] [--format json]',
    options: {
      dismissed: { type: 'boolean' },
      'run-id': { type: 'string' },
    },
    run: async (input) => {
      const usage = 'canonry insights <project> [--dismissed] [--run-id <id>] [--format json]'
      const project = requireProject(input, 'insights', usage)
      const dismissed = input.values.dismissed === true
      const runId = getString(input.values, 'run-id')
      await listInsights(project, { dismissed, runId, format: input.format })
    },
  },
  {
    path: ['insights', 'dismiss'],
    usage: 'canonry insights dismiss <project> <id> [--format json]',
    options: {},
    run: async (input) => {
      const usage = 'canonry insights dismiss <project> <id> [--format json]'
      const project = requireProject(input, 'insights dismiss', usage)
      const id = requirePositional(input, 1, { command: 'insights dismiss', usage, message: 'insight ID is required' })
      await dismissInsight(project, id, { format: input.format })
    },
  },
  {
    path: ['health'],
    usage: 'canonry health <project> [--history] [--limit <n>] [--format json]',
    options: {
      history: { type: 'boolean' },
      limit: { type: 'string' },
    },
    run: async (input) => {
      const usage = 'canonry health <project> [--history] [--limit <n>] [--format json]'
      const project = requireProject(input, 'health', usage)
      const history = input.values.history === true
      const limit = parseIntegerOption(input, 'limit', {
        command: 'health',
        usage,
        message: '--limit must be an integer',
      })
      await showHealth(project, { history, limit, format: input.format })
    },
  },
]
