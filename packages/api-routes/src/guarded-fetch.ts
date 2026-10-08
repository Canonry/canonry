import { isLocationRedirectStatus } from '@ainyc/canonry-contracts'
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { resolveWebhookTarget, type ResolveWebhookTargetResult, type SafeWebhookTarget } from './webhooks.js'

/**
 * A `fetch` for URLs this instance did not choose: an operator's WordPress
 * site, a sitemap, a traffic plugin endpoint. Checking the URL once and then
 * calling global `fetch` protects nothing, because `fetch` looks the name up
 * again (a rebinding name answers differently the second time) and follows
 * redirects on its own (a `302` to an internal address is never checked).
 *
 * So for the first URL and for every redirect hop this:
 *  - resolves and checks the target with `resolveWebhookTarget`, the shared
 *    egress policy;
 *  - dials only the address that was checked. The URL keeps its hostname, so
 *    the Host header, TLS SNI and the certificate check still use it;
 *  - follows the redirect itself, under the fetch rules: Authorization, Cookie
 *    and Proxy-Authorization are dropped when the origin changes; 301 and 302
 *    turn a POST into a GET, 303 turns anything but GET or HEAD into a GET, and
 *    307 and 308 send the same method and body again.
 *
 * The caller's `redirect` mode is not read: redirects are always followed,
 * checked, up to {@link GUARDED_FETCH_MAX_REDIRECTS}. Use only `http:` and
 * `https:` URLs; the policy refuses every other scheme.
 */
export type GuardedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export const GUARDED_FETCH_MAX_REDIRECTS = 5

export interface GuardedFetchOptions {
  /** Admit loopback targets, as `allowLoopbackWebhooks` does. Every other refused range stays refused. */
  allowLoopback?: boolean
  /**
   * The per-hop decision. Defaults to `resolveWebhookTarget` with
   * `allowLoopback`. Injected in tests, so a fixture on loopback can stand in
   * for a public site while every later hop meets the real policy.
   */
  resolveTarget?: (url: string) => Promise<ResolveWebhookTargetResult>
}

/** The request, or one of its redirect hops, was not sent: its target failed the egress policy. */
export class EgressRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressRefusedError'
  }
}

const CROSS_ORIGIN_DROPPED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const
/** The headers that describe a body. They go with the body when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-length', 'content-location', 'content-type'] as const

export function createGuardedFetch(options: GuardedFetchOptions = {}): GuardedFetch {
  const resolveTarget = options.resolveTarget
    ?? ((url: string) => resolveWebhookTarget(url, { allowLoopback: options.allowLoopback }))

  return async (input, init = {}) => {
    // The policy parses the URL, so a malformed one is a refusal like any other.
    let href = String(input)
    let method = (init.method ?? 'GET').toUpperCase()
    let body = init.body ?? null
    const headers = new Headers(init.headers)

    for (let redirects = 0; ; redirects += 1) {
      const check = await resolveTarget(href)
      if (!check.ok) {
        const host = URL.canParse(href) ? new URL(href).host || href : href
        throw new EgressRefusedError(`Refused to connect to ${host}: ${check.message.replace(/^"url" /, '')}`)
      }
      const url = check.target.url
      const response = await requestPinned(check.target, { method, headers, body, signal: init.signal ?? undefined })
      const location = isLocationRedirectStatus(response.status) ? response.headers.get('location') : null
      if (location === null) return response

      // The redirect's own body is never read, so release its connection now.
      await response.body?.cancel()
      if (redirects >= GUARDED_FETCH_MAX_REDIRECTS) {
        throw new EgressRefusedError(`${url.host} redirected more than ${GUARDED_FETCH_MAX_REDIRECTS} times`)
      }
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new EgressRefusedError(`${url.host} redirected to an invalid Location`)
      }

      const status = response.status
      if ((status === 303 && method !== 'GET' && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET'
        body = null
        for (const name of BODY_HEADERS) headers.delete(name)
      }
      if (next.origin !== url.origin) {
        for (const name of CROSS_ORIGIN_DROPPED_HEADERS) headers.delete(name)
      }
      href = next.href
    }
  }
}

async function requestPinned(
  target: SafeWebhookTarget,
  init: { method: string; headers: Headers; body: BodyInit | null; signal: AbortSignal | undefined },
): Promise<Response> {
  const dispatcher = pinnedAgent(target)
  try {
    const response = await undiciFetch(target.url, {
      method: init.method,
      headers: [...init.headers],
      body: init.body as UndiciRequestInit['body'],
      signal: init.signal,
      redirect: 'manual',
      dispatcher,
    })
    // The same Fetch API Response; only undici's type declarations differ from the DOM lib's.
    return response as unknown as Response
  } finally {
    // A graceful close: the agent finishes once the caller has read the body.
    dispatcher.close().catch(() => {})
  }
}

/**
 * An agent whose every connection dials the checked addresses, whatever the
 * resolver says now. Node does not call `lookup` for an IP-literal host, which
 * is safe: a literal is checked as itself, so it is the checked address.
 */
function pinnedAgent(target: SafeWebhookTarget): Agent {
  const addresses = target.addresses ?? [{ address: target.address, family: target.family }]
  return new Agent({
    // Try the next checked address when one does not answer, so a dual-stack
    // site whose first address is unreachable (an IPv6-only network, a dead A
    // record) still loads, as it does through global `fetch`. Every address
    // passed the policy, so falling back reaches nothing it refused.
    autoSelectFamily: true,
    connect: {
      lookup: (_hostname, options, callback) => {
        // With `autoSelectFamily` Node asks with `{ all: true }` and expects
        // an array of `{ address, family }` rather than one address.
        if (options.all) callback(null, addresses.map(({ address, family }) => ({ address, family })))
        else callback(null, addresses[0]!.address, addresses[0]!.family)
      },
    },
  })
}
