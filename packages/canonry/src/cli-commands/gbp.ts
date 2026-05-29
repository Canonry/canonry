import {
  gbpConnect,
  gbpDisconnect,
  gbpAccounts,
  gbpLocationsDiscover,
  gbpLocationsList,
  gbpLocationSelect,
  gbpLocationDeselect,
  gbpSync,
  gbpMetrics,
  gbpKeywords,
  gbpPlaceActions,
  gbpLodging,
  gbpPlaces,
  gbpSummary,
} from '../commands/gbp.js'
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
    path: ['gbp', 'connect'],
    usage: 'canonry gbp connect <project> [--public-url <url>] [--format json]',
    options: {
      'public-url': stringOption(),
    },
    run: async (input) => {
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
      const project = requireProject(input, 'gbp.lodging', 'canonry gbp lodging <project> [--location <name>] [--format json]')
      await gbpLodging(project, { location: getString(input.values, 'location'), format: input.format })
    },
  },
  {
    path: ['gbp', 'places'],
    usage: 'canonry gbp places <project> [--location <name>] [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'gbp.places', 'canonry gbp places <project> [--location <name>] [--format json]')
      await gbpPlaces(project, { location: getString(input.values, 'location'), format: input.format })
    },
  },
  {
    path: ['gbp', 'summary'],
    usage: 'canonry gbp summary <project> [--location <name>] [--format json]',
    options: {
      location: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'gbp.summary', 'canonry gbp summary <project> [--location <name>] [--format json]')
      await gbpSummary(project, { location: getString(input.values, 'location'), format: input.format })
    },
  },
]
