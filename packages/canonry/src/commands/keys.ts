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
    `${'NAME'.padEnd(20)} ${'PREFIX'.padEnd(11)} ${'SCOPES'.padEnd(20)} ${'CREATED'.padEnd(12)} ${'LAST USED'.padEnd(12)} STATUS`,
  )
  for (const key of keys) {
    const scopes = key.scopes.join(',')
    const lastUsed = key.lastUsedAt ? formatIsoDate(key.lastUsedAt) : '—'
    console.log(
      `${key.name.padEnd(20)} ${key.keyPrefix.padEnd(11)} ${scopes.padEnd(20)} ` +
      `${formatIsoDate(key.createdAt).padEnd(12)} ${lastUsed.padEnd(12)} ${keyStatus(key)}`,
    )
  }
}

export async function createApiKey(opts: {
  name: string
  scopes?: string[]
  readOnly?: boolean
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
