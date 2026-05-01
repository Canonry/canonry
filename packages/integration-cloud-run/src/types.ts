import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'

export interface CloudRunLogFilterOptions {
  serviceName?: string
  location?: string
  startTime?: string | Date
  endTime?: string | Date
  userAgentSubstrings?: string[]
}

export interface CloudRunHttpRequest {
  requestMethod?: string
  requestUrl?: string
  requestSize?: string | number
  status?: number
  responseSize?: string | number
  userAgent?: string
  remoteIp?: string
  serverIp?: string
  referer?: string
  latency?: string
  protocol?: string
}

export interface CloudRunLogEntry {
  insertId?: string
  timestamp?: string
  receiveTimestamp?: string
  logName?: string
  resource?: {
    type?: string
    labels?: Record<string, string>
  }
  labels?: Record<string, string>
  httpRequest?: CloudRunHttpRequest
}

export interface ListCloudRunTrafficEventsOptions extends CloudRunLogFilterOptions {
  gcpProjectId: string
  pageSize?: number
  pageToken?: string
  orderBy?: 'timestamp asc' | 'timestamp desc'
  maxPages?: number
  timeoutMs?: number
}

export interface CloudRunTrafficEventsPage {
  events: NormalizedTrafficRequest[]
  rawEntryCount: number
  skippedEntryCount: number
  nextPageToken?: string
  filter: string
}

export interface CloudRunListLogEntriesResponse {
  entries?: CloudRunLogEntry[]
  nextPageToken?: string
}
