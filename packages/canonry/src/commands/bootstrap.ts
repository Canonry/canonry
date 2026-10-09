import crypto from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { eq } from 'drizzle-orm'
import { getBootstrapEnv } from '@ainyc/canonry-config'
import { createClient, migrate, apiKeys, dashboardSessions } from '@ainyc/canonry-db'

import { configExists, getConfigDir, getConfigPath, loadConfig, loadConfigRaw, saveConfig } from '../config.js'
import { isMachineFormat, type CliFormat } from '../cli-error.js'

function persistedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(persistedValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, persistedValue(entry)]),
    )
  }
  return value
}

/**
 * What an agent reading `--format json` should do about a provider-less
 * install. Bootstrap is the provider-free path, so these are the only steps
 * it names: the same remedy `doctor`'s `providers.none-configured` gives,
 * with the credential kept out of the agent's hands.
 */
const PROVIDER_FREE_NEXT_STEPS: readonly string[] = [
  'AI Visibility needs an answer-engine provider. Page Health does not.',
  'To add one, the operator sets GEMINI_API_KEY (free key at https://aistudio.google.com/apikey) and reruns `canonry bootstrap`, '
    + 'or runs `canonry settings provider gemini --api-key <key>` while the server is running. '
    + 'A provider key is the operator\'s credential: never ask for it in chat.',
]

export async function bootstrapCommand(opts?: { format?: CliFormat }): Promise<void> {
  const format = opts?.format ?? 'text'
  const env = getBootstrapEnv(process.env)
  const providers = env.providers

  const configDir = getConfigDir()
  const existing = configExists()
  const existingConfig = existing ? loadConfig() : undefined
  const existingRaw = existing ? loadConfigRaw() : null
  const databasePath = env.databasePath || existingRaw?.database || path.join(configDir, 'data.db')

  // Resolve API key: env var > existing config > generate new
  let rawApiKey: string
  let generatedApiKey: string | undefined
  if (env.apiKey) {
    rawApiKey = env.apiKey
  } else if (existingRaw) {
    rawApiKey = existingRaw.apiKey
  } else {
    generatedApiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    rawApiKey = generatedApiKey
  }

  // Merge providers: env vars override, but preserve dashboard-configured
  // providers that don't have a corresponding env var set
  const mergedProviders = { ...existingConfig?.providers }
  if (providers.gemini) mergedProviders.gemini = providers.gemini
  if (providers.openai) mergedProviders.openai = providers.openai
  if (providers.claude) mergedProviders.claude = providers.claude
  if (providers.perplexity) mergedProviders.perplexity = providers.perplexity
  if (providers.muse) mergedProviders.muse = providers.muse
  if (providers.local) mergedProviders.local = providers.local

  if ((env.googleClientId && !env.googleClientSecret) || (!env.googleClientId && env.googleClientSecret)) {
    console.warn('Warning: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set to configure Google OAuth. Skipping Google auth config.')
  }

  const mergedGoogle = env.googleClientId && env.googleClientSecret
    ? {
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
        connections: existingConfig?.google?.connections ?? [],
      }
    : existingConfig?.google

  const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex')
  const keyPrefix = rawApiKey.slice(0, 9)
  const existingConfigKeyHash = existingRaw
    ? crypto.createHash('sha256').update(existingRaw.apiKey).digest('hex')
    : undefined

  const db = createClient(databasePath)
  migrate(db)
  const keyChanged = db.transaction((tx) => {
    let changed = false
    const rotatedAt = new Date().toISOString()
    const existingDefaults = tx.select({
      id: apiKeys.id,
      keyHash: apiKeys.keyHash,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      projectId: apiKeys.projectId,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    }).from(apiKeys)
      .where(eq(apiKeys.name, 'default')).all()
    const existingDefault = existingDefaults.find(key => key.keyHash === existingConfigKeyHash)
      ?? existingDefaults.at(0)
    if (existingDefault) {
      // Activation grants retain the approving/executing API-key ids as durable
      // audit identity. Rotate the default credential in place so bootstrap can
      // be repeated without violating those foreign keys or orphaning receipts.
      const rotating = existingDefault.keyHash !== keyHash
      const needsUpdate = rotating
        || existingDefault.keyPrefix !== keyPrefix
        || !isDeepStrictEqual(existingDefault.scopes, ['*'])
        || existingDefault.projectId !== null
        || existingDefault.revokedAt !== null
      if (needsUpdate) {
        if (rotating || existingDefault.revokedAt !== null) {
          tx.delete(dashboardSessions).where(eq(dashboardSessions.apiKeyId, existingDefault.id)).run()
        }
        tx.update(apiKeys).set({
          keyHash,
          keyPrefix,
          scopes: ['*'],
          projectId: null,
          ...(rotating ? { lastUsedAt: null } : {}),
          revokedAt: null,
        }).where(eq(apiKeys.id, existingDefault.id)).run()
        changed = true
      }
      for (const duplicate of existingDefaults) {
        if (duplicate.id === existingDefault.id) continue
        tx.delete(dashboardSessions).where(eq(dashboardSessions.apiKeyId, duplicate.id)).run()
        if (duplicate.revokedAt === null) {
          tx.update(apiKeys).set({ revokedAt: rotatedAt })
            .where(eq(apiKeys.id, duplicate.id)).run()
          changed = true
        }
      }
    } else {
      tx.insert(apiKeys).values({
        id: crypto.randomUUID(),
        name: 'default',
        keyHash,
        keyPrefix,
        scopes: ['*'],
        createdAt: rotatedAt,
      }).run()
      changed = true
    }
    return changed
  })

  const apiUrl = env.apiUrl || existingRaw?.apiUrl || `http://127.0.0.1:${process.env.CANONRY_PORT || '4100'}`
  // Spread the RAW on-disk config, never `loadConfig()`'s result: that one is
  // mutated at load time from the environment (CANONRY_BASE_PATH overwrites
  // `basePath`, CANONRY_EXTERNAL_MCP overwrites `externalMcpServers`). Spreading
  // it persisted those process-only overrides into config.yaml, so a single
  // `CANONRY_BASE_PATH=/cnry canonry bootstrap` permanently routed every later
  // CLI invocation through /cnry. The explicit fields below are still written.
  const nextConfig = {
    ...existingRaw,
    apiUrl,
    database: databasePath,
    apiKey: rawApiKey,
    providers: mergedProviders,
    google: mergedGoogle,
  }
  const configChanged = !existingRaw
    || existingRaw.apiUrl !== apiUrl
    || existingRaw.database !== databasePath
    || existingRaw.apiKey !== rawApiKey
    || !isDeepStrictEqual(persistedValue(existingRaw.providers ?? {}), persistedValue(mergedProviders))
    || !isDeepStrictEqual(persistedValue(existingRaw.google), persistedValue(mergedGoogle))
  if (configChanged) saveConfig(nextConfig)

  const status = !existing ? 'created' : configChanged || keyChanged ? 'updated' : 'unchanged'
  const providerFree = Object.keys(mergedProviders).length === 0

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      bootstrapped: true,
      status,
      changed: status !== 'unchanged',
      configPath: getConfigPath(),
      databasePath,
      apiUrl,
      providers: Object.keys(mergedProviders),
      googleConfigured: !!mergedGoogle,
      generatedApiKey,
      nextSteps: providerFree ? PROVIDER_FREE_NEXT_STEPS : [],
    }, null, 2))
    return
  }

  console.log(`Bootstrap ${status}. Config: ${getConfigPath()}`)
  console.log(`SQLite database path: ${databasePath}`)
  if (providerFree) {
    console.log('Providers: none (Page Health works now; add one later to enable AI Visibility).')
    console.log('  To add one, set GEMINI_API_KEY (free key at aistudio.google.com) and rerun `canonry bootstrap`,')
    console.log('  or run `canonry settings provider gemini --api-key <key>` while the server is running.')
  }
  if (generatedApiKey) {
    // Say what it is for. This is the only place the key appears, and without
    // a purpose it reads as a second credential competing with the dashboard
    // password the operator is about to be asked for.
    console.log(`API key (for the CLI, MCP, and agents): ${generatedApiKey}`)
  }
}
