import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  agentSessions,
  parseJsonColumn,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { notFound, validationError } from '@ainyc/canonry-contracts'
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
import type { SessionRegistry } from './session-registry.js'
import type { SupportedAgentProvider } from './session.js'
import { buildAgentProvidersResponse } from './providers.js'

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
 * SSE envelope: each line is `data: <JSON AgentEvent>\n\n`. Two control frames
 * wrap the stream — `stream_open` immediately after headers flush (so clients
 * can show "connected" UX) and `stream_close` just before `reply.raw.end()`
 * (so clients can distinguish clean closes from network drops).
 */
export function registerAgentRoutes(app: FastifyInstance, opts: AgentRoutesOptions): void {
  app.get<{ Params: { name: string } }>(
    '/projects/:name/agent/transcript',
    async (request) => {
      const project = resolveProject(opts.db, request.params.name)
      const row = opts.db.select().from(agentSessions).where(eq(agentSessions.projectId, project.id)).get()
      if (!row) {
        return { messages: [] as AgentMessage[], modelProvider: null, modelId: null, updatedAt: null }
      }
      return {
        messages: parseJsonColumn<AgentMessage[]>(row.messages, []),
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
      resolveProject(opts.db, request.params.name)
      return buildAgentProvidersResponse(opts.sessionRegistry.getConfig())
    },
  )

  app.delete<{ Params: { name: string } }>(
    '/projects/:name/agent/transcript',
    async (request) => {
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
    Body: {
      prompt: string
      provider?: SupportedAgentProvider
      modelId?: string
      scope?: 'all' | 'read-only'
    }
  }>('/projects/:name/agent/prompt', async (request, reply) => {
    const project = resolveProject(opts.db, request.params.name)
    const promptText = (request.body?.prompt ?? '').trim()
    if (!promptText) throw validationError('"prompt" is required')

    // Tool-scope policy:
    //   - Dashboard (no `scope` / `read-only`) — default. Prevents the bar
    //     from firing write tools without a confirmation UX.
    //   - CLI / bearer-token consumer passes `scope: 'all'` to opt into the
    //     full tool surface the operator invoked the command with.
    // Any authenticated caller can pass `scope` — the gate is about blast
    // radius for interactive UI, not authorization.
    const requestedScope = request.body?.scope === 'all' ? 'all' : 'read-only'

    // acquireForTurn serializes per project: the busy check runs BEFORE any
    // scope / model mutation, so a second request against a busy Agent
    // throws `AGENT_BUSY` (409) without swapping out the in-flight turn's
    // tools or model. Safe to call concurrently from CLI + dashboard.
    const agent = opts.sessionRegistry.acquireForTurn(project.name, {
      provider: request.body?.provider,
      modelId: request.body?.modelId,
      toolScope: requestedScope,
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
      write({ type: 'error', message: err instanceof Error ? err.message : String(err) })
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
}
