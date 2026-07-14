import Fastify from 'fastify'

import type { PlatformEnv } from '@ainyc/canonry-config'
import { createClient } from '@ainyc/canonry-db'
import { apiRoutes } from '@ainyc/canonry-api-routes'

import { registerHealthRoutes } from './routes/health.js'
import { registerTelemetryCollectorRoutes } from './routes/telemetry-collector.js'

export function buildApp(env: PlatformEnv) {
  const app = Fastify({
    logger: true,
  })

  // Connect to database and register shared API routes
  const db = createClient(env.databaseUrl)

  const providerSummary = (['gemini', 'openai', 'claude', 'perplexity'] as const).map(name => ({
    name,
    model: env.providers[name]?.model,
    configured: !!env.providers[name],
    quota: env.providers[name]?.quota,
  }))
  // Cloud validates the same public model-id conventions as local serve
  // without importing execution adapters (and their provider SDK graphs).
  const providerAdapters = [
    {
      name: 'gemini', displayName: 'Gemini', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'gemini-2.5-flash',
      knownModels: [
        { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' as const },
        { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', tier: 'standard' as const },
      ],
      modelValidationPattern: /./,
      modelValidationHint: 'any valid Google model name (e.g. gemini-2.5-flash)',
    },
    {
      name: 'openai', displayName: 'OpenAI', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'gpt-5.4',
      knownModels: [
        { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'flagship' as const },
        { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', tier: 'fast' as const },
      ],
      modelValidationPattern: /./,
      modelValidationHint: 'any valid OpenAI model name (e.g. gpt-5.4)',
    },
    {
      name: 'claude', displayName: 'Claude', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'claude-sonnet-4-5',
      knownModels: [{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', tier: 'standard' as const }],
      modelValidationPattern: /^claude-/,
      modelValidationHint: 'a Claude model ID beginning with claude-',
    },
    {
      name: 'perplexity', displayName: 'Perplexity', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'sonar-pro',
      knownModels: [{ id: 'sonar-pro', displayName: 'Sonar Pro', tier: 'standard' as const }],
      modelValidationPattern: /^sonar/,
      modelValidationHint: 'a Perplexity Sonar model ID beginning with sonar',
    },
  ]

  app.register(apiRoutes, {
    db,
    skipAuth: false,
    routePrefix: env.basePath === '/' ? '/api/v1' : `${env.basePath.replace(/\/$/, '')}/api/v1`,
    openApiInfo: {
      title: 'Canonry API',
      version: '0.1.0',
    },
    providerSummary,
    providerAdapters,
    googleStateSecret: env.googleStateSecret,
  })

  registerTelemetryCollectorRoutes(app)
  registerHealthRoutes(app, env)

  return app
}
