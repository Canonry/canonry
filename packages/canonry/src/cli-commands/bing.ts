import {
  bingConnect,
  bingCoverage,
  bingDisconnect,
  bingInspect,
  bingInspections,
  bingPerformance,
  bingRefresh,
  bingRequestIndexing,
  bingSetSite,
  bingSites,
  bingStatus,
} from '../commands/bing.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, requirePositional, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const BING_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['bing', 'connect'],
    usage: 'canonry bing connect <project> [--api-key <key>] [--format json]',
    options: {
      'api-key': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'bing.connect', 'canonry bing connect <project> [--api-key <key>] [--format json]')
      await bingConnect(project, {
        apiKey: getString(input.values, 'api-key'),
        format: input.format,
      })
    },
  },
  {
    path: ['bing', 'disconnect'],
    usage: 'canonry bing disconnect <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'bing.disconnect', 'canonry bing disconnect <project> [--format json]')
      await bingDisconnect(project, input.format)
    },
  },
  {
    path: ['bing', 'status'],
    usage: 'canonry bing status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'bing.status', 'canonry bing status <project> [--format json]')
      await bingStatus(project, input.format)
    },
  },
  {
    path: ['bing', 'sites'],
    usage: 'canonry bing sites <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'bing.sites', 'canonry bing sites <project> [--format json]')
      await bingSites(project, input.format)
    },
  },
  {
    path: ['bing', 'set-site'],
    usage: 'canonry bing set-site <project> <url> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'bing.set-site', 'canonry bing set-site <project> <url> [--format json]')
      const siteUrl = requirePositional(input, 1, {
        command: 'bing.set-site',
        usage: 'canonry bing set-site <project> <url> [--format json]',
        message: 'project name and site URL are required',
      })
      await bingSetSite(project, siteUrl, input.format)
    },
  },
  {
    path: ['bing', 'coverage'],
    usage: 'canonry bing coverage <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'bing.coverage', 'canonry bing coverage <project> [--format json]')
      await bingCoverage(project, input.format)
    },
  },
  {
    path: ['bing', 'inspect'],
    usage: 'canonry bing inspect <project> <url> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'bing.inspect', 'canonry bing inspect <project> <url> [--format json]')
      const url = requirePositional(input, 1, {
        command: 'bing.inspect',
        usage: 'canonry bing inspect <project> <url> [--format json]',
        message: 'project name and URL are required',
      })
      await bingInspect(project, url, input.format)
    },
  },
  {
    path: ['bing', 'inspections'],
    usage: 'canonry bing inspections <project> [--url <url>] [--format json]',
    options: {
      url: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'bing.inspections', 'canonry bing inspections <project> [--url <url>] [--format json]')
      await bingInspections(project, {
        url: getString(input.values, 'url'),
        format: input.format,
      })
    },
  },
  {
    path: ['bing', 'request-indexing'],
    usage: 'canonry bing request-indexing <project> [url] [--all-unindexed] [--format json]',
    options: {
      'all-unindexed': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'bing.request-indexing', 'canonry bing request-indexing <project> [url] [--all-unindexed] [--format json]')
      const url = input.positionals[1]
      const allUnindexed = getBoolean(input.values, 'all-unindexed')
      if (!url && !allUnindexed) {
        throw usageError('Error: provide a URL or use --all-unindexed', {
          message: 'provide a URL or use --all-unindexed',
          details: {
            command: 'bing.request-indexing',
            usage: 'canonry bing request-indexing <project> [url] [--all-unindexed] [--format json]',
          },
        })
      }
      await bingRequestIndexing(project, {
        url,
        allUnindexed,
        format: input.format,
      })
    },
  },
  {
    path: ['bing', 'performance'],
    usage: 'canonry bing performance <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'bing.performance', 'canonry bing performance <project> [--format json]')
      await bingPerformance(project, input.format)
    },
  },
  {
    path: ['bing', 'refresh'],
    usage: 'canonry bing refresh <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'bing.refresh', 'canonry bing refresh <project> [--format json]')
      await bingRefresh(project, input.format)
    },
  },
  {
    path: ['bing'],
    usage: 'canonry bing <connect|disconnect|status|sites|set-site|coverage|inspect|inspections|request-indexing|performance|refresh> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'bing',
        usage: 'canonry bing <connect|disconnect|status|sites|set-site|coverage|inspect|inspections|request-indexing|performance|refresh> <project> [args]',
        available: ['connect', 'disconnect', 'status', 'sites', 'set-site', 'coverage', 'inspect', 'inspections', 'request-indexing', 'performance', 'refresh'],
      })
    },
  },
]
