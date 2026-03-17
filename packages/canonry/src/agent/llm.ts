/**
 * LLM interaction layer — thin wrapper around provider APIs for tool-calling.
 *
 * Uses the OpenAI chat completions format since OpenAI, Claude (via compatibility),
 * and Gemini (via compatibility endpoints) all support it. This avoids adding
 * the Vercel AI SDK as a dependency — we only need fetch().
 */

import type { AgentTool } from './tools.js'

export interface LlmConfig {
  provider: 'openai' | 'claude' | 'gemini'
  apiKey: string
  model?: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface CompletionResponse {
  type: 'text' | 'tool_calls'
  text?: string
  toolCalls?: ToolCall[]
}

// Claude uses a dedicated code path (claudeCompletion) — not listed here.
const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
}

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  claude: 'claude-sonnet-4-5-20250514',
  gemini: 'gemini-2.5-flash',
}

/** Rough character count of a chat request (messages + tool defs). */
function estimateRequestSize(messages: ChatMessage[], tools: AgentTool[]): number {
  const msgSize = messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? []).length, 0)
  const toolSize = tools.reduce((sum, t) => sum + t.description.length + JSON.stringify(t.parameters).length, 0)
  return msgSize + toolSize
}

export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: AgentTool[],
): Promise<CompletionResponse> {
  const approxChars = estimateRequestSize(messages, tools)
  // ~4 chars per token
  const approxTokens = Math.round(approxChars / 4)
  process.stderr.write(`[aero] ${config.provider} request: ~${approxTokens} tokens (${approxChars} chars, ${messages.length} messages)\n`)

  if (config.provider === 'claude') {
    return claudeCompletion(config, messages, tools)
  }

  // OpenAI-compatible (works for OpenAI and Gemini)
  const endpoint = PROVIDER_ENDPOINTS[config.provider]!
  const model = config.model ?? DEFAULT_MODELS[config.provider]!

  const toolDefs = tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  }

  const body = {
    model,
    messages,
    tools: toolDefs.length > 0 ? toolDefs : undefined,
    temperature: 0.3,
    max_tokens: 4096,
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`LLM API error (${config.provider}): ${res.status} ${errBody}`)
  }

  const data = await res.json() as {
    choices: Array<{
      message: {
        content: string | null
        tool_calls?: ToolCall[]
      }
      finish_reason: string
    }>
  }

  const choice = data.choices?.[0]
  if (!choice) throw new Error('No response from LLM')

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    return { type: 'tool_calls', toolCalls: choice.message.tool_calls }
  }

  return { type: 'text', text: choice.message.content ?? '' }
}

/**
 * Claude Messages API — different format from OpenAI.
 */
async function claudeCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: AgentTool[],
): Promise<CompletionResponse> {
  const model = config.model ?? DEFAULT_MODELS.claude!

  // Extract system message
  const systemMsg = messages.find(m => m.role === 'system')
  const nonSystemMessages = messages.filter(m => m.role !== 'system')

  // Convert to Claude format
  const claudeMessages = convertToClaudeMessages(nonSystemMessages)

  const toolDefs = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: claudeMessages,
    temperature: 0.3,
  }

  if (systemMsg) {
    body.system = systemMsg.content
  }

  if (toolDefs.length > 0) {
    body.tools = toolDefs
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Claude API error: ${res.status} ${errBody}`)
  }

  const data = await res.json() as {
    content: Array<{
      type: 'text' | 'tool_use'
      text?: string
      id?: string
      name?: string
      input?: Record<string, unknown>
    }>
    stop_reason: string
  }

  const toolUseBlocks = data.content.filter(b => b.type === 'tool_use')
  if (toolUseBlocks.length > 0) {
    const toolCalls: ToolCall[] = toolUseBlocks.map(b => ({
      id: b.id!,
      type: 'function' as const,
      function: {
        name: b.name!,
        arguments: JSON.stringify(b.input ?? {}),
      },
    }))
    return { type: 'tool_calls', toolCalls }
  }

  const textBlock = data.content.find(b => b.type === 'text')
  return { type: 'text', text: textBlock?.text ?? '' }
}

function convertToClaudeMessages(
  messages: ChatMessage[],
): Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content ?? '' })
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const blocks: Array<Record<string, unknown>> = []
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown>
          try {
            input = JSON.parse(tc.function.arguments) as Record<string, unknown>
          } catch {
            input = {}
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          })
        }
        // Merge consecutive assistant tool-call messages into one.
        // The DB stores each tool call separately but Claude needs them grouped.
        const prev = result[result.length - 1]
        if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
          prev.content.push(...blocks)
        } else {
          result.push({ role: 'assistant', content: blocks })
        }
      } else {
        result.push({ role: 'assistant', content: msg.content ?? '' })
      }
    } else if (msg.role === 'tool') {
      // Claude expects tool results as user messages with tool_result content blocks.
      // Merge consecutive tool results into one user message to avoid
      // consecutive same-role messages (which Claude rejects).
      const toolBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content ?? '',
      }
      const prev = result[result.length - 1]
      if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
        prev.content.push(toolBlock)
      } else {
        result.push({
          role: 'user',
          content: [toolBlock],
        })
      }
    }
  }

  // ── Validate tool_use ↔ tool_result pairing ──────────────
  // Claude requires:
  //   1. Every tool_use in an assistant message must have a tool_result in the NEXT user message
  //   2. Every tool_result in a user message must reference a tool_use in the PREVIOUS assistant message
  // We do multiple passes to clean up both directions.

  // Pass 1: For each assistant message with tool_use blocks, ensure the next
  // message is a user message containing matching tool_result blocks.
  // If not, remove the orphaned tool_use blocks (or the whole assistant message).
  for (let idx = 0; idx < result.length; idx++) {
    const entry = result[idx]
    if (entry.role !== 'assistant' || !Array.isArray(entry.content)) continue

    const toolUseBlocks = (entry.content as Array<Record<string, unknown>>).filter(b => b.type === 'tool_use')
    if (toolUseBlocks.length === 0) continue

    // Collect tool_result IDs from the next message
    const next = idx + 1 < result.length ? result[idx + 1] : null
    const resultIds = new Set<string>()
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          resultIds.add(b.tool_use_id)
        }
      }
    }

    // Remove tool_use blocks without matching results
    entry.content = (entry.content as Array<Record<string, unknown>>).filter(
      b => b.type !== 'tool_use' || resultIds.has(b.id as string),
    )

    // If the assistant message is now empty, remove it
    if ((entry.content as Array<Record<string, unknown>>).length === 0) {
      result.splice(idx, 1)
      idx--
    }
  }

  // Pass 2: For each user message with tool_result blocks, ensure the previous
  // message is an assistant message containing matching tool_use blocks.
  for (let idx = 0; idx < result.length; idx++) {
    const entry = result[idx]
    if (entry.role !== 'user' || !Array.isArray(entry.content)) continue

    const hasToolResults = (entry.content as Array<Record<string, unknown>>).some(b => b.type === 'tool_result')
    if (!hasToolResults) continue

    const prev = idx > 0 ? result[idx - 1] : null
    const toolUseIds = new Set<string>()
    if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
      for (const b of prev.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          toolUseIds.add(b.id)
        }
      }
    }

    entry.content = (entry.content as Array<Record<string, unknown>>).filter(
      b => b.type !== 'tool_result' || toolUseIds.has(b.tool_use_id as string),
    )

    if ((entry.content as Array<Record<string, unknown>>).length === 0) {
      result.splice(idx, 1)
      idx--
    }
  }

  // Ensure conversation starts with a user message (Claude requirement)
  while (result.length > 0 && result[0].role !== 'user') {
    result.shift()
  }
  if (result.length === 0 || result[0].role !== 'user') {
    result.unshift({ role: 'user', content: '(continuing conversation)' })
  }

  return result
}
