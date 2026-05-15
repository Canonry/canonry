import {
  gbpConnect,
  gbpDisconnect,
  gbpLocationsDiscover,
  gbpLocationsList,
  gbpLocationSelect,
  gbpLocationDeselect,
} from '../commands/gbp.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
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
    path: ['gbp', 'locations', 'discover'],
    usage: 'canonry gbp locations discover <project> [--no-select-new] [--format json]',
    options: {
      'no-select-new': { type: 'boolean' as const },
    },
    run: async (input) => {
      const project = requireProject(input, 'gbp.locations.discover', 'canonry gbp locations discover <project> [--no-select-new] [--format json]')
      const noSelectNew = getBoolean(input.values, 'no-select-new') ?? false
      await gbpLocationsDiscover(project, {
        format: input.format,
        selectAllNew: !noSelectNew,
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
]
