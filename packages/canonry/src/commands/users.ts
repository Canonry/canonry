import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'
import { isMachineFormat, CliError } from '../cli-error.js'
import { promptHiddenInput, readAllStdin } from '../cli-prompt.js'
import {
  formatIsoDate,
  UserRoles,
  USER_PASSWORD_MIN_LENGTH,
  type UserDto,
  type UserRole,
} from '@canonry/canonry-contracts'

function getClient() {
  return createApiClient()
}

const ROLE_NAMES = Object.values(UserRoles)

function parseRole(role: string): UserRole {
  const normalized = role.trim().toLowerCase()
  if ((ROLE_NAMES as string[]).includes(normalized)) return normalized as UserRole
  throw new CliError({
    code: 'CLI_USAGE_ERROR',
    message: `Unknown role "${role}" — choose ${ROLE_NAMES.join(' or ')}`,
    displayMessage: `Error: unknown role "${role}". Choose ${ROLE_NAMES.join(' or ')}.`,
  })
}

export async function listUsers(format?: string): Promise<void> {
  const client = getClient()
  const { users } = await client.listUsers()

  if (format === 'json') {
    console.log(JSON.stringify({ users }, null, 2))
    return
  } else if (format === 'jsonl') {
    emitJsonl(users)
    return
  }

  if (users.length === 0) {
    console.log('No accounts yet — the dashboard opens without a sign-in.')
    console.log('Create the first one with: canonry user create --name <name> --role admin')
    return
  }

  console.log(`${'NAME'.padEnd(24)} ${'ROLE'.padEnd(8)} ${'CREATED'.padEnd(12)} LAST SIGN-IN`)
  for (const user of users) {
    const lastLogin = user.lastLoginAt ? formatIsoDate(user.lastLoginAt) : 'never'
    console.log(
      `${user.name.padEnd(24)} ${user.role.padEnd(8)} ${formatIsoDate(user.createdAt).padEnd(12)} ${lastLogin}`,
    )
  }
}

export interface CreateUserOptions {
  name: string
  role: string
  /** Read the password from standard input instead of asking for it. */
  passwordStdin?: boolean
  /** Test seam for the standard-input read. */
  readStdin?: () => Promise<string>
  format?: string
}

export async function createUser(opts: CreateUserOptions): Promise<void> {
  const role = parseRole(opts.role)
  const password = opts.passwordStdin
    ? (await (opts.readStdin ?? readAllStdin)()).replace(/\r?\n$/, '')
    : await askForPassword()

  if (password.length < USER_PASSWORD_MIN_LENGTH) {
    throw new CliError({
      code: 'CLI_USAGE_ERROR',
      message: 'Password too short',
      displayMessage: `Error: the password must be at least ${USER_PASSWORD_MIN_LENGTH} characters.`,
    })
  }

  const client = getClient()
  // Whether this is the first account decides what the operator is told
  // afterwards, and it has to be read BEFORE the account is created.
  const wasFirst = await isFirstAccount(client)
  const created = await client.createUser({ name: opts.name, role, password })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(created, null, 2))
    return
  }

  printCreated(created, wasFirst)
}

async function askForPassword(): Promise<string> {
  const first = await promptHiddenInput('Password: ')
  const second = await promptHiddenInput('Confirm password: ')
  if (first !== second) {
    throw new CliError({
      code: 'CLI_USAGE_ERROR',
      message: 'Passwords do not match',
      displayMessage: 'Error: the two passwords do not match. Nothing was created.',
    })
  }
  return first
}

async function isFirstAccount(client: ReturnType<typeof getClient>): Promise<boolean> {
  try {
    const { users } = await client.listUsers()
    return users.length === 0
  } catch {
    // Listing accounts is an administrator read and can legitimately fail (a
    // narrower key, for instance). Not knowing is not a reason to refuse to
    // create the account — it only means the extra note is left unsaid.
    return false
  }
}

function printCreated(created: UserDto, wasFirst: boolean): void {
  console.log(`Account "${created.name}" created with ${created.role} access.\n`)
  if (wasFirst) {
    console.log('This is the first account on this install, so the dashboard now asks')
    console.log('everyone to sign in. API keys are unaffected and keep working as before.\n')
  }
  if (created.role === UserRoles.viewer) {
    console.log('A viewer can read everything and change nothing.')
  } else {
    console.log('An administrator can do everything the install could already do.')
  }
}

export async function deleteUser(name: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.deleteUser(name)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Account "${result.name}" deleted. Any browser signed in as them is signed out now.`)
}
