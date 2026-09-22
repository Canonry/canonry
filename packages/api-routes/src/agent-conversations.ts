import type { FastifyInstance } from 'fastify'
import { and, desc, eq, like } from 'drizzle-orm'
import { agentConversations, agentMemory, agentSessions, parseJsonColumn, type DatabaseClient } from '@ainyc/canonry-db'
import { agentBusy, agentConversationCreateSchema, agentConversationListQuerySchema, agentConversationTitle, alreadyExists, notFound, validationError, type AgentConversation, type AgentConversationSummary } from '@ainyc/canonry-contracts'
import { requireInstanceAdministrator } from './auth.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'

type ActiveRow = typeof agentSessions.$inferSelect
type ArchivedRow = typeof agentConversations.$inferSelect

/** The runtime is injected by the Aero host; this package never imports it. */
export interface AgentConversationRuntime {
  isBusy(name: string): boolean
  prepareConversationChange(name: string): void
  getOrCreate(name: string): unknown
  reset(name: string): void
}

function summary(row: ActiveRow | ArchivedRow, active: boolean): AgentConversationSummary {
  return {
    id: row.id, active, title: 'title' in row ? row.title : agentConversationTitle(parseJsonColumn(row.messages, [])),
    modelProvider: row.modelProvider, modelId: row.modelId, createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

export function registerAgentConversationRoutes(app: FastifyInstance, opts: { db: DatabaseClient; runtime: AgentConversationRuntime }): void {
  const { db, runtime } = opts
  const activeRow = (projectId: string) => db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
  const archivedRow = (projectId: string, id: string) => db.select().from(agentConversations).where(and(eq(agentConversations.projectId, projectId), eq(agentConversations.id, id))).get()
  const detail = (projectId: string, name: string, id: string): AgentConversation => {
    const current = activeRow(projectId)
    if (current?.id === id) return { ...summary(current, true), messages: parseJsonColumn(current.messages, []), isStreaming: runtime.isBusy(name) }
    const archived = archivedRow(projectId, id)
    if (!archived) throw notFound('conversation', id)
    return { ...summary(archived, false), messages: archived.messages, isStreaming: false }
  }
  const archive = (tx: Pick<DatabaseClient, 'insert'>, row: ActiveRow) => {
    const messages = parseJsonColumn<ArchivedRow['messages']>(row.messages, [])
    tx.insert(agentConversations).values({ ...row, title: agentConversationTitle(messages), messages, followUpQueue: parseJsonColumn(row.followUpQueue, []) }).run()
  }
  const prepare = (name: string) => {
    if (runtime.isBusy(name)) throw agentBusy(name)
    runtime.prepareConversationChange(name)
  }

  app.get<{ Params: { name: string }; Querystring: { offset?: string; limit?: string } }>('/projects/:name/agent/conversations', async request => {
    requireInstanceAdministrator(request)
    const project = resolveProject(db, request.params.name)
    const parsed = agentConversationListQuerySchema.safeParse(request.query)
    if (!parsed.success) throw validationError(parsed.error.message)
    const { offset, limit } = parsed.data
    const current = activeRow(project.id)
    // Summaries do not load archived transcript payloads.
    const rows = db.select({ id: agentConversations.id, title: agentConversations.title, modelProvider: agentConversations.modelProvider,
      modelId: agentConversations.modelId, createdAt: agentConversations.createdAt, updatedAt: agentConversations.updatedAt })
      .from(agentConversations).where(eq(agentConversations.projectId, project.id))
      .orderBy(desc(agentConversations.updatedAt), desc(agentConversations.id)).limit(limit + 1).offset(offset).all()
    return {
      conversations: [...(current && offset === 0 ? [summary(current, true)] : []), ...rows.slice(0, limit).map(row => ({ ...row, active: false }))],
      currentConversationId: current?.id ?? null,
      nextOffset: rows.length > limit ? offset + limit : null,
    }
  })

  app.get<{ Params: { name: string; id: string } }>('/projects/:name/agent/conversations/:id', async request => {
    requireInstanceAdministrator(request)
    const project = resolveProject(db, request.params.name)
    return detail(project.id, project.name, request.params.id)
  })

  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/agent/conversations', async request => {
    requireInstanceAdministrator(request)
    const project = resolveProject(db, request.params.name)
    const parsed = agentConversationCreateSchema.safeParse(request.body)
    if (!parsed.success) throw validationError(parsed.error.message)
    const { id } = parsed.data // Identity, not tuning: replay never switches the active conversation again.
    if (activeRow(project.id)?.id === id || archivedRow(project.id, id)) return detail(project.id, project.name, id)
    if (db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.id, id)).get()
      || db.select({ id: agentConversations.id }).from(agentConversations).where(eq(agentConversations.id, id)).get()) throw alreadyExists('conversation', id)
    prepare(project.name)
    const existing = activeRow(project.id)
    if (!existing) runtime.getOrCreate(project.name)
    const current = activeRow(project.id)!
    const now = new Date().toISOString()
    db.transaction(tx => {
      if (existing) archive(tx, current)
      tx.update(agentSessions).set({ id, messages: '[]', followUpQueue: '[]', createdAt: now, updatedAt: now }).where(eq(agentSessions.projectId, project.id)).run()
      writeAuditLog(tx, auditFromRequest(request, { projectId: project.id, actor: 'api', action: 'agent.conversation.created', entityType: 'agent-conversation', entityId: id }))
    })
    runtime.reset(project.name)
    return detail(project.id, project.name, id)
  })

  app.post<{ Params: { name: string; id: string } }>('/projects/:name/agent/conversations/:id/resume', async request => {
    requireInstanceAdministrator(request)
    const project = resolveProject(db, request.params.name)
    const { id } = request.params
    if (activeRow(project.id)?.id === id) return detail(project.id, project.name, id)
    const selected = archivedRow(project.id, id)
    if (!selected) throw notFound('conversation', id)
    prepare(project.name)
    const current = activeRow(project.id)
    db.transaction(tx => {
      if (current) archive(tx, current)
      tx.delete(agentConversations).where(and(eq(agentConversations.projectId, project.id), eq(agentConversations.id, id))).run()
      tx.delete(agentSessions).where(eq(agentSessions.projectId, project.id)).run()
      tx.insert(agentSessions).values({ id, projectId: project.id, systemPrompt: selected.systemPrompt, modelProvider: selected.modelProvider, modelId: selected.modelId,
        messages: JSON.stringify(selected.messages), followUpQueue: JSON.stringify(selected.followUpQueue), createdAt: selected.createdAt, updatedAt: new Date().toISOString() }).run()
      writeAuditLog(tx, auditFromRequest(request, { projectId: project.id, actor: 'api', action: 'agent.conversation.resumed', entityType: 'agent-conversation', entityId: id }))
    })
    runtime.reset(project.name)
    return detail(project.id, project.name, id)
  })

  app.delete<{ Params: { name: string; id: string } }>('/projects/:name/agent/conversations/:id', async request => {
    requireInstanceAdministrator(request)
    const project = resolveProject(db, request.params.name)
    const { id } = request.params
    const current = activeRow(project.id)
    const isActive = current?.id === id
    if (isActive) prepare(project.name)
    const exists = isActive || !!archivedRow(project.id, id)
    db.transaction(tx => {
      tx.delete(agentConversations).where(and(eq(agentConversations.projectId, project.id), eq(agentConversations.id, id))).run()
      if (isActive) tx.delete(agentSessions).where(eq(agentSessions.projectId, project.id)).run()
      // Prefix matching treats legacy IDs containing SQL wildcards literally.
      const prefix = `compaction:${id}:`
      const notes = tx.select().from(agentMemory).where(and(eq(agentMemory.projectId, project.id), like(agentMemory.key, 'compaction:%'))).all()
      for (const note of notes) if (note.key.startsWith(prefix)) tx.delete(agentMemory).where(eq(agentMemory.id, note.id)).run()
      if (exists) writeAuditLog(tx, auditFromRequest(request, { projectId: project.id, actor: 'api', action: 'agent.conversation.deleted', entityType: 'agent-conversation', entityId: id }))
    })
    if (isActive) runtime.reset(project.name)
    return { id, status: 'deleted' as const }
  })
}
