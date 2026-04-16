import { useEffect, useRef, useCallback } from 'react'
import { useLocation } from '@tanstack/react-router'
import { X } from 'lucide-react'
import type { AgentTranscriptMessageDto, AgentStatusDto } from '@ainyc/canonry-contracts'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.js'
import { ChatInput } from './ChatInput.js'
import { useAgentTranscript } from './useAgentTranscript.js'
import { useAgentEvents } from './useAgentEvents.js'

interface ChatPanelProps {
  open: boolean
  onClose: () => void
  agentStatus?: AgentStatusDto
  messages: AgentTranscriptMessageDto[]
  isStreaming: boolean
  error: string | null
  sendMessage: (message: string, context?: { page?: string; projectName?: string }) => void
  setMessages: React.Dispatch<React.SetStateAction<AgentTranscriptMessageDto[]>>
  chatInputRef?: React.RefObject<HTMLTextAreaElement | null>
}

/**
 * Renders content with basic code block detection.
 * Triple-backtick fences become <pre><code> blocks.
 */
function renderContent(text: string) {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      // Strip the opening/closing fences and optional language tag
      const inner = part.slice(3, -3).replace(/^[^\n]*\n/, '')
      return (
        <pre key={i} className="my-1 overflow-x-auto rounded bg-zinc-900/60 p-2 text-xs font-mono">
          <code>{inner}</code>
        </pre>
      )
    }
    return <span key={i}>{part}</span>
  })
}

function MessageBubble({ message }: { message: AgentTranscriptMessageDto }) {
  const isUser = message.role === 'user'
  const isStreaming = message.state === 'delta'
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0
  const showChannel = message.channel && message.channel !== 'webchat'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-zinc-800 text-zinc-50'
            : 'border border-zinc-800/60 bg-zinc-900/30 text-zinc-200'
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{renderContent(message.content)}</div>

        {hasToolCalls && (
          <details className="mt-2 text-xs text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-400">
              {message.toolCalls!.length} tool call{message.toolCalls!.length > 1 ? 's' : ''}
            </summary>
            <div className="mt-1 space-y-1">
              {message.toolCalls!.map((tc, i) => (
                <div key={i} className="rounded bg-zinc-900/60 p-1.5 font-mono text-xs">
                  <span className="text-zinc-400">{tc.name}</span>
                  {tc.output != null && (
                    <pre className="mt-0.5 overflow-x-auto text-zinc-500">{typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mt-1 flex items-center gap-1">
          {isStreaming && (
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" />
          )}
          {message.timestamp && (
            <span className="text-[10px] text-zinc-600">
              {new Date(message.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {showChannel && (
            <span className="text-[9px] text-zinc-600">{message.channel}</span>
          )}
        </div>
      </div>
    </div>
  )
}

export function ChatPanel({ open, onClose, agentStatus, messages, isStreaming, error, sendMessage, setMessages, chatInputRef }: ChatPanelProps) {
  const location = useLocation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const transcript = useAgentTranscript(open)

  const sseEnabled = open && agentStatus?.gatewayState === 'running'

  // SSE events — replaces polling
  const { connected, reconnecting } = useAgentEvents(sseEnabled, {
    onMessages: (msgs) => {
      if (!isStreaming) setMessages(msgs)
    },
    onMessage: (msg) => {
      setMessages((prev: AgentTranscriptMessageDto[]) => [...prev, msg])
    },
  })

  // Fall back to transcript query data when SSE hasn't connected yet
  useEffect(() => {
    if (!isStreaming && !connected && transcript.data?.messages?.length) {
      setMessages(transcript.data.messages)
    }
  }, [transcript.data, isStreaming, connected, setMessages])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = useCallback((message: string) => {
    const projectMatch = location.pathname.match(/\/projects\/([^/]+)/)
    const context = {
      page: location.pathname,
      ...(projectMatch ? { projectName: projectMatch[1] } : {}),
    }
    sendMessage(message, context)
  }, [location.pathname, sendMessage])

  const isOffline = agentStatus?.gatewayState === 'stopped'
  const needsSetup = agentStatus?.gatewayState === 'needs-setup'

  return (
    <Sheet open={open} onOpenChange={(v: boolean) => { if (!v) onClose() }}>
      <SheetContent className="flex flex-col !p-0">
        <SheetHeader className="flex flex-row items-center justify-between border-b border-zinc-800/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-sm font-semibold text-zinc-50">Aero</SheetTitle>
            {sseEnabled && (
              <span
                className={`size-1.5 rounded-full ${
                  connected
                    ? 'bg-emerald-400'
                    : reconnecting
                      ? 'bg-amber-400 animate-pulse'
                      : 'bg-zinc-600'
                }`}
                title={connected ? 'Connected' : reconnecting ? 'Reconnecting...' : 'Disconnected'}
              />
            )}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="Close chat">
            <X className="size-4" />
          </button>
        </SheetHeader>

        {needsSetup ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="text-sm text-zinc-400">
              Re-run <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300">canonry agent setup</code> to enable chat.
            </p>
          </div>
        ) : isOffline ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="text-sm text-zinc-400">
              Aero is offline. Run <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300">canonry agent start</code> to connect.
            </p>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 && !isStreaming && (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-zinc-500">Start a conversation with Aero</p>
                </div>
              )}
              {messages.map((msg: AgentTranscriptMessageDto) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
            </div>

            {error && (
              <div className="border-t border-rose-900/40 bg-rose-950/20 px-4 py-2">
                <p className="text-xs text-rose-400">{error}</p>
              </div>
            )}

            <ChatInput onSend={handleSend} disabled={isStreaming} inputRef={chatInputRef} />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
