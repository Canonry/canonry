import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { complete, type Api, type Context, type Message, type Model } from '@mariozechner/pi-ai'
import { AGENT_MEMORY_VALUE_MAX_BYTES } from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  COMPACTION_MAX_MESSAGES,
  COMPACTION_PRESERVE_TAIL_MESSAGES,
  COMPACTION_TARGET_RATIO,
  COMPACTION_TOKEN_THRESHOLD,
} from './compaction-config.js'
import { estimateTranscriptTokens } from './token-counter.js'
import { writeCompactionNote } from './memory-store.js'

/**
 * Fires when estimated tokens exceed the threshold OR the raw message
 * count exceeds the hard cap. The count fallback matters for pathological
 * patterns (many tiny tool results) that inflate the array without
 * crossing the char-based token estimate.
 */
export function shouldCompact(messages: readonly AgentMessage[]): boolean {
  if (messages.length >= COMPACTION_MAX_MESSAGES) return true
  return estimateTranscriptTokens(messages) >= COMPACTION_TOKEN_THRESHOLD
}

/**
 * Snap a desired split index forward to the next `UserMessage` boundary so
 * the summarized prefix contains complete turns only. Every turn starts
 * with a user message in pi's transcript, so splitting immediately before
 * one guarantees we don't orphan an assistant's tool call from its
 * matching tool results.
 *
 * Returns `0` when no safe split exists with at least
 * `COMPACTION_PRESERVE_TAIL_MESSAGES` messages remaining in the tail —
 * callers treat that as "skip compaction this turn."
 */
export function findSafeSplit(messages: readonly AgentMessage[], targetIndex: number): number {
  const maxSplit = messages.length - COMPACTION_PRESERVE_TAIL_MESSAGES
  if (maxSplit <= 0) return 0
  const boundedTarget = Math.max(0, Math.min(targetIndex, maxSplit))
  for (let i = boundedTarget; i <= maxSplit; i++) {
    const m = messages[i]
    if (m && m.role === 'user') return i
  }
  return 0
}

/** Only LLM-compatible messages reach the summarizer. */
function toLlmMessages(messages: readonly AgentMessage[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult') {
      out.push(m)
    }
  }
  return out
}

const SUMMARY_SYSTEM_PROMPT = `You compress an AI agent conversation transcript into a short durable note.

Extract only:
- User intents and requests
- Actions the agent took and their outcomes
- Key findings, insights, decisions
- Outstanding TODOs or deferred follow-ups

Style: dense bullet points. No preamble, no closing remarks, no agent self-commentary. Keep the note under 1500 characters.`

/**
 * Truncate on byte length (UTF-8), not character count, so multi-byte
 * glyphs don't bust the memory-row cap. Leaves an ellipsis marker when
 * truncation happens so the agent knows the note was cut.
 */
function truncateToByteLimit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const suffix = '…[truncated]'
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8')
  let buf = Buffer.from(text, 'utf8').subarray(0, budget)
  // Drop a trailing partial UTF-8 sequence if we cut mid-codepoint.
  while (buf.length > 0 && (buf[buf.length - 1] & 0b1100_0000) === 0b1000_0000) {
    buf = buf.subarray(0, buf.length - 1)
  }
  return buf.toString('utf8') + suffix
}

export interface RunSummaryLlmArgs {
  model: Model<Api>
  chunk: readonly AgentMessage[]
  getApiKey?: (provider: string) => string | undefined
}

/**
 * One-shot summarizer call via pi-ai's non-streaming `complete`. Returns
 * the concatenated text content from the assistant reply. Throws on
 * provider error or empty output so callers can fall back to "keep the
 * transcript uncompacted."
 */
export async function runSummaryLlm(args: RunSummaryLlmArgs): Promise<string> {
  const context: Context = {
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    messages: toLlmMessages(args.chunk),
  }
  const apiKey = args.getApiKey?.(args.model.provider)
  const resp = await complete(args.model, context, apiKey ? { apiKey } : {})
  const parts = resp.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
  const text = parts.map((p) => p.text).join('\n').trim()
  if (!text) throw new Error('summary LLM returned no text content')
  return text
}

export interface CompactMessagesArgs {
  db: DatabaseClient
  projectId: string
  sessionId: string
  messages: readonly AgentMessage[]
  model: Model<Api>
  getApiKey?: (provider: string) => string | undefined
  /** Override the summarizer — used in tests to avoid a real LLM call. */
  summarize?: (args: RunSummaryLlmArgs) => Promise<string>
}

export interface CompactMessagesResult {
  messages: AgentMessage[]
  removedCount: number
  summary: string
}

/**
 * Orchestrates a single compaction: pick a safe split, summarize the
 * prefix, persist the summary as a `compaction:` memory row, return the
 * kept suffix. Returns `null` when there's no safe split available — the
 * caller must continue with the unchanged transcript.
 *
 * Summarizer failures bubble up; callers are expected to catch and log
 * so a flaky summarizer never blocks a user turn.
 */
export async function compactMessages(args: CompactMessagesArgs): Promise<CompactMessagesResult | null> {
  const target = Math.floor(args.messages.length * COMPACTION_TARGET_RATIO)
  const split = findSafeSplit(args.messages, target)
  if (split === 0) return null

  const chunk = args.messages.slice(0, split)
  const suffix = args.messages.slice(split)

  const summarize = args.summarize ?? runSummaryLlm
  const rawSummary = await summarize({ model: args.model, chunk, getApiKey: args.getApiKey })
  const summary = truncateToByteLimit(rawSummary, AGENT_MEMORY_VALUE_MAX_BYTES)

  writeCompactionNote(args.db, {
    projectId: args.projectId,
    sessionId: args.sessionId,
    summary,
    removedCount: chunk.length,
  })

  return { messages: suffix, removedCount: chunk.length, summary }
}
