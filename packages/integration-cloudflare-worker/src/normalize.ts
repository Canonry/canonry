import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type CloudflareWorkerEvent,
  type NormalizedTrafficRequest,
} from '@ainyc/canonry-contracts'

function emptyToNull(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  return value
}

function maybeLabel(value: string | number | boolean | null): string | undefined {
  if (value === null) return undefined
  if (typeof value === 'string' && value === '') return undefined
  return String(value)
}

function buildProviderLabels(cf: CloudflareWorkerEvent['cf']): Record<string, string> {
  if (!cf) return {}
  const candidates: Record<string, string | undefined> = {
    verifiedBot: maybeLabel(cf.verifiedBot),
    botScore: maybeLabel(cf.botScore),
    country: maybeLabel(cf.country),
    asn: maybeLabel(cf.asn),
    asOrganization: maybeLabel(cf.asOrganization),
  }
  return Object.fromEntries(
    Object.entries(candidates).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/**
 * Convert a Worker-forwarded event into the provider-neutral
 * `NormalizedTrafficRequest` consumed by `integration-traffic`.
 *
 * Returns `null` when the event is missing one of the three minimum fields
 * (`path`, `observedAt`, `eventId`) — the inbound Zod schema rejects these
 * upstream, but this defensive check lets the normalizer be safely reused
 * outside the HTTP path (e.g. against replayed log lines for tests).
 *
 * Cloudflare-specific signals like `verifiedBot`, `botScore`, `country`,
 * and `asn` ride through on `providerLabels` so the classifier can pick
 * them up — `integration-traffic/ip-verify` still has the authoritative
 * say on the `verified` vs `claimed_unverified` tier, but `verifiedBot`
 * is the most reliable signal Cloudflare exposes on the verified bot
 * side and downstream code may consume it directly.
 */
export function normalizeCloudflareWorkerEvent(
  event: CloudflareWorkerEvent,
): NormalizedTrafficRequest | null {
  if (!event.path) return null
  if (!event.observedAt) return null
  if (!event.eventId) return null

  const host = emptyToNull(event.host)
  const path = event.path
  const queryString = emptyToNull(event.queryString)
  const requestUrl = host
    ? `https://${host}${path}${queryString ? `?${queryString}` : ''}`
    : null

  return {
    sourceType: TrafficSourceTypes.cloudflare,
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: `cloudflare-worker:${event.eventId}`,
    observedAt: event.observedAt,
    method: emptyToNull(event.method),
    requestUrl,
    host,
    path,
    queryString,
    status: event.status,
    userAgent: emptyToNull(event.userAgent),
    remoteIp: emptyToNull(event.remoteIp),
    referer: emptyToNull(event.referer),
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: {
      type: 'cloudflare_zone',
      labels: {},
    },
    providerLabels: buildProviderLabels(event.cf),
  }
}
