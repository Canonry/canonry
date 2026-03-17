/**
 * CLI command: canonry agent
 *
 * Subcommands:
 *   canonry agent ask <project> "message"     — send a message, get a response
 *   canonry agent threads <project>            — list threads
 *   canonry agent thread <project> <threadId>  — show thread with messages
 */

import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

interface AgentThread {
  id: string
  projectId: string
  title: string | null
  channel: string
  createdAt: string
  updatedAt: string
}

interface AgentMessage {
  id: string
  role: string
  content: string
  toolName: string | null
  createdAt: string
}

export async function agentAsk(project: string, message: string, opts?: {
  threadId?: string
  format?: string
  provider?: string
}): Promise<void> {
  const client = getClient()
  let threadId = opts?.threadId

  // Create a new thread if none specified
  if (!threadId) {
    const thread = await client.createAgentThread(project, {
      title: message.slice(0, 80),
    }) as AgentThread
    threadId = thread.id
    if (opts?.format !== 'json') {
      console.log(`Thread: ${threadId}\n`)
    }
  }

  if (opts?.format !== 'json') {
    console.log('Aero is thinking...\n')
  }

  const result = await client.sendAgentMessage(project, threadId, message, opts?.provider)

  if (opts?.format === 'json') {
    console.log(JSON.stringify({ threadId, response: result.response }, null, 2))
  } else {
    console.log(result.response)
  }
}

export async function agentThreads(project: string, format?: string): Promise<void> {
  const client = getClient()
  const threads = await client.listAgentThreads(project) as AgentThread[]

  if (format === 'json') {
    console.log(JSON.stringify(threads, null, 2))
    return
  }

  if (threads.length === 0) {
    console.log('No Aero threads yet. Use "canonry agent ask <project> <message>" to start.')
    return
  }

  console.log(`Aero threads for ${project}:\n`)
  for (const thread of threads) {
    const title = thread.title ?? '(untitled)'
    const ago = timeSince(thread.updatedAt)
    console.log(`  ${thread.id}  ${title}  (${ago})`)
  }
}

export async function agentThread(project: string, threadId: string, format?: string): Promise<void> {
  const client = getClient()
  const data = await client.getAgentThread(project, threadId) as AgentThread & { messages: AgentMessage[] }

  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  console.log(`Thread: ${data.id}`)
  console.log(`Title: ${data.title ?? '(untitled)'}`)
  console.log(`Created: ${data.createdAt}\n`)
  console.log('─'.repeat(60))

  for (const msg of data.messages) {
    if (msg.role === 'tool') continue

    const label = msg.role === 'user' ? '🧑 You' :
                  msg.role === 'assistant' && msg.toolName ? `🔧 ${msg.toolName}` :
                  '🤖 Aero'

    console.log(`\n${label}:`)
    console.log(msg.content)
  }
}

// ── Helpers ─────────────────────────────────────────────────

function timeSince(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
