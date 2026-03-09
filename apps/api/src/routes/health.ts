import type { FastifyInstance } from 'fastify'

import type { PlatformEnv } from '@ainyc/aeo-platform-config'

interface HealthResponse {
  service: 'aeo-platform-api'
  status: 'ok'
  version: string
  port: number
  databaseUrlConfigured: boolean
}

export function registerHealthRoutes(app: FastifyInstance, env: PlatformEnv): void {
  app.get('/health', async (): Promise<HealthResponse> => ({
    service: 'aeo-platform-api',
    status: 'ok',
    version: '0.1.0',
    port: env.apiPort,
    databaseUrlConfigured: env.databaseUrl.length > 0,
  }))
}
