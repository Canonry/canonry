import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'
import { isMachineFormat, CliError } from '../cli-error.js'
import { READ_ONLY_SCOPE, formatIsoDate, type ApiKeyDto, type CreateApiKeyRequest } from '@ainyc/canonry-contracts'

function getClient() {
  return createApiClient()
}

function keyStatus(key: Pick<ApiKeyDto, 'revokedAt'>): 'active' | 'revoked' {
  return key.revokedAt ? 'revoked' : 'active'
}

export async function listApiKeys(format?: string): Promise<void> {
  const client = getClient()
  const { keys } = await client.listApiKeys()

  if (format === 'json') {
    console.log(JSON.stringify({ keys }, null, 2))
    return
  } else if (format === 'jsonl') {
    // Each key row already self-identifies (id, prefix, scopes) and carries no
    // sensitive material, so it stands alone when lifted out of the envelope.
    emitJsonl(keys)
    return
  }

  if (keys.length === 0) {
    console.log('No API keys found.')
    return
  }

  console.log(
    `${'NAME'.padEnd(20)} ${'PREFIX'.padEnd(11)} ${'SCOPES'.padEnd(20)} ${'REACH'.padEnd(18)} ${'CREATED'.padEnd(12)} ${'LAST USED'.padEnd(12)} STATUS`,
  )
  for (const key of keys) {
    const scopes = key.scopes.join(',')
    const lastUsed = key.lastUsedAt ? formatIsoDate(key.lastUsedAt) : '—'
    console.log(
      `${key.name.padEnd(20)} ${key.keyPrefix.padEnd(11)} ${scopes.padEnd(20)} ${keyReach(key).padEnd(18)} ` +
      `${formatIsoDate(key.createdAt).padEnd(12)} ${lastUsed.padEnd(12)} ${keyStatus(key)}`,
    )
  }
}

/**
 * A key as it arrives over the wire. `projectName` is REQUIRED by the DTO, but
 * `ApiClient` casts the response rather than parsing it, so a server older than
 * the field really does deliver an object without it. Typing that possibility
 * here is what makes the absent branch expressible and testable instead of
 * dead code the compiler insists cannot happen.
 */
export type KeyReachInput = Omit<ApiKeyDto, 'projectName'> & { projectName?: string | null }

/**
 * How far a key reaches. Worth its own column because it is the question an
 * operator is usually holding this list open to answer — whether a key can be
 * handed to somebody — and `scopes` alone does not answer it: a `read` key with
 * no project still reads every project on the install.
 */
export function keyReach(key: KeyReachInput): string {
  if (!key.projectId) return 'full instance'
  if (typeof key.projectName === 'string') return key.projectName
  // Absent and null mean different things and must not collapse. A server
  // older than this field sends nothing, so fall back to the id rather than
  // claim the project is gone; only an explicit null is the server saying it
  // looked and found no project. The scope is real either way, so neither
  // renders as full instance.
  return key.projectName === null ? '(deleted project)' : key.projectId.slice(0, 8)
}

export async function createApiKey(opts: {
  name: string
  scopes?: string[]
  readOnly?: boolean
  project?: string
  format?: string
}): Promise<void> {
  const explicitScopes = opts.scopes && opts.scopes.length > 0 ? opts.scopes : undefined

  // `--read-only` is sugar for `--scope read`; combining it with explicit
  // scopes is contradictory, so reject rather than silently picking one.
  if (opts.readOnly && explicitScopes) {
    throw new CliError({
      code: 'CLI_USAGE_ERROR',
      message: '--read-only cannot be combined with --scope',
      displayMessage: 'Error: --read-only cannot be combined with --scope (it already implies the "read" scope).',
    })
  }

  const client = getClient()
  const body: CreateApiKeyRequest = { name: opts.name }
  const scopes = opts.readOnly ? [READ_ONLY_SCOPE] : explicitScopes
  if (scopes) body.scopes = scopes

  // `--project <name>` scopes the key to a single project. The API binds by
  // project id, so resolve the name first (a clear 404 beats minting a key
  // against a typo'd project).
  if (opts.project) {
    const proj = await client.getProject(opts.project)
    body.projectId = proj.id
  }

  const created = await client.createApiKey(body)

  if (isMachineFormat(opts.format)) {
    // The plaintext `key` is included here by design — JSON output is the
    // machine contract, and an agent minting a key needs the token back.
    console.log(JSON.stringify(created, null, 2))
    return
  }

  console.log(`API key "${created.name}" created.\n`)
  console.log(`  Key:       ${created.key}`)
  console.log(`  Prefix:    ${created.keyPrefix}`)
  console.log(`  Scopes:    ${created.scopes.join(', ')}`)
  console.log(`  Read-only: ${created.readOnly ? 'yes' : 'no'}`)
  console.log(`  Reach:     ${keyReach(created)}`)
  console.log('\nSave this now — it will not be shown again.')
}

/** `canonry key whoami` — introspect the key this CLI authenticates with. */
export async function showApiKeySelf(format?: string): Promise<void> {
  const client = getClient()
  const key = await client.getApiKeySelf()

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(key, null, 2))
    return
  }

  console.log(`API key "${key.name}" (${key.keyPrefix})`)
  console.log(`  Scopes:    ${key.scopes.join(', ')}`)
  console.log(`  Read-only: ${key.readOnly ? 'yes' : 'no'}`)
  console.log(`  Operator:  ${key.operator === true ? 'yes' : 'no'}`)
  console.log(`  Reach:     ${keyReach(key)}`)
  console.log(`  Status:    ${keyStatus(key)}`)
}

export async function revokeApiKey(id: string, format?: string): Promise<void> {
  const client = getClient()
  const key = await client.revokeApiKey(id)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(key, null, 2))
    return
  }

  console.log(`API key "${key.name}" (${key.keyPrefix}) revoked.`)
}
