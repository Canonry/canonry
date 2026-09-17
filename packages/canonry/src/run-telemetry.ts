import crypto from 'node:crypto'

/**
 * Extract the registrable host part of a domain string for non-PII telemetry
 * aggregation. Returns the lowercased hostname with leading `www.` stripped,
 * the protocol/port removed, and any path discarded. Returns `null` when the
 * input cannot be parsed into a host (empty/whitespace/garbage).
 *
 * This is intentionally a heuristic, not a strict eTLD+1 split — that would
 * require the Public Suffix List. For ICP analysis (`how many users audit
 * shopify.com vs wordpress.com`) the hostname is sufficient because most
 * customers configure a registrable domain rather than `*.myshopify.com`
 * style subdomains.
 */
export function extractRegistrableHost(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  let host: string
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    host = new URL(candidate).hostname
  } catch {
    return null
  }

  host = host.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  if (!host || !host.includes('.')) return null
  return host
}

/**
 * SHA-256 hash a domain string for telemetry. Returns `null` if the input
 * cannot be parsed into a usable host, so callers can drop the field rather
 * than emit garbage. The host is normalized via `extractRegistrableHost`
 * first so `Example.com`, `https://www.example.com/foo`, and `example.com`
 * all hash to the same value.
 *
 * Lives in the canonry package (not `@ainyc/canonry-contracts`) because
 * `node:crypto` is Node-only — pulling it into shared contracts would force
 * Vite to externalize it for the browser build.
 */
export function hashDomain(input: string | null | undefined): string | null {
  const host = extractRegistrableHost(input)
  if (!host) return null
  return crypto.createHash('sha256').update(host).digest('hex')
}

export interface RunPhaseTimings {
  /** From entry to the first provider call dispatch — DB lookups, quota
   *  checks, gate setup. */
  setup_ms: number
  /** Wall-clock for the `runWithConcurrency` block + browser provider loop.
   *  Includes per-snapshot DB inserts since they happen inside the worker. */
  provider_call_ms: number
  /** End-to-end from entry to telemetry emission. Mirrors the legacy
   *  `durationMs` field. */
  total_ms: number
}

export interface RunTelemetryProps {
  // Index signature lets `RunTelemetryProps` satisfy the `TelemetryProperties`
  // (`Record<string, unknown>`) contract on `trackEvent` without losing the
  // typed fields below for every other consumer.
  [key: string]: unknown
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  providerCount: number
  providers: string[]
  queryCount: number
  durationMs: number
  trigger?: string
  domainHash?: string
  phases?: RunPhaseTimings
  location?: string
}

export function buildRunCompletedProps(input: {
  status: RunTelemetryProps['status']
  providerCount: number
  providers: readonly string[]
  queryCount: number
  startTime: number
  trigger?: string | null
  canonicalDomain?: string | null
  phases?: RunPhaseTimings
  location?: string
}): RunTelemetryProps {
  const totalMs = input.phases?.total_ms ?? Date.now() - input.startTime
  const props: RunTelemetryProps = {
    status: input.status,
    providerCount: input.providerCount,
    providers: [...input.providers],
    queryCount: input.queryCount,
    durationMs: totalMs,
  }
  if (input.trigger) props.trigger = input.trigger
  const domainHash = hashDomain(input.canonicalDomain ?? null)
  if (domainHash) props.domainHash = domainHash
  if (input.phases) props.phases = input.phases
  if (input.location) props.location = input.location
  return props
}

export type SiteAuditTelemetryStatus = 'completed' | 'partial' | 'failed' | 'cancelled'

/** What a published crawl can report. Absent when the audit failed or was
 *  cancelled before a crawl summary existed. */
export interface SiteAuditCrawlOutcome {
  complete: boolean
  termination?: string | null
  pagesDiscovered: number
  pagesFetched: number
  pagesAudited: number
  pagesErrored: number
  aggregateScore?: number | null
  pageBudget: number
  checkDeadLinks: boolean
  deadLinksFound: number
}

export interface SiteAuditCompletedProps {
  [key: string]: unknown
  status: SiteAuditTelemetryStatus
  durationMs: number
  trigger?: string
  domainHash?: string
  complete?: boolean
  termination?: string
  pagesDiscovered?: number
  pagesFetched?: number
  pagesAudited?: number
  pagesErrored?: number
  aggregateScore?: number
  pageBudget?: number
  checkDeadLinks?: boolean
  deadLinksFound?: number
}

/**
 * Compose the `site_audit.completed` payload.
 *
 * Optional fields are omitted, never nulled: the collector's property schema
 * has no null, so a single null value rejects the whole event. The score is
 * sent only when at least one page was audited, because a crawl that audited
 * nothing has no score, and a zero would read as a measured failing site.
 */
export function buildSiteAuditCompletedProps(input: {
  status: SiteAuditTelemetryStatus
  startTime: number
  trigger?: string | null
  canonicalDomain?: string | null
  crawl?: SiteAuditCrawlOutcome
}): SiteAuditCompletedProps {
  const props: SiteAuditCompletedProps = {
    status: input.status,
    durationMs: Date.now() - input.startTime,
  }
  if (input.trigger) props.trigger = input.trigger
  const domainHash = hashDomain(input.canonicalDomain ?? null)
  if (domainHash) props.domainHash = domainHash
  const crawl = input.crawl
  if (!crawl) return props

  props.complete = crawl.complete
  if (crawl.termination) props.termination = crawl.termination
  props.pagesDiscovered = crawl.pagesDiscovered
  props.pagesFetched = crawl.pagesFetched
  props.pagesAudited = crawl.pagesAudited
  props.pagesErrored = crawl.pagesErrored
  if (crawl.pagesAudited > 0 && typeof crawl.aggregateScore === 'number' && Number.isFinite(crawl.aggregateScore)) {
    props.aggregateScore = crawl.aggregateScore
  }
  props.pageBudget = crawl.pageBudget
  props.checkDeadLinks = crawl.checkDeadLinks
  if (crawl.checkDeadLinks) props.deadLinksFound = crawl.deadLinksFound
  return props
}
