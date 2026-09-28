import { z } from 'zod'
import { Type } from '@sinclair/typebox'
import type { Agent, AgentTool } from '@mariozechner/pi-agent-core'
import type { AssistantMessage, AssistantMessageEventStream } from '@mariozechner/pi-ai'
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
  /** The misspelled name the model wrote, by tool call id, for calls renamed to a visible tool. */
  corrected: Map<string, string>
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

/** How far a misspelled tool name may be from the real one: two swapped, dropped, extra or wrong letters. */
const MAX_NAME_EDITS = 2
/** Most near names a "did you mean" reply lists before it stops guessing. */
const MAX_NAME_SUGGESTIONS = 3

/** Optimal string alignment distance: Levenshtein plus adjacent transpositions. */
function nameDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > MAX_NAME_EDITS) return MAX_NAME_EDITS + 1
  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      let value = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2]! + 1)
      row.push(value)
    }
    before = previous
    previous = row
  }
  return previous[b.length]!
}

/** Short names get one edit, so a two-letter change cannot turn one word into another. */
function withinEdits(a: string, b: string): boolean {
  return nameDistance(a, b) <= (Math.min(a.length, b.length) >= 10 ? MAX_NAME_EDITS : 1)
}

/** The name after its first underscore-delimited prefix (`canonry_`, `aero_`). */
function afterPrefix(name: string): string {
  return name.slice(name.indexOf('_') + 1)
}

/**
 * Known tool names a misspelling is close to: within two edits of the whole
 * name, or of the name after its prefix (so a garbled `canonry_` still
 * resolves). A name that is itself known matches only itself.
 */
function nearToolNames(name: string, known: Iterable<string>): string[] {
  const wanted = name.trim().toLowerCase()
  const matches: string[] = []
  for (const candidate of known) {
    if (candidate === wanted) return [candidate]
    if (withinEdits(wanted, candidate) || withinEdits(afterPrefix(wanted), afterPrefix(candidate))) matches.push(candidate)
  }
  return matches
}

/**
 * Whether a call may be renamed to this tool without the model naming it
 * exactly. Only reads: the registry's `access`, plus this runtime's own toolkit
 * tools, which only change what is visible. A tool whose access is unknown
 * counts as a write.
 */
function isReadTool(name: string): boolean {
  return name === DISCOVER || name === LOAD || metadata.get(name)?.access === 'read'
}

/**
 * Some models misspell tool names (`canrony_...` for `canonry_...`). pi looks
 * the tool up before any hook runs and answers "Tool X not found", so the call
 * has to be renamed in the assistant message itself, before pi prepares it.
 * Rename only to the one visible tool the name is close to, only when no
 * other known tool (visible, allowed or in the registry) is as close, and only
 * when that tool is a read. A misspelled write is left for pi to refuse, and
 * the "did you mean" reply makes the model call it again by its exact name.
 */
function correctToolNames(runtime: Runtime, message: AssistantMessage, visible: ReadonlySet<string>): void {
  let known: Set<string> | undefined
  for (const block of message.content) {
    if (block.type !== 'toolCall' || visible.has(block.name)) continue
    known ??= new Set([...metadata.keys(), ...runtime.allowed.map(tool => tool.name), ...visible])
    const matches = nearToolNames(block.name, known)
    if (matches.length !== 1 || !visible.has(matches[0]!) || !isReadTool(matches[0]!)) continue
    runtime.corrected.set(block.id, block.name)
    block.name = matches[0]!
  }
}

/** Rename misspelled calls in the final message, which is what pi executes and stores. */
function withCorrectedToolNames(runtime: Runtime, response: AssistantMessageEventStream, visible: ReadonlySet<string>): AssistantMessageEventStream {
  const result = response.result.bind(response)
  response.result = async () => {
    const message = await result()
    correctToolNames(runtime, message, visible)
    return message
  }
  return response
}

/**
 * A reply for a name that is not a tool but is close to one this turn may
 * use. Names only allowed tools, so a near miss never reveals one that is not.
 */
function suggestToolName(runtime: Runtime, name: string): string | undefined {
  const visible = visibleTools(runtime).map(tool => tool.name)
  const matches = nearToolNames(name, new Set([...visible, ...runtime.allowed.map(tool => tool.name)]))
  if (matches.length === 0 || matches.length > MAX_NAME_SUGGESTIONS || matches.includes(name)) return undefined
  if (matches.length > 1) return `${name} is not a tool. Did you mean one of: ${matches.join(', ')}? Call the one you meant by its exact name.`
  const match = matches[0]!
  const toolkit = metadata.get(match)?.tier
  return visible.includes(match) || !toolkit
    ? `${name} is not a tool. Did you mean ${match}? Call it again by that exact name.`
    : `${name} is not a tool. Did you mean ${match}? Call ${LOAD} with toolkit "${toolkit}", then call ${match}.`
}

/**
 * pi answers a call to a tool outside the visible list with a bare
 * "Tool X not found". A model that learned a tool's name from a skill doc
 * then retries or gives up. Say what to do instead: the exact name when it
 * misspelled one, which toolkit to load when the tool is allowed but not
 * loaded yet, or that it is not available at all.
 */
function explainMissingTool(runtime: Runtime, message: { isError?: boolean; content?: unknown }): void {
  if (!message.isError || !Array.isArray(message.content)) return
  const first = message.content[0] as { type?: string; text?: string } | undefined
  const name = first?.type === 'text' ? /^Tool (\S+) not found$/.exec(first.text ?? '')?.[1] : undefined
  if (!name) return
  let text: string
  const suggestion = suggestToolName(runtime, name)
  if (suggestion) {
    text = suggestion
  } else if (!runtime.progressive) {
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
    runtime = { allowed, loaded: new Set(), limits: agentTurnLimitsSchema.parse(limits ?? {}), calls: 0, rounds: 0, startedAt: 0, reason: 'completed', progressive, pinned: new Set(pinned), corrected: new Map() }
    runtimes.set(agent, runtime)
    const state = runtime
    const stream = agent.streamFn
    agent.streamFn = (model, context, options) => {
      options?.signal?.throwIfAborted()
      state.rounds++
      const visible = new Set((context.tools ?? []).map(tool => tool.name))
      const response = stream(model, context, options)
      return response instanceof Promise
        ? response.then(ready => withCorrectedToolNames(state, ready, visible))
        : withCorrectedToolNames(state, response, visible)
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
        const requested = state.corrected.get(message.toolCallId)
        Object.assign(message, {
          aeroToolLabel: state.allowed.find(tool => tool.name === message.toolName)?.label,
          ...(startedAt === undefined ? {} : { aeroDurationMs: Date.now() - startedAt }),
          ...(requested === undefined ? {} : { aeroRequestedToolName: requested }),
        })
        toolStarts.delete(event.message.toolCallId)
        state.corrected.delete(message.toolCallId)
      }
      if (event.type === 'agent_start') {
        toolStarts.clear()
        state.corrected.clear()
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
