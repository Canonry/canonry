/**
 * Agent loop — the core LLM ↔ tool execution cycle.
 *
 * Modeled after OpenClaw's agent pattern:
 * 1. Load conversation history from SQLite
 * 2. Send to LLM with tools
 * 3. If LLM calls tools → execute → loop back
 * 4. If LLM returns text → persist and return
 */

import type { AgentStore } from './store.js'
import type { AgentTool } from './tools.js'
import type { LlmConfig } from './llm.js'
import { chatCompletion } from './llm.js'
import { buildSystemPrompt } from './prompt.js'

interface LoopOptions {
  store: AgentStore
  tools: AgentTool[]
  llmConfig: LlmConfig
  project: {
    name: string
    displayName: string
    domain: string
    country: string
    language: string
  }
  maxSteps?: number
  maxHistoryMessages?: number
  /** Whether system tools (shell, file I/O) are enabled */
  systemTools?: boolean
  /** Called when the agent produces a text chunk (for streaming) */
  onText?: (text: string) => void
  /** Called when a tool is about to execute */
  onToolCall?: (name: string, args: Record<string, unknown>) => void
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export async function agentChat(
  threadId: string,
  userMessage: string,
  opts: LoopOptions,
): Promise<string> {
  const { store, tools, llmConfig, project, maxSteps = 10, maxHistoryMessages = 30 } = opts

  // Persist user message
  await store.addMessage({
    threadId,
    role: 'user',
    content: userMessage,
    toolName: null,
    toolArgs: null,
    toolCallId: null,
  })

  // Load conversation history
  const history = await store.getMessages(threadId, maxHistoryMessages)

  // Detect new thread — only the user's message exists (first message in thread).
  // This triggers the startup sequence instruction in the system prompt.
  const isNewThread = history.length === 1 && history[0].role === 'user'

  // Auto-title new threads from the user's first message
  if (isNewThread) {
    const title = userMessage.length > 80 ? userMessage.slice(0, 77) + '...' : userMessage
    await store.updateThreadTitle(threadId, title)
  }

  // Build message array for LLM
  const systemPrompt = buildSystemPrompt(project, { isNewThread, systemTools: opts.systemTools })
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ]

  // Convert stored messages to LLM format.
  // The DB stores each tool call as a separate assistant row followed by its
  // tool result row. We need to group consecutive tool-call/result pairs into
  // a single assistant message + tool results block, because Claude requires
  // tool_result blocks to reference tool_use blocks in the immediately
  // preceding assistant message.
  let i = 0
  while (i < history.length) {
    const msg = history[i]

    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content })
      i++
    } else if (msg.role === 'assistant' && msg.toolName) {
      // Collect all consecutive (assistant tool-call, tool result) pairs
      // into one assistant message + one batch of tool results.
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
      const toolResults: ChatMessage[] = []

      while (i < history.length && history[i].role === 'assistant' && history[i].toolName) {
        const tc = history[i]
        const callId = tc.toolCallId ?? tc.id
        toolCalls.push({
          id: callId,
          type: 'function',
          function: { name: tc.toolName!, arguments: tc.toolArgs ?? '{}' },
        })
        // Look for the matching tool result (should be next or nearby)
        const resultIdx = history.findIndex((m, j) => j > i && m.role === 'tool' && m.toolCallId === callId)
        if (resultIdx !== -1) {
          toolResults.push({
            role: 'tool',
            content: history[resultIdx].content,
            tool_call_id: callId,
          })
        }
        i++
      }
      // Skip past any tool result rows we already consumed
      while (i < history.length && history[i].role === 'tool') {
        // Check if this result was already captured above
        const alreadyCaptured = toolResults.some(r => r.tool_call_id === history[i].toolCallId)
        if (!alreadyCaptured) {
          toolResults.push({
            role: 'tool',
            content: history[i].content,
            tool_call_id: history[i].toolCallId ?? undefined,
          })
        }
        i++
      }

      messages.push({ role: 'assistant', content: null, tool_calls: toolCalls })
      messages.push(...toolResults)
    } else if (msg.role === 'assistant') {
      messages.push({ role: 'assistant', content: msg.content })
      i++
    } else if (msg.role === 'tool') {
      // Orphaned tool result (shouldn't happen after grouping, but handle gracefully)
      messages.push({ role: 'tool', content: msg.content, tool_call_id: msg.toolCallId ?? undefined })
      i++
    } else {
      i++
    }
  }

  // Agent loop
  let step = 0
  while (step < maxSteps) {
    step++

    const response = await chatCompletion(llmConfig, messages, tools)

    if (response.type === 'text') {
      const text = response.text ?? ''

      // Persist assistant message
      await store.addMessage({
        threadId,
        role: 'assistant',
        content: text,
        toolName: null,
        toolArgs: null,
        toolCallId: null,
      })

      await store.touchThread(threadId)
      opts.onText?.(text)

      return text
    }

    // Tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      // Add assistant tool-call message to conversation
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: response.toolCalls,
      })

      for (const toolCall of response.toolCalls) {
        const toolName = toolCall.function.name
        
        // Parse tool arguments with error handling (LLMs sometimes return malformed JSON)
        let toolArgs: Record<string, unknown>
        try {
          toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
        } catch {
          const result = `Invalid arguments for ${toolName}: ${toolCall.function.arguments}`
          
          // Persist error and continue
          await store.addMessage({
            threadId,
            role: 'assistant',
            content: `Calling ${toolName}`,
            toolName,
            toolArgs: toolCall.function.arguments,
            toolCallId: toolCall.id,
          })

          await store.addMessage({
            threadId,
            role: 'tool',
            content: result,
            toolName,
            toolArgs: null,
            toolCallId: toolCall.id,
          })

          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: toolCall.id,
          })

          continue
        }

        opts.onToolCall?.(toolName, toolArgs)

        // Persist assistant tool-call row BEFORE execution so the DB
        // always has a matching assistant row for the tool result.
        await store.addMessage({
          threadId,
          role: 'assistant',
          content: `Calling ${toolName}`,
          toolName,
          toolArgs: JSON.stringify(toolArgs),
          toolCallId: toolCall.id,
        })

        // Find and execute tool
        const tool = tools.find(t => t.name === toolName)
        let result: string

        if (tool) {
          try {
            result = await tool.execute(toolArgs)
          } catch (err) {
            result = `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}`
          }
        } else {
          result = `Unknown tool: ${toolName}`
        }

        await store.addMessage({
          threadId,
          role: 'tool',
          content: result,
          toolName,
          toolArgs: null,
          toolCallId: toolCall.id,
        })

        // Add tool result to conversation
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        })
      }
    }
  }

  const fallback = 'I hit the maximum number of steps. Could you try a more specific question?'
  await store.addMessage({
    threadId,
    role: 'assistant',
    content: fallback,
    toolName: null,
    toolArgs: null,
    toolCallId: null,
  })
  return fallback
}
