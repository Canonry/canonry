import Fastify from 'fastify'

import type { PlatformEnv } from '@ainyc/aeo-platform-config'
import { createClient } from '@ainyc/aeo-platform-db'
import { apiRoutes } from '@ainyc/aeo-platform-api-routes'

import { registerHealthRoutes } from './routes/health.js'

export function buildApp(env: PlatformEnv) {
  const app = Fastify({
    logger: true,
  })

  // Connect to database and register shared API routes
  const db = createClient(env.databaseUrl)

  app.register(apiRoutes, {
    db,
    skipAuth: false,
  })

  registerHealthRoutes(app, env)

  return app
}
