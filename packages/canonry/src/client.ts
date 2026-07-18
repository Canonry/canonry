import { CliError, EXIT_SYSTEM_ERROR, EXIT_USER_ERROR } from './cli-error.js'
import { loadConfig } from './config.js'
import type {
  ProjectDto,
  RunDto,
  RunDetailDto,
  LatestProjectRunDto,
  SiteAuditScoreDto,
  SiteAuditPagesResponseDto,
  SiteAuditTrendResponseDto,
  SiteAuditRunResponseDto,
  SnapshotDiffResponse,
  SnapshotListResponse,
  ScheduleDto,
  NotificationDto,
  SnapshotReportDto,
  BrandMetricsDto,
  GapAnalysisDto,
  SourceBreakdownDto,
  VisibilityStatsDto,
  VisibilityCompareDto,
  LocationContext,
  WordpressAuditIssueDto,
  WordpressAuditPageDto,
  WordpressBulkMetaResultDto,
  WordpressDiffDto,
  WordpressEnv,
  WordpressManualAssistDto,
  WordpressOnboardResultDto,
  WordpressPageDetailDto,
  WordpressPageSummaryDto,
  WordpressSchemaBlockDto,
  WordpressSchemaDeployResultDto,
  WordpressSchemaStatusResultDto,
  WordpressStatusDto,
  GaConnectResponse,
  GaStatusResponse,
  GaSyncResponse,
  GaTrafficResponse,
  GaCoverageResponse,
  GaSocialReferralTrendResponse,
  GaAttributionTrendResponse,
  GA4AiReferralHistoryEntry,
  GA4SocialReferralHistoryEntry,
  GA4SessionHistoryEntry,
  AuditLogEntry,
  GoogleConnectionDto,
  GbpAccountListResponse,
  GbpLocationDto,
  GbpLocationListResponse,
  AdsAccountDto,
  AdsGeoSearchQuery,
  AdsGeoSearchResponse,
  AdsConversionPixelListResponse,
  AdsConversionEventSettingListResponse,
  AdsConnectionStatusDto,
  AdsDisconnectResponse,
  AdsSyncResponse,
  AdsCampaignListResponse,
  AdsInsightsResponse,
  AdsOperationResponse,
  AdsImageUploadRequest,
  AdsCampaignCreateRequest,
  AdsCampaignUpdateRequest,
  AdsAdGroupCreateRequest,
  AdsAdGroupUpdateRequest,
  AdsAdCreateRequest,
  AdsAdUpdateRequest,
  AdsPauseRequest,
  AdsSummaryDto,
  GbpSyncResponse,
  GbpDailyMetricListResponse,
  GbpKeywordImpressionListResponse,
  GbpPlaceActionListResponse,
  GbpLodgingListResponse,
  GbpAttributesListResponse,
  GbpPlaceDetailsListResponse,
  GbpSummaryDto,
  GscSearchDataDto,
  GscPerformanceDailyDto,
  GscUrlInspectionDto,
  GscCoverageSummaryDto,
  GscCoverageSnapshotDto,
  InsightDto,
  HealthSnapshotDto,
  CitationVisibilityResponse,
  BingCoverageSnapshotDto,
  AgentProvidersResponse,
  BacklinkHistoryEntry,
  BacklinkListResponse,
  BacklinkSource,
  BacklinkSourcesResponseDto,
  BacklinkSummaryDto,
  BacklinksInstallResultDto,
  BacklinksInstallStatusDto,
  CcAvailableRelease,
  CcCachedRelease,
  CcReleaseSyncDto,
  AgentMemoryEntryDto,
  AgentMemoryListResponse,
  AgentMemoryUpsertRequest,
  ContentTargetsResponseDto,
  ContentSourcesResponseDto,
  ContentGapsResponseDto,
  DomainClassificationsResponseDto,
  RecommendationBriefDto,
  WinnabilityClass,
  CompetitorDto,
  KeywordDto,
  QueryDto,
  ProjectOverviewDto,
  ProjectSearchResponseDto,
  DoctorReportDto,
  ProjectReportDto,
  ReportPeriodDays,
  TrafficSourceDto,
  TrafficSourceDetailDto,
  TrafficSourceListResponse,
  TrafficStatusResponse,
  TrafficEventsResponse,
  TrafficConnectCloudRunRequest,
  TrafficConnectWordpressRequest,
  TrafficConnectVercelRequest,
  TrafficSyncResponse,
  TrafficBackfillResponse,
  DiscoverySessionDto,
  DiscoverySessionDetailDto,
  DiscoveryHarvestDto,
  DiscoveryPromotePreview,
  DiscoveryPromoteRequest,
  DiscoveryPromoteResult,
  ApiKeyDto,
  ApiKeyListDto,
  CreateApiKeyRequest,
  CreatedApiKeyDto,
  ResultsExportFormat,
} from '@ainyc/canonry-contracts'
import {
  createClient as createHeyClient,
  type Client,
  // Agent (canonry-local routes — included in SDK since codegen was set to
  // `includeCanonryLocal: true` in v4.50.0; previously called via raw fetch).
  deleteApiV1ProjectsByNameAgentMemory,
  deleteApiV1ProjectsByNameAgentTranscript,
  getApiV1ProjectsByNameAgentMemory,
  getApiV1ProjectsByNameAgentProviders,
  getApiV1ProjectsByNameAgentTranscript,
  putApiV1ProjectsByNameAgentMemory,
  // Projects
  getApiV1Projects,
  getApiV1ProjectsByName,
  putApiV1ProjectsByName,
  deleteApiV1ProjectsByName,
  getApiV1ProjectsByNameDeletePreview,
  getApiV1ProjectsByNameExport,
  getApiV1ProjectsByNameOverview,
  getApiV1ProjectsByNameSearch,
  getApiV1ProjectsByNameReport,
  postApiV1Apply,
  // Queries / keywords / competitors
  getApiV1ProjectsByNameQueries,
  putApiV1ProjectsByNameQueries,
  postApiV1ProjectsByNameQueries,
  deleteApiV1ProjectsByNameQueries,
  postApiV1ProjectsByNameQueriesReplacePreview,
  postApiV1ProjectsByNameQueriesGenerate,
  getApiV1ProjectsByNameKeywords,
  putApiV1ProjectsByNameKeywords,
  postApiV1ProjectsByNameKeywords,
  deleteApiV1ProjectsByNameKeywords,
  postApiV1ProjectsByNameKeywordsGenerate,
  getApiV1ProjectsByNameCompetitors,
  postApiV1ProjectsByNameCompetitors,
  deleteApiV1ProjectsByNameCompetitors,
  // Runs / timeline / history / snapshots
  getApiV1ProjectsByNameRuns,
  type GetApiV1ProjectsByNameRunsData,
  postApiV1ProjectsByNameRuns,
  getApiV1ProjectsByNameRunsLatest,
  getApiV1RunsById,
  postApiV1RunsByIdCancel,
  getApiV1ProjectsByNameTimeline,
  getApiV1ProjectsByNameHistory,
  getApiV1History,
  getApiV1ProjectsByNameSnapshots,
  getApiV1ProjectsByNameSnapshotsDiff,
  // Analytics
  getApiV1ProjectsByNameAnalyticsMetrics,
  getApiV1ProjectsByNameAnalyticsGaps,
  getApiV1ProjectsByNameAnalyticsSources,
  // Settings / snapshot / telemetry
  getApiV1Settings,
  putApiV1SettingsProvidersByName,
  postApiV1Snapshot,
  getApiV1Telemetry,
  putApiV1Telemetry,
  // API key management
  getApiV1Keys,
  getApiV1KeysSelf,
  postApiV1Keys,
  postApiV1KeysByIdRevoke,
  // Schedules / notifications
  getApiV1ProjectsByNameSchedule,
  putApiV1ProjectsByNameSchedule,
  deleteApiV1ProjectsByNameSchedule,
  getApiV1ProjectsByNameNotifications,
  postApiV1ProjectsByNameNotifications,
  deleteApiV1ProjectsByNameNotificationsById,
  postApiV1ProjectsByNameNotificationsByIdTest,
  // Locations
  getApiV1ProjectsByNameLocations,
  postApiV1ProjectsByNameLocations,
  deleteApiV1ProjectsByNameLocationsByLabel,
  putApiV1ProjectsByNameLocationsDefault,
  // Google connections
  postApiV1ProjectsByNameGoogleConnect,
  getApiV1ProjectsByNameGoogleConnections,
  deleteApiV1ProjectsByNameGoogleConnectionsByType,
  getApiV1ProjectsByNameGoogleProperties,
  putApiV1ProjectsByNameGoogleConnectionsByTypeProperty,
  putApiV1ProjectsByNameGoogleConnectionsByTypeSitemap,
  // Google Business Profile
  getApiV1ProjectsByNameGbpAccounts,
  postApiV1ProjectsByNameGbpLocationsDiscover,
  getApiV1ProjectsByNameGbpLocations,
  putApiV1ProjectsByNameGbpLocationsByLocationNameSelection,
  deleteApiV1ProjectsByNameGbpConnection,
  postApiV1ProjectsByNameAdsConnect,
  postApiV1ProjectsByNameAdsSync,
  deleteApiV1ProjectsByNameAdsConnection,
  getApiV1ProjectsByNameAdsStatus,
  getApiV1ProjectsByNameAdsAccount,
  getApiV1ProjectsByNameAdsGeoSearch,
  getApiV1ProjectsByNameAdsConversionsPixels,
  getApiV1ProjectsByNameAdsConversionsEventSettings,
  getApiV1ProjectsByNameAdsCampaigns,
  getApiV1ProjectsByNameAdsInsights,
  getApiV1ProjectsByNameAdsSummary,
  getApiV1ProjectsByNameAdsOperationsByOperationKey,
  postApiV1ProjectsByNameAdsFiles,
  postApiV1ProjectsByNameAdsCampaigns,
  postApiV1ProjectsByNameAdsCampaignsById,
  postApiV1ProjectsByNameAdsCampaignsByIdPause,
  postApiV1ProjectsByNameAdsAdGroups,
  postApiV1ProjectsByNameAdsAdGroupsById,
  postApiV1ProjectsByNameAdsAdGroupsByIdPause,
  postApiV1ProjectsByNameAdsAds,
  postApiV1ProjectsByNameAdsAdsById,
  postApiV1ProjectsByNameAdsAdsByIdPause,
  postApiV1ProjectsByNameGbpSync,
  getApiV1ProjectsByNameGbpMetrics,
  getApiV1ProjectsByNameGbpKeywords,
  getApiV1ProjectsByNameGbpPlaceActions,
  getApiV1ProjectsByNameGbpLodging,
  getApiV1ProjectsByNameGbpAttributes,
  getApiV1ProjectsByNameGbpPlaces,
  getApiV1ProjectsByNameGbpSummary,
  // GSC
  postApiV1ProjectsByNameGoogleGscSync,
  getApiV1ProjectsByNameGoogleGscPerformance,
  getApiV1ProjectsByNameGoogleGscPerformanceDaily,
  postApiV1ProjectsByNameGoogleGscInspect,
  getApiV1ProjectsByNameGoogleGscInspections,
  getApiV1ProjectsByNameGoogleGscDeindexed,
  getApiV1ProjectsByNameGoogleGscCoverage,
  getApiV1ProjectsByNameGoogleGscCoverageHistory,
  postApiV1ProjectsByNameGoogleGscInspectSitemap,
  getApiV1ProjectsByNameGoogleGscSitemaps,
  postApiV1ProjectsByNameGoogleGscDiscoverSitemaps,
  // Google Indexing
  postApiV1ProjectsByNameGoogleIndexingRequest,
  // Bing
  postApiV1ProjectsByNameBingConnect,
  deleteApiV1ProjectsByNameBingDisconnect,
  getApiV1ProjectsByNameBingStatus,
  getApiV1ProjectsByNameBingSites,
  postApiV1ProjectsByNameBingSetSite,
  getApiV1ProjectsByNameBingCoverage,
  getApiV1ProjectsByNameBingCoverageHistory,
  getApiV1ProjectsByNameBingInspections,
  postApiV1ProjectsByNameBingInspectUrl,
  postApiV1ProjectsByNameBingInspectSitemap,
  postApiV1ProjectsByNameBingRequestIndexing,
  getApiV1ProjectsByNameBingPerformance,
  // CDP
  getApiV1CdpStatus,
  postApiV1CdpScreenshot,
  getApiV1ProjectsByNameRunsByRunIdBrowserDiff,
  // GA4
  postApiV1ProjectsByNameGaConnect,
  deleteApiV1ProjectsByNameGaDisconnect,
  getApiV1ProjectsByNameGaStatus,
  postApiV1ProjectsByNameGaSync,
  getApiV1ProjectsByNameGaTraffic,
  getApiV1ProjectsByNameGaCoverage,
  getApiV1ProjectsByNameGaAiReferralHistory,
  getApiV1ProjectsByNameGaSocialReferralHistory,
  getApiV1ProjectsByNameGaSocialReferralTrend,
  getApiV1ProjectsByNameGaAttributionTrend,
  getApiV1ProjectsByNameGaSessionHistory,
  // Traffic
  postApiV1ProjectsByNameTrafficConnectCloudRun,
  postApiV1ProjectsByNameTrafficConnectWordpress,
  postApiV1ProjectsByNameTrafficConnectVercel,
  postApiV1ProjectsByNameTrafficSourcesByIdSync,
  postApiV1ProjectsByNameTrafficSourcesByIdBackfill,
  postApiV1ProjectsByNameTrafficSourcesByIdReset,
  getApiV1ProjectsByNameTrafficSources,
  getApiV1ProjectsByNameTrafficStatus,
  getApiV1ProjectsByNameTrafficSourcesById,
  getApiV1ProjectsByNameTrafficEvents,
  // Discovery
  postApiV1ProjectsByNameDiscoverRun,
  getApiV1ProjectsByNameDiscoverSessions,
  getApiV1ProjectsByNameDiscoverSessionsById,
  getApiV1ProjectsByNameDiscoverSessionsByIdHarvest,
  getApiV1ProjectsByNameDiscoverSessionsByIdPromote,
  postApiV1ProjectsByNameDiscoverSessionsByIdPromote,
  // Technical AEO (site-audit)
  getApiV1ProjectsByNameTechnicalAeo,
  getApiV1ProjectsByNameTechnicalAeoPages,
  getApiV1ProjectsByNameTechnicalAeoTrend,
  postApiV1ProjectsByNameTechnicalAeoRuns,
  // Wordpress
  postApiV1ProjectsByNameWordpressConnect,
  deleteApiV1ProjectsByNameWordpressDisconnect,
  getApiV1ProjectsByNameWordpressStatus,
  getApiV1ProjectsByNameWordpressPages,
  getApiV1ProjectsByNameWordpressPage,
  postApiV1ProjectsByNameWordpressPages,
  putApiV1ProjectsByNameWordpressPage,
  postApiV1ProjectsByNameWordpressPageMeta,
  postApiV1ProjectsByNameWordpressPagesMetaBulk,
  getApiV1ProjectsByNameWordpressSchema,
  postApiV1ProjectsByNameWordpressSchemaManual,
  postApiV1ProjectsByNameWordpressSchemaDeploy,
  getApiV1ProjectsByNameWordpressSchemaStatus,
  postApiV1ProjectsByNameWordpressOnboard,
  getApiV1ProjectsByNameWordpressLlmsTxt,
  postApiV1ProjectsByNameWordpressLlmsTxtManual,
  getApiV1ProjectsByNameWordpressAudit,
  getApiV1ProjectsByNameWordpressDiff,
  getApiV1ProjectsByNameWordpressStagingStatus,
  postApiV1ProjectsByNameWordpressStagingPush,
  // Insights
  getApiV1ProjectsByNameInsights,
  getApiV1ProjectsByNameInsightsById,
  postApiV1ProjectsByNameInsightsByIdDismiss,
  // Content / health / search / report / doctor / citation visibility
  getApiV1ProjectsByNameContentTargets,
  getApiV1ProjectsByNameContentSources,
  getApiV1ProjectsByNameContentGaps,
  getApiV1ProjectsByNameContentDomainClassifications,
  getApiV1ProjectsByNameContentRecommendationsByTargetRefBrief,
  postApiV1ProjectsByNameContentRecommendationsByTargetRefBrief,
  getApiV1ProjectsByNameHealthLatest,
  getApiV1ProjectsByNameHealthHistory,
  getApiV1ProjectsByNameCitationsVisibility,
  getApiV1ProjectsByNameVisibilityStats,
  getApiV1ProjectsByNameVisibilityCompare,
  getApiV1Doctor,
  getApiV1ProjectsByNameDoctor,
  // Backlinks
  getApiV1BacklinksStatus,
  postApiV1BacklinksInstall,
  postApiV1BacklinksSyncs,
  getApiV1BacklinksLatestRelease,
  getApiV1BacklinksSyncsLatest,
  getApiV1BacklinksSyncs,
  getApiV1BacklinksReleases,
  deleteApiV1BacklinksCacheByRelease,
  postApiV1ProjectsByNameBacklinksExtract,
  postApiV1ProjectsByNameBacklinksBingSync,
  getApiV1ProjectsByNameBacklinksSummary,
  getApiV1ProjectsByNameBacklinksDomains,
  getApiV1ProjectsByNameBacklinksHistory,
  getApiV1ProjectsByNameBacklinksSources,
} from '@ainyc/canonry-api-client'

export type { BrandMetricsDto, GapAnalysisDto, SourceBreakdownDto, AuditLogEntry, CompetitorDto, KeywordDto, QueryDto }

/** Settings response from GET /settings */
export interface SettingsDto {
  providers: Array<{ name: string; displayName: string; configured: boolean; healthy?: boolean; model?: string; quota?: object }>
  google?: object
  bing?: object
}

/** Apply response */
export type ApplyResultDto = ProjectDto

export interface ProjectDeletePreviewDto {
  project: { id: string; name: string }
  cascadeRows: {
    queries: number
    competitors: number
    runs: number
    snapshots: number
    insights: number
  }
  detachedRows: {
    auditLog: number
  }
}

export interface QueriesReplacePreviewDto {
  project: { id: string; name: string }
  current: string[]
  proposed: string[]
  diff: { added: string[]; removed: string[]; unchanged: string[] }
  snapshotImpact: { affectedQueries: number; snapshotsDetached: number }
}

/** Telemetry status */
export interface TelemetryDto {
  enabled: boolean
  anonymousId?: string
}

/** Aero transcript response from GET /projects/{name}/agent/transcript. Loose shape — messages are pi-agent-core `AgentMessage` union types which we don't re-export here. */
export interface AgentTranscriptDto {
  messages: Array<{ role: string; content: unknown; timestamp?: number; [k: string]: unknown }>
  modelProvider: string | null
  modelId: string | null
  updatedAt: string | null
}

export interface TimelineDto {
  query: string
  runs: {
    runId: string
    createdAt: string
    citationState: string
    transition: string
  }[]
}

/** Export DTO */
export interface ExportDto {
  apiVersion: string
  kind: string
  metadata: { name: string; labels?: Record<string, string> }
  spec: object
  results?: unknown
}

/** CDP status DTO */
export interface CdpStatusDto {
  connected: boolean
  endpoint?: string
  version?: string
  browserVersion?: string
  targets: Array<{ name: string; alive: boolean; lastUsed?: string }>
}

/** CDP screenshot result DTO */
export interface CdpScreenshotResultDto {
  results: Array<{
    target: string
    screenshotPath: string
    answerText: string
    citations: { uri: string; title: string }[]
  }>
}

/** Response shape of POST /projects/:name/discover/run */
export interface DiscoveryRunStartResponse {
  runId: string
  sessionId: string
  status: 'running'
  /**
   * True when the request landed on an already-in-flight session for the same
   * project + ICP. Returned IDs point at the existing session; no new
   * orchestrator run was kicked off and the caller's `dedupThreshold` /
   * `maxProbes` were ignored. Issue #498.
   */
  consolidated: boolean
}

/**
 * Create an ApiClient using the loaded config.
 * This is the canonical way to get a client — it ensures basePath and env var
 * overrides (CANONRY_PORT, CANONRY_BASE_PATH) are always incorporated.
 *
 * When no basePath is configured locally (config.yaml or CANONRY_BASE_PATH env),
 * the client will auto-discover it from the server's /health endpoint on the
 * first API call.
 */
export function createApiClient(): ApiClient {
  const config = loadConfig()
  // basePath is already resolved if configured in config.yaml or env var.
  // Also treat an explicitly-set CANONRY_BASE_PATH (even empty) as resolved,
  // since the user is deliberately controlling the value.
  const basePathResolved = !!config.basePath || 'CANONRY_BASE_PATH' in process.env
  return new ApiClient(config.apiUrl, config.apiKey, { skipProbe: basePathResolved })
}

/**
 * Shape returned by the generated SDK operations. The SDK never throws on
 * non-2xx responses — it returns `{ data, error, request, response }` and lets
 * the caller decide. `invoke()` consumes this shape and throws `CliError`.
 *
 * `data` is typed `unknown` deliberately: routes whose spec used
 * `looseObjectSchema` or `rawJsonResponse` generate `{ [k: string]: unknown }`
 * data types, which don't match the hand-written DTOs every ApiClient method
 * declares. The `as TData` cast inside `invoke()` widens that back. Once the
 * spec registers proper schemas for every route, this can tighten back to
 * `data?: TData`.
 */
type SdkResult = {
  data?: unknown
  error?: unknown
  request: Request
  response: Response
}

export class ApiClient {
  private originUrl: string
  private apiKey: string
  private probePromise: Promise<void> | null = null
  private probeSkipped: boolean
  private heyClient: Client
  /** Tracks the base URL most recently applied to `heyClient` so probe-driven updates only re-configure when something actually changed. */
  private heyClientBaseUrl: string

  constructor(baseUrl: string, apiKey: string, opts?: { skipProbe?: boolean }) {
    this.originUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
    this.probeSkipped = opts?.skipProbe ?? false
    this.heyClientBaseUrl = this.originUrl
    this.heyClient = createHeyClient({ baseUrl: this.originUrl, apiKey: this.apiKey })
  }

  /**
   * On first API call, probe /health to auto-discover basePath when the user
   * hasn't configured one locally. This lets `canonry run` in a separate shell
   * discover that the server is running at e.g. /canonry/ without requiring
   * config.yaml edits or CANONRY_BASE_PATH in every shell.
   */
  private probeBasePath(): Promise<void> {
    if (this.probeSkipped) return Promise.resolve()
    if (!this.probePromise) {
      this.probePromise = (async () => {
        try {
          const origin = new URL(this.originUrl).origin
          const res = await fetch(`${origin}/health`, {
            signal: AbortSignal.timeout(2000),
          })
          if (res.ok) {
            const body = (await res.json()) as { basePath?: string }
            if (body.basePath && typeof body.basePath === 'string') {
              const normalized = '/' + body.basePath.replace(/^\/|\/$/g, '')
              if (normalized !== '/') {
                this.originUrl = origin + normalized
              }
            }
          }
        } catch {
          // Health probe failed (server not reachable, timeout, etc.) —
          // proceed with the locally-configured URL. The actual API call
          // will surface its own connection error.
        }
      })()
    }
    return this.probePromise
  }

  /** Apply the probe's discovered base URL to `heyClient` if it changed since last call. */
  private refreshHeyClientBaseUrl(): void {
    if (this.originUrl !== this.heyClientBaseUrl) {
      this.heyClient.setConfig({ baseUrl: this.originUrl, headers: { authorization: `Bearer ${this.apiKey}` } })
      this.heyClientBaseUrl = this.originUrl
    }
  }

  /**
   * Wrap a generated SDK call with probe, tracing, and CliError mapping.
   * The SDK returns `{ data?, error?, request, response }` — this turns that
   * into either the unwrapped data (success) or a thrown CliError.
   */
  private async invoke<TData>(call: () => Promise<SdkResult>): Promise<TData> {
    await this.probeBasePath()
    this.refreshHeyClientBaseUrl()

    const traceEnabled = process.env.CANONRY_TRACE === '1'
    const traceStart = traceEnabled ? Date.now() : 0

    let result: SdkResult
    try {
      result = await call()
    } catch (err) {
      if (err instanceof CliError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (traceEnabled) {
        process.stderr.write(`[trace] (sdk-call) → ERROR (${Date.now() - traceStart}ms): ${msg}\n`)
      }
      if (
        msg.includes('fetch failed') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('connect ECONNREFUSED')
      ) {
        throw new CliError({
          code: 'CONNECTION_ERROR',
          message:
            `Could not connect to canonry server at ${this.originUrl}. ` +
            'Start it with "canonry serve" (or "canonry serve &" to run in background).',
          exitCode: EXIT_SYSTEM_ERROR,
        })
      }
      throw new CliError({ code: 'CONNECTION_ERROR', message: msg, exitCode: EXIT_SYSTEM_ERROR })
    }

    if (traceEnabled) {
      const durMs = Date.now() - traceStart
      process.stderr.write(
        `[trace] ${result.request.method} ${result.request.url} → ${result.response.status} (${durMs}ms)\n`,
      )
    }

    // Every operation routed through ApiClient is a JSON API operation. A
    // successful HTML document means a reverse-proxy or base-path miss fell
    // through to the dashboard SPA; don't let that masquerade as a connection
    // failure later when a command tries to read it as a DTO.
    const contentType = result.response.headers.get('content-type')
    if (result.response.ok && contentType?.toLowerCase().startsWith('text/html')) {
      throw new CliError({
        code: 'UNEXPECTED_RESPONSE_FORMAT',
        message:
          `Expected a JSON response from the canonry API at ${result.request.url}, ` +
          `but received ${contentType} (HTTP ${result.response.status}). ` +
          'Check the server URL and base path.',
        exitCode: EXIT_SYSTEM_ERROR,
        details: {
          requestUrl: result.request.url,
          contentType,
          httpStatus: result.response.status,
        },
      })
    }

    if (result.error !== undefined && result.error !== null) {
      const errorObj =
        typeof result.error === 'object' &&
        result.error !== null &&
        'error' in result.error &&
        typeof (result.error as { error?: unknown }).error === 'object' &&
        (result.error as { error?: unknown }).error !== null
          ? (result.error as { error: { code?: string; message?: string; details?: Record<string, unknown> } }).error
          : null
      const msg = errorObj?.message
        ? String(errorObj.message)
        : `HTTP ${result.response.status}: ${result.response.statusText}`
      const code = errorObj?.code ? String(errorObj.code) : 'API_ERROR'
      const exitCode = result.response.status >= 500 ? EXIT_SYSTEM_ERROR : EXIT_USER_ERROR
      throw new CliError({
        code,
        message: msg,
        exitCode,
        details: { ...(errorObj?.details ?? {}), httpStatus: result.response.status },
      })
    }

    return result.data as TData
  }

  // ── Agent (canonry-local routes — SDK-typed since v4.50.0) ─────────────
  //
  // These endpoints live in `packages/canonry/src/agent/agent-routes.ts` and
  // are registered through `apiRoutes.registerAuthenticatedRoutes`, not the
  // shared `routeCatalog`. They appear in the OpenAPI spec only when the
  // caller passes `includeCanonryLocal: true` to `buildOpenApiDocument` —
  // which canonry's own server and the codegen both do, so they're in the
  // generated SDK and we route them through `invoke()` like every other
  // endpoint. The SSE `POST /agent/prompt` is intentionally not here — it
  // stays on `streamPost()` below since the SDK can't represent SSE cleanly.

  async getAgentTranscript(project: string): Promise<AgentTranscriptDto> {
    return this.invoke<AgentTranscriptDto>(() =>
      getApiV1ProjectsByNameAgentTranscript({ client: this.heyClient, path: { name: project } }),
    )
  }

  async resetAgentTranscript(project: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameAgentTranscript({ client: this.heyClient, path: { name: project } }),
    )
  }

  async listAgentProviders(project: string): Promise<AgentProvidersResponse> {
    return this.invoke<AgentProvidersResponse>(() =>
      getApiV1ProjectsByNameAgentProviders({ client: this.heyClient, path: { name: project } }),
    )
  }

  async listAgentMemory(project: string): Promise<AgentMemoryListResponse> {
    return this.invoke<AgentMemoryListResponse>(() =>
      getApiV1ProjectsByNameAgentMemory({ client: this.heyClient, path: { name: project } }),
    )
  }

  async setAgentMemory(
    project: string,
    body: AgentMemoryUpsertRequest,
  ): Promise<{ status: 'ok'; entry: AgentMemoryEntryDto }> {
    return this.invoke<{ status: 'ok'; entry: AgentMemoryEntryDto }>(() =>
      putApiV1ProjectsByNameAgentMemory({ client: this.heyClient, path: { name: project }, body }),
    )
  }

  async forgetAgentMemory(project: string, key: string): Promise<{ status: 'forgotten' | 'missing'; key: string }> {
    return this.invoke<{ status: 'forgotten' | 'missing'; key: string }>(() =>
      deleteApiV1ProjectsByNameAgentMemory({
        client: this.heyClient,
        path: { name: project },
        body: { key },
      }),
    )
  }

  /**
   * POST a request whose response body the caller intends to consume as a
   * stream (e.g. the Aero agent SSE endpoint). Shares the probe + auth +
   * structured-error behavior of `request()`; the caller reads `res.body`
   * and releases the response when done.
   */
  async streamPost(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    await this.probeBasePath()
    const url = `${this.originUrl}/api/v1${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }

    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}), signal })
    } catch (err) {
      if (err instanceof CliError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED')) {
        throw new CliError({
          code: 'CONNECTION_ERROR',
          message:
            `Could not connect to canonry server at ${this.originUrl}. ` +
            'Start it with "canonry serve" (or "canonry serve &" to run in background).',
          exitCode: EXIT_SYSTEM_ERROR,
        })
      }
      throw new CliError({ code: 'CONNECTION_ERROR', message: msg, exitCode: EXIT_SYSTEM_ERROR })
    }

    if (!res.ok || !res.body) {
      let errorBody: unknown
      try {
        errorBody = await res.json()
      } catch {
        errorBody = { error: { code: 'UNKNOWN', message: res.statusText } }
      }
      const errorObj =
        errorBody && typeof errorBody === 'object' && 'error' in errorBody && errorBody.error
          ? (errorBody.error as { code?: string; message?: string })
          : null
      const msg = errorObj?.message ? String(errorObj.message) : `HTTP ${res.status}: ${res.statusText}`
      const code = errorObj?.code ? String(errorObj.code) : 'API_ERROR'
      const exitCode = res.status >= 500 ? EXIT_SYSTEM_ERROR : EXIT_USER_ERROR
      throw new CliError({ code, message: msg, exitCode, details: { httpStatus: res.status } })
    }

    return res
  }

  // ── Projects ────────────────────────────────────────────────────────────

  async putProject(name: string, body: object): Promise<ProjectDto> {
    return this.invoke<ProjectDto>(() =>
      putApiV1ProjectsByName({ client: this.heyClient, path: { name }, body: body as never }),
    )
  }

  async listProjects(): Promise<ProjectDto[]> {
    return this.invoke<ProjectDto[]>(() => getApiV1Projects({ client: this.heyClient }))
  }

  async getProject(name: string): Promise<ProjectDto> {
    return this.invoke<ProjectDto>(() => getApiV1ProjectsByName({ client: this.heyClient, path: { name } }))
  }

  async deleteProject(name: string): Promise<void> {
    await this.invoke<unknown>(() => deleteApiV1ProjectsByName({ client: this.heyClient, path: { name } }))
  }

  async previewProjectDelete(name: string): Promise<ProjectDeletePreviewDto> {
    return this.invoke<ProjectDeletePreviewDto>(() =>
      getApiV1ProjectsByNameDeletePreview({ client: this.heyClient, path: { name } }),
    )
  }

  async getStatus(project: string): Promise<ProjectDto> {
    return this.invoke<ProjectDto>(() =>
      getApiV1ProjectsByName({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getExport(project: string): Promise<ExportDto> {
    return this.invoke<ExportDto>(() =>
      getApiV1ProjectsByNameExport({ client: this.heyClient, path: { name: project } }),
    )
  }

  async apply(config: object): Promise<ApplyResultDto> {
    return this.invoke<ApplyResultDto>(() => postApiV1Apply({ client: this.heyClient, body: config as never }))
  }

  async getProjectOverview(
    project: string,
    opts?: { location?: string; since?: string },
  ): Promise<ProjectOverviewDto> {
    return this.invoke<ProjectOverviewDto>(() =>
      getApiV1ProjectsByNameOverview({
        client: this.heyClient,
        path: { name: project },
        query: { location: opts?.location, since: opts?.since } as never,
      }),
    )
  }

  async searchProject(project: string, opts: { q: string; limit?: number }): Promise<ProjectSearchResponseDto> {
    return this.invoke<ProjectSearchResponseDto>(() =>
      getApiV1ProjectsByNameSearch({
        client: this.heyClient,
        path: { name: project },
        query: { q: opts.q, limit: opts.limit !== undefined ? String(opts.limit) : undefined } as never,
      }),
    )
  }

  async getReport(project: string, opts?: { period?: ReportPeriodDays }): Promise<ProjectReportDto> {
    return this.invoke<ProjectReportDto>(() =>
      getApiV1ProjectsByNameReport({
        client: this.heyClient,
        path: { name: project },
        ...(opts?.period !== undefined && { query: { period: opts.period } }),
      }),
    )
  }

  /** Download the versioned historical answer-engine results attachment. */
  async downloadResultsExport(
    project: string,
    opts: { format: ResultsExportFormat; since?: string; until?: string; includeProbes?: boolean },
  ): Promise<{ content: string; filename: string }> {
    await this.probeBasePath()
    const params = new URLSearchParams({ format: opts.format })
    if (opts.since) params.set('since', opts.since)
    if (opts.until) params.set('until', opts.until)
    if (opts.includeProbes) params.set('includeProbes', 'true')
    const url = `${this.originUrl}/api/v1/projects/${encodeURIComponent(project)}/results/export?${params.toString()}`

    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('fetch failed') || message.includes('ECONNREFUSED') || message.includes('connect ECONNREFUSED')) {
        throw new CliError({
          code: 'CONNECTION_ERROR',
          message: `Could not connect to canonry server at ${this.originUrl}. Start it with "canonry serve".`,
          exitCode: EXIT_SYSTEM_ERROR,
        })
      }
      throw new CliError({ code: 'CONNECTION_ERROR', message, exitCode: EXIT_SYSTEM_ERROR })
    }

    if (!res.ok) {
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        // The status text below is a suitable fallback for non-JSON errors.
      }
      const error = body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error
        : undefined
      throw new CliError({
        code: error?.code ?? 'API_ERROR',
        message: error?.message ?? `HTTP ${res.status}: ${res.statusText}`,
        exitCode: res.status >= 500 ? EXIT_SYSTEM_ERROR : EXIT_USER_ERROR,
        details: { ...(error?.details ?? {}), httpStatus: res.status },
      })
    }

    const filename = /filename\s*=\s*"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1]
      ?? `canonry-results-${project}.${opts.format}`
    return { content: await res.text(), filename }
  }

  // ── Queries / keywords / competitors ────────────────────────────────────

  async putQueries(project: string, queries: string[]): Promise<void> {
    await this.invoke<unknown>(() =>
      putApiV1ProjectsByNameQueries({ client: this.heyClient, path: { name: project }, body: { queries } }),
    )
  }

  async previewReplaceQueries(project: string, queries: string[]): Promise<QueriesReplacePreviewDto> {
    return this.invoke<QueriesReplacePreviewDto>(() =>
      postApiV1ProjectsByNameQueriesReplacePreview({
        client: this.heyClient,
        path: { name: project },
        body: { queries },
      }),
    )
  }

  async listQueries(project: string): Promise<QueryDto[]> {
    return this.invoke<QueryDto[]>(() =>
      getApiV1ProjectsByNameQueries({ client: this.heyClient, path: { name: project } }),
    )
  }

  async deleteQueries(project: string, queries: string[]): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameQueries({ client: this.heyClient, path: { name: project }, body: { queries } }),
    )
  }

  async appendQueries(project: string, queries: string[]): Promise<void> {
    await this.invoke<unknown>(() =>
      postApiV1ProjectsByNameQueries({ client: this.heyClient, path: { name: project }, body: { queries } }),
    )
  }

  async generateQueries(project: string, provider: string, count?: number): Promise<{ queries: string[]; provider: string }> {
    return this.invoke<{ queries: string[]; provider: string }>(() =>
      postApiV1ProjectsByNameQueriesGenerate({
        client: this.heyClient,
        path: { name: project },
        body: { provider, count } as never,
      }),
    )
  }

  async putKeywords(project: string, keywords: string[]): Promise<void> {
    await this.invoke<unknown>(() =>
      putApiV1ProjectsByNameKeywords({ client: this.heyClient, path: { name: project }, body: { keywords } }),
    )
  }

  async listKeywords(project: string): Promise<KeywordDto[]> {
    return this.invoke<KeywordDto[]>(() =>
      getApiV1ProjectsByNameKeywords({ client: this.heyClient, path: { name: project } }),
    )
  }

  async deleteKeywords(project: string, keywords: string[]): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameKeywords({ client: this.heyClient, path: { name: project }, body: { keywords } }),
    )
  }

  async appendKeywords(project: string, keywords: string[]): Promise<void> {
    await this.invoke<unknown>(() =>
      postApiV1ProjectsByNameKeywords({ client: this.heyClient, path: { name: project }, body: { keywords } }),
    )
  }

  async generateKeywords(project: string, provider: string, count?: number): Promise<{ keywords: string[]; provider: string }> {
    return this.invoke<{ keywords: string[]; provider: string }>(() =>
      postApiV1ProjectsByNameKeywordsGenerate({
        client: this.heyClient,
        path: { name: project },
        body: { provider, count } as never,
      }),
    )
  }

  async listCompetitors(project: string): Promise<CompetitorDto[]> {
    return this.invoke<CompetitorDto[]>(() =>
      getApiV1ProjectsByNameCompetitors({ client: this.heyClient, path: { name: project } }),
    )
  }

  async appendCompetitors(project: string, competitors: string[]): Promise<CompetitorDto[]> {
    return this.invoke<CompetitorDto[]>(() =>
      postApiV1ProjectsByNameCompetitors({
        client: this.heyClient,
        path: { name: project },
        body: { competitors },
      }),
    )
  }

  async deleteCompetitors(project: string, competitors: string[]): Promise<CompetitorDto[]> {
    return this.invoke<CompetitorDto[]>(() =>
      deleteApiV1ProjectsByNameCompetitors({
        client: this.heyClient,
        path: { name: project },
        body: { competitors },
      }),
    )
  }

  // ── Runs / timeline / history / snapshots ───────────────────────────────

  async triggerRun(project: string, body?: Record<string, unknown>): Promise<RunDto | RunDto[]> {
    return this.invoke<RunDto | RunDto[]>(() =>
      postApiV1ProjectsByNameRuns({
        client: this.heyClient,
        path: { name: project },
        body: (body ?? {}) as never,
      }),
    )
  }

  async listRuns(project: string, limit?: number, kind?: string): Promise<RunDto[]> {
    return this.invoke<RunDto[]>(() =>
      getApiV1ProjectsByNameRuns({
        client: this.heyClient,
        path: { name: project },
        // kind arrives as a free CLI string; the server validates it against the enum.
        query: { limit, kind } as GetApiV1ProjectsByNameRunsData['query'],
      }),
    )
  }

  async getLatestRun(project: string): Promise<LatestProjectRunDto> {
    return this.invoke<LatestProjectRunDto>(() =>
      getApiV1ProjectsByNameRunsLatest({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getRun(id: string): Promise<RunDetailDto> {
    return this.invoke<RunDetailDto>(() => getApiV1RunsById({ client: this.heyClient, path: { id } }))
  }

  async cancelRun(id: string): Promise<RunDto> {
    return this.invoke<RunDto>(() => postApiV1RunsByIdCancel({ client: this.heyClient, path: { id } }))
  }

  async getTimeline(project: string, location?: string, limit?: number): Promise<TimelineDto[]> {
    return this.invoke<TimelineDto[]>(() =>
      getApiV1ProjectsByNameTimeline({ client: this.heyClient, path: { name: project }, query: { location, limit } }),
    )
  }

  async getHistory(
    project: string,
    opts?: { limit?: number; offset?: number; since?: string; action?: string; actor?: string; entityType?: string },
  ): Promise<AuditLogEntry[]> {
    return this.invoke<AuditLogEntry[]>(() =>
      getApiV1ProjectsByNameHistory({ client: this.heyClient, path: { name: project }, query: opts }),
    )
  }

  async getGlobalHistory(
    opts?: { limit?: number; offset?: number; since?: string; action?: string; actor?: string; entityType?: string },
  ): Promise<AuditLogEntry[]> {
    return this.invoke<AuditLogEntry[]>(() =>
      getApiV1History({ client: this.heyClient, query: opts }),
    )
  }

  async getSnapshots(
    project: string,
    opts?: { limit?: number; offset?: number; location?: string },
  ): Promise<SnapshotListResponse> {
    return this.invoke<SnapshotListResponse>(() =>
      getApiV1ProjectsByNameSnapshots({
        client: this.heyClient,
        path: { name: project },
        query: { limit: opts?.limit, offset: opts?.offset, location: opts?.location },
      }),
    )
  }

  async getSnapshotDiff(project: string, run1: string, run2: string): Promise<SnapshotDiffResponse> {
    return this.invoke<SnapshotDiffResponse>(() =>
      getApiV1ProjectsByNameSnapshotsDiff({
        client: this.heyClient,
        path: { name: project },
        query: { run1, run2 },
      }),
    )
  }

  // ── Analytics ───────────────────────────────────────────────────────────

  async getAnalyticsMetrics(project: string, window?: string): Promise<BrandMetricsDto> {
    return this.invoke<BrandMetricsDto>(() =>
      getApiV1ProjectsByNameAnalyticsMetrics({
        client: this.heyClient,
        path: { name: project },
        query: { window } as never,
      }),
    )
  }

  async getAnalyticsGaps(project: string, window?: string): Promise<GapAnalysisDto> {
    return this.invoke<GapAnalysisDto>(() =>
      getApiV1ProjectsByNameAnalyticsGaps({
        client: this.heyClient,
        path: { name: project },
        query: { window } as never,
      }),
    )
  }

  async getAnalyticsSources(
    project: string,
    opts: { window?: string; limit?: number } = {},
  ): Promise<SourceBreakdownDto> {
    return this.invoke<SourceBreakdownDto>(() =>
      getApiV1ProjectsByNameAnalyticsSources({
        client: this.heyClient,
        path: { name: project },
        query: { window: opts.window, limit: opts.limit } as never,
      }),
    )
  }

  // ── Settings / providers / snapshot / telemetry ─────────────────────────

  async getSettings(): Promise<SettingsDto> {
    return this.invoke<SettingsDto>(() => getApiV1Settings({ client: this.heyClient }))
  }

  // ── API key management ──────────────────────────────────────────────────

  async listApiKeys(): Promise<ApiKeyListDto> {
    return this.invoke<ApiKeyListDto>(() => getApiV1Keys({ client: this.heyClient }))
  }

  /** Introspect the CURRENT key (the one this client authenticates with). */
  async getApiKeySelf(): Promise<ApiKeyDto> {
    return this.invoke<ApiKeyDto>(() => getApiV1KeysSelf({ client: this.heyClient }))
  }

  async createApiKey(body: CreateApiKeyRequest): Promise<CreatedApiKeyDto> {
    return this.invoke<CreatedApiKeyDto>(() => postApiV1Keys({ client: this.heyClient, body }))
  }

  async revokeApiKey(id: string): Promise<ApiKeyDto> {
    return this.invoke<ApiKeyDto>(() =>
      postApiV1KeysByIdRevoke({ client: this.heyClient, path: { id } }),
    )
  }

  async updateProvider(
    name: string,
    body: {
      apiKey?: string
      baseUrl?: string
      model?: string
      quota?: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number }
    },
  ): Promise<object> {
    return this.invoke<object>(() =>
      putApiV1SettingsProvidersByName({ client: this.heyClient, path: { name } as never, body }),
    )
  }

  async createSnapshot(body: {
    companyName: string
    domain: string
    queries?: string[]
    competitors?: string[]
  }): Promise<SnapshotReportDto> {
    return this.invoke<SnapshotReportDto>(() => postApiV1Snapshot({ client: this.heyClient, body }))
  }

  async getTelemetry(): Promise<TelemetryDto> {
    return this.invoke<TelemetryDto>(() => getApiV1Telemetry({ client: this.heyClient }))
  }

  async updateTelemetry(enabled: boolean): Promise<TelemetryDto> {
    return this.invoke<TelemetryDto>(() => putApiV1Telemetry({ client: this.heyClient, body: { enabled } }))
  }

  // ── Schedules / notifications / locations ───────────────────────────────

  async putSchedule(project: string, body: object): Promise<ScheduleDto> {
    return this.invoke<ScheduleDto>(() =>
      putApiV1ProjectsByNameSchedule({
        client: this.heyClient,
        path: { name: project },
        body: body as never,
      }),
    )
  }

  async getSchedule(project: string, kind?: string): Promise<ScheduleDto> {
    return this.invoke<ScheduleDto>(() =>
      getApiV1ProjectsByNameSchedule({
        client: this.heyClient,
        path: { name: project },
        query: kind ? ({ kind } as never) : undefined,
      }),
    )
  }

  async deleteSchedule(project: string, kind?: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameSchedule({
        client: this.heyClient,
        path: { name: project },
        query: kind ? ({ kind } as never) : undefined,
      }),
    )
  }

  async createNotification(project: string, body: object): Promise<NotificationDto> {
    return this.invoke<NotificationDto>(() =>
      postApiV1ProjectsByNameNotifications({
        client: this.heyClient,
        path: { name: project },
        body: body as never,
      }),
    )
  }

  async listNotifications(project: string): Promise<NotificationDto[]> {
    return this.invoke<NotificationDto[]>(() =>
      getApiV1ProjectsByNameNotifications({ client: this.heyClient, path: { name: project } }),
    )
  }

  async deleteNotification(project: string, id: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameNotificationsById({ client: this.heyClient, path: { name: project, id } }),
    )
  }

  async testNotification(project: string, id: string): Promise<{ status: number; ok: boolean }> {
    return this.invoke<{ status: number; ok: boolean }>(() =>
      postApiV1ProjectsByNameNotificationsByIdTest({ client: this.heyClient, path: { name: project, id } }),
    )
  }

  async addLocation(project: string, body: LocationContext): Promise<LocationContext> {
    return this.invoke<LocationContext>(() =>
      postApiV1ProjectsByNameLocations({ client: this.heyClient, path: { name: project }, body }),
    )
  }

  async listLocations(project: string): Promise<{ locations: LocationContext[]; defaultLocation: string | null }> {
    return this.invoke<{ locations: LocationContext[]; defaultLocation: string | null }>(() =>
      getApiV1ProjectsByNameLocations({ client: this.heyClient, path: { name: project } }),
    )
  }

  async removeLocation(project: string, label: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameLocationsByLabel({
        client: this.heyClient,
        path: { name: project, label },
      }),
    )
  }

  async setDefaultLocation(project: string, label: string): Promise<{ defaultLocation: string }> {
    return this.invoke<{ defaultLocation: string }>(() =>
      putApiV1ProjectsByNameLocationsDefault({
        client: this.heyClient,
        path: { name: project },
        body: { label },
      }),
    )
  }

  // ── Google connections + GSC ───────────────────────────────────────────

  async googleConnect(
    project: string,
    body: { type: string; propertyId?: string; publicUrl?: string },
  ): Promise<{ authUrl: string; redirectUri?: string }> {
    return this.invoke<{ authUrl: string; redirectUri?: string }>(() =>
      postApiV1ProjectsByNameGoogleConnect({
        client: this.heyClient,
        path: { name: project },
        body: body as never,
      }),
    )
  }

  async googleConnections(project: string): Promise<GoogleConnectionDto[]> {
    return this.invoke<GoogleConnectionDto[]>(() =>
      getApiV1ProjectsByNameGoogleConnections({ client: this.heyClient, path: { name: project } }),
    )
  }

  async googleDisconnect(project: string, type: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameGoogleConnectionsByType({
        client: this.heyClient,
        path: { name: project, type } as never,
      }),
    )
  }

  async googleProperties(project: string): Promise<{ sites: Array<{ siteUrl: string; permissionLevel: string }> }> {
    return this.invoke<{ sites: Array<{ siteUrl: string; permissionLevel: string }> }>(() =>
      getApiV1ProjectsByNameGoogleProperties({ client: this.heyClient, path: { name: project } }),
    )
  }

  async googleSetProperty(project: string, type: string, propertyId: string): Promise<GoogleConnectionDto> {
    return this.invoke<GoogleConnectionDto>(() =>
      putApiV1ProjectsByNameGoogleConnectionsByTypeProperty({
        client: this.heyClient,
        path: { name: project, type } as never,
        body: { propertyId },
      }),
    )
  }

  async googleSetSitemap(project: string, type: string, sitemapUrl: string): Promise<GoogleConnectionDto> {
    return this.invoke<GoogleConnectionDto>(() =>
      putApiV1ProjectsByNameGoogleConnectionsByTypeSitemap({
        client: this.heyClient,
        path: { name: project, type } as never,
        body: { sitemapUrl },
      }),
    )
  }

  // Google Business Profile (Phase 1: auth + discovery)
  async listGbpAccounts(project: string): Promise<GbpAccountListResponse> {
    return this.invoke<GbpAccountListResponse>(() =>
      getApiV1ProjectsByNameGbpAccounts({
        client: this.heyClient,
        path: { name: project },
      }),
    )
  }

  async discoverGbpLocations(project: string, body?: { selectAllNew?: boolean; accountName?: string; switchAccount?: boolean }): Promise<GbpLocationListResponse> {
    return this.invoke<GbpLocationListResponse>(() =>
      postApiV1ProjectsByNameGbpLocationsDiscover({
        client: this.heyClient,
        path: { name: project },
        body: body ?? {},
      }),
    )
  }

  async listGbpLocations(project: string, opts?: { selected?: boolean }): Promise<GbpLocationListResponse> {
    return this.invoke<GbpLocationListResponse>(() =>
      getApiV1ProjectsByNameGbpLocations({
        client: this.heyClient,
        path: { name: project },
        query: opts?.selected === undefined ? undefined : { selected: String(opts.selected) } as never,
      }),
    )
  }

  async setGbpLocationSelection(project: string, locationName: string, selected: boolean): Promise<GbpLocationDto> {
    return this.invoke<GbpLocationDto>(() =>
      putApiV1ProjectsByNameGbpLocationsByLocationNameSelection({
        client: this.heyClient,
        path: { name: project, locationName } as never,
        body: { selected },
      }),
    )
  }

  async disconnectGbp(project: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameGbpConnection({
        client: this.heyClient,
        path: { name: project },
      }),
    )
  }

  async triggerGbpSync(
    project: string,
    body?: { locationNames?: string[]; daysOfMetrics?: number; monthsOfKeywords?: number },
  ): Promise<GbpSyncResponse> {
    return this.invoke<GbpSyncResponse>(() =>
      postApiV1ProjectsByNameGbpSync({
        client: this.heyClient,
        path: { name: project },
        body: body ?? {},
      }),
    )
  }

  async adsConnect(project: string, body: { apiKey: string }): Promise<AdsConnectionStatusDto> {
    return this.invoke<AdsConnectionStatusDto>(() =>
      postApiV1ProjectsByNameAdsConnect({ client: this.heyClient, path: { name: project }, body }),
    )
  }

  async adsDisconnect(project: string): Promise<AdsDisconnectResponse> {
    return this.invoke<AdsDisconnectResponse>(() =>
      deleteApiV1ProjectsByNameAdsConnection({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getAdsStatus(project: string): Promise<AdsConnectionStatusDto> {
    return this.invoke<AdsConnectionStatusDto>(() =>
      getApiV1ProjectsByNameAdsStatus({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getAdsAccount(project: string): Promise<AdsAccountDto> {
    return this.invoke<AdsAccountDto>(() =>
      getApiV1ProjectsByNameAdsAccount({ client: this.heyClient, path: { name: project } }),
    )
  }

  async searchAdsGeo(project: string, query: AdsGeoSearchQuery): Promise<AdsGeoSearchResponse> {
    return this.invoke<AdsGeoSearchResponse>(() =>
      getApiV1ProjectsByNameAdsGeoSearch({ client: this.heyClient, path: { name: project }, query }),
    )
  }

  async getAdsConversionPixels(project: string): Promise<AdsConversionPixelListResponse> {
    return this.invoke<AdsConversionPixelListResponse>(() =>
      getApiV1ProjectsByNameAdsConversionsPixels({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getAdsConversionEventSettings(project: string): Promise<AdsConversionEventSettingListResponse> {
    return this.invoke<AdsConversionEventSettingListResponse>(() =>
      getApiV1ProjectsByNameAdsConversionsEventSettings({ client: this.heyClient, path: { name: project } }),
    )
  }

  async triggerAdsSync(project: string): Promise<AdsSyncResponse> {
    return this.invoke<AdsSyncResponse>(() =>
      postApiV1ProjectsByNameAdsSync({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getAdsCampaigns(project: string): Promise<AdsCampaignListResponse> {
    return this.invoke<AdsCampaignListResponse>(() =>
      getApiV1ProjectsByNameAdsCampaigns({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getAdsInsights(
    project: string,
    query?: { level?: string; entityId?: string; from?: string; to?: string },
  ): Promise<AdsInsightsResponse> {
    return this.invoke<AdsInsightsResponse>(() =>
      getApiV1ProjectsByNameAdsInsights({ client: this.heyClient, path: { name: project }, query }),
    )
  }

  async getAdsSummary(project: string): Promise<AdsSummaryDto> {
    return this.invoke<AdsSummaryDto>(() =>
      getApiV1ProjectsByNameAdsSummary({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getAdsOperation(project: string, operationKey: string): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      getApiV1ProjectsByNameAdsOperationsByOperationKey({
        client: this.heyClient,
        path: { name: project, operationKey },
      }),
    )
  }

  async uploadAdsImage(project: string, body: AdsImageUploadRequest): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsFiles({ client: this.heyClient, path: { name: project }, body }),
    )
  }

  async createAdsCampaign(project: string, body: AdsCampaignCreateRequest): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsCampaigns({ client: this.heyClient, path: { name: project }, body }),
    )
  }

  async updateAdsCampaign(
    project: string,
    campaignId: string,
    body: AdsCampaignUpdateRequest,
  ): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsCampaignsById({
        client: this.heyClient,
        path: { name: project, id: campaignId },
        body,
      }),
    )
  }

  async pauseAdsCampaign(
    project: string,
    campaignId: string,
    body: AdsPauseRequest,
  ): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsCampaignsByIdPause({
        client: this.heyClient,
        path: { name: project, id: campaignId },
        body,
      }),
    )
  }

  async createAdsAdGroup(project: string, body: AdsAdGroupCreateRequest): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsAdGroups({ client: this.heyClient, path: { name: project }, body }),
    )
  }

  async updateAdsAdGroup(
    project: string,
    adGroupId: string,
    body: AdsAdGroupUpdateRequest,
  ): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsAdGroupsById({
        client: this.heyClient,
        path: { name: project, id: adGroupId },
        body,
      }),
    )
  }

  async pauseAdsAdGroup(
    project: string,
    adGroupId: string,
    body: AdsPauseRequest,
  ): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsAdGroupsByIdPause({
        client: this.heyClient,
        path: { name: project, id: adGroupId },
        body,
      }),
    )
  }

  async createAdsAd(project: string, body: AdsAdCreateRequest): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsAds({ client: this.heyClient, path: { name: project }, body }),
    )
  }

  async updateAdsAd(
    project: string,
    adId: string,
    body: AdsAdUpdateRequest,
  ): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsAdsById({
        client: this.heyClient,
        path: { name: project, id: adId },
        body,
      }),
    )
  }

  async pauseAdsAd(project: string, adId: string, body: AdsPauseRequest): Promise<AdsOperationResponse> {
    return this.invoke<AdsOperationResponse>(() =>
      postApiV1ProjectsByNameAdsAdsByIdPause({
        client: this.heyClient,
        path: { name: project, id: adId },
        body,
      }),
    )
  }

  async listGbpMetrics(project: string, opts?: { locationName?: string; metric?: string }): Promise<GbpDailyMetricListResponse> {
    return this.invoke<GbpDailyMetricListResponse>(() =>
      getApiV1ProjectsByNameGbpMetrics({
        client: this.heyClient,
        path: { name: project },
        query: (opts && (opts.locationName || opts.metric)) ? opts as never : undefined,
      }),
    )
  }

  async listGbpKeywords(project: string, opts?: { locationName?: string }): Promise<GbpKeywordImpressionListResponse> {
    return this.invoke<GbpKeywordImpressionListResponse>(() =>
      getApiV1ProjectsByNameGbpKeywords({
        client: this.heyClient,
        path: { name: project },
        query: opts?.locationName ? { locationName: opts.locationName } as never : undefined,
      }),
    )
  }

  async listGbpPlaceActions(project: string, opts?: { locationName?: string }): Promise<GbpPlaceActionListResponse> {
    return this.invoke<GbpPlaceActionListResponse>(() =>
      getApiV1ProjectsByNameGbpPlaceActions({
        client: this.heyClient,
        path: { name: project },
        query: opts?.locationName ? { locationName: opts.locationName } as never : undefined,
      }),
    )
  }

  async listGbpLodging(project: string, opts?: { locationName?: string }): Promise<GbpLodgingListResponse> {
    return this.invoke<GbpLodgingListResponse>(() =>
      getApiV1ProjectsByNameGbpLodging({
        client: this.heyClient,
        path: { name: project },
        query: opts?.locationName ? { locationName: opts.locationName } as never : undefined,
      }),
    )
  }

  async listGbpAttributes(project: string, opts?: { locationName?: string }): Promise<GbpAttributesListResponse> {
    return this.invoke<GbpAttributesListResponse>(() =>
      getApiV1ProjectsByNameGbpAttributes({
        client: this.heyClient,
        path: { name: project },
        query: opts?.locationName ? { locationName: opts.locationName } as never : undefined,
      }),
    )
  }

  async listGbpPlaces(project: string, opts?: { locationName?: string }): Promise<GbpPlaceDetailsListResponse> {
    return this.invoke<GbpPlaceDetailsListResponse>(() =>
      getApiV1ProjectsByNameGbpPlaces({
        client: this.heyClient,
        path: { name: project },
        query: opts?.locationName ? { locationName: opts.locationName } as never : undefined,
      }),
    )
  }

  async getGbpSummary(project: string, opts?: { locationName?: string }): Promise<GbpSummaryDto> {
    return this.invoke<GbpSummaryDto>(() =>
      getApiV1ProjectsByNameGbpSummary({
        client: this.heyClient,
        path: { name: project },
        query: opts?.locationName ? { locationName: opts.locationName } as never : undefined,
      }),
    )
  }

  // GSC data
  async gscSync(project: string, body?: { days?: number; full?: boolean }): Promise<RunDto> {
    return this.invoke<RunDto>(() =>
      postApiV1ProjectsByNameGoogleGscSync({
        client: this.heyClient,
        path: { name: project },
        body: body ?? {},
      }),
    )
  }

  async gscPerformance(project: string, params?: Record<string, string>): Promise<GscSearchDataDto[]> {
    return this.invoke<GscSearchDataDto[]>(() =>
      getApiV1ProjectsByNameGoogleGscPerformance({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  async gscPerformanceDaily(project: string, params?: Record<string, string>): Promise<GscPerformanceDailyDto> {
    return this.invoke<GscPerformanceDailyDto>(() =>
      getApiV1ProjectsByNameGoogleGscPerformanceDaily({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  async gscInspect(project: string, url: string): Promise<GscUrlInspectionDto> {
    return this.invoke<GscUrlInspectionDto>(() =>
      postApiV1ProjectsByNameGoogleGscInspect({
        client: this.heyClient,
        path: { name: project },
        body: { url },
      }),
    )
  }

  async gscInspections(project: string, params?: Record<string, string>): Promise<GscUrlInspectionDto[]> {
    return this.invoke<GscUrlInspectionDto[]>(() =>
      getApiV1ProjectsByNameGoogleGscInspections({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  async gscDeindexed(project: string): Promise<object[]> {
    return this.invoke<object[]>(() =>
      getApiV1ProjectsByNameGoogleGscDeindexed({ client: this.heyClient, path: { name: project } }),
    )
  }

  async gscCoverage(project: string): Promise<GscCoverageSummaryDto> {
    return this.invoke<GscCoverageSummaryDto>(() =>
      getApiV1ProjectsByNameGoogleGscCoverage({ client: this.heyClient, path: { name: project } }),
    )
  }

  async gscCoverageHistory(project: string, params?: { limit?: number }): Promise<GscCoverageSnapshotDto[]> {
    return this.invoke<GscCoverageSnapshotDto[]>(() =>
      getApiV1ProjectsByNameGoogleGscCoverageHistory({
        client: this.heyClient,
        path: { name: project },
        query: { limit: params?.limit },
      }),
    )
  }

  async gscInspectSitemap(project: string, body?: { sitemapUrl?: string }): Promise<object> {
    return this.invoke<object>(() =>
      postApiV1ProjectsByNameGoogleGscInspectSitemap({
        client: this.heyClient,
        path: { name: project },
        body: body ?? {},
      }),
    )
  }

  async gscSitemaps(project: string): Promise<object> {
    return this.invoke<object>(() =>
      getApiV1ProjectsByNameGoogleGscSitemaps({ client: this.heyClient, path: { name: project } }),
    )
  }

  async gscDiscoverSitemaps(project: string): Promise<object> {
    return this.invoke<object>(() =>
      postApiV1ProjectsByNameGoogleGscDiscoverSitemaps({ client: this.heyClient, path: { name: project } }),
    )
  }

  // ── Google Indexing API ────────────────────────────────────────────────

  async googleRequestIndexing(project: string, body: { urls: string[]; allUnindexed?: boolean }): Promise<object> {
    return this.invoke<object>(() =>
      postApiV1ProjectsByNameGoogleIndexingRequest({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  // ── Bing Webmaster Tools ───────────────────────────────────────────────

  async bingConnect(project: string, body: { apiKey: string }): Promise<object> {
    return this.invoke<object>(() =>
      postApiV1ProjectsByNameBingConnect({ client: this.heyClient, path: { name: project }, body }),
    )
  }

  async bingDisconnect(project: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameBingDisconnect({ client: this.heyClient, path: { name: project } }),
    )
  }

  async bingStatus(project: string): Promise<object> {
    return this.invoke<object>(() =>
      getApiV1ProjectsByNameBingStatus({ client: this.heyClient, path: { name: project } }),
    )
  }

  async bingSites(project: string): Promise<object> {
    return this.invoke<object>(() =>
      getApiV1ProjectsByNameBingSites({ client: this.heyClient, path: { name: project } }),
    )
  }

  async bingSetSite(project: string, siteUrl: string): Promise<object> {
    return this.invoke<object>(() =>
      postApiV1ProjectsByNameBingSetSite({
        client: this.heyClient,
        path: { name: project },
        body: { siteUrl },
      }),
    )
  }

  async bingCoverage(project: string): Promise<object> {
    return this.invoke<object>(() =>
      getApiV1ProjectsByNameBingCoverage({ client: this.heyClient, path: { name: project } }),
    )
  }

  async bingCoverageHistory(project: string, params?: { limit?: number }): Promise<BingCoverageSnapshotDto[]> {
    return this.invoke<BingCoverageSnapshotDto[]>(() =>
      getApiV1ProjectsByNameBingCoverageHistory({
        client: this.heyClient,
        path: { name: project },
        query: { limit: params?.limit },
      }),
    )
  }

  async bingInspections(project: string, params?: Record<string, string>): Promise<object[]> {
    return this.invoke<object[]>(() =>
      getApiV1ProjectsByNameBingInspections({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  async bingInspectUrl(project: string, url: string): Promise<object> {
    return this.invoke<object>(() =>
      postApiV1ProjectsByNameBingInspectUrl({
        client: this.heyClient,
        path: { name: project },
        body: { url },
      }),
    )
  }

  async bingInspectSitemap(project: string, body?: { sitemapUrl?: string }): Promise<object> {
    return this.invoke<object>(() =>
      postApiV1ProjectsByNameBingInspectSitemap({
        client: this.heyClient,
        path: { name: project },
        body: body ?? {},
      }),
    )
  }

  async bingRequestIndexing(project: string, body: { urls?: string[]; allUnindexed?: boolean }): Promise<object> {
    return this.invoke<object>(() =>
      postApiV1ProjectsByNameBingRequestIndexing({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async bingPerformance(project: string, params?: Record<string, string>): Promise<object[]> {
    return this.invoke<object[]>(() =>
      getApiV1ProjectsByNameBingPerformance({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  // ── CDP browser provider ───────────────────────────────────────────────

  async getCdpStatus(): Promise<CdpStatusDto> {
    return this.invoke<CdpStatusDto>(() => getApiV1CdpStatus({ client: this.heyClient }))
  }

  async cdpScreenshot(query: string, targets?: string[]): Promise<CdpScreenshotResultDto> {
    return this.invoke<CdpScreenshotResultDto>(() =>
      postApiV1CdpScreenshot({ client: this.heyClient, body: { query, targets } }),
    )
  }

  async getBrowserDiff(project: string, runId: string): Promise<object> {
    return this.invoke<object>(() =>
      getApiV1ProjectsByNameRunsByRunIdBrowserDiff({
        client: this.heyClient,
        path: { name: project, runId },
      }),
    )
  }

  // ── Google Analytics 4 ─────────────────────────────────────────────────

  async gaConnect(project: string, body: { propertyId: string; keyJson?: string }): Promise<GaConnectResponse> {
    return this.invoke<GaConnectResponse>(() =>
      postApiV1ProjectsByNameGaConnect({ client: this.heyClient, path: { name: project }, body: body as never }),
    )
  }

  async gaDisconnect(project: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameGaDisconnect({ client: this.heyClient, path: { name: project } }),
    )
  }

  async gaStatus(project: string): Promise<GaStatusResponse> {
    return this.invoke<GaStatusResponse>(() =>
      getApiV1ProjectsByNameGaStatus({ client: this.heyClient, path: { name: project } }),
    )
  }

  async gaSync(project: string, body?: { days?: number; only?: string }): Promise<GaSyncResponse> {
    return this.invoke<GaSyncResponse>(() =>
      postApiV1ProjectsByNameGaSync({
        client: this.heyClient,
        path: { name: project },
        body: body ?? {},
      }),
    )
  }

  async gaTraffic(project: string, params?: Record<string, string>): Promise<GaTrafficResponse> {
    return this.invoke<GaTrafficResponse>(() =>
      getApiV1ProjectsByNameGaTraffic({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  async gaCoverage(project: string): Promise<GaCoverageResponse> {
    return this.invoke<GaCoverageResponse>(() =>
      getApiV1ProjectsByNameGaCoverage({ client: this.heyClient, path: { name: project } }),
    )
  }

  async gaAiReferralHistory(project: string, params?: Record<string, string>): Promise<GA4AiReferralHistoryEntry[]> {
    return this.invoke<GA4AiReferralHistoryEntry[]>(() =>
      getApiV1ProjectsByNameGaAiReferralHistory({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  async gaSocialReferralHistory(project: string, params?: Record<string, string>): Promise<GA4SocialReferralHistoryEntry[]> {
    return this.invoke<GA4SocialReferralHistoryEntry[]>(() =>
      getApiV1ProjectsByNameGaSocialReferralHistory({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  async gaSocialReferralTrend(project: string): Promise<GaSocialReferralTrendResponse> {
    return this.invoke<GaSocialReferralTrendResponse>(() =>
      getApiV1ProjectsByNameGaSocialReferralTrend({ client: this.heyClient, path: { name: project } }),
    )
  }

  async gaAttributionTrend(project: string): Promise<GaAttributionTrendResponse> {
    return this.invoke<GaAttributionTrendResponse>(() =>
      getApiV1ProjectsByNameGaAttributionTrend({ client: this.heyClient, path: { name: project } }),
    )
  }

  async gaSessionHistory(project: string, params?: Record<string, string>): Promise<GA4SessionHistoryEntry[]> {
    return this.invoke<GA4SessionHistoryEntry[]>(() =>
      getApiV1ProjectsByNameGaSessionHistory({
        client: this.heyClient,
        path: { name: project },
        query: params as never,
      }),
    )
  }

  // ── Traffic — server-side ingestion ────────────────────────────────────

  async trafficConnectCloudRun(project: string, body: TrafficConnectCloudRunRequest): Promise<TrafficSourceDto> {
    return this.invoke<TrafficSourceDto>(() =>
      postApiV1ProjectsByNameTrafficConnectCloudRun({
        client: this.heyClient,
        path: { name: project },
        body: body as never,
      }),
    )
  }

  async trafficConnectWordpress(project: string, body: TrafficConnectWordpressRequest): Promise<TrafficSourceDto> {
    return this.invoke<TrafficSourceDto>(() =>
      postApiV1ProjectsByNameTrafficConnectWordpress({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async trafficConnectVercel(project: string, body: TrafficConnectVercelRequest): Promise<TrafficSourceDto> {
    return this.invoke<TrafficSourceDto>(() =>
      postApiV1ProjectsByNameTrafficConnectVercel({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async trafficSync(
    project: string,
    sourceId: string,
    body?: { sinceMinutes?: number },
  ): Promise<TrafficSyncResponse> {
    return this.invoke<TrafficSyncResponse>(() =>
      postApiV1ProjectsByNameTrafficSourcesByIdSync({
        client: this.heyClient,
        path: { name: project, id: sourceId },
        body: body ?? {},
      }),
    )
  }

  async trafficBackfill(
    project: string,
    sourceId: string,
    body?: { days?: number },
  ): Promise<TrafficBackfillResponse> {
    return this.invoke<TrafficBackfillResponse>(() =>
      postApiV1ProjectsByNameTrafficSourcesByIdBackfill({
        client: this.heyClient,
        path: { name: project, id: sourceId },
        body: body ?? {},
      }),
    )
  }

  async trafficListSources(project: string): Promise<TrafficSourceListResponse> {
    return this.invoke<TrafficSourceListResponse>(() =>
      getApiV1ProjectsByNameTrafficSources({ client: this.heyClient, path: { name: project } }),
    )
  }

  async trafficReset(project: string, sourceId: string): Promise<TrafficSourceDetailDto> {
    return this.invoke<TrafficSourceDetailDto>(() =>
      postApiV1ProjectsByNameTrafficSourcesByIdReset({
        client: this.heyClient,
        path: { name: project, id: sourceId },
        body: { advanceToNow: true },
      }),
    )
  }

  async trafficStatus(project: string): Promise<TrafficStatusResponse> {
    return this.invoke<TrafficStatusResponse>(() =>
      getApiV1ProjectsByNameTrafficStatus({ client: this.heyClient, path: { name: project } }),
    )
  }

  async trafficGetSource(project: string, sourceId: string): Promise<TrafficSourceDetailDto> {
    return this.invoke<TrafficSourceDetailDto>(() =>
      getApiV1ProjectsByNameTrafficSourcesById({
        client: this.heyClient,
        path: { name: project, id: sourceId },
      }),
    )
  }

  async trafficListEvents(
    project: string,
    params?: { since?: string; until?: string; kind?: string; limit?: number; sourceId?: string },
  ): Promise<TrafficEventsResponse> {
    return this.invoke<TrafficEventsResponse>(() =>
      getApiV1ProjectsByNameTrafficEvents({
        client: this.heyClient,
        path: { name: project },
        query: {
          since: params?.since,
          until: params?.until,
          kind: params?.kind,
          limit: params?.limit !== undefined ? String(params.limit) : undefined,
          sourceId: params?.sourceId,
        } as never,
      }),
    )
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  async triggerDiscoveryRun(
    project: string,
    body?: { icpDescription?: string; buyerDescription?: string; seedProviders?: Array<'gemini' | 'openai'>; dedupThreshold?: number; maxProbes?: number; probeConcurrency?: number; locations?: string[] },
  ): Promise<DiscoveryRunStartResponse> {
    return this.invoke<DiscoveryRunStartResponse>(() =>
      postApiV1ProjectsByNameDiscoverRun({
        client: this.heyClient,
        path: { name: project },
        body: body ?? {},
      }),
    )
  }

  async listDiscoverySessions(project: string, opts?: { limit?: number }): Promise<DiscoverySessionDto[]> {
    return this.invoke<DiscoverySessionDto[]>(() =>
      getApiV1ProjectsByNameDiscoverSessions({
        client: this.heyClient,
        path: { name: project },
        query: { limit: opts?.limit !== undefined ? String(opts.limit) : undefined } as never,
      }),
    )
  }

  async getDiscoverySession(project: string, sessionId: string): Promise<DiscoverySessionDetailDto> {
    return this.invoke<DiscoverySessionDetailDto>(() =>
      getApiV1ProjectsByNameDiscoverSessionsById({
        client: this.heyClient,
        path: { name: project, id: sessionId },
      }),
    )
  }

  async getDiscoveryHarvest(
    project: string,
    sessionId: string,
    opts?: { minProbeHits?: number; anchor?: boolean },
  ): Promise<DiscoveryHarvestDto> {
    return this.invoke<DiscoveryHarvestDto>(() =>
      getApiV1ProjectsByNameDiscoverSessionsByIdHarvest({
        client: this.heyClient,
        path: { name: project, id: sessionId },
        query: {
          minProbeHits: opts?.minProbeHits !== undefined ? String(opts.minProbeHits) : undefined,
          // The server treats anchor=false as "disable"; omit otherwise.
          anchor: opts?.anchor === false ? 'false' : undefined,
        } as never,
      }),
    )
  }

  async previewDiscoveryPromote(project: string, sessionId: string): Promise<DiscoveryPromotePreview> {
    return this.invoke<DiscoveryPromotePreview>(() =>
      getApiV1ProjectsByNameDiscoverSessionsByIdPromote({
        client: this.heyClient,
        path: { name: project, id: sessionId },
      }),
    )
  }

  async promoteDiscovery(
    project: string,
    sessionId: string,
    body?: DiscoveryPromoteRequest,
  ): Promise<DiscoveryPromoteResult> {
    return this.invoke<DiscoveryPromoteResult>(() =>
      postApiV1ProjectsByNameDiscoverSessionsByIdPromote({
        client: this.heyClient,
        path: { name: project, id: sessionId },
        body: body ?? {},
      }),
    )
  }

  // ── Technical AEO (site-audit) ──────────────────────────────────────────

  async getTechnicalAeoScore(project: string, opts?: { runId?: string }): Promise<SiteAuditScoreDto> {
    return this.invoke<SiteAuditScoreDto>(() =>
      getApiV1ProjectsByNameTechnicalAeo({ client: this.heyClient, path: { name: project }, query: { runId: opts?.runId } }),
    )
  }

  async getTechnicalAeoPages(
    project: string,
    opts?: { runId?: string; status?: 'success' | 'error'; sort?: string; limit?: number; offset?: number },
  ): Promise<SiteAuditPagesResponseDto> {
    return this.invoke<SiteAuditPagesResponseDto>(() =>
      getApiV1ProjectsByNameTechnicalAeoPages({
        client: this.heyClient,
        path: { name: project },
        query: {
          runId: opts?.runId,
          status: opts?.status,
          sort: opts?.sort,
          limit: opts?.limit !== undefined ? String(opts.limit) : undefined,
          offset: opts?.offset !== undefined ? String(opts.offset) : undefined,
        } as never,
      }),
    )
  }

  async getTechnicalAeoTrend(project: string, opts?: { limit?: number }): Promise<SiteAuditTrendResponseDto> {
    return this.invoke<SiteAuditTrendResponseDto>(() =>
      getApiV1ProjectsByNameTechnicalAeoTrend({
        client: this.heyClient,
        path: { name: project },
        query: { limit: opts?.limit !== undefined ? String(opts.limit) : undefined } as never,
      }),
    )
  }

  async triggerSiteAudit(
    project: string,
    body?: { sitemapUrl?: string; limit?: number },
  ): Promise<SiteAuditRunResponseDto> {
    return this.invoke<SiteAuditRunResponseDto>(() =>
      postApiV1ProjectsByNameTechnicalAeoRuns({
        client: this.heyClient,
        path: { name: project },
        body: (body ?? {}) as never,
      }),
    )
  }

  // ── WordPress ──────────────────────────────────────────────────────────

  async wordpressConnect(
    project: string,
    body: {
      url: string
      stagingUrl?: string
      username: string
      appPassword: string
      defaultEnv?: WordpressEnv
    },
  ): Promise<WordpressStatusDto> {
    return this.invoke<WordpressStatusDto>(() =>
      postApiV1ProjectsByNameWordpressConnect({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async wordpressDisconnect(project: string): Promise<void> {
    await this.invoke<unknown>(() =>
      deleteApiV1ProjectsByNameWordpressDisconnect({ client: this.heyClient, path: { name: project } }),
    )
  }

  async wordpressStatus(project: string): Promise<WordpressStatusDto> {
    return this.invoke<WordpressStatusDto>(() =>
      getApiV1ProjectsByNameWordpressStatus({ client: this.heyClient, path: { name: project } }),
    )
  }

  async wordpressPages(
    project: string,
    env?: WordpressEnv,
  ): Promise<{ env: WordpressEnv; pages: WordpressPageSummaryDto[] }> {
    return this.invoke<{ env: WordpressEnv; pages: WordpressPageSummaryDto[] }>(() =>
      getApiV1ProjectsByNameWordpressPages({
        client: this.heyClient,
        path: { name: project },
        query: { env },
      }),
    )
  }

  async wordpressPage(project: string, slug: string, env?: WordpressEnv): Promise<WordpressPageDetailDto> {
    return this.invoke<WordpressPageDetailDto>(() =>
      getApiV1ProjectsByNameWordpressPage({
        client: this.heyClient,
        path: { name: project },
        query: { slug, env },
      }),
    )
  }

  async wordpressCreatePage(
    project: string,
    body: { title: string; slug: string; content: string; status?: string; env?: WordpressEnv },
  ): Promise<WordpressPageDetailDto> {
    return this.invoke<WordpressPageDetailDto>(() =>
      postApiV1ProjectsByNameWordpressPages({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async wordpressUpdatePage(
    project: string,
    body: { currentSlug: string; title?: string; slug?: string; content?: string; status?: string; env?: WordpressEnv },
  ): Promise<WordpressPageDetailDto> {
    return this.invoke<WordpressPageDetailDto>(() =>
      putApiV1ProjectsByNameWordpressPage({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async wordpressSetMeta(
    project: string,
    body: { slug: string; title?: string; description?: string; noindex?: boolean; env?: WordpressEnv },
  ): Promise<WordpressPageDetailDto> {
    return this.invoke<WordpressPageDetailDto>(() =>
      postApiV1ProjectsByNameWordpressPageMeta({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async wordpressBulkSetMeta(
    project: string,
    body: {
      entries: Array<{ slug: string; title?: string; description?: string; noindex?: boolean }>
      env?: WordpressEnv
    },
  ): Promise<WordpressBulkMetaResultDto> {
    return this.invoke<WordpressBulkMetaResultDto>(() =>
      postApiV1ProjectsByNameWordpressPagesMetaBulk({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async wordpressSchema(
    project: string,
    slug: string,
    env?: WordpressEnv,
  ): Promise<{ env: WordpressEnv; slug: string; blocks: WordpressSchemaBlockDto[] }> {
    return this.invoke<{ env: WordpressEnv; slug: string; blocks: WordpressSchemaBlockDto[] }>(() =>
      getApiV1ProjectsByNameWordpressSchema({
        client: this.heyClient,
        path: { name: project },
        query: { slug, env },
      }),
    )
  }

  async wordpressSetSchema(
    project: string,
    body: { slug: string; type?: string; json: string; env?: WordpressEnv },
  ): Promise<WordpressManualAssistDto> {
    return this.invoke<WordpressManualAssistDto>(() =>
      postApiV1ProjectsByNameWordpressSchemaManual({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async wordpressSchemaDeploy(
    project: string,
    body: { profile: unknown; env?: WordpressEnv },
  ): Promise<WordpressSchemaDeployResultDto> {
    return this.invoke<WordpressSchemaDeployResultDto>(() =>
      postApiV1ProjectsByNameWordpressSchemaDeploy({
        client: this.heyClient,
        path: { name: project },
        body: body as never,
      }),
    )
  }

  async wordpressSchemaStatus(project: string, env?: WordpressEnv): Promise<WordpressSchemaStatusResultDto> {
    return this.invoke<WordpressSchemaStatusResultDto>(() =>
      getApiV1ProjectsByNameWordpressSchemaStatus({
        client: this.heyClient,
        path: { name: project },
        query: { env },
      }),
    )
  }

  async wordpressOnboard(
    project: string,
    body: {
      url: string
      username: string
      appPassword: string
      stagingUrl?: string
      defaultEnv?: WordpressEnv
      profile?: unknown
      skipSchema?: boolean
      skipSubmit?: boolean
    },
  ): Promise<WordpressOnboardResultDto> {
    return this.invoke<WordpressOnboardResultDto>(() =>
      postApiV1ProjectsByNameWordpressOnboard({
        client: this.heyClient,
        path: { name: project },
        body: body as never,
      }),
    )
  }

  async wordpressLlmsTxt(
    project: string,
    env?: WordpressEnv,
  ): Promise<{ env: WordpressEnv; url: string; content: string | null }> {
    return this.invoke<{ env: WordpressEnv; url: string; content: string | null }>(() =>
      getApiV1ProjectsByNameWordpressLlmsTxt({
        client: this.heyClient,
        path: { name: project },
        query: { env },
      }),
    )
  }

  async wordpressSetLlmsTxt(
    project: string,
    body: { content: string; env?: WordpressEnv },
  ): Promise<WordpressManualAssistDto> {
    return this.invoke<WordpressManualAssistDto>(() =>
      postApiV1ProjectsByNameWordpressLlmsTxtManual({
        client: this.heyClient,
        path: { name: project },
        body,
      }),
    )
  }

  async wordpressAudit(
    project: string,
    env?: WordpressEnv,
  ): Promise<{ env: WordpressEnv; pages: WordpressAuditPageDto[]; issues: WordpressAuditIssueDto[] }> {
    return this.invoke<{ env: WordpressEnv; pages: WordpressAuditPageDto[]; issues: WordpressAuditIssueDto[] }>(() =>
      getApiV1ProjectsByNameWordpressAudit({
        client: this.heyClient,
        path: { name: project },
        query: { env },
      }),
    )
  }

  async wordpressDiff(project: string, slug: string): Promise<WordpressDiffDto> {
    return this.invoke<WordpressDiffDto>(() =>
      getApiV1ProjectsByNameWordpressDiff({
        client: this.heyClient,
        path: { name: project },
        query: { slug },
      }),
    )
  }

  async wordpressStagingStatus(project: string): Promise<{
    stagingConfigured: boolean
    stagingUrl: string | null
    wpStagingActive: boolean
    adminUrl: string
  }> {
    return this.invoke<{
      stagingConfigured: boolean
      stagingUrl: string | null
      wpStagingActive: boolean
      adminUrl: string
    }>(() =>
      getApiV1ProjectsByNameWordpressStagingStatus({ client: this.heyClient, path: { name: project } }),
    )
  }

  async wordpressStagingPush(project: string): Promise<WordpressManualAssistDto> {
    return this.invoke<WordpressManualAssistDto>(() =>
      postApiV1ProjectsByNameWordpressStagingPush({ client: this.heyClient, path: { name: project } }),
    )
  }

  // ── Intelligence ────────────────────────────────────────────────────────

  async getInsights(project: string, opts?: { dismissed?: boolean; runId?: string; type?: string; severity?: string; limit?: number }): Promise<InsightDto[]> {
    return this.invoke<InsightDto[]>(() =>
      getApiV1ProjectsByNameInsights({
        client: this.heyClient,
        path: { name: project },
        query: {
          dismissed: opts?.dismissed ? 'true' : undefined,
          runId: opts?.runId,
          type: opts?.type,
          severity: opts?.severity,
          limit: opts?.limit !== undefined ? String(opts.limit) : undefined,
        } as never,
      }),
    )
  }

  async getInsight(project: string, id: string): Promise<InsightDto> {
    return this.invoke<InsightDto>(() =>
      getApiV1ProjectsByNameInsightsById({ client: this.heyClient, path: { name: project, id } }),
    )
  }

  async dismissInsight(project: string, id: string): Promise<{ ok: boolean }> {
    return this.invoke<{ ok: boolean }>(() =>
      postApiV1ProjectsByNameInsightsByIdDismiss({ client: this.heyClient, path: { name: project, id } }),
    )
  }

  // ── Content / health / search / report / doctor / citation visibility ──

  async getContentTargets(
    project: string,
    opts?: { limit?: number; includeInProgress?: boolean; winnabilityClass?: WinnabilityClass; ownable?: boolean },
  ): Promise<ContentTargetsResponseDto> {
    return this.invoke<ContentTargetsResponseDto>(() =>
      getApiV1ProjectsByNameContentTargets({
        client: this.heyClient,
        path: { name: project },
        query: {
          limit: opts?.limit,
          'include-in-progress': opts?.includeInProgress ? 'true' : undefined,
          'winnability-class': opts?.winnabilityClass,
          ownable: opts?.ownable ? 'true' : undefined,
        } as never,
      }),
    )
  }

  async getContentSources(project: string): Promise<ContentSourcesResponseDto> {
    return this.invoke<ContentSourcesResponseDto>(() =>
      getApiV1ProjectsByNameContentSources({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getContentGaps(project: string): Promise<ContentGapsResponseDto> {
    return this.invoke<ContentGapsResponseDto>(() =>
      getApiV1ProjectsByNameContentGaps({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getDomainClassifications(project: string): Promise<DomainClassificationsResponseDto> {
    return this.invoke<DomainClassificationsResponseDto>(() =>
      getApiV1ProjectsByNameContentDomainClassifications({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getContentBrief(project: string, targetRef: string): Promise<RecommendationBriefDto> {
    return this.invoke<RecommendationBriefDto>(() =>
      getApiV1ProjectsByNameContentRecommendationsByTargetRefBrief({
        client: this.heyClient,
        path: { name: project, targetRef },
      }),
    )
  }

  async synthesizeContentBrief(
    project: string,
    targetRef: string,
    opts?: { provider?: string; model?: string; forceRefresh?: boolean },
  ): Promise<RecommendationBriefDto> {
    return this.invoke<RecommendationBriefDto>(() =>
      postApiV1ProjectsByNameContentRecommendationsByTargetRefBrief({
        client: this.heyClient,
        path: { name: project, targetRef },
        body: { provider: opts?.provider, model: opts?.model, forceRefresh: opts?.forceRefresh },
      }),
    )
  }

  async getHealth(project: string): Promise<HealthSnapshotDto> {
    return this.invoke<HealthSnapshotDto>(() =>
      getApiV1ProjectsByNameHealthLatest({ client: this.heyClient, path: { name: project } }),
    )
  }

  async runDoctor(opts: { project?: string; checkIds?: string[] } = {}): Promise<DoctorReportDto> {
    const checkQuery = opts.checkIds && opts.checkIds.length > 0 ? { check: opts.checkIds.join(',') } : undefined
    if (opts.project) {
      return this.invoke<DoctorReportDto>(() =>
        getApiV1ProjectsByNameDoctor({
          client: this.heyClient,
          path: { name: opts.project! },
          query: checkQuery,
        }),
      )
    }
    return this.invoke<DoctorReportDto>(() =>
      getApiV1Doctor({ client: this.heyClient, query: checkQuery }),
    )
  }

  async getHealthHistory(project: string, limit?: number): Promise<HealthSnapshotDto[]> {
    return this.invoke<HealthSnapshotDto[]>(() =>
      getApiV1ProjectsByNameHealthHistory({
        client: this.heyClient,
        path: { name: project },
        query: { limit: limit !== undefined ? String(limit) : undefined } as never,
      }),
    )
  }

  async getCitationVisibility(project: string): Promise<CitationVisibilityResponse> {
    return this.invoke<CitationVisibilityResponse>(() =>
      getApiV1ProjectsByNameCitationsVisibility({ client: this.heyClient, path: { name: project } }),
    )
  }

  async getVisibilityStats(
    project: string,
    opts: {
      since?: string
      until?: string
      lastRuns?: number
      groupBy?: 'provider'
      month?: string
      shareOfVoice?: boolean
    } = {},
  ): Promise<VisibilityStatsDto> {
    return this.invoke<VisibilityStatsDto>(() =>
      getApiV1ProjectsByNameVisibilityStats({
        client: this.heyClient,
        path: { name: project },
        query: {
          since: opts.since,
          until: opts.until,
          lastRuns: opts.lastRuns,
          groupBy: opts.groupBy,
          month: opts.month,
          shareOfVoice: opts.shareOfVoice ? '1' : undefined,
        } as never,
      }),
    )
  }

  async getVisibilityCompare(project: string, from: string, to: string): Promise<VisibilityCompareDto> {
    return this.invoke<VisibilityCompareDto>(() =>
      getApiV1ProjectsByNameVisibilityCompare({
        client: this.heyClient,
        path: { name: project },
        query: { from, to } as never,
      }),
    )
  }

  // ── Backlinks — workspace-level ────────────────────────────────────────

  async backlinksStatus(): Promise<BacklinksInstallStatusDto> {
    return this.invoke<BacklinksInstallStatusDto>(() => getApiV1BacklinksStatus({ client: this.heyClient }))
  }

  async backlinksInstall(): Promise<BacklinksInstallResultDto> {
    return this.invoke<BacklinksInstallResultDto>(() => postApiV1BacklinksInstall({ client: this.heyClient }))
  }

  async backlinksTriggerSync(release?: string): Promise<CcReleaseSyncDto> {
    return this.invoke<CcReleaseSyncDto>(() =>
      postApiV1BacklinksSyncs({ client: this.heyClient, body: release ? { release } : undefined }),
    )
  }

  async backlinksLatestRelease(): Promise<CcAvailableRelease | null> {
    return this.invoke<CcAvailableRelease | null>(() => getApiV1BacklinksLatestRelease({ client: this.heyClient }))
  }

  async backlinksLatestSync(): Promise<CcReleaseSyncDto | null> {
    return this.invoke<CcReleaseSyncDto | null>(() => getApiV1BacklinksSyncsLatest({ client: this.heyClient }))
  }

  async backlinksListSyncs(): Promise<CcReleaseSyncDto[]> {
    return this.invoke<CcReleaseSyncDto[]>(() => getApiV1BacklinksSyncs({ client: this.heyClient }))
  }

  async backlinksCachedReleases(): Promise<CcCachedRelease[]> {
    return this.invoke<CcCachedRelease[]>(() => getApiV1BacklinksReleases({ client: this.heyClient }))
  }

  async backlinksPruneCache(release: string): Promise<{ ok: boolean }> {
    return this.invoke<{ ok: boolean }>(() =>
      deleteApiV1BacklinksCacheByRelease({ client: this.heyClient, path: { release } }),
    )
  }

  // ── Backlinks — project-scoped ─────────────────────────────────────────

  async backlinksExtract(project: string, release?: string): Promise<RunDto> {
    return this.invoke<RunDto>(() =>
      postApiV1ProjectsByNameBacklinksExtract({
        client: this.heyClient,
        path: { name: project },
        body: release ? { release } : {},
      }),
    )
  }

  async backlinksBingSync(project: string): Promise<RunDto> {
    return this.invoke<RunDto>(() =>
      postApiV1ProjectsByNameBacklinksBingSync({
        client: this.heyClient,
        path: { name: project },
      }),
    )
  }

  async backlinksSources(
    project: string,
    opts: { excludeCrawlers?: boolean } = {},
  ): Promise<BacklinkSourcesResponseDto> {
    return this.invoke<BacklinkSourcesResponseDto>(() =>
      getApiV1ProjectsByNameBacklinksSources({
        client: this.heyClient,
        path: { name: project },
        query: { excludeCrawlers: opts.excludeCrawlers ? '1' : undefined } as never,
      }),
    )
  }

  async backlinksSummary(
    project: string,
    opts: { release?: string; excludeCrawlers?: boolean; source?: BacklinkSource } = {},
  ): Promise<BacklinkSummaryDto | null> {
    return this.invoke<BacklinkSummaryDto | null>(() =>
      getApiV1ProjectsByNameBacklinksSummary({
        client: this.heyClient,
        path: { name: project },
        query: {
          release: opts.release,
          excludeCrawlers: opts.excludeCrawlers ? '1' : undefined,
          source: opts.source,
        } as never,
      }),
    )
  }

  async backlinksDomains(
    project: string,
    opts: { limit?: number; offset?: number; release?: string; excludeCrawlers?: boolean; source?: BacklinkSource } = {},
  ): Promise<BacklinkListResponse> {
    return this.invoke<BacklinkListResponse>(() =>
      getApiV1ProjectsByNameBacklinksDomains({
        client: this.heyClient,
        path: { name: project },
        query: {
          limit: opts.limit,
          offset: opts.offset,
          release: opts.release,
          excludeCrawlers: opts.excludeCrawlers ? '1' : undefined,
          source: opts.source,
        } as never,
      }),
    )
  }

  async backlinksHistory(project: string, opts: { source?: BacklinkSource } = {}): Promise<BacklinkHistoryEntry[]> {
    return this.invoke<BacklinkHistoryEntry[]>(() =>
      getApiV1ProjectsByNameBacklinksHistory({
        client: this.heyClient,
        path: { name: project },
        query: { source: opts.source } as never,
      }),
    )
  }
}
