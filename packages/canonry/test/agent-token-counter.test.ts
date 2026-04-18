import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { estimateMessageTokens, estimateTranscriptTokens } from '../src/agent/token-counter.js'

describe('token-counter', () => {
  it('estimates string content via chars/4', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: 'a'.repeat(40),
      timestamp: 0,
    } as AgentMessage
    expect(estimateMessageTokens(msg)).toBe(10)
  })

  it('sums text blocks from an assistant message', () => {
    const msg: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'x'.repeat(20) },
        { type: 'text', text: 'y'.repeat(20) },
      ],
      api: 'faux-api',
      provider: 'faux',
      model: 'faux-model',
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 0,
    } as AgentMessage
    expect(estimateMessageTokens(msg)).toBe(10)
  })

  it('counts thinking content and serialized tool-call arguments', () => {
    const msg: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'z'.repeat(16) },
        { type: 'toolCall', id: 't1', name: 'get_status', arguments: { flag: true } },
      ],
      api: 'faux-api',
      provider: 'faux',
      model: 'faux-model',
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 0,
    } as AgentMessage
    // 16 chars thinking + `{"flag":true}` = 13 chars → 29 chars → 8 tokens
    expect(estimateMessageTokens(msg)).toBe(Math.ceil((16 + 13) / 4))
  })

  it('counts tool-result messages via their text content', () => {
    const msg: AgentMessage = {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'get_status',
      content: [{ type: 'text', text: 'q'.repeat(16) }],
      isError: false,
      timestamp: 0,
    } as AgentMessage
    expect(estimateMessageTokens(msg)).toBe(4)
  })

  it('sums tokens across a transcript', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'a'.repeat(40), timestamp: 0 } as AgentMessage,
      { role: 'user', content: 'b'.repeat(40), timestamp: 0 } as AgentMessage,
    ]
    expect(estimateTranscriptTokens(messages)).toBe(20)
  })

  it('handles missing content defensively', () => {
    const msg = { role: 'user', timestamp: 0 } as unknown as AgentMessage
    expect(estimateMessageTokens(msg)).toBe(0)
  })
})
