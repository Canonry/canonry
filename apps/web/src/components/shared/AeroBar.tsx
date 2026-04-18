import { useEffect, useRef, useState } from 'react'
import { Sparkles, X, RotateCcw, ArrowUp, Maximize2, Minimize2 } from 'lucide-react'
import { useLocation } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { fetchProjects } from '../../api.js'
import { queryKeys } from '../../queries/query-keys.js'
import {
  extractAssistantText,
  fetchAeroTranscript,
  promptAero,
  resetAeroTranscript,
  type AeroEvent,
  type AeroMessage,
} from '../../api-aero.js'

interface AeroBarProps {
  projectName: string
}

const STARTER_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: 'Status', prompt: 'Quick status overview for this project — latest runs, current health, anything unusual.' },
  { label: 'Top insights', prompt: 'Walk me through the 3 most severe active insights and what to do about each.' },
  { label: 'Last failed run', prompt: 'If the latest run failed, dig into it and tell me what went wrong plus how to fix it.' },
  { label: 'Schedule', prompt: 'What is the current sweep schedule, and is it appropriate given recent volatility?' },
]

export function AeroBar({ projectName }: AeroBarProps) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<AeroMessage[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [activeTools, setActiveTools] = useState<Array<{ id: string; name: string; args: unknown }>>([])
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  // Escape key collapses expanded → compact first, then closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (expanded) setExpanded(false)
      else setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, expanded])

  // Load transcript when opened / when the project changes, and poll while
  // open so proactive turns (from RunCoordinator wake-ups) surface without a
  // page refresh or a user prompt.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)

    const load = () => {
      if (cancelled || streaming) return
      fetchAeroTranscript(projectName)
        .then((t) => {
          if (!cancelled) setMessages(t.messages)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load transcript')
        })
    }

    load()
    const POLL_MS = 15_000
    const interval = window.setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [open, projectName, streaming])

  // Cancel any in-flight stream when the component unmounts or project changes.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [projectName])

  // Auto-scroll to the bottom on new messages / streaming tokens.
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamingText, activeTools])

  async function send(promptText: string) {
    const trimmed = promptText.trim()
    if (!trimmed || streaming) return
    setError(null)
    setDraft('')
    setStreaming(true)
    setStreamingText('')
    setActiveTools([])

    const optimistic: AeroMessage = { role: 'user', content: trimmed, timestamp: Date.now() }
    setMessages((prev) => [...prev, optimistic])

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      await promptAero({
        project: projectName,
        prompt: trimmed,
        signal: ctrl.signal,
        onEvent: handleEvent,
      })
      // Final transcript reload ensures we're in sync with the server
      // (covers edge cases like events landing after the last message_end).
      const latest = await fetchAeroTranscript(projectName)
      setMessages(latest.messages)
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Prompt failed')
      }
    } finally {
      setStreaming(false)
      setStreamingText('')
      setActiveTools([])
      abortRef.current = null
    }
  }

  function handleEvent(event: AeroEvent) {
    switch (event.type) {
      case 'message_update':
        setStreamingText(extractAssistantText(event.message))
        break
      case 'message_end':
        if (event.message.role === 'assistant') setStreamingText('')
        break
      case 'tool_execution_start':
        setActiveTools((prev) => [...prev, { id: event.toolCallId, name: event.toolName, args: event.args }])
        break
      case 'tool_execution_end':
        setActiveTools((prev) => prev.filter((t) => t.id !== event.toolCallId))
        break
      case 'error':
        setError(event.message)
        break
    }
  }

  async function handleReset() {
    abortRef.current?.abort()
    try {
      await resetAeroTranscript(projectName)
      setMessages([])
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    }
  }

  const conversationIsEmpty = messages.length === 0

  // Layout classes depend on (open, expanded):
  //   closed    → compact pill at bottom
  //   open      → panel at bottom, max-w-3xl, ~40vh transcript
  //   expanded  → near-fullscreen overlay with backdrop, big transcript
  const hostClasses = open && expanded
    ? 'pointer-events-auto fixed inset-0 z-40 flex items-stretch justify-center bg-zinc-950/70 p-4 sm:p-8 backdrop-blur-sm'
    : 'pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-3'

  const panelClasses = expanded
    ? 'pointer-events-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/95 shadow-2xl'
    : 'pointer-events-auto w-full max-w-3xl'

  const transcriptClasses = expanded
    ? 'flex-1 overflow-y-auto px-6 py-5 text-sm text-zinc-200'
    : 'max-h-[40vh] min-h-[120px] overflow-y-auto px-4 py-3 text-sm text-zinc-200'

  return (
    <div
      className={hostClasses}
      onClick={(e) => {
        // Backdrop click in expanded mode collapses back to compact.
        if (expanded && e.target === e.currentTarget) setExpanded(false)
      }}
    >
      <div className={panelClasses}>
        {open ? (
          <div className={expanded ? 'flex h-full flex-col' : 'flex flex-col overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/95 shadow-xl backdrop-blur'}>
            <div className="flex items-center justify-between gap-2 border-b border-zinc-800/70 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                <span className="text-sm font-medium text-zinc-100">Aero</span>
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                  {streaming ? 'working…' : projectName}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleReset}
                  className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-200"
                  aria-label="Reset conversation"
                  title="Reset conversation"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-200"
                  aria-label={expanded ? 'Collapse' : 'Expand'}
                  title={expanded ? 'Collapse' : 'Expand'}
                >
                  {expanded ? (
                    <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(false)
                    setOpen(false)
                  }}
                  className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-200"
                  aria-label="Close Aero"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div ref={transcriptRef} className={transcriptClasses}>
              {error && (
                <div className="mb-2 rounded-md border border-rose-700/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                  {error}
                </div>
              )}
              {conversationIsEmpty && !streaming && (
                <div className="flex flex-col gap-3 py-2">
                  <p className="text-xs text-zinc-500">
                    Ask anything about <span className="text-zinc-300">{projectName}</span>, or start with:
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {STARTER_PROMPTS.map((s) => (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => send(s.prompt)}
                        className="rounded-full border border-zinc-800 bg-zinc-900/70 px-3 py-1 text-xs text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-100"
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <MessageRow key={messageKey(msg, i)} message={msg} />
              ))}
              {streaming && streamingText && (
                <div className="mt-3">
                  <div className="mb-0.5 text-[10px] uppercase tracking-wider text-emerald-400">Aero</div>
                  <AeroMarkdown content={streamingText} />
                </div>
              )}
              {activeTools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {activeTools.map((t) => (
                    <span
                      key={t.id}
                      className="rounded-full border border-emerald-800/50 bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-300"
                    >
                      ⟐ {t.name}
                    </span>
                  ))}
                </div>
              )}
              {streaming && !streamingText && activeTools.length === 0 && <TypingIndicator />}
            </div>

            <form
              className="flex items-end gap-2 border-t border-zinc-800/70 bg-zinc-950/80 px-3 py-2.5"
              onSubmit={(e) => {
                e.preventDefault()
                void send(draft)
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send(draft)
                  }
                }}
                placeholder="Ask Aero…"
                disabled={streaming}
                rows={expanded ? 3 : 1}
                className="flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={streaming || !draft.trim()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500 text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
                aria-label="Send"
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </form>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex w-full items-center justify-between rounded-full border border-zinc-800/80 bg-zinc-950/95 px-4 py-2 text-left text-sm text-zinc-400 shadow-lg backdrop-blur transition hover:border-zinc-700 hover:bg-zinc-900/90 hover:text-zinc-200"
          >
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              Ask Aero about {projectName}…
            </span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-600">Enter</span>
          </button>
        )}
      </div>
    </div>
  )
}

function messageKey(message: AeroMessage, fallbackIndex: number): string {
  const ts = message.timestamp ?? 0
  return `${message.role}:${ts}:${fallbackIndex}`
}

function MessageRow({ message }: { message: AeroMessage }) {
  if (message.role === 'user') {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    // Skip the [system] wake-up messages in the UI — they're internal plumbing.
    if (text.startsWith('[system]')) return null
    return (
      <div className="mt-3 rounded-md bg-zinc-900/60 px-3 py-2 text-zinc-200">
        <div className="mb-0.5 text-[10px] uppercase tracking-wider text-zinc-500">You</div>
        <div className="whitespace-pre-wrap">{text}</div>
      </div>
    )
  }
  if (message.role === 'assistant') {
    const text = extractAssistantText(message)
    if (!text.trim()) return null
    return (
      <div className="mt-3">
        <div className="mb-0.5 text-[10px] uppercase tracking-wider text-emerald-400">Aero</div>
        <AeroMarkdown content={text} />
      </div>
    )
  }
  return null
}

/**
 * Markdown renderer scoped to Aero responses — react-markdown with
 * Tailwind-styled element overrides so headings/tables/lists match the
 * dashboard's zinc palette instead of browser defaults.
 */
function AeroMarkdown({ content }: { content: string }) {
  return (
    <div className="aero-markdown text-zinc-100">
      <ReactMarkdown
        components={{
          h1: (props) => <h1 {...props} className="mt-3 mb-2 text-base font-semibold text-zinc-50" />,
          h2: (props) => <h2 {...props} className="mt-3 mb-2 text-sm font-semibold text-zinc-50" />,
          h3: (props) => <h3 {...props} className="mt-3 mb-1.5 text-sm font-semibold text-zinc-100" />,
          h4: (props) => <h4 {...props} className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-300" />,
          p: (props) => <p {...props} className="mb-2 leading-relaxed" />,
          ul: (props) => <ul {...props} className="mb-2 ml-4 list-disc space-y-1" />,
          ol: (props) => <ol {...props} className="mb-2 ml-4 list-decimal space-y-1" />,
          li: (props) => <li {...props} className="marker:text-zinc-600" />,
          strong: (props) => <strong {...props} className="font-semibold text-zinc-50" />,
          em: (props) => <em {...props} className="text-zinc-200" />,
          code: ({ children, ...props }) => (
            <code
              {...props}
              className="rounded bg-zinc-800/70 px-1 py-0.5 font-mono text-[12px] text-emerald-200"
            >
              {children}
            </code>
          ),
          pre: (props) => (
            <pre
              {...props}
              className="mb-2 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/70 p-3 font-mono text-xs text-zinc-200"
            />
          ),
          a: (props) => (
            <a
              {...props}
              className="text-emerald-400 underline decoration-emerald-700 hover:decoration-emerald-400"
              target="_blank"
              rel="noopener noreferrer"
            />
          ),
          table: (props) => (
            <div className="mb-2 overflow-x-auto">
              <table {...props} className="w-full border-collapse text-xs" />
            </div>
          ),
          thead: (props) => <thead {...props} className="border-b border-zinc-800" />,
          th: (props) => <th {...props} className="px-2 py-1 text-left font-semibold text-zinc-300" />,
          tr: (props) => <tr {...props} className="border-b border-zinc-900" />,
          td: (props) => <td {...props} className="px-2 py-1 text-zinc-200" />,
          blockquote: (props) => (
            <blockquote
              {...props}
              className="mb-2 border-l-2 border-zinc-700 pl-3 italic text-zinc-400"
            />
          ),
          hr: () => <hr className="my-3 border-zinc-800" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

/** Three-dot "Aero is thinking" indicator. Shown pre-first-token and between tool rounds. */
function TypingIndicator() {
  return (
    <div className="mt-3 flex items-center gap-2">
      <div className="text-[10px] uppercase tracking-wider text-emerald-400">Aero</div>
      <div className="flex items-center gap-1" aria-label="Aero is thinking">
        <span className="aero-dot h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
        <span className="aero-dot aero-dot-2 h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
        <span className="aero-dot aero-dot-3 h-1.5 w-1.5 rounded-full bg-emerald-400/40" />
      </div>
    </div>
  )
}

/**
 * Host component: reads the router location and renders the AeroBar only
 * when we're on a project-scoped route. Keeps the bar hidden on overview /
 * settings / setup pages where there's no project context to ask about.
 *
 * The `/projects/$projectId` route carries the project's UUID, not its
 * name. Aero's server routes (and the whole agent-first API surface) key
 * off the project name, so we resolve UUID → name via the cached project
 * list before rendering. Accepts a name in the URL slot too — harmless
 * fallback if the route ever changes to use slugs.
 */
export function AeroBarHost() {
  const location = useLocation()
  const match = /^\/projects\/([^/]+)/.exec(location.pathname)
  const urlSegment = match ? decodeURIComponent(match[1]) : null

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: fetchProjects,
    enabled: urlSegment !== null,
    staleTime: 60_000,
  })

  if (!urlSegment) return null
  const projects = projectsQuery.data ?? []
  const resolved =
    projects.find((p) => p.id === urlSegment) ?? projects.find((p) => p.name === urlSegment)

  if (!resolved) return null
  return <AeroBar key={resolved.name} projectName={resolved.name} />
}
