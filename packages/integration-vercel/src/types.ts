import type { NormalizedTrafficRequest, VercelTrafficEnvironment } from '@ainyc/canonry-contracts'

/**
 * One entry in a request-log row's compute timeline (`events` / `proxyEvents`
 * / `functionEvents`). Only the fields the normalizer reads are typed; Vercel
 * returns many more.
 */
export interface VercelRequestLogEvent {
  source?: string
  httpStatus?: number
  region?: string
}

/**
 * A single row from `GET https://vercel.com/api/logs/request-logs`. This is
 * the internal endpoint the `vercel` CLI rides; only the fields Canonry
 * normalizes are typed here.
 */
export interface VercelRequestLogRow {
  requestId?: string
  timestamp?: string
  deploymentId?: string
  environment?: string
  branch?: string
  domain?: string
  requestMethod?: string
  requestPath?: string
  /** Sometimes `0` — populated lazily by Vercel. Fall back to `events[]`. */
  statusCode?: number
  route?: string
  cache?: string
  clientUserAgent?: string
  requestReferer?: string
  requestSearchParams?: Record<string, string>
  requestDurationMs?: number
  clientRegion?: string
  events?: VercelRequestLogEvent[]
  proxyEvents?: VercelRequestLogEvent[]
  functionEvents?: VercelRequestLogEvent[]
}

export interface VercelRequestLogsResponseBody {
  rows?: VercelRequestLogRow[]
  hasMoreRows?: boolean
}

export interface ListVercelTrafficEventsOptions {
  /** Vercel personal access token. Supplied per call, never stored in this package. */
  token: string
  /** Vercel project id (`prj_...`). */
  projectId: string
  /** Vercel team or account id: the org that owns the project. */
  teamId: string
  /** Deployment environment to pull. Defaults to `production`. */
  environment?: VercelTrafficEnvironment
  /** Inclusive lower bound — epoch ms, ISO string, or Date. */
  startDate: number | string | Date
  /** Exclusive upper bound — epoch ms, ISO string, or Date. */
  endDate: number | string | Date
  /** Max pages to walk (the endpoint paginates by `page`). Defaults to 1. */
  maxPages?: number
  timeoutMs?: number
}

export interface VercelTrafficEventsPage {
  events: NormalizedTrafficRequest[]
  rawEntryCount: number
  skippedEntryCount: number
  /** True when the endpoint reported more rows than the page budget pulled. */
  hasMore: boolean
  endpoint: string
}
