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
 * Maps an OpenClaw history entry to a transcript message DTO.
 * Mirrors the server-side `mapEntry` in `agent-transcript.ts`.
 */
function mapEntry(entry: { runId?: string; seq: number; state: string; message?: string }, index: number): AgentTranscriptMessageDto {
  return {
    id: entry.runId ?? `seq-${entry.seq}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: entry.message ?? '',
    timestamp: new Date().toISOString(),
    seq: entry.seq,
    state: entry.state as AgentTranscriptMessageDto['state'],
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

              if (currentEvent === 'history' && Array.isArray(parsed.history)) {
                const messages = parsed.history.map(mapEntry)
                onMessagesRef.current(messages)
              } else if (currentEvent === 'message') {
                // Live message — map as a single entry
                const msg: AgentTranscriptMessageDto = {
                  id: parsed.id ?? `seq-${parsed.seq}`,
                  role: parsed.role ?? 'assistant', // live messages are typically assistant
                  content: parsed.message ?? '',
                  timestamp: new Date().toISOString(),
                  seq: parsed.seq,
                  state: parsed.state ?? 'final',
                  channel: parsed.channel,
                }
                onMessageRef.current(msg)
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
