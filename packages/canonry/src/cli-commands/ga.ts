import {
  gaAiReferralHistory,
  gaAttribution,
  gaConnect,
  gaCoverage,
  gaDisconnect,
  gaSocialReferralHistory,
  gaSocialReferralSummary,
  gaStatus,
  gaSync,
  gaTraffic,
} from '../commands/ga.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

export const GA_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['ga', 'connect'],
    usage: 'canonry ga connect <project> --property-id <id> --key-file <path> [--key-json <json>] [--format json]',
    options: {
      'property-id': stringOption(),
      'key-file': stringOption(),
      'key-json': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'ga.connect', 'canonry ga connect <project> --property-id <id> --key-file <path>')
      const propertyId = getString(input.values, 'property-id')
      if (!propertyId) {
        throw new Error('--property-id is required')
      }
      await gaConnect(project, {
        propertyId,
        keyFile: getString(input.values, 'key-file'),
        keyJson: getString(input.values, 'key-json'),
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'disconnect'],
    usage: 'canonry ga disconnect <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ga.disconnect', 'canonry ga disconnect <project> [--format json]')
      await gaDisconnect(project, input.format)
    },
  },
  {
    path: ['ga', 'status'],
    usage: 'canonry ga status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ga.status', 'canonry ga status <project> [--format json]')
      await gaStatus(project, input.format)
    },
  },
  {
    path: ['ga', 'sync'],
    usage: 'canonry ga sync <project> [--days 30] [--only traffic|ai|social] [--format json]',
    options: {
      days: stringOption(),
      only: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'ga.sync', 'canonry ga sync <project> [--days 30] [--only traffic|ai|social] [--format json]')
      const daysStr = getString(input.values, 'days')
      const days = daysStr ? parseInt(daysStr, 10) : undefined
      const only = getString(input.values, 'only')
      await gaSync(project, {
        days,
        only,
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'traffic'],
    usage: 'canonry ga traffic <project> [--limit 50] [--format json]',
    options: {
      limit: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'ga.traffic', 'canonry ga traffic <project> [--limit 50] [--format json]')
      const limitStr = getString(input.values, 'limit')
      const limit = limitStr ? parseInt(limitStr, 10) : undefined
      await gaTraffic(project, {
        limit,
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'coverage'],
    usage: 'canonry ga coverage <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ga.coverage', 'canonry ga coverage <project> [--format json]')
      await gaCoverage(project, input.format)
    },
  },
  {
    path: ['ga', 'ai-referral-history'],
    usage: 'canonry ga ai-referral-history <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ga.ai-referral-history', 'canonry ga ai-referral-history <project> [--format json]')
      await gaAiReferralHistory(project, input.format)
    },
  },
  {
    path: ['ga', 'social-referral-history'],
    usage: 'canonry ga social-referral-history <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ga.social-referral-history', 'canonry ga social-referral-history <project> [--format json]')
      await gaSocialReferralHistory(project, input.format)
    },
  },
  {
    path: ['ga', 'social-referral-summary'],
    usage: 'canonry ga social-referral-summary <project> [--trend] [--format json]',
    options: {
      trend: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'ga.social-referral-summary', 'canonry ga social-referral-summary <project> [--trend] [--format json]')
      await gaSocialReferralSummary(project, {
        trend: input.values.trend === true,
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'attribution'],
    usage: 'canonry ga attribution <project> [--trend] [--format json]',
    options: {
      trend: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'ga.attribution', 'canonry ga attribution <project> [--trend] [--format json]')
      await gaAttribution(project, {
        trend: input.values.trend === true,
        format: input.format,
      })
    },
  },
  {
    path: ['ga'],
    usage: 'canonry ga <subcommand> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'ga',
        usage: 'canonry ga <subcommand> <project> [args]',
        available: ['connect', 'disconnect', 'status', 'sync', 'traffic', 'coverage', 'ai-referral-history', 'social-referral-history', 'social-referral-summary', 'attribution'],
      })
    },
  },
]
