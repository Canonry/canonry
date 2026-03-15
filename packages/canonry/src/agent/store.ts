/**
 * Agent persistence — thread and message storage backed by SQLite (via drizzle).
 */

import crypto from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { agentThreads, agentMessages } from '@ainyc/canonry-db'
import type { AgentThread, AgentMessage } from './types.js'

export class AgentStore {
  constructor(private db: DatabaseClient) {}

  // ── Threads ───────────────────────────────────────────────

  async createThread(projectId: string, opts?: { title?: string; channel?: string }): Promise<AgentThread> {
    const now = new Date().toISOString()
    const thread: typeof agentThreads.$inferInsert = {
      id: crypto.randomUUID(),
      projectId,
      title: opts?.title ?? null,
      channel: opts?.channel ?? 'chat',
      createdAt: now,
      updatedAt: now,
    }
    this.db.insert(agentThreads).values(thread).run()
    return thread as AgentThread
  }

  async getThread(threadId: string): Promise<AgentThread | null> {
    const rows = this.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, threadId))
      .all()
    return (rows[0] as AgentThread | undefined) ?? null
  }

  async listThreads(projectId: string, limit = 20): Promise<AgentThread[]> {
    return this.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.projectId, projectId))
      .orderBy(desc(agentThreads.updatedAt))
      .limit(limit)
      .all() as AgentThread[]
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.delete(agentThreads).where(eq(agentThreads.id, threadId)).run()
  }

  async touchThread(threadId: string): Promise<void> {
    this.db
      .update(agentThreads)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(agentThreads.id, threadId))
      .run()
  }

  async updateThreadTitle(threadId: string, title: string): Promise<void> {
    this.db
      .update(agentThreads)
      .set({ title, updatedAt: new Date().toISOString() })
      .where(eq(agentThreads.id, threadId))
      .run()
  }

  // ── Messages ──────────────────────────────────────────────

  async addMessage(msg: Omit<AgentMessage, 'id' | 'createdAt'>): Promise<AgentMessage> {
    const now = new Date().toISOString()
    const record: typeof agentMessages.$inferInsert = {
      id: crypto.randomUUID(),
      threadId: msg.threadId,
      role: msg.role,
      content: msg.content,
      toolName: msg.toolName ?? null,
      toolArgs: msg.toolArgs ?? null,
      toolCallId: msg.toolCallId ?? null,
      createdAt: now,
    }
    this.db.insert(agentMessages).values(record).run()
    return record as AgentMessage
  }

  async getMessages(threadId: string, limit = 50): Promise<AgentMessage[]> {
    const rows = this.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.threadId, threadId))
      .orderBy(desc(agentMessages.createdAt))
      .limit(limit)
      .all() as AgentMessage[]

    return rows.reverse()
  }
}
