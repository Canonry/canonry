import { backfillAiReferralPathsCommand, backfillAnswerVisibilityCommand, backfillInsightsCommand, backfillNormalizedPathsCommand } from '../commands/backfill.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { requireProject, getString, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

export const BACKFILL_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['backfill', 'answer-visibility'],
    usage: 'canonry backfill answer-visibility [--project <name>] [--format json]',
    options: {
      project: stringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await backfillAnswerVisibilityCommand({
        project: getString(input.values, 'project'),
        format: input.format,
      })
    },
  },
  {
    path: ['backfill', 'insights'],
    usage: 'canonry backfill insights <project> [--from-run <id>] [--to-run <id>] [--format json]',
    options: {
      'from-run': stringOption(),
      'to-run': stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry backfill insights <project> [--from-run <id>] [--to-run <id>] [--format json]'
      const project = requireProject(input, 'backfill insights', usage)
      await backfillInsightsCommand(project, {
        fromRun: getString(input.values, 'from-run'),
        toRun: getString(input.values, 'to-run'),
        format: input.format,
      })
    },
  },
  {
    path: ['backfill', 'normalized-paths'],
    usage: 'canonry backfill normalized-paths [--project <name>] [--format json]',
    options: {
      project: stringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await backfillNormalizedPathsCommand({
        project: getString(input.values, 'project'),
        format: input.format,
      })
    },
  },
  {
    path: ['backfill', 'ai-referral-paths'],
    usage: 'canonry backfill ai-referral-paths [--project <name>] [--format json]',
    options: {
      project: stringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await backfillAiReferralPathsCommand({
        project: getString(input.values, 'project'),
        format: input.format,
      })
    },
  },
  {
    path: ['backfill'],
    usage: 'canonry backfill <answer-visibility|insights|normalized-paths|ai-referral-paths> [options]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'backfill',
        usage: 'canonry backfill <answer-visibility|insights|normalized-paths|ai-referral-paths> [options]',
        available: ['answer-visibility', 'insights', 'normalized-paths', 'ai-referral-paths'],
      })
    },
  },
]
