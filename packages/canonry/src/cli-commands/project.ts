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
  getBoolean,
  getString,
  getStringArray,
  multiStringOption,
  requirePositional,
  requireProject,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import {
  competitorAutoAliasModeSchema,
  gbpNegativeReviewMaxStarsSchema,
  providerDispatchModeSchema,
  SITE_AUDIT_MAX_PAGE_LIMIT,
  siteAuditPageBudgetSchema,
  type CompetitorAutoAliasMode,
  type ProviderDispatchModesMap,
} from '@ainyc/canonry-contracts'

export const PROJECT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['project', 'create'],
    usage: 'canonry project create <name> [--domain <domain>] [--owned-domain <domain>...] [--alias <name>...] [--qualified-alias <name>...] [--country <code>] [--language <lang>] [--display-name <name>] [--provider <name>...] [--provider-model provider=model...] [--dispatch-mode provider=sync|batch...] [--site-audit-max-pages <1-50000|full>] [--format json]',
    help: 'Create a project. Pass --domain for the public site to scan. Provider credentials are not required for Page Health.',
    options: {
      domain: { type: 'string', short: 'd' },
      'owned-domain': multiStringOption(),
      alias: multiStringOption(),
      'qualified-alias': multiStringOption(),
      country: stringOption(),
      language: stringOption(),
      'display-name': stringOption(),
      provider: multiStringOption(),
      'provider-model': multiStringOption(),
      'dispatch-mode': multiStringOption(),
      'site-audit-max-pages': stringOption(),
    },
    run: async (input) => {
      const name = requireProject(
        input,
        'project.create',
        'canonry project create <name> [--domain <domain>] [--owned-domain <domain>...] [--alias <name>...] [--qualified-alias <name>...] [--country <code>] [--language <lang>] [--display-name <name>] [--provider <name>...] [--provider-model provider=model...] [--dispatch-mode provider=sync|batch...] [--site-audit-max-pages <1-50000|full>] [--format json]',
      )
      await createProject(name, {
        domain: getString(input.values, 'domain') ?? name,
        ownedDomains: getStringArray(input.values, 'owned-domain') ?? [],
        aliases: getStringArray(input.values, 'alias') ?? [],
        qualifiedAliases: getStringArray(input.values, 'qualified-alias') ?? [],
        country: getString(input.values, 'country') ?? 'US',
        language: getString(input.values, 'language') ?? 'en',
        displayName: getString(input.values, 'display-name') ?? name,
        providers: getStringArray(input.values, 'provider') ?? [],
        providerModels: parseProviderModelAssignments(getStringArray(input.values, 'provider-model')),
        providerDispatchModes: parseDispatchModeAssignments(getStringArray(input.values, 'dispatch-mode')),
        siteAuditMaxPages: parseSiteAuditMaxPages(getString(input.values, 'site-audit-max-pages'), 'project.create'),
        format: input.format,
      })
    },
  },
  {
    path: ['project', 'update'],
    usage: 'canonry project update <name> [--domain <domain>] [--owned-domain <domain>...] [--add-domain <domain>...] [--remove-domain <domain>...] [--alias <name>...] [--add-alias <name>...] [--remove-alias <name>...] [--add-qualified-alias <name>...] [--remove-qualified-alias <name>...] [--country <code>] [--language <lang>] [--display-name <name>] [--provider <name>...] [--all-providers] [--provider-model provider=model...] [--clear-provider-model <provider>...] [--dispatch-mode provider=sync|batch...] [--clear-dispatch-mode <provider>...] [--negative-review-max-stars <1-4|default>] [--site-audit-max-pages <1-50000|full>] [--competitor-auto-aliases <off|preview|apply>] [--format json]',
    options: {
      domain: { type: 'string', short: 'd' },
      'owned-domain': multiStringOption(),
      'add-domain': multiStringOption(),
      'remove-domain': multiStringOption(),
      alias: multiStringOption(),
      'add-alias': multiStringOption(),
      'remove-alias': multiStringOption(),
      'add-qualified-alias': multiStringOption(),
      'remove-qualified-alias': multiStringOption(),
      country: stringOption(),
      language: stringOption(),
      'display-name': stringOption(),
      provider: multiStringOption(),
      'all-providers': { type: 'boolean' },
      'provider-model': multiStringOption(),
      'clear-provider-model': multiStringOption(),
      'dispatch-mode': multiStringOption(),
      'clear-dispatch-mode': multiStringOption(),
      'negative-review-max-stars': stringOption(),
      'site-audit-max-pages': stringOption(),
      'competitor-auto-aliases': stringOption(),
    },
    run: async (input) => {
      const name = requireProject(
        input,
        'project.update',
        'canonry project update <name> [--domain <domain>] [--owned-domain <domain>...] [--add-domain <domain>...] [--remove-domain <domain>...] [--alias <name>...] [--add-alias <name>...] [--remove-alias <name>...] [--add-qualified-alias <name>...] [--remove-qualified-alias <name>...] [--country <code>] [--language <lang>] [--display-name <name>] [--provider <name>...] [--all-providers] [--provider-model provider=model...] [--clear-provider-model <provider>...] [--dispatch-mode provider=sync|batch...] [--clear-dispatch-mode <provider>...] [--negative-review-max-stars <1-4|default>] [--site-audit-max-pages <1-50000|full>] [--competitor-auto-aliases <off|preview|apply>] [--format json]',
      )
      const providers = getStringArray(input.values, 'provider')
      const allProviders = getBoolean(input.values, 'all-providers')
      if (allProviders && providers?.length) throw usageError('Error: --all-providers conflicts with --provider')
      const providerModels = parseProviderModelAssignments(getStringArray(input.values, 'provider-model'))
      const clearProviderModels = getStringArray(input.values, 'clear-provider-model') ?? []
      for (const provider of clearProviderModels) {
        if (provider in providerModels) throw usageError(`Error: --provider-model and --clear-provider-model conflict for ${provider}`)
      }
      const dispatchModes = parseDispatchModeAssignments(getStringArray(input.values, 'dispatch-mode'))
      const clearDispatchModes = getStringArray(input.values, 'clear-dispatch-mode') ?? []
      for (const provider of clearDispatchModes) {
        if (provider in dispatchModes) throw usageError(`Error: --dispatch-mode and --clear-dispatch-mode conflict for ${provider}`)
      }
      await updateProjectSettings(name, {
        displayName: getString(input.values, 'display-name'),
        domain: getString(input.values, 'domain'),
        ownedDomains: getStringArray(input.values, 'owned-domain'),
        addOwnedDomain: getStringArray(input.values, 'add-domain'),
        removeOwnedDomain: getStringArray(input.values, 'remove-domain'),
        aliases: getStringArray(input.values, 'alias'),
        addAlias: getStringArray(input.values, 'add-alias'),
        removeAlias: getStringArray(input.values, 'remove-alias'),
        addQualifiedAlias: getStringArray(input.values, 'add-qualified-alias'),
        removeQualifiedAlias: getStringArray(input.values, 'remove-qualified-alias'),
        country: getString(input.values, 'country'),
        language: getString(input.values, 'language'),
        providers: allProviders ? [] : providers,
        providerModels,
        clearProviderModels,
        dispatchModes,
        clearDispatchModes,
        negativeReviewMaxStars: parseNegativeReviewMaxStars(getString(input.values, 'negative-review-max-stars')),
        siteAuditMaxPages: parseSiteAuditMaxPages(getString(input.values, 'site-audit-max-pages'), 'project.update'),
        competitorAutoAliases: parseCompetitorAutoAliasMode(getString(input.values, 'competitor-auto-aliases')),
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
    usage: 'canonry project show <name> [--format json]',
    run: async (input) => {
      const name = requireProject(input, 'project.show', 'canonry project show <name>')
      await showProject(name, input.format)
    },
  },
  {
    path: ['project', 'delete'],
    usage: 'canonry project delete <name> [--dry-run] [--format json]',
    supportsDryRun: true,
    run: async (input) => {
      const name = requireProject(input, 'project.delete', 'canonry project delete <name> [--dry-run] [--format json]')
      await deleteProject(name, { dryRun: input.dryRun, format: input.format })
    },
  },
  {
    path: ['project', 'add-location'],
    usage: 'canonry project add-location <name> --label <label> --city <city> --region <region> --country <country> [--format json]',
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
        'canonry project add-location <name> --label <label> --city <city> --region <region> --country <country> [--format json]',
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
            usage: 'canonry project add-location <name> --label <label> --city <city> --region <region> --country <country> [--format json]',
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
    usage: 'canonry project locations <name> [--format json]',
    run: async (input) => {
      const name = requireProject(input, 'project.locations', 'canonry project locations <name> [--format json]')
      await listLocations(name, input.format)
    },
  },
  {
    path: ['project', 'remove-location'],
    usage: 'canonry project remove-location <name> <label> [--format json]',
    run: async (input) => {
      const name = requireProject(input, 'project.remove-location', 'canonry project remove-location <name> <label> [--format json]')
      const label = requirePositional(input, 1, {
        command: 'project.remove-location',
        usage: 'canonry project remove-location <name> <label> [--format json]',
        message: 'project name and location label are required',
      })
      await removeLocation(name, label, input.format)
    },
  },
  {
    path: ['project', 'set-default-location'],
    usage: 'canonry project set-default-location <name> <label> [--format json]',
    run: async (input) => {
      const name = requireProject(input, 'project.set-default-location', 'canonry project set-default-location <name> <label> [--format json]')
      const label = requirePositional(input, 1, {
        command: 'project.set-default-location',
        usage: 'canonry project set-default-location <name> <label> [--format json]',
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

/**
 * Parse repeatable provider=sync|batch flags before any API call. The server
 * validates the provider names; the mode is checked here so a typo never
 * reaches it.
 */
export function parseDispatchModeAssignments(assignments: readonly string[] | undefined): ProviderDispatchModesMap {
  const result: ProviderDispatchModesMap = {}
  for (const assignment of assignments ?? []) {
    const separator = assignment.indexOf('=')
    const provider = separator === -1 ? '' : assignment.slice(0, separator).trim()
    const mode = providerDispatchModeSchema.safeParse(separator === -1 ? '' : assignment.slice(separator + 1).trim().toLowerCase())
    if (!provider || !mode.success) throw usageError(`Error: --dispatch-mode must use provider=sync or provider=batch (received ${assignment})`)
    if (provider in result) throw usageError(`Error: duplicate --dispatch-mode assignment for ${provider}`)
    result[provider] = mode.data
  }
  return result
}

/** Parse repeatable provider=model flags before any API call. */
export function parseProviderModelAssignments(assignments: readonly string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const assignment of assignments ?? []) {
    const separator = assignment.indexOf('=')
    const provider = separator === -1 ? '' : assignment.slice(0, separator).trim()
    const model = separator === -1 ? '' : assignment.slice(separator + 1).trim()
    if (!provider || !model) throw usageError(`Error: --provider-model must use provider=model (received ${assignment})`)
    if (provider in result) throw usageError(`Error: duplicate --provider-model assignment for ${provider}`)
    result[provider] = model
  }
  return result
}

/** `1`-`4` sets the threshold, `default` resets it to 3, absent leaves it. */
function parseNegativeReviewMaxStars(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined
  if (raw === 'default') return null
  const parsed = gbpNegativeReviewMaxStarsSchema.safeParse(Number(raw))
  if (!parsed.success) {
    throw usageError('Error: --negative-review-max-stars must be 1, 2, 3, 4, or "default" (3)', {
      message: '--negative-review-max-stars must be 1-4 or "default"',
      details: { command: 'project.update', value: raw },
    })
  }
  return parsed.data
}

/**
 * A whole number from 1 to the hard limit saves a Site Health page budget,
 * `full` saves null (scans cover the full site), absent leaves the stored
 * budget alone. Validated here so a typo never reaches the server.
 */
function parseSiteAuditMaxPages(raw: string | undefined, command: string): number | null | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value.toLowerCase() === 'full') return null
  const parsed = /^\d+$/.test(value) ? siteAuditPageBudgetSchema.safeParse(Number(value)) : undefined
  if (!parsed?.success) {
    throw usageError(`Error: --site-audit-max-pages must be a whole number of pages from 1 to ${SITE_AUDIT_MAX_PAGE_LIMIT}, or "full" for the full site`, {
      message: `--site-audit-max-pages must be 1-${SITE_AUDIT_MAX_PAGE_LIMIT} or "full"`,
      details: { command, option: 'site-audit-max-pages', value: raw },
    })
  }
  return parsed.data
}

/**
 * `off`, `preview` or `apply` sets what answer-derived competitor alias
 * detection does after each sweep; absent leaves the stored mode alone.
 */
function parseCompetitorAutoAliasMode(raw: string | undefined): CompetitorAutoAliasMode | undefined {
  if (raw === undefined) return undefined
  const parsed = competitorAutoAliasModeSchema.safeParse(raw.trim().toLowerCase())
  if (!parsed.success) {
    throw usageError('Error: --competitor-auto-aliases must be off, preview or apply', {
      message: '--competitor-auto-aliases must be off, preview or apply',
      details: { command: 'project.update', option: 'competitor-auto-aliases', value: raw },
    })
  }
  return parsed.data
}
