import { bootstrapCommand } from '../commands/bootstrap.js'
import { startDaemon, stopDaemon } from '../commands/daemon.js'
import { initCommand } from '../commands/init.js'
import { serveCommand } from '../commands/serve.js'
import { telemetryCommand } from '../commands/telemetry.js'
import type { CliCommandSpec, CliValues } from '../cli-dispatch.js'
import { getBoolean, getString, getStringArray, multiStringOption, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

export function applyServerEnv(values: CliValues): void {
  const port = typeof values.port === 'string' ? values.port : undefined
  const host = typeof values.host === 'string' ? values.host : undefined
  const basePath = typeof values['base-path'] === 'string' ? values['base-path'] : undefined

  if (port) process.env.CANONRY_PORT = port
  if (host) process.env.CANONRY_HOST = host
  if (basePath) process.env.CANONRY_BASE_PATH = basePath

  // Embed mode (#716). Each var is guarded on presence so an unset flag never
  // clobbers an inherited env value (mirrors the basePath handling above).
  const embedOrigins = getStringArray(values, 'embed-allow-origin')
  const embedViews = getStringArray(values, 'embed-view')
  if (getBoolean(values, 'embed')) process.env.CANONRY_EMBED = '1'
  if (embedOrigins && embedOrigins.length > 0) process.env.CANONRY_EMBED_ORIGINS = embedOrigins.join(',')
  if (embedViews && embedViews.length > 0) process.env.CANONRY_EMBED_VIEWS = embedViews.join(',')
}

export const SYSTEM_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['init'],
    usage: 'canonry init [--force] [--gemini-key <key>] [--openai-key <key>] [--claude-key <key>] [--perplexity-key <key>] [--local-url <url>] [--local-model <name>] [--local-key <key>] [--google-client-id <id>] [--google-client-secret <key>] [--skip-skills] [--skip-mcp] [--skills-dir <path>] [--format json]',
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
      'skip-skills': { type: 'boolean' },
      'skip-mcp': { type: 'boolean' },
      'skills-dir': stringOption(),
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
        skipSkills: getBoolean(input.values, 'skip-skills'),
        skipMcp: getBoolean(input.values, 'skip-mcp'),
        skillsDir: getString(input.values, 'skills-dir'),
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
    usage: 'canonry serve [--port <port>] [--host <host>] [--base-path <path>] [--embed] [--embed-allow-origin <origin>...] [--embed-view <view>...] [--format json]',
    options: {
      port: stringOption(),
      host: stringOption(),
      'base-path': stringOption(),
      embed: { type: 'boolean', default: false },
      'embed-allow-origin': multiStringOption(),
      'embed-view': multiStringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      applyServerEnv(input.values)
      await serveCommand(input.format)
    },
  },
  {
    path: ['start'],
    usage: 'canonry start [--port <port>] [--host <host>] [--base-path <path>] [--embed] [--embed-allow-origin <origin>...] [--embed-view <view>...] [--format json]',
    options: {
      port: stringOption(),
      host: stringOption(),
      'base-path': stringOption(),
      embed: { type: 'boolean', default: false },
      'embed-allow-origin': multiStringOption(),
      'embed-view': multiStringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await startDaemon({
        port: getString(input.values, 'port'),
        host: getString(input.values, 'host'),
        basePath: getString(input.values, 'base-path'),
        embed: getBoolean(input.values, 'embed'),
        embedAllowOrigins: getStringArray(input.values, 'embed-allow-origin'),
        embedViews: getStringArray(input.values, 'embed-view'),
        format: input.format,
      })
    },
  },
  {
    path: ['stop'],
    usage: 'canonry stop [--format json]',
    allowPositionals: false,
    run: (input) => {
      stopDaemon(input.format)
    },
  },
  {
    path: ['telemetry', 'status'],
    usage: 'canonry telemetry status [--format json]',
    allowPositionals: false,
    run: (input) => {
      telemetryCommand('status', input.format)
    },
  },
  {
    path: ['telemetry', 'enable'],
    usage: 'canonry telemetry enable [--format json]',
    allowPositionals: false,
    run: (input) => {
      telemetryCommand('enable', input.format)
    },
  },
  {
    path: ['telemetry', 'disable'],
    usage: 'canonry telemetry disable [--format json]',
    allowPositionals: false,
    run: (input) => {
      telemetryCommand('disable', input.format)
    },
  },
  {
    path: ['telemetry'],
    usage: 'canonry telemetry <status|enable|disable> [--format json]',
    run: (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'telemetry',
        usage: 'canonry telemetry <status|enable|disable> [--format json]',
        available: ['status', 'enable', 'disable'],
      })
    },
  },
]
