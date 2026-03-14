import type { FastifyInstance } from 'fastify'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { authPlugin } from './auth.js'
import { projectRoutes } from './projects.js'
import type { ProjectRoutesOptions } from './projects.js'
import { keywordRoutes } from './keywords.js'
import type { KeywordRoutesOptions } from './keywords.js'
import { competitorRoutes } from './competitors.js'
import { runRoutes } from './runs.js'
import type { RunRoutesOptions } from './runs.js'
import { applyRoutes } from './apply.js'
import { historyRoutes } from './history.js'
import { openApiRoutes } from './openapi.js'
import type { OpenApiInfo } from './openapi.js'
import { settingsRoutes } from './settings.js'
import type { SettingsRoutesOptions, ProviderSummaryEntry } from './settings.js'
import { telemetryRoutes } from './telemetry.js'
import type { TelemetryRoutesOptions } from './telemetry.js'
import { scheduleRoutes } from './schedules.js'
import type { ScheduleRoutesOptions } from './schedules.js'
import { notificationRoutes } from './notifications.js'
import { googleRoutes } from './google.js'
import type { GoogleRoutesOptions } from './google.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseClient
  }
}

export interface ApiRoutesOptions {
  db: DatabaseClient
  openApiInfo?: OpenApiInfo
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
  /** Callback to generate keyword suggestions using an LLM provider */
  onGenerateKeywords?: KeywordRoutesOptions['onGenerateKeywords']
  /** Telemetry status/toggle callbacks */
  getTelemetryStatus?: TelemetryRoutesOptions['getTelemetryStatus']
  setTelemetryEnabled?: TelemetryRoutesOptions['setTelemetryEnabled']
  /** Google OAuth config + sync callback */
  googleClientId?: string
  googleClientSecret?: string
  /** Secret for signing OAuth state parameters */
  googleStateSecret?: string
  onGscSyncRequested?: GoogleRoutesOptions['onGscSyncRequested']
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
    await api.register(openApiRoutes, opts.openApiInfo ?? {})
    await api.register(projectRoutes, {
      onProjectDeleted: opts.onProjectDeleted,
    } satisfies ProjectRoutesOptions)
    await api.register(keywordRoutes, {
      onGenerateKeywords: opts.onGenerateKeywords,
    } satisfies KeywordRoutesOptions)
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
    await api.register(telemetryRoutes, {
      getTelemetryStatus: opts.getTelemetryStatus,
      setTelemetryEnabled: opts.setTelemetryEnabled,
    } satisfies TelemetryRoutesOptions)
    await api.register(googleRoutes, {
      googleClientId: opts.googleClientId,
      googleClientSecret: opts.googleClientSecret,
      googleStateSecret: opts.googleStateSecret,
      onGscSyncRequested: opts.onGscSyncRequested,
    } satisfies GoogleRoutesOptions)
  }, { prefix: '/api/v1' })
}

export type { DatabaseClient } from '@ainyc/canonry-db'
export { queueRunIfProjectIdle } from './run-queue.js'
export { deliverWebhook, resolveWebhookTarget } from './webhooks.js'
export type { SafeWebhookTarget } from './webhooks.js'
export type { RunRoutesOptions } from './runs.js'
