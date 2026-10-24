import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requireProject,
  stringOption,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const GBP_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['gbp', 'posts', 'attempt'], access: 'stored',
    usage: 'canonry gbp posts attempt <project> --attempt UUID --package SHA256 [--format json]',
    options: { attempt: stringOption(), package: stringOption() },
    run: async input => {
      const { gbpLocalPosts } = await import('../commands/gbp.js')
      await gbpLocalPosts(requireProject(input, 'gbp.posts.attempt', 'canonry gbp posts attempt <project>'), 'attempt', { attempt: getString(input.values, 'attempt'), package: getString(input.values, 'package') })
    },
  },
  {
    path: ['gbp', 'posts', 'list'], access: 'live',
    usage: 'canonry gbp posts list <project> --account accounts/id --location locations/id [--page-token token] [--format json]',
    options: { account: stringOption(), location: stringOption(), 'page-token': stringOption() },
    run: async input => {
      const { gbpLocalPosts } = await import('../commands/gbp.js')
      await gbpLocalPosts(requireProject(input, 'gbp.posts.list', 'canonry gbp posts list <project>'), 'list', { account: getString(input.values, 'account'), location: getString(input.values, 'location'), pageToken: getString(input.values, 'page-token') })
    },
  },
  {
    path: ['gbp', 'posts', 'get'], access: 'live',
    usage: 'canonry gbp posts get <project> --post resource [--format json]',
    options: { post: stringOption() },
    run: async input => {
      const { gbpLocalPosts } = await import('../commands/gbp.js')
      await gbpLocalPosts(requireProject(input, 'gbp.posts.get', 'canonry gbp posts get <project>'), 'get', { post: getString(input.values, 'post') })
    },
  },
  {
    path: ['gbp', 'posts', 'create'], access: 'write',
    usage: 'canonry gbp posts create <project> --request file [--format json]',
    options: { request: stringOption() },
    run: async input => {
      const { gbpLocalPosts } = await import('../commands/gbp.js')
      await gbpLocalPosts(requireProject(input, 'gbp.posts.create', 'canonry gbp posts create <project>'), 'create', { request: getString(input.values, 'request') })
    },
  },
  {
    path: ['gbp', 'reviews', 'live'], access: 'live',
    usage: 'canonry gbp reviews live <project> --account accounts/id --location locations/id [--format json]',
    options: { account: stringOption(), location: stringOption() },
    run: async input => {
      const { gbpLocalPosts } = await import('../commands/gbp.js')
      await gbpLocalPosts(requireProject(input, 'gbp.reviews.live', 'canonry gbp reviews live <project>'), 'reviews', { account: getString(input.values, 'account'), location: getString(input.values, 'location') })
    },
  },
  {
    path: ['gbp', 'connect'],
    usage: 'canonry gbp connect <project> [--public-url <url>] [--format json]',
    options: {
      'public-url': stringOption(),
    },
    run: async (input) => {
      const { gbpConnect } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.connect', 'canonry gbp connect <project> [--public-url <url>] [--format json]')
      await gbpConnect(project, {
        publicUrl: getString(input.values, 'public-url'),
        format: input.format,
      })
    },
  },
  {
    path: ['gbp', 'disconnect'],
    usage: 'canonry gbp disconnect <project> [--format json]',
    run: async (input) => {
      const { gbpDisconnect } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.disconnect', 'canonry gbp disconnect <project> [--format json]')
      await gbpDisconnect(project, { format: input.format })
    },
  },
  {
    path: ['gbp', 'locations'],
    usage: 'canonry gbp locations <project> [--selected-only] [--format json]',
    options: {
      'selected-only': { type: 'boolean' as const },
    },
    run: async (input) => {
      const { gbpLocationsList } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.locations', 'canonry gbp locations <project> [--selected-only] [--format json]')
      await gbpLocationsList(project, {
        format: input.format,
        selectedOnly: getBoolean(input.values, 'selected-only') ?? false,
      })
    },
  },
  {
    path: ['gbp', 'accounts'],
    usage: 'canonry gbp accounts <project> [--format json]',
    run: async (input) => {
      const { gbpAccounts } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.accounts', 'canonry gbp accounts <project> [--format json]')
      await gbpAccounts(project, { format: input.format })
    },
  },
  {
    path: ['gbp', 'locations', 'discover'],
    usage: 'canonry gbp locations discover <project> [--account <accounts/{n}>] [--switch-account] [--no-select-new] [--format json]',
    options: {
      'no-select-new': { type: 'boolean' as const },
      account: stringOption(),
      'switch-account': { type: 'boolean' as const },
    },
    run: async (input) => {
      const { gbpLocationsDiscover } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.locations.discover', 'canonry gbp locations discover <project> [--account <accounts/{n}>] [--switch-account] [--no-select-new] [--format json]')
      const noSelectNew = getBoolean(input.values, 'no-select-new') ?? false
      await gbpLocationsDiscover(project, {
        format: input.format,
        selectAllNew: !noSelectNew,
        account: getString(input.values, 'account'),
        switchAccount: getBoolean(input.values, 'switch-account') ?? false,
      })
    },
  },
  {
    path: ['gbp', 'locations', 'select'],
    usage: 'canonry gbp locations select <project> --location <locations/{n}> [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const { gbpLocationSelect } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.locations.select', 'canonry gbp locations select <project> --location <name> [--format json]')
      const location = getString(input.values, 'location')
      if (!location) throw usageError('canonry gbp locations select <project> --location <locations/{n}>: --location is required')
      await gbpLocationSelect(project, { location, format: input.format })
    },
  },
  {
    path: ['gbp', 'locations', 'deselect'],
    usage: 'canonry gbp locations deselect <project> --location <locations/{n}> [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const { gbpLocationDeselect } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.locations.deselect', 'canonry gbp locations deselect <project> --location <name> [--format json]')
      const location = getString(input.values, 'location')
      if (!location) throw usageError('canonry gbp locations deselect <project> --location <locations/{n}>: --location is required')
      await gbpLocationDeselect(project, { location, format: input.format })
    },
  },
  {
    path: ['gbp', 'sync'],
    usage: 'canonry gbp sync <project> [--location <name>] [--days N] [--months N] [--wait] [--format json]',
    options: {
      location: stringOption(),
      days: stringOption(),
      months: stringOption(),
      wait: { type: 'boolean' as const },
    },
    run: async (input) => {
      const { gbpSync } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.sync', 'canonry gbp sync <project> [--location <name>] [--days N] [--months N] [--wait] [--format json]')
      await gbpSync(project, {
        location: getString(input.values, 'location'),
        days: parseIntegerOption(input, 'days', { message: '--days must be an integer', usage: 'canonry gbp sync <project> --days N', command: 'gbp.sync' }),
        months: parseIntegerOption(input, 'months', { message: '--months must be an integer', usage: 'canonry gbp sync <project> --months N', command: 'gbp.sync' }),
        wait: getBoolean(input.values, 'wait') ?? false,
        format: input.format,
      })
    },
  },
  {
    path: ['gbp', 'metrics'],
    usage: 'canonry gbp metrics <project> [--location <name>] [--metric <DailyMetric>] [--format json]',
    options: {
      location: stringOption(),
      metric: stringOption(),
    },
    run: async (input) => {
      const { gbpMetrics } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.metrics', 'canonry gbp metrics <project> [--location <name>] [--metric <DailyMetric>] [--format json]')
      await gbpMetrics(project, {
        location: getString(input.values, 'location'),
        metric: getString(input.values, 'metric'),
        format: input.format,
      })
    },
  },
  {
    path: ['gbp', 'keywords'],
    usage: 'canonry gbp keywords <project> [--location <name>] [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const { gbpKeywords } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.keywords', 'canonry gbp keywords <project> [--location <name>] [--format json]')
      await gbpKeywords(project, {
        location: getString(input.values, 'location'),
        format: input.format,
      })
    },
  },
  {
    path: ['gbp', 'place-actions'],
    usage: 'canonry gbp place-actions <project> [--location <name>] [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const { gbpPlaceActions } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.place-actions', 'canonry gbp place-actions <project> [--location <name>] [--format json]')
      await gbpPlaceActions(project, { location: getString(input.values, 'location'), format: input.format })
    },
  },
  {
    path: ['gbp', 'lodging'],
    usage: 'canonry gbp lodging <project> [--location <name>] [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const { gbpLodging } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.lodging', 'canonry gbp lodging <project> [--location <name>] [--format json]')
      await gbpLodging(project, { location: getString(input.values, 'location'), format: input.format })
    },
  },
  {
    path: ['gbp', 'attributes'],
    usage: 'canonry gbp attributes <project> [--location <name>] [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const { gbpAttributes } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.attributes', 'canonry gbp attributes <project> [--location <name>] [--format json]')
      await gbpAttributes(project, { location: getString(input.values, 'location'), format: input.format })
    },
  },
  {
    path: ['gbp', 'places'],
    usage: 'canonry gbp places <project> [--location <name>] [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const { gbpPlaces } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.places', 'canonry gbp places <project> [--location <name>] [--format json]')
      await gbpPlaces(project, { location: getString(input.values, 'location'), format: input.format })
    },
  },
  {
    path: ['gbp', 'reviews'],
    usage: 'canonry gbp reviews <project> [--location <name>] [--negative] [--limit N] [--format json]',
    options: {
      location: stringOption(),
      negative: { type: 'boolean' as const },
      limit: stringOption(),
    },
    run: async (input) => {
      const { gbpReviews } = await import('../commands/gbp.js')
      const usage = 'canonry gbp reviews <project> [--location <name>] [--negative] [--limit N] [--format json]'
      const project = requireProject(input, 'gbp.reviews', usage)
      await gbpReviews(project, {
        location: getString(input.values, 'location'),
        negative: getBoolean(input.values, 'negative') ?? false,
        limit: parseIntegerOption(input, 'limit', { message: '--limit must be an integer', usage, command: 'gbp.reviews' }),
        format: input.format,
      })
    },
  },
  {
    path: ['gbp', 'summary'],
    usage: 'canonry gbp summary <project> [--location <name>] [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const { gbpSummary } = await import('../commands/gbp.js')
      const project = requireProject(input, 'gbp.summary', 'canonry gbp summary <project> [--location <name>] [--format json]')
      await gbpSummary(project, { location: getString(input.values, 'location'), format: input.format })
    },
  },
]
