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
import type { SettingsRoutesOptions, ProviderSummaryEntry, ProviderAdapterInfo } from './settings.js'
import { snapshotRoutes } from './snapshot.js'
import type { SnapshotRoutesOptions } from './snapshot.js'
import { telemetryRoutes } from './telemetry.js'
import type { TelemetryRoutesOptions } from './telemetry.js'
import { scheduleRoutes } from './schedules.js'
import type { ScheduleRoutesOptions } from './schedules.js'
import { notificationRoutes } from './notifications.js'
import { googleRoutes } from './google.js'
import type { GoogleRoutesOptions } from './google.js'
import { bingRoutes } from './bing.js'
import type { BingRoutesOptions } from './bing.js'
import { cdpRoutes } from './cdp.js'
import type { CDPRoutesOptions } from './cdp.js'
import { ga4Routes } from './ga.js'
import type { GA4RoutesOptions, Ga4CredentialStore } from './ga.js'
import { wordpressRoutes } from './wordpress.js'
import type { WordpressRoutesOptions } from './wordpress.js'

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
  /** Optional cookie-backed browser session support */
  sessionCookieName?: string
  resolveSessionApiKeyId?: (sessionId: string) => string | null | Promise<string | null>

  /** Callback when a run is created (wire up job runner) */
  onRunCreated?: (runId: string, projectId: string, providers?: string[], location?: import('@ainyc/canonry-contracts').LocationContext | null) => void
  /** Provider configuration summary for settings endpoint */
  providerSummary?: ProviderSummaryEntry[]
  /** Adapter metadata for provider validation */
  providerAdapters?: ProviderAdapterInfo[]
  /** Callback when a provider config is updated via API */
  onProviderUpdate?: SettingsRoutesOptions['onProviderUpdate']
  /** Google OAuth configuration summary + update callback */
  googleSettingsSummary?: SettingsRoutesOptions['google']
  onGoogleSettingsUpdate?: SettingsRoutesOptions['onGoogleUpdate']
  /** Callback when a schedule is created/updated/deleted */
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string) => void
  /** Callback when a project is deleted */
  onProjectDeleted?: (projectId: string) => void
  /** Callback to generate a one-shot AI perception snapshot */
  onSnapshotRequested?: SnapshotRoutesOptions['onSnapshotRequested']
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
  /** Bing Webmaster Tools connection store */
  bingConnectionStore?: BingRoutesOptions['bingConnectionStore']
  /** Bing settings summary for settings endpoint */
  bingSettingsSummary?: SettingsRoutesOptions['bing']
  onBingSettingsUpdate?: SettingsRoutesOptions['onBingUpdate']
  /** WordPress connection store */
  wordpressConnectionStore?: WordpressRoutesOptions['wordpressConnectionStore']
  /** CDP browser provider callbacks */
  getCdpStatus?: CDPRoutesOptions['getCdpStatus']
  onCdpScreenshot?: CDPRoutesOptions['onCdpScreenshot']
  onCdpConfigure?: CDPRoutesOptions['onCdpConfigure']
  /** GA4 credential store — stores service account keys in config, not DB */
  ga4CredentialStore?: Ga4CredentialStore
  /**
   * API route prefix (default: /api/v1).
   * Override when the server is behind a reverse proxy that does NOT strip the
   * base-path prefix before forwarding — e.g. set to '/canonry/api/v1' when
   * Caddy proxies /canonry/* directly to this server without path rewriting.
   */
  routePrefix?: string
}

export async function apiRoutes(app: FastifyInstance, opts: ApiRoutesOptions) {
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

  // Register route plugins under the configured prefix (default: /api/v1).
  // When a basePath is set and the reverse proxy does not strip it, pass
  // routePrefix: `${basePath}api/v1` so routes match the full incoming path.
  await app.register(async (api) => {
    if (!opts.skipAuth) {
      await authPlugin(api, {
        sessionCookieName: opts.sessionCookieName,
        resolveSessionApiKeyId: opts.resolveSessionApiKeyId,
      })
    }

    await api.register(openApiRoutes, opts.openApiInfo ?? {})
    await api.register(projectRoutes, {
      onProjectDeleted: opts.onProjectDeleted,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
    } satisfies ProjectRoutesOptions)
    await api.register(keywordRoutes, {
      onGenerateKeywords: opts.onGenerateKeywords,
      validProviderNames: opts.providerAdapters?.filter(a => a.mode === 'api').map(a => a.name),
    } satisfies KeywordRoutesOptions)
    await api.register(competitorRoutes)
    await api.register(runRoutes, {
      onRunCreated: opts.onRunCreated,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
    } satisfies RunRoutesOptions)
    await api.register(applyRoutes, {
      onScheduleUpdated: opts.onScheduleUpdated,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
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
      providerAdapters: opts.providerAdapters,
      onProviderUpdate: opts.onProviderUpdate,
      google: opts.googleSettingsSummary,
      onGoogleUpdate: opts.onGoogleSettingsUpdate,
      bing: opts.bingSettingsSummary,
      onBingUpdate: opts.onBingSettingsUpdate,
    } satisfies SettingsRoutesOptions)
    await api.register(snapshotRoutes, {
      onSnapshotRequested: opts.onSnapshotRequested,
    } satisfies SnapshotRoutesOptions)
    await api.register(scheduleRoutes, {
      onScheduleUpdated: opts.onScheduleUpdated,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
    } satisfies ScheduleRoutesOptions)
    await api.register(notificationRoutes)
    await api.register(telemetryRoutes, {
      getTelemetryStatus: opts.getTelemetryStatus,
      setTelemetryEnabled: opts.setTelemetryEnabled,
    } satisfies TelemetryRoutesOptions)
    await api.register(bingRoutes, {
      bingConnectionStore: opts.bingConnectionStore,
    } satisfies BingRoutesOptions)
    await api.register(googleRoutes, {
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      googleConnectionStore: opts.googleConnectionStore,
      googleStateSecret: opts.googleStateSecret,
      publicUrl: opts.publicUrl,
      onGscSyncRequested: opts.onGscSyncRequested,
      onInspectSitemapRequested: opts.onInspectSitemapRequested,
    } satisfies GoogleRoutesOptions)
    await api.register(wordpressRoutes, {
      wordpressConnectionStore: opts.wordpressConnectionStore,
      routePrefix: opts.routePrefix ?? '/api/v1',
    } satisfies WordpressRoutesOptions)
    await api.register(cdpRoutes, {
      getCdpStatus: opts.getCdpStatus,
      onCdpScreenshot: opts.onCdpScreenshot,
      onCdpConfigure: opts.onCdpConfigure,
    } satisfies CDPRoutesOptions)
    await api.register(ga4Routes, {
      ga4CredentialStore: opts.ga4CredentialStore,
    } satisfies GA4RoutesOptions)
  }, { prefix: opts.routePrefix ?? '/api/v1' })
}

export type { DatabaseClient } from '@ainyc/canonry-db'
export { queueRunIfProjectIdle } from './run-queue.js'
export { deliverWebhook, resolveWebhookTarget } from './webhooks.js'
export { redactNotificationDiff, redactNotificationUrl } from './notification-redaction.js'
export type { SafeWebhookTarget } from './webhooks.js'
export type { RunRoutesOptions } from './runs.js'
