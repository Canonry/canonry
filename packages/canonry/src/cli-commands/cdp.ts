import { cdpConnect, cdpScreenshot, cdpStatus, cdpTargets } from '../commands/cdp.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requirePositional, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

export const CDP_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['cdp', 'connect'],
    usage: 'canonry cdp connect [--host <host>] [--port <port>] [--format json]',
    options: {
      host: stringOption(),
      port: stringOption(),
    },
    allowPositionals: false,
    run: async (input) => {
      await cdpConnect({
        host: getString(input.values, 'host'),
        port: getString(input.values, 'port'),
        format: input.format,
      })
    },
  },
  {
    path: ['cdp', 'status'],
    usage: 'canonry cdp status [--format json]',
    allowPositionals: false,
    run: async (input) => {
      await cdpStatus(input.format)
    },
  },
  {
    path: ['cdp', 'targets'],
    usage: 'canonry cdp targets [--format json]',
    allowPositionals: false,
    run: async (input) => {
      await cdpTargets(input.format)
    },
  },
  {
    path: ['cdp', 'screenshot'],
    usage: 'canonry cdp screenshot <query> [--targets <list>] [--format json]',
    options: {
      targets: stringOption(),
    },
    run: async (input) => {
      const query = requirePositional(input, 0, {
        command: 'cdp.screenshot',
        usage: 'canonry cdp screenshot <query> [--targets <list>] [--format json]',
        message: 'query is required',
      })
      await cdpScreenshot(query, {
        targets: getString(input.values, 'targets'),
        format: input.format,
      })
    },
  },
  {
    path: ['cdp'],
    usage: 'canonry cdp <connect|status|targets|screenshot> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'cdp',
        usage: 'canonry cdp <connect|status|targets|screenshot> [args]',
        available: ['connect', 'status', 'targets', 'screenshot'],
      })
    },
  },
]
