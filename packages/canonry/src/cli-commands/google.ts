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
  googlePerformanceDaily,
  googleTopPages,
  googleQueryTotals,
  googleProperties,
  googleRefresh,
  googleRequestIndexing,
  googleSetProperty,
  googleSetSitemap,
  googleSubmitSitemaps,
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

const GOOGLE_PERFORMANCE_USAGE =
  'canonry google performance <project> [--days <n> | --start <YYYY-MM-DD> --end <YYYY-MM-DD>] [--keyword <kw>] [--page <url>] [--limit <n>] [--offset <n>] [--order-by clicks|impressions|date] [--format json]'

const GOOGLE_QUERY_TOTALS_USAGE =
  'canonry google query-totals <project> [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>] [--window 7d|30d|90d|all] [--limit <n>] [--offset <n>] [--format json]'

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
    usage: 'canonry google status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.status', 'canonry google status <project> [--format json]')
      await googleStatus(project, input.format)
    },
  },
  {
    path: ['google', 'properties'],
    usage: 'canonry google properties <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.properties', 'canonry google properties <project> [--format json]')
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
    usage: 'canonry google list-sitemaps <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.list-sitemaps', 'canonry google list-sitemaps <project> [--format json]')
      await googleListSitemaps(project, { format: input.format })
    },
  },
  {
    path: ['google', 'submit-sitemap'],
    usage: 'canonry google submit-sitemap <project> [url...] [--configured|--all|--all-files] [--format json|jsonl]',
    options: {
      configured: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      'all-files': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'google.submit-sitemap', 'canonry google submit-sitemap <project> [url...] [--configured|--all|--all-files] [--format json|jsonl]')
      const sitemapUrls = input.positionals.slice(1)
      const configured = getBoolean(input.values, 'configured')
      const all = getBoolean(input.values, 'all')
      const allFiles = getBoolean(input.values, 'all-files')
      if (Number(sitemapUrls.length > 0) + Number(configured) + Number(all) + Number(allFiles) !== 1) {
        throw usageError('Error: provide sitemap URL(s), --configured, --all, or --all-files (exactly one)', {
          message: 'provide sitemap URL(s), --configured, --all, or --all-files (exactly one)',
          details: {
            command: 'google.submit-sitemap',
            usage: 'canonry google submit-sitemap <project> [url...] [--configured|--all|--all-files] [--format json|jsonl]',
          },
        })
      }
      await googleSubmitSitemaps(project, {
        sitemapUrls,
        configured,
        all,
        allFiles,
        format: input.format,
      })
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
    usage: GOOGLE_PERFORMANCE_USAGE,
    options: {
      days: stringOption(),
      start: stringOption(),
      end: stringOption(),
      keyword: stringOption(),
      page: stringOption(),
      limit: stringOption(),
      offset: stringOption(),
      'order-by': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'google.performance', GOOGLE_PERFORMANCE_USAGE)
      const startDate = getString(input.values, 'start')
      const endDate = getString(input.values, 'end')
      const days = parseIntegerOption(input, 'days', {
        command: 'google.performance',
        usage: GOOGLE_PERFORMANCE_USAGE,
        message: '--days must be an integer',
      })
      // --start/--end and --days describe the same window two ways. Picking one
      // silently would hand back a window the caller did not ask for.
      if (days !== undefined && (startDate || endDate)) {
        throw usageError(
          `Error: --days cannot be combined with --start/--end. Pass one window.\nUsage: ${GOOGLE_PERFORMANCE_USAGE}`,
          {
            message: '--days cannot be combined with --start/--end',
            details: { command: 'google.performance', usage: GOOGLE_PERFORMANCE_USAGE },
          },
        )
      }
      await googlePerformance(project, {
        days,
        startDate,
        endDate,
        keyword: getString(input.values, 'keyword'),
        page: getString(input.values, 'page'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'google.performance',
          usage: GOOGLE_PERFORMANCE_USAGE,
          message: '--limit must be an integer',
        }),
        offset: parseIntegerOption(input, 'offset', {
          command: 'google.performance',
          usage: GOOGLE_PERFORMANCE_USAGE,
          message: '--offset must be an integer',
        }),
        orderBy: getString(input.values, 'order-by'),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'performance-daily'],
    usage: 'canonry google performance-daily <project> [--window 7d|30d|90d|all] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>] [--format json]',
    options: {
      window: stringOption(),
      start: stringOption(),
      end: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'google.performance-daily', 'canonry google performance-daily <project> [--window 7d|30d|90d|all] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>] [--format json]')
      await googlePerformanceDaily(project, {
        window: getString(input.values, 'window'),
        startDate: getString(input.values, 'start'),
        endDate: getString(input.values, 'end'),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'top-pages'],
    usage: 'canonry google top-pages <project> [--window 7d|30d|90d|all] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>] [--limit <n>] [--format json]',
    options: {
      window: stringOption(),
      start: stringOption(),
      end: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry google top-pages <project> [--window 7d|30d|90d|all] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>] [--limit <n>] [--format json]'
      const project = requireProject(input, 'google.top-pages', usage)
      await googleTopPages(project, {
        window: getString(input.values, 'window'),
        startDate: getString(input.values, 'start'),
        endDate: getString(input.values, 'end'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'google.top-pages',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'query-totals'],
    usage: GOOGLE_QUERY_TOTALS_USAGE,
    options: {
      window: stringOption(),
      start: stringOption(),
      end: stringOption(),
      limit: stringOption(),
      offset: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'google.query-totals', GOOGLE_QUERY_TOTALS_USAGE)
      await googleQueryTotals(project, {
        window: getString(input.values, 'window'),
        startDate: getString(input.values, 'start'),
        endDate: getString(input.values, 'end'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'google.query-totals',
          usage: GOOGLE_QUERY_TOTALS_USAGE,
          message: '--limit must be an integer',
        }),
        offset: parseIntegerOption(input, 'offset', {
          command: 'google.query-totals',
          usage: GOOGLE_QUERY_TOTALS_USAGE,
          message: '--offset must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['google', 'inspect'],
    usage: 'canonry google inspect <project> <url> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.inspect', 'canonry google inspect <project> <url> [--format json]')
      const url = requirePositional(input, 1, {
        command: 'google.inspect',
        usage: 'canonry google inspect <project> <url> [--format json]',
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
    usage: 'canonry google coverage <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.coverage', 'canonry google coverage <project> [--format json]')
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
    usage: 'canonry google deindexed <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.deindexed', 'canonry google deindexed <project> [--format json]')
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
    path: ['google', 'refresh'],
    usage: 'canonry google refresh <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'google.refresh', 'canonry google refresh <project> [--format json]')
      await googleRefresh(project, input.format)
    },
  },
  {
    path: ['google'],
    usage: 'canonry google <connect|disconnect|status|properties|set-property|set-sitemap|list-sitemaps|submit-sitemap|discover-sitemaps|sync|performance|performance-daily|top-pages|query-totals|inspect|inspect-sitemap|coverage|coverage-history|inspections|deindexed|request-indexing|refresh> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'google',
        usage: 'canonry google <connect|disconnect|status|properties|set-property|set-sitemap|list-sitemaps|submit-sitemap|discover-sitemaps|sync|performance|performance-daily|top-pages|query-totals|inspect|inspect-sitemap|coverage|coverage-history|inspections|deindexed|request-indexing|refresh> <project> [args]',
        available: ['connect', 'disconnect', 'status', 'properties', 'set-property', 'set-sitemap', 'list-sitemaps', 'submit-sitemap', 'discover-sitemaps', 'sync', 'performance', 'performance-daily', 'top-pages', 'query-totals', 'inspect', 'inspect-sitemap', 'coverage', 'coverage-history', 'inspections', 'deindexed', 'request-indexing', 'refresh'],
      })
    },
  },
]
