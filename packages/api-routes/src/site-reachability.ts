import http from 'node:http'
import https from 'node:https'
import { describeError } from '@ainyc/canonry-contracts'
import { resolveMeasurementSitemapTarget, resolveSitemapAddresses } from './measurement-sitemap-fetch.js'
import type { SafeWebhookTarget } from './webhooks.js'

/**
 * Does the project's website answer at all?
 *
 * A homepage is probed the way the sitemap fetcher reaches operator URLs: every
 * hop is resolved and checked against the private, reserved and link-local
 * ranges first, and the socket dials the address that was checked, so a
 * project domain can never be used to reach this host's own network.
 *
 * "Up" means the server answered below 500. A 403 or 429 is a bot challenge
 * from a site that is serving people, and paging on it would train operators
 * to ignore the channel. "Down" means no answer, a TLS failure, a 5xx, or a
 * redirect loop, and only after a second attempt a moment later agrees.
 */

export const SITE_REACHABILITY_USER_AGENT = 'Canonry site-liveness (+https://canonry.ai)'

export interface SiteStatusResponse {
  status: number
  location: string | null
}

/** The transport seam, so tests exercise redirects and failures without a socket. */
export type SiteStatusTransport = (target: SafeWebhookTarget, timeoutMs: number) => Promise<SiteStatusResponse>

/** A hop resolution. `unresolved` separates "the name has no address" (down) from a refused address (not probed). */
export type SiteHopResolution =
  | { ok: true; target: SafeWebhookTarget }
  | { ok: false; message: string; unresolved: boolean }

export interface SiteReachabilityOptions {
  timeoutMs?: number
  maxRedirects?: number
  retryDelayMs?: number
  transport?: SiteStatusTransport
  resolveHop?: (url: string) => Promise<SiteHopResolution>
  sleep?: (ms: number) => Promise<void>
}

export type SiteReachabilityResult =
  | { state: 'up'; url: string; finalUrl: string; httpStatus: number; attempts: number; durationMs: number }
  | { state: 'down'; url: string; finalUrl: string; httpStatus: number | null; reason: string; attempts: number; durationMs: number }
  | { state: 'blocked'; url: string; reason: string }

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

type Attempt =
  | { kind: 'up'; finalUrl: string; httpStatus: number }
  | { kind: 'down'; finalUrl: string; httpStatus: number | null; reason: string }
  | { kind: 'blocked'; reason: string }

async function defaultResolveHop(url: string): Promise<SiteHopResolution> {
  let unresolved = false
  try {
    const result = await resolveMeasurementSitemapTarget(url, {
      resolveAddresses: async (hostname) => {
        let addresses: Awaited<ReturnType<typeof resolveSitemapAddresses>>
        try {
          addresses = await resolveSitemapAddresses(hostname)
        } catch (err) {
          unresolved = true
          throw err
        }
        if (addresses.length === 0) unresolved = true
        return addresses
      },
    })
    return result.ok ? result : { ok: false, message: result.message, unresolved }
  } catch (err) {
    return { ok: false, message: describeError(err), unresolved: true }
  }
}

/** GET the pinned address and resolve on the status line. The body is never read. */
export async function requestPinnedStatus(target: SafeWebhookTarget, timeoutMs: number): Promise<SiteStatusResponse> {
  const secure = target.url.protocol === 'https:'
  const port = target.url.port ? Number(target.url.port) : secure ? 443 : 80
  const requestOptions: https.RequestOptions = {
    hostname: target.address,
    family: target.family,
    port,
    method: 'GET',
    path: `${target.url.pathname}${target.url.search}`,
    headers: { Host: target.url.host, 'User-Agent': SITE_REACHABILITY_USER_AGENT, Accept: 'text/html,*/*;q=0.8' },
  }
  if (secure) requestOptions.servername = target.url.hostname.replace(/^\[|\]$/g, '')

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
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxRedirects = options.maxRedirects ?? 3
  const retryDelayMs = options.retryDelayMs ?? 2_000
  const transport = options.transport ?? requestPinnedStatus
  const resolveHop = options.resolveHop ?? defaultResolveHop
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const started = Date.now()

  const attempt = async (): Promise<Attempt> => {
    let current = url
    for (let hop = 0; ; hop += 1) {
      const resolved = await resolveHop(current)
      if (!resolved.ok) {
        return resolved.unresolved
          ? { kind: 'down', finalUrl: current, httpStatus: null, reason: resolved.message }
          : { kind: 'blocked', reason: resolved.message }
      }
      let response: SiteStatusResponse
      try {
        response = await transport(resolved.target, timeoutMs)
      } catch (err) {
        return { kind: 'down', finalUrl: current, httpStatus: null, reason: describeError(err) }
      }
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
      return { kind: 'up', finalUrl: current, httpStatus: response.status }
    }
  }

  let attempts = 1
  let outcome = await attempt()
  if (outcome.kind === 'down') {
    await sleep(retryDelayMs)
    attempts = 2
    outcome = await attempt()
  }
  const durationMs = Date.now() - started
  if (outcome.kind === 'blocked') return { state: 'blocked', url, reason: outcome.reason }
  if (outcome.kind === 'up') return { state: 'up', url, finalUrl: outcome.finalUrl, httpStatus: outcome.httpStatus, attempts, durationMs }
  return { state: 'down', url, finalUrl: outcome.finalUrl, httpStatus: outcome.httpStatus, reason: outcome.reason, attempts, durationMs }
}
