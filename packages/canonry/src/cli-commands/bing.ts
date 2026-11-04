import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, parseIntegerOption, requirePositional, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const BING_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['bing', 'connect'],
    usage: 'canonry bing connect <project> [--api-key <key>] [--format json]',
    options: {
      'api-key': stringOption(),
    },
    run: async (input) => {
      const { bingConnect } = await import('../commands/bing.js')
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
      const { bingDisconnect } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.disconnect', 'canonry bing disconnect <project> [--format json]')
      await bingDisconnect(project, input.format)
    },
  },
  {
    path: ['bing', 'status'],
    usage: 'canonry bing status <project> [--format json]',
    run: async (input) => {
      const { bingStatus } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.status', 'canonry bing status <project> [--format json]')
      await bingStatus(project, input.format)
    },
  },
  {
    path: ['bing', 'sites'],
    usage: 'canonry bing sites <project> [--format json]',
    run: async (input) => {
      const { bingSites } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.sites', 'canonry bing sites <project> [--format json]')
      await bingSites(project, input.format)
    },
  },
  {
    path: ['bing', 'set-site'],
    usage: 'canonry bing set-site <project> <url> [--format json]',
    run: async (input) => {
      const { bingSetSite } = await import('../commands/bing.js')
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
    path: ['bing', 'coverage-history'],
    usage: 'canonry bing coverage-history <project> [--limit <n>] [--format json]',
    options: { limit: stringOption() },
    run: async (input) => {
      const { bingCoverageHistory } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.coverage-history', 'canonry bing coverage-history <project> [--limit <n>] [--format json]')
      await bingCoverageHistory(project, {
        limit: parseIntegerOption(input, 'limit', {
          command: 'bing.coverage-history',
          message: '--limit must be a positive integer',
          usage: 'canonry bing coverage-history <project> [--limit <n>] [--format json]',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['bing', 'coverage'],
    usage: 'canonry bing coverage <project> [--format json]',
    run: async (input) => {
      const { bingCoverage } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.coverage', 'canonry bing coverage <project> [--format json]')
      await bingCoverage(project, input.format)
    },
  },
  {
    path: ['bing', 'inspect'],
    usage: 'canonry bing inspect <project> <url> [--format json]',
    run: async (input) => {
      const { bingInspect } = await import('../commands/bing.js')
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
      const { bingInspections } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.inspections', 'canonry bing inspections <project> [--url <url>] [--format json]')
      await bingInspections(project, {
        url: getString(input.values, 'url'),
        format: input.format,
      })
    },
  },
  {
    path: ['bing', 'inspect-sitemap'],
    usage: 'canonry bing inspect-sitemap <project> [--sitemap-url <url>] [--wait] [--format json]',
    options: {
      'sitemap-url': stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const { bingInspectSitemap } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.inspect-sitemap', 'canonry bing inspect-sitemap <project> [--sitemap-url <url>] [--wait] [--format json]')
      await bingInspectSitemap(project, {
        sitemapUrl: getString(input.values, 'sitemap-url'),
        wait: getBoolean(input.values, 'wait'),
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
      const { bingRequestIndexing } = await import('../commands/bing.js')
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
      const { bingPerformance } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.performance', 'canonry bing performance <project> [--format json]')
      await bingPerformance(project, input.format)
    },
  },
  {
    path: ['bing', 'refresh'],
    usage: 'canonry bing refresh <project> [--format json]',
    run: async (input) => {
      const { bingRefresh } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.refresh', 'canonry bing refresh <project> [--format json]')
      await bingRefresh(project, input.format)
    },
  },
  {
    path: ['bing', 'sync'],
    usage: 'canonry bing sync <project> [--wait] [--format json]',
    options: { wait: { type: 'boolean', default: false } },
    run: async (input) => {
      const { bingSync } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.sync', 'canonry bing sync <project> [--wait] [--format json]')
      await bingSync(project, { wait: getBoolean(input.values, 'wait'), format: input.format })
    },
  },
  {
    path: ['bing', 'traffic'],
    usage: 'canonry bing traffic <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--format json|jsonl]',
    options: { days: stringOption(), 'start-date': stringOption(), 'end-date': stringOption() },
    run: async (input) => {
      const { bingTraffic } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.traffic', 'canonry bing traffic <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--format json|jsonl]')
      await bingTraffic(project, { days: getString(input.values, 'days'), startDate: getString(input.values, 'start-date'), endDate: getString(input.values, 'end-date'), format: input.format })
    },
  },
  {
    path: ['bing', 'queries'],
    usage: 'canonry bing queries <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--query <text>] [--group-by query|week] [--limit <n>] [--offset <n>] [--format json|jsonl]',
    options: { days: stringOption(), 'start-date': stringOption(), 'end-date': stringOption(), query: stringOption(), 'group-by': stringOption(), limit: stringOption(), offset: stringOption() },
    run: async (input) => {
      const { bingQueries } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.queries', 'canonry bing queries <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--query <text>] [--group-by query|week] [--limit <n>] [--offset <n>] [--format json|jsonl]')
      await bingQueries(project, {
        days: getString(input.values, 'days'), startDate: getString(input.values, 'start-date'), endDate: getString(input.values, 'end-date'),
        query: getString(input.values, 'query'),
        groupBy: getString(input.values, 'group-by'),
        limit: parseIntegerOption(input, 'limit', { command: 'bing.queries', message: '--limit must be an integer', usage: 'canonry bing queries <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--query <text>] [--group-by query|week] [--limit <n>] [--offset <n>] [--format json|jsonl]' }),
        offset: parseIntegerOption(input, 'offset', { command: 'bing.queries', message: '--offset must be an integer', usage: 'canonry bing queries <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--query <text>] [--group-by query|week] [--limit <n>] [--offset <n>] [--format json|jsonl]' }),
        format: input.format,
      })
    },
  },
  {
    path: ['bing', 'pages'],
    usage: 'canonry bing pages <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--page <text>] [--group-by page|week] [--limit <n>] [--offset <n>] [--format json|jsonl]',
    options: { days: stringOption(), 'start-date': stringOption(), 'end-date': stringOption(), page: stringOption(), 'group-by': stringOption(), limit: stringOption(), offset: stringOption() },
    run: async (input) => {
      const { bingPages } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.pages', 'canonry bing pages <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--page <text>] [--group-by page|week] [--limit <n>] [--offset <n>] [--format json|jsonl]')
      await bingPages(project, {
        days: getString(input.values, 'days'), startDate: getString(input.values, 'start-date'), endDate: getString(input.values, 'end-date'),
        page: getString(input.values, 'page'),
        groupBy: getString(input.values, 'group-by'),
        limit: parseIntegerOption(input, 'limit', { command: 'bing.pages', message: '--limit must be an integer', usage: 'canonry bing pages <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--page <text>] [--group-by page|week] [--limit <n>] [--offset <n>] [--format json|jsonl]' }),
        offset: parseIntegerOption(input, 'offset', { command: 'bing.pages', message: '--offset must be an integer', usage: 'canonry bing pages <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--page <text>] [--group-by page|week] [--limit <n>] [--offset <n>] [--format json|jsonl]' }),
        format: input.format,
      })
    },
  },
  {
    path: ['bing', 'crawl-stats'],
    usage: 'canonry bing crawl-stats <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--format json|jsonl]',
    options: { days: stringOption(), 'start-date': stringOption(), 'end-date': stringOption() },
    run: async (input) => {
      const { bingCrawlStats } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.crawl-stats', 'canonry bing crawl-stats <project> [--days <n>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--format json|jsonl]')
      await bingCrawlStats(project, { days: getString(input.values, 'days'), startDate: getString(input.values, 'start-date'), endDate: getString(input.values, 'end-date'), format: input.format })
    },
  },
  {
    path: ['bing', 'sitemaps'],
    usage: 'canonry bing sitemaps <project> [--format json|jsonl]',
        run: async (input) => {
      const { bingSitemaps } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.sitemaps', 'canonry bing sitemaps <project> [--format json|jsonl]')
      await bingSitemaps(project, input.format)
    },
  },
  {
    path: ['bing', 'site'],
    usage: 'canonry bing site <project> [--kind <kind>] [--format json|jsonl]',
    options: { kind: stringOption() },
    run: async (input) => {
      const { bingSite } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.site', 'canonry bing site <project> [--kind <kind>] [--format json|jsonl]')
      await bingSite(project, { kind: getString(input.values, 'kind'), format: input.format })
    },
  },
  {
    path: ['bing', 'keyword-demand'],
    usage: 'canonry bing keyword-demand <project> [--query <tracked query>] [--format json|jsonl]',
    options: { query: stringOption() },
    run: async (input) => {
      const { bingKeywordDemand } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.keyword-demand', 'canonry bing keyword-demand <project> [--query <tracked query>] [--format json|jsonl]')
      await bingKeywordDemand(project, { query: getString(input.values, 'query'), format: input.format })
    },
  },
  {
    path: ['bing', 'query-pages'],
    usage: 'canonry bing query-pages <project> <query> [--format json|jsonl]',
        run: async (input) => {
      const { bingQueryPages } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.query-pages', 'canonry bing query-pages <project> <query> [--format json|jsonl]')
      const searchQuery = requirePositional(input, 1, { command: 'bing.query-pages', usage: 'canonry bing query-pages <project> <query> [--format json|jsonl]', message: 'project name and query are required' })
      await bingQueryPages(project, searchQuery, input.format)
    },
  },
  {
    path: ['bing', 'page-queries'],
    usage: 'canonry bing page-queries <project> <page-url> [--format json|jsonl]',
        run: async (input) => {
      const { bingPageQueries } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.page-queries', 'canonry bing page-queries <project> <page-url> [--format json|jsonl]')
      const page = requirePositional(input, 1, { command: 'bing.page-queries', usage: 'canonry bing page-queries <project> <page-url> [--format json|jsonl]', message: 'project name and page URL are required' })
      await bingPageQueries(project, page, input.format)
    },
  },
  {
    path: ['bing', 'query-history'],
    usage: 'canonry bing query-history <project> <query> [--page <url>] [--format json|jsonl]',
    options: { page: stringOption() },
    run: async (input) => {
      const { bingQueryHistory } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.query-history', 'canonry bing query-history <project> <query> [--page <url>] [--format json|jsonl]')
      const searchQuery = requirePositional(input, 1, { command: 'bing.query-history', usage: 'canonry bing query-history <project> <query> [--page <url>] [--format json|jsonl]', message: 'project name and query are required' })
      await bingQueryHistory(project, { query: searchQuery, page: getString(input.values, 'page'), format: input.format })
    },
  },
  {
    path: ['bing', 'url-traffic'],
    usage: 'canonry bing url-traffic <project> <url> [--children] [--page <n>] [--format json|jsonl]',
    options: { children: { type: 'boolean', default: false }, page: stringOption() },
    run: async (input) => {
      const { bingUrlTraffic } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.url-traffic', 'canonry bing url-traffic <project> <url> [--children] [--page <n>] [--format json|jsonl]')
      const url = requirePositional(input, 1, { command: 'bing.url-traffic', usage: 'canonry bing url-traffic <project> <url> [--children] [--page <n>] [--format json|jsonl]', message: 'project name and URL are required' })
      await bingUrlTraffic(project, { url, children: getBoolean(input.values, 'children'), page: parseIntegerOption(input, 'page', { command: 'bing.url-traffic', message: '--page must be an integer', usage: 'canonry bing url-traffic <project> <url> [--children] [--page <n>] [--format json|jsonl]' }), format: input.format })
    },
  },
  {
    path: ['bing', 'url-children'],
    usage: 'canonry bing url-children <project> <url> [--page <n>] [--format json|jsonl]',
    options: { page: stringOption() },
    run: async (input) => {
      const { bingUrlChildren } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.url-children', 'canonry bing url-children <project> <url> [--page <n>] [--format json|jsonl]')
      const url = requirePositional(input, 1, { command: 'bing.url-children', usage: 'canonry bing url-children <project> <url> [--page <n>] [--format json|jsonl]', message: 'project name and URL are required' })
      await bingUrlChildren(project, { url, page: parseIntegerOption(input, 'page', { command: 'bing.url-children', message: '--page must be an integer', usage: 'canonry bing url-children <project> <url> [--page <n>] [--format json|jsonl]' }), format: input.format })
    },
  },
  {
    path: ['bing', 'links'],
    usage: 'canonry bing links <project> [--url <page-url>] [--page <n>] [--format json|jsonl]',
    options: { url: stringOption(), page: stringOption() },
    run: async (input) => {
      const { bingLinks } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.links', 'canonry bing links <project> [--url <page-url>] [--page <n>] [--format json|jsonl]')
      await bingLinks(project, { url: getString(input.values, 'url'), page: parseIntegerOption(input, 'page', { command: 'bing.links', message: '--page must be an integer', usage: 'canonry bing links <project> [--url <page-url>] [--page <n>] [--format json|jsonl]' }), format: input.format })
    },
  },
  {
    path: ['bing', 'fetched-urls'],
    usage: 'canonry bing fetched-urls <project> [--url <url>] [--format json|jsonl]',
    options: { url: stringOption() },
    run: async (input) => {
      const { bingFetchedUrls } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.fetched-urls', 'canonry bing fetched-urls <project> [--url <url>] [--format json|jsonl]')
      await bingFetchedUrls(project, { url: getString(input.values, 'url'), format: input.format })
    },
  },
  {
    path: ['bing', 'keywords'],
    usage: 'canonry bing keywords <project> <keyword> [--country <cc>] [--language <tag>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--format json|jsonl]',
    options: { country: stringOption(), language: stringOption(), 'start-date': stringOption(), 'end-date': stringOption() },
    run: async (input) => {
      const { bingKeywords } = await import('../commands/bing.js')
      const project = requireProject(input, 'bing.keywords', 'canonry bing keywords <project> <keyword> [--country <cc>] [--language <tag>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--format json|jsonl]')
      const keyword = requirePositional(input, 1, { command: 'bing.keywords', usage: 'canonry bing keywords <project> <keyword> [--country <cc>] [--language <tag>] [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--format json|jsonl]', message: 'project name and keyword are required' })
      await bingKeywords(project, {
        keyword,
        country: getString(input.values, 'country'),
        language: getString(input.values, 'language'),
        startDate: getString(input.values, 'start-date'),
        endDate: getString(input.values, 'end-date'),
        format: input.format,
      })
    },
  },
  {
    path: ['bing'],
    usage: 'canonry bing <connect|disconnect|status|sites|set-site|coverage|coverage-history|inspect|inspect-sitemap|inspections|request-indexing|performance|refresh|sync|traffic|queries|pages|crawl-stats|sitemaps|site|keyword-demand|query-pages|page-queries|query-history|url-traffic|url-children|links|fetched-urls|keywords> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'bing',
        usage: 'canonry bing <connect|disconnect|status|sites|set-site|coverage|coverage-history|inspect|inspect-sitemap|inspections|request-indexing|performance|refresh|sync|traffic|queries|pages|crawl-stats|sitemaps|site|keyword-demand|query-pages|page-queries|query-history|url-traffic|url-children|links|fetched-urls|keywords> <project> [args]',
        available: ['connect', 'disconnect', 'status', 'sites', 'set-site', 'coverage', 'coverage-history', 'inspect', 'inspect-sitemap', 'inspections', 'request-indexing', 'performance', 'refresh', 'sync', 'traffic', 'queries', 'pages', 'crawl-stats', 'sitemaps', 'site', 'keyword-demand', 'query-pages', 'page-queries', 'query-history', 'url-traffic', 'url-children', 'links', 'fetched-urls', 'keywords'],
      })
    },
  },
]
