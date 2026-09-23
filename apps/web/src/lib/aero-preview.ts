import type { AeroPreviewStarter } from '@ainyc/canonry-contracts'
import type { AeroAssistantMessage, AeroEvent, AeroToolResultMessage } from '../api-aero.js'

/**
 * Plays one of the public demo's scripted Aero answers through the same
 * events the live prompt stream sends, so the bar renders it with its
 * ordinary transcript, tool cards and Stop handling. Nothing here reaches a
 * server: the script is already in hand.
 */
export interface PlayAeroPreviewArgs {
  starter: AeroPreviewStarter
  signal?: AbortSignal
  onEvent: (event: AeroEvent) => void
  /** Skip every pause, so the whole answer appears at once. */
  reducedMotion?: boolean
}

/** A beat before the first step, while the typing dots show. */
const THINK_MS = 300
/** How long a scripted tool call shows as running, whatever it took on the server. */
const TOOL_MIN_MS = 400
const TOOL_MAX_MS = 900
/** Typing the final answer: at most this many updates, this far apart. */
const TYPE_MAX_TICKS = 32
const TYPE_TICK_MS = 28

let playCount = 0

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function abortError(): DOMException {
  return new DOMException('Preview stopped', 'AbortError')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Split the answer into at most `TYPE_MAX_TICKS` growing prefixes, cut at whitespace. */
function typingFrames(answer: string): string[] {
  const words = answer.match(/\S+\s*|\s+/g) ?? []
  if (words.length < 2) return []
  const perTick = Math.ceil(words.length / TYPE_MAX_TICKS)
  const frames: string[] = []
  for (let end = perTick; end < words.length; end += perTick) frames.push(words.slice(0, end).join(''))
  return frames
}

function resultText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? null)
}

export async function playAeroPreview({ starter, signal, onEvent, reducedMotion = false }: PlayAeroPreviewArgs): Promise<void> {
  const pause = async (ms: number) => {
    if (signal?.aborted) throw abortError()
    if (!reducedMotion) await wait(ms, signal)
  }
  const startedAt = Date.now()
  // Tool call ids pair a card with its result and with the live trail, so a
  // starter played twice in one conversation must not reuse them.
  const play = ++playCount
  await pause(THINK_MS)

  for (const [index, step] of starter.steps.entries()) {
    const { name, label, arguments: args, result, durationMs } = step.tool
    const toolCallId = `preview-${starter.id}-${play}-${index}`
    const assistant: AeroAssistantMessage = {
      role: 'assistant',
      timestamp: Date.now(),
      stopReason: 'toolUse',
      content: [
        ...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
        { type: 'toolCall' as const, id: toolCallId, name, arguments: args },
      ],
    }
    onEvent({ type: 'message_end', message: assistant })
    onEvent({ type: 'tool_execution_start', toolCallId, toolName: name, label, args })
    await pause(Math.min(TOOL_MAX_MS, Math.max(TOOL_MIN_MS, durationMs)))
    onEvent({ type: 'tool_execution_end', toolCallId, toolName: name, result, isError: false })
    const toolResult: AeroToolResultMessage = {
      role: 'toolResult',
      toolCallId,
      timestamp: Date.now(),
      isError: false,
      aeroToolLabel: label,
      aeroDurationMs: durationMs,
      content: [{ type: 'text', text: resultText(result) }],
    }
    onEvent({ type: 'message_end', message: toolResult })
  }

  if (!reducedMotion) {
    for (const text of typingFrames(starter.answer)) {
      await pause(TYPE_TICK_MS)
      onEvent({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text }] }, assistantMessageEvent: {} })
    }
    await pause(TYPE_TICK_MS)
  }
  onEvent({
    type: 'message_end',
    message: { role: 'assistant', timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text: starter.answer }] },
  })
  onEvent({
    type: 'aero_turn_status',
    status: { reason: 'completed', toolCalls: starter.steps.length, modelCalls: starter.steps.length + 1, durationMs: Date.now() - startedAt },
  })
}
