import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@ainyc/canonry-contracts'
import type { VercelRequestLogRow } from './types.js'

function numberOrNull(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * Resolve the response status. Vercel's top-level `statusCode` is sometimes
 * `0` (populated lazily / propagation lag), so fall back to the last real HTTP
 * status in the merged `events[]` timeline — that reflects what the client
 * actually received (proxy/static layer last, after middleware).
 */
function resolveStatus(row: VercelRequestLogRow): number | null {
  if (typeof row.statusCode === 'number' && row.statusCode >= 100) {
    return row.statusCode
  }
  const events = row.events ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const status = events[i]?.httpStatus
    if (typeof status === 'number' && status >= 100) return status
  }
  return null
}

function serializeSearchParams(params: Record<string, string> | undefined): string | null {
  if (!params) return null
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )
  if (entries.length === 0) return null
  return new URLSearchParams(entries).toString()
}

function emptyToNull(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value
}

function stringLabels(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    ),
  )
}

/**
 * Convert a raw `request-logs` row into a provider-neutral
 * `NormalizedTrafficRequest`. Returns `null` for rows that lack the minimum
 * evidence (path, timestamp, request id) needed downstream.
 */
export function normalizeVercelLogRow(row: VercelRequestLogRow): NormalizedTrafficRequest | null {
  const path = row.requestPath
  if (!path) return null
  const observedAt = row.timestamp
  if (!observedAt) return null
  const requestId = row.requestId
  if (!requestId) return null

  const host = emptyToNull(row.domain)
  const queryString = serializeSearchParams(row.requestSearchParams)
  const requestUrl = host
    ? `https://${host}${path}${queryString ? `?${queryString}` : ''}`
    : null

  return {
    sourceType: TrafficSourceTypes.vercel,
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: `vercel:${observedAt}:${requestId}`,
    observedAt,
    method: row.requestMethod ?? null,
    requestUrl,
    host,
    path,
    queryString,
    status: resolveStatus(row),
    userAgent: emptyToNull(row.clientUserAgent),
    // The request-logs endpoint does not expose a client IP; UA-only matches
    // stay `claimed_unverified` in the classifier.
    remoteIp: null,
    referer: emptyToNull(row.requestReferer),
    latencyMs: numberOrNull(row.requestDurationMs),
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: {
      type: 'vercel_deployment',
      labels: stringLabels({
        deploymentId: row.deploymentId,
        environment: row.environment,
        region: row.clientRegion,
      }),
    },
    providerLabels: stringLabels({
      branch: row.branch,
      cache: row.cache,
    }),
  }
}
