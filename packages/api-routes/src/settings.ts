import type { FastifyInstance } from 'fastify'
import type { ProviderQuotaPolicy } from '@ainyc/canonry-contracts'
import { parseProviderName } from '@ainyc/canonry-contracts'

export interface ProviderSummaryEntry {
  name: string
  model?: string
  configured: boolean
  quota?: ProviderQuotaPolicy
}

export interface SettingsRoutesOptions {
  providerSummary?: ProviderSummaryEntry[]
  onProviderUpdate?: (provider: string, apiKey: string, model?: string, baseUrl?: string, quota?: Partial<ProviderQuotaPolicy>) => ProviderSummaryEntry | null
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions) {
  app.get('/settings', async () => ({
    providers: opts.providerSummary ?? [],
  }))

  app.put<{
    Params: { name: string }
    Body: { apiKey?: string; baseUrl?: string; model?: string; quota?: Partial<ProviderQuotaPolicy> }
  }>('/settings/providers/:name', async (request, reply) => {
    const providerName = parseProviderName(request.params.name)
    const { apiKey, baseUrl, model, quota } = request.body ?? {}

    if (!providerName) {
      return reply.status(400).send({ error: `Invalid provider: ${request.params.name}. Must be one of: gemini, openai, claude, local` })
    }
    const name = providerName

    // Local provider requires baseUrl; others require apiKey
    if (name === 'local') {
      if (!baseUrl || typeof baseUrl !== 'string') {
        return reply.status(400).send({ error: 'baseUrl is required for local provider' })
      }
    } else {
      if (!apiKey || typeof apiKey !== 'string') {
        return reply.status(400).send({ error: 'apiKey is required' })
      }
    }

    if (model !== undefined) {
      if (name === 'gemini' && !model.startsWith('gemini-')) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: `Invalid model "${model}" for provider "gemini" — model name must start with "gemini-" (e.g. gemini-2.5-flash)` },
        })
      }
      if (name === 'openai' && !/^(gpt-|o\d)/.test(model)) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: `Invalid model "${model}" for provider "openai" — expected a GPT or o-series model name (e.g. gpt-4o, o3)` },
        })
      }
      if (name === 'claude' && !model.startsWith('claude-')) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: `Invalid model "${model}" for provider "claude" — model name must start with "claude-" (e.g. claude-sonnet-4-6)` },
        })
      }
    }

    if (!opts.onProviderUpdate) {
      return reply.status(501).send({ error: 'Provider configuration updates are not supported in this deployment' })
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
      return reply.status(500).send({ error: 'Failed to update provider configuration' })
    }

    return result
  })
}
