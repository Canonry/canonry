import {
  addLocation,
  createProject,
  deleteProject,
  listLocations,
  listProjects,
  removeLocation,
  setDefaultLocation,
  showProject,
  updateProjectSettings,
} from '../commands/project.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getString,
  getStringArray,
  multiStringOption,
  requirePositional,
  requireProject,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const PROJECT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['project', 'create'],
    usage: 'canonry project create <name> [--domain <domain>] [--owned-domain <domain>...] [--country <code>] [--language <lang>] [--display-name <name>] [--format json]',
    options: {
      domain: { type: 'string', short: 'd' },
      'owned-domain': multiStringOption(),
      country: stringOption(),
      language: stringOption(),
      'display-name': stringOption(),
    },
    run: async (input) => {
      const name = requireProject(
        input,
        'project.create',
        'canonry project create <name> [--domain <domain>] [--owned-domain <domain>...] [--country <code>] [--language <lang>] [--display-name <name>] [--format json]',
      )
      await createProject(name, {
        domain: getString(input.values, 'domain') ?? name,
        ownedDomains: getStringArray(input.values, 'owned-domain') ?? [],
        country: getString(input.values, 'country') ?? 'US',
        language: getString(input.values, 'language') ?? 'en',
        displayName: getString(input.values, 'display-name') ?? name,
        format: input.format,
      })
    },
  },
  {
    path: ['project', 'update'],
    usage: 'canonry project update <name> [--domain <domain>] [--owned-domain <domain>...] [--add-domain <domain>...] [--remove-domain <domain>...] [--country <code>] [--language <lang>] [--display-name <name>] [--format json]',
    options: {
      domain: { type: 'string', short: 'd' },
      'owned-domain': multiStringOption(),
      'add-domain': multiStringOption(),
      'remove-domain': multiStringOption(),
      country: stringOption(),
      language: stringOption(),
      'display-name': stringOption(),
    },
    run: async (input) => {
      const name = requireProject(
        input,
        'project.update',
        'canonry project update <name> [--domain <domain>] [--owned-domain <domain>...] [--add-domain <domain>...] [--remove-domain <domain>...] [--country <code>] [--language <lang>] [--display-name <name>] [--format json]',
      )
      await updateProjectSettings(name, {
        displayName: getString(input.values, 'display-name'),
        domain: getString(input.values, 'domain'),
        ownedDomains: getStringArray(input.values, 'owned-domain'),
        addOwnedDomain: getStringArray(input.values, 'add-domain'),
        removeOwnedDomain: getStringArray(input.values, 'remove-domain'),
        country: getString(input.values, 'country'),
        language: getString(input.values, 'language'),
        format: input.format,
      })
    },
  },
  {
    path: ['project', 'list'],
    usage: 'canonry project list [--format json]',
    allowPositionals: false,
    run: async (input) => {
      await listProjects(input.format)
    },
  },
  {
    path: ['project', 'show'],
    usage: 'canonry project show <name>',
    run: async (input) => {
      const name = requireProject(input, 'project.show', 'canonry project show <name>')
      await showProject(name, input.format)
    },
  },
  {
    path: ['project', 'delete'],
    usage: 'canonry project delete <name> [--format json]',
    run: async (input) => {
      const name = requireProject(input, 'project.delete', 'canonry project delete <name> [--format json]')
      await deleteProject(name, input.format)
    },
  },
  {
    path: ['project', 'add-location'],
    usage: 'canonry project add-location <name> --label <label> --city <city> --region <region> --country <country>',
    options: {
      label: stringOption(),
      city: stringOption(),
      region: stringOption(),
      country: stringOption(),
      timezone: stringOption(),
    },
    run: async (input) => {
      const name = requireProject(
        input,
        'project.add-location',
        'canonry project add-location <name> --label <label> --city <city> --region <region> --country <country>',
      )
      const label = getString(input.values, 'label')
      const city = getString(input.values, 'city')
      const region = getString(input.values, 'region')
      const country = getString(input.values, 'country')
      if (!label || !city || !region || !country) {
        throw usageError('Error: --label, --city, --region, and --country are all required', {
          message: 'location label, city, region, and country are required',
          details: {
            command: 'project.add-location',
            usage: 'canonry project add-location <name> --label <label> --city <city> --region <region> --country <country>',
            required: ['label', 'city', 'region', 'country'],
          },
        })
      }
      await addLocation(name, {
        label,
        city,
        region,
        country,
        timezone: getString(input.values, 'timezone'),
        format: input.format,
      })
    },
  },
  {
    path: ['project', 'locations'],
    usage: 'canonry project locations <name>',
    run: async (input) => {
      const name = requireProject(input, 'project.locations', 'canonry project locations <name>')
      await listLocations(name, input.format)
    },
  },
  {
    path: ['project', 'remove-location'],
    usage: 'canonry project remove-location <name> <label>',
    run: async (input) => {
      const name = requireProject(input, 'project.remove-location', 'canonry project remove-location <name> <label>')
      const label = requirePositional(input, 1, {
        command: 'project.remove-location',
        usage: 'canonry project remove-location <name> <label>',
        message: 'project name and location label are required',
      })
      await removeLocation(name, label, input.format)
    },
  },
  {
    path: ['project', 'set-default-location'],
    usage: 'canonry project set-default-location <name> <label>',
    run: async (input) => {
      const name = requireProject(input, 'project.set-default-location', 'canonry project set-default-location <name> <label>')
      const label = requirePositional(input, 1, {
        command: 'project.set-default-location',
        usage: 'canonry project set-default-location <name> <label>',
        message: 'project name and location label are required',
      })
      await setDefaultLocation(name, label, input.format)
    },
  },
  {
    path: ['project'],
    usage: 'canonry project <create|update|list|show|delete|add-location|locations|remove-location|set-default-location> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'project',
        usage: 'canonry project <create|update|list|show|delete|add-location|locations|remove-location|set-default-location> [args]',
        available: ['create', 'update', 'list', 'show', 'delete', 'add-location', 'locations', 'remove-location', 'set-default-location'],
      })
    },
  },
]
