import { agentBusy } from '@ainyc/canonry-contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
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
  agentPromptRequestSchema,
  type AgentPromptRequest,
  agentMemoryUpsertRequestSchema,
  notFound,
  validationError,
  type AgentMemoryListResponse,
  describeError,
} from '@ainyc/canonry-contracts'
import type { Agent, AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
import { registerAgentConversationRoutes, requireInstanceAdministrator } from '@ainyc/canonry-api-routes'
import type { SessionRegistry } from './session-registry.js'
import { aeroTurnStatus } from './runtime.js'
import {
  AeroToolProfiles,
  AeroToolScopes,
  isAeroToolProfile,
} from './tools.js'
import { buildAgentProvidersResponse } from './providers.js'
import {
  COMPACTION_KEY_PREFIX,
  deleteMemoryEntry,
  listMemoryEntries,
  upsertMemoryEntry,
} from './memory-store.js'

type AgentPromptBody = AgentPromptRequest

export interface AgentRoutesOptions {
  db: DatabaseClient
  sessionRegistry: SessionRegistry
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
 * directly. `requireInstanceAdministrator` is the boundary; the hidden bar is
 * only courtesy.
 *
 * That gate asks TWO questions, and both are load-bearing here.
 * `requireAdminSession` alone would answer only the first: it reads a role, so
 * it refuses a viewer but passes every API key, since a key carries no role at
 * all. A narrow key — read-only, or confined to one project — would still reach
 * every read. So the gate also refuses any key narrower than the install, and a
 * project-scoped read-only key is exactly the credential an operator hands to a
 * client integration.
 *
 * The prompt route is where it matters most. Aero's tools execute with the
 * INSTALL ROOT key (server.ts builds its ApiClient from `config.apiKey`, which
 * carries the wildcard scope), and the per-turn tool scope is read off the
 * request body. So a caller who reached this route would not be acting with
 * their own authority — they would be driving the operator's, whatever their
 * own credential was narrowed to.
 *
 * The reads are refused outright rather than redacted, deliberately. There is
 * exactly one Aero session per project, so the transcript is not metadata about
 * a conversation, it is the operator's conversation: what they asked, what Aero
 * found, and whatever the tools returned along the way. Memory is the same
 * material — operator notes, plus the compaction summaries Aero writes OF that
 * transcript. Stripping model provenance would have hidden which model answered
 * while still handing over everything it said. Redaction is the right shape for
 * a field that leaks; it is the wrong shape for a body that was never the
 * reader's to see.
 *
 * Which model answers is administrator knowledge for the same reason, so the
 * provider catalog is refused too rather than trimmed: naming which providers
 * exist and which one is configured is most of the answer. The doctor check
 * `config.agent-providers` guards the same fact on a route that is NOT
 * administrator-only, via `callerIsInstanceAdministrator`.
 *
 * The gate runs BEFORE `resolveProject` on purpose: a refused caller gets the
 * same 403 whether or not the project exists, so the refusal cannot be used to
 * probe which projects an install has.
 *
 * SSE envelope: each line is `data: <JSON AgentEvent>\n\n`. Two control frames
 * wrap the stream — `stream_open` immediately after headers flush (so clients
 * can show "connected" UX) and `stream_close` just before `reply.raw.end()`
 * (so clients can distinguish clean closes from network drops).
 */
export function registerAgentRoutes(app: FastifyInstance, opts: AgentRoutesOptions): void {
  registerAgentConversationRoutes(app, { db: opts.db, runtime: opts.sessionRegistry })
  app.get<{ Params: { name: string } }>(
    '/projects/:name/agent/transcript',
    async (request) => {
      requireInstanceAdministrator(request)
      const project = resolveProject(opts.db, request.params.name)
      const row = opts.db.select().from(agentSessions).where(eq(agentSessions.projectId, project.id)).get()
      if (!row) {
        return { conversationId: null, messages: [] as AgentMessage[], modelProvider: null, modelId: null, updatedAt: null }
      }
      const messages = parseJsonColumn<AgentMessage[]>(row.messages, [])
      return {
        messages,
        conversationId: row.id,
        isStreaming: opts.sessionRegistry.isBusy(project.name),
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
      requireInstanceAdministrator(request)
      resolveProject(opts.db, request.params.name)
      return buildAgentProvidersResponse(opts.sessionRegistry.getConfig())
    },
  )

  app.delete<{ Params: { name: string } }>(
    '/projects/:name/agent/transcript',
    async (request) => {
      requireInstanceAdministrator(request)
      const project = resolveProject(opts.db, request.params.name)
      if (opts.sessionRegistry.isBusy(project.name)) throw agentBusy(project.name)
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
    requireInstanceAdministrator(request)
    const project = resolveProject(opts.db, request.params.name)
    const parsed = agentPromptRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError(parsed.error.issues.map(issue => issue.message).join('; '))
    const body = parsed.data
    if (body.conversationId !== undefined) {
      const current = opts.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.projectId, project.id)).get()
      if ((current?.id ?? null) !== body.conversationId) throw validationError('The active conversation changed. Reload the conversation before sending.')
    }
    const promptText = body.prompt

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
    const disconnected = new AbortController()
    let agent: Agent | undefined
    // Observe closure during context validation/compaction too, before SSE opens.
    const onClose = () => {
      if (!reply.raw.writableEnded) {
        disconnected.abort()
        agent?.abort()
      }
    }
    reply.raw.once('close', onClose)
    try {
      agent = await opts.sessionRegistry.acquireForTurn(project.name, {
        provider: body.provider,
        modelId: body.modelId,
        toolScope: requestedScope,
        toolProfile: requestedProfile,
        context: body.context,
        limits: body.limits,
        signal: disconnected.signal,
      })
    } catch (err) {
      reply.raw.off('close', onClose)
      if (disconnected.signal.aborted) return reply
      throw err
    }
    if (disconnected.signal.aborted) return reply
    const acquiredAgent = agent

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const write = (payload: AgentEvent | { type: 'stream_open' } | { type: 'stream_close' } | { type: 'error'; message: string } | { type: 'aero_turn_status'; status: ReturnType<typeof aeroTurnStatus> }): void => {
      if (reply.raw.writableEnded) return
      try {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
      } catch {
        /* socket may be gone — ignore */
      }
    }

    write({ type: 'stream_open' })
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        const labelled = { ...event, label: acquiredAgent.state.tools.find(tool => tool.name === event.toolName)?.label }
        write(labelled)
      } else write(event)
    })

    let failed = false
    try {
      const pending = opts.sessionRegistry.consumePending(project.name)
      const userMessage: AgentMessage = {
        role: 'user',
        content: promptText,
        timestamp: Date.now(),
        ...(body.context ? { aeroContext: body.context } : {}),
      } as AgentMessage
      const batch = pending.length > 0 ? [...pending, userMessage] : userMessage

      await agent.prompt(batch)
      await agent.waitForIdle()
    } catch (err) {
      failed = true
      write({ type: 'error', message: describeError(err) })
    } finally {
      try { opts.sessionRegistry.save(project.name) } catch (err) {
        failed = true
        write({ type: 'error', message: describeError(err) })
      }
      const status = aeroTurnStatus(agent)
      write({ type: 'aero_turn_status', status: status && failed ? { ...status, reason: 'error' } : status })
      unsubscribe()
      reply.raw.off('close', onClose)
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
      requireInstanceAdministrator(request)
      const project = resolveProject(opts.db, request.params.name)
      return { entries: listMemoryEntries(opts.db, project.id) }
    },
  )

  app.put<{ Params: { name: string }; Body: unknown }>(
    '/projects/:name/agent/memory',
    async (request) => {
      requireInstanceAdministrator(request)
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
      requireInstanceAdministrator(request)
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
