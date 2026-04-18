import { createClient, migrate } from '@ainyc/canonry-db'
import { createApiClient } from '../client.js'
import { loadConfig } from '../config.js'
import { SessionRegistry } from '../agent/session-registry.js'
import type { AgentEvent } from '@mariozechner/pi-agent-core'
import type { SupportedAgentProvider } from '../agent/session.js'

export interface AgentAskOptions {
  project: string
  prompt: string
  provider?: SupportedAgentProvider
  modelId?: string
  format?: string
}

export async function agentAsk(opts: AgentAskOptions): Promise<void> {
  const config = loadConfig()
  const client = createApiClient()
  const db = createClient(config.database)
  migrate(db)

  const registry = new SessionRegistry({ db, client, config })
  const agent = registry.getOrCreate(opts.project, {
    provider: opts.provider,
    modelId: opts.modelId,
  })

  const isJson = opts.format === 'json'

  let sawStreamError = false
  agent.subscribe((event) => {
    renderEvent(event, isJson)
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const msg = event.message as { stopReason?: string; errorMessage?: string }
      if (msg.stopReason === 'error' || msg.errorMessage) sawStreamError = true
    }
  })

  // Drain any follow-ups queued while this session was idle (or persisted
  // across a restart). Bundle them in front of the user's prompt so they're
  // processed in a single turn — the user's prompt gets the context.
  const pending = registry.consumePending(opts.project)
  const userMessage = { role: 'user' as const, content: opts.prompt, timestamp: Date.now() }
  const batch = pending.length > 0 ? [...pending, userMessage] : userMessage

  try {
    await agent.prompt(batch)
    await agent.waitForIdle()
    registry.save(opts.project)
    if (sawStreamError) process.exitCode = 2
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isJson) {
      console.error(JSON.stringify({ error: { code: 'AGENT_ERROR', message } }))
    } else {
      console.error(`Agent error: ${message}`)
    }
    process.exitCode = 2
  }
}

function renderEvent(event: AgentEvent, isJson: boolean): void {
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
      const message = event.message
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'text' && block.text.trim().length > 0) {
            console.log('\n' + block.text)
          }
        }
      }
      break
    }
  }
}
