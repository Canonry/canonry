import {
  AgentTrustLevels,
  AgentTrustReasons,
  type AgentTrust,
  type AgentTrustReason,
  type TrafficVerificationManifest,
} from '@canonry/canonry-contracts'
import type { AiCrawlerRule } from './types.js'

/**
 * A miss counts as evidence of a fake only against a list published within
 * this many days of the request, either side. An older list may lack new
 * operator addresses; a much newer one may have dropped addresses the operator
 * used then. Measured from the publisher's own creation time in the manifest.
 */
export const AGENT_IP_LIST_FRESH_DAYS = 30
const FRESH_LIST_MS = AGENT_IP_LIST_FRESH_DAYS * 86_400_000

/** Path segments a user-triggered fetch has no reason to request. */
const SCANNER_SEGMENTS = new Set([
  '.git', '.svn', '.hg', '.github', '.aws', '.ssh', '.docker', '.kube', '.npmrc',
  '.htpasswd', '.htaccess', '.ds_store', 'wp-login.php', 'xmlrpc.php', 'phpmyadmin',
  'cgi-bin', 'phpunit', 'eval-stdin.php',
])
// Encoded parent-directory steps. Checked on the raw path because a failed
// decode must not hide them.
const ENCODED_TRAVERSAL = /(?:%2e%2e|%2e\.|\.%2e)(?:\/|\\|%2f|%5c|$)|\.\.(?:%2f|%5c)|%252e%252e/i

/** Reasons in display order. The first reason of a likely fake request keys its hourly bucket. */
const REASON_ORDER: readonly AgentTrustReason[] = [
  AgentTrustReasons['scanner-path'],
  AgentTrustReasons['same-client-scanned'],
  AgentTrustReasons['unusual-user-agent'],
  AgentTrustReasons['ip-outside-published-list'],
  AgentTrustReasons['ip-in-published-list'],
  AgentTrustReasons['ip-outside-old-list'],
  AgentTrustReasons['no-ip'],
  AgentTrustReasons['no-published-list'],
  AgentTrustReasons['documented-user-agent'],
]
const FAKE_REASONS: ReadonlySet<AgentTrustReason> = new Set([
  AgentTrustReasons['scanner-path'],
  AgentTrustReasons['same-client-scanned'],
  AgentTrustReasons['unusual-user-agent'],
  AgentTrustReasons['ip-outside-published-list'],
])

export interface AgentTrustAssessment {
  trust: AgentTrust
  trustReasons: AgentTrustReason[]
}

export interface AgentTrustInput {
  rule: Pick<AiCrawlerRule, 'documentedUserAgents'>
  userAgent: string
  /** Raw request path; the query string is ignored. */
  path: string
  observedAt: string
  /** `manifest` is set only when a published list was consulted for this request. */
  verification: { verified: boolean; manifest: TrafficVerificationManifest | null }
  /** Whether the operator publishes an IP list for this agent at all. */
  listPublished: boolean
}

/**
 * True when the path asks for secrets, version-control data or admin logins,
 * or steps out of the web root. Real user-triggered fetches follow links a
 * person asked about; scanners wearing an agent user agent request these.
 */
export function isScannerPath(rawPath: string): boolean {
  const pathOnly = (rawPath.split(/[?#]/)[0] ?? '').toLowerCase()
  if (ENCODED_TRAVERSAL.test(pathOnly)) return true
  let decoded = pathOnly
  try {
    decoded = decodeURIComponent(pathOnly)
  } catch {
    // Keep the raw form; the encoded check above already ran on it.
  }
  for (const segment of decoded.split(/[\\/]+/)) {
    if (!segment) continue
    if (segment === '..' || segment.endsWith('..')) return true
    if (SCANNER_SEGMENTS.has(segment) || segment.startsWith('wp-config')) return true
    if (segment === '.env' || segment.startsWith('.env.') || segment.endsWith('.env')) return true
  }
  return false
}

export function sortAgentTrustReasons(reasons: Iterable<AgentTrustReason>): AgentTrustReason[] {
  const present = new Set(reasons)
  return REASON_ORDER.filter(reason => present.has(reason))
}

function ipReason(input: AgentTrustInput): AgentTrustReason {
  if (input.verification.verified) return AgentTrustReasons['ip-in-published-list']
  const manifest = input.verification.manifest
  if (manifest) {
    const distance = Math.abs(Date.parse(input.observedAt) - Date.parse(manifest.version))
    // An unparseable time cannot prove freshness, so its miss stays weak.
    return Number.isFinite(distance) && distance <= FRESH_LIST_MS
      ? AgentTrustReasons['ip-outside-published-list']
      : AgentTrustReasons['ip-outside-old-list']
  }
  return input.listPublished ? AgentTrustReasons['no-ip'] : AgentTrustReasons['no-published-list']
}

/**
 * Per-request trust. An IP in the published list wins. Otherwise any fake
 * signal makes the request likely fake. A request that could not be checked
 * but carries the operator's exact published user agent is likely real.
 * Everything else is unknown.
 */
export function assessAgentTrust(input: AgentTrustInput): AgentTrustAssessment {
  const reasons = new Set<AgentTrustReason>([ipReason(input)])
  const documented = input.rule.documentedUserAgents
  if (documented && documented.length > 0) {
    reasons.add(documented.some(pattern => pattern.test(input.userAgent.trim()))
      ? AgentTrustReasons['documented-user-agent']
      : AgentTrustReasons['unusual-user-agent'])
  }
  if (isScannerPath(input.path)) reasons.add(AgentTrustReasons['scanner-path'])
  return { trust: trustFor(reasons), trustReasons: sortAgentTrustReasons(reasons) }
}

function trustFor(reasons: ReadonlySet<AgentTrustReason>): AgentTrust {
  if (reasons.has(AgentTrustReasons['ip-in-published-list'])) return AgentTrustLevels.verified
  for (const reason of reasons) if (FAKE_REASONS.has(reason)) return AgentTrustLevels.likely_fake
  const unchecked = reasons.has(AgentTrustReasons['no-ip']) || reasons.has(AgentTrustReasons['no-published-list'])
  return unchecked && reasons.has(AgentTrustReasons['documented-user-agent']) ? AgentTrustLevels.likely_real : AgentTrustLevels.unknown
}

/** Mark a request likely fake because its client probed for secrets in the same batch. */
export function withSameClientScanned(assessment: AgentTrustAssessment): AgentTrustAssessment {
  if (assessment.trust === AgentTrustLevels.verified || assessment.trust === AgentTrustLevels.likely_fake) return assessment
  return {
    trust: AgentTrustLevels.likely_fake,
    trustReasons: sortAgentTrustReasons([...assessment.trustReasons, AgentTrustReasons['same-client-scanned']]),
  }
}
