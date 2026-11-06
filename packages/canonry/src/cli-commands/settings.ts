import { OperationAccesses, ProviderQuotaFields, providerSettingsUpdateRequestSchema } from '@canonry/canonry-contracts'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getString,
  getBoolean,
  getStringArray,
  multiStringOption,
  parseIntegerOption,
  requirePositional,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const PROVIDER_USAGE = 'canonry settings provider <name> [--api-key <key>] [--base-url <url> | --reset-base-url] [--model <model> | --reset-model] [--remove-key] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--reset-quota <field>] [--reset-limits] [--if-revision <revision>] [--format json]'

export const SETTINGS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['settings', 'provider-info'],
    usage: 'canonry settings provider-info <name> [--format json]',
    run: async input => {
      const { showProviderSettings } = await import('../commands/settings.js')
      const name = requirePositional(input, 0, { command: 'settings.provider-info', usage: 'canonry settings provider-info <name> [--format json]', message: 'provider name is required' })
      await showProviderSettings(name, input.format)
    },
  },
  {
    path: ['settings', 'disconnect-provider'],
    usage: 'canonry settings disconnect-provider <name> [--confirm] [--if-impact-revision <revision>] [--format json]',
    options: { confirm: { type: 'boolean' }, 'if-impact-revision': stringOption() },
    accessFor: ({ values }) => getBoolean(values, 'confirm') ? OperationAccesses.write : OperationAccesses.stored,
    run: async input => {
      const { disconnectProvider } = await import('../commands/settings.js')
      const name = requirePositional(input, 0, { command: 'settings.disconnect-provider', usage: 'canonry settings disconnect-provider <name> [--confirm] [--format json]', message: 'provider name is required' })
      await disconnectProvider(name, { confirm: getBoolean(input.values, 'confirm'), expectedImpactRevision: getString(input.values, 'if-impact-revision'), format: input.format })
    },
  },
  {
    path: ['settings', 'reload-providers'],
    usage: 'canonry settings reload-providers [--format json]',
    run: async input => {
      const { reloadProviders } = await import('../commands/settings.js')
      return reloadProviders(input.format)
    },
  },
  {
    path: ['settings', 'provider'],
    usage: PROVIDER_USAGE,
    options: {
      'api-key': stringOption(),
      'base-url': stringOption(),
      model: stringOption(),
      'max-concurrent': stringOption(),
      'max-per-minute': stringOption(),
      'max-per-day': stringOption(),
      'reset-model': { type: 'boolean' },
      'reset-base-url': { type: 'boolean' },
      'remove-key': { type: 'boolean' },
      'reset-limits': { type: 'boolean' },
      'reset-quota': multiStringOption(),
      'if-revision': stringOption(),
    },
    run: async (input) => {
      const { setProvider } = await import('../commands/settings.js')
      const name = requirePositional(input, 0, {
        command: 'settings.provider',
        usage: PROVIDER_USAGE,
        message: 'provider name is required (e.g. gemini, openai, claude, perplexity, muse, local)',
      })
      const apiKey = getString(input.values, 'api-key')
      const baseUrl = getString(input.values, 'base-url')
      const model = getString(input.values, 'model')
      const maxConcurrency = parseIntegerOption(input, 'max-concurrent', {
        command: 'settings.provider',
        usage: PROVIDER_USAGE,
        message: '--max-concurrent must be an integer',
      })
      const maxRequestsPerMinute = parseIntegerOption(input, 'max-per-minute', {
        command: 'settings.provider',
        usage: PROVIDER_USAGE,
        message: '--max-per-minute must be an integer',
      })
      const maxRequestsPerDay = parseIntegerOption(input, 'max-per-day', {
        command: 'settings.provider',
        usage: PROVIDER_USAGE,
        message: '--max-per-day must be an integer',
      })

      const quota =
        maxConcurrency != null || maxRequestsPerMinute != null || maxRequestsPerDay != null
          ? {
              ...(maxConcurrency != null ? { maxConcurrency } : {}),
              ...(maxRequestsPerMinute != null ? { maxRequestsPerMinute } : {}),
              ...(maxRequestsPerDay != null ? { maxRequestsPerDay } : {}),
            }
          : undefined

      const resetQuota = getBoolean(input.values, 'reset-limits')
        ? Object.values(ProviderQuotaFields)
        : getStringArray(input.values, 'reset-quota')
      const resetModel = getBoolean(input.values, 'reset-model')
      const removeKey = getBoolean(input.values, 'remove-key')
      const resetBaseUrl = getBoolean(input.values, 'reset-base-url')
      const reset = resetModel || removeKey || resetQuota || resetBaseUrl
        ? { ...(resetBaseUrl ? { baseUrl: true } : {}), ...(resetModel ? { model: true } : {}), ...(removeKey ? { apiKey: true } : {}), ...(resetQuota ? { quota: resetQuota } : {}) }
        : undefined
      const parsed = providerSettingsUpdateRequestSchema.safeParse({ apiKey, baseUrl, model, quota, reset, expectedRevision: getString(input.values, 'if-revision') })
      if (!parsed.success) {
        const message = parsed.error.issues.map(issue => issue.message).join('; ')
        throw usageError(`Error: ${message}\nUsage: ${PROVIDER_USAGE}`, { message, details: { command: 'settings.provider', usage: PROVIDER_USAGE } })
      }
      await setProvider(name, { ...parsed.data, format: input.format })
    },
  },
  {
    path: ['settings', 'google'],
    usage: 'canonry settings google --client-id <id> --client-secret <secret> [--target local|server] [--format json]',
    options: {
      'client-id': stringOption(),
      'client-secret': stringOption(),
      target: stringOption(),
    },
    run: async (input) => {
      const { setGoogleAuth } = await import('../commands/settings.js')
      const clientId = getString(input.values, 'client-id')
      const clientSecret = getString(input.values, 'client-secret')
      if (!clientId || !clientSecret) {
        throw usageError(
          'Error: --client-id and --client-secret are both required\nUsage: canonry settings google --client-id <id> --client-secret <secret> [--format json]',
          {
            message: '--client-id and --client-secret are both required',
            details: {
              command: 'settings.google',
              usage: 'canonry settings google --client-id <id> --client-secret <secret> [--format json]',
              required: ['client-id', 'client-secret'],
            },
          },
        )
      }
      const target = getString(input.values, 'target') ?? 'local'
      if (target !== 'local' && target !== 'server') {
        throw usageError(
          'Error: invalid --target; must be local or server\nUsage: canonry settings google --client-id <id> --client-secret <secret> [--target local|server] [--format json]',
          {
            message: 'invalid --target; must be local or server',
            details: {
              command: 'settings.google',
              usage: 'canonry settings google --client-id <id> --client-secret <secret> [--target local|server] [--format json]',
              option: 'target',
              value: target,
            },
          },
        )
      }
      await setGoogleAuth({
        clientId,
        clientSecret,
        target,
        format: input.format,
      })
    },
  },
  {
    path: ['settings'],
    usage: 'canonry settings [provider|provider-info|disconnect-provider|reload-providers|google] [args]',
    run: async (input) => {
      const { showSettings } = await import('../commands/settings.js')
      const subcommand = input.positionals[0]
      if (!subcommand) {
        await showSettings(input.format)
        return
      }

      unknownSubcommand(subcommand, {
        command: 'settings',
        usage: 'canonry settings [provider|provider-info|disconnect-provider|reload-providers|google] [args]',
        available: ['provider', 'provider-info', 'disconnect-provider', 'reload-providers', 'google'],
      })
    },
  },
]
