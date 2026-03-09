import type { GroundingSource } from '@ainyc/aeo-platform-contracts'

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
  country: string
  language: string
  tags: string[]
  labels: Record<string, string>
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
  country: string
  language: string
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

export function triggerRun(name: string): Promise<ApiRun> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/runs`, { method: 'POST', body: '{}' })
}

export async function deleteProject(name: string): Promise<void> {
  await apiFetch(`/projects/${encodeURIComponent(name)}`, { method: 'DELETE', body: '{}' })
}

export function fetchExport(name: string): Promise<unknown> {
  return apiFetch(`/projects/${encodeURIComponent(name)}/export`)
}

export interface ApiSettings {
  provider: {
    name: string
    model: string
  }
  quota: {
    maxConcurrency: number
    maxRequestsPerMinute: number
    maxRequestsPerDay: number
  }
}

export function fetchSettings(): Promise<ApiSettings> {
  return apiFetch('/settings')
}

export async function fetchHealthCheck(): Promise<{ status: string }> {
  const res = await fetch('/health')
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`)
  return res.json() as Promise<{ status: string }>
}
