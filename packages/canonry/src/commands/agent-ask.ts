import { createApiClient } from '../client.js'
import { loadConfig } from '../config.js'
import { createAeroSession, type SupportedAgentProvider } from '../agent/session.js'
import type { AgentEvent } from '../agent/pi-runtime.js'

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

  const agent = createAeroSession({
    projectName: opts.project,
    client,
    config,
    provider: opts.provider,
    modelId: opts.modelId,
  })

  const isJson = opts.format === 'json'

  agent.subscribe((event) => {
    renderEvent(event, isJson)
  })

  try {
    await agent.prompt(opts.prompt)
    await agent.waitForIdle()
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
