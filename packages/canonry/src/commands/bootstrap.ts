import crypto from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { eq } from 'drizzle-orm'
import { getBootstrapEnv, withBootstrapProviderDefaults, type BootstrapProviderName } from '@ainyc/canonry-config'
import { ProviderNames, ProviderReloadErrorReasons } from '@ainyc/canonry-contracts'
import { createClient, migrate, apiKeys, dashboardSessions } from '@ainyc/canonry-db'

import { configExists, getConfigDir, getConfigPath, loadConfig, loadConfigRaw, saveConfig, type ProviderConfigEntry } from '../config.js'
import { CliError, isEndpointMissing, isMachineFormat, systemError, type CliFormat } from '../cli-error.js'
import { createApiClient } from '../client.js'
import { isLoopbackBindHost } from '../server.js'
import { registeredProviderNames } from '../provider-registration.js'
import { trackCliConnection } from '../cli-connection-telemetry.js'
import { outcomeFailure } from '../outcome-telemetry.js'

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

/**
 * The fields that select and authenticate a provider's account. An env entry
 * replaces them as one unit, so switching auth modes through the env never
 * leaves the old mode behind (a saved Vertex project would otherwise win over
 * a new GEMINI_API_KEY). Every other saved field (model, quota, endpoint,
 * batch, pricing) stays unless the env sets it.
 */
const PROVIDER_CREDENTIAL_FIELDS: Partial<Record<BootstrapProviderName, readonly string[]>> = {
  [ProviderNames.gemini]: ['apiKey', 'vertexProject', 'vertexRegion', 'vertexCredentials'],
  // A local key belongs to the server at its base URL.
  [ProviderNames.local]: ['baseUrl', 'apiKey'],
}
const API_KEY_CREDENTIAL_FIELDS: readonly string[] = ['apiKey']

/** One provider's saved entry with the env's settings applied; a new entry takes the setup defaults. */
function mergeEnvProvider(name: BootstrapProviderName, saved: ProviderConfigEntry | null | undefined, fromEnv: object): ProviderConfigEntry {
  const credentialFields = PROVIDER_CREDENTIAL_FIELDS[name] ?? API_KEY_CREDENTIAL_FIELDS
  const envFields = Object.entries(fromEnv)
  const envValues = new Map(envFields)
  const merged: Record<string, unknown> = {}
  // Saved fields keep their order; env values win, and a credential the env
  // did not set is dropped with the rest of the saved credential set.
  for (const [field, value] of Object.entries(saved ?? {})) {
    if (envValues.get(field) !== undefined) merged[field] = envValues.get(field)
    else if (!credentialFields.includes(field)) merged[field] = value
  }
  // Fields the saved entry lacks follow in the reader's order. An unset one
  // only holds its place: YAML and the change check both ignore undefined.
  for (const [field, value] of envFields) {
    if (!(field in merged)) merged[field] = value
  }
  return withBootstrapProviderDefaults(name, merged as ProviderConfigEntry)
}

/** `serverReload.status` in the JSON output. */
const ServerReloadStatuses = {
  reloaded: 'reloaded',
  unchanged: 'unchanged',
  unavailable: 'unavailable',
  'not-local': 'not-local',
  'not-matching': 'not-matching',
  failed: 'failed',
} as const

/** `serverReload.reason` when a reachable local server did not take the reload. */
const NotMatchingReasons = {
  'other-install': 'other-install',
  'reload-unsupported': 'reload-unsupported',
} as const
type NotMatchingReason = typeof NotMatchingReasons[keyof typeof NotMatchingReasons]

type ServerReload =
  | { status: typeof ServerReloadStatuses.reloaded; providers: string[] }
  | { status: typeof ServerReloadStatuses.unchanged | typeof ServerReloadStatuses.unavailable | typeof ServerReloadStatuses['not-local'] }
  | { status: typeof ServerReloadStatuses['not-matching']; reason: NotMatchingReason; code: string }
  | { status: typeof ServerReloadStatuses.failed; code: string }

/**
 * Answers that mean the server on this URL is not this install's (it refused
 * this install's key, or runs another config or database), or that it cannot
 * reload at all (no reload route, or a host without reload support). Neither
 * is a failure of this install: its providers were saved.
 */
function notMatchingReason(err: CliError): NotMatchingReason | undefined {
  const status = err.details?.httpStatus
  if (status === 401 || status === 403) return NotMatchingReasons['other-install']
  if (err.details?.reason === ProviderReloadErrorReasons['install-identity-mismatch']) return NotMatchingReasons['other-install']
  if (isEndpointMissing(err) || status === 501) return NotMatchingReasons['reload-unsupported']
  return undefined
}

/** What happened to the reload and how to apply the saved providers, one line each. */
function notMatchingLines(reason: NotMatchingReason, serverUrl: string): [string, string] {
  switch (reason) {
    case NotMatchingReasons['other-install']:
      return [
        `The server at ${serverUrl} is not this install's server, so it was not reloaded.`,
        'To apply the saved providers, run `canonry settings reload-providers` against this install\'s server, or restart that server.',
      ]
    case NotMatchingReasons['reload-unsupported']:
      return [
        `The server at ${serverUrl} cannot reload providers: it is too old or does not support reload.`,
        'Restart this install\'s server to apply the saved providers.',
      ]
  }
}

export async function bootstrapCommand(opts?: { format?: CliFormat }): Promise<void> {
  const format = opts?.format ?? 'text'
  const configDir = getConfigDir()
  const existing = configExists()
  const existingConfig = existing ? loadConfig() : undefined
  const existingRaw = existing ? loadConfigRaw() : null
  const env = getBootstrapEnv(process.env)
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

  // Merge providers: an env entry replaces that provider's credentials and any
  // field the env sets; providers the env does not name stay as configured.
  const mergedProviders: Record<string, ProviderConfigEntry> = { ...existingConfig?.providers }
  for (const [name, fromEnv] of Object.entries(env.providers) as [BootstrapProviderName, object | undefined][]) {
    if (fromEnv) mergedProviders[name] = mergeEnvProvider(name, mergedProviders[name], fromEnv)
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
  const providersChanged = !isDeepStrictEqual(persistedValue(existingRaw?.providers ?? {}), persistedValue(mergedProviders))
  const configChanged = !existingRaw
    || existingRaw.apiUrl !== apiUrl
    || existingRaw.database !== databasePath
    || existingRaw.apiKey !== rawApiKey
    || providersChanged
    || !isDeepStrictEqual(persistedValue(existingRaw.google), persistedValue(mergedGoogle))
  // A provider the environment set or changed is a connection; a rerun with the same keys is not.
  const providerConnections = (Object.keys(env.providers) as BootstrapProviderName[])
    .filter(name => env.providers[name] && !isDeepStrictEqual(persistedValue(existingRaw?.providers?.[name]), persistedValue(mergedProviders[name])))
    .map(name => ({ integration: 'provider' as const, provider: name, action: existingRaw?.providers?.[name] ? 'reauth' as const : 'connect' as const }))
  if (configChanged) {
    try {
      saveConfig(nextConfig)
    } catch (err) {
      for (const connection of providerConnections) trackCliConnection({ ...connection, status: 'failed', ...outcomeFailure(err) })
      throw err
    }
  }
  for (const connection of providerConnections) trackCliConnection({ ...connection, status: 'succeeded' })

  const status = !existing ? 'created' : configChanged || keyChanged ? 'updated' : 'unchanged'
  const providerFree = registeredProviderNames(nextConfig).length === 0
  const serverUrl = loadConfig().apiUrl
  let serverReload: ServerReload
  let reloadFailure: CliError | undefined
  if (!isLoopbackBindHost(new URL(serverUrl).hostname)) {
    serverReload = { status: ServerReloadStatuses['not-local'] }
  } else if (!providersChanged) {
    // The saved providers are what they were, so a rerun asks nothing of the server.
    serverReload = { status: ServerReloadStatuses.unchanged }
  } else {
    const signal = AbortSignal.timeout(4000)
    try {
      const receipt = await createApiClient().reloadProviders({ configPath: getConfigPath(), databasePath }, signal)
      serverReload = {
        status: ServerReloadStatuses.reloaded,
        providers: receipt.providers.filter(provider => provider.configured).map(provider => provider.name),
      }
    } catch (err) {
      const reason = err instanceof CliError ? notMatchingReason(err) : undefined
      if (err instanceof CliError && err.code === 'CONNECTION_ERROR' && err.details?.connectionUnavailable === true && !signal.aborted) {
        serverReload = { status: ServerReloadStatuses.unavailable }
      } else if (err instanceof CliError && reason) {
        serverReload = { status: ServerReloadStatuses['not-matching'], reason, code: err.code }
      } else {
        reloadFailure = err instanceof CliError ? err : systemError('Provider configuration was saved, but server reload failed.')
        serverReload = { status: ServerReloadStatuses.failed, code: reloadFailure.code }
      }
    }
  }
  const reloadSteps = (() => {
    switch (serverReload.status) {
      case ServerReloadStatuses.unavailable:
        return ['Start `canonry serve` to use the saved configuration.']
      case ServerReloadStatuses.failed:
        return ['Resolve the server reload error, then run `canonry settings reload-providers`.']
      case ServerReloadStatuses['not-matching']:
        return [notMatchingLines(serverReload.reason, serverUrl).join(' ')]
      case ServerReloadStatuses.reloaded:
      case ServerReloadStatuses.unchanged:
      case ServerReloadStatuses['not-local']:
        return []
    }
  })()
  const nextSteps = [...(providerFree ? PROVIDER_FREE_NEXT_STEPS : []), ...reloadSteps]

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
  switch (serverReload.status) {
    case ServerReloadStatuses.reloaded:
      console.log(`Providers active on the running server: ${serverReload.providers.join(', ') || 'none'}.`)
      break
    case ServerReloadStatuses.unavailable:
      console.log('Start `canonry serve` to use the saved configuration.')
      break
    case ServerReloadStatuses['not-local']:
      console.log('Configuration saved locally. The configured remote server was not reloaded.')
      break
    case ServerReloadStatuses['not-matching']:
      for (const line of notMatchingLines(serverReload.reason, serverUrl)) console.log(line)
      break
    case ServerReloadStatuses.unchanged:
      // A first run has no earlier settings to compare, so it says nothing here.
      if (existing) console.log('Provider settings unchanged, so the server was not reloaded.')
      break
    case ServerReloadStatuses.failed:
      // The thrown reload error below is the report.
      break
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
