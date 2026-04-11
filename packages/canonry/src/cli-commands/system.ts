import { bootstrapCommand } from '../commands/bootstrap.js'
import { startDaemon, stopDaemon } from '../commands/daemon.js'
import { initCommand } from '../commands/init.js'
import { serveCommand } from '../commands/serve.js'
import { telemetryCommand } from '../commands/telemetry.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

function applyServerEnv(values: Record<string, unknown>): void {
  const port = typeof values.port === 'string' ? values.port : undefined
  const host = typeof values.host === 'string' ? values.host : undefined
  const basePath = typeof values['base-path'] === 'string' ? values['base-path'] : undefined

  process.env.CANONRY_PORT = port ?? '4100'
  if (host) process.env.CANONRY_HOST = host
  else delete process.env.CANONRY_HOST
  if (basePath) process.env.CANONRY_BASE_PATH = basePath
  else delete process.env.CANONRY_BASE_PATH
}

export const SYSTEM_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['init'],
    usage: 'canonry init [--force] [--gemini-key <key>] [--openai-key <key>] [--claude-key <key>] [--perplexity-key <key>] [--local-url <url>] [--local-model <name>] [--local-key <key>] [--google-client-id <id>] [--google-client-secret <key>] [--format json]',
    options: {
      force: { type: 'boolean', short: 'f', default: false },
      'gemini-key': stringOption(),
      'openai-key': stringOption(),
      'claude-key': stringOption(),
      'perplexity-key': stringOption(),
      'local-url': stringOption(),
      'local-model': stringOption(),
      'local-key': stringOption(),
      'google-client-id': stringOption(),
      'google-client-secret': stringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await initCommand({
        force: getBoolean(input.values, 'force'),
        geminiKey: getString(input.values, 'gemini-key'),
        openaiKey: getString(input.values, 'openai-key'),
        claudeKey: getString(input.values, 'claude-key'),
        perplexityKey: getString(input.values, 'perplexity-key'),
        localUrl: getString(input.values, 'local-url'),
        localModel: getString(input.values, 'local-model'),
        localKey: getString(input.values, 'local-key'),
        googleClientId: getString(input.values, 'google-client-id'),
        googleClientSecret: getString(input.values, 'google-client-secret'),
        format: input.format,
      })
    },
  },
  {
    path: ['bootstrap'],
    usage: 'canonry bootstrap [--force] [--format json]',
    options: {
      force: { type: 'boolean', short: 'f', default: false },
    },
    allowPositionals: false,
    run: async (input) => {
      await bootstrapCommand({
        force: getBoolean(input.values, 'force'),
        format: input.format,
      })
    },
  },
  {
    path: ['serve'],
    usage: 'canonry serve [--port <port>] [--host <host>] [--base-path <path>] [--format json]',
    options: {
      port: stringOption(),
      host: stringOption(),
      'base-path': stringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      applyServerEnv(input.values)
      await serveCommand(input.format)
    },
  },
  {
    path: ['start'],
    usage: 'canonry start [--port <port>] [--host <host>] [--base-path <path>] [--format json]',
    options: {
      port: stringOption(),
      host: stringOption(),
      'base-path': stringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await startDaemon({
        port: getString(input.values, 'port'),
        host: getString(input.values, 'host'),
        basePath: getString(input.values, 'base-path'),
        format: input.format,
      })
    },
  },
  {
    path: ['stop'],
    usage: 'canonry stop [--format json]',
    allowPositionals: false,
    run: async (input) => {
      await stopDaemon(input.format)
    },
  },
  {
    path: ['telemetry', 'status'],
    usage: 'canonry telemetry status [--format json]',
    allowPositionals: false,
    run: async (input) => {
      await telemetryCommand('status', input.format)
    },
  },
  {
    path: ['telemetry', 'enable'],
    usage: 'canonry telemetry enable [--format json]',
    allowPositionals: false,
    run: async (input) => {
      await telemetryCommand('enable', input.format)
    },
  },
  {
    path: ['telemetry', 'disable'],
    usage: 'canonry telemetry disable [--format json]',
    allowPositionals: false,
    run: async (input) => {
      await telemetryCommand('disable', input.format)
    },
  },
  {
    path: ['telemetry'],
    usage: 'canonry telemetry <status|enable|disable> [--format json]',
    run: async (input) => {
      await unknownSubcommand(input.positionals[0], {
        command: 'telemetry',
        usage: 'canonry telemetry <status|enable|disable> [--format json]',
        available: ['status', 'enable', 'disable'],
      })
    },
  },
]
