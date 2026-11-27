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

const INVITE_USAGE =
  'canonry user invite <email> --role <admin|viewer> [--format json]'

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
    path: ['user', 'invite'],
    usage: INVITE_USAGE,
    options: {
      role: stringOption(),
    },
    run: async (input) => {
      const { inviteUser } = await import('../commands/users.js')
      const email = requirePositional(input, 0, {
        command: 'user.invite',
        usage: INVITE_USAGE,
        message: 'An email address is required',
      })
      const role = requireStringOption(input, 'role', {
        command: 'user.invite',
        usage: INVITE_USAGE,
        message: '--role is required (admin or viewer)',
      })
      await inviteUser({ email, role, format: input.format })
    },
  },
  {
    path: ['user', 'invitations'],
    usage: 'canonry user invitations [--format json|jsonl]',
    run: async (input) => {
      const { listUserInvitations } = await import('../commands/users.js')
      await listUserInvitations(input.format)
    },
  },
  {
    path: ['user', 'uninvite'],
    usage: 'canonry user uninvite <invitation-id> [--format json]',
    run: async (input) => {
      const { revokeUserInvitation } = await import('../commands/users.js')
      const id = requirePositional(input, 0, {
        command: 'user.uninvite',
        usage: 'canonry user uninvite <invitation-id> [--format json]',
        message: 'Invitation ID is required (see canonry user invitations)',
      })
      await revokeUserInvitation(id, input.format)
    },
  },
  {
    path: ['user'],
    usage: 'canonry user <list|create|delete|invite|invitations|uninvite>',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'user',
        usage: 'canonry user <list|create|delete|invite|invitations|uninvite>',
        available: ['list', 'create', 'delete', 'invite', 'invitations', 'uninvite'],
      })
    },
  },
]
