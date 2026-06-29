import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@ainyc/canonry-contracts'
import type { WordpressTrafficEventPayload } from './types.js'

function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildEventId(event: WordpressTrafficEventPayload): string {
  return `wordpress:${event.observed_at}:${event.id}`
}

export function normalizeWordpressTrafficEvent(
  event: WordpressTrafficEventPayload,
  site?: { anonymous_id?: string },
): NormalizedTrafficRequest | null {
  if (!event.observed_at) return null
  if (typeof event.id !== 'number' || !Number.isFinite(event.id)) return null

  const path = event.path.trim()
  if (!path) return null
  const queryString = trimOrNull(event.query_string)
  const host = trimOrNull(event.host)
  const requestUrl = host
    ? `https://${host}${path}${queryString ? `?${queryString}` : ''}`
    : `${path}${queryString ? `?${queryString}` : ''}`

  const labels: Record<string, string> = {}
  if (host) labels.host = host
  if (site?.anonymous_id) labels.anonymousId = site.anonymous_id

  return {
    sourceType: TrafficSourceTypes.wordpress,
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: buildEventId(event),
    observedAt: event.observed_at,
    method: trimOrNull(event.method),
    requestUrl,
    host,
    path,
    queryString,
    status: typeof event.status === 'number' && Number.isFinite(event.status) ? event.status : null,
    userAgent: trimOrNull(event.user_agent),
    remoteIp: trimOrNull(event.remote_ip),
    referer: trimOrNull(event.referer),
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: {
      type: 'wordpress_site',
      labels,
    },
    providerLabels: {},
  }
}
