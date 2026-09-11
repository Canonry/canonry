import type { FastifyInstance } from 'fastify'
import type { ProviderModelRegistry, ProviderQuotaPolicy } from '@ainyc/canonry-contracts'
import {
  validationError,
  notImplemented,
  internalError,
} from '@ainyc/canonry-contracts'
import { requireAdminSession, requireScope } from './auth.js'
import { auditFromRequest, type AuditEntry } from './helpers.js'

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
  /** Cached, credential-free model metadata supplied by the execution host. */
  getProviderModels?: (name: string) => Promise<ProviderModelRegistry['knownModels']>
  providerSummary?: ProviderSummaryEntry[]
  /** Adapter metadata for validation — keyed by provider name */
  providerAdapters?: ProviderAdapterInfo[]
  onProviderUpdate?: (provider: string, apiKey: string, model?: string, baseUrl?: string, quota?: Partial<ProviderQuotaPolicy>, auditContext?: Pick<AuditEntry, 'actor' | 'userAgent' | 'actorSession' | 'requestId' | 'credentialId'>) => ProviderSummaryEntry | null
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
      providerCatalog: await Promise.all((opts.providerAdapters ?? []).map(async adapter => {
        const configured = opts.providerSummary?.some(provider => provider.name === adapter.name && provider.configured)
        const discovered = configured && opts.getProviderModels ? await opts.getProviderModels(adapter.name) : []
        return {
          name: adapter.name,
          displayName: adapter.displayName,
          mode: adapter.mode,
          modelConfigurable: adapter.modelConfigurable,
          defaultModel: adapter.defaultModel,
          knownModels: discovered.length ? discovered : adapter.knownModels,
          modelValidationPattern: {
            source: adapter.modelValidationPattern.source,
            flags: adapter.modelValidationPattern.flags,
          },
          modelValidationHint: adapter.modelValidationHint,
        }
      })),
      google: opts.google ?? { configured: false },
      bing: opts.bing ?? { configured: false },
    }
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
