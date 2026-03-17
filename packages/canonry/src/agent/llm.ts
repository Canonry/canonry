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

/**
 * Convert OpenAI-format messages to Claude Messages API format.
 *
 * Uses a state-machine approach that builds valid output by construction:
 * - Tool call groups (assistant+tool_use → user+tool_result) are only emitted
 *   when ALL tool_use blocks have matching tool_result blocks. Incomplete groups
 *   (orphaned by history truncation or crashes) are dropped entirely.
 * - Consecutive same-role messages are merged.
 * - Orphaned tool result messages (no preceding assistant tool_use) are dropped.
 * - Result always starts with a user message (Claude requirement).
 */
function convertToClaudeMessages(
  messages: ChatMessage[],
): Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> {
  type ClaudeMsg = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }
  const result: ClaudeMsg[] = []

  let i = 0
  while (i < messages.length) {
    const msg = messages[i]

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content ?? '' })
      i++
    } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // ── Tool call group ──────────────────────────────────────────────────────
      // Collect all consecutive assistant+tool_calls messages into one group.
      // DB stores each tool call as a separate row; LLM sends them all at once.
      const allToolCalls: ToolCall[] = [...msg.tool_calls]
      let j = i + 1
      while (j < messages.length && messages[j].role === 'assistant' && messages[j].tool_calls?.length) {
        allToolCalls.push(...(messages[j].tool_calls ?? []))
        j++
      }

      // Build a map from tool_call_id → tool_use block
      const toolUseById = new Map<string, Record<string, unknown>>()
      for (const tc of allToolCalls) {
        let input: Record<string, unknown>
        try { input = JSON.parse(tc.function.arguments) as Record<string, unknown> } catch { input = {} }
        toolUseById.set(tc.id, { type: 'tool_use', id: tc.id, name: tc.function.name, input })
      }

      // Scan ahead and collect matching tool_result blocks (consume all consecutive 'tool' rows)
      const toolResultBlocks: Array<Record<string, unknown>> = []
      while (j < messages.length && messages[j].role === 'tool') {
        const toolMsg = messages[j]
        if (toolMsg.tool_call_id && toolUseById.has(toolMsg.tool_call_id)) {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolMsg.tool_call_id,
            content: toolMsg.content ?? '',
          })
        }
        j++
      }

      // Only emit the group if every tool_use has a matching tool_result.
      // Incomplete groups (truncated history, server crash mid-execution) are dropped.
      const allMatched = allToolCalls.every(tc =>
        toolResultBlocks.some(r => r.tool_use_id === tc.id),
      )

      if (allMatched && allToolCalls.length > 0) {
        result.push({ role: 'assistant', content: [...toolUseById.values()] })
        result.push({ role: 'user', content: toolResultBlocks })
      }
      // Whether emitted or dropped, advance past all consumed messages
      i = j
    } else if (msg.role === 'assistant') {
      result.push({ role: 'assistant', content: msg.content ?? '' })
      i++
    } else {
      // role === 'tool' with no preceding assistant handling — orphaned, skip
      i++
    }
  }

  // ── Merge consecutive same-role messages ─────────────────────────────────
  // Can occur when incomplete tool groups are dropped (e.g. user[tool_result]
  // followed by user[text], or consecutive assistant text messages).
  const merged: ClaudeMsg[] = []
  for (const entry of result) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === entry.role) {
      // Merge by converting both to arrays if needed
      const prevBlocks = Array.isArray(prev.content)
        ? prev.content as Array<Record<string, unknown>>
        : [{ type: 'text', text: prev.content as string }]
      const curBlocks = Array.isArray(entry.content)
        ? entry.content as Array<Record<string, unknown>>
        : [{ type: 'text', text: entry.content as string }]
      prev.content = [...prevBlocks, ...curBlocks]
    } else {
      merged.push({ role: entry.role, content: entry.content })
    }
  }

  // ── Ensure conversation starts with a user message ─────────────────────
  while (merged.length > 0 && merged[0].role !== 'user') {
    merged.shift()
  }
  if (merged.length === 0 || merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '(continuing conversation)' })
  }

  return merged
}
