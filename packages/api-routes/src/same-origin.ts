/**
 * The same-origin rule for cookie-carried writes.
 *
 * Lives in its own module because two callers need exactly one implementation:
 * the auth plugin, which applies it to every gated write, and the sign-in
 * routes, which are on the auth skip-list and therefore have to apply it by
 * hand. Two copies would drift, and the copy that drifts is a hole.
 */
import type { FastifyRequest } from 'fastify'
import { forbidden } from '@canonry/canonry-contracts'

/** HTTP methods that change something. Safe methods are never checked. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** What a browser is told when a write arrives from somewhere that is not the dashboard. */
export const FOREIGN_ORIGIN_MESSAGE =
  'This change did not come from the dashboard, so it was not applied.'

/** The origin a request claims to have come from, by whichever header carries it. */
function claimedOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') return origin

  const referer = request.headers.referer
  if (typeof referer === 'string' && referer) {
    try {
      return new URL(referer).origin
    } catch {
      return null
    }
  }
  return null
}

/**
 * Refuse a cookie-carried write that did not come from this dashboard.
 *
 * `SameSite=Lax` stops another SITE from riding the cookie, but "site" is
 * registrable-domain coarse: any sibling origin under the same domain counts as
 * same-site and its requests carry the cookie. One compromised or untrusted
 * sibling — a docs host, a preview deployment, a subdomain somebody else
 * operates — could then drive real writes here, including runs that cost money.
 * Comparing the ORIGIN to this server's own host closes that, because a sibling
 * cannot forge the header.
 *
 * Only COOKIE-carried credentials are checked — including the older shared
 * dashboard password, which resolves to a wildcard key but is still a browser
 * session in every way that matters here. A key presented in an Authorization
 * header is exempt: no browser attaches one automatically, so there is nothing
 * to ride, and checking it would break every CLI and agent.
 *
 * A missing origin is refused rather than allowed — every browser sends one on a
 * write, so its absence means the request is not the browser this is written for.
 */
function assertOriginMatchesHost(request: FastifyRequest): void {
  const host = request.headers.host
  const origin = claimedOrigin(request)
  if (!origin || !host) throw forbidden(FOREIGN_ORIGIN_MESSAGE)

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw forbidden(FOREIGN_ORIGIN_MESSAGE)
  }
  if (originHost !== host) throw forbidden(FOREIGN_ORIGIN_MESSAGE)
}

export function assertSameOriginWrite(request: FastifyRequest): void {
  if (!request.principal?.viaCookie) return
  if (!WRITE_METHODS.has(request.method)) return
  // No exemption for read-semantic routes.
  //
  // There was one, and it conflated two different questions: `readSemantic`
  // answers "may a view-only account call this", and it was being read as
  // "may another site cause this to be called". Those come apart immediately —
  // measurement-discovery is read-semantic and reaches out to a URL taken from
  // the request body. The dashboard sends an origin on every request it makes,
  // so there is nothing to buy by exempting these and a whole class of future
  // route to get wrong.
  assertOriginMatchesHost(request)
}

/**
 * The same rule, for a route that resolved its own cookie and so has no
 * principal attached yet. Same comparison, stated once.
 */
export function assertCookieWriteOrigin(request: FastifyRequest): void {
  if (!WRITE_METHODS.has(request.method)) return
  assertOriginMatchesHost(request)
}
