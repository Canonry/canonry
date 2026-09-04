import type { FastifyInstance } from 'fastify'
import type {
  EngineConnectionInput,
  EngineConnectionModelCatalogResponse,
  EngineConnectionPublicDto,
  EngineConnectionUpsertInput,
  EngineRouteConfig,
  EngineRouteUpsertInput,
  ProviderModelRegistry,
  ProviderQuotaPolicy,
} from '@ainyc/canonry-contracts'
import {
  buildEngineRouteSummaryDto,
  engineConnectionEndpointChanged,
  engineConnectionInputSchema,
  engineConnectionModelCatalogResponseSchema,
  engineConnectionUpsertInputSchema,
  engineRouteConfigSchema,
  engineRouteSummaryResponseSchema,
  engineRouteUpsertInputSchema,
  nextEngineRouteRevision,
  validationError,
  notImplemented,
  internalError,
} from '@ainyc/canonry-contracts'
import { requireAdminSession, requirePaidReadScope, requireScope } from './auth.js'

/**
 * Scope required to mutate any global setting — provider API keys,
 * Google OAuth client credentials, Bing API key, CDP endpoint.
 *
 * Without this gate any caller with any valid bearer token could swap the
 * operator's OpenAI/Anthropic/Gemini/Perplexity keys for an attacker's
 * (siphoning quota), or swap the Google OAuth client secret to harvest
 * future OAuth grants. The default key written by `canonry init` carries
 * `scopes: ['*']` which satisfies this gate by wildcard; future
 * delegate-key flows must opt in explicitly.
 */
export const SETTINGS_WRITE_SCOPE = 'settings.write'

export interface ProviderSummaryEntry {
  name: string
  displayName?: string
  keyUrl?: string
  modelHint?: string
  model?: string
  /** The adapter's built-in default model (used when `model` is unset). */
  defaultModel?: string
  configured: boolean
  quota?: ProviderQuotaPolicy
  /** Whether Vertex AI is configured for this provider (Gemini only) */
  vertexConfigured?: boolean
}

export interface GoogleSettingsSummary {
  configured: boolean
}

export interface BingSettingsSummary {
  configured: boolean
}

export interface ProviderAdapterInfo {
  name: string
  displayName: string
  mode: 'api' | 'browser'
  /** Browser/detected models are visible but cannot be overridden per project. */
  modelConfigurable: boolean
  defaultModel: string
  knownModels: ProviderModelRegistry['knownModels']
  modelValidationPattern: RegExp
  modelValidationHint: string
}

export interface SettingsRoutesOptions {
  providerSummary?: ProviderSummaryEntry[]
  /** Adapter metadata for validation — keyed by provider name */
  providerAdapters?: ProviderAdapterInfo[]
  onProviderUpdate?: (provider: string, apiKey: string, model?: string, baseUrl?: string, quota?: Partial<ProviderQuotaPolicy>) => ProviderSummaryEntry | null
  google?: GoogleSettingsSummary
  onGoogleUpdate?: (clientId: string, clientSecret: string) => GoogleSettingsSummary | null
  bing?: BingSettingsSummary
  onBingUpdate?: (apiKey: string) => BingSettingsSummary | null
  /** Credential-redacted generic gateway connections. May be a live resolver. */
  engineConnections?: readonly EngineConnectionPublicDto[] | (() => readonly EngineConnectionPublicDto[])
  /** Stable route records. May be a live resolver. */
  engineRoutes?: readonly EngineRouteConfig[] | (() => readonly EngineRouteConfig[])
  onEngineConnectionUpsert?: (input: EngineConnectionInput, body: EngineConnectionUpsertInput) => EngineConnectionPublicDto | null
  onEngineRouteUpsert?: (route: EngineRouteConfig, input: EngineRouteUpsertInput) => EngineRouteConfig | null
  /**
   * Host-owned, non-inference GET /models reader. It receives only the stable
   * id so the route layer never sees a credential; unavailable is a typed
   * manual-entry fallback rather than a leaked upstream error body.
   */
  getEngineConnectionModelCatalog?: (connectionId: string) => Promise<EngineConnectionModelCatalogResponse> | EngineConnectionModelCatalogResponse
}

function resolveSettingList<T>(value: readonly T[] | (() => readonly T[]) | undefined): readonly T[] {
  return typeof value === 'function' ? value() : value ?? []
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions) {
  // A small safe route catalog is deliberately separate from GET /settings:
  // viewers and project-scoped keys may choose/describe routes without seeing
  // connection ids, endpoint URLs, credential state, or provider settings.
  app.get('/settings/engine-routes', async () => {
    const connectionIds = new Set(resolveSettingList(opts.engineConnections).map(connection => connection.id))
    return engineRouteSummaryResponseSchema.parse({
      routes: resolveSettingList(opts.engineRoutes)
        // Configured gateway routes depend on a configured connection. Native
        // and server-owned verified routes use a host-owned adapter instead,
        // so treating their virtual `native:*` connection id as missing would
        // incorrectly hide a healthy built-in provider.
        .map(route => buildEngineRouteSummaryDto(route, {
          connectionAvailable: route.source === 'configured'
            ? connectionIds.has(route.connectionId)
            : undefined,
        }))
        .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)),
    })
  })

  // Settings describe which credentials this install holds and where its
  // providers point. That is administrator territory even to read, so a
  // view-only account is refused here at the server rather than merely being
  // shown no link to it.
  app.get('/settings', async (request) => {
    requireAdminSession(request)
    return {
      providers: opts.providerSummary ?? [],
      providerCatalog: (opts.providerAdapters ?? []).map(adapter => ({
        name: adapter.name,
        displayName: adapter.displayName,
        mode: adapter.mode,
        modelConfigurable: adapter.modelConfigurable,
        defaultModel: adapter.defaultModel,
        knownModels: adapter.knownModels,
        modelValidationPattern: {
          source: adapter.modelValidationPattern.source,
          flags: adapter.modelValidationPattern.flags,
        },
        modelValidationHint: adapter.modelValidationHint,
      })),
      google: opts.google ?? { configured: false },
      bing: opts.bing ?? { configured: false },
      engineConnections: resolveSettingList(opts.engineConnections),
      engineRoutes: resolveSettingList(opts.engineRoutes),
    }
  })

  app.put<{
    Params: { id: string }
    Body: unknown
  }>('/settings/engine-connections/:id', async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw validationError('Invalid engine connection configuration')
    }
    const parsed = engineConnectionUpsertInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid engine connection configuration', { issues: parsed.error.issues })
    if (!opts.onEngineConnectionUpsert) {
      throw notImplemented('Engine connection configuration updates are not supported in this deployment')
    }
    const input = engineConnectionInputSchema.parse({ ...parsed.data, id: request.params.id })
    const existing = resolveSettingList(opts.engineConnections).find(connection => connection.id === input.id)
    if (existing?.secretConfigured && input.apiKey === undefined && engineConnectionEndpointChanged(existing, input)) {
      throw validationError(
        'Changing an engine connection endpoint requires an explicit apiKey; the existing credential is not forwarded to a different endpoint.',
      )
    }
    const result = opts.onEngineConnectionUpsert(input, parsed.data)
    if (!result) throw internalError('Failed to update engine connection configuration')
    return result
  })

  app.put<{
    Params: { id: string }
    Body: unknown
  }>('/settings/engine-routes/:id', async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw validationError('Invalid engine route configuration')
    }
    const parsed = engineRouteUpsertInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid engine route configuration', { issues: parsed.error.issues })
    const input = parsed.data
    // Generic routes live in their own namespace. This prevents a settings
    // caller from replacing a native adapter by choosing e.g. `openai` or
    // `native:openai` as the path id.
    if (!/^route:[a-zA-Z0-9]/.test(request.params.id)) {
      throw validationError('Generic engine route ids must use the server-reserved "route:" prefix.')
    }
    const knownConnection = resolveSettingList(opts.engineConnections).some(connection => connection.id === input.connectionId)
    if (!knownConnection) throw validationError(`Unknown engine connection: ${input.connectionId}`)
    const existing = resolveSettingList(opts.engineRoutes).find(route => route.id === request.params.id)
    if (existing && existing.source !== 'configured') {
      throw validationError('Implicit and verified engine routes are server-owned and cannot be edited through settings.')
    }
    const draft = engineRouteConfigSchema.parse({
      id: request.params.id,
      label: input.label,
      connectionId: input.connectionId,
      modelId: input.modelId,
      revision: existing?.revision ?? 1,
      source: 'configured',
      capabilities: { kind: 'text-only' },
    })
    const route = existing
      ? { ...draft, revision: nextEngineRouteRevision(existing, draft) }
      : draft
    if (!opts.onEngineRouteUpsert) {
      throw notImplemented('Engine route configuration updates are not supported in this deployment')
    }
    const result = opts.onEngineRouteUpsert(route, input)
    if (!result) throw internalError('Failed to update engine route configuration')
    return result
  })

  app.get<{
    Params: { id: string }
  }>('/settings/engine-connections/:id/models', async (request) => {
    // The model catalog is a live request authenticated with an
    // instance-global credential. It never starts inference, but it must not
    // become a read-only/viewer side channel or an unscoped key's gateway probe.
    requireAdminSession(request)
    requirePaidReadScope(request)
    requireScope(request, SETTINGS_WRITE_SCOPE)
    const known = resolveSettingList(opts.engineConnections).some(connection => connection.id === request.params.id)
    if (!known) throw validationError(`Unknown engine connection: ${request.params.id}`)
    if (!opts.getEngineConnectionModelCatalog) {
      throw notImplemented('Engine connection model catalog reads are not supported in this deployment')
    }
    const result = await opts.getEngineConnectionModelCatalog(request.params.id)
    return engineConnectionModelCatalogResponseSchema.parse(result)
  })

  app.put<{
    Params: { name: string }
    Body: { apiKey?: string; baseUrl?: string; model?: string; quota?: Partial<ProviderQuotaPolicy> }
  }>('/settings/providers/:name', async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    const { apiKey, baseUrl, model, quota } = request.body ?? {}
    const name = request.params.name

    const adapters = opts.providerAdapters ?? []
    const apiAdapters = adapters.filter(a => a.mode === 'api')
    const adapterInfo = apiAdapters.find(a => a.name === name)
    if (!adapterInfo) {
      const validNames = apiAdapters.map(a => a.name)
      throw validationError(`Invalid provider: ${name}. Must be one of: ${validNames.join(', ')}`, {
        provider: name,
        validProviders: validNames,
      })
    }

    if (name === 'local') {
      if (!baseUrl || typeof baseUrl !== 'string') {
        throw validationError('baseUrl is required for local provider')
      }
    } else if (name === 'gemini' && !apiKey) {
      const geminiSummary = (opts.providerSummary ?? []).find(p => p.name === 'gemini')
      if (!geminiSummary?.vertexConfigured) {
        throw validationError(
          'apiKey is required for Gemini unless Vertex AI is configured ' +
          '(set GEMINI_VERTEX_PROJECT env var or vertexProject in config file)',
        )
      }
    } else {
      if (!apiKey || typeof apiKey !== 'string') {
        throw validationError('apiKey is required')
      }
    }

    if (model !== undefined) {
      if (!adapterInfo.modelValidationPattern.test(model)) {
        throw validationError(
          `Invalid model "${model}" for provider "${name}" — ${adapterInfo.modelValidationHint}`,
        )
      }
    }

    if (!opts.onProviderUpdate) {
      throw notImplemented('Provider configuration updates are not supported in this deployment')
    }

    if (quota !== undefined) {
      if (typeof quota !== 'object' || quota === null) {
        throw validationError('quota must be an object')
      }
      for (const [key, val] of Object.entries(quota)) {
        if (!['maxConcurrency', 'maxRequestsPerMinute', 'maxRequestsPerDay'].includes(key)) {
          throw validationError(`Unknown quota field: ${key}`)
        }
        if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
          throw validationError(`${key} must be a positive integer`)
        }
      }
    }

    const result = opts.onProviderUpdate(name, apiKey ?? '', model, baseUrl, quota)
    if (!result) {
      throw internalError('Failed to update provider configuration')
    }

    return result
  })

  app.put<{
    Body: { clientId?: string; clientSecret?: string }
  }>('/settings/google', async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    const { clientId, clientSecret } = request.body ?? {}

    if (!clientId || typeof clientId !== 'string' || !clientSecret || typeof clientSecret !== 'string') {
      throw validationError('clientId and clientSecret are required')
    }

    if (!opts.onGoogleUpdate) {
      throw notImplemented('Google OAuth configuration updates are not supported in this deployment')
    }

    const result = opts.onGoogleUpdate(clientId, clientSecret)
    if (!result) {
      throw internalError('Failed to update Google OAuth configuration')
    }

    return result
  })

  app.put<{
    Body: { apiKey?: string }
  }>('/settings/bing', async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    const { apiKey } = request.body ?? {}

    if (!apiKey || typeof apiKey !== 'string') {
      throw validationError('apiKey is required')
    }

    if (!opts.onBingUpdate) {
      throw notImplemented('Bing configuration updates are not supported in this deployment')
    }

    const result = opts.onBingUpdate(apiKey)
    if (!result) {
      throw internalError('Failed to update Bing configuration')
    }

    return result
  })
}
