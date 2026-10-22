import type { FastifyInstance } from 'fastify'
import type {
  AnswerServiceProfileSummary,
  ProviderCapabilities,
  ProviderCatalogEntryDto,
  ProviderKeyCheck,
  ProviderKind,
  ProviderModelRegistry,
  ProviderQuotaPolicy,
  ProviderReloadRequest,
  ProviderRouteFamily,
  ProviderSettingsField,
} from '@canonry/canonry-contracts'
import {
  AppError,
  validationError,
  notImplemented,
  internalError,
  OutcomeReasonCodes,
  OutcomeStatuses,
  providerReloadRequestSchema,
  providerReloadResponseDtoSchema,
  ProviderKinds,
  providerRouteName,
  routeFamiliesOf,
} from '@canonry/canonry-contracts'
import { requireAdminSession, requireInstanceAdministrator, requireScope } from './auth.js'
import { auditFromRequest, type AuditEntry } from './helpers.js'
import { connectionRoute, outcomeProviderName } from './connection-telemetry.js'
import { withFeatureOutcome } from './feature-outcome.js'
import { providerAdapterForName } from './provider-models.js'

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
  /** Absent means an answer engine. */
  kind?: ProviderKind
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
  /** Absent means an answer engine. */
  kind?: ProviderKind
  capabilities?: ProviderCapabilities
  /** The route family a connection serves; its bare name is then never a target. */
  routes?: ProviderRouteFamily
  /** Answer-service profiles, from the service descriptor. */
  profiles?: AnswerServiceProfileSummary[]
  settingsFields?: ProviderSettingsField[]
  keyCheck?: ProviderKeyCheck
  keyUrl?: string
  vendorDocsUrl?: string
}

/**
 * The catalog fields an adapter description adds beyond the model registry.
 * Only adapters that declare them gain them, so every answer engine's catalog
 * entry keeps its exact shape.
 */
function descriptorFields(adapter: ProviderAdapterInfo): Partial<ProviderCatalogEntryDto> {
  if (!adapter.kind && !adapter.routes && !adapter.profiles) return {}
  return {
    ...(adapter.kind ? { kind: adapter.kind } : {}),
    connection: adapter.routes?.connection ?? adapter.name,
    selectionKind: adapter.routes?.selectionKind ?? null,
    ...(adapter.profiles ? { profiles: adapter.profiles } : {}),
    ...(adapter.capabilities?.workflows ? { workflows: [...adapter.capabilities.workflows] } : {}),
    ...(adapter.capabilities ? { textGeneration: adapter.capabilities.textGeneration } : {}),
    ...(adapter.settingsFields ? { settingsFields: adapter.settingsFields } : {}),
    ...(adapter.keyCheck ? { keyCheck: adapter.keyCheck } : {}),
    ...(adapter.keyUrl ? { keyUrl: adapter.keyUrl } : {}),
    ...(adapter.vendorDocsUrl ? { vendorDocsUrl: adapter.vendorDocsUrl } : {}),
  }
}

export interface SettingsRoutesOptions {
  /** Cached, credential-free model metadata supplied by the execution host. */
  getProviderModels?: (name: string) => Promise<ProviderModelRegistry['knownModels']>
  providerSummary?: ProviderSummaryEntry[]
  /** Adapter metadata for validation — keyed by provider name */
  providerAdapters?: ProviderAdapterInfo[]
  onProviderUpdate?: (provider: string, apiKey: string, model?: string, baseUrl?: string, quota?: Partial<ProviderQuotaPolicy>, auditContext?: Pick<AuditEntry, 'actor' | 'userAgent' | 'actorSession' | 'requestId' | 'credentialId'>) => ProviderSummaryEntry | null
  /** Reload only this host's captured provider configuration; never select caller paths. */
  onProviderReload?: (input: ProviderReloadRequest, auditContext?: Pick<AuditEntry, 'actor' | 'userAgent' | 'actorSession' | 'requestId' | 'credentialId'>) => ProviderSummaryEntry[] | Promise<ProviderSummaryEntry[]>
  google?: GoogleSettingsSummary
  onGoogleUpdate?: (clientId: string, clientSecret: string) => GoogleSettingsSummary | null
  bing?: BingSettingsSummary
  onBingUpdate?: (apiKey: string) => BingSettingsSummary | null
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions) {
  // Settings describe which credentials this install holds and where its
  // providers point. That is administrator territory even to read, so a
  // view-only account is refused here at the server rather than merely being
  // shown no link to it.
  app.get('/settings', async (request) => {
    requireAdminSession(request)
    return {
      providers: opts.providerSummary ?? [],
      providerCatalog: (await Promise.all((opts.providerAdapters ?? []).map(async adapter => {
        const configured = opts.providerSummary?.some(provider => provider.name === adapter.name && provider.configured)
        const discovered = configured && opts.getProviderModels ? await opts.getProviderModels(adapter.name) : []
        const knownModels = discovered.length ? discovered : adapter.knownModels
        const descriptor = {
          name: adapter.name,
          displayName: adapter.displayName,
          mode: adapter.mode,
          modelConfigurable: adapter.modelConfigurable,
          defaultModel: adapter.defaultModel,
          // Catalog entries can carry Aero's model metadata (limits, prices,
          // tool support); the documented choice shape is id, name and tier.
          knownModels: knownModels.map(({ id, displayName, tier }) => ({ id, displayName, tier })),
          modelValidationPattern: {
            source: adapter.modelValidationPattern.source,
            flags: adapter.modelValidationPattern.flags,
          },
          modelValidationHint: adapter.modelValidationHint,
          ...descriptorFields(adapter),
        }
        // Descriptions that predate `routes` (the Cloud catalog) still know OpenRouter.
        const family = routeFamiliesOf(opts.providerAdapters).find(item => item.connection === adapter.name)
        if (!family) return [descriptor]
        // A routed connection lists one entry per route it can serve: each
        // catalog model of a gateway, each declared profile of an answer service.
        const selections = family.selectionKind === 'profile'
          ? (adapter.profiles ?? []).map(profile => profile.id)
          : knownModels.map(model => model.id)
        const routeAdapters = selections.flatMap(selection => {
          let routeName: string
          try { routeName = providerRouteName(family, selection) } catch { return [] }
          const route = providerAdapterForName(routeName, [{ ...adapter, knownModels }])
          if (!route) return []
          const fields = descriptorFields(route)
          return [{
            ...descriptor,
            ...fields,
            name: route.name,
            displayName: route.displayName,
            modelConfigurable: false,
            defaultModel: route.defaultModel,
            knownModels: route.knownModels,
            modelValidationPattern: { source: route.modelValidationPattern.source, flags: route.modelValidationPattern.flags },
            modelValidationHint: route.modelValidationHint,
            // A route is a target, not a connection: it selects nothing further and holds no key.
            ...(Object.keys(fields).length > 0 ? { selectionKind: null, settingsFields: undefined, keyCheck: undefined } : {}),
          }]
        })
        return [descriptor, ...routeAdapters]
      }))).flat(),
      google: opts.google ?? { configured: false },
      bing: opts.bing ?? { configured: false },
    }
  })

  app.put<{
    Params: { name: string }
    Body: { apiKey?: string; baseUrl?: string; model?: string; quota?: Partial<ProviderQuotaPolicy> }
  }>('/settings/providers/:name', connectionRoute(app, (request) => {
    // A key or endpoint is a connection; a model or quota change alone is not.
    const provider = outcomeProviderName(request.params.name)
    const body = request.body as { apiKey?: unknown; baseUrl?: unknown } | undefined
    if (!provider || (body?.apiKey === undefined && body?.baseUrl === undefined)) return undefined
    const configured = (opts.providerSummary ?? []).some(entry => entry.name === provider && entry.configured)
    return { integration: 'provider', provider, action: configured ? 'reauth' : 'connect' }
  }, async (request) => {
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

    if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim())) {
      throw validationError('apiKey must be a non-empty string when provided')
    }
    if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !baseUrl.trim())) {
      throw validationError('baseUrl must be a non-empty string when provided')
    }
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
      throw validationError('model must be a non-empty string when provided')
    }
    if (apiKey === undefined && baseUrl === undefined && model === undefined && quota === undefined) {
      throw validationError('at least one provider setting must be supplied')
    }

    const existing = (opts.providerSummary ?? []).find(provider => provider.name === name)
    const configured = Boolean(existing?.configured)
    if (!configured && name === 'local') {
      if (!baseUrl) {
        throw validationError('baseUrl is required for local provider')
      }
    } else if (!configured && name === 'gemini' && !apiKey) {
      const geminiSummary = (opts.providerSummary ?? []).find(p => p.name === 'gemini')
      if (!geminiSummary?.vertexConfigured) {
        throw validationError(
          'apiKey is required for Gemini unless Vertex AI is configured ' +
          '(set GEMINI_VERTEX_PROJECT env var or vertexProject in config file)',
        )
      }
    } else if (!configured) {
      if (!apiKey || typeof apiKey !== 'string') {
        throw validationError('apiKey is required')
      }
    }

    // An answer service takes a key and nothing else: its endpoint is fixed
    // (so the key can never be sent elsewhere) and each route pins its profile.
    if (adapterInfo.kind === ProviderKinds['answer-service']) {
      if (baseUrl !== undefined) throw validationError(`${adapterInfo.displayName} uses a fixed endpoint; baseUrl is not accepted.`, { provider: name })
      if (model !== undefined) throw validationError(`${adapterInfo.displayName} has no connection model; choose profiles per project instead.`, { provider: name })
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
      if (Object.keys(quota).length === 0) {
        throw validationError('quota must include at least one field')
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

    // Only trusted identity and bounded correlation reach the host's audit writer;
    // never forward the authorization header or mutable request object.
    const { actor, userAgent, actorSession, requestId, credentialId } = auditFromRequest(request, {
      actor: 'api', action: 'provider.updated', entityType: 'provider',
    })
    const result = opts.onProviderUpdate(name, apiKey ?? '', model, baseUrl, quota, { actor, userAgent, actorSession, requestId, credentialId })
    if (!result) {
      throw internalError('Failed to update provider configuration')
    }

    return result
  }))

  app.post('/settings/providers/reload', async (request) => withFeatureOutcome(app, { feature: 'providers', operation: 'reload' }, async (settle) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    requireInstanceAdministrator(request)
    const parsed = providerReloadRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError('Invalid provider reload request', parsed.error.flatten())
    }
    if (!opts.onProviderReload) {
      throw notImplemented('Provider configuration reload is not supported in this deployment')
    }
    const { actor, userAgent, actorSession, requestId, credentialId } = auditFromRequest(request, {
      actor: 'api', action: 'providers.reloaded', entityType: 'provider',
    })
    const providers = await opts.onProviderReload(parsed.data, { actor, userAgent, actorSession, requestId, credentialId })
    settle({ status: OutcomeStatuses.succeeded, counts: { providers: providers.filter(provider => provider.configured).length } })
    return providerReloadResponseDtoSchema.parse({ reloaded: true, providers })
  }, err => (err instanceof AppError && err.code === 'NOT_IMPLEMENTED' ? OutcomeReasonCodes.UNSUPPORTED : undefined)))

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
