import crypto from 'node:crypto'
import { AppError, agentBusy } from '@ainyc/canonry-contracts'
import type { AgentViewContext } from '@ainyc/canonry-contracts'
import { apiKeys, type DatabaseClient } from '@ainyc/canonry-db'
import { hashApiKey } from '@ainyc/canonry-api-routes'
import type { Agent, AgentMessage, AgentTool } from '@mariozechner/pi-agent-core'
import { and, eq, isNotNull, like } from 'drizzle-orm'
import { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import { CanonryMcpToolNames, canonryMcpTools, type CanonryMcpToolName } from '../mcp/tool-registry.js'
import { configureAeroRuntime } from './runtime.js'
import { createAeroSession, loadAeroSystemPrompt, resolveSessionProviderAndModel } from './session.js'
import { withoutPersistedToolDetails } from './session-registry.js'
import { buildSkillDocTools } from './skill-tools.js'
import { AeroToolScopes, buildAeroStateTools } from './tools.js'
import { aeroViewPrompt, buildAeroViewTool, readAeroViewEvidence } from './view-context.js'
import { aeroProjectShapePrompt } from './project-shape.js'

/**
 * Read tools a viewer's Aero never gets. They are marked read, but each one
 * calls an ads or Google Marketing provider live and spends against the
 * advertiser account, which is an operator decision.
 */
export const AERO_VIEWER_EXCLUDED_MCP_TOOLS: ReadonlySet<CanonryMcpToolName> = new Set([
  CanonryMcpToolNames.canonry_ads_account,
  CanonryMcpToolNames.canonry_ads_geo_search,
  CanonryMcpToolNames.canonry_ads_live_delivery,
  CanonryMcpToolNames.canonry_ads_conversion_pixels,
  CanonryMcpToolNames.canonry_ads_conversion_event_settings,
  CanonryMcpToolNames.canonry_google_ads_customers,
  CanonryMcpToolNames.canonry_gtm_accounts,
  CanonryMcpToolNames.canonry_gtm_containers,
  CanonryMcpToolNames.canonry_gtm_workspaces,
  // These can list every account the install's Google or provider login can
  // see, other clients included, or run live checks. Not a viewer's to read.
  CanonryMcpToolNames.canonry_settings_get,
  CanonryMcpToolNames.canonry_doctor,
  CanonryMcpToolNames.canonry_ga_properties,
  CanonryMcpToolNames.canonry_gbp_accounts,
  // Marked read, but embeds the harvested queries with the operator's Gemini key.
  CanonryMcpToolNames.canonry_discover_harvest,
  // Live Search Console call on the operator's Google login, which can also
  // refresh and store its token.
  CanonryMcpToolNames.canonry_gsc_sitemaps,
  // Live Common Crawl probe; free, but an outbound call a viewer has no need to make.
  CanonryMcpToolNames.canonry_backlinks_latest_release,
  // The whole install's audit log, not this project's.
  CanonryMcpToolNames.canonry_history_global,
])

/**
 * Tools that only ever answer an operator: Aero's own memory and saved
 * conversations, and operator-approved diagnostics. The viewer's key is refused
 * on all of them anyway, so they are dropped to keep the model from trying.
 */
const OPERATOR_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  canonryMcpTools.filter(tool => tool.tier === 'agent' || tool.requiresOperator).map(tool => tool.name),
)

/** Longest question a viewer may send. Every character rides every later turn. */
export const VIEWER_AERO_MAX_PROMPT_CHARS = 4_000

/** Turns one viewer may run per project per UTC day. Every turn spends the operator's LLM budget. */
export const VIEWER_AERO_DAILY_TURN_LIMIT = 50

export function viewerAeroDailyLimitExceeded(limit: number): AppError {
  return new AppError(
    'QUOTA_EXCEEDED',
    `You have used today's ${limit} Aero questions for this project. Try again tomorrow or ask an administrator.`,
    429,
    { metric: 'aero.viewer.turns', limit },
  )
}

/** Name prefix of the per-turn keys, so a restart can remove any a crash left behind. */
export const VIEWER_AERO_KEY_PREFIX = 'aero-viewer:'

/** Tells the model who it is talking to, so it explains a missing tool instead of hunting for one. */
export const VIEWER_AERO_PROMPT = '\n\nThis conversation is with a view-only account. You can read this project\'s data but cannot change anything, start or schedule sweeps, or spend on live provider reads. If asked to, say an administrator has to do it. You cannot see the operator\'s own Aero conversations or notes.'

/**
 * A viewer conversation keeps at most this many messages. Older turns are
 * dropped whole, at a user message, so a tool call is never split from its
 * result. There is no compaction here, and every message rides every turn.
 */
export const MAX_VIEWER_MESSAGES = 40

/** Drop the oldest whole turns until the transcript fits. */
export function trimViewerTranscript<T extends { role: string }>(messages: T[], max = MAX_VIEWER_MESSAGES): T[] {
  if (messages.length <= max) return messages
  for (let i = messages.length - max; i < messages.length; i++) {
    if (messages[i]!.role === 'user') return messages.slice(i)
  }
  // One turn longer than the cap: keep only that turn.
  const lastUser = messages.map(message => message.role).lastIndexOf('user')
  return lastUser > 0 ? messages.slice(lastUser) : messages
}
/** Conversations idle this long are dropped from memory. */
const VIEWER_IDLE_MS = 12 * 60 * 60 * 1000

export interface ViewerAeroOptions {
  db: DatabaseClient
  config: CanonryConfig
  /** Loopback base URL the per-turn client calls back on. */
  selfApiUrl: string
  managedSweeps?: boolean
  now?: () => number
}

/**
 * Mint the per-turn key: read-only, delegated to the viewer, so the API applies
 * the viewer's role to every call Aero makes on their behalf.
 */
export function mintViewerAeroKey(db: DatabaseClient, userId: string, now: Date = new Date()): { id: string; raw: string } {
  const raw = `cnry_${crypto.randomBytes(24).toString('hex')}`
  const id = crypto.randomUUID()
  db.insert(apiKeys).values({
    id,
    name: `${VIEWER_AERO_KEY_PREFIX}${userId}`,
    keyHash: hashApiKey(raw),
    keyPrefix: raw.slice(0, 9),
    scopes: ['read'],
    delegatedUserId: userId,
    createdAt: now.toISOString(),
  }).run()
  return { id, raw }
}

/** The viewer's tool catalog: read tools only, minus live paid reads and, when managed, sweep controls. */
export function buildViewerAeroTools(client: ApiClient, projectName: string, managedSweeps = false): AgentTool[] {
  const state = buildAeroStateTools({ client, projectName }, {
    scope: AeroToolScopes.readOnly,
    managedSweeps,
  }).filter(tool => !AERO_VIEWER_EXCLUDED_MCP_TOOLS.has(tool.name as CanonryMcpToolName) && !OPERATOR_ONLY_TOOL_NAMES.has(tool.name))
  return [...state, ...buildSkillDocTools()]
}

interface ViewerSession {
  agent: Agent
  lastUsedAt: number
  /**
   * When a turn last finished, as an ISO timestamp. The bar waits for this to
   * change before trusting a transcript after it sends, so it must move on
   * every finished turn, even one another tab started.
   */
  updatedAt: string | null
}

export interface ViewerTurn {
  agent: Agent
  /** Revoke the turn's key. Call once the turn has finished, whatever the outcome. */
  release: () => void
}

/**
 * Aero for signed-in viewer accounts, kept apart from the operator's Aero.
 *
 * The operator's Aero is one persisted conversation per project, hydrated with
 * the project's memory notes, and its tools run with the install root key.
 * None of that is safe to hand a viewer, so a viewer gets their own lane:
 *
 * - One conversation per viewer and project, held in memory only. A viewer
 *   never sees the operator's transcript, history or memory, and the operator's
 *   conversation never receives a viewer's turns.
 * - Tools run with the VIEWER's authority. Each turn mints a short-lived key
 *   delegated to the viewer (the same mechanism hosted MCP uses), so the API
 *   applies the viewer's role to every call, and the key is revoked when the
 *   turn ends. Read-only tools only, minus live paid reads, and minus sweep and
 *   schedule writes on a managed install.
 * - The system prompt carries no memory block, and the model is the install's
 *   configured Aero model; a viewer cannot pick a provider or model.
 */
export class ViewerAeroSessions {
  private readonly sessions = new Map<string, ViewerSession>()
  private readonly acquisitions = new Set<string>()
  /** Turns per viewer and project today, keyed with the UTC date. In memory: a restart forgives. */
  private readonly turnsToday = new Map<string, { date: string; count: number }>()
  private readonly now: () => number

  constructor(private readonly opts: ViewerAeroOptions) {
    this.now = opts.now ?? Date.now
    this.revokeOrphanedKeys()
  }

  private key(projectName: string, userId: string): string {
    return `${projectName}\u0000${userId}`
  }

  /** Without tool `details`, which can be large and the bar never renders; the model's text copy stays. */
  transcript(projectName: string, userId: string): AgentMessage[] {
    this.evictIdle()
    const messages = this.sessions.get(this.key(projectName, userId))?.agent.state.messages ?? []
    return withoutPersistedToolDetails(messages) as AgentMessage[]
  }

  updatedAt(projectName: string, userId: string): string | null {
    return this.sessions.get(this.key(projectName, userId))?.updatedAt ?? null
  }

  isBusy(projectName: string, userId: string): boolean {
    const key = this.key(projectName, userId)
    return this.acquisitions.has(key) || this.sessions.get(key)?.agent.state.isStreaming === true
  }

  reset(projectName: string, userId: string): void {
    const key = this.key(projectName, userId)
    if (this.isBusy(projectName, userId)) throw agentBusy(projectName)
    this.sessions.delete(key)
  }

  async acquireForTurn(
    project: { id: string; name: string },
    userId: string,
    preferences: { context?: AgentViewContext; signal?: AbortSignal } = {},
  ): Promise<ViewerTurn> {
    preferences.signal?.throwIfAborted()
    this.evictIdle()
    const key = this.key(project.name, userId)
    if (this.isBusy(project.name, userId)) throw agentBusy(project.name)
    const today = new Date(this.now()).toISOString().slice(0, 10)
    const used = this.turnsToday.get(key)
    const count = used?.date === today ? used.count : 0
    if (count >= VIEWER_AERO_DAILY_TURN_LIMIT) throw viewerAeroDailyLimitExceeded(VIEWER_AERO_DAILY_TURN_LIMIT)
    // Mint before reserving the lane: a failed insert must not leave it busy.
    const minted = mintViewerAeroKey(this.opts.db, userId, new Date(this.now()))
    this.acquisitions.add(key)
    let handedOff = false
    try {
      const client = new ApiClient(this.opts.selfApiUrl, minted.raw, { skipProbe: true, surface: 'aero' })
      const agent = this.sessions.get(key)?.agent ?? this.createAgent(project, client)
      agent.state.messages = trimViewerTranscript(agent.state.messages)
      const view = { client, projectName: project.name, basePath: this.opts.config.basePath, context: preferences.context }
      const evidence = preferences.context ? await readAeroViewEvidence(view) : undefined
      preferences.signal?.throwIfAborted()
      // Without the operator's AERO_SYSTEM_PROMPT_APPEND / _FILE extras: those
      // are the operator's instructions, not the viewer's to read.
      agent.state.systemPrompt = loadAeroSystemPrompt(undefined, { extras: false }) + VIEWER_AERO_PROMPT
        + aeroProjectShapePrompt(this.opts.db, project.id, { progressive: false })
        + aeroViewPrompt(preferences.context)
      // The whole read catalog, not progressive toolkits: a model that knows a
      // tool's name from the skill docs calls it directly, and a toolkit it has
      // not loaded yet would answer "not found". The catalog is already the
      // viewer's safe read set. Operator turn limits apply.
      configureAeroRuntime(agent, [...buildViewerAeroTools(client, project.name, this.opts.managedSweeps), buildAeroViewTool(view, evidence)], undefined, false)
      this.sessions.set(key, { agent, lastUsedAt: this.now(), updatedAt: this.sessions.get(key)?.updatedAt ?? null })
      this.turnsToday.set(key, { date: today, count: count + 1 })
      handedOff = true
      let released = false
      return {
        agent,
        release: () => {
          if (released) return
          released = true
          this.acquisitions.delete(key)
          const session = this.sessions.get(key)
          if (session) {
            session.lastUsedAt = this.now()
            // Strictly later than the last value, so two turns in one
            // millisecond still read as a change.
            const previous = session.updatedAt ? Date.parse(session.updatedAt) : 0
            session.updatedAt = new Date(Math.max(this.now(), previous + 1)).toISOString()
          }
          this.removeKey(minted.id)
        },
      }
    } finally {
      if (!handedOff) {
        this.acquisitions.delete(key)
        this.removeKey(minted.id)
      }
    }
  }

  private createAgent(project: { id: string; name: string }, client: ApiClient): Agent {
    const { provider, modelId } = resolveSessionProviderAndModel(this.opts.config)
    return createAeroSession({
      projectName: project.name,
      client,
      config: this.opts.config,
      provider,
      modelId,
      systemPromptOverride: loadAeroSystemPrompt(undefined, { extras: false }) + VIEWER_AERO_PROMPT,
      toolScope: AeroToolScopes.readOnly,
      managedSweeps: this.opts.managedSweeps,
      db: this.opts.db,
      projectId: project.id,
    })
  }

  /**
   * Delete the turn's key rather than revoke it: the key list shows revoked
   * keys too, and one per turn would bury the operator's own. Revoke only if
   * the delete fails, so the key is dead either way.
   */
  private removeKey(id: string): void {
    try {
      this.opts.db.delete(apiKeys).where(eq(apiKeys.id, id)).run()
    } catch {
      try {
        this.opts.db.update(apiKeys).set({ revokedAt: new Date(this.now()).toISOString() }).where(eq(apiKeys.id, id)).run()
      } catch {
        // Gone or revoked is the desired end state either way.
      }
    }
  }

  /**
   * A key outlives its turn only if the process died mid-turn. Remove those on
   * start. Only delegated keys match: the key API never sets a delegate, so an
   * operator key that merely shares the name prefix is left alone.
   */
  private revokeOrphanedKeys(): void {
    try {
      this.opts.db.delete(apiKeys)
        .where(and(like(apiKeys.name, `${VIEWER_AERO_KEY_PREFIX}%`), isNotNull(apiKeys.delegatedUserId)))
        .run()
    } catch {
      // Best effort; each key is still delegated to a viewer and read-only.
    }
  }

  private evictIdle(): void {
    const cutoff = this.now() - VIEWER_IDLE_MS
    for (const [key, session] of this.sessions) {
      if (session.lastUsedAt < cutoff && !this.acquisitions.has(key) && !session.agent.state.isStreaming) {
        this.sessions.delete(key)
      }
    }
  }
}
