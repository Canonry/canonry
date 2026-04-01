import Fastify from 'fastify'

import type { PlatformEnv } from '@ainyc/canonry-config'
import { createClient } from '@ainyc/canonry-db'
import { apiRoutes } from '@ainyc/canonry-api-routes'

import { registerHealthRoutes } from './routes/health.js'

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

  app.register(apiRoutes, {
    db,
    skipAuth: false,
    routePrefix: env.basePath === '/' ? '/api/v1' : `${env.basePath.replace(/\/$/, '')}/api/v1`,
    openApiInfo: {
      title: 'Canonry API',
      version: '0.1.0',
    },
    providerSummary,
  })

  registerHealthRoutes(app, env)

  return app
}
