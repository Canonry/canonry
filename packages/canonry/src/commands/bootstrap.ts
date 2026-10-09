import crypto from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { eq } from 'drizzle-orm'
import { getBootstrapEnv } from '@ainyc/canonry-config'
import { createClient, migrate, apiKeys, dashboardSessions } from '@ainyc/canonry-db'

import { configExists, getConfigDir, getConfigPath, loadConfig, loadConfigRaw, saveConfig } from '../config.js'
import { CliError, isMachineFormat, systemError, type CliFormat } from '../cli-error.js'
import { createApiClient } from '../client.js'
import { isLoopbackBindHost } from '../server.js'
import { registeredProviderNames } from '../provider-registration.js'

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
 * with the credential kept out of the agent's hands. Bootstrap reloads the
 * matching local server after saving; the settings command registers live.
 */
const PROVIDER_FREE_NEXT_STEPS: readonly string[] = [
  'AI Visibility needs an answer-engine provider. Page Health does not.',
  'With the server running, the operator runs `canonry settings provider gemini --api-key <key>` '
    + '(free key at https://aistudio.google.com/apikey). It takes effect immediately.',
  'Or the operator sets GEMINI_API_KEY and reruns `canonry bootstrap`. It reloads the matching running local server '
    + 'and confirms active providers; an offline server uses the saved settings at startup.',
  'A provider key is the operator\'s credential: never ask for it in chat.',
]

export async function bootstrapCommand(opts?: { format?: CliFormat }): Promise<void> {
  const format = opts?.format ?? 'text'
  const configDir = getConfigDir()
  const existing = configExists()
  const existingConfig = existing ? loadConfig() : undefined
  const existingRaw = existing ? loadConfigRaw() : null
  const env = getBootstrapEnv(process.env, {
    GEMINI_MODEL: process.env.GEMINI_MODEL ?? existingConfig?.providers?.gemini?.model,
    OPENAI_MODEL: process.env.OPENAI_MODEL ?? existingConfig?.providers?.openai?.model,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? existingConfig?.providers?.claude?.model,
    PERPLEXITY_MODEL: process.env.PERPLEXITY_MODEL ?? existingConfig?.providers?.perplexity?.model,
    MUSE_MODEL: process.env.MUSE_MODEL ?? existingConfig?.providers?.muse?.model,
    LOCAL_MODEL: process.env.LOCAL_MODEL ?? existingConfig?.providers?.local?.model,
  })
  const providers = env.providers
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
  for (const [name, provider] of Object.entries(providers)) {
    const stored = mergedProviders[name]
    mergedProviders[name] = {
      ...stored,
      ...Object.fromEntries(Object.entries(provider).filter(([, value]) => value !== undefined)),
      quota: stored?.quota ?? provider.quota,
    }
  }

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
  const providerFree = registeredProviderNames(nextConfig).length === 0
  let serverReload: {
    status: 'reloaded' | 'unavailable' | 'not-local' | 'failed'
    providers?: string[]
    code?: string
  } = { status: 'not-local' }
  let reloadFailure: CliError | undefined
  if (isLoopbackBindHost(new URL(loadConfig().apiUrl).hostname)) {
    const signal = AbortSignal.timeout(4000)
    try {
      const receipt = await createApiClient().reloadProviders({ configPath: getConfigPath(), databasePath }, signal)
      serverReload = {
        status: 'reloaded',
        providers: receipt.providers.filter(provider => provider.configured).map(provider => provider.name),
      }
    } catch (err) {
      if (err instanceof CliError && err.code === 'CONNECTION_ERROR' && err.details?.connectionUnavailable === true && !signal.aborted) {
        serverReload = { status: 'unavailable' }
      } else {
        reloadFailure = err instanceof CliError ? err : systemError('Provider configuration was saved, but server reload failed.')
        serverReload = { status: 'failed', code: reloadFailure.code }
      }
    }
  }
  const nextSteps = [
    ...(providerFree ? PROVIDER_FREE_NEXT_STEPS : []),
    ...(serverReload.status === 'unavailable' ? ['Start `canonry serve` to use the saved configuration.'] : []),
    ...(serverReload.status === 'failed' ? ['Resolve the server reload error, then run `canonry settings reload-providers`.'] : []),
  ]

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
      serverReload,
      nextSteps,
    }, null, 2))
    if (reloadFailure) throw reloadFailure
    return
  }

  console.log(`Bootstrap ${status}. Config: ${getConfigPath()}`)
  console.log(`SQLite database path: ${databasePath}`)
  if (serverReload.status === 'reloaded') {
    console.log(`Providers active on the running server: ${serverReload.providers?.join(', ') || 'none'}.`)
  } else if (serverReload.status === 'unavailable') {
    console.log('Start `canonry serve` to use the saved configuration.')
  } else if (serverReload.status === 'not-local') {
    console.log('Configuration saved locally. The configured remote server was not reloaded.')
  }
  if (providerFree) {
    console.log('Providers: none (Page Health works now; add one later to enable AI Visibility).')
    console.log('  To add one with the server running: canonry settings provider gemini --api-key <key>')
    console.log('  (free key at aistudio.google.com). Or set GEMINI_API_KEY and rerun `canonry bootstrap`;')
    console.log('  bootstrap reloads the matching running local server and confirms active providers.')
  }
  if (generatedApiKey) {
    // Say what it is for. This is the only place the key appears, and without
    // a purpose it reads as a second credential competing with the dashboard
    // password the operator is about to be asked for.
    console.log(`API key (for the CLI, MCP, and agents): ${generatedApiKey}`)
  }
  if (reloadFailure) throw reloadFailure
}
