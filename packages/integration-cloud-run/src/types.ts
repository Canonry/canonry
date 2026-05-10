import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'

export interface CloudRunLogFilterOptions {
  serviceName?: string
  location?: string
  startTime?: string | Date
  endTime?: string | Date
  userAgentSubstrings?: string[]
  requestUrlSubstrings?: string[]
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
  /**
   * When true, this is a first-time backfill (no prior sync cursor). The
   * client picks `orderBy=timestamp desc` so the bounded `maxPages * pageSize`
   * budget covers the most recent entries inside a long lookback window
   * instead of exhausting on the oldest ones. Ignored if `orderBy` is set
   * explicitly.
   */
  firstSync?: boolean
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
