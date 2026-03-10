import type { FastifyInstance } from 'fastify'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { authPlugin } from './auth.js'
import { projectRoutes } from './projects.js'
import type { ProjectRoutesOptions } from './projects.js'
import { keywordRoutes } from './keywords.js'
import { competitorRoutes } from './competitors.js'
import { runRoutes } from './runs.js'
import type { RunRoutesOptions } from './runs.js'
import { applyRoutes } from './apply.js'
import { historyRoutes } from './history.js'
import { settingsRoutes } from './settings.js'
import type { SettingsRoutesOptions, ProviderSummaryEntry } from './settings.js'
import { scheduleRoutes } from './schedules.js'
import type { ScheduleRoutesOptions } from './schedules.js'
import { notificationRoutes } from './notifications.js'

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
  onRunCreated?: (runId: string, projectId: string, providers?: string[]) => void
  /** Provider configuration summary for settings endpoint */
  providerSummary?: ProviderSummaryEntry[]
  /** Callback when a provider config is updated via API */
  onProviderUpdate?: (provider: string, apiKey: string, model?: string) => ProviderSummaryEntry | null
  /** Callback when a schedule is created/updated/deleted */
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string) => void
  /** Callback when a project is deleted */
  onProjectDeleted?: (projectId: string) => void
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
    await api.register(projectRoutes, {
      onProjectDeleted: opts.onProjectDeleted,
    } satisfies ProjectRoutesOptions)
    await api.register(keywordRoutes)
    await api.register(competitorRoutes)
    await api.register(runRoutes, { onRunCreated: opts.onRunCreated } satisfies RunRoutesOptions)
    await api.register(applyRoutes, {
      onScheduleUpdated: opts.onScheduleUpdated,
    })
    await api.register(historyRoutes)
    await api.register(settingsRoutes, {
      providerSummary: opts.providerSummary,
      onProviderUpdate: opts.onProviderUpdate,
    } satisfies SettingsRoutesOptions)
    await api.register(scheduleRoutes, {
      onScheduleUpdated: opts.onScheduleUpdated,
    } satisfies ScheduleRoutesOptions)
    await api.register(notificationRoutes)
  }, { prefix: '/api/v1' })
}

export type { DatabaseClient } from '@ainyc/canonry-db'
export { queueRunIfProjectIdle } from './run-queue.js'
export { deliverWebhook, resolveWebhookTarget } from './webhooks.js'
export type { SafeWebhookTarget } from './webhooks.js'
export type { RunRoutesOptions } from './runs.js'
