import crypto from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { eq } from 'drizzle-orm'
import { getBootstrapEnv } from '@ainyc/canonry-config'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'

import { configExists, getConfigDir, getConfigPath, loadConfig, loadConfigRaw, saveConfig } from '../config.js'
import type { CliFormat } from '../cli-error.js'

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

  if (format === 'json') {
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
    }, null, 2))
    return
  }

  console.log(`Bootstrap ${status}. Config: ${getConfigPath()}`)
  console.log(`SQLite database path: ${databasePath}`)
  if (Object.keys(mergedProviders).length === 0) {
    console.log('Providers: none (Page Health works now; add one later to enable AI Visibility).')
  }
  if (generatedApiKey) {
    console.log(`API key: ${generatedApiKey}`)
  }
}
