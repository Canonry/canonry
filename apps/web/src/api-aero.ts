import { ApiError } from './api.js'
import type { AgentProviderId, AgentProvidersResponse } from '@ainyc/canonry-contracts'

export type { AgentProviderId, AgentProviderOption, AgentProvidersResponse } from '@ainyc/canonry-contracts'

function getApiBase(): string {
  if (typeof window !== 'undefined' && window.__CANONRY_CONFIG__?.basePath) {
    return window.__CANONRY_CONFIG__.basePath.replace(/\/$/, '') + '/api/v1'
  }
  return '/api/v1'
}

const API_BASE = getApiBase()

// ──────────────────────────────────────────────────────────────────
// Event shape — mirrors pi-agent-core's AgentEvent plus the two control
// frames the server brackets the stream with. Inlined here so we don't
// ship a hard dependency on @mariozechner/pi-agent-core into the frontend.

export type AeroTextBlock = { type: 'text'; text: string; textSignature?: string }
export type AeroToolCallBlock = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
export type AeroAssistantMessage = {
  role: 'assistant'
  content: Array<AeroTextBlock | AeroToolCallBlock | { type: string; [k: string]: unknown }>
  stopReason?: string
  errorMessage?: string
  timestamp?: number
}
export type AeroUserMessage = {
  role: 'user'
  content: string | Array<{ type: string; [k: string]: unknown }>
  timestamp?: number
}
export type AeroToolResultMessage = {
  role: 'toolResult'
  content: Array<{ type: string; [k: string]: unknown }>
  toolCallId: string
  isError?: boolean
  timestamp?: number
}
export type AeroMessage = AeroUserMessage | AeroAssistantMessage | AeroToolResultMessage

export type AeroEvent =
  | { type: 'stream_open' }
  | { type: 'stream_close' }
  | { type: 'error'; message: string }
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AeroMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AeroMessage; toolResults: AeroMessage[] }
  | { type: 'message_start'; message: AeroMessage }
  | { type: 'message_update'; message: AeroMessage; assistantMessageEvent: Record<string, unknown> }
  | { type: 'message_end'; message: AeroMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }

export interface AeroTranscript {
  messages: AeroMessage[]
  modelProvider: string | null
  modelId: string | null
  updatedAt: string | null
}

export async function fetchAeroTranscript(project: string): Promise<AeroTranscript> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/agent/transcript`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(body?.error?.message ?? `transcript fetch failed: ${res.status}`, res.status, body?.error?.code)
  }
  return res.json()
}

export async function fetchAgentProviders(project: string): Promise<AgentProvidersResponse> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/agent/providers`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(
      body?.error?.message ?? `providers fetch failed: ${res.status}`,
      res.status,
      body?.error?.code,
    )
  }
  return res.json()
}

export async function resetAeroTranscript(project: string): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/agent/transcript`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(body?.error?.message ?? `reset failed: ${res.status}`, res.status, body?.error?.code)
  }
}

export type AeroToolScope = 'read-only' | 'all'

export interface PromptAeroArgs {
  project: string
  prompt: string
  /** Override Aero's auto-detected provider for this turn. */
  provider?: AgentProviderId
  /** Override the provider's default model for this turn. */
  modelId?: string
  /**
   * Tool-surface scope for this turn. `read-only` (default) blocks mutating
   * tools like run_sweep and dismiss_insight; `all` enables the full set.
   */
  scope?: AeroToolScope
  signal?: AbortSignal
  onEvent: (event: AeroEvent) => void
}

/**
 * POST to the prompt endpoint and parse the SSE stream, firing onEvent for
 * each frame. Resolves when the server sends `stream_close` or ends the
 * response. Rejects on network errors; SSE `error` frames surface to
 * onEvent but do not reject this promise.
 */
export async function promptAero({
  project,
  prompt,
  provider,
  modelId,
  scope,
  signal,
  onEvent,
}: PromptAeroArgs): Promise<void> {
  const body: Record<string, unknown> = { prompt }
  if (provider) body.provider = provider
  if (modelId) body.modelId = modelId
  if (scope) body.scope = scope
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/agent/prompt`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(body?.error?.message ?? `prompt failed: ${res.status}`, res.status, body?.error?.code)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // Translate signal aborts into a reader.cancel() so `await reader.read()`
  // resolves promptly instead of blocking until the server closes its half.
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          try {
            onEvent(JSON.parse(payload) as AeroEvent)
          } catch {
            /* ignore malformed frame */
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      /* best effort */
    }
  }
}

export function extractAssistantText(message: AeroMessage | undefined): string {
  if (!message || message.role !== 'assistant') return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as AeroTextBlock).text)
    .join('')
}
