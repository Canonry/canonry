import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  requirePositional,
  requireStringOption,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'

const CREATE_USAGE =
  'canonry user create --name <name> --role <admin|viewer> [--password-stdin] [--format json]'

export const USERS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['user', 'list'],
    usage: 'canonry user list [--format json|jsonl]',
    run: async (input) => {
      const { listUsers } = await import('../commands/users.js')
      await listUsers(input.format)
    },
  },
  {
    path: ['user', 'create'],
    usage: CREATE_USAGE,
    options: {
      name: stringOption(),
      role: stringOption(),
      // There is deliberately no `--password` flag: a password given on the
      // command line lands in the shell history and the process list.
      'password-stdin': { type: 'boolean' },
    },
    run: async (input) => {
      const { createUser } = await import('../commands/users.js')
      const name = requireStringOption(input, 'name', {
        command: 'user.create',
        usage: CREATE_USAGE,
        message: '--name is required',
      })
      const role = requireStringOption(input, 'role', {
        command: 'user.create',
        usage: CREATE_USAGE,
        message: '--role is required (admin or viewer)',
      })
      await createUser({
        name,
        role,
        passwordStdin: getBoolean(input.values, 'password-stdin'),
        format: input.format,
      })
    },
  },
  {
    path: ['user', 'delete'],
    usage: 'canonry user delete <name> [--format json]',
    run: async (input) => {
      const { deleteUser } = await import('../commands/users.js')
      const name = requirePositional(input, 0, {
        command: 'user.delete',
        usage: 'canonry user delete <name> [--format json]',
        message: 'Account name is required',
      })
      await deleteUser(name, input.format)
    },
  },
  {
    path: ['user'],
    usage: 'canonry user <list|create|delete>',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'user',
        usage: 'canonry user <list|create|delete>',
        available: ['list', 'create', 'delete'],
      })
    },
  },
]
