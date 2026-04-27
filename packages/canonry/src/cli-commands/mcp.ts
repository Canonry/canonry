import { installMcp, printMcpConfig } from '../commands/mcp.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, requireStringOption, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { listMcpClientIds } from '../mcp-clients.js'

const CLIENT_LIST = listMcpClientIds().join('|')

export const MCP_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['mcp', 'install'],
    usage: `canonry mcp install --client ${CLIENT_LIST} [--name <server>] [--read-only] [--dry-run] [--config-path <path>] [--format json]`,
    options: {
      client: stringOption(),
      name: stringOption(),
      'read-only': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'config-path': stringOption(),
    },
    run: async (input) => {
      const usage = `canonry mcp install --client ${CLIENT_LIST} [--name <server>] [--read-only] [--dry-run] [--config-path <path>] [--format json]`
      const client = requireStringOption(input, 'client', {
        command: 'mcp.install',
        usage,
        message: '--client is required',
        details: { flag: 'client', supportedClients: listMcpClientIds() },
      })
      await installMcp({
        client,
        name: getString(input.values, 'name'),
        readOnly: getBoolean(input.values, 'read-only'),
        dryRun: getBoolean(input.values, 'dry-run'),
        configPath: getString(input.values, 'config-path'),
        format: input.format,
      })
    },
  },
  {
    path: ['mcp', 'config'],
    usage: `canonry mcp config --client ${CLIENT_LIST} [--name <server>] [--read-only] [--format json]`,
    options: {
      client: stringOption(),
      name: stringOption(),
      'read-only': { type: 'boolean' },
    },
    run: async (input) => {
      const usage = `canonry mcp config --client ${CLIENT_LIST} [--name <server>] [--read-only] [--format json]`
      const client = requireStringOption(input, 'client', {
        command: 'mcp.config',
        usage,
        message: '--client is required',
        details: { flag: 'client', supportedClients: listMcpClientIds() },
      })
      await printMcpConfig({
        client,
        name: getString(input.values, 'name'),
        readOnly: getBoolean(input.values, 'read-only'),
        format: input.format,
      })
    },
  },
  {
    path: ['mcp'],
    usage: 'canonry mcp <install|config> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'mcp',
        usage: 'canonry mcp <install|config> [args]',
        available: ['install', 'config'],
      })
    },
  },
]
