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

export interface AgentRoutesOptions {
  db: DatabaseClient
  sessionRegistry: SessionRegistry
  apiPrefix: string
}

function resolveProject(db: DatabaseClient, name: string): { id: string; name: string } {
  const row = db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.name, name)).get()
  if (!row) throw notFound('project', name)
  return row
}

/**
 * Registers the built-in Aero routes under the configured api prefix:
 *   GET    /api/v1/projects/:name/agent/transcript  — the full rolling transcript
 *   POST   /api/v1/projects/:name/agent/prompt      — send a message, SSE stream back
 *   DELETE /api/v1/projects/:name/agent/transcript  — reset the conversation
 *
 * SSE envelope: each line is `data: <JSON AgentEvent>\n\n`. Two additional
 * control events wrap the stream: `{ "type": "stream_open" }` is sent immediately
 * after headers flush so clients can show "connected" UX; `{ "type": "stream_close" }`
 * is sent just before `reply.raw.end()` so clients know the stream is intentionally
 * complete (vs. a network drop).
 */
export function registerAgentRoutes(app: FastifyInstance, opts: AgentRoutesOptions): void {
  const prefix = opts.apiPrefix

  app.get<{ Params: { name: string } }>(
    prefix + '/projects/:name/agent/transcript',
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

  app.delete<{ Params: { name: string } }>(
    prefix + '/projects/:name/agent/transcript',
    async (request) => {
      const project = resolveProject(opts.db, request.params.name)
      opts.sessionRegistry.evict(project.name)
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
    }
  }>(prefix + '/projects/:name/agent/prompt', async (request, reply) => {
    const project = resolveProject(opts.db, request.params.name)
    const promptText = (request.body?.prompt ?? '').trim()
    if (!promptText) throw validationError('"prompt" is required')

    const agent = opts.sessionRegistry.getOrCreate(project.name, {
      provider: request.body?.provider,
      modelId: request.body?.modelId,
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
    // the underlying socket actually goes away.
    reply.raw.on('close', () => {
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
