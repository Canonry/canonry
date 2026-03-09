import Fastify from 'fastify'

import type { PlatformEnv } from '@ainyc/aeo-platform-config'

import { registerHealthRoutes } from './routes/health.js'

export function buildApp(env: PlatformEnv) {
  const app = Fastify({
    logger: true,
  })

  app.get('/', async () => ({
    service: 'aeo-platform-api',
    mode: 'skeleton',
    status: 'ok' as const,
    version: 'phase-1',
    docs: '/health',
  }))

  registerHealthRoutes(app, env)

  return app
}
