import crypto from 'node:crypto'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { getBootstrapEnv } from '@ainyc/canonry-config'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'

import { configExists, getConfigDir, getConfigPath, loadConfig, saveConfig } from '../config.js'
import type { CliFormat } from '../cli-error.js'

export async function bootstrapCommand(_opts?: { force?: boolean; format?: CliFormat }): Promise<void> {
  const format = _opts?.format ?? 'text'
  const env = getBootstrapEnv(process.env)
  const providers = env.providers
  const hasProvider = providers?.gemini || providers?.openai || providers?.claude || providers?.perplexity || providers?.local

  if (!hasProvider) {
    console.warn(
      'Warning: No provider env vars set (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, or LOCAL_BASE_URL). You can configure providers later via the dashboard.',
    )
  }

  const configDir = getConfigDir()
  const databasePath = env.databasePath || path.join(configDir, 'data.db')
  const existing = configExists()
  const existingConfig = existing ? loadConfig() : undefined

  // Resolve API key: env var > existing config > generate new
  let rawApiKey: string
  let generatedApiKey: string | undefined
  if (env.apiKey) {
    rawApiKey = env.apiKey
  } else if (existingConfig) {
    rawApiKey = existingConfig.apiKey
  } else {
    generatedApiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    rawApiKey = generatedApiKey
  }

  // Merge providers: env vars override, but preserve dashboard-configured
  // providers that don't have a corresponding env var set
  const mergedProviders = { ...existingConfig?.providers }
  if (providers?.gemini) mergedProviders.gemini = providers.gemini
  if (providers?.openai) mergedProviders.openai = providers.openai
  if (providers?.claude) mergedProviders.claude = providers.claude
  if (providers?.perplexity) mergedProviders.perplexity = providers.perplexity
  if (providers?.local) mergedProviders.local = providers.local

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
  const existingConfigKeyHash = existingConfig
    ? crypto.createHash('sha256').update(existingConfig.apiKey).digest('hex')
    : undefined

  const db = createClient(databasePath)
  migrate(db)
  db.transaction((tx) => {
    const rotatedAt = new Date().toISOString()
    const existingDefaults = tx.select({ id: apiKeys.id, keyHash: apiKeys.keyHash }).from(apiKeys)
      .where(eq(apiKeys.name, 'default')).all()
    const existingDefault = existingDefaults.find(key => key.keyHash === existingConfigKeyHash)
      ?? existingDefaults.at(0)
    if (existingDefault) {
      // Activation grants retain the approving/executing API-key ids as durable
      // audit identity. Rotate the default credential in place so bootstrap can
      // be repeated without violating those foreign keys or orphaning receipts.
      tx.update(apiKeys).set({
        keyHash,
        keyPrefix,
        scopes: ['*'],
        projectId: null,
        lastUsedAt: null,
        revokedAt: null,
      }).where(eq(apiKeys.id, existingDefault.id)).run()
      for (const duplicate of existingDefaults) {
        if (duplicate.id === existingDefault.id) continue
        tx.update(apiKeys).set({ revokedAt: rotatedAt })
          .where(eq(apiKeys.id, duplicate.id)).run()
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
    }
  })

  saveConfig({
    apiUrl: env.apiUrl || existingConfig?.apiUrl || `http://localhost:${process.env.CANONRY_PORT || '4100'}`,
    database: databasePath,
    apiKey: rawApiKey,
    providers: mergedProviders,
    google: mergedGoogle,
  })

  if (format === 'json') {
    console.log(JSON.stringify({
      bootstrapped: true,
      configPath: getConfigPath(),
      databasePath,
      apiUrl: env.apiUrl || existingConfig?.apiUrl || `http://localhost:${process.env.CANONRY_PORT || '4100'}`,
      providers: Object.keys(mergedProviders ?? {}),
      googleConfigured: !!mergedGoogle,
      generatedApiKey,
    }, null, 2))
    return
  }

  console.log(`Bootstrap complete. Config saved to ${getConfigPath()}`)
  console.log(`SQLite database path: ${databasePath}`)
  if (generatedApiKey) {
    console.log(`API key: ${generatedApiKey}`)
  }
}
