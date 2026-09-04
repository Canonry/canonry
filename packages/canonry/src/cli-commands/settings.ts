import {
  listEngineConnectionModels,
  listEngineRoutes,
  setGoogleAuth,
  setProvider,
  showSettings,
  upsertEngineConnection,
  upsertEngineRoute,
} from '../commands/settings.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getString,
  parseIntegerOption,
  requirePositional,
  requireStringOption,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import { engineConnectionPresetSchema } from '@ainyc/canonry-contracts'

const ENGINE_CONNECTION_USAGE = 'canonry settings engine-connection <id> --label <label> --preset <openrouter|litellm|vercel-ai-gateway|custom-openai-compatible> --max-concurrent <n> --max-per-minute <n> --max-per-day <n> [--base-url <url>] [--api-key <key>] [--format json|jsonl]'
const ENGINE_MODELS_USAGE = 'canonry settings engine-models <connection-id> [--format json|jsonl]'
const ENGINE_ROUTE_USAGE = 'canonry settings engine-route <route-id> --label <label> --connection <connection-id> --model <model-id> [--format json|jsonl]'

function requireIntegerSetting(input: Parameters<CliCommandSpec['run']>[0], key: string, command: string, usage: string): number {
  requireStringOption(input, key, {
    command,
    usage,
    message: `--${key} is required`,
  })
  const value = parseIntegerOption(input, key, {
    command,
    usage,
    message: `--${key} must be an integer`,
  })
  if (value === undefined) throw new Error(`Missing required integer setting: ${key}`)
  return value
}

function requireConnectionPreset(input: Parameters<CliCommandSpec['run']>[0], usage: string) {
  const value = requireStringOption(input, 'preset', {
    command: 'settings.engine-connection',
    usage,
    message: '--preset is required',
  })
  const parsed = engineConnectionPresetSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw usageError(
    'Error: --preset must be openrouter, litellm, vercel-ai-gateway, or custom-openai-compatible',
    {
      message: '--preset must be openrouter, litellm, vercel-ai-gateway, or custom-openai-compatible',
      details: { command: 'settings.engine-connection', usage, option: 'preset', value },
    },
  )
}

export const SETTINGS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['settings', 'engine-routes'],
    usage: 'canonry settings engine-routes [--format json|jsonl]',
    run: async (input) => {
      await listEngineRoutes(input.format)
    },
  },
  {
    path: ['settings', 'engine-connection'],
    usage: ENGINE_CONNECTION_USAGE,
    options: {
      label: stringOption(),
      preset: stringOption(),
      'base-url': stringOption(),
      'api-key': stringOption(),
      'max-concurrent': stringOption(),
      'max-per-minute': stringOption(),
      'max-per-day': stringOption(),
    },
    run: async (input) => {
      const id = requirePositional(input, 0, {
        command: 'settings.engine-connection',
        usage: ENGINE_CONNECTION_USAGE,
        message: 'engine connection ID is required',
      })
      const preset = requireConnectionPreset(input, ENGINE_CONNECTION_USAGE)
      const baseUrl = getString(input.values, 'base-url')
      const apiKey = getString(input.values, 'api-key')
      if (preset === 'custom-openai-compatible' && !baseUrl) {
        throw usageError(
          `Error: --base-url is required for the custom OpenAI-compatible preset\nUsage: ${ENGINE_CONNECTION_USAGE}`,
          {
            message: '--base-url is required for the custom OpenAI-compatible preset',
            details: {
              command: 'settings.engine-connection',
              usage: ENGINE_CONNECTION_USAGE,
              required: ['base-url'],
            },
          },
        )
      }
      await upsertEngineConnection(id, {
        label: requireStringOption(input, 'label', {
          command: 'settings.engine-connection',
          usage: ENGINE_CONNECTION_USAGE,
          message: '--label is required',
        }),
        preset,
        protocol: 'openai-compatible',
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        quota: {
          maxConcurrency: requireIntegerSetting(input, 'max-concurrent', 'settings.engine-connection', ENGINE_CONNECTION_USAGE),
          maxRequestsPerMinute: requireIntegerSetting(input, 'max-per-minute', 'settings.engine-connection', ENGINE_CONNECTION_USAGE),
          maxRequestsPerDay: requireIntegerSetting(input, 'max-per-day', 'settings.engine-connection', ENGINE_CONNECTION_USAGE),
        },
      }, input.format)
    },
  },
  {
    path: ['settings', 'engine-models'],
    usage: ENGINE_MODELS_USAGE,
    run: async (input) => {
      const connectionId = requirePositional(input, 0, {
        command: 'settings.engine-models',
        usage: ENGINE_MODELS_USAGE,
        message: 'engine connection ID is required',
      })
      await listEngineConnectionModels(connectionId, input.format)
    },
  },
  {
    path: ['settings', 'engine-route'],
    usage: ENGINE_ROUTE_USAGE,
    options: {
      label: stringOption(),
      connection: stringOption(),
      model: stringOption(),
    },
    run: async (input) => {
      const id = requirePositional(input, 0, {
        command: 'settings.engine-route',
        usage: ENGINE_ROUTE_USAGE,
        message: 'engine route ID is required',
      })
      await upsertEngineRoute(id, {
        label: requireStringOption(input, 'label', {
          command: 'settings.engine-route',
          usage: ENGINE_ROUTE_USAGE,
          message: '--label is required',
        }),
        connectionId: requireStringOption(input, 'connection', {
          command: 'settings.engine-route',
          usage: ENGINE_ROUTE_USAGE,
          message: '--connection is required',
        }),
        modelId: requireStringOption(input, 'model', {
          command: 'settings.engine-route',
          usage: ENGINE_ROUTE_USAGE,
          message: '--model is required',
        }),
      }, input.format)
    },
  },
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
      if (name === 'local') {
        if (!baseUrl) {
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
      } else if (!apiKey) {
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
        model: getString(input.values, 'model'),
        quota,
        format: input.format,
      })
    },
  },
  {
    path: ['settings', 'google'],
    usage: 'canonry settings google --client-id <id> --client-secret <secret> [--format json]',
    options: {
      'client-id': stringOption(),
      'client-secret': stringOption(),
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
      setGoogleAuth({
        clientId,
        clientSecret,
        format: input.format,
      })
    },
  },
  {
    path: ['settings'],
    usage: 'canonry settings [provider|google|engine-routes|engine-connection|engine-models|engine-route] [args]',
    run: async (input) => {
      const subcommand = input.positionals[0]
      if (!subcommand) {
        await showSettings(input.format)
        return
      }

      unknownSubcommand(subcommand, {
        command: 'settings',
        usage: 'canonry settings [provider|google|engine-routes|engine-connection|engine-models|engine-route] [args]',
        available: ['provider', 'google', 'engine-routes', 'engine-connection', 'engine-models', 'engine-route'],
      })
    },
  },
]
