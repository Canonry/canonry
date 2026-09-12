import {
  changeUserStatus,
  configureGoogleSignIn,
  createUser,
  createUserInvitation,
  deleteUser,
  listAuthProviders,
  listUserInvitations,
  listUsers,
  replaceUserInvitation,
  revokeUserAccess,
  revokeUserInvitation,
  showGoogleSignInConfig,
  showUserAccessHistory,
  updateUser,
} from '../commands/users.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  requirePositional,
  requireStringOption,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { CliError } from '../cli-error.js'

const CREATE_USAGE =
  'canonry user create --name <name> --role <admin|analyst|viewer> [--password-stdin] [--format json]'

export const USERS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['user', 'list'],
    usage: 'canonry user list [--format json|jsonl]',
    run: async (input) => {
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
      const name = requireStringOption(input, 'name', {
        command: 'user.create',
        usage: CREATE_USAGE,
        message: '--name is required',
      })
      const role = requireStringOption(input, 'role', {
        command: 'user.create',
        usage: CREATE_USAGE,
        message: '--role is required (admin, analyst, or viewer)',
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
    path: ['user', 'update'],
    usage: 'canonry user update <id> [--role <admin|analyst|viewer>] [--status <active|suspended>] [--display-name <name>] [--email <email>] [--format json]',
    options: { role: stringOption(), status: stringOption(), 'display-name': stringOption(), email: stringOption() },
    run: async (input) => updateUser(requirePositional(input, 0, {
      command: 'user.update', usage: 'canonry user update <id>', message: 'Account id is required',
    }), { role: input.values.role as string | undefined, status: input.values.status as string | undefined, displayName: input.values['display-name'] as string | undefined, email: input.values.email as string | undefined, format: input.format }),
  },
  ...(['suspend', 'reactivate'] as const).map((action) => ({
    path: ['user', action],
    usage: `canonry user ${action} <id> [--format json]`,
    run: async (input: Parameters<NonNullable<CliCommandSpec['run']>>[0]) => changeUserStatus(requirePositional(input, 0, {
      command: `user.${action}`, usage: `canonry user ${action} <id>`, message: 'Account id is required',
    }), action === 'suspend' ? 'suspended' : 'active', input.format),
  })),
  {
    path: ['user', 'revoke-access'], usage: 'canonry user revoke-access <id> [--format json]',
    run: async (input) => revokeUserAccess(requirePositional(input, 0, { command: 'user.revoke-access', usage: 'canonry user revoke-access <id>', message: 'Account id is required' }), input.format),
  },
  {
    path: ['user', 'history'], usage: 'canonry user history <id> [--format json]',
    run: async (input) => showUserAccessHistory(requirePositional(input, 0, { command: 'user.history', usage: 'canonry user history <id>', message: 'Account id is required' }), input.format),
  },
  {
    path: ['user', 'invite', 'list'], usage: 'canonry user invite list [--format json]', run: async input => listUserInvitations(input.format),
  },
  {
    path: ['user', 'invite', 'create'], usage: 'canonry user invite create --email <email> --role <admin|analyst|viewer> [--format json]',
    options: { email: stringOption(), role: stringOption() },
    run: async input => createUserInvitation({
      email: requireStringOption(input, 'email', { command: 'user.invite.create', usage: 'canonry user invite create --email <email> --role <role>', message: '--email is required' }),
      role: requireStringOption(input, 'role', { command: 'user.invite.create', usage: 'canonry user invite create --email <email> --role <role>', message: '--role is required' }),
      format: input.format,
    }),
  },
  ...(['revoke', 'replace'] as const).map((action) => ({
    path: ['user', 'invite', action], usage: `canonry user invite ${action} <id> [--format json]`,
    run: async (input: Parameters<NonNullable<CliCommandSpec['run']>>[0]) => (action === 'revoke' ? revokeUserInvitation : replaceUserInvitation)(requirePositional(input, 0, { command: `user.invite.${action}`, usage: `canonry user invite ${action} <id>`, message: 'Invitation id is required' }), input.format),
  })),
  {
    path: ['user', 'auth', 'google', 'status'], usage: 'canonry user auth google status [--format json]', run: async input => showGoogleSignInConfig(input.format),
  },
  { path: ['user', 'auth', 'providers'], usage: 'canonry user auth providers [--format json]', run: async input => listAuthProviders(input.format) },
  {
    path: ['user', 'auth', 'google', 'configure'],
    usage: 'canonry user auth google configure [--enabled|--disabled] [--client-id <id>] [--client-secret-stdin] [--format json]',
    options: { enabled: { type: 'boolean' }, disabled: { type: 'boolean' }, 'client-id': stringOption(), 'client-secret-stdin': { type: 'boolean' } },
    run: async input => {
      const enabled = getBoolean(input.values, 'enabled') ? true : getBoolean(input.values, 'disabled') ? false : undefined
      if (getBoolean(input.values, 'enabled') && getBoolean(input.values, 'disabled')) {
        throw new CliError({ code: 'CLI_USAGE_ERROR', message: '--enabled and --disabled cannot be used together.' })
      }
      await configureGoogleSignIn({ enabled, clientId: input.values['client-id'] as string | undefined, clientSecretStdin: getBoolean(input.values, 'client-secret-stdin'), format: input.format })
    },
  },
  {
    path: ['user', 'delete'],
    usage: 'canonry user delete <name> [--format json]',
    run: async (input) => {
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
    usage: 'canonry user <list|create|update|suspend|reactivate|revoke-access|history|invite|auth|delete>',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'user',
        usage: 'canonry user <list|create|update|suspend|reactivate|revoke-access|history|invite|auth|delete>',
        available: ['list', 'create', 'update', 'suspend', 'reactivate', 'revoke-access', 'history', 'invite', 'auth', 'delete'],
      })
    },
  },
]
