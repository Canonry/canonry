import {
  AgentTrustLevels,
  AgentTrustReasons,
  type AgentTrust,
  type AgentTrustReason,
  type TrafficVerificationManifest,
} from '@canonry/canonry-contracts'
import type { AiCrawlerRule } from './types.js'

/**
 * Bump when the scanner checks below change, so stored agent traffic is
 * assessed again under the new rules (`traffic-reclassify.ts`).
 */
export const AGENT_TRUST_RULES_VERSION = 2

/**
 * Path segments a user-triggered fetch has no reason to request. `cgi-bin` is
 * left out on purpose: older sites still serve real pages from it.
 */
const SCANNER_SEGMENTS = new Set([
  'wp-login.php', 'xmlrpc.php', 'phpmyadmin', 'phpunit', 'eval-stdin.php', 'phpinfo.php',
  // Debug consoles of web frameworks, and the Vite dev server's file access.
  '_profiler', '_debugbar', '_ignition', '__debug__', 'elmah.axd', 'trace.axd', '@fs',
])
// Encoded parent-directory steps. Checked on the raw path because a failed
// decode must not hide them.
const ENCODED_TRAVERSAL = /(?:%2e%2e|%2e\.|\.%2e)(?:\/|\\|%2f|%5c|$)|\.\.(?:%2f|%5c)|%252e%252e/i
// Netlify serves functions and images from its hidden folder.
const NETLIFY_PUBLIC = new Set(['functions', 'edge-functions', 'images'])
// Files that hold keys, credentials or server settings. They count only at
// the site root or inside folders like these, so a product page whose name
// mentions a secret is not one.
const CONFIG_FOLDERS = new Set(['config', 'configs', 'conf', 'keys', 'secrets', 'credentials', 'private', 'certs', 'ssl', 'backup', 'backups'])
const SECRET_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'kdbx', 'ovpn', 'tfstate', 'tfvars', 'sql', 'bak', 'swp'])
const CREDENTIAL_FILE = /(?:^|[-_.])(?:credentials?|secrets?|service[-_]?account(?:[-_]?key)?|private[-_]?key|access[-_]?keys?|adminsdk(?:[-_][\w-]+)?)\.(?:json|ya?ml|toml|ini|conf|cfg|xml|txt|js|env|properties)$/
const SSH_KEY_FILE = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/
const SECRET_FILES = new Set([
  'key.json', 'keyfile.json', 'sa.json', 'gcp-key.json', 'gcp-service.json', 'gc-service.json', 'firebase-admin.json',
  'docker-compose.yml', 'docker-compose.yaml', 'serverless.yml', 'serverless.yaml', 'rclone.conf',
  'appsettings.json', 'local.settings.json', 'application.properties', 'application.yml', 'application.yaml',
  'values.yaml', 'web.config', 'configuration.php', 'settings.py', 'database.yml', 'parameters.yml', 'env.json', 'env.js',
])
// The Node `config` package layout, such as `config/production.json`.
const ENVIRONMENT_CONFIG = /^(?:production|prod|development|dev|staging|default|local|test)\.(?:json|ya?ml|js|toml)$/

/** Reasons in display order. The first reason of a likely fake request keys its hourly bucket. */
const REASON_ORDER: readonly AgentTrustReason[] = [
  AgentTrustReasons['scanner-path'],
  AgentTrustReasons['scanner-burst'],
  AgentTrustReasons['unusual-user-agent'],
  AgentTrustReasons['ip-in-published-list'],
  AgentTrustReasons['ip-outside-published-list'],
  AgentTrustReasons['no-ip'],
  AgentTrustReasons['no-published-list'],
  AgentTrustReasons['documented-user-agent'],
]
// An IP missing from a published list is never on its own evidence of a fake:
// some operators publish rotating snapshots of single addresses, and every
// vendored list lags the operator's real egress.
const FAKE_REASONS: ReadonlySet<AgentTrustReason> = new Set([
  AgentTrustReasons['scanner-path'],
  AgentTrustReasons['scanner-burst'],
  AgentTrustReasons['unusual-user-agent'],
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
  /** `manifest` is set only when a published list was consulted for this request. */
  verification: { verified: boolean; manifest: TrafficVerificationManifest | null }
  /** Whether the operator publishes an IP list for this agent at all. */
  listPublished: boolean
}

function isHiddenSegment(segment: string, next: string | undefined): boolean {
  if (!segment.startsWith('.') || segment === '.' || segment === '.well-known') return false
  return !(segment === '.netlify' && next !== undefined && NETLIFY_PUBLIC.has(next))
}

function isSecretFile(folders: readonly string[], file: string): boolean {
  if (!folders.every(folder => CONFIG_FOLDERS.has(folder))) return false
  if (folders.length > 0 && ENVIRONMENT_CONFIG.test(file)) return true
  const dot = file.lastIndexOf('.')
  const extension = dot > 0 ? file.slice(dot + 1) : ''
  return SECRET_EXTENSIONS.has(extension) || SECRET_FILES.has(file) || SSH_KEY_FILE.test(file)
    || CREDENTIAL_FILE.test(file) || /^appsettings\.[\w-]+\.json$/.test(file)
}

/**
 * True when the path asks for secrets, keys, server settings, version-control
 * data, hidden files, debug consoles or admin logins, or steps out of the web
 * root. Real user-triggered fetches follow links a person asked about;
 * scanners wearing an agent user agent request these.
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
  const segments = decoded.split(/[\\/]+/).filter(Boolean)
  for (const [index, segment] of segments.entries()) {
    if (segment === '..' || segment.endsWith('..')) return true
    if (SCANNER_SEGMENTS.has(segment) || segment.startsWith('wp-config') || segment.endsWith('.env')) return true
    if (isHiddenSegment(segment, segments[index + 1])) return true
    // Process environment and mounted cluster secrets.
    if (segment === 'proc' && segments[index + 1] === 'self') return true
    if (segment === 'var' && segments[index + 1] === 'run' && segments[index + 2] === 'secrets') return true
  }
  const file = segments.at(-1)
  if (file === undefined) return false
  // The upload folder of old rich-text editors, asked for as a folder.
  if (segments[0] === 'userfiles' && !file.includes('.')) return true
  return isSecretFile(segments.slice(0, -1), file)
}

export function sortAgentTrustReasons(reasons: Iterable<AgentTrustReason>): AgentTrustReason[] {
  const present = new Set(reasons)
  return REASON_ORDER.filter(reason => present.has(reason))
}

/**
 * The verdict for a request whose client asked for scanner paths in the same
 * burst (`findScannerBursts`). A verified request keeps its verdict: the IP
 * belongs to the operator, so a probe through it came from one of its users.
 * A request already judged likely fake keeps its own reasons.
 */
export function withScannerBurst<T extends AgentTrustAssessment>(assessment: T): T {
  if (assessment.trust === AgentTrustLevels.verified || assessment.trust === AgentTrustLevels.likely_fake) return assessment
  return {
    ...assessment,
    trust: AgentTrustLevels.likely_fake,
    trustReasons: sortAgentTrustReasons([...assessment.trustReasons, AgentTrustReasons['scanner-burst']]),
  }
}

function ipReason(input: AgentTrustInput): AgentTrustReason {
  if (input.verification.verified) return AgentTrustReasons['ip-in-published-list']
  // A manifest is returned only when a list was actually consulted.
  if (input.verification.manifest) return AgentTrustReasons['ip-outside-published-list']
  return input.listPublished ? AgentTrustReasons['no-ip'] : AgentTrustReasons['no-published-list']
}

/**
 * Per-request trust, independent of how requests were batched, so every
 * source and transport reaches the same verdict for the same request. An IP
 * in the published list wins. Otherwise any fake signal makes the request
 * likely fake. A request that could not be checked
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
