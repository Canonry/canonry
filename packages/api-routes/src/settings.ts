import type { FastifyInstance } from 'fastify'
import type { ProviderQuotaPolicy } from '@ainyc/canonry-contracts'
import {
  apiProviderNameSchema,
  MODEL_REGISTRY,
  validationError,
  notImplemented,
} from '@ainyc/canonry-contracts'

export interface ProviderSummaryEntry {
  name: string
  model?: string
  configured: boolean
  quota?: ProviderQuotaPolicy
}

export interface GoogleSettingsSummary {
  configured: boolean
}

export interface BingSettingsSummary {
  configured: boolean
}

export interface SettingsRoutesOptions {
  providerSummary?: ProviderSummaryEntry[]
  onProviderUpdate?: (provider: string, apiKey: string, model?: string, baseUrl?: string, quota?: Partial<ProviderQuotaPolicy>) => ProviderSummaryEntry | null
  google?: GoogleSettingsSummary
  onGoogleUpdate?: (clientId: string, clientSecret: string) => GoogleSettingsSummary | null
  bing?: BingSettingsSummary
  onBingUpdate?: (apiKey: string) => BingSettingsSummary | null
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions) {
  app.get('/settings', async () => ({
    providers: opts.providerSummary ?? [],
    google: opts.google ?? { configured: false },
    bing: opts.bing ?? { configured: false },
  }))

  app.put<{
    Params: { name: string }
    Body: { apiKey?: string; baseUrl?: string; model?: string; quota?: Partial<ProviderQuotaPolicy> }
  }>('/settings/providers/:name', async (request, reply) => {
    const providerName = apiProviderNameSchema.safeParse(request.params.name)
    const { apiKey, baseUrl, model, quota } = request.body ?? {}

    if (!providerName.success) {
      const err = validationError(`Invalid provider: ${request.params.name}. Must be one of: gemini, openai, claude, local`, {
        provider: request.params.name,
        validProviders: ['gemini', 'openai', 'claude', 'local'],
      })
      return reply.status(err.statusCode).send(err.toJSON())
    }
    const name = providerName.data

    // Local provider requires baseUrl; others require apiKey
    if (name === 'local') {
      if (!baseUrl || typeof baseUrl !== 'string') {
        const err = validationError('baseUrl is required for local provider')
        return reply.status(err.statusCode).send(err.toJSON())
      }
    } else {
      if (!apiKey || typeof apiKey !== 'string') {
        const err = validationError('apiKey is required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
    }

    if (model !== undefined) {
      const registry = MODEL_REGISTRY[name]
      if (!registry.validationPattern.test(model)) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: `Invalid model "${model}" for provider "${name}" — ${registry.validationHint}` },
        })
      }
    }

    if (!opts.onProviderUpdate) {
      const err = notImplemented('Provider configuration updates are not supported in this deployment')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    // Validate quota fields if provided
    if (quota !== undefined) {
      if (typeof quota !== 'object' || quota === null) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'quota must be an object' } })
      }
      for (const [key, val] of Object.entries(quota)) {
        if (!['maxConcurrency', 'maxRequestsPerMinute', 'maxRequestsPerDay'].includes(key)) {
          return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: `Unknown quota field: ${key}` } })
        }
        if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
          return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: `${key} must be a positive integer` } })
        }
      }
    }

    const result = opts.onProviderUpdate(name, apiKey ?? '', model, baseUrl, quota)
    if (!result) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to update provider configuration',
        },
      })
    }

    return result
  })

  app.put<{
    Body: { clientId?: string; clientSecret?: string }
  }>('/settings/google', async (request, reply) => {
    const { clientId, clientSecret } = request.body ?? {}

    if (!clientId || typeof clientId !== 'string' || !clientSecret || typeof clientSecret !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'clientId and clientSecret are required' },
      })
    }

    if (!opts.onGoogleUpdate) {
      const err = notImplemented('Google OAuth configuration updates are not supported in this deployment')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const result = opts.onGoogleUpdate(clientId, clientSecret)
    if (!result) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to update Google OAuth configuration',
        },
      })
    }

    return result
  })

  app.put<{
    Body: { apiKey?: string }
  }>('/settings/bing', async (request, reply) => {
    const { apiKey } = request.body ?? {}

    if (!apiKey || typeof apiKey !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'apiKey is required' },
      })
    }

    if (!opts.onBingUpdate) {
      const err = notImplemented('Bing configuration updates are not supported in this deployment')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const result = opts.onBingUpdate(apiKey)
    if (!result) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to update Bing configuration',
        },
      })
    }

    return result
  })
}
