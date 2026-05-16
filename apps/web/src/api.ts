import type { ErrorCode, GroundingSource, ProjectOverviewDto, ScheduleDto, NotificationDto, GscCoverageSummaryDto, GscCoverageSnapshotDto, GscPerformanceDailyDto, IndexingRequestResultDto, MetricsWindow, GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry, InsightDto, HealthSnapshotDto, ProjectReportDto, ReportAudience, RunKind, RunStatus, RunTrigger, RunErrorDto, CitationState, CitationVisibilityResponse, ComputedTransition, BacklinkSummaryDto, BacklinkDomainDto, BacklinkListResponse, BacklinkHistoryEntry, BacklinksInstallStatusDto, BacklinksInstallResultDto, CcAvailableRelease, CcCachedRelease, CcReleaseSyncDto, TrafficSourceDto, TrafficSourceDetailDto, TrafficSourceListResponse, TrafficStatusResponse, TrafficEventsResponse, TrafficConnectCloudRunRequest, TrafficConnectWordpressRequest, TrafficConnectVercelRequest, TrafficSyncResponse, DiscoveryRunRequest, DiscoverySessionDto, DiscoverySessionDetailDto, DiscoveryPromotePreview, DiscoveryPromoteRequest, DiscoveryPromoteResult } from '@ainyc/canonry-contracts'
export type { ProjectOverviewDto }
export type { BacklinkSummaryDto, BacklinkDomainDto, BacklinkListResponse, BacklinkHistoryEntry, BacklinksInstallStatusDto, BacklinksInstallResultDto, CcAvailableRelease, CcCachedRelease, CcReleaseSyncDto }
export type { TrafficSourceDto, TrafficSourceDetailDto, TrafficSourceListResponse, TrafficStatusResponse, TrafficEventsResponse, TrafficConnectCloudRunRequest, TrafficConnectWordpressRequest, TrafficConnectVercelRequest, TrafficSyncResponse }
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
  return import.meta.env.VITE_API_KEY ?? ''
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
 * apiFetch on 401/403 responses; also callable from tests.
 */
export function handleAuthExpired(): void {
  _onAuthExpired?.()
}

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

export interface ApiLocation {
  label: string
  city: string
  region: string
  country: string
  timezone?: string
}

export interface ApiProject {
  id: string
  name: string
  displayName: string
  canonicalDomain: string
  ownedDomains: string[]
  aliases: string[]
  country: string
  language: string
  tags: string[]
  labels: Record<string, string>
  providers: string[]
  locations: ApiLocation[]
  defaultLocation: string | null
  autoExtractBacklinks: boolean
  configSource: string
  configRevision: number
  createdAt: string
  updatedAt: string
}

export interface ApiRun {
  id: string
  projectId: string
  kind: RunKind
  status: RunStatus
  trigger: RunTrigger
  location: string | null
  startedAt: string | null
  finishedAt: string | null
  error: RunErrorDto | null
  createdAt: string
}

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

export interface ApiSnapshot {
  id: string
  runId: string
  queryId: string
  query: string | null
  provider: string
  citationState: CitationState
  answerMentioned?: boolean
  /** @deprecated legacy alias for `mentionState`; same data, kept for backwards compatibility. */
  visibilityState?: string
  mentionState?: string
  answerText: string | null
  citedDomains: string[]
  competitorOverlap: string[]
  recommendedCompetitors?: string[]
  matchedTerms?: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  model: string | null
  location: string | null
  createdAt: string
}

export interface ApiRunDetail extends ApiRun {
  snapshots: ApiSnapshot[]
}

export interface ApiQuery {
  id: string
  query: string
  createdAt: string
}

export interface ApiCompetitor {
  id: string
  domain: string
  createdAt: string
}

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

export interface ApiAuditEntry {
  id: string
  projectId: string | null
  actor: string
  action: string
  entityType: string
  entityId: string | null
  diff: unknown
  createdAt: string
}

export function fetchProjects(): Promise<ApiProject[]> {
  return apiFetch('/projects')
}

export function fetchProject(name: string): Promise<ApiProject> {
  return apiFetch(`/projects/${encodeURIComponent(name)}`)
}

export function fetchAllRuns(): Promise<ApiRun[]> {
  return apiFetch('/runs')
}

export function fetchProjectRuns(name: string): Promise<ApiRun[]> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/runs`)
}

export function fetchRunDetail(id: string): Promise<ApiRunDetail> {
  return apiFetch(`/runs/${encodeURIComponent(id)}`)
}

export function fetchQueries(name: string): Promise<ApiQuery[]> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/queries`)
}

export function fetchCompetitors(name: string): Promise<ApiCompetitor[]> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/competitors`)
}

export function fetchTimeline(name: string, location?: string): Promise<ApiTimelineEntry[]> {
  const params = new URLSearchParams()
  if (location !== undefined) params.set('location', location)
  const qs = params.toString()
  return apiFetch(`/projects/${encodeURIComponent(name)}/timeline${qs ? `?${qs}` : ''}`)
}

export function fetchHistory(name: string): Promise<ApiAuditEntry[]> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/history`)
}

export function fetchProjectOverview(
  name: string,
  opts?: { location?: string; since?: string },
): Promise<ProjectOverviewDto> {
  const params = new URLSearchParams()
  if (opts?.location) params.set('location', opts.location)
  if (opts?.since) params.set('since', opts.since)
  const qs = params.toString()
  return apiFetch(`/projects/${encodeURIComponent(name)}/overview${qs ? `?${qs}` : ''}`)
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
  return apiFetch(`/projects/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function setQueries(projectName: string, queries: string[]): Promise<ApiQuery[]> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/queries`, {
    method: 'PUT',
    body: JSON.stringify({ queries }),
  })
}

export function deleteQueries(projectName: string, queries: string[]): Promise<ApiQuery[]> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/queries`, {
    method: 'DELETE',
    body: JSON.stringify({ queries }),
  })
}

export function appendQueries(projectName: string, queries: string[]): Promise<ApiQuery[]> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/queries`, {
    method: 'POST',
    body: JSON.stringify({ queries }),
  })
}

export function setCompetitors(projectName: string, competitors: string[]): Promise<ApiCompetitor[]> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/competitors`, {
    method: 'PUT',
    body: JSON.stringify({ competitors }),
  })
}

export async function updateOwnedDomains(projectName: string, ownedDomains: string[]): Promise<ApiProject> {
  const project = await fetchProject(projectName)
  return createProject(projectName, {
    displayName: project.displayName,
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
    displayName: project.displayName,
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
    displayName: updates.displayName ?? project.displayName,
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
  return apiFetch(`/projects/${encodeURIComponent(name)}/runs`, { method: 'POST', body: JSON.stringify(body) })
}

export function addLocation(project: string, location: ApiLocation): Promise<ApiLocation> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/locations`, {
    method: 'POST',
    body: JSON.stringify(location),
  })
}

export function fetchLocations(project: string): Promise<{ locations: ApiLocation[]; defaultLocation: string | null }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/locations`)
}

export async function removeLocation(project: string, label: string): Promise<void> {
  await apiFetch(`/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(label)}`, { method: 'DELETE' })
}

export function setDefaultLocation(project: string, label: string): Promise<{ defaultLocation: string }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/locations/default`, {
    method: 'PUT',
    body: JSON.stringify({ label }),
  })
}

export async function deleteProject(name: string): Promise<void> {
  await apiFetch(`/projects/${encodeURIComponent(name)}`, { method: 'DELETE', body: '{}' })
}

export function fetchExport(name: string): Promise<unknown> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/export`)
}

export interface ApiProviderSummary {
  name: string
  displayName?: string
  keyUrl?: string
  modelHint?: string
  model?: string
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
  return apiFetch('/settings')
}

export interface ApiSessionState {
  authenticated: boolean
  setupRequired?: boolean
}

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

export function loginWithApiKey(apiKey: string): Promise<ApiSessionState> {
  return apiFetch('/session', {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  })
}

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
  return apiFetch(`/settings/providers/${encodeURIComponent(provider)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function updateGoogleAuthConfig(body: {
  clientId: string
  clientSecret: string
}): Promise<{ configured: boolean }> {
  return apiFetch('/settings/google', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export type ApiSchedule = ScheduleDto

export async function fetchSchedule(project: string): Promise<ApiSchedule | null> {
  try {
    return await apiFetch<ApiSchedule>(`/projects/${encodeURIComponent(project)}/schedule`)
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
  return apiFetch(`/projects/${encodeURIComponent(project)}/schedule`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function removeSchedule(project: string): Promise<void> {
  await apiFetch(`/projects/${encodeURIComponent(project)}/schedule`, { method: 'DELETE', body: '{}' })
}

export type ApiNotification = Omit<NotificationDto, 'webhookSecret'>

export function listNotifications(project: string): Promise<ApiNotification[]> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/notifications`)
}

export function addNotification(project: string, body: {
  channel: string
  url: string
  events: string[]
}): Promise<ApiNotification> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/notifications`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function removeNotification(project: string, id: string): Promise<void> {
  await apiFetch(`/projects/${encodeURIComponent(project)}/notifications/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' })
}

export function sendTestNotification(project: string, id: string): Promise<{ status: number; ok: boolean }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/notifications/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: '{}',
  })
}

export function generateQueries(projectName: string, provider: string, count?: number): Promise<{ queries: string[]; provider: string }> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/queries/generate`, {
    method: 'POST',
    body: JSON.stringify({ provider, count }),
  })
}

export interface ApiApplyResult {
  id: string
  name: string
  displayName: string
  configRevision: number
}

export function applyProjectConfig(config: object): Promise<ApiApplyResult> {
  return apiFetch('/apply', {
    method: 'POST',
    body: JSON.stringify(config),
  })
}

export function fetchNotificationEvents(): Promise<string[]> {
  return apiFetch('/notifications/events')
}

export function triggerAllRuns(body?: { providers?: string[] }): Promise<ApiTriggerAllRunsResult[]> {
  return apiFetch('/runs', {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

export interface ApiGoogleConnection {
  id: string
  domain: string
  connectionType: 'gsc' | 'ga4'
  propertyId: string | null
  sitemapUrl: string | null
  scopes: string[]
  createdAt: string
  updatedAt: string
}

export interface ApiGoogleProperty {
  siteUrl: string
  permissionLevel: string
}

export interface ApiGscPerformanceRow {
  date: string
  query: string
  page: string
  country: string | null
  device: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface ApiGscInspection {
  id: string
  url: string
  indexingState: string | null
  verdict: string | null
  coverageState: string | null
  pageFetchState: string | null
  robotsTxtState: string | null
  crawlTime: string | null
  lastCrawlResult: string | null
  isMobileFriendly: boolean | null
  richResults: string[]
  referringUrls: string[]
  inspectedAt: string
}

export interface ApiGscDeindexedRow {
  url: string
  previousState: string | null
  currentState: string | null
  transitionDate: string
}

export function fetchGoogleConnections(project: string): Promise<ApiGoogleConnection[]> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/connections`)
}

export function googleConnect(project: string, type: 'gsc' | 'ga4'): Promise<{ authUrl: string }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/connect`, {
    method: 'POST',
    body: JSON.stringify({ type }),
  })
}

export function googleDisconnect(project: string, type: string): Promise<void> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/connections/${encodeURIComponent(type)}`, {
    method: 'DELETE',
    body: '{}',
  })
}

export function fetchGoogleProperties(project: string): Promise<{ sites: ApiGoogleProperty[] }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/properties`)
}

export function saveGoogleProperty(project: string, type: 'gsc' | 'ga4', propertyId: string): Promise<{ propertyId: string }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/connections/${encodeURIComponent(type)}/property`, {
    method: 'PUT',
    body: JSON.stringify({ propertyId }),
  })
}

export function saveSitemapUrl(project: string, type: 'gsc' | 'ga4', sitemapUrl: string): Promise<{ sitemapUrl: string }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/connections/${encodeURIComponent(type)}/sitemap`, {
    method: 'PUT',
    body: JSON.stringify({ sitemapUrl }),
  })
}

export function triggerGscSync(project: string, opts?: { days?: number; full?: boolean }): Promise<ApiRun> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/sync`, {
    method: 'POST',
    body: JSON.stringify(opts ?? {}),
  })
}

export function fetchGscPerformance(
  project: string,
  params?: { startDate?: string; endDate?: string; query?: string; page?: string; limit?: number; offset?: number; window?: MetricsWindow },
): Promise<ApiGscPerformanceRow[]> {
  const qs = new URLSearchParams()
  if (params?.startDate) qs.set('startDate', params.startDate)
  if (params?.endDate) qs.set('endDate', params.endDate)
  if (params?.window && params.window !== 'all' && !params.startDate) qs.set('window', params.window)
  if (params?.query) qs.set('query', params.query)
  if (params?.page) qs.set('page', params.page)
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  if (params?.offset !== undefined && params.offset > 0) qs.set('offset', String(params.offset))
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/performance${query}`)
}

export function fetchGscPerformanceDaily(
  project: string,
  params?: { startDate?: string; endDate?: string; window?: MetricsWindow },
): Promise<GscPerformanceDailyDto> {
  const qs = new URLSearchParams()
  if (params?.startDate) qs.set('startDate', params.startDate)
  if (params?.endDate) qs.set('endDate', params.endDate)
  if (params?.window && params.window !== 'all' && !params.startDate) qs.set('window', params.window)
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/performance/daily${query}`)
}

export function inspectGscUrl(project: string, url: string): Promise<ApiGscInspection> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/inspect`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export function fetchGscInspections(
  project: string,
  params?: { url?: string; limit?: number },
): Promise<ApiGscInspection[]> {
  const qs = new URLSearchParams()
  if (params?.url) qs.set('url', params.url)
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/inspections${query}`)
}

export function fetchGscDeindexed(project: string): Promise<ApiGscDeindexedRow[]> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/deindexed`)
}

export type { GscCoverageSummaryDto as ApiGscCoverageSummary }

export function fetchGscCoverage(project: string): Promise<GscCoverageSummaryDto> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/coverage`)
}

export function fetchGscCoverageHistory(
  project: string,
  params?: { limit?: number },
): Promise<GscCoverageSnapshotDto[]> {
  const qs = new URLSearchParams()
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/coverage/history${query}`)
}

export function triggerInspectSitemap(project: string, opts?: { sitemapUrl?: string }): Promise<ApiRun> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/inspect-sitemap`, {
    method: 'POST',
    body: JSON.stringify(opts ?? {}),
  })
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
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/sitemaps`)
}

export function triggerDiscoverSitemaps(project: string): Promise<{ sitemaps: ApiGscSitemap[]; primarySitemapUrl: string; run: ApiRun }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/discover-sitemaps`, {
    method: 'POST',
    body: '{}',
  })
}

export function triggerDiscoveryRun(
  project: string,
  body?: DiscoveryRunRequest,
): Promise<ApiDiscoveryRunStartResponse> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/discover/run`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

export function fetchDiscoverySessions(
  project: string,
  opts?: { limit?: number },
): Promise<DiscoverySessionDto[]> {
  const qs = new URLSearchParams()
  if (opts?.limit !== undefined) qs.set('limit', String(opts.limit))
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/discover/sessions${query}`)
}

export function fetchDiscoverySession(
  project: string,
  sessionId: string,
): Promise<DiscoverySessionDetailDto> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/discover/sessions/${encodeURIComponent(sessionId)}`)
}

export function previewDiscoveryPromote(
  project: string,
  sessionId: string,
): Promise<DiscoveryPromotePreview> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/discover/sessions/${encodeURIComponent(sessionId)}/promote`)
}

export function promoteDiscovery(
  project: string,
  sessionId: string,
  body?: DiscoveryPromoteRequest,
): Promise<DiscoveryPromoteResult> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/discover/sessions/${encodeURIComponent(sessionId)}/promote`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

export type ApiIndexingRequestResult = IndexingRequestResultDto

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
  return apiFetch('/cdp/status')
}

export function configureCdp(host: string, port: number): Promise<{ endpoint: string }> {
  return apiFetch('/settings/cdp', {
    method: 'PUT',
    body: JSON.stringify({ host, port }),
  })
}

export function triggerCdpScreenshot(
  query: string,
  targets?: string[],
): Promise<{ results: { target: string; screenshotPath: string; answerText: string; citations: { uri: string; title: string }[] }[] }> {
  return apiFetch('/cdp/screenshot', {
    method: 'POST',
    body: JSON.stringify({ query, targets }),
  })
}

export function requestIndexing(
  project: string,
  body: { urls: string[]; allUnindexed?: boolean },
): Promise<ApiIndexingRequestResponse> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/indexing/request`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ── Bing Webmaster Tools ─────────────────────────────────────────────────────

export interface ApiBingConnection {
  connected: boolean
  domain: string
  siteUrl: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface ApiBingSite {
  url: string
  verified: boolean
}

export interface ApiBingInspection {
  id: string
  url: string
  httpCode: number | null
  inIndex: boolean | null
  lastCrawledDate: string | null
  inIndexDate: string | null
  inspectedAt: string
}

export interface ApiBingCoverageSummary {
  summary: {
    total: number
    indexed: number
    notIndexed: number
    unknown?: number
    percentage: number
  }
  lastInspectedAt: string | null
  indexed: ApiBingInspection[]
  notIndexed: ApiBingInspection[]
  unknown?: ApiBingInspection[]
}

export interface ApiBingKeywordStats {
  query: string
  impressions: number
  clicks: number
  ctr: number
  averagePosition: number
}

export function fetchBingStatus(project: string): Promise<ApiBingConnection> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/status`)
}

export function bingConnect(project: string, apiKey: string): Promise<{
  connected: boolean
  domain: string
  availableSites: ApiBingSite[]
}> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/connect`, {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  })
}

export function bingDisconnect(project: string): Promise<void> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/disconnect`, {
    method: 'DELETE',
    body: '{}',
  })
}

export function fetchBingSites(project: string): Promise<{ sites: ApiBingSite[] }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/sites`)
}

export function bingSetSite(project: string, siteUrl: string): Promise<{ siteUrl: string }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/set-site`, {
    method: 'POST',
    body: JSON.stringify({ siteUrl }),
  })
}

export function fetchBingCoverage(project: string): Promise<ApiBingCoverageSummary> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/coverage`)
}

export function fetchBingInspections(
  project: string,
  params?: { url?: string; limit?: number },
): Promise<ApiBingInspection[]> {
  const qs = new URLSearchParams()
  if (params?.url) qs.set('url', params.url)
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/inspections${query}`)
}

export function inspectBingUrl(project: string, url: string): Promise<ApiBingInspection> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/inspect-url`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export function inspectBingSitemap(project: string, opts?: { sitemapUrl?: string }): Promise<ApiRun> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/inspect-sitemap`, {
    method: 'POST',
    body: opts?.sitemapUrl ? JSON.stringify({ sitemapUrl: opts.sitemapUrl }) : undefined,
  })
}

export function bingRequestIndexing(
  project: string,
  body: { urls?: string[]; allUnindexed?: boolean },
): Promise<{
  summary: { total: number; succeeded: number; failed: number }
  results: Array<{ url: string; status: string; submittedAt: string; error?: string }>
}> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/request-indexing`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function fetchBingPerformance(project: string): Promise<ApiBingKeywordStats[]> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/bing/performance`)
}

export function updateBingApiKey(apiKey: string): Promise<{ configured: boolean }> {
  return apiFetch('/settings/bing', {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
  })
}

// Report
export function fetchReport(project: string): Promise<ProjectReportDto> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/report`)
}

function parseFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const match = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  return match?.[1] ?? null
}

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
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/status`)
}

export function fetchGaTraffic(project: string, limit?: number, window?: MetricsWindow): Promise<ApiGaTraffic> {
  const params = new URLSearchParams()
  if (limit) params.set('limit', String(limit))
  if (window && window !== 'all') params.set('window', window)
  const qs = params.toString() ? `?${params}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/traffic${qs}`)
}

export function triggerGaSync(project: string, days?: number): Promise<ApiGaSyncResult> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/sync`, {
    method: 'POST',
    body: JSON.stringify(days ? { days } : {}),
  })
}

export function connectGa(project: string, body: { propertyId: string; keyJson: string }): Promise<{ connected: boolean; propertyId: string; clientEmail: string }> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/connect`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export type { GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry }

export function fetchGaAiReferralHistory(project: string, window?: MetricsWindow): Promise<GA4AiReferralHistoryEntry[]> {
  const qs = window && window !== 'all' ? `?window=${window}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/ai-referral-history${qs}`)
}

export function fetchGaSocialReferralHistory(project: string, window?: MetricsWindow): Promise<GA4SocialReferralHistoryEntry[]> {
  const qs = window && window !== 'all' ? `?window=${window}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/social-referral-history${qs}`)
}

export function fetchGaSessionHistory(project: string, window?: MetricsWindow): Promise<GA4SessionHistoryEntry[]> {
  const qs = window && window !== 'all' ? `?window=${window}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/session-history${qs}`)
}

export function disconnectGa(project: string): Promise<void> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/disconnect`, {
    method: 'DELETE',
    body: '{}',
  })
}

// ── Server traffic (Cloud Run / log-based ingestion) ────────────────────────

export type ApiTrafficSource = TrafficSourceDto
export type ApiTrafficSourceDetail = TrafficSourceDetailDto
export type ApiTrafficSourceList = TrafficSourceListResponse
export type ApiTrafficStatus = TrafficStatusResponse
export type ApiTrafficEvents = TrafficEventsResponse
export type ApiTrafficSyncResult = TrafficSyncResponse

export function fetchServerTrafficSources(project: string): Promise<TrafficSourceListResponse> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/traffic/sources`)
}

export function fetchServerTrafficStatus(project: string): Promise<TrafficStatusResponse> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/traffic/status`)
}

export function fetchServerTrafficSource(project: string, sourceId: string): Promise<TrafficSourceDetailDto> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/traffic/sources/${encodeURIComponent(sourceId)}`)
}

export function fetchServerTrafficEvents(
  project: string,
  params?: { since?: string; until?: string; kind?: 'all' | 'crawler' | 'ai-referral'; sourceId?: string; limit?: number },
): Promise<TrafficEventsResponse> {
  const search: Record<string, string> = {}
  if (params?.since) search.since = params.since
  if (params?.until) search.until = params.until
  if (params?.kind) search.kind = params.kind
  if (params?.sourceId) search.sourceId = params.sourceId
  if (params?.limit !== undefined) search.limit = String(params.limit)
  const qs = Object.keys(search).length ? '?' + new URLSearchParams(search).toString() : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/traffic/events${qs}`)
}

export function connectServerTrafficCloudRun(
  project: string,
  body: TrafficConnectCloudRunRequest,
): Promise<TrafficSourceDto> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/traffic/connect/cloud-run`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function connectServerTrafficWordpress(
  project: string,
  body: TrafficConnectWordpressRequest,
): Promise<TrafficSourceDto> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/traffic/connect/wordpress`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function connectServerTrafficVercel(
  project: string,
  body: TrafficConnectVercelRequest,
): Promise<TrafficSourceDto> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/traffic/connect/vercel`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function triggerServerTrafficSync(
  project: string,
  sourceId: string,
  body?: { sinceMinutes?: number },
): Promise<TrafficSyncResponse> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/traffic/sources/${encodeURIComponent(sourceId)}/sync`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

// ── Intelligence ────────────────────────────────────────────────────────────

export function fetchInsights(project: string, runId?: string): Promise<InsightDto[]> {
  const qs = runId ? `?runId=${encodeURIComponent(runId)}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/insights${qs}`)
}

export function fetchLatestHealth(project: string): Promise<HealthSnapshotDto> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/health/latest`)
}

export function fetchCitationVisibility(project: string): Promise<CitationVisibilityResponse> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/citations/visibility`)
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
      .join(' \u00b7 ')

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
  return apiFetch('/backlinks/status')
}

export function installBacklinks(): Promise<BacklinksInstallResultDto> {
  return apiFetch('/backlinks/install', { method: 'POST' })
}

export function fetchLatestReleaseSync(): Promise<CcReleaseSyncDto | null> {
  return apiFetch('/backlinks/syncs/latest')
}

export function fetchReleaseSyncs(): Promise<CcReleaseSyncDto[]> {
  return apiFetch('/backlinks/syncs')
}

export function triggerReleaseSync(release?: string): Promise<CcReleaseSyncDto> {
  return apiFetch('/backlinks/syncs', {
    method: 'POST',
    body: JSON.stringify(release ? { release } : {}),
  })
}

export function fetchCachedReleases(): Promise<CcCachedRelease[]> {
  return apiFetch('/backlinks/releases')
}

export function fetchLatestAvailableRelease(): Promise<CcAvailableRelease | null> {
  return apiFetch('/backlinks/latest-release')
}

export function pruneCachedRelease(release: string): Promise<{ ok: boolean }> {
  return apiFetch(`/backlinks/cache/${encodeURIComponent(release)}`, {
    method: 'DELETE',
  })
}

export function fetchBacklinkSummary(
  projectName: string,
  opts: { release?: string; excludeCrawlers?: boolean } = {},
): Promise<BacklinkSummaryDto | null> {
  const params = new URLSearchParams()
  if (opts.release) params.set('release', opts.release)
  if (opts.excludeCrawlers) params.set('excludeCrawlers', '1')
  const qs = params.toString()
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/backlinks/summary${qs ? `?${qs}` : ''}`)
}

export function fetchBacklinkDomains(
  projectName: string,
  opts: { limit?: number; offset?: number; release?: string; excludeCrawlers?: boolean } = {},
): Promise<BacklinkListResponse> {
  const params = new URLSearchParams()
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.offset !== undefined) params.set('offset', String(opts.offset))
  if (opts.release) params.set('release', opts.release)
  if (opts.excludeCrawlers) params.set('excludeCrawlers', '1')
  const qs = params.toString()
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/backlinks/domains${qs ? `?${qs}` : ''}`)
}

export function fetchBacklinkHistory(projectName: string): Promise<BacklinkHistoryEntry[]> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/backlinks/history`)
}

export function triggerBacklinkExtract(projectName: string, release?: string): Promise<ApiRun> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/backlinks/extract`, {
    method: 'POST',
    body: JSON.stringify({ release: release ?? undefined }),
  })
}
