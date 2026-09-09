import type { FastifyInstance } from 'fastify'

import type { McpHealth } from '@ainyc/canonry-contracts'
import type { PlatformEnv } from '@ainyc/canonry-config'

interface HealthResponse {
  service: 'canonry'
  status: 'ok'
  version: string
  port: number
  basePath: string
  databaseUrlConfigured: boolean
  lastHeartbeatAt: string
  mcp: McpHealth
}

export function registerHealthRoutes(app: FastifyInstance, env: PlatformEnv): void {
  const path = env.basePath === '/' ? '/health' : `${env.basePath.replace(/\/$/, '')}/health`
  app.get(path, async (): Promise<HealthResponse> => ({
    service: 'canonry',
    status: 'ok',
    mcp: { status: 'not-supported' },
    version: '0.1.0',
    port: env.apiPort,
    basePath: env.basePath,
    databaseUrlConfigured: env.databaseUrl.length > 0,
    lastHeartbeatAt: new Date().toISOString(),
  }))
}
