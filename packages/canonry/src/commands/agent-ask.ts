import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
import { loadConfig } from '../config.js'
import type { SupportedAgentProvider } from '../agent/session.js'

export interface AgentAskOptions {
  project: string
  prompt: string
  provider?: SupportedAgentProvider
  modelId?: string
  format?: string
}

/**
 * Thin CLI client for the `/api/v1/projects/:name/agent/prompt` SSE route.
 *
 * The CLI used to run its own `SessionRegistry` against a local DB, which
 * broke against remote / shared canonry servers (you'd read and write a
 * different session store than the server owned). Now it posts to the HTTP
 * surface just like the dashboard does — one execution path, one session
 * store, zero drift.
 *
 * Tool scope is `'all'` so the CLI keeps its write-capable behavior. The
 * dashboard route intentionally defaults to `'read-only'`.
 */
export async function agentAsk(opts: AgentAskOptions): Promise<void> {
  const config = loadConfig()
  const isJson = opts.format === 'json'
  const apiUrl = config.apiUrl.replace(/\/$/, '')
  const url = `${apiUrl}/api/v1/projects/${encodeURIComponent(opts.project)}/agent/prompt`

  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  let sawStreamError = false

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        prompt: opts.prompt,
        provider: opts.provider,
        modelId: opts.modelId,
        scope: 'all',
      }),
      signal: controller.signal,
    })

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      let message = `Agent request failed: ${res.status}`
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } }
        if (parsed.error?.message) message = parsed.error.message
      } catch {
        /* leave the default message */
      }
      if (isJson) {
        console.error(JSON.stringify({ error: { code: 'AGENT_ERROR', message } }))
      } else {
        console.error(message)
      }
      process.exitCode = res.status === 409 ? 1 : 2
      return
    }

    for await (const event of parseSse(res.body)) {
      renderEvent(event, isJson)
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const msg = event.message as unknown as { stopReason?: string; errorMessage?: string }
        if (msg.stopReason === 'error' || msg.errorMessage) sawStreamError = true
      } else if (event.type === 'error') {
        sawStreamError = true
      }
    }

    if (sawStreamError) process.exitCode = 2
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isJson) {
      console.error(JSON.stringify({ error: { code: 'AGENT_ERROR', message } }))
    } else {
      console.error(`Agent error: ${message}`)
    }
    process.exitCode = 2
  } finally {
    process.off('SIGINT', onSigint)
  }
}

/**
 * The AgentEvent + two server-side control frames (stream_open, stream_close).
 * Loose shape — the CLI only renders a handful of types.
 */
type CliStreamEvent =
  | AgentEvent
  | { type: 'stream_open' }
  | { type: 'stream_close' }
  | { type: 'error'; message: string }

async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<CliStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
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
            yield JSON.parse(payload) as CliStreamEvent
          } catch {
            /* ignore malformed frame */
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* best effort */
    }
  }
}

function renderEvent(event: CliStreamEvent, isJson: boolean): void {
  if (isJson) {
    console.log(JSON.stringify(event))
    return
  }

  switch (event.type) {
    case 'tool_execution_start':
      console.log(`\n⟐ ${event.toolName} ${JSON.stringify(event.args)}`)
      break
    case 'tool_execution_end':
      console.log(`  ${event.isError ? '✗' : '✓'} ${event.toolName}`)
      break
    case 'message_end': {
      const message = event.message as AgentMessage
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'text' && block.text.trim().length > 0) {
            console.log('\n' + block.text)
          }
        }
      }
      break
    }
    case 'error':
      console.error(`Agent stream error: ${event.message}`)
      break
  }
}
