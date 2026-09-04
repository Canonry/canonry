import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { apiKeys, projects, runs, users } from '@ainyc/canonry-db'
import {
  ADS_ACTIVATE_SCOPE,
  ADS_APPROVE_SCOPE,
  ADS_WRITE_SCOPE,
  authRequired,
  authInvalid,
  forbidden,
  isReadOnlyKey,
  normalizeIdTokens,
  READ_ONLY_SCOPE,
  RunKinds,
  splitList,
  UserRoles,
  WILDCARD_SCOPE,
  type UserRole,
} from '@ainyc/canonry-contracts'
import { assertSameOriginWrite } from './same-origin.js'
import {
  anyUsersExist,
  cookieIsSecure,
  parseCookieHeader,
  resolveUserSession,
  serializeUserSessionCookie,
  USER_SESSION_COOKIE_NAME,
  type UserSessionCookieOptions,
} from './user-session.js'

/**
 * HTTP methods that mutate state. A read-only key is rejected on these; the
 * safe methods (GET / HEAD / OPTIONS) always pass so reads — and any future
 * CORS preflight — are never blocked.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const ADS_MUTATION_SCOPES: ReadonlySet<string> = new Set([
  ADS_WRITE_SCOPE,
  ADS_APPROVE_SCOPE,
  ADS_ACTIVATE_SCOPE,
])

function isAdsMutationOnlyKey(scopes: readonly string[]): boolean {
  const writeGrants = scopes.filter((scope) =>
    scope === '*'
    || scope === 'write'
    || scope.endsWith('.write')
    || scope === ADS_APPROVE_SCOPE
    || scope === ADS_ACTIVATE_SCOPE)
  return writeGrants.length > 0 && writeGrants.every((scope) => ADS_MUTATION_SCOPES.has(scope))
}

function isAdsWriteRoute(url: string): boolean {
  const rest = projectRouteRest(url)
  return rest !== null && rest.startsWith('ads/')
}

/**
 * Resolved API key attached to every authenticated request. Used by scope
 * gates on sensitive routes — see `requireScope`.
 */
export interface AuthedApiKey {
  id: string
  name: string
  scopes: string[]
  /**
   * When set, the key is scoped to this single project id. The `authPlugin`
   * project gate + `assertProjectScope` enforce it. Absent/null = the
   * historical full-instance access.
   */
  projectId?: string | null
}

/**
 * Whoever is making this request.
 *
 * There are exactly two kinds and they are peers: an API key, and a person
 * signed in with a named account. Neither one gates the other, and both are
 * expressed in the SAME currency — a scope list — so every existing gate keeps
 * working unchanged instead of growing a second permission model beside it.
 *
 * An admin carries `['*']`: precisely the authority the install already had,
 * now behind a sign-in. A viewer carries `['read']`, which the global write
 * gate below already understands.
 */
export interface AuthPrincipal {
  kind: 'api-key' | 'user'
  id: string
  name: string
  scopes: string[]
  projectId?: string | null
  /** Present only for a signed-in person. */
  role?: UserRole
  /**
   * The credential arrived in a COOKIE, so a browser attaches it automatically
   * and another origin can therefore cause it to be sent.
   *
   * This is deliberately separate from `kind`. The install's older shared
   * dashboard password also arrives in a cookie and resolves to a wildcard API
   * key — so a rule written against `kind` would exempt a full-authority
   * browser session from the very check that exists to protect browser
   * sessions. What matters is the carrier, not what it resolves to.
   */
  viaCookie: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The API key that authenticated the current request. Present on every
     * request that passed `authPlugin` (i.e. everything not in the
     * skip-paths list). Routes that need scope checks should call
     * `requireScope(request, '<scope>')`.
     *
     * Absent when the request was authenticated by a signed-in person — see
     * `principal`, which covers both cases.
     */
    apiKey?: AuthedApiKey
    /** Whoever authenticated this request: an API key or a signed-in person. */
    principal?: AuthPrincipal
    /**
     * Set when a viewer reached a route whose config declares `readSemantic`.
     * Only ever true for a signed-in viewer, so API-key behavior is untouched
     * by the annotation.
     */
    readSemanticGrant?: boolean
  }
  interface FastifyContextConfig {
    /**
     * This route's POST does not change anything.
     *
     * A few routes are reads that have to be POSTs because the thing being read
     * is described by a body too large for a URL — compiling a proposed plan to
     * see what it would do, for instance. The blanket "no write methods for a
     * viewer" rule would otherwise refuse them, leaving a viewer unable to look
     * at the very previews that exist to be looked at.
     *
     * Set this ONLY on a route that performs no writes at all. It is the entire
     * allowance; every other write method stays refused for a viewer. It also
     * changes nothing for an API key — a read-only key is refused here exactly
     * as it was before.
     */
    readSemantic?: boolean

    /**
     * This route's POST is a PROTOCOL ENVELOPE, not an operation.
     *
     * A JSON-RPC transport (MCP over Streamable HTTP) carries every message —
     * including pure reads like `initialize` and `tools/list` — inside a POST.
     * The method-based read-only gate below would therefore refuse a
     * `['read']` key at the door, which defeats the entire point of handing a
     * client a read-only credential.
     *
     * WHY THIS IS SAFE, and the reason it is scoped to one route: the flag
     * lets the ENVELOPE through, never the operations inside it. The transport
     * re-dispatches each tool call as a fresh authenticated HTTP request
     * carrying the caller's own bearer, so the read-only gate, the ads gate and
     * the project-scope gate all re-apply per operation, at their normal
     * strength. Nothing reaches a handler without passing this hook again.
     *
     * Set this ONLY on a transport endpoint that does no work of its own.
     */
    transportEnvelope?: boolean
  }
}

function principalScopes(request: FastifyRequest): string[] | undefined {
  return request.principal?.scopes ?? request.apiKey?.scopes
}

/** True when the route this request landed on declared itself a pure read. */
function isReadSemanticRoute(request: FastifyRequest): boolean {
  return request.routeOptions.config.readSemantic === true
}

/**
 * True when this route is a JSON-RPC transport envelope rather than an
 * operation. See `transportEnvelope` above for why this exemption is sound.
 */
function isTransportEnvelopeRoute(request: FastifyRequest): boolean {
  return request.routeOptions.config.transportEnvelope === true
}

/**
 * Reject the request unless the caller carries the named scope (or the
 * wildcard `'*'`). The wildcard is what `canonry init` writes for the
 * install's root key, and it is also what an admin account carries —
 * operators don't have to opt in to existing capabilities. Created delegate
 * keys must declare their scopes explicitly to satisfy this gate.
 */
export function requireScope(request: FastifyRequest, scope: string): void {
  // A viewer on a route that only reads is allowed through — see the
  // `readSemantic` route config above.
  if (request.readSemanticGrant) return

  const scopes = principalScopes(request)
  // No principal on the request means the auth plugin didn't run — happens when
  // `apiRoutes` is mounted with `skipAuth: true` (test harnesses, fixtures).
  // The deployable code path always registers `authPlugin` before routes,
  // so a real request without one would have been rejected upstream.
  // Treat the absence as "auth not enforced" rather than as a deny — this
  // keeps the test harness ergonomic without weakening the prod gate.
  if (!scopes) return
  if (scopes.includes('*') || scopes.includes(scope)) return
  if (request.principal?.kind === 'user') {
    throw forbidden(VIEWER_DENIED_MESSAGE)
  }
  throw forbidden(`This action requires the "${scope}" scope on your API key.`)
}

/** What a viewer is told when they reach something only an admin can do. */
export const VIEWER_DENIED_MESSAGE =
  'Your account has view-only access, so it cannot make this change.'

/** What a viewer is told when they reach an administrator-only screen. */
export const ADMIN_ONLY_MESSAGE =
  'Only an administrator account can use this.'

/**
 * Reject a signed-in VIEWER outright, whatever the HTTP method.
 *
 * The name says session on purpose: this asks about the role on a sign-in and
 * nothing else. An API key passes straight through, because this function never
 * reads a key's scopes — so it is NOT sufficient on its own for a surface a
 * narrow key should not reach. Pair it with `requireBroadInstanceKey` there.
 */
export function requireAdminSession(request: FastifyRequest): void {
  const principal = request.principal
  if (!principal || principal.kind !== 'user') return
  if (principal.role === UserRoles.admin) return
  throw forbidden(ADMIN_ONLY_MESSAGE)
}

/**
 * Reject a credential that must not be able to SPEND on the operator's behalf.
 *
 * Some reads are not free: they fan out into billed provider calls. The
 * method-based gate only sees the HTTP verb, so a GET that costs money looks
 * exactly like one that does not.
 *
 * Stated as an ALLOW list on purpose, mirroring `requireBroadInstanceKey`. The
 * previous version asked one DENY question — "is this key read-only" — and a
 * key that was merely narrow (scoped to something unrelated, e.g.
 * `users.read`) sailed straight through: it never opted into the `read` token,
 * so `isReadOnlyKey` said no, and "not read-only" was treated as "may spend."
 * Deny lists silently widen every time a new scope is invented; an allow list
 * does not.
 *
 * So: the wildcard, or a scope explicitly about ads. Nothing else — including
 * a key that merely isn't marked read-only, and including an empty scope
 * list. "Read-only" is a statement about Canonry's own data; it was never a
 * licence to spend, and now neither is silence.
 */
export function requirePaidReadScope(request: FastifyRequest): void {
  const principal = request.principal
  if (!principal || principal.kind !== 'api-key') return
  const grantsAdsAccess = principal.scopes.some(scope =>
    scope === WILDCARD_SCOPE
    || scope === ADS_WRITE_SCOPE
    || scope === ADS_APPROVE_SCOPE
    || scope === ADS_ACTIVATE_SCOPE)
  if (!grantsAdsAccess) {
    throw forbidden('This API key was not granted access to OpenAI Ads paid reads.')
  }
}

/**
 * Require a key that was actually granted account administration.
 *
 * Stated as an ALLOW list on purpose. The previous version asked two deny
 * questions — "is it read-only" and "is it project-scoped" — and a key that was
 * neither sailed through: `['ads.write']`, or even `[]`, could enumerate every
 * account name, role and last sign-in. Deny lists silently widen every time a
 * new scope is invented; an allow list does not.
 *
 * So: the wildcard, or a scope explicitly about accounts. Nothing else. A
 * project-scoped key is refused whatever its scopes, because the install's
 * access list is not a single project's business.
 */
export function requireBroadInstanceKey(request: FastifyRequest): void {
  const principal = request.principal
  if (!principal || principal.kind !== 'api-key') return
  if (principal.projectId) {
    throw forbidden('This API key is limited to one project, and this is an instance-wide surface.')
  }
  const grantsAccountAccess = principal.scopes.some(scope =>
    scope === WILDCARD_SCOPE || scope === USERS_READ_SCOPE || scope === USERS_WRITE_SCOPE)
  if (!grantsAccountAccess) {
    throw forbidden('This API key was not granted access to accounts on this install.')
  }
}

/**
 * Enforce a project-scoped key against a project id resolved from an ENTITY
 * (a run, snapshot, …) rather than the URL. The `authPlugin` project gate
 * already covers every `/projects/<name>` route; call this in the handful of
 * routes that address an entity by id (e.g. `/runs/:id`, `/screenshots/:id`)
 * AFTER loading the entity, passing the entity's `projectId`. A full-instance
 * key (no `projectId`) or an unauthenticated request passes.
 */
export function assertProjectScope(request: FastifyRequest, projectId: string): void {
  const scoped = request.apiKey?.projectId
  if (scoped && scoped !== projectId) {
    throw forbidden('This API key is scoped to a different project.')
  }
}

/**
 * Refuse a project-scoped key on a route whose RESPONSE inherently spans more
 * than the scoped project.
 *
 * `assertProjectScope` is not enough for these. It compares the key's project
 * against one entity, but a route that enumerates an upstream provider's
 * account tree returns whatever the operator's OAuth principal can see —
 * every client on the instance, not just the one in the URL. A key deliberately
 * narrowed to one project would otherwise read a list of unrelated clients'
 * property and account names, which is exactly the boundary that key exists to
 * draw.
 *
 * A full-instance key (no `projectId`) or a signed-in person passes.
 */
export function assertNotProjectScoped(request: FastifyRequest, what: string): void {
  if (request.apiKey?.projectId) {
    throw forbidden(
      `This API key is scoped to a single project, and ${what} covers every account the connected Google principal can see. Use a full-instance key.`,
    )
  }
}

/**
 * Hash a raw `cnry_…` bearer token to the value stored in `api_keys.key_hash`.
 * Plain SHA-256 is sufficient here because the tokens are 128-bit random, so a
 * 64-hex digest has no brute-force exposure. Exported so the key-management
 * routes (`keys.ts`) hash newly minted keys through the exact same function the
 * auth path verifies against — never duplicate the sha256 inline.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

const SKIP_PATHS = ['/health']

export function shouldSkipAuth(url: string): boolean {
  if (SKIP_PATHS.includes(url)) return true
  if (url.endsWith('/openapi.json')) return true
  // Both OAuth callback routes (`/google/callback` and
  // `/projects/:name/google/callback`) end with this suffix. `endsWith` (not
  // `includes`) so a future route that merely contains the substring — e.g.
  // `/google/callback/anything` — does not silently become unauthenticated.
  if (url.endsWith('/google/callback')) return true
  // Shared Google Ads / Tag Manager OAuth callback. This is intentionally the
  // same exact-suffix rule as the legacy Google callback above: only the
  // signed state verifier in that route may receive an unauthenticated request.
  if (url.endsWith('/google-marketing/callback')) return true
  if (url.endsWith('/session') || url.endsWith('/session/setup')) return true
  // The sign-in surface. It cannot require a credential: the sign-in screen has
  // to be able to ask whether a sign-in is needed, offer the form, and clear a
  // dead session, none of which it can do while holding something it does not
  // have yet. Each of the three does its own resolution.
  if (url.endsWith('/auth/session') || url.endsWith('/auth/login') || url.endsWith('/auth/logout')) return true
  // Seeing and ending your own sessions is part of the sign-in surface: it has
  // to work from a session that the rest of the API might already be refusing.
  // Both routes resolve the cookie themselves, and the DELETE runs its own
  // same-origin check below.
  if (url.endsWith('/auth/sessions')) return true
  // Cloudflare Worker ingest carries its own per-source bearer + HMAC
  // (verified inside the route handler). A canonry `cnry_*` key isn't
  // available to the Worker — that would defeat the per-source isolation.
  if (url.endsWith('/traffic/cloudflare/ingest')) return true
  return false
}

/** Reading the install's account list. */
export const USERS_READ_SCOPE = 'users.read'

/** Creating or deleting accounts. Also satisfies the read gate. */
export const USERS_WRITE_SCOPE = 'users.write'

/** Scopes a role carries. Admin is exactly today's authority, behind a sign-in. */
function scopesForRole(role: UserRole): string[] {
  return role === UserRoles.admin ? [WILDCARD_SCOPE] : [READ_ONLY_SCOPE]
}

/** What an OAuth access token resolved to. */
export interface ResolvedOAuthToken {
  userId: string
  clientId: string
  scope: string | null
}

export interface AuthPluginOptions {
  /**
   * Resolve a bearer that is NOT an api key as an OAuth 2.1 access token.
   *
   * Hosted MCP clients cannot present an api key at all — ChatGPT offers only
   * OAuth, no-auth, or a mix — so without this the remote MCP surface is
   * unreachable from them no matter what else is built. Tried only after the
   * api-key lookup misses, so nothing about existing keys changes.
   */
  resolveOAuthToken?: (token: string) => ResolvedOAuthToken | null

  sessionCookieName?: string
  resolveSessionApiKeyId?: (sessionId: string) => string | null | Promise<string | null>
  /** Cookie attributes for named-account sessions. Must match the sign-in routes. */
  userSessionCookie?: UserSessionCookieOptions
  /**
   * When set, the server is running in embed mode and this is the effective
   * project-tab allowlist. It is a server-side data boundary layered on top of
   * the read-only/project-scoped key: hidden tabs' API reads are rejected even
   * if a client forges the URL.
   */
  embedProjectTabs?: readonly string[]
}

function queryValue(request: FastifyRequest, key: string): string | undefined {
  const raw = (request.query as Record<string, unknown> | undefined)?.[key]
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return undefined
}

/**
 * The effective tab set to enforce for this request, or `undefined` when
 * nothing restricts it at all.
 *
 * A caller-supplied header may only NARROW the server's configured allowlist,
 * never replace or widen it — the header comes from the Embed v2 fronting
 * proxy scoping ONE embedded dashboard down to a subset of what the install
 * allows overall, not from a party trusted to name the install's allowlist
 * itself. When a configured allowlist exists, the result is its intersection
 * with the header (or the allowlist verbatim when there is no header) — this
 * can legitimately be `[]` when the header names no tab the install permits,
 * and `[]` must still be treated as an ACTIVE (maximally narrow) restriction
 * by the caller, not as "nothing to enforce".
 */
function requestEmbedProjectTabs(
  request: FastifyRequest,
  configuredTabs: readonly string[] | undefined,
): string[] | undefined {
  const headerTabs = normalizeIdTokens(splitList(request.headers['x-canonry-embed-tabs']))
  const configured = configuredTabs && configuredTabs.length > 0 ? configuredTabs : undefined

  if (!configured) return headerTabs
  if (!headerTabs) return [...configured]
  return headerTabs.filter((tab) => configured.includes(tab))
}

function projectRouteRest(url: string): string | null {
  const match = url.match(/\/projects\/[^/]+(?:\/([^?#]*))?$/)
  if (!match) return null
  return match[1] ?? ''
}

function isGlobalAnswerVisibilityRunsList(request: FastifyRequest, url: string): boolean {
  if (!url.endsWith('/runs')) return false
  const kind = queryValue(request, 'kind')
  return kind === RunKinds['answer-visibility']
}

function isAnswerVisibilityRunsList(request: FastifyRequest, rest: string): boolean {
  if (rest !== 'runs') return false
  const kind = queryValue(request, 'kind')
  return kind === RunKinds['answer-visibility']
}

function isAnswerVisibilityRunDetail(request: FastifyRequest, url: string): boolean {
  const runMatch = url.match(/\/runs\/([^/?#]+)$/)
  if (!runMatch) return false
  const run = request.server.db
    .select({ kind: runs.kind })
    .from(runs)
    .where(eq(runs.id, decodeURIComponent(runMatch[1]!)))
    .get()
  // Unknown ids continue downstream to the route's normal 404. Existing
  // answer-visibility ids are safe for the project dashboard evidence drawer.
  return !run || run.kind === RunKinds['answer-visibility']
}

function isProjectShellRead(request: FastifyRequest, url: string): boolean {
  if (url.endsWith('/projects')) return true
  if (isGlobalAnswerVisibilityRunsList(request, url)) return true

  const rest = projectRouteRest(url)
  if (rest === null) return isAnswerVisibilityRunDetail(request, url)

  return rest === '' || isAnswerVisibilityRunsList(request, rest)
}

function isOverviewRead(url: string): boolean {
  const rest = projectRouteRest(url)
  if (rest === null) return false
  return new Set([
    'queries',
    'competitors',
    'timeline',
    'overview',
    'analytics/metrics',
    // Stored historical competitor evidence. This path does not call a
    // provider and write methods are refused before the tab allowlist.
    'analytics/competitors',
    'google/gsc/coverage',
    'bing/coverage',
    'insights',
    'citations/visibility',
  ]).has(rest)
}

function isTechnicalAeoRead(request: FastifyRequest, url: string): boolean {
  const rest = projectRouteRest(url)
  if (rest === 'runs') {
    return queryValue(request, 'kind') === RunKinds['site-audit']
  }
  if (rest && /^technical-aeo\/runs\/[^/]+\/(?:progress|page-health-preview)$/.test(rest)) {
    return true
  }
  return rest === 'technical-aeo'
    || rest === 'technical-aeo/pages'
    || rest === 'technical-aeo/trend'
    || rest === 'technical-aeo/crawl'
    || rest === 'technical-aeo/graph'
    || rest === 'technical-aeo/subgraph'
    || rest === 'technical-aeo/path'
    || rest === 'technical-aeo/changes'
    || rest === 'technical-aeo/crawl/pages/audit'
    || rest === 'technical-aeo/crawl/pages'
    // Scan history. Only the GET reaches here; every write method is refused
    // before the tab allowlist is consulted, so the POST on this same path
    // stays out of the embed surface.
    || rest === 'technical-aeo/runs'
    || rest === 'technical-aeo/structure'
    || rest === 'technical-aeo/internal-links'
    || rest === 'technical-aeo/internal-links/neighbors'
    || rest === 'technical-aeo/dead-links'
}

function isReportRead(url: string): boolean {
  const rest = projectRouteRest(url)
  return rest === 'report' || rest === 'report.html'
}

function enforceEmbedProjectTabs(request: FastifyRequest, configuredTabs: readonly string[] | undefined): void {
  const tabs = requestEmbedProjectTabs(request, configuredTabs)
  // `undefined` is the only "nothing to enforce" value now. An empty ARRAY is
  // a real, maximally-narrow restriction (a header that named no tab the
  // install permits) and must fall through to the checks below, where an
  // empty `tabs.includes(...)` never matches and the request is refused
  // rather than waved through as if no allowlist applied.
  if (tabs === undefined) return
  if (request.method === 'OPTIONS') return

  // In embed mode with a tab allowlist, the public iframe is a read surface.
  // The read-only key already blocks writes, but this makes the tab policy
  // independent of key shape and future write routes.
  if (WRITE_METHODS.has(request.method)) {
    throw forbidden('This endpoint is not available in embed mode.')
  }

  const url = request.url.split('?')[0]!
  if (isProjectShellRead(request, url)) return
  if (tabs.includes('overview') && isOverviewRead(url)) return
  if (tabs.includes('technical-aeo') && isTechnicalAeoRead(request, url)) return
  if (tabs.includes('report') && isReportRead(url)) return

  throw forbidden('This endpoint is not available for the configured embed tabs.')
}

/**
 * Resolve a sign-in cookie to a principal, or return false.
 *
 * Returns false — rather than refusing — when there is no cookie or the cookie
 * is dead, so the caller decides what "not signed in" means for this install.
 * Extending a session re-sends the cookie, which is what keeps somebody working
 * all day from being signed out at hour twelve.
 */
function resolveSignedInPerson(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  cookie: UserSessionCookieOptions | undefined,
): boolean {
  const sessionId = parseCookieHeader(request.headers.cookie)[USER_SESSION_COOKIE_NAME]
  if (!sessionId) return false

  const resolved = resolveUserSession(app.db, sessionId)
  if (!resolved) return false

  request.principal = {
    kind: 'user',
    id: resolved.user.id,
    name: resolved.user.name,
    scopes: scopesForRole(resolved.user.role),
    projectId: null,
    role: resolved.user.role,
    viaCookie: true,
  }

  if (resolved.renewedExpiresAt) {
    reply.header('set-cookie', serializeUserSessionCookie({
      value: sessionId,
      path: cookie?.path,
      secure: cookieIsSecure(request, cookie?.secure),
    }))
  }

  return true
}

/**
 * The one place a signed-in person's role turns into a yes or a no.
 *
 * A viewer is refused every write method, which is the same gate a read-only
 * API key already goes through — there is no second permission model here, only
 * a second way to arrive at the same scope list. The single exception is a route
 * that has declared itself a read (the `readSemantic` route config).
 */
function applyRoleGates(request: FastifyRequest): void {
  const principal = request.principal
  if (!principal || principal.kind !== 'user') return

  request.readSemanticGrant = principal.role === UserRoles.viewer && isReadSemanticRoute(request)

  // A transport envelope is a read no matter WHO is asking, so the exemption is
  // separate from `readSemanticGrant` rather than folded into it. Those two
  // pivot on different things and conflating them was a live bug: this gate
  // keys off SCOPES, while readSemanticGrant keys off the viewer ROLE. An
  // admin who grants an OAuth connector `scope=read` correctly ends up with
  // read-only scopes and a non-viewer role, so the gate fired and the grant did
  // not exempt it — the connector was refused at the door for exactly the
  // person who set it up.
  if (
    isReadOnlyKey(principal.scopes)
    && WRITE_METHODS.has(request.method)
    && !request.readSemanticGrant
    && !isTransportEnvelopeRoute(request)
  ) {
    throw forbidden(VIEWER_DENIED_MESSAGE)
  }
}

export async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions = {}) {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0]!
    if (shouldSkipAuth(url)) return

    const header = request.headers.authorization
    let key: typeof apiKeys.$inferSelect | undefined
    // Tracks the CARRIER, which is what decides whether a browser could have
    // been made to send this request. The older shared dashboard password
    // resolves to a key but arrives in a cookie, and that is the case the
    // origin rule exists for.
    let keyArrivedInCookie = false

    if (header) {
      const parts = header.split(' ')
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw authRequired()
      }

      const token = parts[1]!
      const hash = hashApiKey(token)

      key = app.db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hash))
        .get()

      if (!key || key.revokedAt) {
        // Not an api key. Before refusing, try it as an OAuth access token:
        // this is the only credential a hosted MCP client can present.
        // An OAuth token is ONLY ever a credential for the MCP transport. It is
        // refused everywhere else, and that confinement is load-bearing: the
        // token is minted for a specific resource URL, so honouring it on the
        // wider REST surface would let a connector approved for one thing act
        // on everything the person can reach. Checked before the token is even
        // looked up, so a non-MCP route cannot be probed with one.
        const granted = isTransportEnvelopeRoute(request)
          ? opts.resolveOAuthToken?.(token) ?? null
          : null
        if (granted) {
          const account = app.db.select().from(users).where(eq(users.id, granted.userId)).get()
          if (!account) throw authInvalid()
          // Authority is the INTERSECTION of what the person can do and what
          // they granted the client. Taking the role alone was a privilege
          // escalation: an admin approving a `scope=read` connector handed it
          // full admin, including minting root api keys.
          const roleScopes = scopesForRole(account.role)
          // `offline_access` governs refresh tokens, not API authority.
          const requested = (granted.scope ?? '')
            .split(/\s+/)
            .filter(part => part.length > 0 && part !== 'offline_access')
          // The role is a CEILING, the grant is the request, and the effective
          // authority is the smaller of the two. A literal set intersection is
          // wrong here because an admin's role scope is the wildcard `*`, which
          // does not textually contain `read` — intersecting would leave an
          // admin who granted `scope=read` with no authority at all.
          const narrowed = roleScopes.includes(WILDCARD_SCOPE)
            ? (requested.length > 0 ? requested : [READ_ONLY_SCOPE])
            : roleScopes.filter(scope => requested.includes(scope) || requested.includes(WILDCARD_SCOPE))
          // An EMPTY set is not "no authority" — isReadOnlyKey([]) is false,
          // because empty means "no read-only marker", so an empty set reads as
          // NOT read-only and widens the catalog. A grant that intersects
          // nothing must therefore floor at read, never at nothing: otherwise
          // the narrowest possible grant to the least privileged account yields
          // the WIDEST tool surface.
          const effective = narrowed.length > 0 ? narrowed : [READ_ONLY_SCOPE]
          request.principal = {
            kind: 'user',
            id: account.id,
            name: account.name,
            scopes: effective,
            role: account.role,
            // NOT viaCookie: a bearer is attached deliberately by the client,
            // so no browser can be induced into sending it cross-origin.
            viaCookie: false,
          }
          applyRoleGates(request)
          enforceEmbedProjectTabs(request, opts.embedProjectTabs)
          return
        }
        throw authInvalid()
      }
    } else if (resolveSignedInPerson(app, request, reply, opts.userSessionCookie)) {
      // Signed in with a named account. Handled entirely inside the helper,
      // which attaches the principal and re-sends the cookie when the session
      // was extended. Nothing below this point applies: an account is not a
      // key, so there is no key row to touch and no key-shaped gate to run.
      applyRoleGates(request)
      assertSameOriginWrite(request)
      enforceEmbedProjectTabs(request, opts.embedProjectTabs)
      return
    } else if (anyUsersExist(app.db)) {
      // This install has accounts, so a request with no API key and no valid
      // session is simply not signed in. The older shared-password session is
      // deliberately NOT consulted here: once there are named accounts, a
      // shared password would hand everyone the authority of the root key and
      // quietly undo the roles that were just set up.
      throw authRequired()
    } else if (opts.resolveSessionApiKeyId && opts.sessionCookieName) {
      const sessionId = parseCookieHeader(request.headers.cookie)[opts.sessionCookieName]
      if (sessionId) {
        const apiKeyId = await opts.resolveSessionApiKeyId(sessionId)
        if (apiKeyId) {
          key = app.db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, apiKeyId))
            .get()
        }
      }

      if (!key || key.revokedAt) {
        throw authRequired()
      }
      keyArrivedInCookie = true
    } else {
      throw authRequired()
    }

    app.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, key.id))
      .run()

    // Attach the resolved key to the request so scope-gated routes can
    // inspect it without re-querying. `key.scopes` is a string[] from the
    // JSON column; the type assertion mirrors what Drizzle returns.
    const scopes = Array.isArray(key.scopes) ? key.scopes : []
    request.apiKey = { id: key.id, name: key.name, scopes, projectId: key.projectId ?? null }
    request.principal = {
      kind: 'api-key',
      id: key.id,
      name: key.name,
      scopes,
      projectId: key.projectId ?? null,
      viaCookie: keyArrivedInCookie,
    }

    assertSameOriginWrite(request)

    // Global read-only gate. A key that opted into read-only (`['read']`)
    // cannot perform any write — keyed off the HTTP method, NOT per-route
    // `requireScope` calls, so a newly added write route is protected
    // automatically. Safe methods (GET/HEAD/OPTIONS) always pass. This runs
    // after `shouldSkipAuth` (so public routes stay open) and does not gate
    // the `last_used_at` write above (infrastructural usage tracking).
    if (
      isReadOnlyKey(scopes) &&
      WRITE_METHODS.has(request.method) &&
      !isTransportEnvelopeRoute(request)
    ) {
      throw forbidden('This API key is read-only and cannot perform write operations.')
    }

    // The named ads scopes are delegated operator/approver grants. Keep a key
    // whose write capabilities are exclusively ads-related inside the
    // project's `/ads/*` surface even though older write routes still rely on
    // the historical read-only-vs-write classifier. Every ads mutation also
    // calls requireScope(), so the route and the key must agree in both
    // directions. Wildcard/root keys retain the existing full-instance access.
    if (
      isAdsMutationOnlyKey(scopes) &&
      WRITE_METHODS.has(request.method) &&
      !isAdsWriteRoute(url)
    ) {
      throw forbidden('This API key can only perform OpenAI Ads write operations.')
    }

    enforceEmbedProjectTabs(request, opts.embedProjectTabs)

    // Project-scope gate. A key bound to a single project (`project_id` set) may
    // only touch THAT project. The project name is the first `/projects/<name>`
    // path segment (the project-scoped routes are all mounted there); resolve it
    // and 403 on a mismatch. NULL project_id — every historical key — skips this
    // and keeps full-instance access. Routes that address an entity by id (e.g.
    // `/runs/:id`) are not in the URL; they call `assertProjectScope()` after
    // loading the entity's project.
    if (key.projectId) {
      const match = url.match(/\/projects\/([^/?#]+)/)
      if (match) {
        const projectName = decodeURIComponent(match[1]!)
        const scoped = app.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.name, projectName))
          .get()
        if (!scoped || scoped.id !== key.projectId) {
          throw forbidden('This API key is scoped to a different project.')
        }
      }
    }
  })
}
