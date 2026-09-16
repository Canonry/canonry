import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { describeError } from '@ainyc/canonry-contracts'
import { resolveMeasurementSitemapTarget, type MeasurementSitemapAddress } from './measurement-sitemap-fetch.js'
import type { SafeWebhookTarget } from './webhooks.js'

/**
 * Does the project's website answer at all?
 *
 * Every hop is resolved and checked against the private, reserved and
 * link-local ranges before dialing, and the socket dials the address that was
 * checked, so a project domain can never be used to reach this host's network.
 *
 * The hard part is not detecting an outage, it is refusing to claim one. Three
 * outcomes are deliberately NOT "down":
 *  - `unavailable`: OUR resolver or network failed. A host DNS outage would
 *    otherwise report every project on the instance as down at once.
 *  - a certificate chain or response header Node rejects and a browser accepts:
 *    the second attempt relaxes both, and a site that answers is up, with the
 *    problem recorded in `details`.
 *  - one dead address out of several: every approved address is tried, the way
 *    a browser fails over.
 * `unreachable` is its own outcome: the name resolves only to addresses the
 * egress policy refuses (a sinkholed or suspended domain). Visitors cannot
 * reach it either, so it is reported as a real failure, and still never dialed.
 */

export const SITE_REACHABILITY_USER_AGENT = 'Canonry site-liveness (+https://canonry.ai)'
/** Browsers follow about 20. Three graded a working multi-hop homepage as down. */
export const DEFAULT_SITE_MAX_REDIRECTS = 10
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_DELAY_MS = 2_000
const DNS_TIMEOUT_MS = 5_000
/** Addresses dialed per hop before giving up, so a large round-robin set stays bounded. */
const MAX_ADDRESSES_PER_HOP = 4
/** Node rejects these where a browser does not, so they earn a lenient second try, never a page on their own. */
const LENIENT_RETRY_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'HPE_INVALID_HEADER_TOKEN', 'HPE_UNEXPECTED_CONTENT_LENGTH', 'HPE_INVALID_CONSTANT',
])
/** Only these mean the name has no address. Everything else is our resolver failing. */
const NO_SUCH_HOST_CODES = new Set(['ENOTFOUND', 'ENODATA'])

export interface SiteStatusResponse {
  status: number
  location: string | null
  /** Set when the answer only came back after relaxing certificate or parser strictness. */
  lenient?: string
}

/** The transport seam, so tests exercise redirects and failures without a socket. */
export type SiteStatusTransport = (target: SafeWebhookTarget, timeoutMs: number, options?: { lenient?: boolean }) => Promise<SiteStatusResponse>

export type SiteAddressLookup =
  | { kind: 'addresses'; addresses: readonly MeasurementSitemapAddress[] }
  | { kind: 'no-such-host'; reason: string }
  | { kind: 'resolver-error'; reason: string }

/** The DNS seam. Injected in tests so every classification is reachable without owning a domain. */
export type SiteAddressResolver = (hostname: string) => Promise<SiteAddressLookup>

export interface SiteReachabilityOptions {
  timeoutMs?: number
  maxRedirects?: number
  retryDelayMs?: number
  transport?: SiteStatusTransport
  resolveAddresses?: SiteAddressResolver
  sleep?: (ms: number) => Promise<void>
}

export type SiteReachabilityResult =
  | { state: 'up'; url: string; finalUrl: string; httpStatus: number; attempts: number; durationMs: number; lenient?: string }
  | { state: 'down'; url: string; finalUrl: string; httpStatus: number | null; reason: string; attempts: number; durationMs: number }
  | { state: 'unreachable'; url: string; finalUrl: string; reason: string; attempts: number; durationMs: number }
  | { state: 'unavailable'; url: string; reason: string }

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

type Attempt =
  | { kind: 'up'; finalUrl: string; httpStatus: number; lenient?: string }
  | { kind: 'down'; finalUrl: string; httpStatus: number | null; reason: string }
  | { kind: 'unreachable'; finalUrl: string; reason: string }
  | { kind: 'unavailable'; reason: string }

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

/**
 * Resolve a hostname, separating "this name has no address" from "our resolver
 * did not answer". `dns.resolve4`/`resolve6` rather than `dns.lookup`, matching
 * the sitemap fetcher: the socket must dial the address that was checked.
 */
export async function lookupSiteAddresses(hostname: string, timeoutMs = DNS_TIMEOUT_MS): Promise<SiteAddressLookup> {
  const literalFamily = net.isIPv6(hostname) ? 6 : net.isIPv4(hostname) ? 4 : null
  if (literalFamily) return { kind: 'addresses', addresses: [{ address: hostname, family: literalFamily }] }

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
  try {
    const settled = await Promise.race([
      Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]),
      deadline,
    ])
    if (settled === 'timeout') return { kind: 'resolver-error', reason: `DNS did not answer within ${Math.round(timeoutMs / 1000)}s` }
    const [ipv4, ipv6] = settled
    const found = new Map<string, MeasurementSitemapAddress>()
    if (ipv4.status === 'fulfilled') for (const address of ipv4.value) found.set(`4:${address}`, { address, family: 4 })
    if (ipv6.status === 'fulfilled') for (const address of ipv6.value) found.set(`6:${address}`, { address, family: 6 })
    if (found.size > 0) return { kind: 'addresses', addresses: [...found.values()] }
    const codes = [ipv4, ipv6].map(r => (r.status === 'rejected' ? errorCode(r.reason) : ''))
    if (codes.every(code => NO_SUCH_HOST_CODES.has(code))) {
      return { kind: 'no-such-host', reason: `${hostname} has no DNS address (${codes[0]})` }
    }
    const failing = codes.find(code => code && !NO_SUCH_HOST_CODES.has(code)) ?? 'unknown resolver error'
    return { kind: 'resolver-error', reason: `DNS lookup for ${hostname} failed (${failing})` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** GET the pinned address and resolve on the status line. The body is never read. */
export async function requestPinnedStatus(
  target: SafeWebhookTarget,
  timeoutMs: number,
  options: { lenient?: boolean } = {},
): Promise<SiteStatusResponse> {
  const secure = target.url.protocol === 'https:'
  const port = target.url.port ? Number(target.url.port) : secure ? 443 : 80
  const requestOptions: https.RequestOptions = {
    hostname: target.address,
    family: target.family,
    port,
    method: 'GET',
    path: `${target.url.pathname}${target.url.search}`,
    headers: { Host: target.url.host, 'User-Agent': SITE_REACHABILITY_USER_AGENT, Accept: 'text/html,*/*;q=0.8' },
    insecureHTTPParser: options.lenient === true,
  }
  if (secure) {
    requestOptions.servername = target.url.hostname.replace(/^\[|\]$/g, '')
    if (options.lenient) requestOptions.rejectUnauthorized = false
  }

  return await new Promise<SiteStatusResponse>((resolve, reject) => {
    let settled = false
    const request = (secure ? https.request : http.request)(requestOptions, (response) => {
      if (settled) {
        response.destroy()
        return
      }
      settled = true
      clearTimeout(deadline)
      const location = typeof response.headers.location === 'string' ? response.headers.location : null
      resolve({ status: response.statusCode ?? 0, location })
      response.destroy()
      request.destroy()
    })
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      request.destroy()
      reject(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    request.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      reject(err)
    })
    request.end()
  })
}

export async function probeSiteReachability(url: string, options: SiteReachabilityOptions = {}): Promise<SiteReachabilityResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? DEFAULT_SITE_MAX_REDIRECTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const transport = options.transport ?? ((target, ms, opts) => requestPinnedStatus(target, ms, opts))
  const resolveAddresses = options.resolveAddresses ?? (hostname => lookupSiteAddresses(hostname))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const started = Date.now()

  /** Every approved address for one hop, in resolution order, plus why any were refused. */
  const approveHop = async (hopUrl: string): Promise<
    | { kind: 'targets'; targets: SafeWebhookTarget[] }
    | { kind: 'no-such-host'; reason: string }
    | { kind: 'resolver-error'; reason: string }
    | { kind: 'refused'; reason: string }
  > => {
    let hostname: string
    try {
      hostname = new URL(hopUrl).hostname.replace(/^\[|\]$/g, '')
    } catch {
      return { kind: 'refused', reason: `${hopUrl} is not a valid URL` }
    }
    const lookup = await resolveAddresses(hostname)
    if (lookup.kind !== 'addresses') return lookup
    const targets: SafeWebhookTarget[] = []
    let refusal = ''
    for (const address of lookup.addresses.slice(0, MAX_ADDRESSES_PER_HOP)) {
      // One address at a time through the shared egress policy, so an approved
      // address is still only ever dialed after it was checked by itself.
      const approved = await resolveMeasurementSitemapTarget(hopUrl, { resolveAddresses: async () => [address] })
      if (approved.ok) targets.push(approved.target)
      else if (!refusal) refusal = approved.message
    }
    if (targets.length === 0) return { kind: 'refused', reason: refusal || `${hostname} has no address this instance may dial` }
    return { kind: 'targets', targets }
  }

  const attempt = async (): Promise<Attempt> => {
    let current = url
    for (let hop = 0; ; hop += 1) {
      const approved = await approveHop(current)
      if (approved.kind === 'no-such-host') return { kind: 'down', finalUrl: current, httpStatus: null, reason: approved.reason }
      if (approved.kind === 'resolver-error') return { kind: 'unavailable', reason: approved.reason }
      if (approved.kind === 'refused') return { kind: 'unreachable', finalUrl: current, reason: approved.reason }

      let response: SiteStatusResponse | null = null
      let lastError = ''
      for (const target of approved.targets) {
        try {
          response = await transport(target, timeoutMs)
          break
        } catch (err) {
          lastError = describeError(err)
          if (LENIENT_RETRY_CODES.has(errorCode(err))) {
            try {
              const lenient = await transport(target, timeoutMs, { lenient: true })
              response = { ...lenient, lenient: `${errorCode(err)} (accepted leniently)` }
              break
            } catch (retryErr) {
              lastError = describeError(retryErr)
            }
          }
          // Otherwise fall through to the next approved address, the way a browser fails over.
        }
      }
      if (!response) return { kind: 'down', finalUrl: current, httpStatus: null, reason: lastError || 'no address answered' }

      if (REDIRECT_STATUSES.has(response.status) && response.location) {
        if (hop >= maxRedirects) {
          return { kind: 'down', finalUrl: current, httpStatus: response.status, reason: `more than ${maxRedirects} redirects` }
        }
        try {
          current = new URL(response.location, current).toString()
        } catch {
          return { kind: 'down', finalUrl: current, httpStatus: response.status, reason: 'redirect with an invalid Location header' }
        }
        continue
      }
      if (response.status >= 500 || response.status === 0) {
        return { kind: 'down', finalUrl: current, httpStatus: response.status, reason: `HTTP ${response.status}` }
      }
      return { kind: 'up', finalUrl: current, httpStatus: response.status, lenient: response.lenient }
    }
  }

  let attempts = 1
  let outcome = await attempt()
  // Only a claimed outage is worth a second look. `unavailable` is about this
  // host, and retrying it would just delay the skip.
  if (outcome.kind === 'down' || outcome.kind === 'unreachable') {
    await sleep(retryDelayMs)
    attempts = 2
    outcome = await attempt()
  }
  const durationMs = Date.now() - started
  if (outcome.kind === 'unavailable') return { state: 'unavailable', url, reason: outcome.reason }
  if (outcome.kind === 'up') {
    return { state: 'up', url, finalUrl: outcome.finalUrl, httpStatus: outcome.httpStatus, attempts, durationMs, ...(outcome.lenient ? { lenient: outcome.lenient } : {}) }
  }
  if (outcome.kind === 'unreachable') return { state: 'unreachable', url, finalUrl: outcome.finalUrl, reason: outcome.reason, attempts, durationMs }
  return { state: 'down', url, finalUrl: outcome.finalUrl, httpStatus: outcome.httpStatus, reason: outcome.reason, attempts, durationMs }
}
