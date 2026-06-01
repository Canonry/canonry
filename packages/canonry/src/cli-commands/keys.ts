import { createApiKey, listApiKeys, revokeApiKey } from '../commands/keys.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getStringArray,
  multiStringOption,
  requirePositional,
  requireStringOption,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'

export const KEYS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['key', 'list'],
    usage: 'canonry key list [--format json|jsonl]',
    run: async (input) => {
      await listApiKeys(input.format)
    },
  },
  {
    path: ['key', 'create'],
    usage: 'canonry key create --name <name> [--scope <s> ...] [--format json]',
    options: {
      name: stringOption(),
      scope: multiStringOption(),
    },
    run: async (input) => {
      const name = requireStringOption(input, 'name', {
        command: 'key.create',
        usage: 'canonry key create --name <name> [--scope <s> ...] [--format json]',
        message: '--name is required',
      })
      // Accept repeated flags (--scope read --scope keys.write) and
      // comma-separated values (--scope read,keys.write).
      const raw = getStringArray(input.values, 'scope') ?? []
      const scopes = raw.flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean)
      await createApiKey({
        name,
        scopes: scopes.length > 0 ? scopes : undefined,
        format: input.format,
      })
    },
  },
  {
    path: ['key', 'revoke'],
    usage: 'canonry key revoke <id> [--format json]',
    run: async (input) => {
      const id = requirePositional(input, 0, {
        command: 'key.revoke',
        usage: 'canonry key revoke <id> [--format json]',
        message: 'API key ID is required',
      })
      await revokeApiKey(id, input.format)
    },
  },
  {
    path: ['key'],
    usage: 'canonry key <list|create|revoke>',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'key',
        usage: 'canonry key <list|create|revoke>',
        available: ['list', 'create', 'revoke'],
      })
    },
  },
]
