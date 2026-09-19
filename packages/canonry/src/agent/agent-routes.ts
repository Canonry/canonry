import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  agentSessions,
  parseJsonColumn,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  AGENT_MEMORY_VALUE_MAX_BYTES,
  MemorySources,
  agentMemoryDeleteRequestSchema,
  agentMemoryUpsertRequestSchema,
  notFound,
  validationError,
  type AgentMemoryListResponse,
  describeError,
  UserRoles,
  WILDCARD_SCOPE,
} from '@ainyc/canonry-contracts'
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
import { requireAdminSession } from '@ainyc/canonry-api-routes'
import type { SessionRegistry } from './session-registry.js'
import type { SupportedAgentProvider } from './session.js'
import {
  AeroToolProfiles,
  AeroToolScopes,
  isAeroToolProfile,
  type AeroToolProfile,
  type AeroToolScope,
} from './tools.js'
import { buildAgentProvidersResponse } from './providers.js'
import {
  COMPACTION_KEY_PREFIX,
  deleteMemoryEntry,
  listMemoryEntries,
  upsertMemoryEntry,
} from './memory-store.js'

type AgentPromptBody = Partial<{
  prompt: string
  provider?: SupportedAgentProvider
  modelId?: string
  scope?: AeroToolScope
  profile?: AeroToolProfile
}>

export interface AgentRoutesOptions {
  db: DatabaseClient
  sessionRegistry: SessionRegistry
}

/**
 * Fields pi-agent-core stamps onto a persisted assistant message that disclose
 * which model answered: the model id, the vendor, the transport (whose name
 * embeds a vendor), and the usage block, which carries per-turn cost.
 */
const MESSAGE_PROVENANCE_FIELDS = ['model', 'provider', 'api', 'usage'] as const

/**
 * Whether this caller may learn which provider and model sit behind Aero.
 *
 * Separate from `requireAdminSession`, which answers a different question.
 * That gate refuses signed-in VIEWERS, but it passes every API key, because a
 * key carries no role at all. So a narrow key — read-only, or confined to one
 * project — still reaches these reads. Such a key is authorized to read the
 * project; it was never handed the operator's choice of model, nor what a turn
 * costs them.
 *
 * Admin means: a signed-in administrator (directly, or behind a delegated
 * credential), or the install's own full-instance wildcard key, which is what
 * `canonry init` writes and what the CLI and MCP present. A request with no
 * principal at all is the un-authenticated internal path (the auth plugin did
 * not run), and is left as it was.
 */
function revealsModelIdentity(request: FastifyRequest): boolean {
  const principal = request.principal
  if (!principal) return true
  const role = principal.kind === 'user' ? principal.role : principal.delegatedUser?.role
  if (role) return role === UserRoles.admin
  return !principal.projectId && principal.scopes.includes(WILDCARD_SCOPE)
}

/**
 * Copy the transcript with every message's provenance removed. Returns new
 * objects: the stored row is never touched, because the operator's own reads,
 * the CLI, and cost accounting all still need what it holds.
 */
function redactMessageProvenance(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const copy = { ...(message as unknown as Record<string, unknown>) }
    let redacted = false
    for (const field of MESSAGE_PROVENANCE_FIELDS) {
      if (field in copy) {
        delete copy[field]
        redacted = true
      }
    }
    return (redacted ? copy : message) as AgentMessage
  })
}

function resolveProject(db: DatabaseClient, name: string): { id: string; name: string } {
  const row = db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.name, name)).get()
  if (!row) throw notFound('project', name)
  return row
}

/**
 * Registers the built-in Aero routes on the supplied Fastify scope. Callers
 * are expected to invoke this inside the authenticated api-routes scope so
 * these endpoints share canonry's bearer-key / session-cookie auth.
 *
 * Routes (relative paths — the scope's prefix provides /api/v1):
 *   GET    /projects/:name/agent/transcript  — rolling transcript + model config
 *   POST   /projects/:name/agent/prompt      — send a message, SSE stream back
 *   DELETE /projects/:name/agent/transcript  — reset the conversation
 *
 * AUTHORIZATION — every route here is administrator-only.
 *
 * Aero is an operator tool. On an install where the customer's analysts hold
 * viewer accounts, the dashboard can hide the command bar, but hiding it is
 * presentation: a viewer still holds a session cookie and can call these paths
 * directly. `requireAdminSession` is the boundary; the hidden bar is only
 * courtesy.
 *
 * The prompt route is where it matters most. Aero's tools execute with the
 * INSTALL ROOT key (server.ts builds its ApiClient from `config.apiKey`, which
 * carries the wildcard scope), and the per-turn tool scope is read off the
 * request body. So a viewer who reached this route would not be acting with
 * their own authority — they would be driving the operator's.
 *
 * GET transcript is admin-ONLY rather than admin-REDACTED, deliberately. There
 * is exactly one Aero session per project, so the transcript is not metadata
 * about a conversation, it is the operator's conversation: what they asked,
 * what Aero found, and whatever the tools returned along the way. Stripping the
 * model provenance would hide which model answered while still handing over
 * everything it said. Redaction is the right shape for a field that leaks; it
 * is the wrong shape for a body that was never the reader's to see.
 *
 * The gate runs BEFORE `resolveProject` on purpose: a viewer gets the same 403
 * whether or not the project exists, so the refusal cannot be used to probe
 * which projects an install has.
 *
 * SSE envelope: each line is `data: <JSON AgentEvent>\n\n`. Two control frames
 * wrap the stream — `stream_open` immediately after headers flush (so clients
 * can show "connected" UX) and `stream_close` just before `reply.raw.end()`
 * (so clients can distinguish clean closes from network drops).
 */
export function registerAgentRoutes(app: FastifyInstance, opts: AgentRoutesOptions): void {
  app.get<{ Params: { name: string } }>(
    '/projects/:name/agent/transcript',
    async (request) => {
      requireAdminSession(request)
      const project = resolveProject(opts.db, request.params.name)
      const row = opts.db.select().from(agentSessions).where(eq(agentSessions.projectId, project.id)).get()
      if (!row) {
        return { messages: [] as AgentMessage[], modelProvider: null, modelId: null, updatedAt: null }
      }
      const messages = parseJsonColumn<AgentMessage[]>(row.messages, [])
      // Redaction happens on the way out, never in the database.
      if (!revealsModelIdentity(request)) {
        return {
          messages: redactMessageProvenance(messages),
          modelProvider: null,
          modelId: null,
          updatedAt: row.updatedAt,
        }
      }
      return {
        messages,
        modelProvider: row.modelProvider,
        modelId: row.modelId,
        updatedAt: row.updatedAt,
      }
    },
  )

  // Provider catalog + key-resolution status. The dashboard provider picker
  // uses this to render enabled vs. disabled entries; the CLI can consume
  // the same shape to show `canonry agent providers`. Project-scoped path is
  // cosmetic — the response is global today but lives on the project scope
  // so future per-project provider overrides slot in without a URL shuffle.
  app.get<{ Params: { name: string } }>(
    '/projects/:name/agent/providers',
    async (request) => {
      requireAdminSession(request)
      resolveProject(opts.db, request.params.name)
      // This catalog names a default model for every provider, so serving it is
      // disclosing model identity by another path. A caller who may not know it
      // gets an EMPTY catalog rather than a trimmed one: a trimmed list would
      // still say which providers exist and which one is configured, which is
      // most of the answer.
      if (!revealsModelIdentity(request)) {
        return { providers: [], defaultProvider: null }
      }
      return buildAgentProvidersResponse(opts.sessionRegistry.getConfig())
    },
  )

  app.delete<{ Params: { name: string } }>(
    '/projects/:name/agent/transcript',
    async (request) => {
      requireAdminSession(request)
      const project = resolveProject(opts.db, request.params.name)
      // `reset` (not `evict`) — wipes the in-memory pending follow-up
      // buffer too. Otherwise a system message queued on a hot session
      // would leak into the next prompt after this reset.
      opts.sessionRegistry.reset(project.name)
      opts.db
        .update(agentSessions)
        .set({ messages: '[]', followUpQueue: '[]', updatedAt: new Date().toISOString() })
        .where(eq(agentSessions.projectId, project.id))
        .run()
      return { status: 'reset' }
    },
  )

  app.post<{
    Params: { name: string }
    Body: AgentPromptBody
  }>('/projects/:name/agent/prompt', async (request, reply) => {
    requireAdminSession(request)
    const project = resolveProject(opts.db, request.params.name)
    const body = request.body as unknown as AgentPromptBody | undefined
    const promptText = (body?.prompt ?? '').trim()
    if (!promptText) throw validationError('"prompt" is required')

    // Tool-scope policy:
    //   - Dashboard (no `scope` / `read-only`) — default. Prevents the bar
    //     from firing write tools without a confirmation UX.
    //   - CLI / bearer-token consumer passes `scope: 'all'` to opt into the
    //     full tool surface the operator invoked the command with.
    // Any authenticated caller can pass `scope` — the gate is about blast
    // radius for interactive UI, not authorization.
    const requestedScope = body?.scope === AeroToolScopes.all ? AeroToolScopes.all : AeroToolScopes.readOnly
    const requestedProfile = isAeroToolProfile(body?.profile)
      ? body.profile
      : AeroToolProfiles.default

    // acquireForTurn serializes per project: the busy check runs BEFORE any
    // scope / model mutation, so a second request against a busy Agent
    // throws `AGENT_BUSY` (409) without swapping out the in-flight turn's
    // tools or model. Safe to call concurrently from CLI + dashboard.
    const agent = await opts.sessionRegistry.acquireForTurn(project.name, {
      provider: body?.provider,
      modelId: body?.modelId,
      toolScope: requestedScope,
      toolProfile: requestedProfile,
    })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const write = (payload: AgentEvent | { type: 'stream_open' } | { type: 'stream_close' } | { type: 'error'; message: string }): void => {
      if (reply.raw.writableEnded) return
      try {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
      } catch {
        /* socket may be gone — ignore */
      }
    }

    write({ type: 'stream_open' })
    const unsubscribe = agent.subscribe((event) => {
      write(event)
    })

    // Abort the run if the client disconnects mid-stream. Listen on the
    // response raw (not the request raw) because for a POST the request
    // stream fires 'close' as soon as the body finishes uploading — long
    // before the response stream matters. Response-side 'close' fires when
    // the underlying socket actually goes away. `once` so we don't leak a
    // listener if the socket emits multiple close events.
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) {
        agent.abort()
      }
    })

    try {
      const pending = opts.sessionRegistry.consumePending(project.name)
      const userMessage: AgentMessage = {
        role: 'user',
        content: promptText,
        timestamp: Date.now(),
      } as AgentMessage
      const batch = pending.length > 0 ? [...pending, userMessage] : userMessage

      await agent.prompt(batch)
      await agent.waitForIdle()
      opts.sessionRegistry.save(project.name)
    } catch (err) {
      write({ type: 'error', message: describeError(err) })
    } finally {
      unsubscribe()
      write({ type: 'stream_close' })
      if (!reply.raw.writableEnded) {
        reply.raw.end()
      }
    }

    // Fastify accepts this as "reply already handled" because we wrote to reply.raw.
    return reply
  })

  // ──────────────────────────────────────────────────────────────────
  // Durable memory — project-scoped notes Aero reads/writes via tools.
  // These endpoints mirror the `remember` / `forget` / `recall` tool set
  // so operators and external agents get full CLI/API parity.
  // ──────────────────────────────────────────────────────────────────

  app.get<{ Params: { name: string } }>(
    '/projects/:name/agent/memory',
    async (request): Promise<AgentMemoryListResponse> => {
      requireAdminSession(request)
      const project = resolveProject(opts.db, request.params.name)
      return { entries: listMemoryEntries(opts.db, project.id) }
    },
  )

  app.put<{ Params: { name: string }; Body: unknown }>(
    '/projects/:name/agent/memory',
    async (request) => {
      requireAdminSession(request)
      const project = resolveProject(opts.db, request.params.name)
      const parsed = agentMemoryUpsertRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join('; '))
      }
      if (parsed.data.key.startsWith(COMPACTION_KEY_PREFIX)) {
        throw validationError(
          `key prefix "${COMPACTION_KEY_PREFIX}" is reserved for compaction notes`,
        )
      }
      if (Buffer.byteLength(parsed.data.value, 'utf8') > AGENT_MEMORY_VALUE_MAX_BYTES) {
        throw validationError(`"value" exceeds ${AGENT_MEMORY_VALUE_MAX_BYTES} bytes`)
      }
      const entry = upsertMemoryEntry(opts.db, {
        projectId: project.id,
        key: parsed.data.key,
        value: parsed.data.value,
        source: MemorySources.user,
      })
      opts.sessionRegistry.rehydrateLiveMemory(project.name)
      return { status: 'ok', entry }
    },
  )

  app.delete<{ Params: { name: string }; Body: unknown }>(
    '/projects/:name/agent/memory',
    async (request) => {
      requireAdminSession(request)
      const project = resolveProject(opts.db, request.params.name)
      const parsed = agentMemoryDeleteRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join('; '))
      }
      if (parsed.data.key.startsWith(COMPACTION_KEY_PREFIX)) {
        throw validationError(
          `key prefix "${COMPACTION_KEY_PREFIX}" is reserved; compaction notes are pruned automatically`,
        )
      }
      const removed = deleteMemoryEntry(opts.db, project.id, parsed.data.key)
      if (removed) opts.sessionRegistry.rehydrateLiveMemory(project.name)
      return { status: removed ? 'forgotten' : 'missing', key: parsed.data.key }
    },
  )
}
