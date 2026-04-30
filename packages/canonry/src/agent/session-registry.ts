import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  agentSessions,
  parseJsonColumn,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core'
import { agentBusy, AgentProviderIds } from '@ainyc/canonry-contracts'
import { createLogger } from '../logger.js'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import {
  buildApiKeyResolver,
  createAeroSession,
  loadAeroSystemPrompt,
  resolveAeroModel,
  resolveSessionProviderAndModel,
  type SupportedAgentProvider,
} from './session.js'
import { getAgentProvider } from './providers.js'
import { buildSkillDocTools } from './skill-tools.js'
import { buildAllTools, buildReadTools } from './tools.js'
import { loadRecentForHydrate } from './memory-store.js'
import { compactMessages, shouldCompact } from './compaction.js'

const log = createLogger('SessionRegistry')

export interface SessionRegistryOptions {
  db: DatabaseClient
  client: ApiClient
  config: CanonryConfig
}

export interface SessionPreferences {
  provider?: SupportedAgentProvider
  modelId?: string
  /** Pass 'read-only' to build a session that exposes only read tools. Default 'all'. */
  toolScope?: 'all' | 'read-only'
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
/**
 * Hydrate cap — top N most-recent memory rows injected into the system
 * prompt `<memory>` block at session build time. Keeps the block readable
 * and bounded against the value-byte cap.
 */
const MAX_HYDRATE_NOTES = 20

/**
 * Soft byte cap for the total memory block rendered into the system prompt.
 * 20 notes × 2 KB value = 40 KB worst case; we truncate to ~32 KB so the
 * block never dominates the prompt, dropping oldest entries first.
 */
const MAX_HYDRATE_BYTES = 32 * 1024

/**
 * Neutralize sequences in a memory fragment that could otherwise escape
 * the `<memory>` wrapper and persistently modify system instructions.
 * Compaction summaries are LLM-authored and notes can be written by any
 * operator, so values must be treated as untrusted data. We escape any
 * `<memory>`/`</memory>` tag (case-insensitive) by inserting a zero-width
 * non-joiner so the rendered text reads the same to a human but no longer
 * closes the data block.
 */
function escapeMemoryFragment(value: string): string {
  return value.replace(/<(\/?)memory>/gi, '<$1\u200Cmemory>')
}

export class SessionRegistry {
  private readonly live = new Map<string, Agent>()
  private readonly pending = new Map<string, AgentMessage[]>()
  /** Last tool scope used on the live Agent for a project. Read in getOrCreate to know when to swap. */
  private readonly scopes = new Map<string, 'all' | 'read-only'>()
  /** Cached resolved project id per project name, used so alignScope can rebuild tool context without a DB roundtrip. */
  private readonly projectIds = new Map<string, string>()
  /**
   * In-flight compaction promises keyed by project name. A second
   * `acquireForTurn` that arrives while the first is still summarizing
   * awaits the same promise instead of kicking off a duplicate LLM call.
   */
  private readonly compactions = new Map<string, Promise<void>>()
  private readonly opts: SessionRegistryOptions

  constructor(opts: SessionRegistryOptions) {
    this.opts = opts
  }

  /** Read-only access to the config snapshot the registry was built with. */
  getConfig(): CanonryConfig {
    return this.opts.config
  }

  /**
   * Returns the live Agent for a project, hydrating from DB or creating
   * fresh. Applies caller preferences on fresh/hydrated construction. Does
   * NOT mutate an already-cached Agent — that path goes through
   * `acquireForTurn`, which gates scope/model changes behind a busy check
   * so an in-flight turn can't have its tools swapped out from under it.
   */
  getOrCreate(projectName: string, preferences?: SessionPreferences): Agent {
    const cached = this.live.get(projectName)
    if (cached) return cached

    const projectId = this.resolveProjectId(projectName)
    const row = this.loadRow(projectId)

    if (row) {
      const persistedMessages = parseJsonColumn<AgentMessage[]>(row.messages, [])
      const queued = parseJsonColumn<AgentMessage[]>(row.followUpQueue, [])

      // Explicit caller preferences override the persisted values (and are
      // persisted back). This keeps `--provider` / `--model` flags meaningful
      // after the first session exists instead of silently ignoring them.
      const effectiveProvider = (preferences?.provider ?? row.modelProvider) as SupportedAgentProvider
      const effectiveModelId = preferences?.modelId ?? row.modelId
      if (preferences?.provider || preferences?.modelId) {
        this.opts.db
          .update(agentSessions)
          .set({
            modelProvider: effectiveProvider,
            modelId: effectiveModelId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agentSessions.projectId, projectId))
          .run()
      }

      const agent = createAeroSession({
        projectName,
        client: this.opts.client,
        config: this.opts.config,
        provider: effectiveProvider,
        modelId: effectiveModelId,
        systemPromptOverride: this.buildHydratedSystemPrompt(projectId, row.systemPrompt),
        initialMessages: persistedMessages,
        toolScope: preferences?.toolScope,
      })
      this.scopes.set(projectName, preferences?.toolScope ?? 'all')
      this.projectIds.set(projectName, projectId)

      if (queued.length > 0) {
        this.appendPending(projectName, queued)
        this.updateRow(projectId, { followUpQueue: '[]' })
      }

      this.live.set(projectName, agent)
      this.registerDrainHook(agent, projectName)
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
      // Hydrate on the fresh path too — a brand-new session may still see
      // notes if they were seeded via CLI/API before the first prompt.
      systemPromptOverride: this.buildHydratedSystemPrompt(projectId, systemPrompt),
      toolScope: preferences?.toolScope,
    })
    this.scopes.set(projectName, preferences?.toolScope ?? 'all')
    this.projectIds.set(projectName, projectId)

    this.insertRow({
      projectId,
      // Persist the raw (unhydrated) prompt so the DB remains canonical —
      // the `<memory>` block is rebuilt from the notes table on every load.
      systemPrompt,
      modelProvider: provider,
      modelId,
      messages: [],
      followUpQueue: [],
    })

    this.live.set(projectName, agent)
    this.registerDrainHook(agent, projectName)
    return agent
  }

  /**
   * Append the `<memory>` block to a base system prompt, sourced from the
   * `agent_memory` table. Returns the base prompt unchanged when no notes
   * exist — an empty block would just be prompt noise. Truncates to
   * `MAX_HYDRATE_BYTES`, dropping oldest-first, so the block is bounded
   * even when notes sit near their 2 KB cap.
   *
   * Note values come from LLM-authored compaction summaries and operator
   * input, so they are treated as untrusted data: closing tags that could
   * escape the `<memory>` wrapper are neutralized before interpolation.
   */
  buildHydratedSystemPrompt(projectId: string, basePrompt: string): string {
    const entries = loadRecentForHydrate(this.opts.db, projectId, MAX_HYDRATE_NOTES)
    if (entries.length === 0) return basePrompt

    let totalBytes = 0
    const kept: Array<{ source: string; key: string; value: string }> = []
    for (const entry of entries) {
      const escaped = {
        source: escapeMemoryFragment(entry.source),
        key: escapeMemoryFragment(entry.key),
        value: escapeMemoryFragment(entry.value),
      }
      const line = `- [${escaped.source}] ${escaped.key}: ${escaped.value}\n`
      const bytes = Buffer.byteLength(line, 'utf8')
      if (totalBytes + bytes > MAX_HYDRATE_BYTES) break
      kept.push(escaped)
      totalBytes += bytes
    }
    if (kept.length === 0) return basePrompt

    const lines = kept.map((e) => `- [${e.source}] ${e.key}: ${e.value}`)
    return (
      `${basePrompt.trimEnd()}\n\n---\n\n` +
      `<memory>\n` +
      `Project-scoped durable notes (newest first). Use canonry_memory_set/canonry_memory_forget/canonry_memory_list to manage. Entries tagged [compaction] are LLM-summarized transcript slices.\n\n` +
      `${lines.join('\n')}\n` +
      `</memory>`
    )
  }

  /**
   * Rebuild the live agent's system prompt from the latest `agent_memory`
   * rows. Called after out-of-band memory writes (CLI/API PUT/DELETE) so
   * the next turn on a hot session sees the updated notes without waiting
   * for compaction or a cold restart. No-op when no live agent exists —
   * the next `getOrCreate` will hydrate from DB anyway.
   */
  rehydrateLiveMemory(projectName: string): void {
    const agent = this.live.get(projectName)
    if (!agent) return
    const projectId = this.tryResolveProjectId(projectName)
    if (!projectId) return
    const row = this.loadRow(projectId)
    if (!row) return
    agent.state.systemPrompt = this.buildHydratedSystemPrompt(projectId, row.systemPrompt)
  }

  /**
   * Acquire the Agent for an upcoming prompt/turn.
   *
   * Busy-check runs FIRST, before any state mutation — if two requests race
   * on the same project, one gets the 409 and the other's in-flight turn is
   * untouched. Only after confirming idle do we:
   *   - align `state.tools` to the requested scope (CLI full vs dashboard
   *     read-only share the same cached Agent; each request re-scopes it).
   *   - align `state.model` when the caller passes `provider` or `modelId`,
   *     honoring `--provider` / `--model` on hot sessions (not just on
   *     fresh/hydrated construction).
   *
   * Persists the new model choice to the DB row so subsequent invocations
   * stay on it unless overridden again.
   */
  async acquireForTurn(projectName: string, preferences?: SessionPreferences): Promise<Agent> {
    const agent = this.getOrCreate(projectName)
    if (agent.state.isStreaming) {
      throw agentBusy(projectName)
    }
    this.alignScope(projectName, agent, preferences?.toolScope ?? 'all')
    if (preferences?.provider || preferences?.modelId) {
      this.alignModel(projectName, agent, preferences)
    }
    await this.maybeCompact(projectName, agent)
    return agent
  }

  /**
   * Summarize the oldest half of the transcript into a `compaction:`
   * memory row when the transcript crosses the token/message threshold.
   * Runs before the caller's next `agent.prompt()` so the model sees the
   * trimmed transcript + a refreshed `<memory>` block that now includes
   * the new summary.
   *
   * Races are deduped through `this.compactions`: a concurrent call for
   * the same project awaits the in-flight promise instead of launching a
   * duplicate summarizer run. Failures are logged and swallowed — a flaky
   * summarizer must never block a user turn.
   */
  private async maybeCompact(projectName: string, agent: Agent): Promise<void> {
    const inflight = this.compactions.get(projectName)
    if (inflight) {
      await inflight
      return
    }
    if (!shouldCompact(agent.state.messages)) return

    const promise = this.runCompaction(projectName, agent).finally(() => {
      this.compactions.delete(projectName)
    })
    this.compactions.set(projectName, promise)
    await promise
  }

  private async runCompaction(projectName: string, agent: Agent): Promise<void> {
    const projectId = this.projectIds.get(projectName) ?? this.resolveProjectId(projectName)
    this.projectIds.set(projectName, projectId)
    const row = this.loadRow(projectId)
    if (!row) return
    try {
      const result = await compactMessages({
        db: this.opts.db,
        projectId,
        sessionId: row.id,
        messages: agent.state.messages,
        model: agent.state.model,
        getApiKey: buildApiKeyResolver(this.opts.config),
      })
      if (!result) return
      agent.state.messages = result.messages
      // Rehydrate the system prompt so the just-written compaction note
      // shows up in the `<memory>` block on the very next LLM call.
      agent.state.systemPrompt = this.buildHydratedSystemPrompt(projectId, row.systemPrompt)
      this.save(projectName)
      log.info('compaction.completed', {
        projectName,
        removedCount: result.removedCount,
        summaryBytes: Buffer.byteLength(result.summary, 'utf8'),
      })
    } catch (err) {
      log.error('compaction.failed', {
        projectName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private alignScope(projectName: string, agent: Agent, wantScope: 'all' | 'read-only'): void {
    if (this.scopes.get(projectName) === wantScope) return
    const projectId = this.projectIds.get(projectName) ?? this.resolveProjectId(projectName)
    this.projectIds.set(projectName, projectId)
    const toolCtx = { client: this.opts.client, projectName }
    // Mirror createAeroSession: skill-doc tools ride in every scope.
    const stateTools =
      wantScope === 'read-only' ? buildReadTools(toolCtx) : buildAllTools(toolCtx)
    agent.state.tools = [...stateTools, ...buildSkillDocTools()]
    this.scopes.set(projectName, wantScope)
  }

  private alignModel(
    projectName: string,
    agent: Agent,
    preferences: SessionPreferences,
  ): void {
    const projectId = this.tryResolveProjectId(projectName)
    if (!projectId) return
    const row = this.loadRow(projectId)
    const currentProvider = (row?.modelProvider ?? AgentProviderIds.claude) as SupportedAgentProvider
    const currentModelId = row?.modelId
    const nextProvider = preferences.provider ?? currentProvider
    const nextModelId =
      preferences.modelId ?? (preferences.provider ? getAgentProvider(nextProvider).defaultModel : currentModelId)
    if (!nextModelId) return
    if (nextProvider === currentProvider && nextModelId === currentModelId) return

    agent.state.model = resolveAeroModel(nextProvider, nextModelId)
    this.opts.db
      .update(agentSessions)
      .set({
        modelProvider: nextProvider,
        modelId: nextModelId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agentSessions.projectId, projectId))
      .run()
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
   * - Live session exists: append to the in-memory pending queue. The next
   *   `consumePending`-backed prompt, a `drainNow` call, or the post-`agent_end`
   *   drain hook will process it.
   * - No live session: persist to the DB follow-up queue. The next
   *   `getOrCreate` hydrates the agent and migrates the queue into pending.
   *
   * Crucially writes to exactly ONE of the two sinks to avoid the duplicate
   * message we saw during the first end-to-end dogfood (run.completed fired,
   * both the in-memory pending and the DB-queue migration produced copies).
   */
  queueFollowUp(projectName: string, message: AgentMessage): void {
    if (this.live.has(projectName)) {
      this.appendPending(projectName, [message])
    } else {
      this.persistQueueAppend(projectName, message)
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
   *   - there are no pending messages in memory AND no persisted queue in
   *     the DB (post-restart / never-hydrated sessions still need to wake)
   *   - the agent is currently streaming (it will pick them up on the next turn)
   *
   * Fire-and-forget safe: failures are logged, never thrown. This is what
   * RunCoordinator calls after a run completes to wake Aero unprompted.
   */
  async drainNow(projectName: string): Promise<void> {
    if (!this.hasPendingWork(projectName)) return
    try {
      let agent: Agent
      try {
        // Preserve the session's current scope — a proactive drain must not
        // escalate a read-only dashboard session to the full write surface.
        // Default to 'read-only' when no scope has been set yet, since drains
        // are system-triggered and should fail closed.
        const scope = this.scopes.get(projectName) ?? 'read-only'
        // acquireForTurn does the busy check in the registry — if the agent
        // is mid-stream we leave pending alone and let `agent_end` drain
        // hook pick it up. Pi's AppError surfaces as `AGENT_BUSY`.
        agent = await this.acquireForTurn(projectName, { toolScope: scope })
      } catch (err) {
        if ((err as { code?: string }).code === 'AGENT_BUSY') return
        throw err
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

  /**
   * Authoritative reset for a project's session state. Drops the live Agent,
   * clears the in-memory pending follow-up buffer, and forgets the cached
   * tool scope. Caller is responsible for wiping the durable row; this only
   * touches the in-process state the registry holds.
   *
   * Use this (not `evict`) when the caller guarantees the conversation is
   * being wiped — e.g. `DELETE /agent/transcript`. `evict` alone leaves any
   * in-memory follow-ups queued on a hot session, which would leak into the
   * next turn after the reset.
   */
  reset(projectName: string): void {
    this.live.delete(projectName)
    this.pending.delete(projectName)
    this.scopes.delete(projectName)
    this.projectIds.delete(projectName)
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

  /**
   * True when there's in-memory pending work OR a persisted follow-up queue
   * for this project. Checked by `drainNow` before doing any hydration work
   * so proactive wake-up fires even on cold / post-restart sessions where
   * the follow-up lives only in the DB row.
   */
  private hasPendingWork(projectName: string): boolean {
    if ((this.pending.get(projectName) ?? []).length > 0) return true
    const projectId = this.tryResolveProjectId(projectName)
    if (!projectId) return false
    const row = this.loadRow(projectId)
    if (!row) return false
    return parseJsonColumn<AgentMessage[]>(row.followUpQueue, []).length > 0
  }

  private appendPending(projectName: string, messages: AgentMessage[]): void {
    if (messages.length === 0) return
    const existing = this.pending.get(projectName) ?? []
    this.pending.set(projectName, [...existing, ...messages])
  }

  private persistQueueAppend(projectName: string, message: AgentMessage): void {
    const projectId = this.tryResolveProjectId(projectName)
    if (!projectId) return
    const row = this.loadRow(projectId)
    if (!row) {
      // No session row yet — insert a fresh one with this message as the first queued entry.
      this.insertRow({
        projectId,
        systemPrompt: loadAeroSystemPrompt(),
        ...resolveSessionProviderAndModel(this.opts.config),
        messages: [],
        followUpQueue: [message],
      })
      return
    }
    const existing = parseJsonColumn<AgentMessage[]>(row.followUpQueue, [])
    this.updateRow(projectId, { followUpQueue: JSON.stringify([...existing, message]) })
  }

  /**
   * Subscribe to agent_end so any pending messages that landed during a run
   * (from RunCoordinator callbacks or steered follow-ups) drain automatically
   * after the current turn settles. Without this, a RunCoordinator event that
   * arrives mid-CLI-turn would sit in pending until someone called drainNow.
   */
  private registerDrainHook(agent: Agent, projectName: string): void {
    agent.subscribe((event) => {
      if (event.type !== 'agent_end') return
      if ((this.pending.get(projectName) ?? []).length === 0) return
      // Fire-and-forget — the drain re-invokes prompt() which itself emits a
      // new agent_end, so we stay single-threaded via pi's internal guards.
      void this.drainNow(projectName)
    })
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
        modelProvider: params.provider ?? params.modelProvider ?? AgentProviderIds.claude,
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
