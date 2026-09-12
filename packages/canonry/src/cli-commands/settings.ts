import { setGoogleAuth, setProvider, showSettings } from '../commands/settings.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getString,
  parseIntegerOption,
  requirePositional,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const SETTINGS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['settings', 'provider'],
    usage: 'canonry settings provider <name> [--api-key <key>] [--base-url <url>] [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]',
    options: {
      'api-key': stringOption(),
      'base-url': stringOption(),
      model: stringOption(),
      'max-concurrent': stringOption(),
      'max-per-minute': stringOption(),
      'max-per-day': stringOption(),
    },
    run: async (input) => {
      const name = requirePositional(input, 0, {
        command: 'settings.provider',
        usage: 'canonry settings provider <name> [--api-key <key>] [--base-url <url>] [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]',
        message: 'provider name is required (e.g. gemini, openai, claude, perplexity, local)',
      })
      const apiKey = getString(input.values, 'api-key')
      const baseUrl = getString(input.values, 'base-url')
      const model = getString(input.values, 'model')
      const maxConcurrency = parseIntegerOption(input, 'max-concurrent', {
        command: 'settings.provider',
        usage: 'canonry settings provider <name> [--api-key <key>] [--base-url <url>] [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]',
        message: '--max-concurrent must be an integer',
      })
      const maxRequestsPerMinute = parseIntegerOption(input, 'max-per-minute', {
        command: 'settings.provider',
        usage: 'canonry settings provider <name> [--api-key <key>] [--base-url <url>] [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]',
        message: '--max-per-minute must be an integer',
      })
      const maxRequestsPerDay = parseIntegerOption(input, 'max-per-day', {
        command: 'settings.provider',
        usage: 'canonry settings provider <name> [--api-key <key>] [--base-url <url>] [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]',
        message: '--max-per-day must be an integer',
      })
      const hasNonCredentialEdit = Boolean(model) || maxConcurrency != null || maxRequestsPerMinute != null || maxRequestsPerDay != null
      if (name === 'local') {
        if (!baseUrl && !hasNonCredentialEdit) {
          throw usageError(
            'Error: --base-url is required for the local provider\nUsage: canonry settings provider local --base-url <url> [--api-key <key>] [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]',
            {
              message: '--base-url is required for the local provider',
              details: {
                command: 'settings.provider',
                usage: 'canonry settings provider local --base-url <url> [--api-key <key>] [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]',
                required: ['base-url'],
              },
            },
          )
        }
      } else if (!apiKey && !baseUrl && !hasNonCredentialEdit) {
        throw usageError(
          `Error: --api-key is required\nUsage: canonry settings provider ${name} --api-key <key> [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]`,
          {
            message: '--api-key is required',
            details: {
              command: 'settings.provider',
              usage: `canonry settings provider ${name} --api-key <key> [--model <model>] [--max-concurrent <n>] [--max-per-minute <n>] [--max-per-day <n>] [--format json]`,
              required: ['api-key'],
            },
          },
        )
      }

      const quota =
        maxConcurrency != null || maxRequestsPerMinute != null || maxRequestsPerDay != null
          ? {
              ...(maxConcurrency != null ? { maxConcurrency } : {}),
              ...(maxRequestsPerMinute != null ? { maxRequestsPerMinute } : {}),
              ...(maxRequestsPerDay != null ? { maxRequestsPerDay } : {}),
            }
          : undefined

      await setProvider(name, {
        apiKey,
        baseUrl,
        model,
        quota,
        format: input.format,
      })
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
    usage: 'canonry settings [provider|google] [args]',
    run: async (input) => {
      const subcommand = input.positionals[0]
      if (!subcommand) {
        await showSettings(input.format)
        return
      }

      unknownSubcommand(subcommand, {
        command: 'settings',
        usage: 'canonry settings [provider|google] [args]',
        available: ['provider', 'google'],
      })
    },
  },
]
