import { z } from 'zod'
import { Type } from '@sinclair/typebox'
import type { Agent, AgentTool } from '@mariozechner/pi-agent-core'
import { agentTurnLimitsSchema, type AgentTurnLimits } from '@ainyc/canonry-contracts'
import { canonryMcpTools } from '../mcp/tool-registry.js'
import { CANONRY_MCP_TOOLKITS } from '../mcp/toolkits.js'
import { truncateToolResult } from './mcp-to-agent-tool.js'

const DISCOVER = 'aero_list_toolkits'
/**
 * Most tools one model request may carry. Several providers refuse a request
 * with more than 128 functions, so loading a toolkit unloads the oldest others
 * rather than cross it. Core and pinned tools are never unloaded.
 */
export const MAX_VISIBLE_TOOLS = 128
const LOAD = 'aero_load_toolkit'
const metadata = new Map(canonryMcpTools.map(tool => [tool.name as string, tool]))

interface Runtime {
  allowed: AgentTool[]
  loaded: Set<string>
  limits: AgentTurnLimits
  calls: number
  rounds: number
  startedAt: number
  finishedAt?: number
  reason: 'completed' | 'stopped' | 'tool-limit' | 'time-limit' | 'error'
  timer?: ReturnType<typeof setTimeout>
  progressive: boolean
  /** Tools a progressive turn keeps visible without loading their toolkit. */
  pinned: Set<string>
}
const runtimes = new WeakMap<Agent, Runtime>()

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: truncateToolResult(value) }], details: value }
}

function visibleTools(runtime: Runtime): AgentTool[] {
  if (!runtime.progressive) return runtime.allowed
  const visible = runtime.allowed.filter(tool => {
    const entry = metadata.get(tool.name)
    return !entry || entry.tier === 'core' || runtime.pinned.has(tool.name) || runtime.loaded.has(entry.tier)
  })
  const available = CANONRY_MCP_TOOLKITS.filter(kit => runtime.allowed.some(tool => metadata.get(tool.name)?.tier === kit.name))
  return [...visible, {
    name: DISCOVER,
    label: 'Find relevant tools',
    description: 'List available toolkits and when to load them. Only tools allowed for this turn are discoverable.',
    parameters: Type.Object({}),
    execute: async () => result(available.map(kit => ({ ...kit, loaded: runtime.loaded.has(kit.name) }))),
  }, {
    name: LOAD,
    label: 'Load relevant tools',
    description: 'Load one toolkit before calling its tools. Idempotent within this turn. Never grants additional permissions.',
    parameters: Type.Object({ toolkit: Type.String({ enum: available.map(kit => kit.name) }) }),
    execute: async (_id: string, input: unknown) => {
      const args = z.object({ toolkit: z.string() }).parse(input)
      if (!available.some(kit => kit.name === args.toolkit)) throw new Error('Toolkit is unavailable for this turn.')
      // Re-adding moves the toolkit to the newest position, so eviction below
      // drops the ones loaded longest ago.
      runtime.loaded.delete(args.toolkit)
      runtime.loaded.add(args.toolkit)
      const unloaded: string[] = []
      for (const older of [...runtime.loaded]) {
        if (visibleTools(runtime).length <= MAX_VISIBLE_TOOLS || older === args.toolkit) continue
        runtime.loaded.delete(older)
        unloaded.push(older)
      }
      return result({
        tools: runtime.allowed.filter(tool => metadata.get(tool.name)?.tier === args.toolkit).map(tool => ({ name: tool.name, description: tool.description })),
        ...(unloaded.length > 0 ? { unloaded, note: `Unloaded ${unloaded.join(', ')} to stay within the tool limit; load again if needed.` } : {}),
      })
    },
  }]
}

/**
 * pi answers a call to a tool outside the visible list with a bare
 * "Tool X not found". A model that learned a tool's name from a skill doc
 * then retries or gives up. Say what to do instead: which toolkit to load when
 * the tool is allowed but not loaded yet, or that it is not available at all.
 */
function explainMissingTool(runtime: Runtime, message: { isError?: boolean; content?: unknown }): void {
  if (!message.isError || !Array.isArray(message.content)) return
  const first = message.content[0] as { type?: string; text?: string } | undefined
  const name = first?.type === 'text' ? /^Tool (\S+) not found$/.exec(first.text ?? '')?.[1] : undefined
  if (!name) return
  let text: string
  if (!runtime.progressive) {
    // No toolkits to load in this turn: every tool it may use is already listed.
    text = `${name} is not available in this conversation. Use only the tools listed for you.`
  } else {
    const toolkit = metadata.get(name)?.tier
    text = runtime.allowed.some(tool => tool.name === name) && toolkit && toolkit !== 'core'
      ? `${name} is not loaded yet. Call ${LOAD} with toolkit "${toolkit}", then call ${name} again.`
      : `${name} is not available in this conversation. Use ${DISCOVER} to see the tools you can load.`
  }
  message.content = [{ type: 'text', text }]
}

/** Rebuild from the already-authorized catalog every turn, including scope downgrades. */
export function configureAeroRuntime(agent: Agent, allowed: AgentTool[], limits?: AgentTurnLimits, progressive = true, pinned: readonly string[] = []): void {
  let runtime = runtimes.get(agent)
  if (!runtime) {
    runtime = { allowed, loaded: new Set(), limits: agentTurnLimitsSchema.parse(limits ?? {}), calls: 0, rounds: 0, startedAt: 0, reason: 'completed', progressive, pinned: new Set(pinned) }
    runtimes.set(agent, runtime)
    const state = runtime
    const stream = agent.streamFn
    agent.streamFn = (model, context, options) => {
      options?.signal?.throwIfAborted()
      state.rounds++
      return stream(model, context, options)
    }
    const before = agent.beforeToolCall
    const after = agent.afterToolCall
    agent.beforeToolCall = async (event, signal) => {
      if (signal?.aborted) return { block: true, reason: 'Turn stopped.' }
      return before?.(event, signal)
    }
    agent.afterToolCall = async (event, signal) => {
      const override = await after?.(event, signal)
      if (event.toolCall.name === LOAD && !event.isError) {
        const tools = visibleTools(state)
        // pi takes a snapshot at prompt start. Update the active loop as well
        // as the public state, so the NEXT model call receives loaded schemas.
        event.context.tools = tools
        agent.state.tools = tools
      }
      return override
    }
    const toolStarts = new Map<string, number>()
    agent.subscribe(event => {
      if (event.type === 'tool_execution_start') {
        if (state.calls >= state.limits.maxToolCalls) {
          state.reason = 'tool-limit'
          agent.abort()
        } else if (!agent.signal?.aborted) {
          state.calls++
          toolStarts.set(event.toolCallId, Date.now())
        }
      }
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        const message = event.message
        explainMissingTool(state, message)
        const startedAt = toolStarts.get(message.toolCallId)
        Object.assign(message, {
          aeroToolLabel: state.allowed.find(tool => tool.name === message.toolName)?.label,
          ...(startedAt === undefined ? {} : { aeroDurationMs: Date.now() - startedAt }),
        })
        toolStarts.delete(event.message.toolCallId)
      }
      if (event.type === 'agent_start') {
        toolStarts.clear()
        state.calls = 0
        state.rounds = 0
        state.reason = 'completed'
        state.startedAt = Date.now()
        state.finishedAt = undefined
        state.timer = setTimeout(() => { state.reason = 'time-limit'; agent.abort() }, state.limits.timeoutMs)
        state.timer.unref()
      } else if (event.type === 'agent_end') {
        state.finishedAt = Date.now()
        clearTimeout(state.timer)
        if (state.reason === 'completed' && agent.signal?.aborted) state.reason = 'stopped'
        if (state.reason === 'completed' && agent.state.errorMessage) state.reason = 'error'
      }
    })
  }
  runtime.allowed = allowed
  runtime.loaded = new Set()
  runtime.limits = agentTurnLimitsSchema.parse(limits ?? {})
  runtime.progressive = progressive
  runtime.pinned = new Set(pinned)
  agent.state.tools = visibleTools(runtime)
}

export function aeroTurnStatus(agent: Agent) {
  const runtime = runtimes.get(agent)
  return runtime ? {
    reason: runtime.reason,
    toolCalls: runtime.calls,
    modelCalls: runtime.rounds,
    durationMs: Math.max(0, (runtime.finishedAt ?? Date.now()) - runtime.startedAt),
    limits: runtime.limits,
  } : undefined
}
