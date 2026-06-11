import {
  technicalAeoPages,
  technicalAeoRun,
  technicalAeoScore,
  technicalAeoTrend,
} from '../commands/technical-aeo.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requireProject,
  stringOption,
} from '../cli-command-helpers.js'

export const TECHNICAL_AEO_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['technical-aeo', 'score'],
    usage: 'canonry technical-aeo score <project> [--format json]',
    run: async (input) => {
      const project = requireProject(
        input,
        'technical-aeo.score',
        'canonry technical-aeo score <project> [--format json]',
      )
      await technicalAeoScore(project, { format: input.format })
    },
  },
  {
    path: ['technical-aeo', 'pages'],
    usage: 'canonry technical-aeo pages <project> [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]',
    options: {
      status: stringOption(),
      sort: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo pages <project> [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.pages', usage)
      await technicalAeoPages(project, {
        status: getString(input.values, 'status'),
        sort: getString(input.values, 'sort'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.pages',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'trend'],
    usage: 'canonry technical-aeo trend <project> [--limit <n>] [--format json|jsonl]',
    options: {
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo trend <project> [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.trend', usage)
      await technicalAeoTrend(project, {
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.trend',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'run'],
    usage: 'canonry technical-aeo run <project> [--sitemap-url <url>] [--limit <n>] [--wait] [--format json]',
    options: {
      'sitemap-url': stringOption(),
      limit: stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo run <project> [--sitemap-url <url>] [--limit <n>] [--wait] [--format json]'
      const project = requireProject(input, 'technical-aeo.run', usage)
      await technicalAeoRun(project, {
        sitemapUrl: getString(input.values, 'sitemap-url'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.run',
          usage,
          message: '--limit must be an integer',
        }),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
]
