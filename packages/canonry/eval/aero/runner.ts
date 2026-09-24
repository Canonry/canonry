/**
 * Ask Aero one question and capture the turn.
 *
 * Each ask starts from an empty conversation on its lane (DELETE transcript),
 * sends the prompt the way the dashboard does (read-only tool scope, the
 * product's own turn limits), and reads the SSE stream back into a
 * `TurnCapture`: the final answer, every tool call with what the model saw
 * of its result, whether that result was truncated, the turn status, and the
 * turn's LLM spend from `llm_usage_events` in the database copy.
 */
import type { EvalLane, ToolCallTrace, TurnCapture } from './types.js'

export interface CostSnapshot {
  /** USD; null when no usage row was written or a row carried tokens but no price. */
  costUsd: number | null
  /** provider/model pairs that answered. */
  models: string[]
  tokens?: number
}

export interface CostReader {
  mark(): number
  since(mark: number): CostSnapshot
}

export interface RunnerTarget {
  baseUrl: string
  /** Headers for one turn on the lane. Throws when the lane is unavailable. */
  headers(lane: EvalLane): Record<string, string>
  costReader?: CostReader
}

export interface AskInput {
  questionId: string
  /** The prompt as sent, placeholders already filled. */
  prompt: string
  lane: EvalLane
  attempt: number
}

export interface RunnerOptions {
  project: string
  /** Client-side ceiling on one turn, beyond the product's own limits. Default 15 minutes. */
  timeoutMs?: number
  /** Passed through as the prompt's `limits`; omitted uses the product defaults. */
  limits?: { maxToolCalls?: number; timeoutMs?: number }
  fetch?: typeof fetch
  /** Wait between reset retries while the lane is busy. Default 3s. */
  resetRetryMs?: number
}

const PREVIEW_CHARS = 400
const SLICE_NOTE = '(truncated, result too large)'
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const RESET_RETRIES = 10
const RESET_RETRY_MS = 3000

interface TruncationSummary {
  cutAt?: string
  droppedKeys?: string[]
  keptItems?: Record<string, string>
  moreDroppedKeys?: number
}

function describeSummary(summary: TruncationSummary): string {
  const parts: string[] = []
  if (summary.cutAt) parts.push(`cut at ${summary.cutAt}`)
  if (summary.droppedKeys?.length) {
    parts.push(`dropped ${summary.droppedKeys.join(', ')}${summary.moreDroppedKeys ? ` and ${summary.moreDroppedKeys} more` : ''}`)
  }
  const kept = Object.entries(summary.keptItems ?? {}).filter(([key]) => !summary.droppedKeys?.includes(key))
  if (kept.length > 0) parts.push(`kept ${kept.slice(0, 8).map(([key, value]) => `${key} ${value}`).join(', ')}${kept.length > 8 ? ', ...' : ''}`)
  return parts.join('; ').slice(0, 400)
}

/**
 * Did the model see a cut-down result? Reads the markers
 * `src/agent/mcp-to-agent-tool.ts` adds: a `__truncation` field on structured
 * output, or a `__truncation: {...}` line before the closing note on a plain
 * slice.
 */
export function detectTruncation(text: string): { truncated: boolean; note?: string } {
  const trimmed = text.trimEnd()
  if (trimmed.endsWith(SLICE_NOTE)) {
    const line = trimmed.split('\n').reverse().find(candidate => candidate.startsWith('__truncation: '))
    if (line) {
      try {
        const note = describeSummary(JSON.parse(line.slice('__truncation: '.length)) as TruncationSummary)
        return { truncated: true, note: `plain slice; ${note || 'no summary'}` }
      } catch {
        // Fall through to the bare note.
      }
    }
    return { truncated: true, note: `plain slice at ${text.length} chars, no summary of what was cut` }
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const summary = parsed.__truncation
      if (summary && typeof summary === 'object') {
        return { truncated: true, note: describeSummary(summary as TruncationSummary) || 'structured trim' }
      }
      if (parsed.__truncated === true) {
        const omitted = typeof parsed.__omittedRows === 'number' ? `${parsed.__omittedRows} rows omitted` : 'rows omitted'
        return { truncated: true, note: omitted }
      }
      if (trimmed.includes('"__truncated": true')) return { truncated: true, note: 'nested collections trimmed' }
      return { truncated: false }
    } catch {
      // Not JSON after all.
    }
  }
  if (text.includes('__truncation')) return { truncated: true, note: 'truncation marker present' }
  return { truncated: false }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map(part => part.text)
    .join('')
}

interface TurnStatusFrame {
  reason?: string
  toolCalls?: number
  modelCalls?: number
  durationMs?: number
}

export interface CollectedTurn {
  answer: string
  tools: ToolCallTrace[]
  status: string
  toolCalls: number
  modelCalls: number
  durationMs?: number
  error?: string
  models: string[]
}

/**
 * Folds SSE frames into a turn. Pure: the test feeds it frames directly.
 * Tool results come from `message_end` tool-result frames (the text the model
 * actually read, after truncation and any missing-tool rewrite), falling back
 * to `tool_execution_end` when a result frame never arrived.
 */
export class TurnCollector {
  private readonly tools = new Map<string, ToolCallTrace & { hasResult: boolean }>()
  private readonly order: string[] = []
  private finalAssistantText = ''
  private assistantMessages = 0
  private readonly errors: string[] = []
  private readonly models = new Set<string>()
  private status: TurnStatusFrame | null | undefined
  private closed = false

  private tool(id: string, name: string): ToolCallTrace & { hasResult: boolean } {
    let entry = this.tools.get(id)
    if (!entry) {
      entry = { name, args: {}, isError: false, resultPreview: '', resultChars: 0, truncated: false, hasResult: false }
      this.tools.set(id, entry)
      this.order.push(id)
    }
    return entry
  }

  private setResult(entry: ToolCallTrace & { hasResult: boolean }, text: string): void {
    entry.hasResult = true
    entry.resultChars = text.length
    entry.resultPreview = text.slice(0, PREVIEW_CHARS)
    // Already capped near 20K by the product's truncation; the checks and the
    // grader read every number the model saw, not just the preview.
    entry.resultText = text
    const truncation = detectTruncation(text)
    entry.truncated = truncation.truncated
    if (truncation.note) entry.truncationNote = truncation.note
    else delete entry.truncationNote
  }

  push(frame: unknown): void {
    if (!frame || typeof frame !== 'object') return
    const event = frame as Record<string, unknown> & { type?: string }
    switch (event.type) {
      case 'tool_execution_start': {
        const entry = this.tool(String(event.toolCallId), String(event.toolName))
        entry.args = event.args ?? {}
        break
      }
      case 'tool_execution_end': {
        const entry = this.tool(String(event.toolCallId), String(event.toolName))
        entry.isError = event.isError === true
        if (!entry.hasResult) {
          const result = event.result as { content?: unknown } | undefined
          this.setResult(entry, textOf(result?.content))
        }
        break
      }
      case 'message_end': {
        const message = event.message as Record<string, unknown> | undefined
        if (!message) break
        if (message.role === 'toolResult') {
          const entry = this.tool(String(message.toolCallId), String(message.toolName))
          entry.isError = message.isError === true
          this.setResult(entry, textOf(message.content))
          if (typeof message.aeroDurationMs === 'number') entry.durationMs = message.aeroDurationMs
        } else if (message.role === 'assistant') {
          this.assistantMessages++
          this.finalAssistantText = textOf(message.content)
          if (typeof message.provider === 'string' && typeof message.model === 'string') this.models.add(`${message.provider}/${message.model}`)
          if (typeof message.errorMessage === 'string' && message.errorMessage) this.errors.push(message.errorMessage)
        }
        break
      }
      case 'aero_turn_status':
        this.status = (event.status ?? null) as TurnStatusFrame | null
        break
      case 'error':
        this.errors.push(typeof event.message === 'string' ? event.message : 'stream error')
        break
      case 'stream_close':
        this.closed = true
        break
      default:
        break
    }
  }

  /** Record a failure outside the stream (HTTP error, abort, dropped connection). */
  fail(message: string): void {
    this.errors.push(message)
  }

  result(): CollectedTurn {
    const tools = this.order.map(id => {
      const { hasResult: _hasResult, ...trace } = this.tools.get(id)!
      return trace
    })
    const errors = [...this.errors]
    if (!this.closed && errors.length === 0) errors.push('The stream ended before stream_close.')
    const status = this.status?.reason ?? (errors.length > 0 ? 'error' : 'completed')
    return {
      answer: this.finalAssistantText.trim(),
      tools,
      status,
      toolCalls: this.status?.toolCalls ?? tools.length,
      modelCalls: this.status?.modelCalls ?? this.assistantMessages,
      ...(this.status?.durationMs !== undefined ? { durationMs: this.status.durationMs } : {}),
      ...(errors.length > 0 ? { error: [...new Set(errors)].join(' | ').slice(0, 2000) } : {}),
      models: [...this.models],
    }
  }
}

/** Parse an SSE body into JSON frames as they arrive. */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  const flush = function* (final: boolean): Generator<unknown> {
    buffer = buffer.replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0 || (final && buffer.trim())) {
      const block = boundary >= 0 ? buffer.slice(0, boundary) : buffer
      buffer = boundary >= 0 ? buffer.slice(boundary + 2) : ''
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (data) {
        try {
          yield JSON.parse(data)
        } catch {
          yield { type: 'error', message: `Unparseable SSE frame (${data.length} chars)` }
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      yield* flush(false)
    }
    buffer += decoder.decode()
    yield* flush(true)
  } finally {
    reader.releaseLock()
  }
}

async function errorText(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } }
    if (parsed.error?.message) return `HTTP ${response.status} ${parsed.error.code ?? ''}: ${parsed.error.message}`.replace('  ', ' ')
  } catch {
    // Not JSON.
  }
  return `HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`
}

export interface Runner {
  ask(input: AskInput): Promise<TurnCapture>
  /** provider/model pairs seen across every turn so far. */
  readonly modelsSeen: ReadonlySet<string>
}

export function createRunner(target: RunnerTarget, opts: RunnerOptions): Runner {
  const doFetch = opts.fetch ?? fetch
  const modelsSeen = new Set<string>()
  const projectPath = `${target.baseUrl}/api/v1/projects/${encodeURIComponent(opts.project)}/agent`

  async function ask(input: AskInput): Promise<TurnCapture> {
    const started = Date.now()
    const collector = new TurnCollector()
    const base = {
      questionId: input.questionId,
      lane: input.lane,
      attempt: input.attempt,
      prompt: input.prompt,
    }
    let cost: CostSnapshot | null = null
    const finish = (): TurnCapture => {
      const turn = collector.result()
      for (const model of [...turn.models, ...(cost?.models ?? [])]) modelsSeen.add(model)
      return {
        ...base,
        answer: turn.answer,
        tools: turn.tools,
        status: turn.status,
        toolCalls: turn.toolCalls,
        modelCalls: turn.modelCalls,
        durationMs: turn.durationMs ?? Date.now() - started,
        ...(turn.error ? { error: turn.error } : {}),
        costUsd: cost?.costUsd ?? null,
      }
    }

    let headers: Record<string, string>
    try {
      headers = target.headers(input.lane)
    } catch (error) {
      collector.fail(error instanceof Error ? error.message : String(error))
      return finish()
    }

    // A fresh conversation per ask: an attempt must never read an earlier one.
    // A turn the eval stopped waiting for can still be winding down, so a busy
    // lane (409) is retried for a while before the ask gives up.
    let reset: Response | Error
    for (let attempt = 0; ; attempt++) {
      reset = await doFetch(`${projectPath}/transcript`, { method: 'DELETE', headers }).catch((error: unknown) => error as Error)
      if (reset instanceof Error || reset.status !== 409 || attempt >= RESET_RETRIES) break
      await reset.body?.cancel().catch(() => {})
      await new Promise(resolve => setTimeout(resolve, opts.resetRetryMs ?? RESET_RETRY_MS))
    }
    if (reset instanceof Error || !reset.ok) {
      collector.fail(`Could not reset the ${input.lane} conversation: ${reset instanceof Error ? reset.message : await errorText(reset)}`)
      return finish()
    }
    await reset.body?.cancel().catch(() => {})

    const mark = target.costReader?.mark()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await doFetch(`${projectPath}/prompt`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ prompt: input.prompt, scope: 'read-only', ...(opts.limits ? { limits: opts.limits } : {}) }),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        collector.fail(await errorText(response))
      } else {
        for await (const frame of readSseFrames(response.body)) collector.push(frame)
      }
    } catch (error) {
      collector.fail(controller.signal.aborted
        ? `The eval stopped waiting after ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`
        : error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }
    if (target.costReader && mark !== undefined) {
      try {
        cost = target.costReader.since(mark)
      } catch {
        cost = null
      }
    }
    return finish()
  }

  return { ask, modelsSeen }
}

/** Fill `{placeholder}` tokens; returns the names left unfilled. */
export function fillPrompt(prompt: string, values: Record<string, string> = {}): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = prompt.replace(/\{([\w.-]+)\}/g, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name]!
    missing.push(name)
    return whole
  })
  return { text, missing: [...new Set(missing)] }
}
