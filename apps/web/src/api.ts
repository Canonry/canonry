import type { ErrorCode, GroundingSource, ProjectOverviewDto, ScheduleDto, NotificationDto, GscCoverageSummaryDto, GscCoverageSnapshotDto, GscPerformanceDailyDto, IndexingRequestResultDto, MetricsWindow, GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry, InsightDto, ProjectReportDto, ReportAudience, CitationVisibilityResponse, BacklinkSummaryDto, BacklinkDomainDto, BacklinkListResponse, BacklinkHistoryEntry, BacklinksInstallStatusDto, BacklinksInstallResultDto, CcAvailableRelease, CcCachedRelease, CcReleaseSyncDto, TrafficSourceDto, TrafficSourceDetailDto, TrafficSourceListResponse, TrafficStatusResponse, TrafficEventsResponse, TrafficConnectCloudRunRequest, TrafficConnectWordpressRequest, TrafficConnectVercelRequest, TrafficSyncResponse, TrafficBackfillResponse, DiscoveryRunRequest, DiscoverySessionDto, DiscoverySessionDetailDto, DiscoveryPromotePreview, DiscoveryPromoteRequest, DiscoveryPromoteResult, ProjectDto, QueryDto, CompetitorDto, LocationContext, GoogleConnectionDto, GscUrlInspectionDto, GscDeindexedRowDto, BingUrlInspectionDto, BingCoverageSummaryDto, BingKeywordStatsDto, BingStatusDto, BingConnectResponseDto, BingSetSiteResponseDto, BingSitesResponseDto, GscSearchDataDto, ContentTargetDismissalDto, ContentTargetDismissRequest } from '@ainyc/canonry-contracts'
import {
  createClient as createHeyClient,
  // Projects + queries + competitors + locations + runs + apply + settings + telemetry
  getApiV1Projects,
  getApiV1ProjectsByName,
  putApiV1ProjectsByName,
  deleteApiV1ProjectsByName,
  getApiV1ProjectsByNameOverview,
  getApiV1ProjectsByNameExport,
  getApiV1ProjectsByNameQueries,
  putApiV1ProjectsByNameQueries,
  postApiV1ProjectsByNameQueries,
  postApiV1ProjectsByNameQueriesGenerate,
  postApiV1ProjectsByNameContentDismissals,
  deleteApiV1ProjectsByNameContentDismissalsByTargetRef,
  deleteApiV1ProjectsByNameCompetitors,
  getApiV1ProjectsByNameCompetitors,
  putApiV1ProjectsByNameCompetitors,
  postApiV1ProjectsByNameLocations,
  deleteApiV1ProjectsByNameLocationsByLabel,
  putApiV1ProjectsByNameLocationsDefault,
  getApiV1Runs,
  postApiV1Runs,
  getApiV1ProjectsByNameRuns,
  getApiV1RunsById,
  postApiV1ProjectsByNameRuns,
  getApiV1ProjectsByNameTimeline,
  postApiV1Apply,
  getApiV1Settings,
  putApiV1SettingsProvidersByName,
  putApiV1SettingsGoogle,
  putApiV1SettingsBing,
  putApiV1SettingsCdp,
  // Schedules / notifications
  getApiV1ProjectsByNameSchedule,
  putApiV1ProjectsByNameSchedule,
  deleteApiV1ProjectsByNameSchedule,
  getApiV1ProjectsByNameNotifications,
  postApiV1ProjectsByNameNotifications,
  deleteApiV1ProjectsByNameNotificationsById,
  postApiV1ProjectsByNameNotificationsByIdTest,
  // CDP
  getApiV1CdpStatus,
  // Google connections + GSC + Indexing
  postApiV1ProjectsByNameGoogleConnect,
  getApiV1ProjectsByNameGoogleConnections,
  deleteApiV1ProjectsByNameGoogleConnectionsByType,
  getApiV1ProjectsByNameGoogleProperties,
  putApiV1ProjectsByNameGoogleConnectionsByTypeProperty,
  putApiV1ProjectsByNameGoogleConnectionsByTypeSitemap,
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
  postApiV1ProjectsByNameGoogleIndexingRequest,
  // Discovery
  postApiV1ProjectsByNameDiscoverRun,
  getApiV1ProjectsByNameDiscoverSessions,
  getApiV1ProjectsByNameDiscoverSessionsById,
  getApiV1ProjectsByNameDiscoverSessionsByIdPromote,
  postApiV1ProjectsByNameDiscoverSessionsByIdPromote,
  // Bing
  postApiV1ProjectsByNameBingConnect,
  deleteApiV1ProjectsByNameBingDisconnect,
  getApiV1ProjectsByNameBingStatus,
  getApiV1ProjectsByNameBingSites,
  postApiV1ProjectsByNameBingSetSite,
  getApiV1ProjectsByNameBingCoverage,
  getApiV1ProjectsByNameBingInspections,
  postApiV1ProjectsByNameBingInspectUrl,
  postApiV1ProjectsByNameBingInspectSitemap,
  postApiV1ProjectsByNameBingRequestIndexing,
  getApiV1ProjectsByNameBingPerformance,
  // Report
  getApiV1ProjectsByNameReport,
  // GA4
  getApiV1ProjectsByNameGaStatus,
  postApiV1ProjectsByNameGaConnect,
  deleteApiV1ProjectsByNameGaDisconnect,
  postApiV1ProjectsByNameGaSync,
  getApiV1ProjectsByNameGaTraffic,
  getApiV1ProjectsByNameGaAiReferralHistory,
  getApiV1ProjectsByNameGaSocialReferralHistory,
  getApiV1ProjectsByNameGaSessionHistory,
  // Traffic — server-side
  getApiV1ProjectsByNameTrafficSources,
  getApiV1ProjectsByNameTrafficStatus,
  getApiV1ProjectsByNameTrafficSourcesById,
  getApiV1ProjectsByNameTrafficEvents,
  postApiV1ProjectsByNameTrafficConnectCloudRun,
  postApiV1ProjectsByNameTrafficConnectWordpress,
  postApiV1ProjectsByNameTrafficConnectVercel,
  postApiV1ProjectsByNameTrafficSourcesByIdSync,
  postApiV1ProjectsByNameTrafficSourcesByIdBackfill,
  // Intelligence
  getApiV1ProjectsByNameInsights,
  getApiV1ProjectsByNameCitationsVisibility,
  // Backlinks
  getApiV1BacklinksStatus,
  postApiV1BacklinksInstall,
  getApiV1BacklinksSyncsLatest,
  getApiV1BacklinksSyncs,
  postApiV1BacklinksSyncs,
  getApiV1BacklinksReleases,
  getApiV1BacklinksLatestRelease,
  deleteApiV1BacklinksCacheByRelease,
  getApiV1ProjectsByNameBacklinksSummary,
  getApiV1ProjectsByNameBacklinksDomains,
  getApiV1ProjectsByNameBacklinksHistory,
  postApiV1ProjectsByNameBacklinksExtract,
} from '@ainyc/canonry-api-client'
import type { RunDto, RunDetailDto } from '@ainyc/canonry-api-client'
export type { ProjectOverviewDto }
export type { BacklinkSummaryDto, BacklinkDomainDto, BacklinkListResponse, BacklinkHistoryEntry, BacklinksInstallStatusDto, BacklinksInstallResultDto, CcAvailableRelease, CcCachedRelease, CcReleaseSyncDto }
export type { TrafficSourceDto, TrafficSourceDetailDto, TrafficSourceListResponse, TrafficStatusResponse, TrafficEventsResponse, TrafficConnectCloudRunRequest, TrafficConnectWordpressRequest, TrafficConnectVercelRequest, TrafficSyncResponse, TrafficBackfillResponse }
export type { DiscoveryRunRequest, DiscoverySessionDto, DiscoverySessionDetailDto, DiscoveryPromotePreview, DiscoveryPromoteRequest, DiscoveryPromoteResult }

export type { GroundingSource }

/**
 * Client-side error that preserves the structured error code from the API.
 * Components can check `err.code` to distinguish error types (e.g. NOT_FOUND vs AUTH_REQUIRED).
 */
export class ApiError extends Error {
  readonly code: ErrorCode | 'UNKNOWN'
  readonly statusCode: number

  constructor(message: string, statusCode: number, code?: ErrorCode) {
    super(message)
    this.name = 'ApiError'
    this.code = code ?? 'UNKNOWN'
    this.statusCode = statusCode
  }
}

declare global {
  interface Window {
    __CANONRY_CONFIG__?: {
      /**
       * Sub-path prefix injected by `canonry serve --base-path /canonry/`.
       * When set, API requests are sent relative to this path so they route
       * correctly through reverse proxies that strip the prefix.
       * Example: '/canonry/' → API calls go to '/canonry/api/v1/...'
       */
      basePath?: string
    }
  }
}

function getApiBase(): string {
  if (typeof window !== 'undefined' && window.__CANONRY_CONFIG__?.basePath) {
    // Strip trailing slash then append /api/v1 so we never get double slashes
    return window.__CANONRY_CONFIG__.basePath.replace(/\/$/, '') + '/api/v1'
  }
  return '/api/v1'
}

const API_BASE = getApiBase()

/**
 * Absolute origin (scheme://host[:port]) plus any configured basePath.
 * The generated SDK builds requests through `new Request(url, …)` which
 * rejects relative URLs — `fetch('/api/v1/…')` works at runtime in a
 * browser but `new Request('/api/v1/…')` throws ERR_INVALID_URL. Anchoring
 * to `window.location.origin` keeps the URL absolute in every environment
 * (jsdom tests included).
 */
function getApiOrigin(): string {
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
  if (typeof window !== 'undefined' && window.__CANONRY_CONFIG__?.basePath) {
    return origin + window.__CANONRY_CONFIG__.basePath.replace(/\/$/, '')
  }
  return origin
}

function getPublicBase(): string {
  if (typeof window !== 'undefined' && window.__CANONRY_CONFIG__?.basePath) {
    return window.__CANONRY_CONFIG__.basePath.replace(/\/$/, '')
  }
  return ''
}

function publicPath(path: string): string {
  return `${getPublicBase()}${path}`
}

function healthFailureHint(path: string, statusCode: number): string | undefined {
  if (path === '/health' && statusCode === 404) {
    return 'Health endpoint returned 404. Check basePath or reverse-proxy configuration and make sure the dashboard reaches /health instead of an API-prefixed route.'
  }
  return undefined
}

function getApiKey(): string {
  return (import.meta.env.VITE_API_KEY as string | undefined) ?? ''
}

export function hasExplicitBrowserApiKey(): boolean {
  return Boolean(getApiKey())
}

let _onAuthExpired: (() => void) | null = null

/**
 * Register a handler to call when any API request returns 401 or 403.
 * Pass null to clear. Only one handler is active at a time.
 */
export function setOnAuthExpired(handler: (() => void) | null): void {
  _onAuthExpired = handler
}

/**
 * Trigger the registered auth-expiry handler. Called automatically by
 * apiFetch / invokeWeb on 401/403 responses; also callable from tests.
 */
export function handleAuthExpired(): void {
  _onAuthExpired?.()
}

/**
 * Module-level hey-api client preconfigured with the dashboard's basePath
 * and `VITE_API_KEY` (when set). Operations call it explicitly via the
 * `client` option; we don't rely on the SDK's default global client because
 * tests can stub this module's client and the dashboard's basePath is known
 * at import time.
 *
 * Exported so TanStack Query hooks can pass it to the generated
 * `<op>Options(...)` / `<op>Mutation(...)` helpers from
 * `@ainyc/canonry-api-client/react-query`. The hooks import this client
 * rather than re-creating one so the dashboard's auth + basePath + test
 * stubs stay in one place.
 */
export const heyClient = createHeyClient({
  baseUrl: getApiOrigin(),
  apiKey: getApiKey() || undefined,
})

// Session-expiry interceptor — runs for every response regardless of who
// called the SDK (invokeWeb wrapper, generated TanStack Query options, raw
// SDK call). Without this, hooks that bypass `invokeWeb` (e.g. components
// using `useQuery(getApiV1...Options(...))`) would silently 401 and leave
// the user staring at a broken dashboard instead of being kicked to login.
// Skips /session/* routes — a 401 there means "wrong password," not
// "your session expired."
heyClient.interceptors.response.use((res, req) => {
  if ((res.status === 401 || res.status === 403) && !req.url.includes('/api/v1/session')) {
    handleAuthExpired()
  }
  return res
})

/**
 * Result shape returned by every generated SDK operation. `data` is typed
 * `unknown` here — see `packages/canonry/src/client.ts` for the rationale
 * (looseObjectSchema routes generate `{ [k]: unknown }` data; tightening
 * forces hand-written DTOs to widen). `invokeWeb()` consumes this and
 * either throws an `ApiError` or returns `data as T`.
 */
type SdkResult = {
  data?: unknown
  error?: unknown
  request: Request
  response: Response
}

/**
 * Wrap a generated SDK call with `ApiError` mapping.
 *
 * 401/403 → `handleAuthExpired()` is handled by the `heyClient.interceptors.response`
 * hook (declared at module top) so generated TanStack Query options get the
 * same redirect-on-expiry behavior. Don't dispatch it here too — that would
 * fire the handler twice for every expired-session request that flows through
 * this wrapper.
 */
async function invokeWeb<T>(call: () => Promise<SdkResult>): Promise<T> {
  const result = await call()
  if (result.error !== undefined && result.error !== null) {
    const status = result.response.status
    let message = `API ${status}: ${result.response.statusText}`
    let code: ErrorCode | undefined
    if (typeof result.error === 'object' && result.error !== null) {
      const inner = (result.error as { error?: unknown }).error
      if (typeof inner === 'string') {
        message = inner
      } else if (inner && typeof inner === 'object') {
        const obj = inner as { message?: string; code?: string }
        if (obj.message) message = obj.message
        if (obj.code) code = obj.code as ErrorCode
      } else {
        const flat = result.error as { message?: string; code?: string }
        if (flat.message) message = flat.message
        if (flat.code) code = flat.code as ErrorCode
      }
    } else if (typeof result.error === 'string') {
      message = result.error
    }
    throw new ApiError(message, status, code)
  }
  if (result.response.status === 204) return undefined as T
  return result.data as T
}

/**
 * Raw HTTP — used for routes that aren't in the OpenAPI spec
 * (`/session*` login + setup flows, `/health` and other public probes
 * that live outside `/api/v1`). Everything else goes through the
 * generated SDK via `invokeWeb()`.
 */
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const key = getApiKey()
  const hasBody = options?.body != null
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: options?.credentials ?? 'same-origin',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const bodyText = await res.text()
    let message = `API ${res.status}: ${res.statusText}`
    let code: ErrorCode | undefined
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as {
          error?: string | { message?: string; code?: string }
          message?: string
        }
        if (typeof parsed.error === 'string') {
          message = parsed.error
        } else if (parsed.error?.message) {
          message = parsed.error.message
          code = parsed.error.code as ErrorCode | undefined
        } else if (parsed.message) {
          message = parsed.message
        }
      } catch {
        message = bodyText
      }
    }
    // Don't trigger auth-expiry on the session endpoints themselves — those
    // are the login/setup paths, and a 401 there means "wrong password", not
    // "your session expired."
    if ((res.status === 401 || res.status === 403) && !path.startsWith('/session')) {
      handleAuthExpired()
    }
    throw new ApiError(message, res.status, code)
  }
  if (res.status === 204) {
    return undefined as T
  }
  return res.json() as Promise<T>
}

/** Re-export of the contracts `LocationContext` — identical fields. */
export type ApiLocation = LocationContext

/**
 * Re-export of the generated `ProjectDto` from the spec.
 * `displayName`, `createdAt`, `updatedAt` are optional (`?: string`) — all
 * consumers already coalesce with `displayName || name` / `?? name`.
 * `locations` is inlined (no longer references the local `ApiLocation`).
 */
export type ApiProject = ProjectDto

/**
 * Re-export of the generated `RunDto`. Spec marks `location`/`startedAt`/
 * `finishedAt`/`error` as `?: T | null` (optional + nullable); consumers
 * already coalesce / nullable-check.
 */
export type ApiRun = RunDto

export interface ApiDiscoveryRunStartResponse {
  runId: string
  sessionId: string
  status: 'running'
}

export interface ApiTriggerAllRunsConflict {
  projectName: string
  projectId: string
  status: 'conflict'
  error: string
}

export type ApiTriggerAllRunsResult = (ApiRun & { projectName: string }) | ApiTriggerAllRunsConflict

/**
 * Snapshot shape returned inside `RunDetailDto.snapshots[]`. There's no
 * standalone `SnapshotDto` in the spec — the snapshot fields are only
 * defined as an inline array element on the run-detail response. Use
 * `NonNullable<...>` because `snapshots?: Array<...>` is optional in the
 * spec (a queued/running run has no snapshots yet).
 */
export type ApiSnapshot = NonNullable<RunDetailDto['snapshots']>[number]

/**
 * Re-export of the generated `RunDetailDto`. Consumers that destructure
 * `.snapshots` must guard for `undefined` (queued/running runs have none).
 */
export type ApiRunDetail = RunDetailDto

/**
 * Re-export of the generated `QueryDto` from the spec.
 * Shape matches; zero consumer migration needed.
 */
export type ApiQuery = QueryDto

/**
 * Re-export of the generated `CompetitorDto` from the spec.
 * Shape matches; zero consumer migration needed.
 */
export type ApiCompetitor = CompetitorDto

export interface ApiTimelineRunEntry {
  runId: string
  createdAt: string
  citationState: string
  transition: string
  answerMentioned?: boolean
  /** @deprecated legacy alias for `mentionState`. */
  visibilityState?: string
  /** @deprecated legacy alias for `mentionTransition`. */
  visibilityTransition?: string
  mentionState?: string
  mentionTransition?: string
  location?: string | null
}

export interface ApiTimelineEntry {
  query: string
  runs: ApiTimelineRunEntry[]
  providerRuns?: Record<string, ApiTimelineRunEntry[]>
  modelRuns?: Record<string, ApiTimelineRunEntry[]>
}

export function fetchProjects(): Promise<ApiProject[]> {
  return invokeWeb<ApiProject[]>(() => getApiV1Projects({ client: heyClient }))
}

export function fetchProject(name: string): Promise<ApiProject> {
  return invokeWeb<ApiProject>(() => getApiV1ProjectsByName({ client: heyClient, path: { name } }))
}

export function fetchAllRuns(): Promise<ApiRun[]> {
  return invokeWeb<ApiRun[]>(() => getApiV1Runs({ client: heyClient }))
}

export function fetchProjectRuns(name: string): Promise<ApiRun[]> {
  return invokeWeb<ApiRun[]>(() => getApiV1ProjectsByNameRuns({ client: heyClient, path: { name } }))
}

export function fetchRunDetail(id: string): Promise<ApiRunDetail> {
  return invokeWeb<ApiRunDetail>(() => getApiV1RunsById({ client: heyClient, path: { id } }))
}

export function fetchQueries(name: string): Promise<ApiQuery[]> {
  return invokeWeb<ApiQuery[]>(() => getApiV1ProjectsByNameQueries({ client: heyClient, path: { name } }))
}

export function fetchCompetitors(name: string): Promise<ApiCompetitor[]> {
  return invokeWeb<ApiCompetitor[]>(() => getApiV1ProjectsByNameCompetitors({ client: heyClient, path: { name } }))
}

export function fetchTimeline(name: string, location?: string): Promise<ApiTimelineEntry[]> {
  return invokeWeb<ApiTimelineEntry[]>(() =>
    getApiV1ProjectsByNameTimeline({ client: heyClient, path: { name }, query: { location } }),
  )
}

export function fetchProjectOverview(
  name: string,
  opts?: { location?: string; since?: string },
): Promise<ProjectOverviewDto> {
  return invokeWeb<ProjectOverviewDto>(() =>
    getApiV1ProjectsByNameOverview({
      client: heyClient,
      path: { name },
      query: { location: opts?.location, since: opts?.since } as never,
    }),
  )
}

export function createProject(name: string, body: {
  displayName: string
  canonicalDomain: string
  ownedDomains?: string[]
  aliases?: string[]
  country: string
  language: string
  tags?: string[]
  labels?: Record<string, string>
  providers?: string[]
  locations?: ApiLocation[]
  defaultLocation?: string | null
  autoExtractBacklinks?: boolean
}): Promise<ApiProject> {
  return invokeWeb<ApiProject>(() =>
    putApiV1ProjectsByName({ client: heyClient, path: { name }, body: body as never }),
  )
}

export function setQueries(projectName: string, queries: string[]): Promise<ApiQuery[]> {
  return invokeWeb<ApiQuery[]>(() =>
    putApiV1ProjectsByNameQueries({ client: heyClient, path: { name: projectName }, body: { queries } }),
  )
}

export function appendQueries(projectName: string, queries: string[]): Promise<ApiQuery[]> {
  return invokeWeb<ApiQuery[]>(() =>
    postApiV1ProjectsByNameQueries({ client: heyClient, path: { name: projectName }, body: { queries } }),
  )
}

/**
 * Persist a "mark addressed" dismissal for one content recommendation. The
 * backend (`POST /projects/:name/content/dismissals`) idempotently upserts a
 * row keyed by `(projectId, targetRef)`. Returns the stored dismissal so the
 * caller can confirm what landed (timestamp + audit fields).
 */
export function dismissContentTarget(
  projectName: string,
  body: ContentTargetDismissRequest,
): Promise<ContentTargetDismissalDto> {
  return invokeWeb<ContentTargetDismissalDto>(() =>
    postApiV1ProjectsByNameContentDismissals({ client: heyClient, path: { name: projectName }, body }),
  )
}

/**
 * Reverse a dismissal. The recommendation reappears on the next report load
 * if the orchestrator still surfaces it.
 */
export function undismissContentTarget(projectName: string, targetRef: string): Promise<void> {
  return invokeWeb<void>(() =>
    deleteApiV1ProjectsByNameContentDismissalsByTargetRef({
      client: heyClient,
      path: { name: projectName, targetRef },
    }),
  )
}

export function setCompetitors(projectName: string, competitors: string[]): Promise<ApiCompetitor[]> {
  return invokeWeb<ApiCompetitor[]>(() =>
    putApiV1ProjectsByNameCompetitors({
      client: heyClient,
      path: { name: projectName },
      body: { competitors },
    }),
  )
}

/**
 * Remove specific competitors by domain. Returns the remaining tracked
 * competitors. Domains are normalized server-side, so either the original or
 * a subdomain form resolves to the stored registrable domain.
 */
export function removeCompetitors(projectName: string, competitors: string[]): Promise<ApiCompetitor[]> {
  return invokeWeb<ApiCompetitor[]>(() =>
    deleteApiV1ProjectsByNameCompetitors({
      client: heyClient,
      path: { name: projectName },
      body: { competitors },
    }),
  )
}

export async function updateOwnedDomains(projectName: string, ownedDomains: string[]): Promise<ApiProject> {
  const project = await fetchProject(projectName)
  return createProject(projectName, {
    displayName: project.displayName ?? project.name,
    canonicalDomain: project.canonicalDomain,
    ownedDomains,
    aliases: project.aliases,
    country: project.country,
    language: project.language,
    tags: project.tags,
    labels: project.labels,
    providers: project.providers,
    locations: project.locations,
    defaultLocation: project.defaultLocation,
  })
}

export async function updateAliases(projectName: string, aliases: string[]): Promise<ApiProject> {
  const project = await fetchProject(projectName)
  return createProject(projectName, {
    displayName: project.displayName ?? project.name,
    canonicalDomain: project.canonicalDomain,
    ownedDomains: project.ownedDomains,
    aliases,
    country: project.country,
    language: project.language,
    tags: project.tags,
    labels: project.labels,
    providers: project.providers,
    locations: project.locations,
    defaultLocation: project.defaultLocation,
  })
}

export async function updateProject(projectName: string, updates: {
  displayName?: string
  canonicalDomain?: string
  ownedDomains?: string[]
  aliases?: string[]
  country?: string
  language?: string
  locations?: ApiLocation[]
  defaultLocation?: string | null
}): Promise<ApiProject> {
  const project = await fetchProject(projectName)
  return createProject(projectName, {
    displayName: updates.displayName ?? project.displayName ?? project.name,
    canonicalDomain: updates.canonicalDomain ?? project.canonicalDomain,
    ownedDomains: updates.ownedDomains ?? project.ownedDomains,
    aliases: updates.aliases ?? project.aliases,
    country: updates.country ?? project.country,
    language: updates.language ?? project.language,
    tags: project.tags,
    labels: project.labels,
    providers: project.providers,
    locations: updates.locations ?? project.locations,
    defaultLocation: updates.defaultLocation !== undefined ? updates.defaultLocation : project.defaultLocation,
  })
}

export function triggerRun(name: string, opts?: { location?: string; allLocations?: boolean; noLocation?: boolean }): Promise<ApiRun> {
  const body: Record<string, unknown> = {}
  if (opts?.location) body.location = opts.location
  if (opts?.allLocations) body.allLocations = true
  if (opts?.noLocation) body.noLocation = true
  return invokeWeb<ApiRun>(() =>
    postApiV1ProjectsByNameRuns({ client: heyClient, path: { name }, body: body as never }),
  )
}

export function addLocation(project: string, location: ApiLocation): Promise<ApiLocation> {
  return invokeWeb<ApiLocation>(() =>
    postApiV1ProjectsByNameLocations({ client: heyClient, path: { name: project }, body: location }),
  )
}

export async function removeLocation(project: string, label: string): Promise<void> {
  await invokeWeb<unknown>(() =>
    deleteApiV1ProjectsByNameLocationsByLabel({ client: heyClient, path: { name: project, label } }),
  )
}

export function setDefaultLocation(project: string, label: string): Promise<{ defaultLocation: string }> {
  return invokeWeb<{ defaultLocation: string }>(() =>
    putApiV1ProjectsByNameLocationsDefault({
      client: heyClient,
      path: { name: project },
      body: { label },
    }),
  )
}

export async function deleteProject(name: string): Promise<void> {
  await invokeWeb<unknown>(() =>
    deleteApiV1ProjectsByName({ client: heyClient, path: { name } }),
  )
}

export function fetchExport(name: string): Promise<unknown> {
  return invokeWeb<unknown>(() => getApiV1ProjectsByNameExport({ client: heyClient, path: { name } }))
}

export interface ApiProviderSummary {
  name: string
  displayName?: string
  keyUrl?: string
  modelHint?: string
  model?: string
  defaultModel?: string
  configured: boolean
  quota?: {
    maxConcurrency: number
    maxRequestsPerMinute: number
    maxRequestsPerDay: number
  }
}

export interface ApiSettings {
  providers: ApiProviderSummary[]
  google: {
    configured: boolean
  }
  bing: {
    configured: boolean
  }
}

export function fetchSettings(): Promise<ApiSettings> {
  return invokeWeb<ApiSettings>(() => getApiV1Settings({ client: heyClient }))
}

export interface ApiSessionState {
  authenticated: boolean
  setupRequired?: boolean
}

// /session* routes are not in the OpenAPI spec — keep on raw apiFetch.

export function fetchSession(): Promise<ApiSessionState> {
  return apiFetch('/session')
}

export function setupDashboardPassword(password: string): Promise<ApiSessionState> {
  return apiFetch('/session/setup', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export function loginWithPassword(password: string): Promise<ApiSessionState> {
  return apiFetch('/session', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

// /health is outside /api/v1 — keep on raw fetch.

export async function fetchHealthCheck(): Promise<{ status: string }> {
  const res = await fetch(publicPath('/health'), { credentials: 'same-origin' })
  if (!res.ok) {
    throw new Error(`Health check failed: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<{ status: string }>
}

export function updateProviderConfig(provider: string, body: {
  apiKey?: string
  baseUrl?: string
  model?: string
  quota?: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number }
}): Promise<ApiProviderSummary> {
  return invokeWeb<ApiProviderSummary>(() =>
    putApiV1SettingsProvidersByName({
      client: heyClient,
      path: { name: provider } as never,
      body,
    }),
  )
}

export function updateGoogleAuthConfig(body: {
  clientId: string
  clientSecret: string
}): Promise<{ configured: boolean }> {
  return invokeWeb<{ configured: boolean }>(() =>
    putApiV1SettingsGoogle({ client: heyClient, body }),
  )
}

export type ApiSchedule = ScheduleDto

export async function fetchSchedule(project: string): Promise<ApiSchedule | null> {
  try {
    return await invokeWeb<ApiSchedule>(() =>
      getApiV1ProjectsByNameSchedule({ client: heyClient, path: { name: project } }),
    )
  } catch (e) {
    if (e instanceof ApiError && e.statusCode === 404) return null
    throw e
  }
}

export function saveSchedule(project: string, body: {
  preset?: string
  cron?: string
  timezone?: string
  providers?: string[]
  enabled?: boolean
}): Promise<ApiSchedule> {
  return invokeWeb<ApiSchedule>(() =>
    putApiV1ProjectsByNameSchedule({
      client: heyClient,
      path: { name: project },
      body: body as never,
    }),
  )
}

export async function removeSchedule(project: string): Promise<void> {
  await invokeWeb<unknown>(() =>
    deleteApiV1ProjectsByNameSchedule({ client: heyClient, path: { name: project } }),
  )
}

export type ApiNotification = Omit<NotificationDto, 'webhookSecret'>

export function listNotifications(project: string): Promise<ApiNotification[]> {
  return invokeWeb<ApiNotification[]>(() =>
    getApiV1ProjectsByNameNotifications({ client: heyClient, path: { name: project } }),
  )
}

export function addNotification(project: string, body: {
  channel: string
  url: string
  events: string[]
}): Promise<ApiNotification> {
  return invokeWeb<ApiNotification>(() =>
    postApiV1ProjectsByNameNotifications({
      client: heyClient,
      path: { name: project },
      body: body as never,
    }),
  )
}

export async function removeNotification(project: string, id: string): Promise<void> {
  await invokeWeb<unknown>(() =>
    deleteApiV1ProjectsByNameNotificationsById({
      client: heyClient,
      path: { name: project, id },
    }),
  )
}

export function sendTestNotification(project: string, id: string): Promise<{ status: number; ok: boolean }> {
  return invokeWeb<{ status: number; ok: boolean }>(() =>
    postApiV1ProjectsByNameNotificationsByIdTest({
      client: heyClient,
      path: { name: project, id },
    }),
  )
}

export function generateQueries(projectName: string, provider: string, count?: number): Promise<{ queries: string[]; provider: string }> {
  return invokeWeb<{ queries: string[]; provider: string }>(() =>
    postApiV1ProjectsByNameQueriesGenerate({
      client: heyClient,
      path: { name: projectName },
      body: { provider, count } as never,
    }),
  )
}

export interface ApiApplyResult {
  id: string
  name: string
  displayName: string
  configRevision: number
}

export function applyProjectConfig(config: object): Promise<ApiApplyResult> {
  return invokeWeb<ApiApplyResult>(() => postApiV1Apply({ client: heyClient, body: config as never }))
}

export function triggerAllRuns(body?: { providers?: string[] }): Promise<ApiTriggerAllRunsResult[]> {
  return invokeWeb<ApiTriggerAllRunsResult[]>(() =>
    postApiV1Runs({ client: heyClient, body: (body ?? {}) as never }),
  )
}

/**
 * Re-export of the generated `GoogleConnectionDto`. Spec marks
 * `propertyId` / `sitemapUrl` as optional (`?: string | null`); consumers
 * already nullable-coalesce so no consumer changes needed.
 */
export type ApiGoogleConnection = GoogleConnectionDto

export interface ApiGoogleProperty {
  siteUrl: string
  permissionLevel: string
}

/** Re-export of the generated `GscSearchDataDto`. */
export type ApiGscPerformanceRow = GscSearchDataDto

/**
 * Re-export of the generated `GscUrlInspectionDto`. After PR #568 added
 * `referringUrls` to the contracts schema, this is now field-equivalent
 * to the hand-typed interface. Spec marks several fields as optional
 * (`?: T | null`); consumers already nullable-coalesce.
 */
export type ApiGscInspection = GscUrlInspectionDto

/** Re-export of the generated `GscDeindexedRowDto`. Identical shape. */
export type ApiGscDeindexedRow = GscDeindexedRowDto

export function fetchGoogleConnections(project: string): Promise<ApiGoogleConnection[]> {
  return invokeWeb<ApiGoogleConnection[]>(() =>
    getApiV1ProjectsByNameGoogleConnections({ client: heyClient, path: { name: project } }),
  )
}

export function googleConnect(project: string, type: 'gsc' | 'ga4'): Promise<{ authUrl: string }> {
  return invokeWeb<{ authUrl: string }>(() =>
    postApiV1ProjectsByNameGoogleConnect({
      client: heyClient,
      path: { name: project },
      body: { type } as never,
    }),
  )
}

export function googleDisconnect(project: string, type: string): Promise<void> {
  return invokeWeb<void>(() =>
    deleteApiV1ProjectsByNameGoogleConnectionsByType({
      client: heyClient,
      path: { name: project, type } as never,
    }),
  )
}

export function fetchGoogleProperties(project: string): Promise<{ sites: ApiGoogleProperty[] }> {
  return invokeWeb<{ sites: ApiGoogleProperty[] }>(() =>
    getApiV1ProjectsByNameGoogleProperties({ client: heyClient, path: { name: project } }),
  )
}

export function saveGoogleProperty(project: string, type: 'gsc' | 'ga4', propertyId: string): Promise<{ propertyId: string }> {
  return invokeWeb<{ propertyId: string }>(() =>
    putApiV1ProjectsByNameGoogleConnectionsByTypeProperty({
      client: heyClient,
      path: { name: project, type } as never,
      body: { propertyId },
    }),
  )
}

export function saveSitemapUrl(project: string, type: 'gsc' | 'ga4', sitemapUrl: string): Promise<{ sitemapUrl: string }> {
  return invokeWeb<{ sitemapUrl: string }>(() =>
    putApiV1ProjectsByNameGoogleConnectionsByTypeSitemap({
      client: heyClient,
      path: { name: project, type } as never,
      body: { sitemapUrl },
    }),
  )
}

export function triggerGscSync(project: string, opts?: { days?: number; full?: boolean }): Promise<ApiRun> {
  return invokeWeb<ApiRun>(() =>
    postApiV1ProjectsByNameGoogleGscSync({
      client: heyClient,
      path: { name: project },
      body: opts ?? {},
    }),
  )
}

export function fetchGscPerformance(
  project: string,
  params?: { startDate?: string; endDate?: string; query?: string; page?: string; limit?: number; offset?: number; window?: MetricsWindow },
): Promise<ApiGscPerformanceRow[]> {
  const query: Record<string, string> = {}
  if (params?.startDate) query.startDate = params.startDate
  if (params?.endDate) query.endDate = params.endDate
  if (params?.window && params.window !== 'all' && !params.startDate) query.window = params.window
  if (params?.query) query.query = params.query
  if (params?.page) query.page = params.page
  if (params?.limit !== undefined) query.limit = String(params.limit)
  if (params?.offset !== undefined && params.offset > 0) query.offset = String(params.offset)
  return invokeWeb<ApiGscPerformanceRow[]>(() =>
    getApiV1ProjectsByNameGoogleGscPerformance({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function fetchGscPerformanceDaily(
  project: string,
  params?: { startDate?: string; endDate?: string; window?: MetricsWindow },
): Promise<GscPerformanceDailyDto> {
  const query: Record<string, string> = {}
  if (params?.startDate) query.startDate = params.startDate
  if (params?.endDate) query.endDate = params.endDate
  if (params?.window && params.window !== 'all' && !params.startDate) query.window = params.window
  return invokeWeb<GscPerformanceDailyDto>(() =>
    getApiV1ProjectsByNameGoogleGscPerformanceDaily({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function inspectGscUrl(project: string, url: string): Promise<ApiGscInspection> {
  return invokeWeb<ApiGscInspection>(() =>
    postApiV1ProjectsByNameGoogleGscInspect({
      client: heyClient,
      path: { name: project },
      body: { url },
    }),
  )
}

export function fetchGscInspections(
  project: string,
  params?: { url?: string; limit?: number },
): Promise<ApiGscInspection[]> {
  const query: Record<string, string> = {}
  if (params?.url) query.url = params.url
  if (params?.limit !== undefined) query.limit = String(params.limit)
  return invokeWeb<ApiGscInspection[]>(() =>
    getApiV1ProjectsByNameGoogleGscInspections({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function fetchGscDeindexed(project: string): Promise<ApiGscDeindexedRow[]> {
  return invokeWeb<ApiGscDeindexedRow[]>(() =>
    getApiV1ProjectsByNameGoogleGscDeindexed({ client: heyClient, path: { name: project } }),
  )
}

export type { GscCoverageSummaryDto as ApiGscCoverageSummary }

export function fetchGscCoverage(project: string): Promise<GscCoverageSummaryDto> {
  return invokeWeb<GscCoverageSummaryDto>(() =>
    getApiV1ProjectsByNameGoogleGscCoverage({ client: heyClient, path: { name: project } }),
  )
}

export function fetchGscCoverageHistory(
  project: string,
  params?: { limit?: number },
): Promise<GscCoverageSnapshotDto[]> {
  return invokeWeb<GscCoverageSnapshotDto[]>(() =>
    getApiV1ProjectsByNameGoogleGscCoverageHistory({
      client: heyClient,
      path: { name: project },
      query: { limit: params?.limit !== undefined ? String(params.limit) : undefined } as never,
    }),
  )
}

export function triggerInspectSitemap(project: string, opts?: { sitemapUrl?: string }): Promise<ApiRun> {
  return invokeWeb<ApiRun>(() =>
    postApiV1ProjectsByNameGoogleGscInspectSitemap({
      client: heyClient,
      path: { name: project },
      body: opts ?? {},
    }),
  )
}

export interface ApiGscSitemap {
  path: string
  lastSubmitted?: string
  isPending?: boolean
  isSitemapsIndex?: boolean
  type?: string
  lastDownloaded?: string
  warnings?: string
  errors?: string
  contents?: Array<{ type: string; submitted: string; indexed: string }>
}

export function fetchGscSitemaps(project: string): Promise<{ sitemaps: ApiGscSitemap[] }> {
  return invokeWeb<{ sitemaps: ApiGscSitemap[] }>(() =>
    getApiV1ProjectsByNameGoogleGscSitemaps({ client: heyClient, path: { name: project } }),
  )
}

export function triggerDiscoverSitemaps(project: string): Promise<{ sitemaps: ApiGscSitemap[]; primarySitemapUrl: string; run: ApiRun }> {
  return invokeWeb<{ sitemaps: ApiGscSitemap[]; primarySitemapUrl: string; run: ApiRun }>(() =>
    postApiV1ProjectsByNameGoogleGscDiscoverSitemaps({ client: heyClient, path: { name: project } }),
  )
}

export function triggerDiscoveryRun(
  project: string,
  body?: DiscoveryRunRequest,
): Promise<ApiDiscoveryRunStartResponse> {
  return invokeWeb<ApiDiscoveryRunStartResponse>(() =>
    postApiV1ProjectsByNameDiscoverRun({
      client: heyClient,
      path: { name: project },
      body: (body ?? {}) as never,
    }),
  )
}

export function fetchDiscoverySessions(
  project: string,
  opts?: { limit?: number },
): Promise<DiscoverySessionDto[]> {
  return invokeWeb<DiscoverySessionDto[]>(() =>
    getApiV1ProjectsByNameDiscoverSessions({
      client: heyClient,
      path: { name: project },
      query: { limit: opts?.limit !== undefined ? String(opts.limit) : undefined } as never,
    }),
  )
}

export function fetchDiscoverySession(
  project: string,
  sessionId: string,
): Promise<DiscoverySessionDetailDto> {
  return invokeWeb<DiscoverySessionDetailDto>(() =>
    getApiV1ProjectsByNameDiscoverSessionsById({
      client: heyClient,
      path: { name: project, id: sessionId },
    }),
  )
}

export function previewDiscoveryPromote(
  project: string,
  sessionId: string,
): Promise<DiscoveryPromotePreview> {
  return invokeWeb<DiscoveryPromotePreview>(() =>
    getApiV1ProjectsByNameDiscoverSessionsByIdPromote({
      client: heyClient,
      path: { name: project, id: sessionId },
    }),
  )
}

export function promoteDiscovery(
  project: string,
  sessionId: string,
  body?: DiscoveryPromoteRequest,
): Promise<DiscoveryPromoteResult> {
  return invokeWeb<DiscoveryPromoteResult>(() =>
    postApiV1ProjectsByNameDiscoverSessionsByIdPromote({
      client: heyClient,
      path: { name: project, id: sessionId },
      body: (body ?? {}) as never,
    }),
  )
}

export interface ApiIndexingRequestResponse {
  summary: { total: number; succeeded: number; failed: number }
  results: IndexingRequestResultDto[]
}

export interface ApiCdpTarget {
  name: string
  alive: boolean
  lastUsed: string | null
}

export interface ApiCdpStatus {
  connected: boolean
  endpoint: string
  version?: string
  browserVersion?: string
  targets: ApiCdpTarget[]
}

export function fetchCdpStatus(): Promise<ApiCdpStatus> {
  return invokeWeb<ApiCdpStatus>(() => getApiV1CdpStatus({ client: heyClient }))
}

export function configureCdp(host: string, port: number): Promise<{ endpoint: string }> {
  return invokeWeb<{ endpoint: string }>(() =>
    putApiV1SettingsCdp({ client: heyClient, body: { host, port } }),
  )
}

export function requestIndexing(
  project: string,
  body: { urls: string[]; allUnindexed?: boolean },
): Promise<ApiIndexingRequestResponse> {
  return invokeWeb<ApiIndexingRequestResponse>(() =>
    postApiV1ProjectsByNameGoogleIndexingRequest({
      client: heyClient,
      path: { name: project },
      body,
    }),
  )
}

// ── Bing Webmaster Tools ─────────────────────────────────────────────────────

/** Re-export of the generated `BingStatusDto`. */
export type ApiBingConnection = BingStatusDto

/** Inline-array item shape from `BingSitesResponseDto.sites` — the spec
 * inlines it rather than $ref-ing a `BingSiteDto` component. */
export type ApiBingSite = BingSitesResponseDto['sites'][number]

/** Re-export of the generated `BingUrlInspectionDto`. */
export type ApiBingInspection = BingUrlInspectionDto

/** Re-export of the generated `BingCoverageSummaryDto`. */
export type ApiBingCoverageSummary = BingCoverageSummaryDto

/** Re-export of the generated `BingKeywordStatsDto`. */
export type ApiBingKeywordStats = BingKeywordStatsDto

export function fetchBingStatus(project: string): Promise<ApiBingConnection> {
  return invokeWeb<ApiBingConnection>(() =>
    getApiV1ProjectsByNameBingStatus({ client: heyClient, path: { name: project } }),
  )
}

export function bingConnect(project: string, apiKey: string): Promise<BingConnectResponseDto> {
  return invokeWeb<BingConnectResponseDto>(() =>
    postApiV1ProjectsByNameBingConnect({
      client: heyClient,
      path: { name: project },
      body: { apiKey },
    }),
  )
}

export function bingDisconnect(project: string): Promise<void> {
  return invokeWeb<void>(() =>
    deleteApiV1ProjectsByNameBingDisconnect({ client: heyClient, path: { name: project } }),
  )
}

export function fetchBingSites(project: string): Promise<BingSitesResponseDto> {
  return invokeWeb<BingSitesResponseDto>(() =>
    getApiV1ProjectsByNameBingSites({ client: heyClient, path: { name: project } }),
  )
}

export function bingSetSite(project: string, siteUrl: string): Promise<BingSetSiteResponseDto> {
  return invokeWeb<BingSetSiteResponseDto>(() =>
    postApiV1ProjectsByNameBingSetSite({
      client: heyClient,
      path: { name: project },
      body: { siteUrl },
    }),
  )
}

export function fetchBingCoverage(project: string): Promise<ApiBingCoverageSummary> {
  return invokeWeb<ApiBingCoverageSummary>(() =>
    getApiV1ProjectsByNameBingCoverage({ client: heyClient, path: { name: project } }),
  )
}

export function fetchBingInspections(
  project: string,
  params?: { url?: string; limit?: number },
): Promise<ApiBingInspection[]> {
  const query: Record<string, string> = {}
  if (params?.url) query.url = params.url
  if (params?.limit !== undefined) query.limit = String(params.limit)
  return invokeWeb<ApiBingInspection[]>(() =>
    getApiV1ProjectsByNameBingInspections({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function inspectBingUrl(project: string, url: string): Promise<ApiBingInspection> {
  return invokeWeb<ApiBingInspection>(() =>
    postApiV1ProjectsByNameBingInspectUrl({
      client: heyClient,
      path: { name: project },
      body: { url },
    }),
  )
}

export function inspectBingSitemap(project: string, opts?: { sitemapUrl?: string }): Promise<ApiRun> {
  return invokeWeb<ApiRun>(() =>
    postApiV1ProjectsByNameBingInspectSitemap({
      client: heyClient,
      path: { name: project },
      body: opts?.sitemapUrl ? { sitemapUrl: opts.sitemapUrl } : {},
    }),
  )
}

export function bingRequestIndexing(
  project: string,
  body: { urls?: string[]; allUnindexed?: boolean },
): Promise<{
  summary: { total: number; succeeded: number; failed: number }
  results: Array<{ url: string; status: string; submittedAt: string; error?: string }>
}> {
  return invokeWeb<{
    summary: { total: number; succeeded: number; failed: number }
    results: Array<{ url: string; status: string; submittedAt: string; error?: string }>
  }>(() =>
    postApiV1ProjectsByNameBingRequestIndexing({
      client: heyClient,
      path: { name: project },
      body,
    }),
  )
}

export function fetchBingPerformance(project: string): Promise<ApiBingKeywordStats[]> {
  return invokeWeb<ApiBingKeywordStats[]>(() =>
    getApiV1ProjectsByNameBingPerformance({ client: heyClient, path: { name: project } }),
  )
}

export function updateBingApiKey(apiKey: string): Promise<{ configured: boolean }> {
  return invokeWeb<{ configured: boolean }>(() =>
    putApiV1SettingsBing({ client: heyClient, body: { apiKey } }),
  )
}

// Report
export function fetchReport(project: string): Promise<ProjectReportDto> {
  return invokeWeb<ProjectReportDto>(() =>
    getApiV1ProjectsByNameReport({ client: heyClient, path: { name: project } }),
  )
}

function parseFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const match = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  return match?.[1] ?? null
}

// Blob download — keep raw fetch so we can read the binary body + parse
// the Content-Disposition filename. The generated SDK would JSON-parse the
// response and discard the binary payload.
export async function downloadReportHtml(project: string, audience: ReportAudience = 'agency'): Promise<void> {
  const key = getApiKey()
  const params = new URLSearchParams({ audience })
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/report.html?${params.toString()}`, {
    credentials: 'same-origin',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  })
  if (!res.ok) {
    throw new ApiError(`Failed to download report: ${res.status}`, res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const filename =
    parseFilenameFromContentDisposition(res.headers.get('Content-Disposition'))
    ?? `canonry-report-${project}.html`
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── GA4 Traffic ─────────────────────────────────────────────────────────────

export interface ApiGaStatus {
  connected: boolean
  propertyId: string | null
  clientEmail: string | null
  lastSyncedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface ApiGaTrafficPage {
  landingPage: string
  sessions: number
  organicSessions: number
  /** Direct-channel sessions for this landing page (sessions with no source). 0 for legacy rows. */
  directSessions: number
  users: number
}

export interface ApiGaTrafficReferral {
  source: string
  medium: string
  sourceDimension: 'session' | 'first_user' | 'manual_utm'
  sessions: number
  users: number
}

export interface ApiGaTrafficAiLandingPage {
  source: string
  medium: string
  sourceDimension: 'session' | 'first_user' | 'manual_utm'
  landingPage: string
  sessions: number
  users: number
}

export interface ApiGaSocialReferral {
  source: string
  medium: string
  channelGroup: string
  sessions: number
  users: number
}

export interface ApiGaChannelBucket {
  sessions: number
  sharePct: number
  sharePctDisplay: string
}

export interface ApiGaChannelBreakdown {
  organic: ApiGaChannelBucket
  social: ApiGaChannelBucket
  direct: ApiGaChannelBucket
  ai: ApiGaChannelBucket
  other: ApiGaChannelBucket
}

export interface ApiGaTraffic {
  totalSessions: number
  totalOrganicSessions: number
  /** Total Direct-channel sessions across the synced window. */
  totalDirectSessions: number
  totalUsers: number
  topPages: ApiGaTrafficPage[]
  aiReferrals: ApiGaTrafficReferral[]
  aiReferralLandingPages: ApiGaTrafficAiLandingPage[]
  /** Deduped AI session total (MAX per date+source+medium across attribution dimensions). Cross-cutting: can overlap with Direct/Organic/Social. */
  aiSessionsDeduped: number
  /** Deduped AI user total. */
  aiUsersDeduped: number
  /** AI sessions whose CURRENT sessionSource matched an AI engine. Can overlap with raw Organic/Social/Direct totals; channelBreakdown removes those overlaps for display. */
  aiSessionsBySession: number
  /** AI users whose CURRENT sessionSource matched an AI engine. */
  aiUsersBySession: number
  socialReferrals: ApiGaSocialReferral[]
  /** Total social sessions (session-scoped via sessionDefaultChannelGroup). */
  socialSessions: number
  /** Total social users (session-scoped via sessionDefaultChannelGroup). */
  socialUsers: number
  /** Five disjoint buckets used for the channel breakdown cards. */
  channelBreakdown: ApiGaChannelBreakdown
  /** Organic sessions as a percentage of total sessions (0–100, rounded). */
  organicSharePct: number
  /** Deduped AI sessions as a percentage of total sessions (0–100, rounded). Cross-cutting: can overlap with Direct/Organic/Social. */
  aiSharePct: number
  /** Session-source-only AI sessions as a percentage of total sessions (0–100, rounded). Can overlap with raw Organic/Social/Direct totals. */
  aiSharePctBySession: number
  /** Social sessions as a percentage of total sessions (0–100, rounded). */
  socialSharePct: number
  /** Direct sessions as a percentage of total sessions (0–100, rounded). */
  directSharePct: number
  /** Display string for organicSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  organicSharePctDisplay: string
  /** Display string for aiSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctDisplay: string
  /** Display string for aiSharePctBySession: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  aiSharePctBySessionDisplay: string
  /** Display string for socialSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  socialSharePctDisplay: string
  /** Display string for directSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  directSharePctDisplay: string
  /** Sessions not covered by Organic, Social, Direct, or AI (session) channels — e.g. Referral, Email, Paid Search, Display. */
  otherSessions: number
  /** Other sessions as a percentage of total sessions (0–100, rounded). */
  otherSharePct: number
  /** Display string for otherSharePct: 'X%', '<1%' for non-zero shares that round below 1, or '—' when sessions exist but total is unknown (partial sync). */
  otherSharePctDisplay: string
  lastSyncedAt: string | null
  /** Start of the synced date range (YYYY-MM-DD), null if no data. */
  periodStart: string | null
  /** End of the synced date range (YYYY-MM-DD), null if no data. */
  periodEnd: string | null
}

export interface ApiGaSyncResult {
  synced: boolean
  rowCount: number
  aiReferralCount: number
  socialReferralCount: number
  days: number
  syncedAt: string
}

export function fetchGaStatus(project: string): Promise<ApiGaStatus> {
  return invokeWeb<ApiGaStatus>(() =>
    getApiV1ProjectsByNameGaStatus({ client: heyClient, path: { name: project } }),
  )
}

export function fetchGaTraffic(project: string, limit?: number, window?: MetricsWindow): Promise<ApiGaTraffic> {
  const query: Record<string, string> = {}
  if (limit) query.limit = String(limit)
  if (window && window !== 'all') query.window = window
  return invokeWeb<ApiGaTraffic>(() =>
    getApiV1ProjectsByNameGaTraffic({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function triggerGaSync(project: string, days?: number): Promise<ApiGaSyncResult> {
  return invokeWeb<ApiGaSyncResult>(() =>
    postApiV1ProjectsByNameGaSync({
      client: heyClient,
      path: { name: project },
      body: days ? { days } : {},
    }),
  )
}

export function connectGa(project: string, body: { propertyId: string; keyJson: string }): Promise<{ connected: boolean; propertyId: string; clientEmail: string }> {
  return invokeWeb<{ connected: boolean; propertyId: string; clientEmail: string }>(() =>
    postApiV1ProjectsByNameGaConnect({
      client: heyClient,
      path: { name: project },
      body,
    }),
  )
}

export type { GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry }

export function fetchGaAiReferralHistory(project: string, window?: MetricsWindow): Promise<GA4AiReferralHistoryEntry[]> {
  const query: Record<string, string> = {}
  if (window && window !== 'all') query.window = window
  return invokeWeb<GA4AiReferralHistoryEntry[]>(() =>
    getApiV1ProjectsByNameGaAiReferralHistory({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function fetchGaSocialReferralHistory(project: string, window?: MetricsWindow): Promise<GA4SocialReferralHistoryEntry[]> {
  const query: Record<string, string> = {}
  if (window && window !== 'all') query.window = window
  return invokeWeb<GA4SocialReferralHistoryEntry[]>(() =>
    getApiV1ProjectsByNameGaSocialReferralHistory({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function fetchGaSessionHistory(project: string, window?: MetricsWindow): Promise<GA4SessionHistoryEntry[]> {
  const query: Record<string, string> = {}
  if (window && window !== 'all') query.window = window
  return invokeWeb<GA4SessionHistoryEntry[]>(() =>
    getApiV1ProjectsByNameGaSessionHistory({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function disconnectGa(project: string): Promise<void> {
  return invokeWeb<void>(() =>
    deleteApiV1ProjectsByNameGaDisconnect({ client: heyClient, path: { name: project } }),
  )
}

// ── Server traffic (Cloud Run / log-based ingestion) ────────────────────────

export type ApiTrafficSourceDetail = TrafficSourceDetailDto
export type ApiTrafficSourceList = TrafficSourceListResponse
export type ApiTrafficStatus = TrafficStatusResponse
export type ApiTrafficEvents = TrafficEventsResponse
export type ApiTrafficSyncResult = TrafficSyncResponse

export function fetchServerTrafficSources(project: string): Promise<TrafficSourceListResponse> {
  return invokeWeb<TrafficSourceListResponse>(() =>
    getApiV1ProjectsByNameTrafficSources({ client: heyClient, path: { name: project } }),
  )
}

export function fetchServerTrafficStatus(project: string): Promise<TrafficStatusResponse> {
  return invokeWeb<TrafficStatusResponse>(() =>
    getApiV1ProjectsByNameTrafficStatus({ client: heyClient, path: { name: project } }),
  )
}

export function fetchServerTrafficSource(project: string, sourceId: string): Promise<TrafficSourceDetailDto> {
  return invokeWeb<TrafficSourceDetailDto>(() =>
    getApiV1ProjectsByNameTrafficSourcesById({
      client: heyClient,
      path: { name: project, id: sourceId },
    }),
  )
}

export function fetchServerTrafficEvents(
  project: string,
  params?: { since?: string; until?: string; kind?: 'all' | 'crawler' | 'ai-referral'; sourceId?: string; limit?: number },
): Promise<TrafficEventsResponse> {
  const query: Record<string, string> = {}
  if (params?.since) query.since = params.since
  if (params?.until) query.until = params.until
  if (params?.kind) query.kind = params.kind
  if (params?.sourceId) query.sourceId = params.sourceId
  if (params?.limit !== undefined) query.limit = String(params.limit)
  return invokeWeb<TrafficEventsResponse>(() =>
    getApiV1ProjectsByNameTrafficEvents({
      client: heyClient,
      path: { name: project },
      query: query as never,
    }),
  )
}

export function connectServerTrafficCloudRun(
  project: string,
  body: TrafficConnectCloudRunRequest,
): Promise<TrafficSourceDto> {
  return invokeWeb<TrafficSourceDto>(() =>
    postApiV1ProjectsByNameTrafficConnectCloudRun({
      client: heyClient,
      path: { name: project },
      body: body as never,
    }),
  )
}

export function connectServerTrafficWordpress(
  project: string,
  body: TrafficConnectWordpressRequest,
): Promise<TrafficSourceDto> {
  return invokeWeb<TrafficSourceDto>(() =>
    postApiV1ProjectsByNameTrafficConnectWordpress({
      client: heyClient,
      path: { name: project },
      body,
    }),
  )
}

export function connectServerTrafficVercel(
  project: string,
  body: TrafficConnectVercelRequest,
): Promise<TrafficSourceDto> {
  return invokeWeb<TrafficSourceDto>(() =>
    postApiV1ProjectsByNameTrafficConnectVercel({
      client: heyClient,
      path: { name: project },
      body,
    }),
  )
}

export function triggerServerTrafficSync(
  project: string,
  sourceId: string,
  body?: { sinceMinutes?: number },
): Promise<TrafficSyncResponse> {
  return invokeWeb<TrafficSyncResponse>(() =>
    postApiV1ProjectsByNameTrafficSourcesByIdSync({
      client: heyClient,
      path: { name: project, id: sourceId },
      body: body ?? {},
    }),
  )
}

export function triggerServerTrafficBackfill(
  project: string,
  sourceId: string,
  body?: { days?: number },
): Promise<TrafficBackfillResponse> {
  return invokeWeb<TrafficBackfillResponse>(() =>
    postApiV1ProjectsByNameTrafficSourcesByIdBackfill({
      client: heyClient,
      path: { name: project, id: sourceId },
      body: body ?? {},
    }),
  )
}

// ── Intelligence ────────────────────────────────────────────────────────────

export function fetchInsights(project: string, runId?: string): Promise<InsightDto[]> {
  return invokeWeb<InsightDto[]>(() =>
    getApiV1ProjectsByNameInsights({
      client: heyClient,
      path: { name: project },
      query: { runId } as never,
    }),
  )
}

export function fetchCitationVisibility(project: string): Promise<CitationVisibilityResponse> {
  return invokeWeb<CitationVisibilityResponse>(() =>
    getApiV1ProjectsByNameCitationsVisibility({ client: heyClient, path: { name: project } }),
  )
}

// ── Health ──────────────────────────────────────────────────────────────────

import type { ServiceStatus, UpdateAvailable } from './view-models.js'

function parseUpdateAvailable(value: unknown): UpdateAvailable | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (
    typeof v.current !== 'string' ||
    typeof v.latest !== 'string' ||
    typeof v.url !== 'string' ||
    typeof v.upgradeCommand !== 'string'
  ) return undefined
  return {
    current: v.current,
    latest: v.latest,
    url: v.url,
    upgradeCommand: v.upgradeCommand,
  }
}

export async function fetchServiceStatus(path: string, label: string): Promise<ServiceStatus> {
  const requestPath = publicPath(path)

  try {
    const res = await fetch(requestPath, { credentials: 'same-origin' })
    if (!res.ok) {
      return {
        label,
        state: 'error',
        detail: `${label} ${res.status}: ${res.statusText}`,
        statusCode: res.status,
        hint: healthFailureHint(path, res.status),
      }
    }

    const payload = await res.json() as Record<string, unknown>
    const version = typeof payload.version === 'string' ? payload.version : 'unknown'
    const databaseConfigured =
      typeof payload.databaseUrlConfigured === 'boolean' ? payload.databaseUrlConfigured : undefined
    const lastHeartbeatAt = typeof payload.lastHeartbeatAt === 'string' ? payload.lastHeartbeatAt : undefined
    const updateAvailable = parseUpdateAvailable(payload.updateAvailable)
    const detail = [
      version,
      databaseConfigured === false ? 'database not configured' : 'database configured',
      lastHeartbeatAt ? `heartbeat ${lastHeartbeatAt}` : undefined,
    ]
      .filter(Boolean)
      .join(' · ')

    return {
      label,
      state: 'ok',
      detail,
      version,
      databaseConfigured,
      lastHeartbeatAt,
      ...(updateAvailable ? { updateAvailable } : {}),
    }
  } catch (error) {
    return {
      label,
      state: 'error',
      detail: error instanceof Error ? error.message : 'unreachable',
      hint: path === '/health'
        ? `Request failed while checking ${requestPath}. If this instance is served behind a sub-path, verify the dashboard basePath and reverse-proxy rewrites.`
        : undefined,
    }
  }
}

// --- Backlinks (Common Crawl) ---

export function fetchBacklinksStatus(): Promise<BacklinksInstallStatusDto> {
  return invokeWeb<BacklinksInstallStatusDto>(() => getApiV1BacklinksStatus({ client: heyClient }))
}

export function installBacklinks(): Promise<BacklinksInstallResultDto> {
  return invokeWeb<BacklinksInstallResultDto>(() => postApiV1BacklinksInstall({ client: heyClient }))
}

export function fetchLatestReleaseSync(): Promise<CcReleaseSyncDto | null> {
  return invokeWeb<CcReleaseSyncDto | null>(() => getApiV1BacklinksSyncsLatest({ client: heyClient }))
}

export function fetchReleaseSyncs(): Promise<CcReleaseSyncDto[]> {
  return invokeWeb<CcReleaseSyncDto[]>(() => getApiV1BacklinksSyncs({ client: heyClient }))
}

export function triggerReleaseSync(release?: string): Promise<CcReleaseSyncDto> {
  return invokeWeb<CcReleaseSyncDto>(() =>
    postApiV1BacklinksSyncs({ client: heyClient, body: release ? { release } : {} }),
  )
}

export function fetchCachedReleases(): Promise<CcCachedRelease[]> {
  return invokeWeb<CcCachedRelease[]>(() => getApiV1BacklinksReleases({ client: heyClient }))
}

export function fetchLatestAvailableRelease(): Promise<CcAvailableRelease | null> {
  return invokeWeb<CcAvailableRelease | null>(() => getApiV1BacklinksLatestRelease({ client: heyClient }))
}

export function pruneCachedRelease(release: string): Promise<{ ok: boolean }> {
  return invokeWeb<{ ok: boolean }>(() =>
    deleteApiV1BacklinksCacheByRelease({ client: heyClient, path: { release } }),
  )
}

export function fetchBacklinkSummary(
  projectName: string,
  opts: { release?: string; excludeCrawlers?: boolean } = {},
): Promise<BacklinkSummaryDto | null> {
  return invokeWeb<BacklinkSummaryDto | null>(() =>
    getApiV1ProjectsByNameBacklinksSummary({
      client: heyClient,
      path: { name: projectName },
      query: {
        release: opts.release,
        excludeCrawlers: opts.excludeCrawlers ? '1' : undefined,
      } as never,
    }),
  )
}

export function fetchBacklinkDomains(
  projectName: string,
  opts: { limit?: number; offset?: number; release?: string; excludeCrawlers?: boolean } = {},
): Promise<BacklinkListResponse> {
  return invokeWeb<BacklinkListResponse>(() =>
    getApiV1ProjectsByNameBacklinksDomains({
      client: heyClient,
      path: { name: projectName },
      query: {
        limit: opts.limit !== undefined ? String(opts.limit) : undefined,
        offset: opts.offset !== undefined ? String(opts.offset) : undefined,
        release: opts.release,
        excludeCrawlers: opts.excludeCrawlers ? '1' : undefined,
      } as never,
    }),
  )
}

export function fetchBacklinkHistory(projectName: string): Promise<BacklinkHistoryEntry[]> {
  return invokeWeb<BacklinkHistoryEntry[]>(() =>
    getApiV1ProjectsByNameBacklinksHistory({ client: heyClient, path: { name: projectName } }),
  )
}

export function triggerBacklinkExtract(projectName: string, release?: string): Promise<ApiRun> {
  return invokeWeb<ApiRun>(() =>
    postApiV1ProjectsByNameBacklinksExtract({
      client: heyClient,
      path: { name: projectName },
      body: { release: release ?? undefined },
    }),
  )
}
