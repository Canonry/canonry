import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  agentSessions,
  parseJsonColumn,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core'
import { createLogger } from '../logger.js'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import {
  createAeroSession,
  loadAeroSystemPrompt,
  resolveSessionProviderAndModel,
  type SupportedAgentProvider,
} from './session.js'

const log = createLogger('SessionRegistry')

export interface SessionRegistryOptions {
  db: DatabaseClient
  client: ApiClient
  config: CanonryConfig
}

export interface SessionPreferences {
  provider?: SupportedAgentProvider
  modelId?: string
}

interface AgentSessionRow {
  id: string
  projectId: string
  systemPrompt: string
  modelProvider: string
  modelId: string
  messages: string
  followUpQueue: string
  createdAt: string
  updatedAt: string
}

/**
 * Hybrid session registry for Aero — durable state in `agent_sessions`,
 * live pi-agent-core Agent instance in memory per project.
 *
 * Single rolling session per project (UNIQUE project_id). Live Agents hold
 * listeners + abort controllers (non-serializable); the DB row stores the
 * transcript, chosen provider/model, and any follow-up messages queued
 * while no live Agent was alive.
 *
 * The registry owns its own pending-messages queue (separate from pi's
 * internal follow-up queue). Events arrive via `queueFollowUp`; the next
 * `drainNow` or user-driven prompt bundles the pending messages in front
 * of the next prompt so they're processed in a single turn.
 */
export class SessionRegistry {
  private readonly live = new Map<string, Agent>()
  private readonly pending = new Map<string, AgentMessage[]>()
  private readonly opts: SessionRegistryOptions

  constructor(opts: SessionRegistryOptions) {
    this.opts = opts
  }

  /** Returns the live Agent for a project, hydrating from DB or creating fresh. */
  getOrCreate(projectName: string, preferences?: SessionPreferences): Agent {
    const cached = this.live.get(projectName)
    if (cached) return cached

    const projectId = this.resolveProjectId(projectName)
    const row = this.loadRow(projectId)

    if (row) {
      const persistedMessages = parseJsonColumn<AgentMessage[]>(row.messages, [])
      const queued = parseJsonColumn<AgentMessage[]>(row.followUpQueue, [])

      const agent = createAeroSession({
        projectName,
        client: this.opts.client,
        config: this.opts.config,
        provider: row.modelProvider as SupportedAgentProvider,
        modelId: row.modelId,
        systemPromptOverride: row.systemPrompt,
        initialMessages: persistedMessages,
      })

      if (queued.length > 0) {
        this.appendPending(projectName, queued)
        this.updateRow(projectId, { followUpQueue: '[]' })
      }

      this.live.set(projectName, agent)
      return agent
    }

    const { provider, modelId } = resolveSessionProviderAndModel(this.opts.config, preferences)
    const systemPrompt = loadAeroSystemPrompt()

    const agent = createAeroSession({
      projectName,
      client: this.opts.client,
      config: this.opts.config,
      provider,
      modelId,
      systemPromptOverride: systemPrompt,
    })

    this.insertRow({
      projectId,
      systemPrompt,
      modelProvider: provider,
      modelId,
      messages: [],
      followUpQueue: [],
    })

    this.live.set(projectName, agent)
    return agent
  }

  /** Persist a session's transcript back to the DB. Call after any run settles. */
  save(projectName: string): void {
    const agent = this.live.get(projectName)
    if (!agent) return
    const projectId = this.resolveProjectId(projectName)
    this.updateRow(projectId, {
      messages: JSON.stringify(agent.state.messages),
    })
  }

  /**
   * Enqueue a message for the next turn.
   *
   * Always appends to the registry's pending queue. If no live Agent exists
   * for this project, also persists to the DB follow-up queue so the message
   * survives a restart.
   *
   * Does NOT kick a run — callers either drain explicitly via `drainNow` or
   * let the next `consumePending`-backed prompt pick them up.
   */
  queueFollowUp(projectName: string, message: AgentMessage): void {
    this.appendPending(projectName, [message])
    if (!this.live.has(projectName)) {
      this.persistQueue(projectName, this.pending.get(projectName) ?? [])
    }
  }

  /** Consume (and clear) the pending queue for a project. Caller prompts with the result. */
  consumePending(projectName: string): AgentMessage[] {
    const msgs = this.pending.get(projectName) ?? []
    if (msgs.length === 0) return []
    this.pending.delete(projectName)
    // Clear persisted queue too — caller is taking ownership of these messages.
    const projectId = this.tryResolveProjectId(projectName)
    if (projectId) this.updateRow(projectId, { followUpQueue: '[]' })
    return msgs
  }

  /**
   * Proactive drain — hydrate if needed, consume pending, prompt the agent.
   *
   * No-op when:
   *   - there are no pending messages
   *   - the agent is currently streaming (it will pick them up on the next turn)
   *
   * Fire-and-forget safe: failures are logged, never thrown. This is what
   * RunCoordinator calls after a run completes to wake Aero unprompted.
   */
  async drainNow(projectName: string): Promise<void> {
    try {
      const agent = this.getOrCreate(projectName)
      if (agent.state.isStreaming) {
        return
      }
      const msgs = this.consumePending(projectName)
      if (msgs.length === 0) return
      await agent.prompt(msgs)
      this.save(projectName)
    } catch (err) {
      log.error('drain.failed', {
        projectName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Drop the live Agent for a project. Next lookup rehydrates from DB. */
  evict(projectName: string): void {
    this.live.delete(projectName)
  }

  /** Evict every live Agent. Durable state in DB is untouched. */
  clear(): void {
    this.live.clear()
  }

  /** Visible so tests can assert whether a session is hot. */
  isLive(projectName: string): boolean {
    return this.live.has(projectName)
  }

  /** Visible so tests can peek at the pending queue without consuming. */
  peekPending(projectName: string): readonly AgentMessage[] {
    return this.pending.get(projectName) ?? []
  }

  // ──────────────────────────────────────────────────────────────────

  private appendPending(projectName: string, messages: AgentMessage[]): void {
    if (messages.length === 0) return
    const existing = this.pending.get(projectName) ?? []
    this.pending.set(projectName, [...existing, ...messages])
  }

  private persistQueue(projectName: string, messages: AgentMessage[]): void {
    const projectId = this.tryResolveProjectId(projectName)
    if (!projectId) return
    const row = this.loadRow(projectId)
    if (!row) {
      // No session row yet — insert a fresh one so the queue has a home.
      this.insertRow({
        projectId,
        systemPrompt: loadAeroSystemPrompt(),
        ...resolveSessionProviderAndModel(this.opts.config),
        messages: [],
        followUpQueue: messages,
      })
      return
    }
    this.updateRow(projectId, { followUpQueue: JSON.stringify(messages) })
  }

  private resolveProjectId(projectName: string): string {
    const id = this.tryResolveProjectId(projectName)
    if (!id) throw new Error(`Project "${projectName}" not found`)
    return id
  }

  private tryResolveProjectId(projectName: string): string | undefined {
    const row = this.opts.db.select({ id: projects.id }).from(projects).where(eq(projects.name, projectName)).get()
    return row?.id
  }

  private loadRow(projectId: string): AgentSessionRow | null {
    const row = this.opts.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.projectId, projectId))
      .get()
    return row ?? null
  }

  private insertRow(params: {
    projectId: string
    systemPrompt: string
    provider?: SupportedAgentProvider
    modelId?: string
    modelProvider?: string
    messages: AgentMessage[]
    followUpQueue: AgentMessage[]
  }): void {
    const now = new Date().toISOString()
    this.opts.db
      .insert(agentSessions)
      .values({
        id: crypto.randomUUID(),
        projectId: params.projectId,
        systemPrompt: params.systemPrompt,
        modelProvider: params.provider ?? params.modelProvider ?? 'anthropic',
        modelId: params.modelId ?? 'claude-opus-4-7',
        messages: JSON.stringify(params.messages),
        followUpQueue: JSON.stringify(params.followUpQueue),
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  private updateRow(projectId: string, patch: Partial<Pick<AgentSessionRow, 'messages' | 'followUpQueue'>>): void {
    const now = new Date().toISOString()
    this.opts.db
      .update(agentSessions)
      .set({ ...patch, updatedAt: now })
      .where(eq(agentSessions.projectId, projectId))
      .run()
  }
}
