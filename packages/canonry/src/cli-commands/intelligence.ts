import { listInsights, dismissInsight } from '../commands/insights.js'
import { showHealth } from '../commands/health-cmd.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { requireProject, requirePositional, getString } from '../cli-command-helpers.js'

export const INTELLIGENCE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['insights'],
    usage: 'canonry insights <project> [--dismissed] [--format json]',
    options: {
      dismissed: { type: 'boolean' },
    },
    run: async (input) => {
      const usage = 'canonry insights <project> [--dismissed] [--format json]'
      const project = requireProject(input, 'insights', usage)
      const dismissed = input.values.dismissed === true
      await listInsights(project, { dismissed, format: input.format })
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
      const limitStr = getString(input.values, 'limit')
      const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined
      await showHealth(project, { history, limit, format: input.format })
    },
  },
]
