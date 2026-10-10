import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Agent, AgentTool } from '@earendil-works/pi-agent-core'
import {
  Type,
  createInitialSystemMessage,
  getCurrentTools,
  toToolDeclaration,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import { agentTurnLimitsSchema, MeasurementPortfolioLists, type AgentTurnLimits } from '@ainyc/canonry-contracts'
import { canonryMcpTools, CanonryMcpToolNames } from '../mcp/tool-registry.js'
import { CANONRY_MCP_TOOLKITS } from '../mcp/toolkits.js'
import { isStoredPageReadTool, isStoredReadTool, truncateToolResult } from './mcp-to-agent-tool.js'

const DISCOVER = 'aero_list_toolkits'
/**
 * Most tools one model request may carry. Several providers refuse a request
 * with more than 128 functions, so loading a toolkit unloads the oldest others
 * rather than cross it. Core and pinned tools are never unloaded.
 */
export const MAX_VISIBLE_TOOLS = 128
const LOAD = 'aero_load_toolkit'
const metadata = new Map(canonryMcpTools.map(tool => [tool.name as string, tool]))

const PAGE_REFERENCE_PREFIX = 'aero-page:'
const PAGE_SIZE_PARAMS = new Set(['limit', 'queryLimit', 'attemptLimit'])
/** Recognized native stored-read page owners and their public request parameters. */
const PAGE_CURSORS = [
  { owner: [], key: 'nextCursor', parameter: 'cursor' },
  { owner: ['properties'], key: 'nextCursor', parameter: 'cursor' },
  { owner: ['queryPage'], key: 'nextCursor', parameter: 'queryCursor' },
  { owner: [], key: 'nextAttemptCursor', parameter: 'attemptCursor' },
] as const
type ToolResult = Awaited<ReturnType<AgentTool['execute']>>
interface PageReference {
  tool: AgentTool
  token: string
  parameter: string
  params: Record<string, unknown>
  selection: Record<string, unknown>
}

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
  deadlineTimer?: ReturnType<typeof setTimeout>
  research?: AbortController
  hardDeadline: boolean
  memo: Map<string, { id: string; value: Promise<Awaited<ReturnType<AgentTool['execute']>>> }>
  pageReferences: Map<string, PageReference>
  pageNamespace: string
  pageTurn: number
  progressive: boolean
  /** Tools a progressive turn keeps visible without loading their toolkit. */
  pinned: Set<string>
  /** The misspelled name the model wrote, by tool call id, for calls renamed to a visible tool. */
  corrected: Map<string, string>
  /** Set once a bounded turn has been asked for its final answer. */
  wrapUp: boolean
  usage: AeroTurnUsage
}
const runtimes = new WeakMap<Agent, Runtime>()

/**
 * What one turn's model calls reported and how many of its tool calls failed,
 * for outcome telemetry. Server-side only: `aero_turn_status` is streamed to
 * viewers, who never see cost.
 */
export interface AeroTurnUsage {
  /** Model calls that came back with a response, as `llm_usage_events` records them. */
  responses: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number
  /** Counted tool calls that returned an error; calls the turn's limits blocked are not. */
  toolErrors: number
}

function emptyTurnUsage(): AeroTurnUsage {
  return { responses: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, toolErrors: 0 }
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Sent with every tool removed to a turn that used its tool budget, so what
 * it already read becomes an answer instead of an empty reply.
 */
export const TOOL_LIMIT_WRAP_UP =
  'This turn has used its tool budget, and no tools are available now. Answer the question from the tool results above: '
  + 'give what they establish with their numbers, say plainly which parts you could not check, '
  + 'and suggest one narrower question the user could ask next.'

const TIME_LIMIT_WRAP_UP = TOOL_LIMIT_WRAP_UP.replace('used its tool budget', 'used its research time budget')

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: truncateToolResult(value) }], details: value }
}

/** Native schema defaults make omitted and explicitly defaulted scope equivalent. */
function pageDefaults(tool: AgentTool, params: Record<string, unknown>): Record<string, unknown> {
  const filled = { ...params }
  for (const [key, property] of Object.entries(pageOwner(tool.parameters, ['properties']) ?? {})) {
    const schema = pageOwner(property, [])
    if (filled[key] === undefined && schema && Object.hasOwn(schema, 'default')) filled[key] = structuredClone(schema.default)
  }
  return filled
}

function pageSelection(tool: AgentTool, params: Record<string, unknown>, parameter: string): Record<string, unknown> {
  const selection = pageDefaults(tool, params)
  // Omission keeps first-page summaries at dispatch, but selects the same continuation list.
  if (tool.name === CanonryMcpToolNames.canonry_measurement_portfolio_summary && selection.list === undefined) {
    selection.list = MeasurementPortfolioLists['weakest-properties']
  }
  return Object.fromEntries(Object.entries(selection).filter(([key, value]) => key !== parameter && !PAGE_SIZE_PARAMS.has(key) && value !== undefined))
}

/** Inherit scope before pi validates required inputs; keep short references in its transcript. */
function inheritPageArguments(runtime: Runtime, message: AssistantMessage, visible: ReadonlySet<string>): void {
  for (const block of message.content) {
    if (block.type !== 'toolCall' || !visible.has(block.name)) continue
    const tool = runtime.allowed.find(candidate => candidate.name === block.name)
    if (!tool || !isStoredPageReadTool(tool) || !pageOwner(block.arguments, [])) continue
    let params = block.arguments as Record<string, unknown>
    for (const parameter of new Set(PAGE_CURSORS.map(cursor => cursor.parameter))) {
      const reference = params[parameter]
      const page = typeof reference === 'string' ? runtime.pageReferences.get(reference) : undefined
      if (page?.tool === tool && page.parameter === parameter) params = { ...page.params, ...params }
    }
    block.arguments = pageDefaults(tool, params) as typeof block.arguments
  }
}

function resolvePageReferences(runtime: Runtime, tool: AgentTool, params: unknown): unknown {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return params
  let resolved = params as Record<string, unknown>
  for (const parameter of new Set(PAGE_CURSORS.map(cursor => cursor.parameter))) {
    const value = resolved[parameter]
    if (typeof value !== 'string' || !value.startsWith(PAGE_REFERENCE_PREFIX)) continue
    const page = runtime.pageReferences.get(value)
    if (!page) throw new Error('This Aero page reference is no longer available. Read the first page again with the original filters.')
    const inherited = { ...page.params, ...resolved }
    if (page.tool !== tool || page.parameter !== parameter || !isDeepStrictEqual(page.selection, pageSelection(tool, inherited, parameter))) {
      throw new Error('Use this Aero page reference with the same tool and original filters; only limit, queryLimit or attemptLimit may change.')
    }
    resolved = { ...inherited, [parameter]: page.token }
  }
  return resolved
}

function pageOwner(value: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let owner = value
  for (const key of path) {
    if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) return undefined
    owner = (owner as Record<string, unknown>)[key]
  }
  return owner !== null && typeof owner === 'object' && !Array.isArray(owner) ? owner as Record<string, unknown> : undefined
}

/** Short local continuations preserve the raw API result and never bless a cap-cut next cursor. */
function referencePages(runtime: Runtime, tool: AgentTool, params: unknown, value: ToolResult): ToolResult {
  if (!isStoredPageReadTool(tool) || value.isError || value.content.length !== 1 || params === null || typeof params !== 'object' || Array.isArray(params)) return value
  const block = value.content[0]!
  if (block.type !== 'text') return value
  let shown: unknown
  try { shown = JSON.parse(block.text) as unknown } catch { return value }
  const root = pageOwner(shown, [])
  if (!root || root.__truncated === true) return value
  let changed = false
  for (const cursor of PAGE_CURSORS) {
    const owner = pageOwner(root, cursor.owner)
    const token = owner?.[cursor.key]
    if (!Object.hasOwn(pageOwner(tool.parameters, ['properties']) ?? {}, cursor.parameter) || !owner || owner.__truncated === true || typeof token !== 'string' || token !== pageOwner(value.details, cursor.owner)?.[cursor.key]) continue
    if (runtime.pageReferences.size >= runtime.limits.maxToolCalls * PAGE_CURSORS.length) break
    const reference = `${PAGE_REFERENCE_PREFIX}${runtime.pageNamespace}-${runtime.pageTurn}:${runtime.pageReferences.size + 1}`
    if (token.length <= reference.length) continue
    runtime.pageReferences.set(reference, {
      tool, token, parameter: cursor.parameter,
      params: structuredClone(params as Record<string, unknown>),
      selection: structuredClone(pageSelection(tool, params as Record<string, unknown>, cursor.parameter)),
    })
    owner[cursor.key] = reference
    const pagination = pageOwner(root.__pagination, [])
    for (const [path, note] of Object.entries(pagination ?? {})) {
      if (typeof note === 'string') pagination![path] = note.split(token).join(reference)
    }
    changed = true
  }
  if (!changed) return value
  root.__pageReferences = 'Aero page references expire at the end of this turn. Pass them unchanged to the same tool. Omitted filters inherit the original scope; supplied filters must match. Only the page size may change.'
  let text = JSON.stringify(root)
  // The adapter already enforced its cap. A reference must never make that text larger.
  if (text.length > block.text.length) {
    delete root.__pageReferences
    text = JSON.stringify(root)
  }
  return { ...value, content: [{ ...block, text }] }
}

function visibleTools(runtime: Runtime): AgentTool[] {
  const allowed = runtime.allowed.map(tool => ({
    ...tool,
    execute: async (id: string, params: unknown, signal?: AbortSignal, onUpdate?: Parameters<AgentTool['execute']>[3]) => {
      const dispatchedParams = resolvePageReferences(runtime, tool, params)
      const safeRead = isStoredReadTool(tool)
      const key = safeRead ? `${tool.name}:${JSON.stringify(dispatchedParams)}` : undefined
      const prior = key === undefined ? undefined : runtime.memo.get(key)
      if (prior) {
        const previous = await prior.value
        if (!previous.isError) return result({ alreadyReturned: true, toolCallId: prior.id, note: 'Already returned above. Use that result and follow its pagination instruction. A cap-cut page must be re-requested from the original cursor with a smaller limit.' })
      }
      if (!safeRead) runtime.memo.clear()
      const research = runtime.research?.signal
      const signals = [signal, research].filter((value): value is AbortSignal => value !== undefined)
      const combined = signals.length > 0 ? AbortSignal.any(signals) : undefined
      let interrupted: (() => void) | undefined
      const work = Promise.race([
        tool.execute(id, dispatchedParams, combined, onUpdate),
        new Promise<never>((_resolve, reject) => {
          interrupted = () => reject(new Error('Research time budget elapsed; dispatched work may still settle.'))
          research?.addEventListener('abort', interrupted, { once: true })
          if (research?.aborted) interrupted()
        }),
      ]).then(value => referencePages(runtime, tool, dispatchedParams, value)).finally(() => { if (interrupted) research?.removeEventListener('abort', interrupted) })
      if (key !== undefined) runtime.memo.set(key, { id, value: work })
      try {
        const value = await work
        if (key !== undefined && value.isError) runtime.memo.delete(key)
        return value
      } catch (error) {
        if (key !== undefined) runtime.memo.delete(key)
        throw error
      }
    },
  }))
  if (!runtime.progressive) return allowed
  const visible = allowed.filter(tool => {
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
function withCorrectedToolNames(runtime: Runtime, response: AssistantMessageEventStream, visible: ReadonlySet<string>, wrapUp: boolean, signal?: AbortSignal): AssistantMessageEventStream {
  const result = response.result.bind(response)
  response.result = async () => {
    const message = await result()
    const researchEnded = !wrapUp && runtime.research?.signal.aborted && !signal?.aborted
    const canFinish = wrapUp && (!signal?.aborted || runtime.hardDeadline)
    const failedAnswer = canFinish && !runtime.hardDeadline && (message.stopReason === 'error' || message.stopReason === 'aborted')
    if (researchEnded) {
      message.content = message.content.filter(block => block.type !== 'toolCall')
      if (!message.content.some(block => block.type === 'text' && block.text.trim())) message.content.push({ type: 'text', text: 'Research time budget elapsed; preparing an answer from the evidence already gathered.' })
      message.stopReason = 'stop'
      delete message.errorMessage
    } else if (canFinish && (message.stopReason === 'error' || message.stopReason === 'aborted' || !message.content.some(block => block.type === 'text' && block.text.trim()))) {
      message.content.push({ type: 'text', text: `I reached this turn's ${runtime.reason === 'time-limit' ? 'time' : 'tool'} limit and could not complete the answer. The results above are partial; ask a narrower question to continue.` })
      message.stopReason = 'stop'
      delete message.errorMessage
    }
    if (failedAnswer) runtime.reason = 'error'
    correctToolNames(runtime, message, visible)
    inheritPageArguments(runtime, message, visible)
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
    runtime = { allowed, loaded: new Set(), limits: agentTurnLimitsSchema.parse(limits ?? {}), calls: 0, rounds: 0, startedAt: 0, reason: 'completed', progressive, pinned: new Set(pinned), corrected: new Map(), wrapUp: false, hardDeadline: false, memo: new Map(), pageReferences: new Map(), pageNamespace: randomUUID().slice(0, 8), pageTurn: 0, usage: emptyTurnUsage() }
    runtimes.set(agent, runtime)
    const state = runtime
    const stream = agent.streamFunction
    agent.streamFunction = (model, context, options) => {
      options?.signal?.throwIfAborted()
      state.rounds++
      // The loop sends a normalized transcript: its system messages, not
      // `context.tools`, declare the tools this request can call.
      const visible = new Set(getCurrentTools(context.messages).map(tool => tool.name))
      const wrapUp = state.wrapUp
      const signals = [options?.signal, wrapUp ? undefined : state.research?.signal].filter((value): value is AbortSignal => value !== undefined)
      // Keep the reusable static prompt prefix, then supply a trusted clock only to this request.
      const messages = [...context.messages]
      let clockIndex = 0
      while (messages[clockIndex]?.role === 'system') clockIndex++
      messages.splice(clockIndex, 0, {
        role: 'system', timestamp: state.startedAt,
        content: `Current turn clock (UTC): ${new Date(state.startedAt).toISOString()}. Use this current UTC date and year for relative dates or omitted years unless the user explicitly specifies a year. Stored run and scan dates remain authoritative; this clock is not an observation date.`,
      })
      const response = stream(model, { ...context, messages }, { ...options, ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}) })
      return response instanceof Promise
        ? response.then(ready => withCorrectedToolNames(state, ready, visible, wrapUp, options?.signal))
        : withCorrectedToolNames(state, response, visible, wrapUp, options?.signal)
    }
    const before = agent.beforeToolCall
    const after = agent.afterToolCall
    // Calls past the tool limit, marked at tool_execution_start.
    const overLimit = new Set<string>()
    // Calls this runtime refused to run, so their error results are not tool failures.
    const blocked = new Set<string>()
    agent.beforeToolCall = async (event, signal) => {
      if (signal?.aborted || state.reason === 'time-limit' || state.wrapUp || overLimit.has(event.toolCall.id)) {
        blocked.add(event.toolCall.id)
        return { block: true, reason: 'Turn stopped.' }
      }
      return before?.(event, signal)
    }
    const finish = agent.finishTurn
    // A turn that hit the tool limit gets one more model call once its batch
    // settles, with no tools and a request to answer from what it read. The
    // run ends after that call, whatever it returns.
    agent.finishTurn = (turn, signal) => {
      if (state.reason !== 'tool-limit' && state.reason !== 'time-limit') return finish?.(turn, signal)
      if (state.wrapUp) return { action: 'end' }
      state.wrapUp = true
      return { action: 'continue' }
    }
    const prepare = agent.prepareNextTurnWithContext
    agent.prepareNextTurnWithContext = (turn, signal) => {
      if ((state.reason === 'tool-limit' || state.reason === 'time-limit') && state.wrapUp) {
        return {
          context: { ...turn.context, tools: [] },
          messages: [{ role: 'system', content: state.reason === 'time-limit' ? TIME_LIMIT_WRAP_UP : TOOL_LIMIT_WRAP_UP, timestamp: Date.now() }],
        }
      }
      return prepare ? prepare(turn, signal) : agent.prepareNextTurn?.(signal)
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
    const toolDurations = new Map<string, number>()
    agent.subscribe(event => {
      if (event.type === 'tool_execution_start') {
        // Count every attempt here, including unknown tools and invalid
        // arguments, which pi rejects before beforeToolCall runs. A call past
        // the limit is blocked there instead of aborting the run: pi runs a
        // parallel batch only after preparing every call in it, so an abort
        // would also cancel the calls already allowed.
        if (state.calls >= state.limits.maxToolCalls) {
          if (state.reason !== 'time-limit') state.reason = 'tool-limit'
          overLimit.add(event.toolCallId)
        } else if (!agent.signal?.aborted) {
          state.calls++
        }
        toolStarts.set(event.toolCallId, Date.now())
      }
      // Time each call from its own end event: a parallel batch's result
      // messages arrive only after the whole batch has finished.
      if (event.type === 'tool_execution_end') {
        const startedAt = toolStarts.get(event.toolCallId)
        if (startedAt !== undefined) toolDurations.set(event.toolCallId, Date.now() - startedAt)
        toolStarts.delete(event.toolCallId)
      }
      if (event.type === 'turn_end' && event.message.role === 'assistant' && !isRunFailureMessage(event.message)) {
        // Read loosely: a malformed message must not break the turn it is counted in.
        const usage = event.message.usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cost?: { total?: unknown } } | undefined
        state.usage.responses++
        // Whole tokens per response, as `llm_usage_events` stores them: a fractional count is not a valid outcome count.
        state.usage.inputTokens += Math.round(nonNegative(usage?.input))
        state.usage.outputTokens += Math.round(nonNegative(usage?.output))
        state.usage.cachedTokens += Math.round(nonNegative(usage?.cacheRead))
        state.usage.costUsd += nonNegative(usage?.cost?.total)
      }
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        const message = event.message
        if (message.isError && !overLimit.has(message.toolCallId) && !blocked.has(message.toolCallId)) state.usage.toolErrors++
        explainMissingTool(state, message)
        const durationMs = toolDurations.get(message.toolCallId)
        const requested = state.corrected.get(message.toolCallId)
        Object.assign(message, {
          aeroToolLabel: state.allowed.find(tool => tool.name === message.toolName)?.label,
          ...(durationMs === undefined ? {} : { aeroDurationMs: durationMs }),
          ...(requested === undefined ? {} : { aeroRequestedToolName: requested }),
        })
        toolDurations.delete(message.toolCallId)
        state.corrected.delete(message.toolCallId)
      }
      if (event.type === 'agent_start') {
        toolStarts.clear()
        toolDurations.clear()
        overLimit.clear()
        blocked.clear()
        state.usage = emptyTurnUsage()
        state.corrected.clear()
        state.wrapUp = false
        state.hardDeadline = false
        state.memo.clear()
        state.pageReferences.clear()
        state.pageTurn++
        state.research = new AbortController()
        state.calls = 0
        state.rounds = 0
        state.reason = 'completed'
        state.startedAt = Date.now()
        state.finishedAt = undefined
        const reservedMs = Math.min(15_000, Math.max(250, Math.floor(state.limits.timeoutMs / 10)))
        state.timer = setTimeout(() => {
          if (state.wrapUp) return
          state.reason = 'time-limit'
          state.research?.abort()
        }, state.limits.timeoutMs - reservedMs)
        state.deadlineTimer = setTimeout(() => {
          state.reason = 'time-limit'
          state.hardDeadline = true
          agent.abort()
        }, state.limits.timeoutMs)
        state.timer.unref()
        state.deadlineTimer.unref()
      } else if (event.type === 'agent_end') {
        state.finishedAt = Date.now()
        clearTimeout(state.timer)
        clearTimeout(state.deadlineTimer)
        state.memo.clear()
        state.pageReferences.clear()
        if (agent.signal?.aborted && !state.hardDeadline) state.reason = 'stopped'
        if (state.reason === 'completed' && agent.state.errorMessage) state.reason = 'error'
      }
    })
  }
  runtime.pageReferences.clear()
  runtime.allowed = allowed
  runtime.loaded = new Set()
  runtime.limits = agentTurnLimitsSchema.parse(limits ?? {})
  runtime.progressive = progressive
  runtime.pinned = new Set(pinned)
  agent.state.tools = visibleTools(runtime)
  setAeroSystemPrompt(agent)
}

/**
 * pi-agent-core 0.86+ keeps the system prompt and tool declarations in the
 * transcript as `role: 'system'` messages. They are rebuilt from the database
 * and the live tool set on every hydrate and turn, so they are never stored,
 * archived or shown: a stored copy would bring back a stale prompt, the full
 * `<memory>` block and every tool schema, and 0.67-era rows stay loadable.
 */
export function isSystemMessage(message: unknown): boolean {
  return !!message && typeof message === 'object' && (message as { role?: unknown }).role === 'system'
}


/**
 * The assistant message pi-agent-core appends when a run throws or is aborted
 * outside a provider call (for example the stream wrapper's abort check). Since
 * 0.81 it is streamed as message_start/message_end/turn_end; 0.67 only put it
 * in the transcript and on `agent_end`. It carries no answer and no usage: one
 * empty text part, stop reason `aborted` or `error`, and the thrown message.
 * It also has no `responseId`, which tells it apart from a real provider error
 * of the same shape (OpenAI Responses opens an empty text part as soon as an
 * output item starts, and sets `responseId` before that).
 */
export function isRunFailureMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const m = message as { role?: unknown; stopReason?: unknown; content?: unknown; usage?: { totalTokens?: unknown }; responseId?: unknown }
  if (m.role !== 'assistant' || (m.stopReason !== 'aborted' && m.stopReason !== 'error') || m.responseId) return false
  const content = Array.isArray(m.content) ? m.content as Array<{ type?: unknown; text?: unknown }> : []
  return content.length === 1 && content[0]!.type === 'text' && content[0]!.text === '' && m.usage?.totalTokens === 0
}

/**
 * Set the prompt Aero runs with. pi-agent-core 0.86 made `state.systemPrompt`
 * a read-only replay of the transcript's system messages, and a later system
 * message appends to the prompt rather than replacing it. So rewrite the one
 * leading system message instead: the given prompt plus the tools the agent
 * holds now, followed by the rest of the transcript without any system
 * message (earlier tool announcements are folded into the new declaration).
 * Call it between runs only; a run keeps the context it started with.
 */
export function setAeroSystemPrompt(agent: Agent, prompt: string = agent.state.systemPrompt): void {
  const system = createInitialSystemMessage(prompt, agent.state.tools.map(toToolDeclaration))
  const rest = agent.state.messages.filter(message => message.role !== 'system')
  agent.state.messages = system ? [system, ...rest] : rest
}

/** Token, cost and tool-error totals of the agent's latest turn. Never streamed to clients. */
export function aeroTurnUsage(agent: Agent): Readonly<AeroTurnUsage> | undefined {
  return runtimes.get(agent)?.usage
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
