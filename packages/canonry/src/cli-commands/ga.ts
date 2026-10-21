import { WINDOW_SETS } from '@canonry/canonry-contracts'
import type { CliCommandSpec, CliValues } from '../cli-dispatch.js'
import { getString, parseIntegerOption, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

/**
 * `--window` is rolling from now and can never name a calendar month, so every
 * date-scoped GA read also takes explicit `--start` / `--end` (YYYY-MM-DD).
 * Explicit dates win over `--window` server-side.
 */
const RANGE_OPTIONS = {
  window: stringOption(),
  start: stringOption(),
  end: stringOption(),
} as const

const RANGE_USAGE = `[--window ${WINDOW_SETS.metrics.join('|')}] [--start YYYY-MM-DD] [--end YYYY-MM-DD]`

function rangeValues(values: CliValues): { window?: string; startDate?: string; endDate?: string } {
  return {
    window: getString(values, 'window'),
    startDate: getString(values, 'start'),
    endDate: getString(values, 'end'),
  }
}

export const GA_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['ga', 'acquisition'],
    windows: WINDOW_SETS.metrics,
    usage: 'canonry ga acquisition <project> [--window 7d|30d|90d|all] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--channel <group>] [--source <source>] [--medium <medium>] [--host <hostname>] [--landing-page <page>] [--path-prefix <prefix>] [--group-by date,channel,source,medium,host,landing-page] [--limit 100] [--offset 0] [--format json|jsonl]',
    help: 'Stored GA4 sessions only, with filtered totals independent of grouping and paging. Never calls Google. Meaningful page query parameters remain distinct.',
    options: { ...RANGE_OPTIONS, channel: stringOption(), source: stringOption(), medium: stringOption(), host: stringOption(), 'landing-page': stringOption(), 'path-prefix': stringOption(), 'group-by': stringOption(), limit: stringOption(), offset: stringOption() },
    run: async input => {
      const { gaAcquisition } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.acquisition', 'canonry ga acquisition <project>')
      const aliases: Record<string, string> = { channel: 'channelGroup', host: 'hostName', 'landing-page': 'landingPage' }
      const groupBy = getString(input.values, 'group-by')?.split(',').map(key => aliases[key.trim()] ?? key.trim()).join(',')
      const integer = (name: string) => parseIntegerOption(input, name, { command: 'ga.acquisition', usage: 'canonry ga acquisition <project>', message: `--${name} must be an integer` })
      await gaAcquisition(project, { ...rangeValues(input.values), channel: getString(input.values, 'channel'), source: getString(input.values, 'source'), medium: getString(input.values, 'medium'), hostName: getString(input.values, 'host'), landingPage: getString(input.values, 'landing-page'), pathPrefix: getString(input.values, 'path-prefix'), groupBy, limit: integer('limit'), offset: integer('offset'), format: input.format })
    },
  },
  {
    path: ['ga', 'connect'],
    usage: 'canonry ga connect <project> --property-id <id> [--key-file <path>] [--key-json <json>] [--format json]',
    options: {
      'property-id': stringOption(),
      'key-file': stringOption(),
      'key-json': stringOption(),
    },
    run: async (input) => {
      const { gaConnect } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.connect', 'canonry ga connect <project> --property-id <id> [--key-file <path>]')
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
      const { gaDisconnect } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.disconnect', 'canonry ga disconnect <project> [--format json]')
      await gaDisconnect(project, input.format)
    },
  },
  {
    path: ['ga', 'properties'],
    usage: 'canonry ga properties <project> [--format json]',
    run: async (input) => {
      const { gaProperties } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.properties', 'canonry ga properties <project> [--format json]')
      await gaProperties(project, input.format)
    },
  },
  {
    path: ['ga', 'status'],
    usage: 'canonry ga status <project> [--format json]',
    run: async (input) => {
      const { gaStatus } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.status', 'canonry ga status <project> [--format json]')
      await gaStatus(project, input.format)
    },
  },
  {
    path: ['ga', 'sync'],
    usage: 'canonry ga sync <project> [--days 30] [--only traffic|ai|social|search-landing] [--format json]',
    options: {
      days: stringOption(),
      only: stringOption(),
    },
    run: async (input) => {
      const { gaSync } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.sync', 'canonry ga sync <project> [--days 30] [--only traffic|ai|social|search-landing] [--format json]')
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
    path: ['ga', 'measurement-analysis'],
    windows: WINDOW_SETS.gaMeasurementAnalysis,
    usage: 'canonry ga measurement-analysis <project> [--window 30d|60d|90d] [--host-scope marketing|all] [--path-prefix /path] [--limit 100] [--format json]',
    options: {
      window: stringOption(),
      'host-scope': stringOption(),
      'path-prefix': stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const { gaMeasurementAnalysis } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.measurement-analysis', 'canonry ga measurement-analysis <project> [--window 30d|60d|90d] [--format json]')
      const limitValue = getString(input.values, 'limit')
      await gaMeasurementAnalysis(project, {
        window: getString(input.values, 'window'),
        hostScope: getString(input.values, 'host-scope'),
        pathPrefix: getString(input.values, 'path-prefix'),
        limit: limitValue ? parseInt(limitValue, 10) : undefined,
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'search-landing-pages'],
    windows: WINDOW_SETS.gaSearchLanding,
    usage: 'canonry ga search-landing-pages <project> [--window 7d|28d|90d] [--limit 50] [--offset 0] [--format json|jsonl]',
    options: {
      window: stringOption(),
      limit: stringOption(),
      offset: stringOption(),
    },
    run: async (input) => {
      const { gaSearchLandingPages } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.search-landing-pages', 'canonry ga search-landing-pages <project> [--window 7d|28d|90d] [--limit 50] [--offset 0] [--format json|jsonl]')
      // Forwarded verbatim: the server is the one place that validates them.
      await gaSearchLandingPages(project, {
        window: getString(input.values, 'window'),
        limit: getString(input.values, 'limit'),
        offset: getString(input.values, 'offset'),
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'traffic'],
    windows: WINDOW_SETS.metrics,
    usage: `canonry ga traffic <project> [--limit 50] ${RANGE_USAGE} [--format json]`,
    options: {
      limit: stringOption(),
      ...RANGE_OPTIONS,
    },
    run: async (input) => {
      const { gaTraffic } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.traffic', `canonry ga traffic <project> [--limit 50] ${RANGE_USAGE} [--format json]`)
      const limitStr = getString(input.values, 'limit')
      const limit = limitStr ? parseInt(limitStr, 10) : undefined
      await gaTraffic(project, {
        limit,
        ...rangeValues(input.values),
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'coverage'],
    usage: 'canonry ga coverage <project> [--format json]',
    run: async (input) => {
      const { gaCoverage } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.coverage', 'canonry ga coverage <project> [--format json]')
      await gaCoverage(project, input.format)
    },
  },
  {
    path: ['ga', 'ai-referral-history'],
    windows: WINDOW_SETS.metrics,
    usage: `canonry ga ai-referral-history <project> ${RANGE_USAGE} [--format json]`,
    options: { ...RANGE_OPTIONS },
    run: async (input) => {
      const { gaAiReferralHistory } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.ai-referral-history', `canonry ga ai-referral-history <project> ${RANGE_USAGE} [--format json]`)
      await gaAiReferralHistory(project, {
        ...rangeValues(input.values),
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'ai-referral-daily'],
    windows: WINDOW_SETS.metrics,
    usage: `canonry ga ai-referral-daily <project> ${RANGE_USAGE} [--format json]`,
    options: { ...RANGE_OPTIONS },
    run: async (input) => {
      const { gaAiReferralDaily } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.ai-referral-daily', `canonry ga ai-referral-daily <project> ${RANGE_USAGE} [--format json]`)
      await gaAiReferralDaily(project, {
        ...rangeValues(input.values),
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'social-referral-history'],
    windows: WINDOW_SETS.metrics,
    usage: `canonry ga social-referral-history <project> ${RANGE_USAGE} [--format json]`,
    options: { ...RANGE_OPTIONS },
    run: async (input) => {
      const { gaSocialReferralHistory } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.social-referral-history', `canonry ga social-referral-history <project> ${RANGE_USAGE} [--format json]`)
      await gaSocialReferralHistory(project, {
        ...rangeValues(input.values),
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'session-history'],
    windows: WINDOW_SETS.metrics,
    usage: `canonry ga session-history <project> ${RANGE_USAGE} [--format json]`,
    options: { ...RANGE_OPTIONS },
    run: async (input) => {
      const { gaSessionHistory } = await import('../commands/ga.js')
      const project = requireProject(input, 'ga.session-history', `canonry ga session-history <project> ${RANGE_USAGE} [--format json]`)
      await gaSessionHistory(project, {
        ...rangeValues(input.values),
        format: input.format,
      })
    },
  },
  {
    path: ['ga', 'social-referral-summary'],
    usage: 'canonry ga social-referral-summary <project> [--trend] [--format json]',
    options: {
      trend: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const { gaSocialReferralSummary } = await import('../commands/ga.js')
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
      const { gaAttribution } = await import('../commands/ga.js')
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
        available: ['connect', 'disconnect', 'status', 'properties', 'sync', 'acquisition', 'measurement-analysis', 'search-landing-pages', 'traffic', 'coverage', 'ai-referral-history', 'ai-referral-daily', 'social-referral-history', 'session-history', 'social-referral-summary', 'attribution'],
      })
    },
  },
]
