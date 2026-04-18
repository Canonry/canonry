import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  agentSessions,
  parseJsonColumn,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import {
  createAeroSession,
  loadAeroSystemPrompt,
  resolveSessionProviderAndModel,
  type SupportedAgentProvider,
} from './session.js'

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
 * Hybrid session registry — durable state in `agent_sessions`, live pi-agent-core
 * Agent instance in memory per project.
 *
 * Single rolling session per project (one row per project via UNIQUE). Live
 * Agents hold subscribers + abort controllers, which are not serializable;
 * the DB row stores the transcript + any follow-up messages that were enqueued
 * while no live Agent existed. On next `getOrCreate` the registry rehydrates
 * those into a fresh live Agent.
 */
export class SessionRegistry {
  private readonly live = new Map<string, Agent>()
  private readonly opts: SessionRegistryOptions

  constructor(opts: SessionRegistryOptions) {
    this.opts = opts
  }

  /**
   * Get the live Agent for a project. Hydrates from DB if one was persisted;
   * constructs a fresh session + inserts a new row otherwise.
   */
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
      for (const msg of queued) agent.followUp(msg)

      if (queued.length > 0) {
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

  /** Persist a session's transcript (and empty its follow-up queue) back to the DB. */
  save(projectName: string): void {
    const agent = this.live.get(projectName)
    if (!agent) return
    const projectId = this.resolveProjectId(projectName)
    this.updateRow(projectId, {
      messages: JSON.stringify(agent.state.messages),
    })
  }

  /**
   * Enqueue a follow-up for a project's session.
   *
   * If a live Agent exists, forward directly to its follow-up queue.
   * Otherwise append to the persisted row's queue — the next `getOrCreate`
   * drains it into the rehydrated Agent.
   */
  queueFollowUp(projectName: string, message: AgentMessage): void {
    const live = this.live.get(projectName)
    if (live) {
      live.followUp(message)
      return
    }
    const projectId = this.resolveProjectId(projectName)
    const row = this.loadRow(projectId)
    const existing = row ? parseJsonColumn<AgentMessage[]>(row.followUpQueue, []) : []
    const merged = [...existing, message]
    if (row) {
      this.updateRow(projectId, { followUpQueue: JSON.stringify(merged) })
    } else {
      // No row yet — defer creation until someone actually opens the session.
      // Store the pending message in a pre-session queue so the first
      // getOrCreate can drain it.
      this.pendingPreSession.set(projectName, merged)
    }
  }

  /** Drop the live Agent for a project — next lookup rehydrates from DB. */
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

  // ──────────────────────────────────────────────────────────────────
  // Pre-session queue — messages that arrive before a session row exists.
  // Drained by getOrCreate when it creates the first row.
  private readonly pendingPreSession = new Map<string, AgentMessage[]>()

  private resolveProjectId(projectName: string): string {
    const row = this.opts.db.select({ id: projects.id }).from(projects).where(eq(projects.name, projectName)).get()
    if (!row) {
      throw new Error(`Project "${projectName}" not found`)
    }
    return row.id
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
    modelProvider: string
    modelId: string
    messages: AgentMessage[]
    followUpQueue: AgentMessage[]
  }): void {
    const now = new Date().toISOString()
    // Drain any pre-session queue for this project into the new row.
    const projectName = this.projectNameById(params.projectId)
    const preSession = projectName ? this.pendingPreSession.get(projectName) ?? [] : []
    const mergedQueue = [...params.followUpQueue, ...preSession]

    this.opts.db
      .insert(agentSessions)
      .values({
        id: crypto.randomUUID(),
        projectId: params.projectId,
        systemPrompt: params.systemPrompt,
        modelProvider: params.modelProvider,
        modelId: params.modelId,
        messages: JSON.stringify(params.messages),
        followUpQueue: JSON.stringify(mergedQueue),
        createdAt: now,
        updatedAt: now,
      })
      .run()

    if (projectName) this.pendingPreSession.delete(projectName)
  }

  private updateRow(projectId: string, patch: Partial<Pick<AgentSessionRow, 'messages' | 'followUpQueue'>>): void {
    const now = new Date().toISOString()
    this.opts.db
      .update(agentSessions)
      .set({ ...patch, updatedAt: now })
      .where(eq(agentSessions.projectId, projectId))
      .run()
  }

  private projectNameById(projectId: string): string | undefined {
    const row = this.opts.db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).get()
    return row?.name
  }
}
