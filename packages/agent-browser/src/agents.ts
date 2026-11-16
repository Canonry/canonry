// The agents. Three see screenshots through their provider's computer-use API; the fourth is
// a Claude model that reads the accessibility tree instead. Each one turns its provider's
// actions into the same BrowserSession calls, so every agent meets the same page, fence and
// evidence capture.

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { Environment, GoogleGenAI } from '@google/genai'
import { describeError, jsonValueText } from '@canonry/canonry-contracts'
import type { BrowserSession } from './browser.js'
import { clickNode, fillNode, selectNodeOption, takeA11ySnapshot } from './a11y.js'
import { normalizeKeyName, splitKeyCombo } from './keys.js'

export interface AgentUsage {
  requests: number
  /** Every input token billed, cached ones included. */
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  /** Output tokens, thinking included. */
  outputTokens: number
}

export interface AgentRunInput {
  session: BrowserSession
  startUrl: string
  task: string
  model: string
  apiKey: string
  /** Epoch milliseconds after which no new turn starts. */
  deadline: number
  maxTurns: number
  signal?: AbortSignal
}

export interface AgentRunOutput {
  answer: string
  turns: number
  actions: number
  /** Why the loop ended: `final`, `turn-limit`, `time-limit`, `refusal`, or the provider's own reason. */
  stop: string
  usage: AgentUsage
  /** Provider safety prompts the run acknowledged; each is a point where a person would be asked. */
  safetyChecks: number
}

export const emptyUsage = (): AgentUsage => ({ requests: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })

const RULES = [
  'Rules:',
  "- Use only the website itself. There is no address bar, so you can't type a URL.",
  "- Don't ask me anything; I can't reply. Make reasonable choices and keep going.",
  '- When you\'re done, reply with one line that starts with "ANSWER:" and then your answer. If you can\'t finish, reply "ANSWER: FAILED" and say why in one sentence.',
].join('\n')

export function visionPrompt(startUrl: string, task: string): string {
  return `You are using a website the way a visitor would. A browser window is open on ${startUrl}; you can look, click, scroll, type and use the keyboard.\n\nTask: ${task}\n\n${RULES}`
}

function a11yPrompt(startUrl: string, task: string): string {
  return `You are using a website the way a visitor would, through its accessibility tree. The browser is open on ${startUrl}. You don't see pixels: after every action you get a fresh snapshot of the page, and each element you can act on has a ref like [ref=e12]. Use the tools with those refs.\n\nTask: ${task}\n\n${RULES}`
}

const limitStop = (input: AgentRunInput, turns: number): string | null =>
  input.signal?.aborted ? 'cancelled' : Date.now() > input.deadline ? 'time-limit' : turns >= input.maxTurns ? 'turn-limit' : null

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// ---------- OpenAI: Responses API, `computer` tool ----------

interface OpenAIComputerAction {
  type: string
  x?: number
  y?: number
  button?: string
  keys?: string[] | null
  path?: Array<{ x: number; y: number }>
  scroll_x?: number
  scroll_y?: number
  text?: string
}

async function execOpenAIAction(s: BrowserSession, a: OpenAIComputerAction): Promise<void> {
  const mods = Array.isArray(a.keys) ? a.keys : []
  switch (a.type) {
    case 'click':
      if (a.button === 'back') return s.goBack()
      if (a.button === 'forward') return s.goForward()
      return s.click(num(a.x), num(a.y), { button: a.button === 'right' ? 'right' : a.button === 'wheel' ? 'middle' : 'left', modifiers: mods })
    case 'double_click':
      return s.click(num(a.x), num(a.y), { clickCount: 2, modifiers: mods })
    case 'drag':
      return s.drag(a.path ?? [])
    case 'keypress':
      await s.pressKeys(a.keys ?? [])
      return
    case 'move':
      return s.move(num(a.x), num(a.y))
    case 'scroll':
      return s.scroll(num(a.x), num(a.y), num(a.scroll_x), num(a.scroll_y), mods)
    case 'type':
      return s.typeText(a.text ?? '')
    case 'wait':
      return s.wait(1500)
    case 'screenshot':
      return
    default:
      s.record({ unsupported: a.type })
  }
}

const jpegDataUrl = (buf: Buffer) => `data:image/jpeg;base64,${buf.toString('base64')}`

export async function runOpenAIAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const { session } = input
  const client = new OpenAI({ apiKey: input.apiKey, timeout: 180_000, maxRetries: 3 })
  const tools = [{ type: 'computer' as const }]
  const usage = emptyUsage()
  const addUsage = (u: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null | undefined) => {
    if (!u) return
    usage.requests += 1
    usage.inputTokens += num(u.input_tokens)
    usage.cachedInputTokens += num(u.input_tokens_details?.cached_tokens)
    usage.outputTokens += num(u.output_tokens)
  }
  let actions = 0
  let safetyChecks = 0
  const first = await session.screenshot()
  let resp = await client.responses.create(
    {
      model: input.model,
      tools,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: visionPrompt(input.startUrl, input.task) },
            { type: 'input_image', image_url: jpegDataUrl(first), detail: 'original' },
          ],
        },
      ],
    },
    { signal: input.signal },
  )
  addUsage(resp.usage)
  let turns = 1
  for (;;) {
    const calls = resp.output.filter((item) => item.type === 'computer_call')
    if (!calls.length) return { answer: resp.output_text ?? '', turns, actions, stop: 'final', usage, safetyChecks }
    const stop = limitStop(input, turns)
    if (stop) return { answer: '', turns, actions, stop, usage, safetyChecks }
    const outputs = []
    for (const call of calls) {
      const batch = (call.actions ?? (call.action ? [call.action] : [])) as OpenAIComputerAction[]
      for (const action of batch) {
        actions += 1
        session.record({ ...action })
        await execOpenAIAction(session, action)
      }
      const checks = call.pending_safety_checks ?? []
      safetyChecks += checks.length
      const shot = await session.screenshot()
      outputs.push({
        type: 'computer_call_output' as const,
        call_id: call.call_id,
        output: { type: 'computer_screenshot' as const, image_url: jpegDataUrl(shot), detail: 'original' as const },
        ...(checks.length ? { acknowledged_safety_checks: checks } : {}),
      })
    }
    resp = await client.responses.create({ model: input.model, tools, previous_response_id: resp.id, input: outputs }, { signal: input.signal })
    addUsage(resp.usage)
    turns += 1
  }
}

// ---------- Claude: Messages API, computer toolset ----------

type ClaudeContent = Anthropic.Messages.ContentBlockParam
const jpegBlock = (buf: Buffer): Anthropic.Messages.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } })
const textOf = (content: Array<{ type: string; text?: string }>) => content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')

type Coordinate = [number, number]

async function execClaudeAction(s: BrowserSession, name: string, inp: Record<string, unknown>): Promise<{ image?: Buffer; text?: string }> {
  const at = (c: unknown) => (Array.isArray(c) && c.length >= 2 ? { x: num(c[0]), y: num(c[1]) } : s.mouse)
  const mods = typeof inp.text === 'string' && name !== 'type' && name !== 'key' && name !== 'hold_key' ? splitKeyCombo(inp.text) : []
  switch (name) {
    case 'screenshot':
      return { image: await s.screenshot() }
    case 'zoom':
      return { image: await s.zoom((inp.region as [number, number, number, number]) ?? [0, 0, s.viewport.width, s.viewport.height]) }
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      const p = at(inp.coordinate)
      const button = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left'
      const clickCount = name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1
      await s.click(p.x, p.y, { button, clickCount, modifiers: mods })
      return {}
    }
    case 'left_click_drag':
      await s.drag([at(inp.start_coordinate), at(inp.coordinate)])
      return {}
    case 'mouse_move': {
      const p = at(inp.coordinate)
      await s.move(p.x, p.y)
      return {}
    }
    case 'left_mouse_down':
      await s.mouseDown()
      return {}
    case 'left_mouse_up':
      await s.mouseUp()
      return {}
    case 'cursor_position':
      return { text: `X=${Math.round(s.mouse.x)}, Y=${Math.round(s.mouse.y)}` }
    case 'scroll': {
      const p = inp.coordinate ? at(inp.coordinate as Coordinate) : null
      const amount = (num(inp.scroll_amount) || 3) * 100
      const d = inp.scroll_direction
      await s.scroll(p?.x ?? null, p?.y ?? null, d === 'left' ? -amount : d === 'right' ? amount : 0, d === 'up' ? -amount : d === 'down' ? amount : 0, mods)
      return {}
    }
    case 'type':
      await s.typeText(jsonValueText(inp.text))
      return {}
    case 'key':
      return { text: await s.pressKeys(splitKeyCombo(jsonValueText(inp.text)), Math.min(Math.max(num(inp.repeat) || 1, 1), 100)) }
    case 'hold_key': {
      const held = splitKeyCombo(jsonValueText(inp.text)).map(normalizeKeyName)
      for (const k of held) await s.keyDown(k)
      await s.wait(Math.min((num(inp.duration) || 1) * 1000, 10_000))
      for (const k of [...held].reverse()) await s.keyUp(k)
      return {}
    }
    case 'wait':
      await s.wait(Math.min((num(inp.duration) || 1) * 1000, 10_000))
      return {}
    default:
      throw new Error(`Unsupported action: ${name}`)
  }
}

function addClaudeUsage(usage: AgentUsage, u: Anthropic.Messages.Usage | undefined): void {
  if (!u) return
  usage.requests += 1
  const cacheRead = num(u.cache_read_input_tokens)
  const cacheWrite = num(u.cache_creation_input_tokens)
  usage.inputTokens += num(u.input_tokens) + cacheRead + cacheWrite
  usage.cachedInputTokens += cacheRead
  usage.cacheWriteTokens += cacheWrite
  usage.outputTokens += num(u.output_tokens)
}

export async function runClaudeAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const { session } = input
  const client = new Anthropic({ apiKey: input.apiKey, timeout: 300_000, maxRetries: 3 })
  const usage = emptyUsage()
  let actions = 0
  let turns = 0
  const first = await session.screenshot()
  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: visionPrompt(input.startUrl, input.task) }, jpegBlock(first)] }]
  for (;;) {
    const stop = limitStop(input, turns)
    if (stop) return { answer: '', turns, actions, stop, usage, safetyChecks: 0 }
    const resp = await client.messages.create(
      // The computer toolset and top-level automatic caching are newer than this SDK's types.
      { model: input.model, max_tokens: 16_000, tools: [{ type: 'computer_toolset_20260801' }], messages, cache_control: { type: 'ephemeral' } } as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
      { signal: input.signal },
    )
    turns += 1
    addClaudeUsage(usage, resp.usage)
    messages.push({ role: 'assistant', content: resp.content as unknown as ClaudeContent[] })
    if (resp.stop_reason === 'refusal') return { answer: textOf(resp.content), turns, actions, stop: 'refusal', usage, safetyChecks: 0 }
    const uses = resp.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
    if (!uses.length) return { answer: textOf(resp.content), turns, actions, stop: 'final', usage, safetyChecks: 0 }
    const results: Array<Record<string, unknown>> = []
    let failed = false
    let endedOnImage = false
    for (const use of uses) {
      const base = { type: 'tool_result', tool_use_id: use.id, toolset_name: 'computer' }
      if (failed) {
        results.push({ ...base, is_error: true, content: 'Not executed: an earlier computer action in this turn failed.' })
        continue
      }
      try {
        actions += 1
        const inp = (use.input ?? {}) as Record<string, unknown>
        session.record({ name: use.name, ...inp })
        const out = await execClaudeAction(session, use.name, inp)
        if (out.image) {
          results.push({ ...base, content: [jpegBlock(out.image)] })
          endedOnImage = true
        } else {
          results.push({ ...base, content: [{ type: 'text', text: out.text ?? 'OK' }] })
          endedOnImage = false
        }
      } catch (err) {
        failed = true
        results.push({ ...base, is_error: true, content: `Error: ${describeError(err)}` })
      }
    }
    const lastResult = results.at(-1)
    if (!failed && !endedOnImage && lastResult && Array.isArray(lastResult.content)) lastResult.content.push(jpegBlock(await session.screenshot()))
    messages.push({ role: 'user', content: results as unknown as ClaudeContent[] })
  }
}

// ---------- Gemini: generateContent, computerUse tool ----------

// Gemini's Interactions API refused every follow-up turn of a computer-use session on the
// keys this was built with ("Request blocked due to safety violations"), even on
// example.com, so this agent uses generateContent and sends the whole history each turn.

const fromGrid = (v: unknown, size: number) => Math.round((num(v) / 1000) * size)

async function execGeminiAction(s: BrowserSession, name: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { width: W, height: H } = s.viewport
  const point = () => ({ x: fromGrid(a.x, W), y: fromGrid(a.y, H) })
  switch (name) {
    case 'click':
    case 'click_at': {
      const p = point()
      await s.click(p.x, p.y)
      return {}
    }
    case 'double_click':
    case 'triple_click': {
      const p = point()
      await s.click(p.x, p.y, { clickCount: name === 'double_click' ? 2 : 3 })
      return {}
    }
    case 'middle_click':
    case 'right_click': {
      const p = point()
      await s.click(p.x, p.y, { button: name === 'right_click' ? 'right' : 'middle' })
      return {}
    }
    case 'mouse_down':
    case 'mouse_up':
      if (a.x !== undefined) {
        const p = point()
        await s.move(p.x, p.y)
      }
      if (name === 'mouse_down') await s.mouseDown()
      else await s.mouseUp()
      return {}
    case 'move':
    case 'hover_at': {
      const p = point()
      await s.move(p.x, p.y)
      return {}
    }
    case 'type':
      await s.typeText(jsonValueText(a.text))
      if (a.press_enter) await s.pressKeys(['Enter'])
      return {}
    case 'type_text_at': {
      const p = point()
      await s.click(p.x, p.y)
      if (a.clear_before_typing !== false) {
        await s.pressKeys(['Control', 'a'])
        await s.pressKeys(['Backspace'])
      }
      await s.typeText(jsonValueText(a.text))
      if (a.press_enter) await s.pressKeys(['Enter'])
      return {}
    }
    case 'drag_and_drop':
      await s.drag([
        { x: fromGrid(a.start_x ?? a.x, W), y: fromGrid(a.start_y ?? a.y, H) },
        { x: fromGrid(a.end_x ?? a.destination_x, W), y: fromGrid(a.end_y ?? a.destination_y, H) },
      ])
      return {}
    case 'wait':
    case 'wait_5_seconds':
      await s.wait(Math.min((num(a.seconds) || (name === 'wait_5_seconds' ? 5 : 1)) * 1000, 10_000))
      return {}
    case 'press_key':
      return { result: await s.pressKeys([jsonValueText(a.key)]) }
    case 'key_down':
      await s.keyDown(jsonValueText(a.key))
      return {}
    case 'key_up':
      await s.keyUp(jsonValueText(a.key))
      return {}
    case 'hotkey':
      return { result: await s.pressKeys(Array.isArray(a.keys) ? a.keys.map((k) => jsonValueText(k)) : []) }
    case 'key_combination':
      return { result: await s.pressKeys(splitKeyCombo(jsonValueText(a.keys))) }
    case 'scroll':
    case 'scroll_at':
    case 'scroll_document': {
      const p = a.x !== undefined ? point() : { x: W / 2, y: H / 2 }
      const m = num(a.magnitude_in_pixels) || num(a.magnitude) || 600
      const d = a.direction
      await s.scroll(p.x, p.y, d === 'left' ? -m : d === 'right' ? m : 0, d === 'up' ? -m : d === 'down' ? m : 0)
      return {}
    }
    case 'take_screenshot':
    case 'open_web_browser':
      return {}
    case 'go_back':
      await s.goBack()
      return {}
    case 'go_forward':
      await s.goForward()
      return {}
    case 'navigate':
    case 'search':
      return { error: 'This browser has no address bar. Use the page itself.' }
    default:
      return { error: `Unsupported action: ${name}` }
  }
}

export async function runGeminiAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const { session } = input
  const ai = new GoogleGenAI({ apiKey: input.apiKey })
  const config = {
    abortSignal: input.signal,
    tools: [{ computerUse: { environment: Environment.ENVIRONMENT_BROWSER, excludedPredefinedFunctions: ['navigate'] } }],
  }
  const usage = emptyUsage()
  let actions = 0
  let turns = 0
  let safetyChecks = 0
  const first = await session.screenshot()
  const contents: Array<{ role: string; parts: unknown[] }> = [
    { role: 'user', parts: [{ text: visionPrompt(input.startUrl, input.task) }, { inlineData: { mimeType: 'image/jpeg', data: first.toString('base64') } }] },
  ]
  for (;;) {
    const stop = limitStop(input, turns)
    if (stop) return { answer: '', turns, actions, stop, usage, safetyChecks }
    const resp = await ai.models.generateContent({ model: input.model, contents: contents as never, config })
    turns += 1
    const meta = resp.usageMetadata
    if (meta) {
      usage.requests += 1
      usage.inputTokens += num(meta.promptTokenCount)
      usage.cachedInputTokens += num(meta.cachedContentTokenCount)
      usage.outputTokens += num(meta.candidatesTokenCount) + num(meta.thoughtsTokenCount)
    }
    const candidate = resp.candidates?.[0]
    const content = candidate?.content
    if (!content?.parts?.length) return { answer: '', turns, actions, stop: String(candidate?.finishReason ?? 'empty'), usage, safetyChecks }
    contents.push(content as { role: string; parts: unknown[] })
    const calls = content.parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []))
    if (!calls.length) {
      const answer = content.parts.filter((part) => part.text && !part.thought).map((part) => part.text).join('\n')
      return { answer, turns, actions, stop: 'final', usage, safetyChecks }
    }
    const parts: unknown[] = []
    for (const call of calls) {
      const name = call.name ?? ''
      const args = (call.args ?? {}) as Record<string, unknown>
      actions += 1
      session.record({ name, ...args })
      const extra: Record<string, unknown> = {}
      const decision = args.safety_decision as { decision?: string } | undefined
      if (decision) {
        safetyChecks += 1
        if (decision.decision === 'require_confirmation') extra.safety_acknowledgement = 'true'
      }
      let out: Record<string, unknown>
      try {
        out = await execGeminiAction(session, name, args)
      } catch (err) {
        out = { error: describeError(err) }
      }
      const shot = await session.screenshot()
      parts.push({
        functionResponse: {
          name,
          ...(call.id ? { id: call.id } : {}),
          response: { url: await session.url(), ...out, ...extra },
          parts: [{ inlineData: { mimeType: 'image/jpeg', data: shot.toString('base64') } }],
        },
      })
    }
    contents.push({ role: 'user', parts })
  }
}

// ---------- Claude reading the accessibility tree ----------

const strictTool = (name: string, description: string, properties: Record<string, unknown>) => ({
  name,
  description,
  strict: true,
  input_schema: { type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false },
})
const refProp = { type: 'string', description: "The element's ref from the latest snapshot, like e12" }
const A11Y_TOOLS = [
  strictTool('click', 'Click an element.', { ref: refProp }),
  strictTool('fill', 'Replace the text in a text field with this text.', { ref: refProp, text: { type: 'string' } }),
  strictTool('select_option', 'Choose an option in a dropdown by its visible label.', { ref: refProp, option: { type: 'string', description: "The option's visible label" } }),
  strictTool('press_key', 'Press a key or key combination, such as Enter, Tab, ArrowDown or Control+a.', { key: { type: 'string' } }),
  strictTool('go_back', 'Go back to the previous page.', {}),
]

async function execA11yAction(s: BrowserSession, refs: Map<string, number>, name: string, inp: Record<string, unknown>): Promise<string> {
  const node = () => {
    const id = refs.get(jsonValueText(inp.ref))
    if (id === undefined) throw new Error(`No element has ref ${jsonValueText(inp.ref) || '(none)'} in the latest snapshot.`)
    return id
  }
  switch (name) {
    case 'click':
      await clickNode(s, node())
      return 'OK'
    case 'fill':
      await fillNode(s, node(), jsonValueText(inp.text))
      return 'OK'
    case 'select_option':
      return `Chose "${await selectNodeOption(s, node(), jsonValueText(inp.option))}".`
    case 'press_key':
      return s.pressKeys(splitKeyCombo(jsonValueText(inp.key)))
    case 'go_back':
      await s.goBack()
      return 'OK'
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export async function runClaudeA11yAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const { session } = input
  const client = new Anthropic({ apiKey: input.apiKey, timeout: 300_000, maxRetries: 3 })
  const usage = emptyUsage()
  let actions = 0
  let turns = 0
  await session.screenshot() // kept as evidence only; this agent never sees pixels
  let snapshot = await takeA11ySnapshot(session)
  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: `${a11yPrompt(input.startUrl, input.task)}\n\nThe page now:\n${snapshot.text}` }] }]
  for (;;) {
    const stop = limitStop(input, turns)
    if (stop) return { answer: '', turns, actions, stop, usage, safetyChecks: 0 }
    const resp = await client.messages.create(
      { model: input.model, max_tokens: 16_000, tools: A11Y_TOOLS, messages, cache_control: { type: 'ephemeral' } } as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
      { signal: input.signal },
    )
    turns += 1
    addClaudeUsage(usage, resp.usage)
    messages.push({ role: 'assistant', content: resp.content as unknown as ClaudeContent[] })
    if (resp.stop_reason === 'refusal') return { answer: textOf(resp.content), turns, actions, stop: 'refusal', usage, safetyChecks: 0 }
    const uses = resp.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
    if (!uses.length) return { answer: textOf(resp.content), turns, actions, stop: 'final', usage, safetyChecks: 0 }
    const results: Array<{ type: 'tool_result'; tool_use_id: string; is_error?: boolean; content: string }> = []
    let failed = false
    for (const use of uses) {
      if (failed) {
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Not executed: an earlier action in this turn failed.' })
        continue
      }
      try {
        actions += 1
        const inp = (use.input ?? {}) as Record<string, unknown>
        session.record({ name: use.name, ...inp })
        results.push({ type: 'tool_result', tool_use_id: use.id, content: await execA11yAction(session, snapshot.refs, use.name, inp) })
      } catch (err) {
        failed = true
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Error: ${describeError(err).split('\n')[0]}` })
      }
    }
    await session.screenshot()
    snapshot = await takeA11ySnapshot(session)
    const last = results.at(-1)
    if (last) last.content = `${last.content}\n\nThe page now:\n${snapshot.text}`
    messages.push({ role: 'user', content: results })
  }
}
