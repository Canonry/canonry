import { useEffect, useRef, useState, useCallback } from 'react'
import type { AgentTranscriptMessageDto } from '@ainyc/canonry-contracts'
import { streamAgentEvents } from '../../api.js'

interface UseAgentEventsOptions {
  onMessages: (messages: AgentTranscriptMessageDto[]) => void
  onMessage: (message: AgentTranscriptMessageDto) => void
}

interface UseAgentEventsReturn {
  connected: boolean
  reconnecting: boolean
}

/**
 * OpenClaw transcript message shape (2026.4.x+).
 * Each item has `role`, `content` (string or content blocks), `timestamp`, and `__openclaw` metadata.
 */
interface OpenClawTranscriptMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | Array<{ type: string; text?: string }>
  timestamp?: number
  __openclaw?: {
    id?: string
    seq?: number
    kind?: string
  }
}

function extractContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!)
    .join('\n')
}

function mapTranscriptMessage(entry: OpenClawTranscriptMessage): AgentTranscriptMessageDto {
  const meta = entry.__openclaw
  const id = meta?.id ?? `seq-${meta?.seq ?? 0}`
  const seq = meta?.seq ?? 0
  // OpenClaw stamps messages with Date.now() (milliseconds)
  const ts = entry.timestamp
    ? new Date(entry.timestamp).toISOString()
    : new Date().toISOString()

  return {
    id,
    role: entry.role,
    content: extractContent(entry.content),
    timestamp: ts,
    seq,
    state: 'final',
  }
}

export function useAgentEvents(enabled: boolean, opts: UseAgentEventsOptions): UseAgentEventsReturn {
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const retryDelayRef = useRef(1000)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Stable refs for callbacks to avoid re-triggering the effect
  const onMessagesRef = useRef(opts.onMessages)
  onMessagesRef.current = opts.onMessages
  const onMessageRef = useRef(opts.onMessage)
  onMessageRef.current = opts.onMessage

  const connect = useCallback(async () => {
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const response = await streamAgentEvents(controller.signal)

      if (!response.ok || !response.body) {
        throw new Error(`SSE response ${response.status}`)
      }

      setConnected(true)
      setReconnecting(false)
      retryDelayRef.current = 1000 // reset backoff on success

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last partial line in the buffer
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            try {
              const parsed = JSON.parse(data)

              if (currentEvent === 'history') {
                // OpenClaw sends { sessionKey, items: [...], messages: [...], hasMore }
                const rawItems: OpenClawTranscriptMessage[] = parsed.items ?? parsed.messages ?? []
                const messages = rawItems.map(mapTranscriptMessage)
                onMessagesRef.current(messages)
              } else if (currentEvent === 'message') {
                // OpenClaw sends { sessionKey, message: {...}, messageId, messageSeq }
                const rawMsg: OpenClawTranscriptMessage | undefined = parsed.message
                if (rawMsg) {
                  const msg: AgentTranscriptMessageDto = {
                    ...mapTranscriptMessage(rawMsg),
                    id: parsed.messageId ?? rawMsg.__openclaw?.id ?? `seq-${parsed.messageSeq ?? 0}`,
                    seq: parsed.messageSeq ?? rawMsg.__openclaw?.seq ?? 0,
                  }
                  onMessageRef.current(msg)
                }
              }
            } catch {
              // skip malformed JSON
            }
            currentEvent = ''
          } else if (line.trim() === '') {
            // Empty line resets event state (SSE spec)
            currentEvent = ''
          }
        }
      }

      // Stream ended cleanly — reconnect
      setConnected(false)
    } catch {
      if (controller.signal.aborted) return // intentional disconnect
      setConnected(false)
    }

    // Schedule reconnect with exponential backoff
    if (!controller.signal.aborted) {
      setReconnecting(true)
      const delay = retryDelayRef.current
      retryDelayRef.current = Math.min(delay * 2, 30_000)
      retryTimerRef.current = setTimeout(() => {
        void connect()
      }, delay)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      // Cleanup if disabled
      abortRef.current?.abort()
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      setConnected(false)
      setReconnecting(false)
      return
    }

    void connect()

    return () => {
      abortRef.current?.abort()
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [enabled, connect])

  return { connected, reconnecting }
}
