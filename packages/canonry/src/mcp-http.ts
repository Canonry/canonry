import crypto from 'node:crypto'

import { isReadOnlyKey } from '@ainyc/canonry-contracts'
import { apiKeys, type DatabaseClient } from '@ainyc/canonry-db'
import { hashApiKey } from '@ainyc/canonry-api-routes'
import { eq } from 'drizzle-orm'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ApiClient } from './client.js'
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
  /** The api key id that created this session. A different key may not reuse it. */
  keyId: string
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
function mintSessionKey(db: DatabaseClient, scopes: readonly string[], userId: string): { id: string; raw: string } {
  const raw = `cnry_${crypto.randomBytes(24).toString('hex')}`
  const id = crypto.randomUUID()
  db.insert(apiKeys).values({
    id,
    name: `mcp-session:${userId}`,
    keyHash: hashApiKey(raw),
    keyPrefix: raw.slice(0, 9),
    scopes: [...scopes],
    createdAt: new Date().toISOString(),
  }).run()
  return { id, raw }
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
    keyId: string,
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
    // So an OAuth caller gets an EPHEMERAL API KEY minted for this session,
    // carrying the scopes already resolved above (the intersection of the
    // person's role and what they granted) and nothing more. It is revoked when
    // the session closes, so it cannot outlive the connection that justified it.
    // An api-key caller keeps using its own key, unchanged.
    let sessionKey: { id: string; raw: string } | null = null
    if (!request.apiKey && request.principal?.kind === 'user') {
      sessionKey = mintSessionKey(opts.db, scopes, request.principal.id)
    }
    const client = new ApiClient(opts.selfApiUrl, sessionKey?.raw ?? bearer, { skipProbe: true })
    const server = createCanonryMcpServer({
      scope: segment.readOnly || isReadOnlyKey(scopes) ? 'read-only' : 'all',
      tiers: segment.tiers,
      clientFactory: () => client,
    })

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, close, keyId, segmentId: segment.id, lastSeenAt: now() })
      },
    })

    async function close(): Promise<void> {
      await transport.close()
      await server.close()
      // Revoke before anything else can fail: an ephemeral key that outlives
      // its session is a credential nobody is watching.
      if (sessionKey) revokeSessionKey(opts.db, sessionKey.id)
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

    await server.connect(transport)
    return { transport, close, keyId, segmentId: segment.id, lastSeenAt: now() }
  }

  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    segment: Segment,
  ): Promise<void> {
    const keyId = request.principal?.id ?? request.apiKey?.id
    if (!keyId) {
      // The onSend hook above attaches the RFC 9728 challenge to any 401 on
      // this route, including this one. Reachable only when auth is skipped
      // entirely, since otherwise the auth hook rejects before we get here.
      await reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } })
      return
    }

    const sessionId = request.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined

    if (existing) {
      // A session belongs to the credential that opened it. Without this a
      // leaked session id would let any authenticated caller ride another
      // caller's server — including its tool scope.
      if (existing.keyId !== keyId || existing.segmentId !== segment.id) {
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

    const opened = await openSession(request, keyId, segment)
    if (!opened) {
      await reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } })
      return
    }
    await opened.transport.handleRequest(request.raw, reply.raw, request.body)
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
