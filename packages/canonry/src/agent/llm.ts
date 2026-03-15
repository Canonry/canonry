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

const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
}

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  claude: 'claude-sonnet-4-5-20250514',
  gemini: 'gemini-2.5-flash',
}

export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: AgentTool[],
): Promise<CompletionResponse> {
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
  }

  if (config.provider === 'gemini') {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`
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
        const content: Array<Record<string, unknown>> = []
        if (msg.content) {
          content.push({ type: 'text', text: msg.content })
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          })
        }
        result.push({ role: 'assistant', content })
      } else {
        result.push({ role: 'assistant', content: msg.content ?? '' })
      }
    } else if (msg.role === 'tool') {
      // Claude expects tool results as user messages with tool_result content blocks
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content ?? '',
          },
        ],
      })
    }
  }

  return result
}
