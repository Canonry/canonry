import type { AgentMessage } from '@mariozechner/pi-agent-core'

/**
 * Cheap token estimator — chars/4 heuristic, no model-specific tokenizer.
 *
 * We use this only to decide when to compact, not to enforce a hard
 * provider limit. Real token counts vary by model (BPE vs tiktoken vs
 * SentencePiece); what matters is that the estimate is roughly
 * monotonic with the true count so the trigger fires before any provider
 * refuses the request. The 4-chars-per-token rule is accurate enough for
 * English prose and structured JSON — both dominant in Aero transcripts.
 */
const CHARS_PER_TOKEN = 4

/**
 * Estimate tokens for a single AgentMessage. Handles the three shapes
 * pi-ai emits:
 *   - UserMessage.content: `string | (TextContent | ImageContent)[]`
 *   - AssistantMessage.content: `(TextContent | ThinkingContent | ToolCall)[]`
 *   - ToolResultMessage.content: `(TextContent | ImageContent)[]`
 *
 * Images contribute a fixed nominal cost — their base64 data would
 * massively skew a char-count estimate and isn't what providers bill on.
 */
export function estimateMessageTokens(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content
  if (content === undefined) return 0

  if (typeof content === 'string') {
    return Math.ceil(content.length / CHARS_PER_TOKEN)
  }

  if (!Array.isArray(content)) return 0

  let chars = 0
  for (const part of content) {
    if (part && typeof part === 'object' && 'type' in part) {
      const p = part as { type: string; text?: string; thinking?: string; arguments?: unknown }
      switch (p.type) {
        case 'text':
          chars += (p.text ?? '').length
          break
        case 'thinking':
          chars += (p.thinking ?? '').length
          break
        case 'toolCall':
          try {
            chars += JSON.stringify(p.arguments ?? {}).length
          } catch {
            // Non-serializable args are rare; fall back to a modest estimate.
            chars += 64
          }
          break
        case 'image':
          // Nominal cost — providers don't bill on base64 length.
          chars += 1024
          break
        default:
          break
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Sum token estimates across a transcript. Used by `shouldCompact` to
 * decide when to trigger summarization.
 */
export function estimateTranscriptTokens(messages: readonly AgentMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateMessageTokens(m)
  return total
}
