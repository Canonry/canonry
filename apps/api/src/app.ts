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
  //
  // KEEP IN SYNC with each adapter's `modelRegistry` in
  // packages/provider-*/src/adapter.ts (defaultModel / knownModels /
  // validationPattern / validationHint). This is a deliberate hand-mirrored copy
  // because apps/api must not pull the provider SDK graphs; a stale copy makes
  // the cloud /settings catalog advertise a wrong "inherited default" and a
  // truncated model list versus what the worker actually runs. Durable fix
  // (deferred): move each registry into an SDK-free module shared by the adapter
  // and this list so they cannot drift.
  const providerAdapters = [
    {
      name: 'gemini', displayName: 'Gemini', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'gemini-2.5-flash',
      knownModels: [
        { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' as const },
        { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', tier: 'standard' as const },
        { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', tier: 'economy' as const },
        { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', tier: 'standard' as const },
      ],
      modelValidationPattern: /./,
      modelValidationHint: 'any valid Google model name (e.g. gemini-2.5-flash, learnlm-1.5-pro-experimental)',
    },
    {
      name: 'openai', displayName: 'OpenAI', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'gpt-5.4',
      knownModels: [
        { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'flagship' as const },
        { id: 'gpt-5.4-pro', displayName: 'GPT-5.4 Pro', tier: 'flagship' as const },
        { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', tier: 'fast' as const },
        { id: 'gpt-5-nano', displayName: 'GPT-5 Nano', tier: 'economy' as const },
        { id: 'gpt-5', displayName: 'GPT-5', tier: 'standard' as const },
        { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' as const },
      ],
      modelValidationPattern: /./,
      modelValidationHint: 'any valid OpenAI model name (e.g. gpt-5.4, o3, chatgpt-4o-latest)',
    },
    {
      name: 'claude', displayName: 'Claude', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'claude-sonnet-4-6',
      knownModels: [
        { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tier: 'flagship' as const },
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tier: 'standard' as const },
        { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', tier: 'fast' as const },
      ],
      modelValidationPattern: /^claude-/,
      modelValidationHint: 'model name must start with "claude-" (e.g. claude-sonnet-4-6)',
    },
    {
      name: 'perplexity', displayName: 'Perplexity', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'sonar',
      knownModels: [
        { id: 'sonar', displayName: 'Sonar', tier: 'standard' as const },
        { id: 'sonar-pro', displayName: 'Sonar Pro', tier: 'flagship' as const },
        { id: 'sonar-reasoning', displayName: 'Sonar Reasoning', tier: 'flagship' as const },
        { id: 'sonar-reasoning-pro', displayName: 'Sonar Reasoning Pro', tier: 'flagship' as const },
      ],
      modelValidationPattern: /^sonar/,
      modelValidationHint: 'expected a sonar model (e.g. sonar, sonar-pro, sonar-reasoning)',
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
