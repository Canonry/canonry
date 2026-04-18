import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
import { CliError, EXIT_SYSTEM_ERROR, printCliError, type CliFormat } from '../cli-error.js'
import { createApiClient } from '../client.js'
import type { SupportedAgentProvider } from '../agent/session.js'

export type AgentAskScope = 'all' | 'read-only'

export interface AgentAskOptions {
  project: string
  prompt: string
  provider?: SupportedAgentProvider
  modelId?: string
  scope?: AgentAskScope
  format?: string
}

/**
 * Thin CLI client for the `/api/v1/projects/:name/agent/prompt` SSE route.
 *
 * Routes through `createApiClient()` so the shared basePath probe + bearer
 * auth + structured `CliError` contract are all in effect. The CLI used to
 * run its own `SessionRegistry` against a local DB; that broke against
 * remote or reverse-proxied servers. Now the session lives on the server
 * and the CLI is a thin stream consumer.
 *
 * Scope defaults to `'all'` (keeps the CLI write-capable, as documented).
 * The dashboard "Copy as CLI" emits `--scope read-only` when the bar is in
 * its default safe mode so a pasted command cannot enable writes the UI
 * turn couldn't perform.
 */
export async function agentAsk(opts: AgentAskOptions): Promise<void> {
  const format = (opts.format === 'json' ? 'json' : 'text') as CliFormat
  const isJson = format === 'json'

  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  let sawStreamError = false

  try {
    const client = createApiClient()
    const res = await client.streamPost(
      `/projects/${encodeURIComponent(opts.project)}/agent/prompt`,
      {
        prompt: opts.prompt,
        provider: opts.provider,
        modelId: opts.modelId,
        scope: opts.scope ?? 'all',
      },
      controller.signal,
    )
    if (!res.body) {
      throw new CliError({
        code: 'API_ERROR',
        message: 'Server returned no response body',
        exitCode: EXIT_SYSTEM_ERROR,
      })
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

    if (sawStreamError) process.exitCode = EXIT_SYSTEM_ERROR
  } catch (err) {
    printCliError(err, format)
    process.exitCode =
      err instanceof CliError ? err.exitCode : EXIT_SYSTEM_ERROR
  } finally {
    process.off('SIGINT', onSigint)
  }
}

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
