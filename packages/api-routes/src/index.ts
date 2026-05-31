import type { FastifyInstance, FastifyError } from 'fastify'
import type { DatabaseClient } from '@ainyc/canonry-db'
import fs from 'node:fs'
import { AppError, runtimeStateMissing } from '@ainyc/canonry-contracts'
import { authPlugin } from './auth.js'
import { projectRoutes } from './projects.js'
import type { ProjectRoutesOptions } from './projects.js'
import { queryRoutes } from './queries.js'
import type { QueryRoutesOptions } from './queries.js'
import { competitorRoutes } from './competitors.js'
import { runRoutes } from './runs.js'
import type { RunRoutesOptions } from './runs.js'
import { applyRoutes } from './apply.js'
import type { ApplyRoutesOptions } from './apply.js'
import { historyRoutes } from './history.js'
import { analyticsRoutes } from './analytics.js'
import { intelligenceRoutes } from './intelligence.js'
import { reportRoutes } from './report.js'
import { citationRoutes } from './citations.js'
import { compositeRoutes } from './composites.js'
import { contentRoutes } from './content.js'
import { openApiRoutes } from './openapi.js'
import type { OpenApiInfo } from './openapi.js'
import { settingsRoutes } from './settings.js'
import type { SettingsRoutesOptions, ProviderSummaryEntry, ProviderAdapterInfo } from './settings.js'
import { keysRoutes } from './keys.js'
import { snapshotRoutes } from './snapshot.js'
import type { SnapshotRoutesOptions } from './snapshot.js'
import { telemetryRoutes } from './telemetry.js'
import type { TelemetryRoutesOptions } from './telemetry.js'
import { scheduleRoutes } from './schedules.js'
import type { ScheduleRoutesOptions } from './schedules.js'
import { notificationRoutes, type NotificationRoutesOptions } from './notifications.js'
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
import { backlinksRoutes } from './backlinks.js'
import type { BacklinksRoutesOptions } from './backlinks.js'
import { trafficRoutes, defaultResolveAccessToken } from './traffic.js'
import type { TrafficRoutesOptions, CloudRunCredentialStore } from './traffic.js'
import {
  listWordpressTrafficEvents,
  WordpressTrafficApiError,
} from '@ainyc/canonry-integration-wordpress-traffic'
import {
  listVercelTrafficEvents,
  VercelLogsApiError,
} from '@ainyc/canonry-integration-vercel'
import { doctorRoutes } from './doctor.js'
import { discoveryRoutes } from './discovery/index.js'
import type { DiscoveryRoutesOptions } from './discovery/index.js'
import { CheckStatuses, TrafficSourceTypes } from '@ainyc/canonry-contracts'
import type { BundledSkillSnapshot } from '@ainyc/canonry-contracts'
import type { CheckOutput, TrafficSourceProbe, TrafficSourceValidator } from './doctor/types.js'

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
  /** Callback when a schedule is created/updated/deleted. `kind` scopes which run-kind schedule changed. */
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string, kind: import('@ainyc/canonry-contracts').SchedulableRunKind) => void
  /** Callback when a project is deleted */
  onProjectDeleted?: (projectId: string) => void
  /** Callback when a project is created or updated */
  onProjectUpserted?: (projectId: string, projectName: string) => void
  /**
   * Callback when a project's normalized alias set changes. Wire this up to
   * trigger a fire-and-forget mention-fields backfill so historical snapshots
   * reflect the new aliases. Skipped when only other fields change.
   */
  onAliasesChanged?: (projectId: string, projectName: string) => void
  /** Callback to generate a one-shot AI perception snapshot */
  onSnapshotRequested?: SnapshotRoutesOptions['onSnapshotRequested']
  /** Callback to generate query suggestions using an LLM provider */
  onGenerateQueries?: QueryRoutesOptions['onGenerateQueries']
  /**
   * Optional LLM-backed explainer for content recommendations. When
   * provided, `POST /projects/:name/content/recommendations/:targetRef/analyze`
   * calls it (and caches the response). When omitted, that route returns
   * 503 with `NO_PROVIDER`. Wiring lives in canonry's server.ts where
   * the pi-ai integration + capability-tier model resolution happens —
   * api-routes stays LLM-agnostic.
   */
  explainContentRecommendation?: import('./content.js').ExplainContentRecommendationFn
  /** Telemetry status/toggle callbacks */
  getTelemetryStatus?: TelemetryRoutesOptions['getTelemetryStatus']
  setTelemetryEnabled?: TelemetryRoutesOptions['setTelemetryEnabled']
  /** Google auth config and storage */
  getGoogleAuthConfig?: GoogleRoutesOptions['getGoogleAuthConfig']
  /** Resolved Google Places config for the `gbp.places.api-key` doctor check. */
  getPlacesConfig?: () => { apiKey?: string; tier: 'atmosphere' | 'pro' | 'off'; refreshIntervalDays: number }
  googleConnectionStore?: GoogleRoutesOptions['googleConnectionStore']
  /** Secret for signing OAuth state parameters */
  googleStateSecret?: string
  /** Public URL for OAuth redirect URIs (overrides auto-detect from request headers) */
  publicUrl?: string
  onGscSyncRequested?: GoogleRoutesOptions['onGscSyncRequested']
  onInspectSitemapRequested?: GoogleRoutesOptions['onInspectSitemapRequested']
  onGbpSyncRequested?: GoogleRoutesOptions['onGbpSyncRequested']
  /** Bing Webmaster Tools connection store */
  bingConnectionStore?: BingRoutesOptions['bingConnectionStore']
  /** Bing settings summary for settings endpoint */
  bingSettingsSummary?: SettingsRoutesOptions['bing']
  onBingSettingsUpdate?: SettingsRoutesOptions['onBingUpdate']
  onBingInspectSitemapRequested?: BingRoutesOptions['onInspectSitemapRequested']
  /** WordPress connection store */
  wordpressConnectionStore?: WordpressRoutesOptions['wordpressConnectionStore']
  /** CDP browser provider callbacks */
  getCdpStatus?: CDPRoutesOptions['getCdpStatus']
  onCdpScreenshot?: CDPRoutesOptions['onCdpScreenshot']
  onCdpConfigure?: CDPRoutesOptions['onCdpConfigure']
  /** GA4 credential store — stores service account keys in config, not DB */
  ga4CredentialStore?: Ga4CredentialStore
  /** Cloud Run credential store — stores SA keys / OAuth tokens in config, not DB */
  cloudRunCredentialStore?: CloudRunCredentialStore
  /** Override Cloud Run pull (tests) — see `TrafficRoutesOptions` */
  pullCloudRunEvents?: TrafficRoutesOptions['pullCloudRunEvents']
  /** Override Cloud Run access-token resolver (tests) — see `TrafficRoutesOptions` */
  resolveCloudRunAccessToken?: TrafficRoutesOptions['resolveCloudRunAccessToken']
  /** WordPress traffic-logger credential store — stores Application Passwords in config, not DB */
  wordpressTrafficCredentialStore?: TrafficRoutesOptions['wordpressTrafficCredentialStore']
  /** Override WordPress traffic pull (tests) — see `TrafficRoutesOptions` */
  pullWordpressTrafficEvents?: TrafficRoutesOptions['pullWordpressTrafficEvents']
  /** Vercel traffic credential store — stores Vercel API tokens in config, not DB */
  vercelTrafficCredentialStore?: TrafficRoutesOptions['vercelTrafficCredentialStore']
  /** Override Vercel traffic pull (tests) — see `TrafficRoutesOptions` */
  pullVercelTrafficEvents?: TrafficRoutesOptions['pullVercelTrafficEvents']
  /** Fired after every traffic sync (success OR failure). Used by canonry to emit `traffic.synced` telemetry. */
  onTrafficSynced?: TrafficRoutesOptions['onTrafficSynced']
  /** Discovery feature callback — fires after a discovery_sessions row + matching runs row are inserted. */
  onDiscoveryRunRequested?: DiscoveryRoutesOptions['onDiscoveryRunRequested']
  /** Backlinks feature callbacks — see `backlinksRoutes` for details. */
  getBacklinksStatus?: BacklinksRoutesOptions['getBacklinksStatus']
  onInstallBacklinks?: BacklinksRoutesOptions['onInstallBacklinks']
  onReleaseSyncRequested?: BacklinksRoutesOptions['onReleaseSyncRequested']
  onBacklinkExtractRequested?: BacklinksRoutesOptions['onBacklinkExtractRequested']
  onBacklinksPruneCache?: BacklinksRoutesOptions['onBacklinksPruneCache']
  listCachedReleases?: BacklinksRoutesOptions['listCachedReleases']
  discoverLatestRelease?: BacklinksRoutesOptions['discoverLatestRelease']
  /**
   * API route prefix (default: /api/v1).
   * Override when the server is behind a reverse proxy that does NOT strip the
   * base-path prefix before forwarding — e.g. set to '/canonry/api/v1' when
   * Caddy proxies /canonry/* directly to this server without path rewriting.
   */
  routePrefix?: string
  /**
   * Hook for registering additional routes inside the authenticated plugin
   * scope so they share canonry's API-key + session-cookie auth. Used by
   * the local-only Aero agent routes, which are canonry-specific but must
   * not bypass auth. Cloud deployments pass undefined.
   */
  registerAuthenticatedRoutes?: (scope: FastifyInstance) => Promise<void> | void
  /**
   * Allow webhook URLs that resolve to loopback addresses (127.0.0.0/8 and ::1).
   * Defaults to false — loopback is blocked by default so a cloud deployment
   * cannot be coerced into reaching its own host services (metadata proxies,
   * Redis/Vault, sidecar admin endpoints). Local servers can opt in to preserve
   * dev workflows that point webhooks at localhost.
   */
  allowLoopbackWebhooks?: boolean
  /**
   * On-disk paths the daemon depends on at runtime. When wired, a pre-request
   * hook fails non-doctor / non-health requests with HTTP 503
   * `RUNTIME_STATE_MISSING` if either path has been deleted while the daemon
   * is running. Pairs with the `db.file.present` / `config.file.present`
   * doctor checks. Cloud deployments leave this undefined.
   */
  runtimeStatePaths?: { databasePath: string; configPath?: string | null }
  /**
   * Snapshots (version + per-file hashes) of the agent skills bundled into the
   * running build. Wired by `canonry serve` from its bundled assets; powers the
   * `agent.skills.current` doctor check. Cloud deployments leave this undefined
   * and the check `skipped`.
   */
  bundledSkills?: BundledSkillSnapshot[]
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

  // Runtime-state guard — fail loud if the DB or config file the daemon
  // depends on was deleted out from under it. SQLite holds the file
  // inode open across `unlink`, so without this hook the daemon would
  // keep serving stale data from an orphaned file and the operator's
  // `rm ~/.canonry/data.db` would silently not take effect. Skips the
  // health and doctor endpoints so operators can still diagnose. Only
  // active when `runtimeStatePaths` is wired — cloud deployments leave
  // this undefined (managed DB, no local config).
  if (opts.runtimeStatePaths) {
    const { databasePath, configPath } = opts.runtimeStatePaths
    // Allow-listed paths bypass the guard so an operator can still
    // diagnose the daemon when the files are gone: `/health` for liveness,
    // `/doctor` (and `/projects/<name>/doctor`) for the actual `db.file.missing`
    // / `config.file.missing` check output. Match `/doctor` either at the
    // end of the URL or immediately followed by `?` so query-stringed
    // doctor calls (`?check=db.*`) still pass.
    const isDiagnosticUrl = (url: string) =>
      url === '/health' || /\/doctor(?:\?|$)/.test(url)
    app.addHook('onRequest', async (request) => {
      if (isDiagnosticUrl(request.url)) return
      const missing: string[] = []
      if (!fs.existsSync(databasePath)) missing.push(`database file \`${databasePath}\``)
      if (configPath && !fs.existsSync(configPath)) missing.push(`config file \`${configPath}\``)
      if (missing.length === 0) return
      throw runtimeStateMissing(
        `Runtime state missing: ${missing.join(' and ')}. Restart \`canonry serve\` so a fresh state is created (the daemon's open file handles still point at the deleted inode, so writes are being lost).`,
        { missing },
      )
    })
  }

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

    await api.register(openApiRoutes, { ...opts.openApiInfo, routePrefix: opts.routePrefix })
    await api.register(projectRoutes, {
      onProjectDeleted: opts.onProjectDeleted,
      onProjectUpserted: opts.onProjectUpserted,
      onAliasesChanged: opts.onAliasesChanged,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
    } satisfies ProjectRoutesOptions)
    await api.register(queryRoutes, {
      onGenerateQueries: opts.onGenerateQueries,
      validProviderNames: opts.providerAdapters?.filter(a => a.mode === 'api').map(a => a.name),
    } satisfies QueryRoutesOptions)
    await api.register(competitorRoutes)
    await api.register(runRoutes, {
      onRunCreated: opts.onRunCreated,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
    } satisfies RunRoutesOptions)
    await api.register(applyRoutes, {
      onScheduleUpdated: opts.onScheduleUpdated,
      onProjectUpserted: opts.onProjectUpserted,
      onAliasesChanged: opts.onAliasesChanged,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
      allowLoopbackWebhooks: opts.allowLoopbackWebhooks,
      onGoogleConnectionPropertyUpdated: (domain, connectionType, propertyId) => {
        opts.googleConnectionStore?.updateConnection(domain, connectionType, {
          propertyId,
          updatedAt: new Date().toISOString(),
        })
      },
    } satisfies ApplyRoutesOptions)
    await api.register(historyRoutes)
    await api.register(analyticsRoutes)
    await api.register(intelligenceRoutes)
    await api.register(reportRoutes)
    await api.register(citationRoutes)
    await api.register(compositeRoutes)
    await api.register(contentRoutes, { explainContentRecommendation: opts.explainContentRecommendation })
    await api.register(settingsRoutes, {
      providerSummary: opts.providerSummary,
      providerAdapters: opts.providerAdapters,
      onProviderUpdate: opts.onProviderUpdate,
      google: opts.googleSettingsSummary,
      onGoogleUpdate: opts.onGoogleSettingsUpdate,
      bing: opts.bingSettingsSummary,
      onBingUpdate: opts.onBingSettingsUpdate,
    } satisfies SettingsRoutesOptions)
    await api.register(keysRoutes)
    await api.register(snapshotRoutes, {
      onSnapshotRequested: opts.onSnapshotRequested,
    } satisfies SnapshotRoutesOptions)
    await api.register(scheduleRoutes, {
      onScheduleUpdated: opts.onScheduleUpdated,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
    } satisfies ScheduleRoutesOptions)
    await api.register(notificationRoutes, {
      allowLoopbackWebhooks: opts.allowLoopbackWebhooks,
    } satisfies NotificationRoutesOptions)
    await api.register(telemetryRoutes, {
      getTelemetryStatus: opts.getTelemetryStatus,
      setTelemetryEnabled: opts.setTelemetryEnabled,
    } satisfies TelemetryRoutesOptions)
    await api.register(bingRoutes, {
      bingConnectionStore: opts.bingConnectionStore,
      onInspectSitemapRequested: opts.onBingInspectSitemapRequested,
    } satisfies BingRoutesOptions)
    await api.register(googleRoutes, {
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      googleConnectionStore: opts.googleConnectionStore,
      googleStateSecret: opts.googleStateSecret,
      publicUrl: opts.publicUrl,
      routePrefix: opts.routePrefix,
      onGscSyncRequested: opts.onGscSyncRequested,
      onInspectSitemapRequested: opts.onInspectSitemapRequested,
      onGbpSyncRequested: opts.onGbpSyncRequested,
    } satisfies GoogleRoutesOptions)
    await api.register(wordpressRoutes, {
      wordpressConnectionStore: opts.wordpressConnectionStore,
      routePrefix: opts.routePrefix ?? '/api/v1',
    } satisfies WordpressRoutesOptions)
    await api.register(cdpRoutes, {
      getCdpStatus: opts.getCdpStatus,
      onCdpScreenshot: opts.onCdpScreenshot,
      onCdpConfigure: opts.onCdpConfigure,
      routePrefix: opts.routePrefix,
    } satisfies CDPRoutesOptions)
    await api.register(ga4Routes, {
      ga4CredentialStore: opts.ga4CredentialStore,
      googleConnectionStore: opts.googleConnectionStore,
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
    } satisfies GA4RoutesOptions)
    await api.register(trafficRoutes, {
      cloudRunCredentialStore: opts.cloudRunCredentialStore,
      pullCloudRunEvents: opts.pullCloudRunEvents,
      resolveCloudRunAccessToken: opts.resolveCloudRunAccessToken,
      wordpressTrafficCredentialStore: opts.wordpressTrafficCredentialStore,
      pullWordpressTrafficEvents: opts.pullWordpressTrafficEvents,
      vercelTrafficCredentialStore: opts.vercelTrafficCredentialStore,
      pullVercelTrafficEvents: opts.pullVercelTrafficEvents,
      onTrafficSynced: opts.onTrafficSynced,
      allowLoopbackWebhooks: opts.allowLoopbackWebhooks,
    } satisfies TrafficRoutesOptions)
    // Always mount the backlinks routes so read endpoints (summary, domains,
    // history, sync list) work off the shared DB. Action routes (install,
    // sync, extract, cache prune) throw MISSING_DEPENDENCY when the host
    // doesn't supply the required callback — cloud returns a meaningful
    // error instead of 404.
    await api.register(backlinksRoutes, {
      getBacklinksStatus: opts.getBacklinksStatus,
      onInstallBacklinks: opts.onInstallBacklinks,
      onReleaseSyncRequested: opts.onReleaseSyncRequested,
      onBacklinkExtractRequested: opts.onBacklinkExtractRequested,
      onBacklinksPruneCache: opts.onBacklinksPruneCache,
      listCachedReleases: opts.listCachedReleases,
      discoverLatestRelease: opts.discoverLatestRelease,
    } satisfies BacklinksRoutesOptions)
    await api.register(discoveryRoutes, {
      onDiscoveryRunRequested: opts.onDiscoveryRunRequested,
    } satisfies DiscoveryRoutesOptions)
    await api.register(doctorRoutes, {
      googleConnectionStore: opts.googleConnectionStore,
      bingConnectionStore: opts.bingConnectionStore,
      wordpressConnectionStore: opts.wordpressConnectionStore,
      ga4CredentialStore: opts.ga4CredentialStore,
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      getPlacesConfig: opts.getPlacesConfig,
      publicUrl: opts.publicUrl,
      providerSummary: opts.providerSummary,
      trafficSourceValidators: buildTrafficSourceValidators(opts),
      runtimeStatePaths: opts.runtimeStatePaths,
      bundledSkills: opts.bundledSkills,
    })
    // Local-only extension hook: canonry passes the Aero agent routes here
    // so they live inside the authenticated scope. Cloud leaves it undefined.
    if (opts.registerAuthenticatedRoutes) {
      await opts.registerAuthenticatedRoutes(api)
    }
  }, { prefix: opts.routePrefix ?? '/api/v1' })
}

export type { DatabaseClient } from '@ainyc/canonry-db'
export { queueRunIfProjectIdle } from './run-queue.js'
export {
  executeDiscovery,
  classifyProbeBucket,
  buildCompetitorMap,
  markSessionFailed,
  pickCanonicals,
} from './discovery/index.js'
export type {
  DiscoveryDeps,
  DiscoveryDomainClassification,
  DiscoveryProjectContext,
  DiscoverySeedResult,
  DiscoveryProbeResult,
  ExecuteDiscoveryOptions,
  ExecuteDiscoveryResult,
  OnDiscoveryRunRequested,
} from './discovery/index.js'
export { deliverWebhook, resolveWebhookTarget } from './webhooks.js'
export { redactNotificationDiff, redactNotificationUrl } from './notification-redaction.js'
export type { SafeWebhookTarget } from './webhooks.js'
export type { RunRoutesOptions } from './runs.js'
export { renderReportHtml } from './report-renderer.js'
export type { RenderReportHtmlOptions } from './report-renderer.js'
// Pure GBP summary math — reused by the intelligence service to derive
// per-location signals (window deltas, lodging/CTA flags) for gbp-sync insights.
export {
  buildGbpSummary,
  computeMetricTotals,
  computeWindowDelta,
  computeKeywordCoverage,
  summarizePlaceActions,
  summarizeLodging,
} from './gbp-summary.js'
export type {
  GbpSummary,
  GbpSummaryInput,
  DailyMetricInput,
  KeywordInput,
  PlaceActionInput,
  LodgingInput,
  WindowDelta,
  KeywordCoverage,
  PlaceActionSummary,
  LodgingSummary,
} from './gbp-summary.js'
export type {
  ExplainContentRecommendationFn,
  ExplainContentRecommendationInput,
  ExplainContentRecommendationResult,
} from './content.js'
export { buildOpenApiDocument } from './openapi.js'
export type { OpenApiInfo } from './openapi.js'

/**
 * Build the per-source-type validator map consumed by the generic
 * `traffic.source.credentials` and `traffic.source.scopes` doctor checks.
 *
 * Today only Cloud Run has an adapter, so this returns at most one entry
 * (`'cloud-run'`). Future adapters (WordPress plugin, others) plug in by
 * adding their own entry here behind the same `TrafficSourceValidator`
 * interface — no doctor-side changes needed.
 */
function buildTrafficSourceValidators(opts: ApiRoutesOptions): Record<string, TrafficSourceValidator> | undefined {
  const validators: Record<string, TrafficSourceValidator> = {}
  if (opts.cloudRunCredentialStore) {
    const store = opts.cloudRunCredentialStore
    const resolveToken = opts.resolveCloudRunAccessToken ?? defaultResolveAccessToken
    validators['cloud-run'] = {
      validateCredentials: async (source: TrafficSourceProbe): Promise<CheckOutput> => {
        const record = store.getConnection(source.projectName)
        if (!record) {
          return {
            status: CheckStatuses.fail,
            code: 'traffic.credentials.missing',
            summary: `No Cloud Run credential found in ~/.canonry/config.yaml for project "${source.projectName}".`,
            remediation: 'Re-run `canonry traffic connect cloud-run <project> --gcp-project <id> --service-account-key <path>`.',
          }
        }
        try {
          await resolveToken(record)
          return {
            status: CheckStatuses.ok,
            code: 'traffic.credentials.resolved',
            summary: `Cloud Run access token resolves for "${source.displayName}" (project ${record.gcpProjectId}).`,
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return {
            status: CheckStatuses.fail,
            code: 'traffic.credentials.resolve-failed',
            summary: `Failed to resolve Cloud Run access token: ${msg}.`,
            remediation: 'Verify the service-account key in ~/.canonry/config.yaml is unexpired and well-formed. Re-connect the source if needed.',
          }
        }
      },
      // Cloud Run scopes are implicit in the service-account key — Cloud
      // Logging viewer is the only required scope today, and it's enforced
      // at the IAM layer rather than baked into the token. We surface a
      // skipped result so the framework is uniform without producing a
      // false signal.
      validateScopes: () => null,
    }
  }
  if (opts.wordpressTrafficCredentialStore) {
    const store = opts.wordpressTrafficCredentialStore
    const pullEvents = opts.pullWordpressTrafficEvents ?? listWordpressTrafficEvents
    validators[TrafficSourceTypes.wordpress] = {
      validateCredentials: async (source: TrafficSourceProbe): Promise<CheckOutput> => {
        const record = store.getConnection(source.projectName)
        if (!record) {
          return {
            status: CheckStatuses.fail,
            code: 'traffic.credentials.missing',
            summary: `No WordPress traffic credential found in ~/.canonry/config.yaml for project "${source.projectName}".`,
            remediation: 'Re-run `canonry traffic connect wordpress <project> --url <site> --username <user> --app-password <password>`.',
          }
        }
        try {
          await pullEvents({
            baseUrl: record.baseUrl,
            username: record.username,
            applicationPassword: record.applicationPassword,
            pageSize: 1,
            maxPages: 1,
          })
          return {
            status: CheckStatuses.ok,
            code: 'traffic.credentials.resolved',
            summary: `WordPress endpoint responds for "${source.displayName}" (${new URL(record.baseUrl).host}).`,
          }
        } catch (e) {
          const httpStatus = e instanceof WordpressTrafficApiError ? e.status : null
          const msg = e instanceof Error ? e.message : String(e)
          return {
            status: CheckStatuses.fail,
            code: httpStatus === 401 || httpStatus === 403
              ? 'traffic.credentials.unauthorized'
              : 'traffic.credentials.resolve-failed',
            summary: httpStatus
              ? `WordPress endpoint returned HTTP ${httpStatus}: ${msg}.`
              : `WordPress endpoint probe failed: ${msg}.`,
            remediation: 'Verify the site URL is reachable and the Application Password is valid. Re-connect the source if needed.',
          }
        }
      },
      // WordPress Application Passwords have no scope concept — auth is
      // strictly "valid credential or not". Surface a skipped result so the
      // framework is uniform without producing a false signal.
      validateScopes: () => null,
    }
  }
  if (opts.vercelTrafficCredentialStore) {
    const store = opts.vercelTrafficCredentialStore
    const pullEvents = opts.pullVercelTrafficEvents ?? listVercelTrafficEvents
    validators[TrafficSourceTypes.vercel] = {
      validateCredentials: async (source: TrafficSourceProbe): Promise<CheckOutput> => {
        const record = store.getConnection(source.projectName)
        if (!record) {
          return {
            status: CheckStatuses.fail,
            code: 'traffic.credentials.missing',
            summary: `No Vercel credential found in ~/.canonry/config.yaml for project "${source.projectName}".`,
            remediation: 'Re-run `canonry traffic connect vercel <project> --project-id <prj> --team-id <team> --token <token>`.',
          }
        }
        try {
          // Tiny recent window — we only need an HTTP 2xx to confirm the
          // token + project/team ids resolve against `request-logs`.
          const probeEnd = Date.now()
          await pullEvents({
            token: record.token,
            projectId: record.projectId,
            teamId: record.teamId,
            environment: record.environment,
            startDate: probeEnd - 60 * 60_000,
            endDate: probeEnd,
            maxPages: 1,
          })
          return {
            status: CheckStatuses.ok,
            code: 'traffic.credentials.resolved',
            summary: `Vercel request-logs responds for "${source.displayName}" (project ${record.projectId}).`,
          }
        } catch (e) {
          const httpStatus = e instanceof VercelLogsApiError ? e.status : null
          const msg = e instanceof Error ? e.message : String(e)
          return {
            status: CheckStatuses.fail,
            code: httpStatus === 401 || httpStatus === 403
              ? 'traffic.credentials.unauthorized'
              : 'traffic.credentials.resolve-failed',
            summary: httpStatus
              ? `Vercel request-logs returned HTTP ${httpStatus}: ${msg}.`
              : `Vercel request-logs probe failed: ${msg}.`,
            remediation: 'Verify the Vercel API token is unexpired and the project / team ids are correct. Vercel tokens can expire — re-connect the source with a fresh token if needed.',
          }
        }
      },
      // Vercel API tokens have no granular per-resource scopes — a token
      // inherits the user's team access, so there is no "missing scope"
      // failure mode. Surface a skipped result so the framework stays
      // uniform without producing a false signal.
      validateScopes: () => null,
    }
  }
  return Object.keys(validators).length > 0 ? validators : undefined
}
