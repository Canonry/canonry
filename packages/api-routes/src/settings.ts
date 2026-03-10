import type { FastifyInstance } from 'fastify'
import type { ProviderQuotaPolicy } from '@ainyc/aeo-platform-contracts'

export interface ProviderSummaryEntry {
  name: string
  model?: string
  configured: boolean
  quota?: ProviderQuotaPolicy
}

export interface SettingsRoutesOptions {
  providerSummary?: ProviderSummaryEntry[]
  onProviderUpdate?: (provider: string, apiKey: string, model?: string) => ProviderSummaryEntry | null
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions) {
  app.get('/settings', async () => ({
    providers: opts.providerSummary ?? [],
  }))

  app.put<{
    Params: { name: string }
    Body: { apiKey: string; model?: string }
  }>('/settings/providers/:name', async (request, reply) => {
    const { name } = request.params
    const { apiKey, model } = request.body ?? {}

    if (!apiKey || typeof apiKey !== 'string') {
      return reply.status(400).send({ error: 'apiKey is required' })
    }

    const validProviders = ['gemini', 'openai', 'claude']
    if (!validProviders.includes(name)) {
      return reply.status(400).send({ error: `Invalid provider: ${name}. Must be one of: ${validProviders.join(', ')}` })
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

    const result = opts.onProviderUpdate(name, apiKey, model)
    if (!result) {
      return reply.status(500).send({ error: 'Failed to update provider configuration' })
    }

    return result
  })
}
