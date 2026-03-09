import type { FastifyInstance } from 'fastify'
import type { DatabaseClient } from '@ainyc/aeo-platform-db'
import { authPlugin } from './auth.js'
import { projectRoutes } from './projects.js'
import { keywordRoutes } from './keywords.js'
import { competitorRoutes } from './competitors.js'
import { runRoutes } from './runs.js'
import type { RunRoutesOptions } from './runs.js'
import { applyRoutes } from './apply.js'
import { historyRoutes } from './history.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseClient
  }
}

export interface ApiRoutesOptions {
  db: DatabaseClient
  /** Skip auth for testing */
  skipAuth?: boolean
  /** Callback when a run is created (wire up job runner) */
  onRunCreated?: (runId: string, projectId: string) => void
}

export async function apiRoutes(app: FastifyInstance, opts: ApiRoutesOptions) {
  // Decorate with db
  app.decorate('db', opts.db)

  // Register auth (unless skipped)
  if (!opts.skipAuth) {
    await app.register(authPlugin)
  }

  // Register route plugins under /api/v1
  await app.register(async (api) => {
    await api.register(projectRoutes)
    await api.register(keywordRoutes)
    await api.register(competitorRoutes)
    await api.register(runRoutes, { onRunCreated: opts.onRunCreated } satisfies RunRoutesOptions)
    await api.register(applyRoutes)
    await api.register(historyRoutes)
  }, { prefix: '/api/v1' })
}

export type { DatabaseClient } from '@ainyc/aeo-platform-db'
export type { RunRoutesOptions } from './runs.js'
