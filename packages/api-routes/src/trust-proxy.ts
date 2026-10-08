/**
 * Who is actually calling, when there is a proxy in the way.
 *
 * Fastify reports `request.ip` as the socket's peer. Behind a reverse proxy
 * that peer is the PROXY, identically for everyone, so anything keyed on it
 * collapses into a single shared bucket — and a per-caller budget becomes an
 * unauthenticated way to lock every real person out.
 *
 * The fix has two halves and both are needed:
 *
 *   1. Tell Fastify which hops to trust, so `request.ip` becomes the real
 *      client again. That is `resolveTrustProxy` below, wired into both servers.
 *   2. Notice when we have NOT been told, and stop pretending. A forwarded
 *      header on a server that trusts nothing means "there is a proxy here and
 *      it has not been configured" — the address in hand is not a caller, and a
 *      budget keyed on it would punish everybody for one attacker.
 */
import type { FastifyRequest } from 'fastify'

/**
 * Parse the operator's trust setting into what Fastify wants.
 *
 * Accepts what an operator would reasonably write:
 *   - unset / `0` / `false` → trust nothing (the safe default for a server
 *     bound to localhost with nothing in front of it)
 *   - `true` → trust every hop. Correct ONLY when the server is unreachable
 *     except through the proxy, because anyone who can reach it directly can
 *     otherwise forge the header.
 *   - a number → trust that many hops closest to this server
 *   - a comma-separated list of addresses/CIDRs → trust exactly those
 */
export function resolveTrustProxy(raw: string | undefined): boolean | number | string[] {
  const value = raw?.trim()
  if (!value) return false

  const lowered = value.toLowerCase()
  if (lowered === 'false' || lowered === '0' || lowered === 'no') return false
  if (lowered === 'true' || lowered === 'yes') return true

  if (/^\d+$/.test(value)) return Number(value)

  const hops = value.split(',').map(part => part.trim()).filter(Boolean)
  return hops.length > 0 ? hops : false
}

/** Headers a proxy adds. Their presence means somebody is in front of us. */
const FORWARDED_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'] as const

export function hasForwardedHeaders(request: FastifyRequest): boolean {
  return FORWARDED_HEADERS.some(header => request.headers[header] !== undefined)
}

/**
 * Headers that a proxy, tunnel, or CDN adds besides the client-address headers
 * above. A proxy that sends only one of these (the original host, scheme, or
 * port, a `Via` hop, or a CDN's client address) still put itself in the path.
 * None of them names the caller Fastify resolves, so `resolveCallerKey` does
 * not read them.
 */
const PROXY_PATH_HEADERS = [
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'via',
  'cf-connecting-ip',
  'true-client-ip',
] as const

/** Whether any header a proxy, tunnel, or CDN adds is present. */
export function hasProxyHeaders(request: FastifyRequest): boolean {
  return hasForwardedHeaders(request)
    || PROXY_PATH_HEADERS.some(header => request.headers[header] !== undefined)
}

/**
 * A stable key for "this caller", or null when there is no honest answer.
 *
 * The rule turns on ONE question the server must be told rather than guess:
 * has an operator declared a proxy in front of it?
 *
 *   - NOT declared. Forwarded headers are meaningless — Fastify never consulted
 *     them, and anyone can set them. The socket's peer is the only thing here
 *     that cannot be forged, so it IS the caller. Treating a self-asserted
 *     header as evidence of a proxy was an opt-out: an attacker with no proxy
 *     at all could add one line and have every per-caller budget skipped.
 *   - Declared, and Fastify resolved an address out of the chain. That resolved
 *     address is the caller.
 *   - Declared, but the chain did not resolve past the proxy. Now the address
 *     in hand really is shared by everyone behind it, and there is no honest
 *     per-caller answer — null, so the budget degrades rather than punishing
 *     every real person for one attacker.
 *
 * Note what this costs when a proxy is present but undeclared: callers share a
 * bucket again. That is a MISCONFIGURATION, it is the operator's to fix with
 * `CANONRY_TRUST_PROXY`, and a shared bucket is a far better failure than a
 * budget any attacker can switch off from the outside.
 */
export function resolveCallerKey(request: FastifyRequest, trustProxyConfigured: boolean): string | null {
  const socketAddress = request.socket.remoteAddress ?? request.ip

  if (!trustProxyConfigured) return socketAddress

  // Declared: a resolved address that differs from the socket's peer is proof
  // the chain was believed and yielded a real client.
  if (request.ip !== socketAddress) return request.ip

  // Declared but unresolved past the proxy — only then is there nobody to name.
  if (hasForwardedHeaders(request)) return null

  return socketAddress
}
