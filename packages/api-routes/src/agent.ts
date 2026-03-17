/**
 * Agent API routes — chat with the built-in AEO analyst.
 *
 * POST /api/v1/projects/:project/agent/threads             — create thread
 * GET  /api/v1/projects/:project/agent/threads              — list threads
 * GET  /api/v1/projects/:project/agent/threads/:id          — get thread + messages
 * POST /api/v1/projects/:project/agent/threads/:id/messages — send message
 * DELETE /api/v1/projects/:project/agent/threads/:id        — delete thread
 */

import crypto from 'node:crypto'
import { eq, desc, asc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { agentThreads, agentMessages } from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'

export interface AgentRoutesOptions {
  /** Called when a user sends a message to the agent. Returns the agent's response. */
  onAgentMessage?: (
    projectId: string,
    threadId: string,
    message: string,
  ) => Promise<string>
}

export async function agentRoutes(app: FastifyInstance, opts: AgentRoutesOptions) {
  const prefix = '/projects/:project/agent'

  // Per-thread mutex — prevents concurrent agent loops from corrupting history
  const activeThreads = new Set<string>()

  // ── Create thread ─────────────────────────────────────────

  app.post<{
    Params: { project: string }
    Body: { title?: string; channel?: string }
  }>(`${prefix}/threads`, {
    schema: {
      params: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200 },
          channel: { type: 'string', enum: ['chat', 'cli', 'api'] },
        },
      },
    },
  }, async (request, reply) => {
    const { project } = request.params
    const { title, channel } = request.body ?? {}

    const projectRow = resolveProject(app.db, project)

    const now = new Date().toISOString()
    const thread = {
      id: crypto.randomUUID(),
      projectId: projectRow.id,
      title: title ?? null,
      channel: channel ?? 'chat',
      createdAt: now,
      updatedAt: now,
    }

    app.db.insert(agentThreads).values(thread).run()

    return reply.status(201).send(thread)
  })

  // ── List threads ──────────────────────────────────────────

  app.get<{
    Params: { project: string }
    Querystring: { limit?: string }
  }>(`${prefix}/threads`, {
    schema: {
      params: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
    },
  }, async (request, reply) => {
    const { project } = request.params
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100)

    const projectRow = resolveProject(app.db, project)

    const threads = app.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.projectId, projectRow.id))
      .orderBy(desc(agentThreads.updatedAt))
      .limit(limit)
      .all()

    return reply.send(threads)
  })

  // ── Get thread with messages ──────────────────────────────

  app.get<{
    Params: { project: string; id: string }
  }>(`${prefix}/threads/:id`, {
    schema: {
      params: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['project', 'id'],
      },
    },
  }, async (request, reply) => {
    const { project, id } = request.params

    const projectRow = resolveProject(app.db, project)

    const thread = app.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, id))
      .get()

    if (!thread || thread.projectId !== projectRow.id) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } })
    }

    const messages = app.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.threadId, id))
      .orderBy(asc(agentMessages.createdAt))
      .all()

    return reply.send({ ...thread, messages })
  })

  // ── Send message ──────────────────────────────────────────

  app.post<{
    Params: { project: string; id: string }
    Body: { message: string }
  }>(`${prefix}/threads/:id/messages`, {
    schema: {
      params: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['project', 'id'],
      },
      body: {
        type: 'object',
        properties: {
          message: { type: 'string', maxLength: 8000 },
        },
        required: ['message'],
      },
    },
  }, async (request, reply) => {
    const { project, id: threadId } = request.params
    const { message } = request.body

    const projectRow = resolveProject(app.db, project)

    // Verify thread exists and belongs to this project
    const thread = app.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, threadId))
      .get()

    if (!thread || thread.projectId !== projectRow.id) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } })
    }

    if (!opts.onAgentMessage) {
      return reply.status(503).send({
        error: {
          code: 'AGENT_UNAVAILABLE',
          message: 'Agent is not configured. Add a provider with an API key.',
        },
      })
    }

    if (activeThreads.has(threadId)) {
      return reply.status(409).send({
        error: {
          code: 'THREAD_BUSY',
          message: 'This thread is already processing a message. Please wait.',
        },
      })
    }

    activeThreads.add(threadId)
    try {
      const response = await opts.onAgentMessage(thread.projectId, threadId, message)
      return reply.send({ threadId, response })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isLlmError = msg.includes('API error') || msg.includes('API key') || msg.includes('timeout')
      return reply.status(isLlmError ? 502 : 500).send({
        error: {
          code: isLlmError ? 'LLM_ERROR' : 'AGENT_ERROR',
          message: msg,
        },
      })
    } finally {
      activeThreads.delete(threadId)
    }
  })

  // ── Delete thread ─────────────────────────────────────────

  app.delete<{
    Params: { project: string; id: string }
  }>(`${prefix}/threads/:id`, {
    schema: {
      params: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['project', 'id'],
      },
    },
  }, async (request, reply) => {
    const { project, id } = request.params

    const projectRow = resolveProject(app.db, project)

    // Verify thread exists and belongs to this project
    const thread = app.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, id))
      .get()

    if (!thread || thread.projectId !== projectRow.id) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } })
    }

    app.db.delete(agentMessages).where(eq(agentMessages.threadId, id)).run()
    app.db.delete(agentThreads).where(eq(agentThreads.id, id)).run()

    return reply.status(204).send()
  })
}
