/**
 * Agent Chat Widget — LLM-powered AEO analyst interface.
 *
 * Displays a chat interface for interacting with the built-in canonry agent.
 * Uses the agent API endpoints to create threads, send messages, and display responses.
 */

import { useState, useRef, useEffect } from 'react'
import { Send, Bot, User, Loader2, MessageSquare, X } from 'lucide-react'
import { Button } from './ui/button.js'
import { Card } from './ui/card.js'

interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName: string | null
  createdAt: string
}

interface AgentThread {
  id: string
  title: string | null
  messages?: AgentMessage[]
}

interface AgentChatProps {
  projectName: string
  onClose?: () => void
}

function getApiKey(): string {
  if (typeof window !== 'undefined' && window.__CANONRY_CONFIG__?.apiKey) {
    return window.__CANONRY_CONFIG__.apiKey
  }
  return ''
}

declare global {
  interface Window {
    __CANONRY_CONFIG__?: { apiKey?: string }
  }
}

export function AgentChat({ projectName, onClose }: AgentChatProps) {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    setError(null)

    // Optimistically add user message
    const tempUserMsg: AgentMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: userMessage,
      toolName: null,
      createdAt: new Date().toISOString(),
    }
    setMessages(prev => [...prev, tempUserMsg])
    setLoading(true)

    try {
      // Create thread if needed
      let currentThreadId = threadId
      const apiKey = getApiKey()
      
      if (!currentThreadId) {
        const threadRes = await fetch(
          `/api/v1/projects/${encodeURIComponent(projectName)}/agent/threads`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({ title: userMessage.slice(0, 80) }),
          },
        )

        if (!threadRes.ok) {
          throw new Error(`Failed to create thread: ${threadRes.status}`)
        }

        const thread = (await threadRes.json()) as AgentThread
        currentThreadId = thread.id
        setThreadId(currentThreadId)
      }

      // Send message
      const messageRes = await fetch(
        `/api/v1/projects/${encodeURIComponent(projectName)}/agent/threads/${currentThreadId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ message: userMessage }),
        },
      )

      if (!messageRes.ok) {
        const errorBody = await messageRes.text()
        throw new Error(`Agent error: ${errorBody}`)
      }

      const result = (await messageRes.json()) as { threadId: string; response: string }

      // Add assistant response
      const assistantMsg: AgentMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: result.response,
        toolName: null,
        createdAt: new Date().toISOString(),
      }

      setMessages(prev => [...prev, assistantMsg])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
      // Remove optimistic user message on error
      setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id))
    } finally {
      setLoading(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <Card className="agent-chat-container">
      <div className="agent-chat-header">
        <div className="flex items-center gap-2">
          <Bot className="size-5 text-emerald-400" />
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">AEO Analyst</h3>
            <p className="text-xs text-zinc-500">Ask about your visibility data</p>
          </div>
        </div>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="size-4" />
          </Button>
        )}
      </div>

      <div className="agent-chat-messages">
        {messages.length === 0 ? (
          <div className="agent-chat-empty">
            <MessageSquare className="size-8 text-zinc-600 mb-2" />
            <p className="text-sm text-zinc-500">Start a conversation with your AEO analyst</p>
            <p className="text-xs text-zinc-600 mt-1">Try: "How's my visibility?" or "Show me recent changes"</p>
          </div>
        ) : (
          messages
            .filter(m => m.role !== 'tool')
            .map(msg => (
              <div
                key={msg.id}
                className={`agent-message ${msg.role === 'user' ? 'agent-message-user' : 'agent-message-assistant'}`}
              >
                <div className="agent-message-avatar">
                  {msg.role === 'user' ? (
                    <User className="size-4" />
                  ) : (
                    <Bot className="size-4 text-emerald-400" />
                  )}
                </div>
                <div className="agent-message-content">
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))
        )}
        {loading && (
          <div className="agent-message agent-message-assistant">
            <div className="agent-message-avatar">
              <Loader2 className="size-4 text-emerald-400 animate-spin" />
            </div>
            <div className="agent-message-content">
              <p className="text-zinc-500 italic">Thinking...</p>
            </div>
          </div>
        )}
        {error && (
          <div className="agent-chat-error">
            <p className="text-sm text-rose-400">{error}</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="agent-chat-input">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Ask a question..."
          disabled={loading}
          className="agent-input-field"
        />
        <Button
          size="sm"
          onClick={handleSend}
          disabled={!input.trim() || loading}
          className="agent-send-button"
        >
          <Send className="size-4" />
        </Button>
      </div>
    </Card>
  )
}
