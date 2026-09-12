import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'
import { isMachineFormat, CliError } from '../cli-error.js'
import { promptHiddenInput, readAllStdin } from '../cli-prompt.js'
import {
  formatIsoDate,
  UserRoles,
  UserStatuses,
  USER_PASSWORD_MIN_LENGTH,
  type GoogleSignInConfig,
  type UpdateUserRequest,
  type UserDto,
  type UserRole,
} from '@ainyc/canonry-contracts'

function getClient() {
  return createApiClient()
}

const ROLE_NAMES = Object.values(UserRoles)
const STATUS_NAMES = Object.values(UserStatuses)

/** Copy label for the one-time invitation link in normal CLI output. */
export const INVITATION_URL_OUTPUT_PREFIX = 'Invitation URL:'

function parseRole(role: string): UserRole {
  const normalized = role.trim().toLowerCase()
  if ((ROLE_NAMES as string[]).includes(normalized)) return normalized as UserRole
  throw new CliError({
    code: 'CLI_USAGE_ERROR',
    message: `Unknown role "${role}" — choose ${ROLE_NAMES.join(' or ')}`,
    displayMessage: `Error: unknown role "${role}". Choose ${ROLE_NAMES.join(' or ')}.`,
  })
}

function parseStatus(status: string): UpdateUserRequest['status'] {
  const normalized = status.trim().toLowerCase()
  if ((STATUS_NAMES as string[]).includes(normalized)) return normalized as UpdateUserRequest['status']
  throw new CliError({
    code: 'CLI_USAGE_ERROR',
    message: `Unknown status "${status}" — choose ${STATUS_NAMES.join(' or ')}`,
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

  console.log(`${'NAME'.padEnd(24)} ${'ROLE'.padEnd(8)} ${'STATUS'.padEnd(10)} ${'CREATED'.padEnd(12)} LAST SIGN-IN`)
  for (const user of users) {
    const lastLogin = user.lastLoginAt ? formatIsoDate(user.lastLoginAt) : 'never'
    console.log(
      `${user.name.padEnd(24)} ${user.role.padEnd(8)} ${user.status.padEnd(10)} ${formatIsoDate(user.createdAt).padEnd(12)} ${lastLogin}`,
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
  } else if (created.role === UserRoles.analyst) {
    console.log('An analyst can read everything and run bounded research.')
  } else {
    console.log('An administrator can do everything the install could already do.')
  }
}

export async function updateUser(id: string, patch: { role?: string; status?: string; displayName?: string; email?: string; format?: string }): Promise<void> {
  const body: UpdateUserRequest = {
    ...(patch.role === undefined ? {} : { role: parseRole(patch.role) }),
    ...(patch.status === undefined ? {} : { status: parseStatus(patch.status) }),
    ...(patch.displayName === undefined ? {} : { displayName: patch.displayName.trim() || null }),
    ...(patch.email === undefined ? {} : { email: patch.email.trim() || null }),
  }
  if (Object.keys(body).length === 0) {
    throw new CliError({ code: 'CLI_USAGE_ERROR', message: 'Provide --role, --status, --display-name or --email.' })
  }
  const result = await getClient().updateUser(id, body)
  printResponse(result, patch.format, `Account "${result.name}" updated.`)
}

export async function changeUserStatus(id: string, status: 'active' | 'suspended', format?: string): Promise<void> {
  await updateUser(id, { status, format })
}

export async function listUserInvitations(format?: string): Promise<void> {
  const result = await getClient().listUserInvitations()
  printResponse(result, format, result.invitations.length === 0 ? 'No invitations.' : `${result.invitations.length} invitation(s).`)
}

export async function createUserInvitation(input: { email: string; role: string; format?: string }): Promise<void> {
  const role = parseRole(input.role)
  const result = await getClient().createUserInvitation({ email: input.email, role })
  printInvitationResponse(result, input.format, `Invitation created for ${result.invitation.email}.`)
}

export async function revokeUserInvitation(id: string, format?: string): Promise<void> {
  const result = await getClient().revokeUserInvitation(id)
  printResponse(result, format, 'Invitation revoked.')
}

export async function replaceUserInvitation(id: string, format?: string): Promise<void> {
  const result = await getClient().replaceUserInvitation(id)
  printInvitationResponse(result, format, `Invitation replaced for ${result.invitation.email}.`)
}

export async function revokeUserAccess(id: string, format?: string): Promise<void> {
  const result = await getClient().revokeUserAccess(id)
  printResponse(result, format, 'Active access revoked.')
}

export async function showUserAccessHistory(id: string, format?: string): Promise<void> {
  const result = await getClient().getUserAccessHistory(id)
  printResponse(result, format, result.events.length === 0 ? 'No access history.' : `${result.events.length} access event(s).`)
}

export async function showGoogleSignInConfig(format?: string): Promise<void> {
  const result = await getClient().getGoogleSignInSettings()
  printResponse(result, format, result.configured ? 'Google sign-in configuration is available.' : 'Google sign-in is not configured.')
}

export async function listAuthProviders(format?: string): Promise<void> {
  const result = await getClient().getAuthProviders()
  printResponse(result, format, result.google.enabled ? 'Google sign-in is available.' : 'No external sign-in provider is available.')
}

export async function configureGoogleSignIn(input: {
  enabled?: boolean
  clientId?: string
  clientSecretStdin?: boolean
  readStdin?: () => Promise<string>
  format?: string
}): Promise<void> {
  const clientSecret = input.clientSecretStdin
    ? (await (input.readStdin ?? readAllStdin)()).replace(/\r?\n$/, '')
    : undefined
  const body: Partial<GoogleSignInConfig> = {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
  }
  if (Object.keys(body).length === 0) {
    throw new CliError({ code: 'CLI_USAGE_ERROR', message: 'Provide --enabled, --disabled, --client-id, or --client-secret-stdin.' })
  }
  const result = await getClient().updateGoogleSignInSettings(body)
  printResponse(result, input.format, 'Google sign-in configuration updated.')
}

function printResponse(value: unknown, format: string | undefined, human: string): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  console.log(human)
}

function printInvitationResponse(value: { invitationUrl: string }, format: string | undefined, human: string): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  console.log(human)
  console.log(`${INVITATION_URL_OUTPUT_PREFIX} ${value.invitationUrl}`)
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
