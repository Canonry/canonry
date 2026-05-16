import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@ainyc/canonry-contracts'
import type { CloudRunLogEntry } from './types.js'

function numberOrNull(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function latencyToMs(value: string | undefined): number | null {
  if (!value) return null
  const secondsMatch = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
  if (!secondsMatch) return null
  const seconds = Number(secondsMatch[1])
  return Number.isFinite(seconds) ? Math.round(seconds * 1_000_000) / 1000 : null
}

function normalizeLabels(labels: Record<string, string> | undefined): Record<string, string> {
  if (!labels) return {}
  return Object.fromEntries(
    Object.entries(labels)
      .filter((entry): entry is [string, string] => (
        typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )),
  )
}

function parseRequestUrl(requestUrl: string): { host: string | null; path: string; queryString: string | null } | null {
  try {
    const url = requestUrl.startsWith('/')
      ? new URL(requestUrl, 'https://canonry.local')
      : new URL(requestUrl)
    return {
      host: url.hostname === 'canonry.local' ? null : url.hostname,
      path: url.pathname || '/',
      queryString: url.search ? url.search.slice(1) : null,
    }
  } catch {
    return null
  }
}

function buildEventId(entry: CloudRunLogEntry, observedAt: string, requestUrl: string): string {
  if (entry.insertId?.trim()) {
    return `cloud-run:${observedAt}:${entry.insertId}`
  }
  return `cloud-run:${observedAt}:${requestUrl}`
}

export function normalizeCloudRunLogEntry(entry: CloudRunLogEntry): NormalizedTrafficRequest | null {
  const request = entry.httpRequest
  if (!request?.requestUrl) return null

  const observedAt = entry.timestamp ?? entry.receiveTimestamp
  if (!observedAt) return null

  const urlParts = parseRequestUrl(request.requestUrl)
  if (!urlParts) return null

  return {
    sourceType: TrafficSourceTypes['cloud-run'],
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: buildEventId(entry, observedAt, request.requestUrl),
    observedAt,
    method: request.requestMethod ?? null,
    requestUrl: request.requestUrl,
    host: urlParts.host,
    path: urlParts.path,
    queryString: urlParts.queryString,
    status: numberOrNull(request.status),
    userAgent: request.userAgent ?? null,
    remoteIp: request.remoteIp ?? null,
    referer: request.referer ?? null,
    latencyMs: latencyToMs(request.latency),
    requestSizeBytes: numberOrNull(request.requestSize),
    responseSizeBytes: numberOrNull(request.responseSize),
    providerResource: {
      type: entry.resource?.type ?? null,
      labels: normalizeLabels(entry.resource?.labels),
    },
    providerLabels: normalizeLabels(entry.labels),
  }
}
