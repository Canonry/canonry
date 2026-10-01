import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Type,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  validateToolArguments,
  type AssistantMessage,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
} from '@earendil-works/pi-ai'
import type { Agent, AgentMessage, AgentOptions, AgentTool } from '@earendil-works/pi-agent-core'
import { AppError } from '@ainyc/canonry-contracts'
import { agentSessions, agentToolEvents, createClient, llmUsageEvents, migrate, parseJsonColumn, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { registerAeroFaux, type AeroFaux } from './helpers/aero-faux.js'
import { aeroStreamFn, completeOnce } from '../src/agent/pi-models.js'
import { aeroTurnStatus, configureAeroRuntime, isRunFailureMessage, isSystemMessage, setAeroSystemPrompt } from '../src/agent/runtime.js'
import { createAeroSession, loadAeroSystemPrompt } from '../src/agent/session.js'
import { SessionRegistry, withoutPersistedToolDetails } from '../src/agent/session-registry.js'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import { mcpToAgentTool } from '../src/agent/mcp-to-agent-tool.js'
import { loadExternalMcpTools } from '../src/agent/remote-mcp.js'
import { AeroToolProfiles, AeroToolScopes, buildAeroStateTools } from '../src/agent/tools.js'
import { buildSkillDocTools } from '../src/agent/skill-tools.js'
import { buildViewerAeroTools } from '../src/agent/viewer-sessions.js'
import { aeroViewPrompt, buildAeroViewTool } from '../src/agent/view-context.js'
import { aeroProjectShape } from '../src/agent/project-shape.js'
import { getAgentProvider } from '../src/agent/providers.js'
import { toJsonSchema } from '../src/mcp/schema.js'
import type { CanonryMcpTool } from '../src/mcp/tool-registry.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

// Regression tests for the pi 0.67 -> 0.87 upgrade (@mariozechner -> @earendil-works)
// and later bumps. Each one pins a Canonry behavior the old runtime gave for free
// and the new one only keeps because Canonry now does it explicitly, or a pi
// behavior Canonry's own code depends on, driven through pi's real agent loop.

let directory: string
let db: DatabaseClient
let faux: AeroFaux

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-pi-upgrade-'))
  db = createClient(path.join(directory, 'data.db'))
  migrate(db)
  faux = registerAeroFaux({
    api: 'aero-pi-upgrade-test',
    provider: 'aero-pi-upgrade-test',
    models: [{ id: 'test' }, { id: 'small', maxTokens: 16_384 }, { id: 'large', maxTokens: 128_000 }],
  })
})

afterEach(() => {
  faux.unregister()
  fs.rmSync(directory, { recursive: true, force: true })
})

function config(providers: CanonryConfig['providers'] = { claude: { apiKey: 'anthropic-key' } }, extra: Partial<CanonryConfig> = {}): CanonryConfig {
  return { apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', providers, ...extra } as CanonryConfig
}

function insertProject(name = 'demo'): string {
  const id = `proj_${name}_${crypto.randomUUID()}`
  const now = new Date().toISOString()
  db.insert(projects).values({ id, name, displayName: name, canonicalDomain: `${name}.example.com`, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  return id
}

function sessionRow(projectId: string) {
  return db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
}

function systemMessages(messages: readonly unknown[]): unknown[] {
  return messages.filter(message => (message as { role?: string }).role === 'system')
}

/** A session on the faux model with an explicit tool list (eager, no toolkits). */
function fauxSession(tools: AgentTool[], limits?: { maxToolCalls: number; timeoutMs: number }): Agent {
  const agent = createAeroSession({ projectName: 'demo', client: {} as ApiClient, config: config(), systemPromptOverride: 'You are a test agent.', tools })
  agent.state.model = faux.getModel('test')!
  if (limits) configureAeroRuntime(agent, tools, limits, false)
  return agent
}

const TYPEBOX_KIND = Symbol.for('TypeBox.Kind')

describe('tool arguments', () => {
  it('coerces string numbers and booleans for MCP-adapted, remote, and native tools, and no Aero tool carries a TypeBox 0.x kind', async () => {
    // pi-ai skips its JSON-schema coercion for any schema carrying the old
    // @sinclair/typebox kind symbol, so a model that sends "5" for a number
    // would fail validation on every such tool.
    const handler = vi.fn(async (_client: ApiClient, _input: unknown) => ({ ok: true }))
    const mcpTool = {
      name: 'canonry_upgrade_probe',
      title: 'Upgrade probe',
      description: 'Test',
      access: 'read',
      tier: 'core',
      inputSchema: z.object({ project: z.string(), limit: z.number().int().optional(), flag: z.boolean().optional() }),
      inputJsonSchema: toJsonSchema(z.object({ project: z.string(), limit: z.number().int().optional(), flag: z.boolean().optional() }), 'canonry_upgrade_probe'),
      annotations: { readOnlyHint: true },
      openApiOperations: [],
      handler,
    } as unknown as CanonryMcpTool
    const adapted = mcpToAgentTool(mcpTool, { client: {} as ApiClient, projectName: 'demo' })
    const native: AgentTool = {
      name: 'native_probe',
      label: 'Native probe',
      description: 'Test',
      parameters: Type.Object({ limit: Type.Optional(Type.Number()), flag: Type.Optional(Type.Boolean()) }),
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
    }
    const [remote] = await loadExternalMcpTools([{ url: 'https://remote.example/mcp', token: 't' }], {
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'remote_probe', inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, flag: { type: 'boolean' } } }, annotations: { readOnlyHint: true } }] }),
        callTool: async () => ({}),
      }),
    })
    expect(remote).toBeDefined()
    const call = (name: string): ToolCall => ({ type: 'toolCall', id: `call-${name}`, name, arguments: { limit: '5', flag: 'true' } })
    for (const tool of [adapted, native, remote!]) {
      expect(validateToolArguments(tool as Tool, call(tool.name))).toEqual({ limit: 5, flag: true })
    }

    // The same coercion through the agent loop: the MCP handler receives numbers
    // and booleans, with the project injected.
    const agent = fauxSession([adapted])
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('canonry_upgrade_probe', { limit: '5', flag: 'true' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Probe')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![1]).toEqual({ project: 'demo', limit: 5, flag: true })

    // Every tool Aero can hold: operator scopes and profiles, viewer lane,
    // skill docs, the current-view reader, and the runtime's toolkit tools.
    const ctx = { client: {} as ApiClient, projectName: 'demo' }
    const runtimeAgent = fauxSession([])
    configureAeroRuntime(runtimeAgent, buildAeroStateTools(ctx, { scope: AeroToolScopes.all }), undefined, true)
    const everyTool = [
      ...buildAeroStateTools(ctx, { scope: AeroToolScopes.all }),
      ...buildAeroStateTools(ctx, { scope: AeroToolScopes.readOnly }),
      ...buildAeroStateTools(ctx, { scope: AeroToolScopes.all, profile: AeroToolProfiles.adsOperator }),
      ...buildViewerAeroTools(ctx.client, 'demo'),
      ...buildSkillDocTools(),
      buildAeroViewTool(ctx),
      ...runtimeAgent.state.tools,
      remote!,
    ]
    expect(everyTool.map(tool => tool.name)).toEqual(expect.arrayContaining(['aero_list_toolkits', 'aero_load_toolkit', 'aero_inspect_view', 'canonry_ads_operator_context']))
    // validateToolArguments checks the top-level schema for the kind symbol.
    const legacy = everyTool.filter(tool => Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)).map(tool => tool.name)
    expect(legacy).toEqual([])
  })
})

describe('turn limits', () => {
  it('runs the calls within the limit from one parallel batch, answers the rest with "Turn stopped." and ends without another model request', async () => {
    const execute = vi.fn(async (id: string) => ({ content: [{ type: 'text' as const, text: `ran ${id}` }], details: {} }))
    const check: AgentTool = { name: 'check', label: 'Check', description: 'Test', parameters: Type.Object({}), execute }
    const agent = fauxSession([check], { maxToolCalls: 2, timeoutMs: 10_000 })
    const ended: AgentMessage[][] = []
    agent.subscribe(event => { if (event.type === 'agent_end') ended.push(event.messages) })
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('check', {}, { id: 'first' }),
        fauxToolCall('check', {}, { id: 'second' }),
        fauxToolCall('check', {}, { id: 'third' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Should never be requested.'),
    ])
    await agent.prompt('Check three times')

    expect(execute.mock.calls.map(args => args[0])).toEqual(['first', 'second'])
    const results = agent.state.messages.filter(message => message.role === 'toolResult') as Array<{ toolCallId: string; isError: boolean; content: Array<{ text: string }> }>
    expect(results.map(result => [result.toolCallId, result.isError, result.content[0]!.text])).toEqual([
      ['first', false, 'ran first'],
      ['second', false, 'ran second'],
      ['third', true, 'Turn stopped.'],
    ])
    expect(faux.state.callCount).toBe(1)
    expect(faux.getPendingResponseCount()).toBe(1)
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'tool-limit', toolCalls: 2, modelCalls: 1 })
    // The limit is a clean stop, not a failed run.
    const withError = [...agent.state.messages, ...ended.flat()].filter(message => message.role === 'assistant' && (message as { errorMessage?: string }).errorMessage)
    expect(withError).toEqual([])
    expect(agent.state.errorMessage).toBeUndefined()
  })

  it('counts unknown-tool and invalid-argument attempts toward the tool limit', async () => {
    // AGENTS.md: "Count attempted calls, including invalid ones." A model that
    // keeps calling a tool that does not exist must still hit the limit.
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }], details: {} }))
    const check: AgentTool = { name: 'check', label: 'Check', description: 'Test', parameters: Type.Object({ limit: Type.Number() }), execute }
    const agent = fauxSession([check], { maxToolCalls: 2, timeoutMs: 10_000 })
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('missing_tool', {}, { id: 'unknown' }),
        fauxToolCall('check', { limit: 'many' }, { id: 'invalid' }),
        fauxToolCall('check', { limit: 1 }, { id: 'valid' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Try three calls')

    expect(execute).not.toHaveBeenCalled()
    expect(aeroTurnStatus(agent)).toMatchObject({ reason: 'tool-limit', toolCalls: 2, modelCalls: 1 })
    const valid = agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'valid') as { content: Array<{ text: string }> } | undefined
    expect(valid?.content[0]!.text).toBe('Turn stopped.')
  })
})

describe('tool results', () => {
  it('flags a result a tool returns with isError on tool_execution_end, in afterToolCall and on the toolResult message', async () => {
    // pi-agent-core 1.0 honours `isError: true` on a returned result; 0.87 only
    // flagged a thrown error. Canonry's tool ledger and the toolkit loader read
    // the flag in afterToolCall, and the dashboard and CLI read it on the
    // event and the stored message.
    const projectId = insertProject()
    const refuse: AgentTool = {
      name: 'refuse',
      label: 'Refuse',
      description: 'Test',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'Upstream refused.' }], details: {}, isError: true }),
    }
    const agent = createAeroSession({ projectName: 'demo', projectId, db, client: {} as ApiClient, config: config(), systemPromptOverride: 'You are a test agent.', tools: [refuse] })
    agent.state.model = faux.getModel('test')!
    const hooked: boolean[] = []
    const after = agent.afterToolCall
    agent.afterToolCall = async (event, signal) => {
      hooked.push(event.isError)
      return after?.(event, signal)
    }
    const ended: boolean[] = []
    agent.subscribe(event => { if (event.type === 'tool_execution_end') ended.push(event.isError) })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('refuse', {}, { id: 'refused' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('It was refused.'),
    ])
    await agent.prompt('Try it')

    expect(ended).toEqual([true])
    expect(hooked).toEqual([true])
    const results = agent.state.messages.filter(message => message.role === 'toolResult')
    expect(results).toMatchObject([{ toolCallId: 'refused', isError: true, content: [{ type: 'text', text: 'Upstream refused.' }] }])
    expect(db.select().from(agentToolEvents).all().map(row => [row.toolCallId, row.status])).toEqual([['refused', 'error']])
  })

  it('still words a call to an unknown tool the way Canonry looks for, so the reply says what to do instead', async () => {
    // explainMissingTool (runtime.ts) rewrites pi's "Tool X not found" by
    // matching that exact text. If pi rewords it, the model gets the bare
    // reply again and retries the same name.
    const check: AgentTool = { name: 'check', label: 'Check', description: 'Test', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'ran' }], details: {} }) }
    const agent = fauxSession([check])
    const fromPi: string[] = []
    agent.subscribe(event => {
      if (event.type === 'tool_execution_end') fromPi.push(...(event.result.content as Array<{ text: string }>).map(block => block.text))
    })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('missing_tool', {}, { id: 'unknown' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Call a tool that does not exist')

    expect(fromPi).toEqual(['Tool missing_tool not found'])
    const unknown = agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'unknown')
    expect(unknown).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'missing_tool is not available in this conversation. Use only the tools listed for you.' }],
    })
  })
})

describe('system messages', () => {
  let app: FastifyInstance
  let registry: SessionRegistry
  let projectId: string

  beforeEach(async () => {
    projectId = insertProject()
    registry = new SessionRegistry({ db, client: {} as ApiClient, config: config() })
    registry.getOrCreate('demo').state.model = faux.getModel('test')!
    app = Fastify()
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
      return reply.status(500).send(error)
    })
    registerAgentRoutes(app, { db, sessionRegistry: registry })
    await app.ready()
  })

  afterEach(async () => { await app.close() })

  async function promptTurn(prompt: string): Promise<{ body: string; events: Array<{ type: string; messages?: unknown[] }> }> {
    const response = await app.inject({ method: 'POST', url: '/projects/demo/agent/prompt', payload: { prompt } })
    expect(response.statusCode).toBe(200)
    return { body: response.body, events: response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) }
  }

  it('keeps one leading system message with the prompt Canonry set, never persists or streams it, and replaces it without accumulating', async () => {
    const seen: string[] = []
    faux.setResponses([
      context => {
        seen.push(getCurrentSystemPrompt(context.messages))
        return fauxAssistantMessage(fauxToolCall('list_skill_docs', {}), { stopReason: 'toolUse' })
      },
      context => {
        seen.push(getCurrentSystemPrompt(context.messages))
        return fauxAssistantMessage('Here are the docs.')
      },
    ])
    const turn = await promptTurn('What docs do you have?')

    const expected = registry.buildHydratedSystemPrompt(projectId, loadAeroSystemPrompt()) + aeroProjectShape(db, projectId).prompt + aeroViewPrompt(undefined)
    expect(seen).toEqual([expected, expected])
    const agent = registry.getOrCreate('demo')
    const inMemory = agent.state.messages
    expect(inMemory[0]!.role).toBe('system')
    expect(systemMessages(inMemory)).toHaveLength(1)
    expect(getCurrentSystemPrompt(inMemory)).toBe(expected)
    expect(inMemory.slice(1).map(message => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])

    // Not persisted, not on the wire, not in the transcript read.
    expect(systemMessages(withoutPersistedToolDetails(inMemory))).toEqual([])
    expect(withoutPersistedToolDetails(inMemory)).toHaveLength(4)
    const stored = parseJsonColumn<AgentMessage[]>(sessionRow(projectId)!.messages, [])
    expect(stored.map(message => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    expect(turn.body).not.toContain('"role":"system"')
    expect(turn.events.find(event => event.type === 'agent_end')!.messages!.map(message => (message as { role: string }).role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    const transcript = (await app.inject('/projects/demo/agent/transcript')).json() as { messages: Array<{ role: string }> }
    expect(transcript.messages.map(message => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])

    // setAeroSystemPrompt rewrites the leading message; the conversation and
    // the declared tools are untouched, and a second call does not stack.
    const conversation = inMemory.slice(1)
    const toolNames = agent.state.tools.map(tool => tool.name)
    setAeroSystemPrompt(agent, 'Replacement prompt')
    setAeroSystemPrompt(agent, 'Second replacement')
    expect(systemMessages(agent.state.messages)).toHaveLength(1)
    expect(agent.state.messages[0]!.role).toBe('system')
    expect(getCurrentSystemPrompt(agent.state.messages)).toBe('Second replacement')
    expect(agent.state.systemPrompt).toBe('Second replacement')
    expect(agent.state.messages.slice(1)).toEqual(conversation)
    expect(getCurrentTools(agent.state.messages).map(tool => tool.name)).toEqual(toolNames)
  })

  it('folds tool announcements from a toolkit load back into one leading system message on the next turn', async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('aero_load_toolkit', { toolkit: 'monitoring' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Loaded.'),
    ])
    const turn = await promptTurn('Load monitoring')
    expect(turn.body).not.toContain('"role":"system"')
    const stored = parseJsonColumn<AgentMessage[]>(sessionRow(projectId)!.messages, [])
    expect(systemMessages(stored)).toEqual([])

    const agent = await registry.acquireForTurn('demo')
    const expected = registry.buildHydratedSystemPrompt(projectId, loadAeroSystemPrompt()) + aeroProjectShape(db, projectId).prompt
    expect(agent.state.messages[0]!.role).toBe('system')
    expect(systemMessages(agent.state.messages)).toHaveLength(1)
    expect(getCurrentSystemPrompt(agent.state.messages)).toBe(expected)
    // A new turn starts from its own allowed set; the loaded toolkit is gone.
    expect(getCurrentTools(agent.state.messages).map(tool => tool.name)).toEqual(agent.state.tools.map(tool => tool.name))
    expect(agent.state.tools.map(tool => tool.name)).not.toContain('canonry_insights_list')
  })
})

describe('request defaults', () => {
  it('streams with two retries, an output cap of min(model max, 32000) and a canonry User-Agent unless the caller says otherwise', async () => {
    const seen: Array<{ model: string; options: SimpleStreamOptions | undefined }> = []
    const record = (text: string) => (_context: unknown, options: SimpleStreamOptions | undefined, _state: unknown, model: { id: string }) => {
      seen.push({ model: model.id, options })
      return fauxAssistantMessage(text)
    }
    const expectDefaults = (entry: { options: SimpleStreamOptions | undefined }, maxTokens: number) => {
      expect(entry.options?.maxRetries).toBe(2)
      expect(entry.options?.maxTokens).toBe(maxTokens)
      expect(entry.options?.headers?.['User-Agent']).toBe('canonry')
    }

    // Through the Agent, on the default stream function.
    const agent = createAeroSession({ projectName: 'demo', client: {} as ApiClient, config: config(), systemPromptOverride: 'Test.', tools: [] })
    agent.state.model = faux.getModel('large')!
    faux.setResponses([record('large turn')])
    await agent.prompt('Hello')
    agent.state.model = faux.getModel('small')!
    faux.setResponses([record('small turn')])
    await agent.prompt('Hello again')
    expect(seen.map(entry => entry.model)).toEqual(['large', 'small'])
    expectDefaults(seen[0]!, 32_000)
    expectDefaults(seen[1]!, 16_384)

    // One-shot calls (compaction, recommendation explanations) get the same defaults.
    const context = { systemPrompt: 'Summarize.', messages: [{ role: 'user' as const, content: 'Text', timestamp: Date.now() }] }
    faux.setResponses([record('summary')])
    await completeOnce(faux.getModel('large')!, context, { apiKey: 'key' })
    expectDefaults(seen[2]!, 32_000)

    // An explicit caller value wins over every default.
    faux.setResponses([record('override')])
    const stream = await aeroStreamFn(faux.getModel('large')!, normalizeContext(context), { maxRetries: 0, maxTokens: 1_000, headers: { 'User-Agent': 'custom' } })
    await stream.result()
    expect(seen[3]!.options).toMatchObject({ maxRetries: 0, maxTokens: 1_000, headers: { 'User-Agent': 'custom' } })
  })
})

describe('stored model fallback', () => {
  function insertZaiSession(projectId: string, modelId: string): void {
    const now = new Date().toISOString()
    db.insert(agentSessions).values({
      id: crypto.randomUUID(),
      projectId,
      systemPrompt: 'system',
      modelProvider: 'zai',
      modelId,
      messages: '[]',
      followUpQueue: '[]',
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  it('moves a stored model id the catalog dropped to the provider default, but still refuses a requested or pinned one', async () => {
    expect(getAgentProvider('zai').defaultModel).toBe('glm-5.2')
    const projectId = insertProject()
    insertZaiSession(projectId, 'glm-5.1')
    const registry = new SessionRegistry({ db, client: {} as ApiClient, config: config({ zai: { apiKey: 'zai-key' } }) })

    const agent = await registry.acquireForTurn('demo')
    expect(agent.state.model).toMatchObject({ provider: 'zai', id: 'glm-5.2' })
    expect(sessionRow(projectId)).toMatchObject({ modelProvider: 'zai', modelId: 'glm-5.2' })

    // An explicit request is kept as given, so a retired id fails loudly on a
    // live session and leaves the turn model and the row alone.
    await expect(registry.acquireForTurn('demo', { provider: 'zai', modelId: 'glm-5.1' })).rejects.toThrow(/glm-5\.1/)
    expect(agent.state.model).toMatchObject({ provider: 'zai', id: 'glm-5.2' })
    expect(sessionRow(projectId)).toMatchObject({ modelProvider: 'zai', modelId: 'glm-5.2' })
    expect(registry.isBusy('demo')).toBe(false)

    // ...and on a cold one.
    const cold = new SessionRegistry({ db, client: {} as ApiClient, config: config({ zai: { apiKey: 'zai-key' } }) })
    await expect(cold.acquireForTurn('demo', { provider: 'zai', modelId: 'glm-5.1' })).rejects.toThrow(/glm-5\.1/)

    // A pinned agent.model is kept as given too.
    const pinned = new SessionRegistry({ db, client: {} as ApiClient, config: config({ zai: { apiKey: 'zai-key' } }, { agent: { provider: 'zai', model: 'glm-5.1' } } as Partial<CanonryConfig>) })
    await expect(pinned.acquireForTurn('demo')).rejects.toThrow(/glm-5\.1/)
  })
})

describe('createAeroSession', () => {
  it('builds without a streamFn and streams through the Aero model collection', async () => {
    // pi-agent-core 0.81 made `streamFn` required; Canonry supplies aeroStreamFn.
    let agent!: Agent
    expect(() => {
      agent = createAeroSession({ projectName: 'demo', client: {} as ApiClient, config: config(), systemPromptOverride: 'Test.' })
    }).not.toThrow()
    expect(agent.streamFunction).toEqual(expect.any(Function))
    agent.state.model = faux.getModel('test')!
    faux.setResponses([fauxAssistantMessage('Hello from Aero.')])
    await agent.prompt('Hello')
    expect(faux.state.callCount).toBe(1)
    const last = agent.state.messages.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
    expect(last.role).toBe('assistant')
    expect(last.content).toEqual([{ type: 'text', text: 'Hello from Aero.' }])
  })

  it('gets thinkingLevel "off" stamped on every streamed answer, since Canonry never sets reasoning', async () => {
    // pi-agent-core 1.0 records the requested thinking level on each answer it
    // streams. The field reaches the transcript, storage and SSE frames, so the
    // viewer redaction in agent-routes.ts has to keep hiding it.
    const check: AgentTool = { name: 'check', label: 'Check', description: 'Test', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'ran' }], details: {} }) }
    const agent = fauxSession([check])
    const streamed: AgentMessage[] = []
    agent.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'assistant') streamed.push(event.message) })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('check', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    await agent.prompt('Check')

    expect(agent.state.thinkingLevel).toBe('off')
    const levels = (messages: AgentMessage[]) => messages.filter(message => message.role === 'assistant').map(message => (message as AssistantMessage).thinkingLevel)
    expect(levels(streamed)).toEqual(['off', 'off'])
    expect(levels(agent.state.messages)).toEqual(['off', 'off'])
  })
})

describe('run-failure placeholder detection', () => {
  const usage = (totalTokens: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })

  it('matches only the placeholder pi appends when a run throws or is aborted', () => {
    // Agent.handleRunFailure: one empty text part, no usage, no responseId.
    const placeholder = { role: 'assistant', content: [{ type: 'text', text: '' }], usage: usage(0), stopReason: 'aborted', errorMessage: 'This operation was aborted', timestamp: 1 }
    expect(isRunFailureMessage(placeholder)).toBe(true)
    expect(isRunFailureMessage({ ...placeholder, stopReason: 'error' })).toBe(true)
  })

  it('keeps real provider errors, which the dashboard and usage ledger still receive', () => {
    // OpenAI Responses opens an empty text part once an output item starts, and
    // sets responseId before that; an error then leaves the same shape.
    const openaiError = { role: 'assistant', content: [{ type: 'text', text: '' }], usage: usage(0), stopReason: 'error', errorMessage: 'server_error', responseId: 'resp_1', timestamp: 1 }
    // Anthropic/HTTP failures before any output: no content at all.
    const httpError = { role: 'assistant', content: [], usage: usage(0), stopReason: 'error', errorMessage: '401 invalid x-api-key', timestamp: 1 }
    const partialAnswer = { role: 'assistant', content: [{ type: 'text', text: 'Partial' }], usage: usage(12), stopReason: 'aborted', timestamp: 1 }
    for (const message of [openaiError, httpError, partialAnswer]) expect(isRunFailureMessage(message)).toBe(false)
  })

  it('matches what pi streams when a run fails before any answer, but not a provider error that carries a responseId', async () => {
    const projectId = insertProject()
    async function turn(setup: (agent: Agent) => void, streamFn?: AgentOptions['streamFn']): Promise<AgentMessage[]> {
      const agent = createAeroSession({ projectName: 'demo', projectId, db, client: {} as ApiClient, config: config(), systemPromptOverride: 'You are a test agent.', tools: [], streamFn })
      agent.state.model = faux.getModel('test')!
      setup(agent)
      // The SSE route filters on message_end, the usage ledger on turn_end.
      const ended: AgentMessage[] = []
      agent.subscribe(event => { if ((event.type === 'message_end' || event.type === 'turn_end') && event.message.role === 'assistant') ended.push(event.message) })
      await agent.prompt('Hello')
      return ended
    }
    const outcome = (messages: AgentMessage[]) => messages.map(message => {
      const { stopReason, errorMessage, responseId } = message as AssistantMessage
      return { stopReason, errorMessage, responseId, runFailure: isRunFailureMessage(message) }
    })

    // Stopped before the first model request: Canonry's stream wrapper throws on the aborted signal.
    const stopped = await turn(agent => agent.subscribe(event => { if (event.type === 'agent_start') agent.abort() }))
    // A stream function that throws instead of answering.
    const thrown = await turn(() => {}, () => { throw new Error('stream setup failed') })
    expect(faux.state.callCount).toBe(0)
    const placeholder = (stopReason: string, errorMessage: string) => ({ stopReason, errorMessage, responseId: undefined, runFailure: true })
    expect(outcome(stopped)).toEqual([placeholder('aborted', 'This operation was aborted'), placeholder('aborted', 'This operation was aborted')])
    expect(outcome(thrown)).toEqual([placeholder('error', 'stream setup failed'), placeholder('error', 'stream setup failed')])
    // No provider call was made, so nothing reaches the usage ledger.
    expect(db.select().from(llmUsageEvents).all()).toEqual([])

    // An OpenAI Responses failure after the response opened: the same empty
    // text part and zero usage, told apart only by its responseId. The faux
    // provider always estimates usage, so this stream is scripted.
    const providerError = await turn(() => {}, model => {
      const stream = createAssistantMessageEventStream()
      const error: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider, model: model.id,
        responseId: 'resp_1', usage: usage(0), stopReason: 'error', errorMessage: 'server_error', timestamp: Date.now(),
      }
      stream.push({ type: 'error', reason: 'error', error })
      stream.end(error)
      return stream
    })
    const providerFailure = { stopReason: 'error', errorMessage: 'server_error', responseId: 'resp_1', runFailure: false }
    expect(outcome(providerError)).toEqual([providerFailure, providerFailure])
    expect(db.select().from(llmUsageEvents).all().map(row => [row.responseId, row.totalTokens])).toEqual([['resp_1', 0]])
  })

  it('treats only role system as a system message', () => {
    expect(isSystemMessage({ role: 'system', content: 'prompt' })).toBe(true)
    for (const message of [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }, null, 'system']) expect(isSystemMessage(message)).toBe(false)
  })
})
