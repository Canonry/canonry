import crypto from 'node:crypto'

import { authInvalid, intersectScopes, isReadOnlyKey, UserStatuses, userRoleScopes, type McpHealth } from '@ainyc/canonry-contracts'
import { apiKeys, users, type DatabaseClient } from '@ainyc/canonry-db'
import { hashApiKey } from '@ainyc/canonry-api-routes'
import { eq } from 'drizzle-orm'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ApiClient } from './client.js'
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
 *    per session, and a session is pinned to the key that created it.
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

/**
 * One endpoint's fixed surface.
 *
 * `readOnly` forces the read-only catalog even for a wildcard key, so a
 * `/readonly` URL is a genuine guarantee rather than a naming convention. It
 * can only ever narrow: a read-only KEY still gets a read-only catalog on a
 * non-readonly path.
 */
interface Segment {
  id: string
  tiers: readonly CanonryMcpTier[]
  readOnly: boolean
}

interface McpSession {
  transport: StreamableHTTPServerTransport
  close: () => Promise<void>
  /** Fingerprint of the bearer and effective authority that opened this session. */
  authorizationId: string
  /** The endpoint that opened it. A session may not be replayed against a wider segment. */
  segmentId: string
  lastSeenAt: number
}

/**
 * Mint a short-lived api key for one MCP session.
 *
 * Not a general-purpose key: it is named for the session, scoped to exactly the
 * authority already resolved for the caller, and revoked on close.
 */
function mintSessionKey(
  db: DatabaseClient,
  requestedScopes: readonly string[],
  userId: string,
): { id: string; raw: string; scopes: string[] } | null {
  const raw = `cnry_${crypto.randomBytes(24).toString('hex')}`
  const id = crypto.randomUUID()
  return db.transaction((tx) => {
    // Authorize against the row at issuance time. This closes the interval
    // between OAuth/session authentication and minting the inner REST key.
    const user = tx.select().from(users).where(eq(users.id, userId)).get()
    if (!user || user.status !== UserStatuses.active) return null
    const scopes = intersectScopes(userRoleScopes(user.role), requestedScopes)
    tx.insert(apiKeys).values({
      id,
      name: `mcp-session:${userId}`,
      keyHash: hashApiKey(raw),
      keyPrefix: raw.slice(0, 9),
      scopes,
      delegatedUserId: userId,
      delegatedUserAuthVersion: user.authVersion,
      createdAt: new Date().toISOString(),
    }).run()
    return { id, raw, scopes }
  })
}

function revokeSessionKey(db: DatabaseClient, id: string): void {
  try {
    db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, id)).run()
  } catch {
    // A revoked-or-gone key is the desired end state either way.
  }
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
export function mcpHttpHealth(app: FastifyInstance, apiPrefix: string): McpHealth {
  const available = mcpTransportPaths().every(path =>
    (['POST', 'GET', 'DELETE'] as const).every(method => app.hasRoute({ method, url: `${apiPrefix}${path}` })),
  )
  return { status: available ? 'available' : 'unavailable' }
}

export function registerMcpHttpRoutes(scope: FastifyInstance, opts: McpHttpOptions): void {
  const sessions = new Map<string, McpSession>()
  const now = opts.now ?? (() => Date.now())

  async function dropSession(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    await session.close().catch(() => {
      // A transport that already tore itself down is the normal case here.
    })
  }

  const sweep = setInterval(() => {
    const cutoff = now() - SESSION_IDLE_MS
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < cutoff) void dropSession(id)
    }
  }, SWEEP_INTERVAL_MS)
  // Never hold the process open for a housekeeping timer.
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

  scope.addHook('onClose', async () => {
    clearInterval(sweep)
    await Promise.all([...sessions.keys()].map(id => dropSession(id)))
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

  async function openSession(
    request: FastifyRequest,
    authorizationId: string,
    segment: Segment,
  ): Promise<McpSession | null> {
    const bearer = callerBearer(request)
    if (!bearer) return null

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
    let scopes = request.principal?.scopes ?? request.apiKey?.scopes ?? []

    // THE INNER HOP NEEDS A CREDENTIAL THAT WORKS ON REST ROUTES.
    //
    // Every tool call re-enters the API over HTTP as an ordinary request. An
    // OAuth access token is deliberately confined to the transport route and is
    // refused everywhere else, so handing it to this client made every single
    // tool call fail with AUTH_INVALID while initialize and tools/list looked
    // perfectly healthy — the feature was unusable for exactly the hosted
    // clients it exists to serve.
    //
    // So an OAuth caller gets an EPHEMERAL API KEY minted for this session,
    // carrying the scopes already resolved above (the intersection of the
    // person's role and what they granted) and nothing more. It is revoked when
    // the session closes, so it cannot outlive the connection that justified it.
    // An api-key caller keeps using its own key, unchanged.
    let sessionKey: { id: string; raw: string; scopes: string[] } | null = null
    if (!request.apiKey && request.principal?.kind === 'user') {
      sessionKey = mintSessionKey(opts.db, scopes, request.principal.id)
      if (!sessionKey) {
        throw authInvalid()
      }
      // The nested REST client must use the capabilities calculated from the
      // user row inside the mint transaction, not a role snapshot captured
      // before a concurrent demotion.
      scopes = sessionKey.scopes
    }
    const client = new ApiClient(opts.selfApiUrl, sessionKey?.raw ?? bearer, {
      skipProbe: true,
      clientName: `canonry-mcp/${PACKAGE_VERSION}`,
      // Correlation only: this is never accepted as caller identity or authority.
      actorSession: crypto.randomUUID(),
    })
    let server: ReturnType<typeof createCanonryMcpServer>
    try {
      server = createCanonryMcpServer({
        scope: segment.readOnly || isReadOnlyKey(scopes) ? 'read-only' : 'all',
        credentialScopes: scopes,
        tiers: segment.tiers,
        clientFactory: () => client,
      })
    } catch (error) {
      if (sessionKey) revokeSessionKey(opts.db, sessionKey.id)
      throw error
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, close, authorizationId, segmentId: segment.id, lastSeenAt: now() })
      },
    })

    async function close(): Promise<void> {
      // Revocation must survive a transport/server cleanup failure.
      if (sessionKey) revokeSessionKey(opts.db, sessionKey.id)
      try {
        await transport.close()
      } finally {
        await server.close()
      }
    }

    transport.onclose = () => {
      const id = transport.sessionId
      if (id) sessions.delete(id)
      // ALSO revoke here, not only in close(). A client-initiated DELETE closes
      // the transport directly and fires this, never routing through close() —
      // so revoking only there leaked a live credential on every well-behaved
      // client that ended its own session. Revoking twice is harmless.
      if (sessionKey) revokeSessionKey(opts.db, sessionKey.id)
    }

    try {
      await server.connect(transport)
    } catch (error) {
      await close().catch(() => {})
      throw error
    }
    return { transport, close, authorizationId, segmentId: segment.id, lastSeenAt: now() }
  }

  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    segment: Segment,
  ): Promise<void> {
    const principal = request.principal ?? request.apiKey
    const bearer = callerBearer(request)
    if (!principal || !bearer) {
      // The onSend hook above attaches the RFC 9728 challenge to any 401 on
      // this route, including this one. Reachable only when auth is skipped
      // entirely, since otherwise the auth hook rejects before we get here.
      await reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } })
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
    }))

    const sessionId = request.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined

    if (existing) {
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
