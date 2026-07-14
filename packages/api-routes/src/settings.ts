import type { FastifyInstance } from 'fastify'
import type { ProviderModelRegistry, ProviderQuotaPolicy } from '@ainyc/canonry-contracts'
import {
  validationError,
  notImplemented,
  internalError,
} from '@ainyc/canonry-contracts'
import { requireScope } from './auth.js'

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
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions) {
  app.get('/settings', async () => ({
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
  }))

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
