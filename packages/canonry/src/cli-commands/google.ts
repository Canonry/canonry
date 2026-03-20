import {
  googleConnect,
  googleCoverage,
  googleCoverageHistory,
  googleDeindexed,
  googleDisconnect,
  googleDiscoverSitemaps,
  googleInspect,
  googleInspectSitemap,
  googleInspections,
  googleListSitemaps,
  googlePerformance,
  googleProperties,
  googleRequestIndexing,
  googleSetProperty,
  googleSetSitemap,
  googleStatus,
  googleSync,
} from '../commands/google.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requirePositional,
  requireProject,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const GOOGLE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['google', 'connect'],
    usage: 'canonry google connect <project> [--type gsc|ga4] [--public-url <url>] [--format json]',
    options: {
      type: stringOption(),
      'public-url': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'google.connect', 'canonry google connect <project> [--type gsc|ga4] [--public-url <url>] [--format json]')
      await googleConnect(project, {
        type: getString(input.values, 'type') ?? 'gsc',
        publicUrl: getString(input.values, 'public-url'),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'disconnect'],
    usage: 'canonry google disconnect <project> [--type gsc|ga4] [--format json]',
    options: {
      type: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'google.disconnect', 'canonry google disconnect <project> [--type gsc|ga4] [--format json]')
      await googleDisconnect(project, {
        type: getString(input.values, 'type') ?? 'gsc',
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'status'],
    usage: 'canonry google status <project>',
    run: async (input) => {
      const project = requireProject(input, 'google.status', 'canonry google status <project>')
      await googleStatus(project, input.format)
    },
  },
  {
    path: ['google', 'properties'],
    usage: 'canonry google properties <project>',
    run: async (input) => {
      const project = requireProject(input, 'google.properties', 'canonry google properties <project>')
      await googleProperties(project, input.format)
    },
  },
  {
    path: ['google', 'set-property'],
    usage: 'canonry google set-property <project> <url> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.set-property', 'canonry google set-property <project> <url> [--format json]')
      const propertyUrl = requirePositional(input, 1, {
        command: 'google.set-property',
        usage: 'canonry google set-property <project> <url> [--format json]',
        message: 'project name and property URL are required',
      })
      await googleSetProperty(project, propertyUrl, input.format)
    },
  },
  {
    path: ['google', 'set-sitemap'],
    usage: 'canonry google set-sitemap <project> <url> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.set-sitemap', 'canonry google set-sitemap <project> <url> [--format json]')
      const sitemapUrl = requirePositional(input, 1, {
        command: 'google.set-sitemap',
        usage: 'canonry google set-sitemap <project> <url> [--format json]',
        message: 'project name and sitemap URL are required',
      })
      await googleSetSitemap(project, sitemapUrl, input.format)
    },
  },
  {
    path: ['google', 'list-sitemaps'],
    usage: 'canonry google list-sitemaps <project>',
    run: async (input) => {
      const project = requireProject(input, 'google.list-sitemaps', 'canonry google list-sitemaps <project>')
      await googleListSitemaps(project, { format: input.format })
    },
  },
  {
    path: ['google', 'sync'],
    usage: 'canonry google sync <project> [--type gsc|ga4] [--days <n>] [--full] [--wait] [--format json]',
    options: {
      type: stringOption(),
      days: stringOption(),
      full: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'google.sync', 'canonry google sync <project> [--type gsc|ga4] [--days <n>] [--full] [--wait] [--format json]')
      await googleSync(project, {
        type: getString(input.values, 'type') ?? 'gsc',
        days: parseIntegerOption(input, 'days', {
          command: 'google.sync',
          usage: 'canonry google sync <project> [--type gsc|ga4] [--days <n>] [--full] [--wait] [--format json]',
          message: '--days must be an integer',
        }),
        full: getBoolean(input.values, 'full'),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'performance'],
    usage: 'canonry google performance <project> [--days <n>] [--keyword <kw>] [--page <url>] [--format json]',
    options: {
      days: stringOption(),
      keyword: stringOption(),
      page: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'google.performance', 'canonry google performance <project> [--days <n>] [--keyword <kw>] [--page <url>] [--format json]')
      await googlePerformance(project, {
        days: parseIntegerOption(input, 'days', {
          command: 'google.performance',
          usage: 'canonry google performance <project> [--days <n>] [--keyword <kw>] [--page <url>] [--format json]',
          message: '--days must be an integer',
        }),
        keyword: getString(input.values, 'keyword'),
        page: getString(input.values, 'page'),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'inspect'],
    usage: 'canonry google inspect <project> <url>',
    run: async (input) => {
      const project = requireProject(input, 'google.inspect', 'canonry google inspect <project> <url>')
      const url = requirePositional(input, 1, {
        command: 'google.inspect',
        usage: 'canonry google inspect <project> <url>',
        message: 'project name and URL are required',
      })
      await googleInspect(project, url, input.format)
    },
  },
  {
    path: ['google', 'inspections'],
    usage: 'canonry google inspections <project> [--url <url>] [--format json]',
    options: {
      url: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'google.inspections', 'canonry google inspections <project> [--url <url>] [--format json]')
      await googleInspections(project, {
        url: getString(input.values, 'url'),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'inspect-sitemap'],
    usage: 'canonry google inspect-sitemap <project> [--sitemap-url <url>] [--wait] [--format json]',
    options: {
      'sitemap-url': stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'google.inspect-sitemap', 'canonry google inspect-sitemap <project> [--sitemap-url <url>] [--wait] [--format json]')
      await googleInspectSitemap(project, {
        sitemapUrl: getString(input.values, 'sitemap-url'),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'coverage'],
    usage: 'canonry google coverage <project>',
    run: async (input) => {
      const project = requireProject(input, 'google.coverage', 'canonry google coverage <project>')
      await googleCoverage(project, input.format)
    },
  },
  {
    path: ['google', 'coverage-history'],
    usage: 'canonry google coverage-history <project> [--limit <n>] [--format json]',
    options: {
      limit: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'google.coverage-history', 'canonry google coverage-history <project> [--limit <n>] [--format json]')
      await googleCoverageHistory(project, {
        limit: parseIntegerOption(input, 'limit', {
          command: 'google.coverage-history',
          usage: 'canonry google coverage-history <project> [--limit <n>] [--format json]',
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'deindexed'],
    usage: 'canonry google deindexed <project>',
    run: async (input) => {
      const project = requireProject(input, 'google.deindexed', 'canonry google deindexed <project>')
      await googleDeindexed(project, input.format)
    },
  },
  {
    path: ['google', 'discover-sitemaps'],
    usage: 'canonry google discover-sitemaps <project> [--wait] [--format json]',
    options: {
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'google.discover-sitemaps', 'canonry google discover-sitemaps <project> [--wait] [--format json]')
      await googleDiscoverSitemaps(project, {
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'request-indexing'],
    usage: 'canonry google request-indexing <project> [url] [--all-unindexed] [--wait] [--format json]',
    options: {
      'all-unindexed': { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'google.request-indexing', 'canonry google request-indexing <project> [url] [--all-unindexed] [--wait] [--format json]')
      const url = input.positionals[1]
      const allUnindexed = getBoolean(input.values, 'all-unindexed')
      if (!url && !allUnindexed) {
        throw usageError('Error: provide a URL or use --all-unindexed', {
          message: 'provide a URL or use --all-unindexed',
          details: {
            command: 'google.request-indexing',
            usage: 'canonry google request-indexing <project> [url] [--all-unindexed] [--wait] [--format json]',
          },
        })
      }
      await googleRequestIndexing(project, {
        url,
        allUnindexed,
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['google'],
    usage: 'canonry google <connect|disconnect|status|properties|set-property|set-sitemap|list-sitemaps|discover-sitemaps|sync|performance|inspect|inspect-sitemap|coverage|coverage-history|inspections|deindexed|request-indexing> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'google',
        usage: 'canonry google <connect|disconnect|status|properties|set-property|set-sitemap|list-sitemaps|discover-sitemaps|sync|performance|inspect|inspect-sitemap|coverage|coverage-history|inspections|deindexed|request-indexing> <project> [args]',
        available: ['connect', 'disconnect', 'status', 'properties', 'set-property', 'set-sitemap', 'list-sitemaps', 'discover-sitemaps', 'sync', 'performance', 'inspect', 'inspect-sitemap', 'coverage', 'coverage-history', 'inspections', 'deindexed', 'request-indexing'],
      })
    },
  },
]
