import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentTranscriptMessageDto } from '@ainyc/canonry-contracts'
import { streamAgentChat } from '../../api.js'
import { queryKeys } from '../../queries/query-keys.js'

interface UseAgentChatReturn {
  messages: AgentTranscriptMessageDto[]
  isStreaming: boolean
  error: string | null
  sendMessage: (message: string, context?: { page?: string; projectName?: string }) => void
  setMessages: React.Dispatch<React.SetStateAction<AgentTranscriptMessageDto[]>>
}

export function useAgentChat(): UseAgentChatReturn {
  const [messages, setMessages] = useState<AgentTranscriptMessageDto[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const sendMessage = useCallback(async (message: string, context?: { page?: string; projectName?: string }) => {
    setError(null)

    const userMsg: AgentTranscriptMessageDto = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
      seq: messages.length,
      state: 'final',
    }

    const assistantMsg: AgentTranscriptMessageDto = {
      id: `local-${Date.now()}-assistant`,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      seq: messages.length + 1,
      state: 'delta',
    }

    setMessages(prev => [...prev, userMsg, assistantMsg])
    setIsStreaming(true)

    try {
      const response = await streamAgentChat({ message, context, stream: true })

      if (!response.ok) {
        const body = await response.text()
        let errorMessage = `Agent returned ${response.status}`
        try {
          const parsed = JSON.parse(body)
          if (parsed.error?.message) errorMessage = parsed.error.message
        } catch { /* use default */ }
        setError(errorMessage)
        setMessages(prev => prev.filter(m => m.id !== assistantMsg.id))
        setIsStreaming(false)
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        setError('No response stream available')
        setIsStreaming(false)
        return
      }

      const decoder = new TextDecoder()
      let accumulated = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta?.content ?? ''
              if (delta) {
                accumulated += delta
                setMessages(prev =>
                  prev.map(m =>
                    m.id === assistantMsg.id ? { ...m, content: accumulated } : m,
                  ),
                )
              }
            } catch { /* skip malformed SSE lines */ }
          }
        }
      }

      // Mark assistant message as final
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: 'final' } : m,
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
      setMessages(prev => prev.filter(m => m.id !== assistantMsg.id))
    } finally {
      setIsStreaming(false)
      queryClient.invalidateQueries({ queryKey: queryKeys.agent.transcript() })
    }
  }, [messages.length, queryClient])

  return { messages, isStreaming, error, sendMessage, setMessages }
}
