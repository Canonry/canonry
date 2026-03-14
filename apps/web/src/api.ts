import type { GroundingSource, ScheduleDto, NotificationDto } from '@ainyc/canonry-contracts'

export type { GroundingSource }

const API_BASE = '/api/v1'

declare global {
  interface Window {
    __CANONRY_CONFIG__?: { apiKey?: string }
  }
}

function getApiKey(): string {
  if (typeof window !== 'undefined' && window.__CANONRY_CONFIG__?.apiKey) {
    return window.__CANONRY_CONFIG__.apiKey
  }
  return import.meta.env.VITE_API_KEY ?? ''
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const key = getApiKey()
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${res.statusText}`)
  }
  if (res.status === 204) {
    return undefined as T
  }
  return res.json() as Promise<T>
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
  configSource: string
  configRevision: number
  createdAt: string
  updatedAt: string
}

export interface ApiRun {
  id: string
  projectId: string
  kind: string
  status: string
  trigger: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  createdAt: string
}

export interface ApiSnapshot {
  id: string
  runId: string
  keywordId: string
  keyword: string | null
  provider: string
  citationState: string
  answerText: string | null
  citedDomains: string[]
  competitorOverlap: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  model: string | null
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
  }[]
  providerRuns?: Record<string, {
    runId: string
    createdAt: string
    citationState: string
    transition: string
  }[]>
  modelRuns?: Record<string, {
    runId: string
    createdAt: string
    citationState: string
    transition: string
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

export function fetchTimeline(name: string): Promise<ApiTimelineEntry[]> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/timeline`)
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
  })
}

export async function updateProject(projectName: string, updates: {
  displayName?: string
  canonicalDomain?: string
  ownedDomains?: string[]
  country?: string
  language?: string
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
  })
}

export function triggerRun(name: string): Promise<ApiRun> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/runs`, { method: 'POST', body: '{}' })
}

export async function deleteProject(name: string): Promise<void> {
  await apiFetch(`/projects/${encodeURIComponent(name)}`, { method: 'DELETE', body: '{}' })
}

export function fetchExport(name: string): Promise<unknown> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/export`)
}

export interface ApiProviderSummary {
  name: string
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
}

export function fetchSettings(): Promise<ApiSettings> {
  return apiFetch('/settings')
}

export async function fetchHealthCheck(): Promise<{ status: string }> {
  const res = await fetch('/health')
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

export type ApiSchedule = ScheduleDto

export async function fetchSchedule(project: string): Promise<ApiSchedule | null> {
  try {
    return await apiFetch<ApiSchedule>(`/projects/${encodeURIComponent(project)}/schedule`)
  } catch (e) {
    if (e instanceof Error && e.message.includes('404')) return null
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

export function triggerAllRuns(body?: { providers?: string[] }): Promise<unknown[]> {
  return apiFetch('/runs', {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

export interface ApiGoogleConnection {
  id: string
  domain: string
  connectionType: string
  propertyId: string | null
  scopes: string[]
  createdAt: string
  updatedAt: string
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
