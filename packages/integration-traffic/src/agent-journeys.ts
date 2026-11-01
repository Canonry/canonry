import { AgentTrustLevels, classifyTrafficPath, hostOf, TrafficPathClasses, type AgentTrustReason, type NormalizedTrafficRequest, type StoredAgentTrust, type TrafficVerificationManifest, type VerificationStatus } from '@canonry/canonry-contracts'
import { withScannerBurst } from './agent-trust.js'
import { classifyAiUserFetch, isSelfTraffic } from './classifier.js'
import { maskJourneyPath } from './journey.js'
import { findScannerBurstsInBatch } from './scanner-bursts.js'

/** Raw identity is transient input to the capture layer's keyed correlation. */
export interface AgentJourneyRequest {
  sourceEventId: string
  ts: string
  remoteIp: string | null
  userAgent: string
  agentId: string
  operator: string
  product: string
  verificationStatus: VerificationStatus
  verificationManifest: TrafficVerificationManifest | null
  trust: StoredAgentTrust
  trustReasons: AgentTrustReason[]
  host: string | null
  path: string
  method: string | null
  status: number | null
  latencyMs: number | null
}

export interface ExtractAgentJourneyOptions {
  /** Requests from a probing client (`findScannerBursts`); found within the batch when omitted. */
  scannerBurstEventIds?: ReadonlySet<string>
}

/**
 * Observed fetches only: a request does not prove navigation, intent or
 * success. Likely fake requests are left out; their hourly totals count them.
 */
export function extractAgentJourneyRequests(events: readonly NormalizedTrafficRequest[], options: ExtractAgentJourneyOptions = {}): AgentJourneyRequest[] {
  const bursts = options.scannerBurstEventIds ?? findScannerBurstsInBatch(events)
  const requests: AgentJourneyRequest[] = []
  for (const event of events) {
    if (isSelfTraffic(event)) continue
    const classified = classifyAiUserFetch(event)
    const agent = classified && bursts.has(event.eventId) ? withScannerBurst(classified) : classified
    if (!agent || agent.trust === AgentTrustLevels.likely_fake) continue
    const timestamp = Date.parse(event.observedAt)
    if (!Number.isFinite(timestamp)) continue
    const path = event.path.split(/[?#]/)[0] || '/'
    // JSON may be the agent's direct API response, not a page subresource.
    if (classifyTrafficPath(path) === TrafficPathClasses.asset && !/\.json\/?$/i.test(path)) continue
    const maskedPath = maskJourneyPath(path)
    // Keep a redaction marker when truncating so a partial URL cannot be
    // attributed to a different, shorter Target's exact URL.
    const retainedPath = maskedPath.length > 512 ? `${maskedPath.slice(0, 505)}/:token` : maskedPath
    requests.push({
      sourceEventId: event.eventId,
      ts: new Date(timestamp).toISOString(),
      remoteIp: event.remoteIp?.trim() || null,
      userAgent: agent.matchedUserAgent,
      agentId: agent.botId,
      operator: agent.operator,
      product: agent.product,
      verificationStatus: agent.verificationStatus,
      verificationManifest: agent.verificationManifest,
      trust: agent.trust,
      trustReasons: agent.trustReasons,
      host: hostOf(event.host) ?? hostOf(event.requestUrl),
      path: retainedPath,
      method: event.method?.trim().toUpperCase() || null,
      status: event.status,
      latencyMs: event.latencyMs !== null && Number.isFinite(event.latencyMs) && event.latencyMs >= 0 ? event.latencyMs : null,
    })
  }
  return requests
}
