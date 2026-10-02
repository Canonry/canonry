import crypto from 'node:crypto'
import { and, eq, inArray, lt } from 'drizzle-orm'
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import { managedAgentSessions, managedAgentTurnGrants, type DatabaseClient } from '@ainyc/canonry-db'
import { AgentProviderIds, agentBusy, authInvalid, validationError, type AgentPromptRequest } from '@ainyc/canonry-contracts'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import { canonryMcpTools } from '../mcp/tool-registry.js'
import { managedChatGptModel, managedChatGptStream } from './managed-chatgpt.js'
import type { ManagedInferenceGrant, ManagedInferenceTurnGrant } from './managed-inference.js'
import { configureAeroRuntime } from './runtime.js'
import { loadAeroSystemPrompt } from './session.js'
import { withoutPersistedToolDetails } from './session-registry.js'
import { buildSkillDocTools } from './skill-tools.js'
import { AERO_ADS_OPERATOR_CONTEXT_TOOL_NAME, AeroToolProfiles, AeroToolScopes, buildAeroStateTools } from './tools.js'
import { aeroProjectShape } from './project-shape.js'
import { aeroViewPrompt, buildAeroViewTool, readAeroViewEvidence } from './view-context.js'
import { trimViewerTranscript } from './viewer-sessions.js'
import { loadExternalMcpTools } from './remote-mcp.js'

const PRIVATE_TOOL_NAMES = new Set<string>([
  ...canonryMcpTools.filter(tool => tool.tier === 'agent' || tool.requiresOperator).map(tool => tool.name),
  AERO_ADS_OPERATOR_CONTEXT_TOOL_NAME,
])
const PERSONAL_PROMPT = '\n\nThis is a personal conversation. You cannot read the operator\'s Aero conversations, project memory or queued follow-ups. Your answers use this person\'s connected ChatGPT account only while they request a turn.'

export interface ManagedAeroOptions {
  db: DatabaseClient
  client: ApiClient
  config: CanonryConfig
  managedSweeps?: boolean
  /** Injectable public Responses transport for offline protocol checks. */
  transport?: typeof globalThis.fetch
  streamFactory?: (grant: ManagedInferenceTurnGrant) => { stream: StreamFn; release: () => void }
}

/** Current sessions are acquired only for foreground turns; credentials never hydrate or wake. */
export class ManagedAeroSessions {
  private readonly busy = new Set<string>()
  private externalTools?: Promise<AgentTool[]>

  constructor(private readonly opts: ManagedAeroOptions) {}

  private key(projectId: string, grant: ManagedInferenceGrant): string {
    return JSON.stringify([projectId, grant.actorId, grant.connectionId])
  }

  private selection(projectId: string, grant: ManagedInferenceGrant) {
    return and(eq(managedAgentSessions.projectId, projectId), eq(managedAgentSessions.actorId, grant.actorId), eq(managedAgentSessions.connectionId, grant.connectionId))
  }

  transcript(projectId: string, grant: ManagedInferenceGrant) {
    const row = this.opts.db.select().from(managedAgentSessions).where(this.selection(projectId, grant)).get()
    return {
      conversationId: row?.id ?? null,
      messages: (row?.messages ?? []) as AgentMessage[],
      isStreaming: this.busy.has(this.key(projectId, grant)),
      modelProvider: row ? 'openai' : null,
      modelId: row?.modelId ?? null,
      updatedAt: row?.updatedAt ?? null,
    }
  }

  reset(project: { id: string; name: string }, grant: ManagedInferenceGrant): void {
    if (this.busy.has(this.key(project.id, grant))) throw agentBusy(project.name)
    this.opts.db.delete(managedAgentSessions).where(this.selection(project.id, grant)).run()
  }

  async acquireForTurn(
    project: { id: string; name: string },
    grant: ManagedInferenceTurnGrant,
    body: AgentPromptRequest,
    signal?: AbortSignal,
  ): Promise<{ agent: Agent; save: () => void; release: () => void }> {
    signal?.throwIfAborted()
    const key = this.key(project.id, grant)
    if (this.busy.has(key)) throw agentBusy(project.name)
    const row = this.opts.db.select().from(managedAgentSessions).where(this.selection(project.id, grant)).get()
    if (body.conversationId !== undefined && body.conversationId !== (row?.id ?? null)) {
      throw validationError('The active conversation changed. Reload the conversation before sending.')
    }
    if (body.provider !== undefined && body.provider !== AgentProviderIds.openai) throw validationError('Personal Aero uses your connected ChatGPT account.')
    if (body.modelId !== undefined && body.modelId !== grant.modelId) throw validationError('Choose a model from your connected ChatGPT account.')
    this.busy.add(key)
    let credentials: ReturnType<typeof managedChatGptStream> | undefined
    try {
      this.consumeGrant(grant)
      const view = { client: this.opts.client, projectName: project.name, basePath: this.opts.config.basePath, context: body.context }
      const evidence = body.context ? await readAeroViewEvidence(view) : undefined
      this.externalTools ??= loadExternalMcpTools(this.opts.config.externalMcpServers ?? [])
      const external = await this.externalTools
      signal?.throwIfAborted()
      if (grant.expiresAt <= Date.now()) throw authInvalid()
      const shape = aeroProjectShape(this.opts.db, project.id)
      const profile = body.profile ?? AeroToolProfiles.default
      const tools = [
        ...buildAeroStateTools({ client: this.opts.client, projectName: project.name }, {
          scope: body.scope === AeroToolScopes.all ? AeroToolScopes.all : AeroToolScopes.readOnly,
          profile, managedSweeps: this.opts.managedSweeps,
        }),
        ...buildSkillDocTools(), ...external,
        buildAeroViewTool(view, evidence),
      ].filter(tool => !PRIVATE_TOOL_NAMES.has(tool.name))
      credentials = this.opts.streamFactory?.(grant) ?? managedChatGptStream(grant, this.opts.transport)
      const storedMessages = (row?.messages ?? []) as AgentMessage[]
      const modelMessages = trimViewerTranscript(storedMessages)
      const earlierMessages = storedMessages.slice(0, storedMessages.length - modelMessages.length)
      const agent = new Agent({
        initialState: {
          systemPrompt: loadAeroSystemPrompt() + PERSONAL_PROMPT + shape.prompt + aeroViewPrompt(body.context),
          model: managedChatGptModel(grant.modelId), tools,
          messages: modelMessages,
        },
        streamFn: credentials.stream,
      })
      configureAeroRuntime(agent, tools, body.limits, profile === AeroToolProfiles.default, shape.pinned)
      const { actorId, connectionId, modelId } = grant
      const id = row?.id ?? crypto.randomUUID()
      const createdAt = row?.createdAt ?? new Date().toISOString()
      let released = false
      return {
        agent,
        save: () => {
          const previous = row?.updatedAt ? Date.parse(row.updatedAt) : 0
          const messages = [...earlierMessages, ...withoutPersistedToolDetails(agent.state.messages)]
          const updatedAt = new Date(Math.max(Date.now(), previous + 1)).toISOString()
          this.opts.db.insert(managedAgentSessions).values({
            id, projectId: project.id, actorId, connectionId,
            modelId, messages, createdAt, updatedAt,
          }).onConflictDoUpdate({
            target: [managedAgentSessions.projectId, managedAgentSessions.actorId, managedAgentSessions.connectionId],
            set: { modelId, messages, updatedAt },
          }).run()
        },
        release: () => {
          if (released) return
          released = true
          credentials?.release()
          this.busy.delete(key)
        },
      }
    } catch (error) {
      credentials?.release()
      this.busy.delete(key)
      throw error
    }
  }

  private consumeGrant(grant: ManagedInferenceTurnGrant): void {
    this.opts.db.transaction(tx => {
      const expired = tx.select({ id: managedAgentTurnGrants.id }).from(managedAgentTurnGrants)
        .where(lt(managedAgentTurnGrants.expiresAt, Date.now())).limit(100).all()
      if (expired.length) tx.delete(managedAgentTurnGrants).where(inArray(managedAgentTurnGrants.id, expired.map(row => row.id))).run()
      const inserted = tx.insert(managedAgentTurnGrants).values({ id: grant.grantId, expiresAt: grant.expiresAt })
        .onConflictDoNothing().returning({ id: managedAgentTurnGrants.id }).all()
      if (inserted.length !== 1) throw authInvalid()
    })
  }
}
