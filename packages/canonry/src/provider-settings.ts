import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ApiRoutesOptions } from '@canonry/canonry-api-routes'
import type { DatabaseClient } from '@canonry/canonry-db'
import {
  AppError,
  ProviderKinds,
  ProviderNames,
  forbidden,
  notFound,
  notImplemented,
  operationInProgress,
  redactUrlPrivateFields,
  validationError,
  type ProviderAdapter,
  type ProviderConnectionConfigDto,
  type ProviderSettingsUpdateRequest,
} from '@canonry/canonry-contracts'
import { loadConfig, type CanonryConfig, type ProviderConfigEntry } from './config.js'
import { buildAgentProvidersResponse, resolveApiKeySource } from './agent/providers.js'
import { providerConfigFromEntry } from './provider-batch-config.js'
import { assertProviderReloadKeepsPendingBatches } from './provider-reload-batch-guard.js'
import { configuredProviderEntries, DEFAULT_CDP_QUOTA, DEFAULT_PROVIDER_QUOTA, resolveProviderQuotaPolicy } from './provider-runtime-config.js'
import type { ProviderRegistry, RegisteredProvider } from './provider-registry.js'

type ProviderAuditContext = Parameters<NonNullable<ApiRoutesOptions['onProviderUpdate']>>[5]

interface ProviderSettingsHost {
  config: CanonryConfig
  configPath: string | undefined
  db: DatabaseClient
  registry: ProviderRegistry
  apiAdapters: readonly ProviderAdapter[]
  browserAdapter: ProviderAdapter
  executingBatches: () => readonly { runId: string; registration: RegisteredProvider }[]
  persist: (name: string, entry: ProviderConfigEntry | null) => void
  recordChange: (name: string, before: RegisteredProvider | undefined, after: RegisteredProvider | undefined, audit?: ProviderAuditContext, savedSettingsChanged?: boolean) => void
  refreshSummary: () => void
}

/** Saved connection lifecycle; provider calls and project/history mutations never belong here. */
export function createProviderSettingsController(host: ProviderSettingsHost) {
  function savedConfig(): CanonryConfig {
    if (!host.configPath || !fs.existsSync(host.configPath)) return host.config
    try {
      return loadConfig(host.configPath)
    } catch {
      // YAML exceptions can contain the credential-bearing source line.
      throw validationError('Provider configuration could not be loaded; repair config.yaml and retry.')
    }
  }

  function writable(): boolean {
    if (!host.configPath) return true
    try {
      if (fs.existsSync(host.configPath) && (fs.statSync(host.configPath).mode & 0o222) === 0) return false
      let directory = path.dirname(host.configPath)
      while (!fs.existsSync(directory)) directory = path.dirname(directory)
      fs.accessSync(directory, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  function revision(name: string, entry: ProviderConfigEntry | undefined): string {
    return crypto.createHmac('sha256', host.config.apiKey).update(JSON.stringify({ name, entry: entry ?? null })).digest('hex')
  }

  function connection(adapter: ProviderAdapter, saved: CanonryConfig): ProviderConnectionConfigDto {
    const browser = adapter.mode === 'browser'
    const entry = saved.providers?.[adapter.name]
    const current = host.registry.get(adapter.name)
    const defaults = adapter.defaultQuota ?? (browser ? DEFAULT_CDP_QUOTA : DEFAULT_PROVIDER_QUOTA)
    const quota = browser ? saved.cdp?.quota : entry?.quota
    const vertex = entry?.vertexProject
      ? { project: entry.vertexProject, region: entry.vertexRegion ?? null, credentialsConfigured: Boolean(entry.vertexCredentials) }
      : null
    const environmentFallback = resolveApiKeySource(adapter.name, {})?.source === 'env'
    const mutable = writable() && !browser
    const answerService = adapter.kind === ProviderKinds['answer-service']
    const blockers: ProviderConnectionConfigDto['blockers'] = []
    const addBlocker = (code: string, message: string): void => { blockers.push({ code, message, runIds: [], batchIds: [] }) }
    if (!writable()) addBlocker('read-only-config', 'This deployment manages a read-only configuration file. Change provider settings on the host.')
    if (browser) addBlocker('browser-managed', 'Browser connection settings are managed through the browser setup controls.')
    if (vertex) addBlocker('vertex-managed', 'Vertex authentication is managed on the host. Model and quota overrides can still be edited here.')
    if (environmentFallback) addBlocker('environment-credential', 'An environment credential would remain available to Aero after removing the saved key. Remove it on the host before disconnecting.')

    let baseUrl = browser ? current?.config.cdpEndpoint ?? null : entry?.baseUrl ?? null
    let endpointEditable = true
    if (baseUrl) {
      const endpoint = redactUrlPrivateFields(baseUrl)
      endpointEditable = endpoint !== null && !endpoint.redacted
      if (!endpointEditable) {
        baseUrl = null
        addBlocker('private-endpoint', 'The saved endpoint contains private URL fields or is not a URL. Manage that endpoint on the host.')
      }
    }
    try {
      assertProviderReloadKeepsPendingBatches(host.db, current ? [current] : [], [], host.executingBatches().filter(item => item.registration.adapter.name === adapter.name))
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
      blockers.push({ code: 'outstanding-batches', message: error.message, runIds: strings(error.details?.runIds), batchIds: strings(error.details?.batchIds) })
    }
    const hostUses: string[] = []
    if (buildAgentProvidersResponse(host.config).defaultProvider === adapter.name) hostUses.push('Aero default provider')
    if (host.config.sentiment?.provider === adapter.name) hostUses.push('Sentiment evaluation')
    if (host.config.classification?.provider === adapter.name) hostUses.push('Answer classification')

    return {
      name: adapter.name,
      displayName: adapter.displayName,
      kind: adapter.kind ?? ProviderKinds['answer-engine'],
      mode: adapter.mode,
      configured: Boolean(current),
      revision: revision(adapter.name, browser ? undefined : entry),
      apiKeyConfigured: Boolean(entry?.apiKey),
      baseUrl,
      model: entry?.model ?? null,
      defaultModel: adapter.modelRegistry.defaultModel || null,
      effectiveModel: current?.config.model ?? (current ? adapter.modelRegistry.defaultModel || null : null),
      quota: { defaults: { ...defaults }, overrides: { ...quota }, effective: current?.config.quotaPolicy ?? resolveProviderQuotaPolicy(quota, defaults) },
      capabilities: {
        apiKey: mutable && !vertex,
        clearApiKey: mutable && adapter.name === ProviderNames.local,
        baseUrl: mutable && !answerService && !vertex && endpointEditable,
        resetBaseUrl: mutable && !answerService && !vertex && endpointEditable && adapter.name !== ProviderNames.local,
        model: mutable && !answerService,
        quota: mutable,
        disconnect: mutable && !vertex && !environmentFallback,
        reload: Boolean(host.configPath),
      },
      hostManaged: { vertex, batch: entry?.batch ?? null, pricing: entry?.pricing ?? null },
      hostUses,
      blockers,
    }
  }

  function connections(): ProviderConnectionConfigDto[] {
    const saved = savedConfig()
    return [...host.apiAdapters, host.browserAdapter].map(adapter => connection(adapter, saved))
  }

  function prepare(name: string, expectedRevision?: string) {
    if (name === host.browserAdapter.name) throw notImplemented('Browser connection settings use /settings/cdp and the browser setup controls.')
    const adapter = host.apiAdapters.find(item => item.name === name)
    if (!adapter) throw notFound('Provider connection', name)
    const saved = savedConfig()
    const metadata = connection(adapter, saved)
    if (expectedRevision !== undefined && metadata.revision !== expectedRevision) {
      throw operationInProgress('Provider settings changed. Read the connection again before saving.', { reason: 'provider-settings-changed' })
    }
    if (!writable()) throw forbidden('Provider configuration is managed by this deployment and cannot be edited here.')
    return { adapter, saved, metadata }
  }

  function commit(adapter: ProviderAdapter, entry: ProviderConfigEntry | null, saved: CanonryConfig, audit?: ProviderAuditContext): void {
    const name = adapter.name
    const nextConfig = { ...host.config, providers: { ...host.config.providers } }
    if (entry === null) delete nextConfig.providers[name]
    else nextConfig.providers[name] = entry
    const next = configuredProviderEntries(nextConfig, host.apiAdapters, host.browserAdapter)
    assertProviderReloadKeepsPendingBatches(host.db, host.registry.getAll(), next, host.executingBatches())
    const previousEntry = saved.providers?.[name]
    const previous = host.registry.get(name) ?? (previousEntry ? {
      adapter,
      config: providerConfigFromEntry(name, previousEntry, resolveProviderQuotaPolicy(previousEntry.quota, adapter.defaultQuota ?? DEFAULT_PROVIDER_QUOTA)),
    } : undefined)
    host.db.transaction(() => {
      host.recordChange(name, previous, next.find(item => item.adapter.name === name), audit, JSON.stringify(previousEntry) !== JSON.stringify(entry ?? undefined))
      host.persist(name, entry)
    })
    host.config.providers = nextConfig.providers
    if (name === ProviderNames.gemini) {
      delete host.config.geminiApiKey
      delete host.config.geminiModel
      delete host.config.geminiQuota
    }
    host.registry.replace(next)
    host.refreshSummary()
  }

  function update(name: string, input: ProviderSettingsUpdateRequest, audit?: ProviderAuditContext): void {
    const { adapter, saved, metadata } = prepare(name, input.expectedRevision)
    const { capabilities } = metadata
    if ((input.apiKey !== undefined && !capabilities.apiKey) || (input.reset?.apiKey && !capabilities.clearApiKey)) throw forbidden('This connection does not allow API-key changes here.')
    if (input.baseUrl !== undefined && !capabilities.baseUrl) throw forbidden('This connection does not allow endpoint changes here.')
    if (input.reset?.baseUrl && !capabilities.resetBaseUrl) throw forbidden('This connection does not allow resetting its endpoint here.')
    if ((input.model !== undefined || input.reset?.model) && !capabilities.model) throw forbidden('This connection does not allow a connection model override.')
    const next: ProviderConfigEntry = { ...saved.providers?.[name] }
    if (input.apiKey !== undefined) next.apiKey = input.apiKey
    if (input.baseUrl !== undefined) next.baseUrl = input.baseUrl
    if (input.model !== undefined) next.model = input.model
    if (input.quota !== undefined) next.quota = { ...next.quota, ...input.quota }
    if (input.reset?.apiKey) delete next.apiKey
    if (input.reset?.baseUrl) delete next.baseUrl
    if (input.reset?.model) delete next.model
    if (input.reset?.quota) {
      const quota = { ...next.quota }
      for (const field of input.reset.quota) delete quota[field]
      if (Object.keys(quota).length > 0) next.quota = quota
      else delete next.quota
    }
    commit(adapter, next, saved, audit)
  }

  function disconnect(name: string, expectedRevision?: string, audit?: ProviderAuditContext): void {
    const { adapter, metadata, saved } = prepare(name, expectedRevision)
    if (!metadata.capabilities.disconnect) throw forbidden('This connection has host-managed credentials. Disconnect it on the host.')
    commit(adapter, null, saved, audit)
  }

  return { connections, update, disconnect }
}
