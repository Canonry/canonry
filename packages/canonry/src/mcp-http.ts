import crypto from 'node:crypto'
import { isIP } from 'node:net'

import { forbidden, isReadOnlyKey, McpTransportStatuses, HostedMcpStatuses, HostedMcpUnavailableReasons, type McpHealth, type HostedMcpHealth } from '@canonry/canonry-contracts'
import { apiKeys, dashboardSessions, type DatabaseClient } from '@canonry/canonry-db'
import { hashApiKey, blockedAddressReason, stripIpv6Brackets, MCP_DELEGATED_KEY_MAX_AGE_MS } from '@canonry/canonry-api-routes'
import { and, eq, isNull } from 'drizzle-orm'
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node'
import { McpServer, createMcpHandler, isInitializeRequest, isLegacyRequest } from '@modelcontextprotocol/server'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ApiClient, type ServerUpdateAvailable } from './client.js'
import { PACKAGE_VERSION } from './package-version.js'
import { createCanonryMcpServer } from './mcp/server.js'
import { CANONRY_MCP_TIERS, CANONRY_MCP_TOOLKIT_NAMES, type CanonryMcpTier } from './mcp/toolkits.js'

/**
 * MCP over Streamable HTTP.
 *
 * The stdio adapter puts one server in one process for one user, so identity
 * and lifetime come free. Over HTTP neither does, and the two facts that shape
 * everything here are:
 *
 * 1. The dynamic tool catalog is PER SERVER INSTANCE — enabling a toolkit
 *    mutates it. One shared server would leak one caller's tool state into
 *    every other caller's session, so there is one McpServer and one transport
 *    per legacy session, pinned to the key that created it. Modern requests
 *    get a fresh server and retire their authority when their response ends.
 * 2. Nothing reaps an HTTP session. A client that goes away without DELETE
 *    leaves its server behind forever, so the idle sweep below is not a
 *    refinement — without it the process leaks until it dies.
 *
 * Mounted through `registerAuthenticatedRoutes`, so it lands INSIDE the
 * api-routes plugin scope and the auth hook actually runs. Registering it on
 * the root app instead would serve MCP with no authentication at all; that is
 * not theoretical, it is what a test doing exactly that produced.
 */

/** Idle sessions are dropped after this long without a request. */
const SESSION_IDLE_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000
const MAX_CLEANUP_RETRIES_PER_SWEEP = 8
const MAX_PENDING_KEY_RETIREMENTS = 256
const MAX_CLEANUP_BACKOFF_MS = 10 * 60 * 1000

interface SessionKey { id: string; raw: string; expiresAt: number }
interface PendingRetirement { remove: boolean; expiresAt: number; nextAttemptAt: number; attempts: number }

/**
 * One endpoint's fixed surface.
 *
 * `readOnly` forces stored reads and the matching client policy even for a
 * wildcard key, so `/readonly` is an executable restriction. It
 * can only ever narrow: a read-only KEY still gets a read-only catalog on a
 * non-readonly path.
 */
interface Segment {
  id: string
  tiers: readonly CanonryMcpTier[]
  readOnly: boolean
}

interface McpSession {
  transport: NodeStreamableHTTPServerTransport
  close: () => Promise<void>
  /** Fingerprint of the bearer and effective authority that opened this session. */
  authorizationId: string
  /** The endpoint that opened it. A session may not be replayed against a wider segment. */
  segmentId: string
  /** OAuth-derived key lifetime also bounds otherwise idle transports. */
  sessionKeyId?: string
  expiresAt?: number
  lastSeenAt: number
}

/**
 * Mint a short-lived api key for one MCP session.
 *
 * Not a general-purpose key: it is named for the session, scoped to exactly the
 * authority already resolved for the caller, and revoked on close.
 */
function mintSessionKey(db: DatabaseClient, scopes: readonly string[], userId: string, oauthGrantId: string, createdAt: number): SessionKey {
  const raw = `cnry_${crypto.randomBytes(24).toString('hex')}`
  const id = crypto.randomUUID()
  db.insert(apiKeys).values({
    id,
    name: `mcp-session:${userId}`,
    keyHash: hashApiKey(raw),
    keyPrefix: raw.slice(0, 9),
    scopes: [...scopes],
    delegatedUserId: userId,
    delegatedOAuthGrantId: oauthGrantId,
    createdAt: new Date(createdAt).toISOString(),
  }).run()
  return { id, raw, expiresAt: createdAt + MCP_DELEGATED_KEY_MAX_AGE_MS }
}


export interface McpHttpOptions {
  /** Base URL the per-session client calls back on — loopback, not the public host. */
  selfApiUrl: string
  /** Needed to mint and revoke the per-session key for OAuth callers. */
  db: DatabaseClient
  /**
   * Public origin this instance is reached on. Used only to point an
   * unauthenticated caller at its RFC 9728 discovery document. Omitted when the
   * instance has no OAuth server, in which case no challenge is advertised.
   */
  issuer?: string
  /** Overridable for tests. */
  now?: () => number
  /** Newer-release notice for hosted sessions (initialize + `canonry_help`). Must not block. */
  getUpdateAvailable?: () => ServerUpdateAvailable | null
}

/**
 * Every path this transport mounts, relative to the api prefix. Exported so the
 * OAuth server publishes one protected-resource document per segment — a 401
 * from `/mcp/x/gsc` names its own metadata URL, and that URL must resolve.
 */
export function mcpTransportPaths(): string[] {
  const paths = ['/mcp', '/mcp/readonly']
  for (const toolkit of CANONRY_MCP_TOOLKIT_NAMES) {
    paths.push(`/mcp/x/${toolkit}`, `/mcp/x/${toolkit}/readonly`)
  }
  return paths
}

/** Read registered routes only: health polling must not open MCP sessions or run tools. */
export function mcpHttpHealth(app: FastifyInstance, apiPrefix: string, hosted?: {
  publicUrl?: string
  hasAccounts: boolean
  authorizationPath: string
}): McpHealth {
  const available = mcpTransportPaths().every(path =>
    (['POST', 'GET', 'DELETE'] as const).every(method => app.hasRoute({ method, url: `${apiPrefix}${path}` })),
  )
  const status = available ? McpTransportStatuses.available : McpTransportStatuses.unavailable
  if (!hosted) return { status }

  const unavailable = (reason: Extract<HostedMcpHealth, { status: typeof HostedMcpStatuses.unavailable }>['reason']): McpHealth => ({
    status, hosted: { status: HostedMcpStatuses.unavailable, reason },
  })
  if (!available) return unavailable(HostedMcpUnavailableReasons['transport-unavailable'])
  if (!hosted.publicUrl) return unavailable(HostedMcpUnavailableReasons['public-url-required'])
  let publicUrl: URL
  try {
    publicUrl = new URL(hosted.publicUrl)
  } catch {
    return unavailable(HostedMcpUnavailableReasons['public-url-required'])
  }
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    return unavailable(HostedMcpUnavailableReasons['public-url-required'])
  }
  if (publicUrl.protocol !== 'https:') return unavailable(HostedMcpUnavailableReasons['https-required'])
  const hostname = stripIpv6Brackets(publicUrl.hostname).toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || (isIP(hostname) !== 0 ? blockedAddressReason(hostname) !== null : !hostname.includes('.'))) {
    return unavailable(HostedMcpUnavailableReasons['public-host-required'])
  }
  const publicBasePath = publicUrl.pathname.replace(/\/$/, '')
  const mountedBasePath = apiPrefix.slice(0, -'/api/v1'.length)
  if (publicBasePath !== mountedBasePath) return unavailable(HostedMcpUnavailableReasons['public-path-mismatch'])
  const oauthRoutes = [
    ['GET', hosted.authorizationPath],
    ['POST', hosted.authorizationPath],
    ['POST', `${hosted.authorizationPath}/consent`],
    ['POST', '/oauth/token'],
    ['POST', '/oauth/register'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', `/.well-known/oauth-protected-resource${apiPrefix}/mcp`],
  ] as const
  if (!oauthRoutes.every(([method, url]) => app.hasRoute({ method, url }))) {
    return unavailable(HostedMcpUnavailableReasons['oauth-unavailable'])
  }
  if (!hosted.hasAccounts) return unavailable(HostedMcpUnavailableReasons['account-required'])
  // Configuration readiness only. DNS, TLS, proxy reachability and the client's
  // authorization are verified by the client making a successful stored read.
  return { status, hosted: { status: HostedMcpStatuses.ready, url: `${publicUrl.origin}${apiPrefix}/mcp` } }
}

export function registerMcpHttpRoutes(scope: FastifyInstance, opts: McpHttpOptions): void {
  const sessions = new Map<string, McpSession>()
  const legacyServers = new Set<McpSession>()
  const modernExchanges = new Set<{ sessionKey?: SessionKey; close: () => Promise<void> }>()
  const now = opts.now ?? (() => Date.now())
  const pendingKeyRetirements = new Map<string, PendingRetirement>()
  let shuttingDown = false

  // Cleanup must never wait behind a writer. This scope is synchronous, so the
  // connection's exact busy policy is restored before other work can run.
  function withoutLockWait<T>(work: () => T): T {
    const timeout = opts.db.$client.pragma('busy_timeout', { simple: true }) as number
    try {
      opts.db.$client.pragma('busy_timeout = 0')
      return work()
    } finally {
      opts.db.$client.pragma(`busy_timeout = ${timeout}`)
    }
  }

  function attemptKeyRetirement(id: string, remove: boolean): boolean {
    try {
      withoutLockWait(() => {
        opts.db.transaction(tx => {
          tx.delete(dashboardSessions).where(eq(dashboardSessions.apiKeyId, id)).run()
          tx.update(apiKeys).set({ revokedAt: new Date(now()).toISOString() })
            .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).run()
        })
        if (remove) {
          try {
            opts.db.delete(apiKeys).where(eq(apiKeys.id, id)).run()
          } catch (error) {
            // Durable audit references may require the revoked identity to remain.
            scope.log.warn({ err: error, keyId: id }, 'Retained revoked MCP request key after deletion failed')
          }
        }
      })
      return true
    } catch (error) {
      scope.log.error({ err: error, keyId: id }, 'Failed to retire MCP key; cleanup remains bounded by its expiry')
      return false
    }
  }

  function retireSessionKey(key: SessionKey, remove = false): void {
    const queued = pendingKeyRetirements.get(key.id)
    if (queued) {
      queued.remove ||= remove
      return
    }
    if (attemptKeyRetirement(key.id, remove)) return
    if (pendingKeyRetirements.size >= MAX_PENDING_KEY_RETIREMENTS) {
      const oldest = pendingKeyRetirements.keys().next().value
      if (oldest !== undefined) pendingKeyRetirements.delete(oldest)
      scope.log.warn('MCP cleanup queue is full; oldest credential remains bounded by its expiry')
    }
    pendingKeyRetirements.set(key.id, { remove, expiresAt: key.expiresAt, nextAttemptAt: now() + SWEEP_INTERVAL_MS, attempts: 1 })
  }

  function retryKeyRetirements(): void {
    let attempted = 0
    for (const [id, queued] of pendingKeyRetirements) {
      if (queued.expiresAt <= now()) {
        pendingKeyRetirements.delete(id)
        continue
      }
      if (queued.nextAttemptAt > now()) continue
      if (attempted++ >= MAX_CLEANUP_RETRIES_PER_SWEEP) break
      if (attemptKeyRetirement(id, queued.remove)) pendingKeyRetirements.delete(id)
      else {
        queued.nextAttemptAt = now() + Math.min(SWEEP_INTERVAL_MS * 2 ** queued.attempts, MAX_CLEANUP_BACKOFF_MS)
        queued.attempts++
      }
    }
  }

  async function dropSession(id: string): Promise<void> {
    await sessions.get(id)?.close().catch(error => scope.log.error({ err: error }, 'Failed to close legacy MCP session'))
  }

  const sweep = setInterval(() => {
    try {
      retryKeyRetirements()
      withoutLockWait(() => {
        const cutoff = now() - SESSION_IDLE_MS
        for (const session of legacyServers) {
          const key = session.sessionKeyId ? opts.db.select({ revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.id, session.sessionKeyId)).get() : undefined
          if (session.lastSeenAt < cutoff || (session.expiresAt !== undefined && session.expiresAt <= now()) || (session.sessionKeyId && (!key || key.revokedAt))) {
            void session.close().catch(error => scope.log.error({ err: error }, 'Failed to close expired MCP session'))
          }
        }
        for (const exchange of modernExchanges) {
          if (!exchange.sessionKey) continue
          const key = opts.db.select({ revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.id, exchange.sessionKey.id)).get()
          if (!key || key.revokedAt || exchange.sessionKey.expiresAt <= now()) {
            void exchange.close().catch(error => scope.log.error({ err: error }, 'Failed to close expired MCP request'))
          }
        }
      })
    } catch (error) {
      scope.log.error({ err: error }, 'MCP lifecycle sweep failed; will retry on the next interval')
    }
  }, SWEEP_INTERVAL_MS)
  sweep.unref()

  // The auth hook rejects an unauthenticated request BEFORE any handler runs,
  // so the RFC 9728 challenge cannot be set inside `handle`. Attach it on the
  // way out instead, narrowed to this transport's own routes by the config flag
  // rather than by matching on the URL.
  if (opts.issuer) {
    scope.addHook('onSend', async (request, reply, payload) => {
      const isTransport = request.routeOptions.config?.transportEnvelope === true
      if (isTransport && reply.statusCode === 401 && !reply.getHeader('WWW-Authenticate')) {
        const metadata = `${opts.issuer}/.well-known/oauth-protected-resource${request.routeOptions.url ?? ''}`
        void reply.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`)
      }
      return payload
    })
  }

  scope.addHook('preClose', async () => {
    shuttingDown = true
    clearInterval(sweep)
    await Promise.all([...legacyServers].map(session => session.close().catch(error => scope.log.error({ err: error }, 'Failed to close MCP session during shutdown'))))
    await Promise.all([...modernExchanges].map(exchange => exchange.close().catch(error => scope.log.error({ err: error }, 'Failed to close MCP request during shutdown'))))
    retryKeyRetirements()
    if (pendingKeyRetirements.size > 0) {
      scope.log.warn({ count: pendingKeyRetirements.size }, 'MCP credential cleanup remains pending at shutdown; credentials remain bounded by expiry')
    }
  })

  /**
   * The caller's OWN bearer, taken from the header rather than from
   * `request.apiKey` — auth stores only the hash, and the instance's default
   * key carries scopes ['*']. Reusing that key here would silently upgrade a
   * read-only caller to full write access on every tool call.
   */
  function callerBearer(request: FastifyRequest): string | null {
    const header = request.headers.authorization
    if (typeof header !== 'string') return null
    // Parsed with string ops rather than a regex: `/^Bearer\s+(.+)$/` lets the
    // quantifiers exchange characters and backtrack super-linearly, and this
    // runs on an attacker-supplied header on every request.
    const trimmed = header.trim()
    const prefix = 'bearer '
    if (trimmed.length <= prefix.length) return null
    if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return null
    return trimmed.slice(prefix.length).trim() || null
  }

  function createAuthorizedServer(
    request: FastifyRequest,
    segment: Segment,
    bearer: string,
    signal?: AbortSignal,
    modern = false,
    needsApiCredential = true,
  ) {
    if (shuttingDown) throw new Error('MCP server is shutting down')
    // The surface is narrowed HERE, when the connection opens, by the endpoint
    // that was dialled and the credential that was presented. Never at runtime:
    // the MCP spec states a tool set "MUST NOT vary per-connection or as a side
    // effect of other requests on the connection", and equally that it MAY vary
    // "by the authorization presented on the request".
    //
    // Progressive discovery (canonry_load_toolkit) stays the stdio default and
    // is deliberately NOT used here. Not because the notification cannot be
    // delivered — it can, if it carries relatedRequestId — but because the
    // hosts do not act on it: ChatGPT freezes the tool list at admin approval
    // so a runtime-loaded tool is never callable, Claude delivers the
    // notification and ignores it, and Gemini Enterprise requires an admin to
    // re-import actions by hand.
    const scopes = request.principal?.scopes ?? request.apiKey?.scopes ?? []

    // THE INNER HOP NEEDS A CREDENTIAL THAT WORKS ON REST ROUTES.
    //
    // Every tool call re-enters the API over HTTP as an ordinary request. An
    // OAuth access token is deliberately confined to the transport route and is
    // refused everywhere else, so handing it to this client made every single
    // tool call fail with AUTH_INVALID while initialize and tools/list looked
    // perfectly healthy — the feature was unusable for exactly the hosted
    // clients it exists to serve.
    //
    // An OAuth caller gets an ephemeral API key for this serving unit,
    // carrying the scopes already resolved above (the intersection of the
    // person's role and what they granted) and nothing more. It is revoked when
    // the session or modern request closes, so it cannot outlive its authority.
    // An api-key caller keeps using its own key, unchanged.
    let sessionKey: SessionKey | null = null
    if (needsApiCredential && !request.apiKey && request.principal?.kind === 'user') {
      if (!request.principal.oauthGrantId) throw forbidden('MCP OAuth credentials require an active authorization grant.')
      sessionKey = mintSessionKey(opts.db, segment.readOnly ? ['read'] : scopes, request.principal.id, request.principal.oauthGrantId, now())
    }
    const client = new ApiClient(opts.selfApiUrl, sessionKey?.raw ?? bearer, {
      skipProbe: true,
      storedOnly: segment.readOnly,
      signal,
      clientName: `canonry-mcp/${PACKAGE_VERSION}`,
      surface: 'mcp-http',
      // Correlation only: this is never accepted as caller identity or authority.
      ...(modern ? {} : { actorSession: crypto.randomUUID() }),
    })
    let server: ReturnType<typeof createCanonryMcpServer>
    try {
      server = createCanonryMcpServer({
        scope: segment.readOnly ? 'stored-only' : isReadOnlyKey(scopes) ? 'read-only' : 'all',
        credentialScopes: scopes,
        operator: request.operatorAccess === true,
        connectionProfile: Boolean(opts.issuer && !request.principal?.projectId
          && (request.principal?.kind === 'user' || request.principal?.delegatedUser)
          && scopes.some(scope => scope === 'read' || scope === '*')),
        tiers: segment.tiers,
        clientFactory: () => client,
        updateAvailable: opts.getUpdateAvailable,
      })
      // Hosted catalogs do not change during a connection or publish events.
      server.server.registerCapabilities({ tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } })
    } catch (error) {
      if (sessionKey) retireSessionKey(sessionKey, modern)
      throw error
    }

    return { server, sessionKey }
  }

  async function openSession(
    request: FastifyRequest,
    authorizationId: string,
    segment: Segment,
  ): Promise<McpSession | null> {
    const bearer = callerBearer(request)
    if (!bearer) return null
    const { server, sessionKey } = createAuthorizedServer(request, segment, bearer)

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string) => {
        if (!shuttingDown && !closing) sessions.set(id, session)
      },
    })
    let closing: Promise<void> | undefined
    const session: McpSession = { transport, close, authorizationId, segmentId: segment.id, sessionKeyId: sessionKey?.id, expiresAt: sessionKey?.expiresAt, lastSeenAt: now() }
    legacyServers.add(session)

    function close(): Promise<void> {
      if (closing) return closing
      closing = Promise.resolve().then(async () => {
        if (sessionKey) retireSessionKey(sessionKey)
        const id = transport.sessionId
        if (id) sessions.delete(id)
        try {
          await transport.close()
        } finally {
          try {
            await server.close()
          } finally {
            legacyServers.delete(session)
          }
        }
      })
      return closing
    }

    transport.onclose = () => {
      void close().catch(error => scope.log.error({ err: error }, 'Failed to close legacy MCP transport'))
    }

    try {
      await server.connect(transport)
    } catch (error) {
      await close().catch(() => {})
      throw error
    }
    return session
  }

  async function handleModern(
    request: FastifyRequest,
    reply: FastifyReply,
    segment: Segment,
    bearer: string,
  ): Promise<void> {
    const abort = new AbortController()
    let closing: Promise<void> | undefined
    const exchange: { sessionKey?: SessionKey; close: () => Promise<void> } = {
      close: () => {
        if (closing) return closing
        abort.abort()
        if (exchange.sessionKey) retireSessionKey(exchange.sessionKey, true)
        modernExchanges.delete(exchange)
        closing = handler.close().catch(error => {
          scope.log.error({ err: error }, 'Failed to close MCP request transport')
          throw error
        })
        return closing
      },
    }
    // The SDK validates the modern envelope and mirrored headers before calling
    // this factory. Each request captures only its own authenticated principal.
    const reportError = (error: Error) => scope.log.error({ err: error }, 'Modern MCP request failed')
    const handler = createMcpHandler(({ requestInfo }) => {
      if (shuttingDown) throw new Error('MCP server is shutting down')
      const body = request.body as { method?: unknown } | null
      const method = body && typeof body === 'object' ? body.method : undefined
      if (method === 'subscriptions/listen') {
        // No hosted catalog events exist. The SDK acknowledges an empty honored
        // set and completes immediately; no catalog, credential or stream remains.
        return new McpServer({ name: 'canonry', version: PACKAGE_VERSION })
      }
      const signal = requestInfo ? AbortSignal.any([abort.signal, requestInfo.signal]) : abort.signal
      const opened = createAuthorizedServer(request, segment, bearer, signal, true, method === 'tools/call')
      exchange.sessionKey = opened.sessionKey ?? undefined
      return opened.server
    }, { legacy: 'reject', onerror: reportError })
    modernExchanges.add(exchange)
    try {
      // This resolves after the response body has drained or the client cancels,
      // not merely when handler.fetch produces a Response with a live stream.
      await toNodeHandler(handler, { onerror: reportError })(request.raw, reply.raw, request.body)
    } finally {
      await exchange.close()
    }
  }

  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    segment: Segment,
  ): Promise<void> {
    if (shuttingDown) {
      await reply.status(503).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP server is shutting down.' } })
      return
    }
    const principal = request.principal ?? request.apiKey
    const bearer = callerBearer(request)
    if (!principal || !bearer) {
      // The onSend hook above attaches the RFC 9728 challenge to any 401 on
      // this route, including this one. Reachable only when auth is skipped
      // entirely, since otherwise the auth hook rejects before we get here.
      await reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } })
      return
    }

    // A research-only grant is not a read grant. Never manufacture read
    // authority while narrowing the internal credential for this endpoint.
    if (segment.readOnly && !request.apiKey && request.principal?.kind === 'user'
      && !principal.scopes.some(scope => scope === 'read' || scope === '*')) {
      throw forbidden('The hosted read-only MCP endpoint requires the "read" scope.')
    }

    // Use the SDK's body-first classifier: a malformed modern claim must stay
    // on the modern validation path, never fall back into a legacy session.
    const webRequest = await toWebRequest(request.raw, request.body)
    const legacy = await isLegacyRequest(webRequest, request.body)
    if (shuttingDown) {
      await reply.status(503).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP server is shutting down.' } })
      return
    }
    if (!legacy) {
      await handleModern(request, reply, segment, bearer)
      return
    }

    // OAuth principal IDs identify people, not grants. Bind the actual bearer
    // AND its current effective authority so another token for the same person
    // cannot reuse the stronger internal credential captured by this session.
    // Refreshes and scope/project changes require a new initialize (404 below).
    // Store only a fingerprint, never another copy of the raw bearer.
    const authorizationId = hashApiKey(JSON.stringify({
      bearerHash: hashApiKey(bearer),
      kind: request.principal?.kind ?? 'api-key',
      id: principal.id,
      scopes: [...new Set(principal.scopes)].sort(),
      projectId: principal.projectId ?? null,
      operator: request.operatorAccess === true,
    }))

    const sessionId = request.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined

    if (existing) {
      if (existing.expiresAt !== undefined && existing.expiresAt <= now() && typeof sessionId === 'string') {
        await dropSession(sessionId)
        await reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown MCP session.' } })
        return
      }
      // A session belongs to the credential that opened it. Without this a
      // leaked session id would let any authenticated caller ride another
      // caller's server — including its tool scope.
      if (existing.authorizationId !== authorizationId || existing.segmentId !== segment.id) {
        await reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown MCP session.' } })
        return
      }
      existing.lastSeenAt = now()
      await existing.transport.handleRequest(request.raw, reply.raw, request.body)
      return
    }

    if (typeof sessionId === 'string') {
      // Named a session we do not have: expired, reaped, or from another
      // process. 404 is what tells a client to re-initialize.
      await reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown MCP session.' } })
      return
    }

    // No credential or catalog should be created for a request that cannot
    // open a session. In particular, GET/DELETE and pre-initialize tool calls
    // used to mint OAuth keys that never entered the idle/shutdown registry.
    if (request.method !== 'POST' || !isInitializeRequest(request.body)) {
      await reply.status(400).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Expected an initialize request.' }, id: null })
      return
    }
    const opened = await openSession(request, authorizationId, segment)
    if (!opened) {
      await reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } })
      return
    }
    if (shuttingDown) {
      await opened.close()
      await reply.status(503).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP server is shutting down.' } })
      return
    }
    let handled = false
    try {
      await opened.transport.handleRequest(request.raw, reply.raw, request.body)
      handled = true
    } finally {
      // A valid JSON-RPC initialize can still fail HTTP content negotiation or
      // transport validation. Only an initialized, registered session owns its
      // resources beyond this request; every failed attempt is closed here.
      const openedId = opened.transport.sessionId
      if (!handled || reply.raw.statusCode >= 400 || openedId === undefined || !sessions.has(openedId)) {
        if (openedId !== undefined) sessions.delete(openedId)
        await opened.close().catch(() => {})
      }
    }
  }

  // `transportEnvelope` exempts the JSON-RPC envelope from the method-based
  // read-only gate — a read is carried inside a POST here. It admits the
  // envelope only: every tool call re-enters the API as a fresh authenticated
  // request carrying this same bearer, so the read-only, ads and project gates
  // all re-apply per operation.
  const config = { transportEnvelope: true } as const

  function mount(pathname: string, segment: Segment): void {
    // POST carries requests, GET opens the optional SSE stream, DELETE ends the
    // session. All three are the same handler over the same segment.
    const run = (request: FastifyRequest, reply: FastifyReply) => handle(request, reply, segment)
    scope.post(pathname, { config }, run)
    scope.get(pathname, { config }, run)
    scope.delete(pathname, { config }, run)
  }

  // The directory, resolved by URL. Each endpoint is a fixed surface: stable
  // across the whole connection, so hosts can import the full default catalog
  // once. Specialist endpoints remain available for clients that prefer a
  // smaller catalog. Credential and endpoint read-only filtering still apply.
  mount('/mcp', { id: 'default', tiers: CANONRY_MCP_TIERS, readOnly: false })
  mount('/mcp/readonly', { id: 'default:ro', tiers: CANONRY_MCP_TIERS, readOnly: true })
  for (const toolkit of CANONRY_MCP_TOOLKIT_NAMES) {
    // `core` rides along with every toolkit: it carries project lookup and
    // search, without which a toolkit's tools have nothing to aim at.
    const tiers: readonly CanonryMcpTier[] = ['core', toolkit]
    mount(`/mcp/x/${toolkit}`, { id: toolkit, tiers, readOnly: false })
    mount(`/mcp/x/${toolkit}/readonly`, { id: `${toolkit}:ro`, tiers, readOnly: true })
  }
}
