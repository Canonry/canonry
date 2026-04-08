import type { ErrorCode, GroundingSource, ScheduleDto, NotificationDto, GscCoverageSummaryDto, GscCoverageSnapshotDto, IndexingRequestResultDto, BrandMetricsDto, GapAnalysisDto, SourceBreakdownDto, MetricsWindow, GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry, InsightDto, HealthSnapshotDto, RunKind, RunStatus, RunTrigger, CitationState, ComputedTransition } from '@ainyc/canonry-contracts'

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

function getApiKey(): string {
  return import.meta.env.VITE_API_KEY ?? ''
}

export function hasExplicitBrowserApiKey(): boolean {
  return Boolean(getApiKey())
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const key = getApiKey()
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: options?.credentials ?? 'same-origin',
    headers: {
      'Content-Type': 'application/json',
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
  country: string
  language: string
  tags: string[]
  labels: Record<string, string>
  providers: string[]
  locations: ApiLocation[]
  defaultLocation: string | null
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
  error: string | null
  createdAt: string
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
  keywordId: string
  keyword: string | null
  provider: string
  citationState: CitationState
  answerMentioned?: boolean
  visibilityState?: string
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

export interface ApiKeyword {
  id: string
  keyword: string
  createdAt: string
}

export interface ApiCompetitor {
  id: string
  domain: string
  createdAt: string
}

export interface ApiTimelineEntry {
  keyword: string
  runs: {
    runId: string
    createdAt: string
    citationState: string
    transition: string
    answerMentioned?: boolean
    visibilityState?: string
    visibilityTransition?: string
  }[]
  providerRuns?: Record<string, {
    runId: string
    createdAt: string
    citationState: string
    transition: string
    answerMentioned?: boolean
    visibilityState?: string
    visibilityTransition?: string
  }[]>
  modelRuns?: Record<string, {
    runId: string
    createdAt: string
    citationState: string
    transition: string
    answerMentioned?: boolean
    visibilityState?: string
    visibilityTransition?: string
  }[]>
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

export function fetchKeywords(name: string): Promise<ApiKeyword[]> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/keywords`)
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

export function createProject(name: string, body: {
  displayName: string
  canonicalDomain: string
  ownedDomains?: string[]
  country: string
  language: string
  tags?: string[]
  labels?: Record<string, string>
  providers?: string[]
  locations?: ApiLocation[]
  defaultLocation?: string | null
}): Promise<ApiProject> {
  return apiFetch(`/projects/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function setKeywords(projectName: string, keywords: string[]): Promise<ApiKeyword[]> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/keywords`, {
    method: 'PUT',
    body: JSON.stringify({ keywords }),
  })
}

export function deleteKeywords(projectName: string, keywords: string[]): Promise<ApiKeyword[]> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/keywords`, {
    method: 'DELETE',
    body: JSON.stringify({ keywords }),
  })
}

export function appendKeywords(projectName: string, keywords: string[]): Promise<ApiKeyword[]> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/keywords`, {
    method: 'POST',
    body: JSON.stringify({ keywords }),
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
  const basePath = window.__CANONRY_CONFIG__?.basePath || ''
  const url = `${basePath.replace(/\/$/, '')}/health`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`)
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

export function generateKeywords(projectName: string, provider: string, count?: number): Promise<{ keywords: string[]; provider: string }> {
  return apiFetch(`/projects/${encodeURIComponent(projectName)}/keywords/generate`, {
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
  params?: { startDate?: string; endDate?: string; query?: string; page?: string; limit?: number },
): Promise<ApiGscPerformanceRow[]> {
  const qs = new URLSearchParams()
  if (params?.startDate) qs.set('startDate', params.startDate)
  if (params?.endDate) qs.set('endDate', params.endDate)
  if (params?.query) qs.set('query', params.query)
  if (params?.page) qs.set('page', params.page)
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/google/gsc/performance${query}`)
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

// Analytics
export function fetchAnalyticsMetrics(project: string, window?: MetricsWindow): Promise<BrandMetricsDto> {
  const qs = window ? `?window=${window}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/analytics/metrics${qs}`)
}

export function fetchAnalyticsGaps(project: string, window?: MetricsWindow): Promise<GapAnalysisDto> {
  const qs = window ? `?window=${window}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/analytics/gaps${qs}`)
}

export function fetchAnalyticsSources(project: string, window?: MetricsWindow): Promise<SourceBreakdownDto> {
  const qs = window ? `?window=${window}` : ''
  return apiFetch(`/projects/${encodeURIComponent(project)}/analytics/sources${qs}`)
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
  users: number
}

export interface ApiGaTrafficReferral {
  source: string
  medium: string
  sourceDimension: 'session' | 'first_user' | 'manual_utm'
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

export interface ApiGaTraffic {
  totalSessions: number
  totalOrganicSessions: number
  totalUsers: number
  topPages: ApiGaTrafficPage[]
  aiReferrals: ApiGaTrafficReferral[]
  /** Deduped AI session total (MAX per date+source+medium across attribution dimensions). */
  aiSessionsDeduped: number
  /** Deduped AI user total. */
  aiUsersDeduped: number
  socialReferrals: ApiGaSocialReferral[]
  /** Total social sessions (session-scoped via sessionDefaultChannelGroup). */
  socialSessions: number
  /** Total social users (session-scoped via sessionDefaultChannelGroup). */
  socialUsers: number
  /** Organic sessions as a percentage of total sessions (0–100, rounded). */
  organicSharePct: number
  /** Deduped AI sessions as a percentage of total sessions (0–100, rounded). */
  aiSharePct: number
  /** Social sessions as a percentage of total sessions (0–100, rounded). */
  socialSharePct: number
  lastSyncedAt: string | null
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

export function fetchGaTraffic(project: string, limit?: number): Promise<ApiGaTraffic> {
  const qs = limit ? `?limit=${limit}` : ''
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

export function fetchGaAiReferralHistory(project: string): Promise<GA4AiReferralHistoryEntry[]> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/ai-referral-history`)
}

export function fetchGaSocialReferralHistory(project: string): Promise<GA4SocialReferralHistoryEntry[]> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/social-referral-history`)
}

export function fetchGaSessionHistory(project: string): Promise<GA4SessionHistoryEntry[]> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/session-history`)
}

export function disconnectGa(project: string): Promise<void> {
  return apiFetch(`/projects/${encodeURIComponent(project)}/ga/disconnect`, {
    method: 'DELETE',
    body: '{}',
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

// ── Health ──────────────────────────────────────────────────────────────────

import type { ServiceStatus } from './view-models.js'

export async function fetchServiceStatus(url: string, label: string): Promise<ServiceStatus> {
  try {
    const response = await fetch(url)

    if (!response.ok) {
      return {
        label,
        state: 'error',
        detail: `HTTP ${response.status}`,
      }
    }

    const payload = (await response.json()) as Record<string, unknown>
    const version = typeof payload.version === 'string' ? payload.version : 'unknown'
    const databaseConfigured =
      typeof payload.databaseUrlConfigured === 'boolean' ? payload.databaseUrlConfigured : undefined
    const lastHeartbeatAt = typeof payload.lastHeartbeatAt === 'string' ? payload.lastHeartbeatAt : undefined
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
    }
  } catch (error) {
    return {
      label,
      state: 'error',
      detail: error instanceof Error ? error.message : 'unreachable',
    }
  }
}
