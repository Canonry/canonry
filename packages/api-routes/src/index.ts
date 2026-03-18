import type { FastifyInstance, FastifyError } from 'fastify'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'
import { authPlugin } from './auth.js'
import { projectRoutes } from './projects.js'
import type { ProjectRoutesOptions } from './projects.js'
import { keywordRoutes } from './keywords.js'
import type { KeywordRoutesOptions } from './keywords.js'
import { competitorRoutes } from './competitors.js'
import { runRoutes } from './runs.js'
import type { RunRoutesOptions } from './runs.js'
import { applyRoutes } from './apply.js'
import type { ApplyRoutesOptions } from './apply.js'
import { historyRoutes } from './history.js'
import { analyticsRoutes } from './analytics.js'
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
import { cdpRoutes } from './cdp.js'
import type { CDPRoutesOptions } from './cdp.js'

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
  /** API route prefix (default: /api/v1). Override for sub-path deployments e.g. /canonry/api/v1.
   *  Named routePrefix (not prefix) to avoid collision with Fastify's reserved prefix option.
   *  Must start with '/' — values without a leading slash will be rejected at startup. */
  routePrefix?: string
  /** Callback when a run is created (wire up job runner) */
  onRunCreated?: (runId: string, projectId: string, providers?: string[], location?: import('@ainyc/canonry-contracts').LocationContext | null) => void
  /** Provider configuration summary for settings endpoint */
  providerSummary?: ProviderSummaryEntry[]
  /** Callback when a provider config is updated via API */
  onProviderUpdate?: SettingsRoutesOptions['onProviderUpdate']
  /** Google OAuth configuration summary + update callback */
  googleSettingsSummary?: SettingsRoutesOptions['google']
  onGoogleSettingsUpdate?: SettingsRoutesOptions['onGoogleUpdate']
  /** Callback when a schedule is created/updated/deleted */
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string) => void
  /** Callback when a project is deleted */
  onProjectDeleted?: (projectId: string) => void
  /** Callback to generate keyword suggestions using an LLM provider */
  onGenerateKeywords?: KeywordRoutesOptions['onGenerateKeywords']
  /** Telemetry status/toggle callbacks */
  getTelemetryStatus?: TelemetryRoutesOptions['getTelemetryStatus']
  setTelemetryEnabled?: TelemetryRoutesOptions['setTelemetryEnabled']
  /** Google auth config and storage */
  getGoogleAuthConfig?: GoogleRoutesOptions['getGoogleAuthConfig']
  googleConnectionStore?: GoogleRoutesOptions['googleConnectionStore']
  /** Secret for signing OAuth state parameters */
  googleStateSecret?: string
  /** Public URL for OAuth redirect URIs (overrides auto-detect from request headers) */
  publicUrl?: string
  onGscSyncRequested?: GoogleRoutesOptions['onGscSyncRequested']
  onInspectSitemapRequested?: GoogleRoutesOptions['onInspectSitemapRequested']
  /** CDP browser provider callbacks */
  getCdpStatus?: CDPRoutesOptions['getCdpStatus']
  onCdpScreenshot?: CDPRoutesOptions['onCdpScreenshot']
  onCdpConfigure?: CDPRoutesOptions['onCdpConfigure']
}

export async function apiRoutes(app: FastifyInstance, opts: ApiRoutesOptions) {
  // Validate routePrefix format eagerly to surface misconfiguration at startup
  // rather than silently mis-routing all API requests.
  if (opts.routePrefix !== undefined && !opts.routePrefix.startsWith('/')) {
    throw new Error(
      `apiRoutes: routePrefix must start with '/' — got ${JSON.stringify(opts.routePrefix)}`,
    )
  }

  // Decorate with db
  app.decorate('db', opts.db)

  // Global error handler — serializes AppError consistently, prevents stack trace leaks
  app.setErrorHandler((error: FastifyError | AppError, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }

    // Derive HTTP status from Fastify's statusCode or a generic .status property
    // (e.g. GoogleApiError uses .status instead of .statusCode)
    const httpStatus = error.statusCode
      ?? (error as unknown as { status?: number }).status
      ?? 500

    // Client errors (4xx) — forward the message
    if (httpStatus >= 400 && httpStatus < 500) {
      return reply.status(httpStatus).send({
        error: {
          code: httpStatus === 401 ? 'AUTH_INVALID'
            : httpStatus === 403 ? 'FORBIDDEN'
            : httpStatus === 404 ? 'NOT_FOUND'
            : httpStatus === 429 ? 'QUOTA_EXCEEDED'
            : 'VALIDATION_ERROR',
          message: error.message,
        },
      })
    }

    // Unexpected errors — log full detail, return safe message
    app.log.error(error)
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    })
  })

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
      onGoogleConnectionPropertyUpdated: (domain, connectionType, propertyId) => {
        opts.googleConnectionStore?.updateConnection(domain, connectionType, {
          propertyId,
          updatedAt: new Date().toISOString(),
        })
      },
    } satisfies ApplyRoutesOptions)
    await api.register(historyRoutes)
    await api.register(analyticsRoutes)
    await api.register(settingsRoutes, {
      providerSummary: opts.providerSummary,
      onProviderUpdate: opts.onProviderUpdate,
      google: opts.googleSettingsSummary,
      onGoogleUpdate: opts.onGoogleSettingsUpdate,
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
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      googleConnectionStore: opts.googleConnectionStore,
      googleStateSecret: opts.googleStateSecret,
      publicUrl: opts.publicUrl,
      onGscSyncRequested: opts.onGscSyncRequested,
      onInspectSitemapRequested: opts.onInspectSitemapRequested,
    } satisfies GoogleRoutesOptions)
    await api.register(cdpRoutes, {
      getCdpStatus: opts.getCdpStatus,
      onCdpScreenshot: opts.onCdpScreenshot,
      onCdpConfigure: opts.onCdpConfigure,
    } satisfies CDPRoutesOptions)
  }, { prefix: opts.routePrefix ?? '/api/v1' })
}

export type { DatabaseClient } from '@ainyc/canonry-db'
export { queueRunIfProjectIdle } from './run-queue.js'
export { deliverWebhook, resolveWebhookTarget } from './webhooks.js'
export type { SafeWebhookTarget } from './webhooks.js'
export type { RunRoutesOptions } from './runs.js'
