import type { FastifyInstance, FastifyError } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { DatabaseClient } from '@ainyc/canonry-db'
import fs from 'node:fs'
import { AppError, runtimeStateMissing, describeError } from '@ainyc/canonry-contracts'
import { authPlugin } from './auth.js'
import { createCredentialChecker, type CredentialChecker } from './user-session.js'
import { resolveOAuthAccessToken } from './oauth.js'
import { projectRoutes } from './projects.js'
import type { ProjectRoutesOptions } from './projects.js'
import { queryRoutes } from './queries.js'
import type { QueryRoutesOptions } from './queries.js'
import { competitorRoutes } from './competitors.js'
import { competitorLandscapeRoutes } from './competitor-landscape.js'
import { runRoutes } from './runs.js'
import type { RunRoutesOptions } from './runs.js'
import { measurementPlanRoutes } from './measurement-plan.js'
import type { MeasurementPlanRoutesOptions } from './measurement-plan.js'
import { measurementServiceRoutes } from './measurement-service.js'
import type { MeasurementServiceRoutesOptions } from './measurement-service.js'
import { measurementDraftRoutes } from './measurement-draft.js'
import type { MeasurementDraftRoutesOptions } from './measurement-draft.js'
import { measurementDiscoveryV2Routes } from './measurement-discovery-v2.js'
import { measurementOverviewRoutes, type MeasurementOverviewCache } from './measurement-overview.js'
import { measurementPropertyEvidenceRoutes } from './measurement-property-evidence.js'
import { measurementPortfolioReadRoutes } from './measurement-portfolio-reads.js'
import { measurementQuestionReadRoutes } from './measurement-question-reads.js'
import { applyRoutes } from './apply.js'
import type { ApplyRoutesOptions } from './apply.js'
import { historyRoutes } from './history.js'
import { analyticsRoutes } from './analytics.js'
import { intelligenceRoutes } from './intelligence.js'
import { reportRoutes } from './report.js'
import { organicEvidenceRoutes } from './organic-evidence.js'
import { citationRoutes } from './citations.js'
import { visibilityStatsRoutes } from './visibility-stats.js'
import { resultsExportRoutes } from './results-export.js'
import { compositeRoutes } from './composites.js'
import { contentRoutes } from './content.js'
import { openApiRoutes } from './openapi.js'
import type { OpenApiInfo } from './openapi.js'
import { settingsRoutes } from './settings.js'
import type { SettingsRoutesOptions, ProviderSummaryEntry, ProviderAdapterInfo } from './settings.js'
import { keysRoutes } from './keys.js'
import { userRoutes } from './users.js'
import { userSessionRoutes } from './user-session.js'
import type { UserSessionCookieOptions } from './user-session.js'
import { snapshotRoutes } from './snapshot.js'
import type { SnapshotRoutesOptions } from './snapshot.js'
import { telemetryRoutes } from './telemetry.js'
import type { TelemetryRoutesOptions } from './telemetry.js'
import { scheduleRoutes } from './schedules.js'
import type { ScheduleRoutesOptions } from './schedules.js'
import { notificationRoutes, type NotificationRoutesOptions } from './notifications.js'
import { googleRoutes } from './google.js'
import type { GoogleRoutesOptions } from './google.js'
import { googleMarketingRoutes } from './google-marketing.js'
import type { GoogleMarketingRoutesOptions } from './google-marketing.js'
import { adsRoutes } from './ads.js'
import type { AdsRoutesOptions } from './ads.js'
import { bingRoutes } from './bing.js'
import type { BingRoutesOptions } from './bing.js'
import { cdpRoutes } from './cdp.js'
import type { CDPRoutesOptions } from './cdp.js'
import { ga4Routes } from './ga.js'
import type { GA4RoutesOptions, Ga4CredentialStore } from './ga.js'
import { gaMeasurementAnalysisRoutes } from './ga-measurement-analysis.js'
import { wordpressRoutes } from './wordpress.js'
import type { WordpressRoutesOptions } from './wordpress.js'
import { backlinksRoutes } from './backlinks.js'
import type { BacklinksRoutesOptions } from './backlinks.js'
import {
  trafficRoutes,
  defaultResolveAccessToken,
  hashCloudflareBearerToken,
} from './traffic.js'
import type { TrafficRoutesOptions, CloudRunCredentialStore } from './traffic.js'
import {
  listWordpressTrafficEvents,
  WordpressTrafficApiError,
} from '@ainyc/canonry-integration-wordpress-traffic'
import {
  listVercelTrafficEvents,
  VercelLogsApiError,
} from '@ainyc/canonry-integration-vercel'
import { doctorRoutes, type DoctorRoutesOptions } from './doctor.js'
import { discoveryRoutes } from './discovery/index.js'
import type { DiscoveryRoutesOptions } from './discovery/index.js'
import { technicalAeoRoutes } from './technical-aeo.js'
import type { TechnicalAeoRoutesOptions } from './technical-aeo.js'
import { researchRoutes } from './research.js'
import type { ResearchRoutesOptions } from './research.js'
import { CheckStatuses, TrafficSourceTypes } from '@ainyc/canonry-contracts'
import type { AgentPluginState, BundledSkillSnapshot } from '@ainyc/canonry-contracts'
import type { CheckOutput, TrafficSourceProbe, TrafficSourceValidator } from './doctor/types.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseClient
  }
}

export { registerOAuthRoutes, registerOAuthAdminRoutes, resolveOAuthAccessToken } from './oauth.js'
export { hashApiKey } from './auth.js'
export type { OAuthRoutesOptions } from './oauth.js'
export type { CredentialChecker } from './user-session.js'
export * from './notifications/alert.js'
export * from './notifications/destinations.js'
export { resolveVercelSyncDeadlineMs, VERCEL_MAX_SYNC_WINDOW_MS, DEFAULT_VERCEL_SYNC_DEADLINE_MS, TRAFFIC_SOURCE_MAX_CATCHUP_MS } from './traffic-limits.js'
export interface ApiRoutesOptions {
  db: DatabaseClient
  /**
   * Absolute URL of the MCP resource, e.g. https://host/api/v1/mcp. Enables
   * OAuth bearer acceptance and is the audience every token is checked against,
   * so a token minted for another resource cannot be replayed here. Undefined
   * leaves OAuth off entirely.
   */
  oauthResourceUrl?: string
  /**
   * Shared credential checker. When the host also mounts the OAuth consent
   * page it MUST pass the same instance both places, or each sign-in door gets
   * its own full brute-force budget.
   */
  credentials?: CredentialChecker
  openApiInfo?: OpenApiInfo
  /** Skip auth for testing */
  skipAuth?: boolean
  /** Optional cookie-backed browser session support */
  sessionCookieName?: string
  resolveSessionApiKeyId?: (sessionId: string) => string | null | Promise<string | null>
  /**
   * Cookie attributes for named-account sign-in sessions. Point `path` at the
   * install's base path when it is mounted under a sub-path. Leave `secure`
   * unset unless you KNOW the install is https-only: unset means it is decided
   * per request from how that request arrived, which is the only thing that
   * gets a TLS-terminating proxy right.
   */
  userSessionCookie?: UserSessionCookieOptions
  /**
   * True when this host has declared which proxy hops to believe (its Fastify
   * instance was built with `trustProxy`). Everything that budgets per caller
   * needs this: without it a forwarded header is just a string the caller
   * chose, and treating it as evidence of a proxy lets an attacker opt out of
   * its own rate limit. Defaults to false — say so explicitly when you mean it.
   */
  trustProxyConfigured?: boolean
  /** Effective project-tab allowlist when the host runs the API in embed mode. */
  embedProjectTabs?: readonly string[]

  /** Callback when a run is created (wire up job runner) */
  onRunCreated?: (runId: string, projectId: string, providers?: string[], location?: import('@ainyc/canonry-contracts').LocationContext | null) => void
  /** Callback after a run is durably cancelled; local hosts use this to abort active work. */
  onRunCancelled?: RunRoutesOptions['onRunCancelled']
  /** Returns providers currently registered and runnable by the host worker. */
  getRunnableProviderNames?: () => readonly string[]
  /**
   * Provider → the model this instance currently has it pointed at. A run
   * freezes the model that will actually answer, so an inherited default that
   * moves shows up as a new measurement series instead of silent drift.
   */
  getEffectiveProviderModels?: () => Readonly<Record<string, string>>
  /** Optional deterministic sitemap-fetch seam for Target discovery tests/hosts. */
  fetchMeasurementSitemap?: MeasurementServiceRoutesOptions['fetchSitemap']
  /** Bounded read-through cache for a server instance's measurement overview aggregates. */
  measurementOverviewCache?: MeasurementOverviewCache
  /** Provider configuration summary for settings endpoint */
  providerSummary?: ProviderSummaryEntry[]
  /** Resolves agent LLM provider key status for the `config.agent-providers` doctor check. See `DoctorContext.getAgentProviderSummary`. */
  getAgentProviderSummary?: () => import('@ainyc/canonry-contracts').AgentProviderOption[]
  /** Offline, secret-free Google Ads/GTM metadata for project Doctor checks. */
  getGoogleMarketingDoctorInput?: DoctorRoutesOptions['getGoogleMarketingDoctorInput']
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
  /** Pre-delete durable cleanup. May throw to abort the database delete. */
  onProjectDeleting?: ProjectRoutesOptions['onProjectDeleting']
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
  /**
   * Optional LLM-backed brief synthesizer for content recommendations. When
   * provided, `POST /projects/:name/content/recommendations/:targetRef/brief`
   * calls it (gated to `ownable` targets, caches the structured result). When
   * omitted, that route returns 503. Same LLM-agnostic wiring story as
   * `explainContentRecommendation`.
   */
  briefContentRecommendation?: import('./content.js').SynthesizeContentBriefFn
  /** Current brief prompt version — scopes the brief cache lookup (see ContentRoutesOptions). */
  briefPromptVersion?: string
  /** Telemetry status/toggle callbacks */
  getTelemetryStatus?: TelemetryRoutesOptions['getTelemetryStatus']
  setTelemetryEnabled?: TelemetryRoutesOptions['setTelemetryEnabled']
  /** Privacy-safe dashboard onboarding milestones. */
  recordOnboardingEvent?: TelemetryRoutesOptions['recordOnboardingEvent']
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
  /** Private project-scoped Google Ads/GTM OAuth credential storage. */
  googleMarketingCredentialStore?: GoogleMarketingRoutesOptions['googleMarketingCredentialStore']
  /** Provider-agnostic OAuth URL/code-exchange adapter for Google Ads and GTM. */
  googleMarketingOAuth?: GoogleMarketingRoutesOptions['googleMarketingOAuth']
  /** Host-provided OAuth scopes; api-routes deliberately has no provider package dependency. */
  googleMarketingOAuthScopes?: GoogleMarketingRoutesOptions['googleMarketingOAuthScopes']
  /** Bounded read-only Google Ads/GTM discovery adapter. */
  googleMarketingLiveReader?: GoogleMarketingRoutesOptions['googleMarketingLiveReader']
  /** Pure stored-evidence integrity evaluator (keeps api-routes free of runtime cycles). */
  assessConversionTrackingIntegrity?: GoogleMarketingRoutesOptions['assessConversionTrackingIntegrity']
  /** Called after a tracked Google Ads sync run commits. */
  onGoogleAdsSyncRequested?: GoogleMarketingRoutesOptions['onGoogleAdsSyncRequested']
  /** Called after a tracked GTM sync run commits. */
  onGtmSyncRequested?: GoogleMarketingRoutesOptions['onGtmSyncRequested']
  adsCredentialStore?: AdsRoutesOptions['adsCredentialStore']
  verifyAdsAccount?: AdsRoutesOptions['verifyAdsAccount']
  adsReader?: AdsRoutesOptions['adsReader']
  adsLiveDeliveryReader?: AdsRoutesOptions['adsLiveDeliveryReader']
  adsLiveDeliveryMinIntervalMs?: AdsRoutesOptions['adsLiveDeliveryMinIntervalMs']
  adsLiveDeliveryMaxPagesPerReaderCall?: AdsRoutesOptions['adsLiveDeliveryMaxPagesPerReaderCall']
  onAdsSyncRequested?: AdsRoutesOptions['onAdsSyncRequested']
  adsOperator?: AdsRoutesOptions['adsOperator']
  adsReconcileSweepIntervalMs?: AdsRoutesOptions['adsReconcileSweepIntervalMs']
  adsReconcilePendingStaleMs?: AdsRoutesOptions['adsReconcilePendingStaleMs']
  adsReconcileBackoffBaseMs?: AdsRoutesOptions['adsReconcileBackoffBaseMs']
  adsReconcileMaxAttempts?: AdsRoutesOptions['adsReconcileMaxAttempts']
  adsReconcileBatchSize?: AdsRoutesOptions['adsReconcileBatchSize']
  adsReconcileLeaseMs?: AdsRoutesOptions['adsReconcileLeaseMs']
  adsAccountVerificationCacheTtlMs?: AdsRoutesOptions['adsAccountVerificationCacheTtlMs']
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
  /** WordPress pull page size override (tests/hosts) — see `TrafficRoutesOptions`. */
  defaultWordpressPageSize?: TrafficRoutesOptions['defaultWordpressPageSize']
  /** WordPress pages allowed in one sync invocation (tests/hosts) — see `TrafficRoutesOptions`. */
  defaultWordpressMaxPages?: TrafficRoutesOptions['defaultWordpressMaxPages']
  /** Vercel traffic credential store — stores Vercel API tokens in config, not DB */
  vercelTrafficCredentialStore?: TrafficRoutesOptions['vercelTrafficCredentialStore']
  /** Override Vercel traffic pull (tests) — see `TrafficRoutesOptions` */
  pullVercelTrafficEvents?: TrafficRoutesOptions['pullVercelTrafficEvents']
  /** Wall-clock budget (ms) for a Vercel sync's adaptive drain — see `TrafficRoutesOptions` */
  vercelSyncDeadlineMs?: TrafficRoutesOptions['vercelSyncDeadlineMs']
  /** Cloudflare Worker traffic credentials — direct-push secrets or Queue API tokens in config, not DB. */
  cloudflareTrafficCredentialStore?: TrafficRoutesOptions['cloudflareTrafficCredentialStore']
  /** Override Cloudflare Queue pull (tests/hosts). */
  pullCloudflareQueueMessages?: TrafficRoutesOptions['pullCloudflareQueueMessages']
  /** Override Cloudflare Queue acknowledgement (tests/hosts). */
  ackCloudflareQueueMessages?: TrafficRoutesOptions['ackCloudflareQueueMessages']
  /** Bounded Cloudflare Queue short-poll batches per traffic sync. */
  cloudflareQueueMaxBatches?: TrafficRoutesOptions['cloudflareQueueMaxBatches']
  /** Override the canonry ingest URL embedded into generated Worker scripts (tests) */
  cloudflareTrafficIngestUrl?: TrafficRoutesOptions['cloudflareTrafficIngestUrl']
  /** Per-source Cloudflare direct-push request budget per minute (tests/hosts). */
  cloudflareIngestRateLimitMax?: TrafficRoutesOptions['cloudflareIngestRateLimitMax']
  /** Early public Cloudflare ingest request budget per caller IP. */
  cloudflareIngestIpRateLimitMax?: TrafficRoutesOptions['cloudflareIngestIpRateLimitMax']
  /** Raw traffic evidence samples retained per source and observed UTC hour. */
  defaultTrafficSampleLimit?: TrafficRoutesOptions['defaultSampleLimit']
  /** Fired after every traffic sync (success OR failure). Used by canonry to emit `traffic.synced` telemetry. */
  onTrafficSynced?: TrafficRoutesOptions['onTrafficSynced']
  /** Discovery feature callback — fires after a discovery_sessions row + matching runs row are inserted. */
  onDiscoveryRunRequested?: DiscoveryRoutesOptions['onDiscoveryRunRequested']
  /** Executes an isolated research batch. Never creates a tracked run or query snapshots. */
  onResearchRunRequested?: ResearchRoutesOptions['onResearchRunRequested']
  /** Discovery harvest seam — extracts issued search queries (fan-out) from a stored probe payload, provider-shaped. Wire to the provider adapter's extractor. */
  harvestSearchQueries?: DiscoveryRoutesOptions['harvestSearchQueries']
  /** Discovery harvest embed seam — embeds query strings for the semantic novelty pass. Wire to the Gemini embedder; unset/rejecting degrades novelty to exact-match. */
  embedQueries?: DiscoveryRoutesOptions['embedQueries']
  /** Technical AEO callback — fires after a `site-audit` run row is created. Wire to `executeSiteAudit`. */
  onSiteAuditRequested?: TechnicalAeoRoutesOptions['onSiteAuditRequested']
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
  /** Live user-global native Canonry plugin state, when available on a local host. */
  getAgentPluginState?: () => AgentPluginState
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
    // Expensive POST-based previews opt in per route. Run after authentication
    // so API keys and named users get independent budgets; unauthenticated test
    // harnesses safely fall back to the caller IP.
    await api.register(rateLimit, {
      global: false,
      hook: 'preHandler',
      keyGenerator: request => request.principal
        ? `${request.principal.kind}:${request.principal.id}`
        : request.ip,
    })

    if (!opts.skipAuth) {
      await authPlugin(api, {
        // A bearer that is not an api key is tried as an OAuth access token.
        // Wired unconditionally: the table is empty until an operator registers
        // a client, so an install with no OAuth in use pays one indexed miss.
        resolveOAuthToken: (token) =>
          opts.oauthResourceUrl
            ? resolveOAuthAccessToken(opts.db, token, opts.oauthResourceUrl)
            : null,
        sessionCookieName: opts.sessionCookieName,
        resolveSessionApiKeyId: opts.resolveSessionApiKeyId,
        userSessionCookie: opts.userSessionCookie,
        embedProjectTabs: opts.embedProjectTabs,
      })
    }

    // Sign-in surface. Registered inside the authenticated scope so it shares
    // the error handler and prefix, but each of its routes is on the auth
    // skip-list — a sign-in screen cannot present a credential it has not been
    // given yet.
    await api.register(userSessionRoutes, {
      cookie: opts.userSessionCookie,
      trustProxyConfigured: opts.trustProxyConfigured ?? false,
      // ONE checker for the whole app. Passed in when the caller supplies it —
      // canonry does, so /auth/login and the OAuth consent page count against
      // the same budgets — and built here otherwise so an embedder that never
      // mounts OAuth still gets the limits.
      credentials: opts.credentials ?? createCredentialChecker({
        db: opts.db,
        trustProxyConfigured: opts.trustProxyConfigured ?? false,
      }),
    })
    await api.register(userRoutes)

    await api.register(openApiRoutes, { ...opts.openApiInfo, routePrefix: opts.routePrefix })
    await api.register(projectRoutes, {
      onProjectDeleting: opts.onProjectDeleting,
      onProjectDeleted: opts.onProjectDeleted,
      onProjectUpserted: opts.onProjectUpserted,
      onAliasesChanged: opts.onAliasesChanged,
      providerAdapters: opts.providerAdapters,
    } satisfies ProjectRoutesOptions)
    await api.register(queryRoutes, {
      onGenerateQueries: opts.onGenerateQueries,
      validProviderNames: opts.providerAdapters?.filter(a => a.mode === 'api').map(a => a.name),
    } satisfies QueryRoutesOptions)
    await api.register(competitorRoutes)
    await api.register(competitorLandscapeRoutes)
    await api.register(runRoutes, {
      onRunCreated: opts.onRunCreated,
      onRunCancelled: opts.onRunCancelled,
      validProviderNames: opts.providerAdapters?.map(a => a.name),
      getRunnableProviderNames: opts.getRunnableProviderNames,
      getEffectiveProviderModels: opts.getEffectiveProviderModels,
    } satisfies RunRoutesOptions)
    await api.register(measurementPlanRoutes, {
      getRunnableProviderNames: opts.getRunnableProviderNames,
    } satisfies MeasurementPlanRoutesOptions)
    await api.register(measurementServiceRoutes, {
      fetchSitemap: opts.fetchMeasurementSitemap,
    } satisfies MeasurementServiceRoutesOptions)
    // Advanced Measurement v2. Registered here so the slices that fill in the
    // handlers never have to touch this file or `openapi.ts`.
    await api.register(measurementDraftRoutes, {
      getRunnableProviderNames: opts.getRunnableProviderNames,
    } satisfies MeasurementDraftRoutesOptions)
    await api.register(measurementDiscoveryV2Routes)
    await api.register(measurementOverviewRoutes, { cache: opts.measurementOverviewCache })
    await api.register(measurementPropertyEvidenceRoutes)
    await api.register(measurementPortfolioReadRoutes)
    await api.register(measurementQuestionReadRoutes)
    await api.register(applyRoutes, {
      onScheduleUpdated: opts.onScheduleUpdated,
      onProjectUpserted: opts.onProjectUpserted,
      onAliasesChanged: opts.onAliasesChanged,
      providerAdapters: opts.providerAdapters,
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
    await api.register(organicEvidenceRoutes)
    await api.register(citationRoutes)
    await api.register(visibilityStatsRoutes)
    await api.register(resultsExportRoutes)
    await api.register(compositeRoutes)
    await api.register(contentRoutes, {
      explainContentRecommendation: opts.explainContentRecommendation,
      briefContentRecommendation: opts.briefContentRecommendation,
      briefPromptVersion: opts.briefPromptVersion,
    })
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
      recordOnboardingEvent: opts.recordOnboardingEvent,
    } satisfies TelemetryRoutesOptions)
    await api.register(adsRoutes, {
      adsCredentialStore: opts.adsCredentialStore,
      verifyAdsAccount: opts.verifyAdsAccount,
      adsReader: opts.adsReader,
      adsLiveDeliveryReader: opts.adsLiveDeliveryReader,
      adsLiveDeliveryMinIntervalMs: opts.adsLiveDeliveryMinIntervalMs,
      adsLiveDeliveryMaxPagesPerReaderCall: opts.adsLiveDeliveryMaxPagesPerReaderCall,
      onAdsSyncRequested: opts.onAdsSyncRequested,
      adsOperator: opts.adsOperator,
      adsReconcileSweepIntervalMs: opts.adsReconcileSweepIntervalMs,
      adsReconcilePendingStaleMs: opts.adsReconcilePendingStaleMs,
      adsReconcileBackoffBaseMs: opts.adsReconcileBackoffBaseMs,
      adsReconcileMaxAttempts: opts.adsReconcileMaxAttempts,
      adsReconcileBatchSize: opts.adsReconcileBatchSize,
      adsReconcileLeaseMs: opts.adsReconcileLeaseMs,
      adsAccountVerificationCacheTtlMs: opts.adsAccountVerificationCacheTtlMs,
    } satisfies AdsRoutesOptions)
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
    await api.register(googleMarketingRoutes, {
      googleMarketingCredentialStore: opts.googleMarketingCredentialStore,
      googleMarketingOAuth: opts.googleMarketingOAuth,
      googleMarketingOAuthScopes: opts.googleMarketingOAuthScopes,
      googleMarketingLiveReader: opts.googleMarketingLiveReader,
      assessConversionTrackingIntegrity: opts.assessConversionTrackingIntegrity,
      onGoogleAdsSyncRequested: opts.onGoogleAdsSyncRequested,
      onGtmSyncRequested: opts.onGtmSyncRequested,
      googleStateSecret: opts.googleStateSecret,
      publicUrl: opts.publicUrl,
      routePrefix: opts.routePrefix,
    } satisfies GoogleMarketingRoutesOptions)
    await api.register(wordpressRoutes, {
      wordpressConnectionStore: opts.wordpressConnectionStore,
      routePrefix: opts.routePrefix ?? '/api/v1',
      allowLoopbackWebhooks: opts.allowLoopbackWebhooks,
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
    await api.register(gaMeasurementAnalysisRoutes)
    await api.register(trafficRoutes, {
      cloudRunCredentialStore: opts.cloudRunCredentialStore,
      pullCloudRunEvents: opts.pullCloudRunEvents,
      resolveCloudRunAccessToken: opts.resolveCloudRunAccessToken,
      wordpressTrafficCredentialStore: opts.wordpressTrafficCredentialStore,
      pullWordpressTrafficEvents: opts.pullWordpressTrafficEvents,
      defaultWordpressPageSize: opts.defaultWordpressPageSize,
      defaultWordpressMaxPages: opts.defaultWordpressMaxPages,
      vercelTrafficCredentialStore: opts.vercelTrafficCredentialStore,
      pullVercelTrafficEvents: opts.pullVercelTrafficEvents,
      vercelSyncDeadlineMs: opts.vercelSyncDeadlineMs,
      cloudflareTrafficCredentialStore: opts.cloudflareTrafficCredentialStore,
      pullCloudflareQueueMessages: opts.pullCloudflareQueueMessages,
      ackCloudflareQueueMessages: opts.ackCloudflareQueueMessages,
      cloudflareQueueMaxBatches: opts.cloudflareQueueMaxBatches,
      cloudflareTrafficIngestUrl: opts.cloudflareTrafficIngestUrl,
      cloudflareIngestRateLimitMax: opts.cloudflareIngestRateLimitMax,
      cloudflareIngestIpRateLimitMax: opts.cloudflareIngestIpRateLimitMax,
      defaultSampleLimit: opts.defaultTrafficSampleLimit,
      onTrafficSynced: opts.onTrafficSynced,
      onScheduleUpdated: opts.onScheduleUpdated,
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
      harvestSearchQueries: opts.harvestSearchQueries,
      embedQueries: opts.embedQueries,
    } satisfies DiscoveryRoutesOptions)
    await api.register(researchRoutes, {
      providerAdapters: opts.providerAdapters,
      configuredProviderNames: opts.providerSummary?.filter(provider => provider.configured).map(provider => provider.name),
      onResearchRunRequested: opts.onResearchRunRequested,
    } satisfies ResearchRoutesOptions)
    await api.register(technicalAeoRoutes, {
      onSiteAuditRequested: opts.onSiteAuditRequested,
    } satisfies TechnicalAeoRoutesOptions)
    await api.register(doctorRoutes, {
      googleConnectionStore: opts.googleConnectionStore,
      bingConnectionStore: opts.bingConnectionStore,
      wordpressConnectionStore: opts.wordpressConnectionStore,
      ga4CredentialStore: opts.ga4CredentialStore,
      adsCredentialStore: opts.adsCredentialStore,
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      getPlacesConfig: opts.getPlacesConfig,
      publicUrl: opts.publicUrl,
      providerSummary: opts.providerSummary,
      getAgentProviderSummary: opts.getAgentProviderSummary,
      trafficSourceValidators: buildTrafficSourceValidators(opts),
      runtimeStatePaths: opts.runtimeStatePaths,
      bundledSkills: opts.bundledSkills,
      getAgentPluginState: opts.getAgentPluginState,
      getGoogleMarketingDoctorInput: opts.getGoogleMarketingDoctorInput,
    })
    // Local-only extension hook: canonry passes the Aero agent routes here
    // so they live inside the authenticated scope. Cloud leaves it undefined.
    if (opts.registerAuthenticatedRoutes) {
      await opts.registerAuthenticatedRoutes(api)
    }
  }, { prefix: opts.routePrefix ?? '/api/v1' })
}

export type { DatabaseClient } from '@ainyc/canonry-db'
// Whether this install has named accounts. The host needs the same answer the
// auth layer uses, so it is exported rather than reimplemented.
export { anyUsersExist, createCredentialChecker, createUserSession, parseCookieHeader, resolveUserSession, serializeUserSessionCookie, USER_SESSION_COOKIE_NAME, USER_SESSION_TTL_MS } from './user-session.js'
export type { UserSessionCookieOptions } from './user-session.js'
export { requireAdminSession, requireBroadInstanceKey, requirePaidReadScope } from './auth.js'
export { assertSameOriginWrite, assertCookieWriteOrigin, FOREIGN_ORIGIN_MESSAGE } from './same-origin.js'
// How a host decides which proxy hops may be believed about who is calling.
export { resolveTrustProxy, resolveCallerKey, hasForwardedHeaders } from './trust-proxy.js'
// Password storage, exported so a host can seed an account without
// reimplementing the derivation that `auth` verifies against.
export { hashUserPassword, verifyUserPassword } from './user-password.js'
export type { AuthPrincipal } from './auth.js'
export { hasActiveMeasurementPlan, queueRunIfProjectIdle } from './run-queue.js'
export { ensureCurrentQueryBasketRevision, latestQueryBasketRevision } from './query-basket.js'
export { nextRunFromCron } from './schedule-utils.js'
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
// Shared public-egress preflight: validates every resolved address class and
// returns the exact address callers must dial to prevent DNS rebinding.
export { resolveMeasurementSitemapTarget as resolvePublicHttpTarget } from './measurement-sitemap-fetch.js'
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
  SynthesizeContentBriefFn,
  SynthesizeContentBriefInput,
  SynthesizeContentBriefResult,
} from './content.js'
export { buildOpenApiDocument } from './openapi.js'
export type { OpenApiInfo } from './openapi.js'
// Pure Target-model engines. They are intentionally network- and DB-free so
// callers can reuse deterministic discovery and historical attribution
// without implying that a read performs sitemap or provider I/O.
export * from './measurement-discovery.js'
export * from './measurement-report.js'
export * from './measurement-run-completeness.js'
// Additive re-export: the runner package needs the same manifest builder and
// stored-report reader the routes use, and the package exposes only this entry.
export { buildMeasurementRunManifest, buildStoredMeasurementReport } from './measurement-report-adapter.js'

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
          const msg = describeError(e)
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
          const msg = describeError(e)
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
          const msg = describeError(e)
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
  if (opts.cloudflareTrafficCredentialStore) {
    const store = opts.cloudflareTrafficCredentialStore
    validators[TrafficSourceTypes.cloudflare] = {
      validateCredentials: (source: TrafficSourceProbe): CheckOutput | null => {
        const sourceMode = source.configJson.deliveryMode
        const deliveryMode = sourceMode === 'queue-pull' ? 'queue-pull' : 'direct-push'

        // A staged pull source and the current direct-push source can coexist
        // for one project. Project-name lookup silently returns the wrong
        // credential in that state, so Doctor always follows the source id.
        const record = store.getConnectionBySourceId(source.id)
        if (!record) {
          const projectRecord = store.getConnection(source.projectName)
          if (projectRecord && projectRecord.sourceId !== source.id) {
            return {
              status: CheckStatuses.fail,
              code: 'traffic.credentials.source-mismatch',
              summary: `The stored Cloudflare credential belongs to a different source than "${source.displayName}".`,
              remediation: 'Reconnect the Cloudflare source to pair the credential and source row.',
            }
          }
          return {
            status: CheckStatuses.fail,
            code: 'traffic.credentials.missing',
            summary: `No Cloudflare ${deliveryMode} credential is stored for source "${source.displayName}".`,
            remediation: 'Re-run `canonry traffic connect cloudflare <project> --zone-id <id>` from the credential-owning host.',
          }
        }
        const recordMode: unknown = record.deliveryMode
        if (recordMode !== deliveryMode) {
          return {
            status: CheckStatuses.fail,
            code: 'traffic.credentials.mode-mismatch',
            summary: `The stored Cloudflare credential mode does not match ${deliveryMode} source "${source.displayName}".`,
            remediation: 'Reconnect the Cloudflare source from the credential-owning host.',
          }
        }
        if (record.sourceId !== source.id) {
          return {
            status: CheckStatuses.fail,
            code: 'traffic.credentials.source-mismatch',
            summary: `The stored Cloudflare credential belongs to a different source than "${source.displayName}".`,
            remediation: 'Reconnect the Cloudflare source to pair the credential and source row.',
          }
        }
        if (record.deliveryMode === 'queue-pull') {
          const queueConfig = source.configJson
          if (
            typeof record.apiToken !== 'string'
            || record.apiToken.length === 0
            || typeof record.accountId !== 'string'
            || record.accountId.length === 0
            || typeof record.queueId !== 'string'
            || record.queueId.length === 0
            || typeof record.queueName !== 'string'
            || record.queueName.length === 0
            || !Number.isInteger(record.retentionSeconds)
            || record.retentionSeconds < 60
            || record.retentionSeconds > 1_209_600
            || queueConfig.accountId !== record.accountId
            || queueConfig.queueId !== record.queueId
            || queueConfig.queueName !== record.queueName
            || queueConfig.retentionSeconds !== record.retentionSeconds
          ) {
            return {
              status: CheckStatuses.fail,
              code: 'traffic.credentials.queue-mismatch',
              summary: `The stored Cloudflare Queue credential does not match source "${source.displayName}".`,
              remediation: 'Reconnect the Cloudflare Queue source from the credential-owning host.',
            }
          }
          return {
            status: CheckStatuses.ok,
            code: 'traffic.credentials.resolved',
            summary: `Cloudflare Queue credentials match source "${source.displayName}".`,
          }
        }

        if (
          typeof record.bearerToken !== 'string'
          || record.bearerToken.length === 0
          || typeof record.hmacSecret !== 'string'
          || record.hmacSecret.length === 0
          || !source.ingestTokenHash
          || hashCloudflareBearerToken(record.bearerToken) !== source.ingestTokenHash
        ) {
          return {
            status: CheckStatuses.fail,
            code: 'traffic.credentials.bearer-mismatch',
            summary: `The stored Cloudflare push credential does not match source "${source.displayName}".`,
            remediation: 'Reconnect the Cloudflare source and redeploy the generated Worker secrets.',
          }
        }
        return {
          status: CheckStatuses.ok,
          code: 'traffic.credentials.resolved',
          summary: `Cloudflare direct-push credentials match source "${source.displayName}".`,
        }
      },
      validateScopes: (source: TrafficSourceProbe): CheckOutput | null => {
        if (source.configJson.deliveryMode !== 'queue-pull') return null
        return {
          status: CheckStatuses.skipped,
          code: 'traffic.scopes.queue-pull-static',
          summary: `Cloudflare Queue token scopes for "${source.displayName}" are not inspected by Doctor.`,
          remediation: `Verify the token has Account Queues Edit permission and run \`wrangler queues consumer http add ${source.configJson.queueName as string}\` for the configured Queue, then re-run the Queue smoke test.`,
        }
      },
    }
  }
  return Object.keys(validators).length > 0 ? validators : undefined
}
