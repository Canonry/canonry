import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Sparkles,
  X,
  RotateCcw,
  ArrowUp,
  Maximize2,
  Minimize2,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertTriangle,
  Wrench,
  Copy,
} from 'lucide-react'
import { useLocation } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { fetchProjects } from '../../api.js'
import { queryKeys } from '../../queries/query-keys.js'
import {
  extractAssistantText,
  fetchAeroTranscript,
  fetchAgentProviders,
  promptAero,
  resetAeroTranscript,
  type AeroAssistantMessage,
  type AeroEvent,
  type AeroMessage,
  type AeroToolResultMessage,
  type AeroToolScope,
  type AgentProviderId,
  type AgentProviderOption,
} from '../../api-aero.js'

/**
 * A single tool invocation within an assistant turn. Hydrated from two
 * sources: live `tool_execution_*` events for the in-flight turn, and
 * reconstructed from persisted `toolCall` blocks + following `toolResult`
 * messages when we render transcript history.
 */
interface ToolTrail {
  id: string
  name: string
  args: unknown
  startedAt: number
  endedAt?: number
  isError?: boolean
  result?: unknown
}

interface AeroBarProps {
  projectName: string
}

const STARTER_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: 'Status', prompt: 'Quick status overview for this project — latest runs, current health, anything unusual.' },
  { label: 'Top insights', prompt: 'Walk me through the 3 most severe active insights and what to do about each.' },
  { label: 'Last failed run', prompt: 'If the latest run failed, dig into it and tell me what went wrong plus how to fix it.' },
  { label: 'Schedule', prompt: 'What is the current sweep schedule, and is it appropriate given recent volatility?' },
]

/**
 * Pre-baked prompts the composer palette surfaces when the user types `/`.
 * `prompt` is what gets sent to Aero; `command` is the shorthand the user
 * types; `label` / `hint` drive the palette UI. Keep these scoped to
 * read-only operations — write commands (`/run-sweep`) explicitly flag that
 * they'll ask Aero to invoke a tool so the user isn't surprised.
 */
const SLASH_COMMANDS: Array<{
  command: string
  label: string
  hint: string
  prompt: string
}> = [
  {
    command: '/status',
    label: 'Status',
    hint: 'Latest runs, health, anything unusual',
    prompt: 'Quick status overview for this project — latest runs, current health, anything unusual.',
  },
  {
    command: '/insights',
    label: 'Top insights',
    hint: 'Walk through the most severe active insights',
    prompt: 'Walk me through the 3 most severe active insights and what to do about each.',
  },
  {
    command: '/last-run',
    label: 'Last run',
    hint: 'Summarize the latest sweep',
    prompt: 'Summarize the latest run for this project — provider mix, visibility changes, and anything that moved.',
  },
  {
    command: '/last-failed',
    label: 'Last failed run',
    hint: 'Diagnose the most recent failure',
    prompt: 'If the latest run failed, dig into it and tell me what went wrong plus how to fix it.',
  },
  {
    command: '/run-sweep',
    label: 'Run sweep now',
    hint: 'Trigger a new visibility sweep',
    prompt: 'Run a new answer-visibility sweep for this project now and tell me when it lands.',
  },
  {
    command: '/schedule',
    label: 'Schedule',
    hint: 'Review the sweep schedule',
    prompt: 'What is the current sweep schedule, and is it appropriate given recent volatility?',
  },
  {
    command: '/keywords',
    label: 'Keywords',
    hint: 'List tracked keywords',
    prompt: 'List the tracked keywords for this project and flag any that are obvious duplicates or underperformers.',
  },
  {
    command: '/competitors',
    label: 'Competitors',
    hint: 'List tracked competitors',
    prompt: 'List this project\'s tracked competitors and call out which ones are showing up in answer citations.',
  },
]

const PROVIDER_PREF_KEY = (project: string) => `canonry:aero:provider:${project}`
const SCOPE_PREF_KEY = (project: string) => `canonry:aero:scope:${project}`

export function AeroBar({ projectName }: AeroBarProps) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<AeroMessage[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  // Live trail for the in-flight turn. Persisted until the next user send so
  // users can see what tools were run while Aero was composing. Past-turn
  // trails are reconstructed from the transcript instead.
  const [liveTrail, setLiveTrail] = useState<ToolTrail[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [providerOverride, setProviderOverride] = useState<AgentProviderId | null>(() => {
    if (typeof window === 'undefined') return null
    const stored = window.localStorage.getItem(PROVIDER_PREF_KEY(projectName))
    return (stored as AgentProviderId | null) ?? null
  })
  // Per-project tool scope. `read-only` (the server default) is the safe
  // choice; `all` lets Aero fire write tools like run_sweep without a
  // confirmation UX. Persist so the user doesn't have to re-opt-in each
  // visit, but key by project so the choice doesn't leak across tenants.
  const [scope, setScope] = useState<AeroToolScope>(() => {
    if (typeof window === 'undefined') return 'read-only'
    const stored = window.localStorage.getItem(SCOPE_PREF_KEY(projectName))
    return stored === 'all' ? 'all' : 'read-only'
  })
  const abortRef = useRef<AbortController | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [paletteIndex, setPaletteIndex] = useState(0)

  // Palette opens when the draft starts with `/` and has no whitespace yet —
  // as soon as the user types a space, they've committed to a free-form
  // prompt. We match command strings by prefix so `/st` narrows to `/status`.
  const paletteMatches = useMemo(() => {
    const trimmed = draft.trimStart()
    if (!trimmed.startsWith('/')) return []
    if (/\s/.test(trimmed)) return []
    const q = trimmed.toLowerCase()
    return SLASH_COMMANDS.filter(
      (cmd) => cmd.command.startsWith(q) || cmd.label.toLowerCase().includes(q.slice(1)),
    )
  }, [draft])

  // Keep the selected index in range as matches narrow. Reset to 0 whenever
  // the palette toggles, so the top option is always the "enter to pick"
  // target.
  useEffect(() => {
    setPaletteIndex((prev) => (paletteMatches.length === 0 ? 0 : Math.min(prev, paletteMatches.length - 1)))
  }, [paletteMatches.length])

  const providersQuery = useQuery({
    queryKey: queryKeys.agent.providers(projectName),
    queryFn: () => fetchAgentProviders(projectName),
    enabled: open,
    staleTime: 60_000,
  })

  // Active provider = user override if it's still configured, else the
  // server-detected default. Reset stale overrides when the key goes away.
  const activeProvider: AgentProviderOption | null = useMemo(() => {
    const list = providersQuery.data?.providers ?? []
    if (providerOverride) {
      const hit = list.find((p) => p.id === providerOverride && p.configured)
      if (hit) return hit
    }
    const defaultId = providersQuery.data?.defaultProvider
    return defaultId ? (list.find((p) => p.id === defaultId) ?? null) : null
  }, [providerOverride, providersQuery.data])

  useEffect(() => {
    if (!providersQuery.data || !providerOverride) return
    const hit = providersQuery.data.providers.find(
      (p) => p.id === providerOverride && p.configured,
    )
    if (!hit) {
      setProviderOverride(null)
      window.localStorage.removeItem(PROVIDER_PREF_KEY(projectName))
    }
  }, [providersQuery.data, providerOverride, projectName])

  const pickProvider = useCallback(
    (id: AgentProviderId | null) => {
      setProviderOverride(id)
      if (typeof window === 'undefined') return
      if (id) window.localStorage.setItem(PROVIDER_PREF_KEY(projectName), id)
      else window.localStorage.removeItem(PROVIDER_PREF_KEY(projectName))
    },
    [projectName],
  )

  const toggleScope = useCallback(() => {
    setScope((prev) => {
      const next: AeroToolScope = prev === 'all' ? 'read-only' : 'all'
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(SCOPE_PREF_KEY(projectName), next)
      }
      return next
    })
  }, [projectName])

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
  }, [messages, streamingText, liveTrail])

  async function send(promptText: string) {
    const trimmed = promptText.trim()
    if (!trimmed || streaming) return
    setError(null)
    setDraft('')
    setStreaming(true)
    setStreamingText('')
    // Wipe the live trail on a new prompt — any prior turn's trail is now
    // part of the persisted transcript and will be reconstructed from there.
    setLiveTrail([])

    const optimistic: AeroMessage = { role: 'user', content: trimmed, timestamp: Date.now() }
    setMessages((prev) => [...prev, optimistic])

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      await promptAero({
        project: projectName,
        prompt: trimmed,
        provider: providerOverride ?? undefined,
        scope,
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
      // Leave liveTrail populated so the final assistant bubble still shows
      // what tools were run this turn. It clears on the next send().
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
        setLiveTrail((prev) => [
          ...prev,
          { id: event.toolCallId, name: event.toolName, args: event.args, startedAt: Date.now() },
        ])
        break
      case 'tool_execution_end':
        setLiveTrail((prev) =>
          prev.map((t) =>
            t.id === event.toolCallId
              ? { ...t, endedAt: Date.now(), isError: event.isError, result: event.result }
              : t,
          ),
        )
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
                <ProviderPicker
                  providers={providersQuery.data?.providers ?? []}
                  active={activeProvider}
                  override={providerOverride}
                  onPick={pickProvider}
                  disabled={streaming}
                />
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
              {renderTranscript(messages, projectName, providerOverride, scope)}
              {liveTrail.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {liveTrail.map((trail) => (
                    <ToolTrailRow key={trail.id} trail={trail} />
                  ))}
                </div>
              )}
              {streaming && streamingText && (
                <div className="mt-3">
                  <div className="mb-0.5 text-[10px] uppercase tracking-wider text-emerald-400">Aero</div>
                  <AeroMarkdown content={streamingText} />
                </div>
              )}
              {streaming && !streamingText && liveTrail.every((t) => t.endedAt !== undefined) && (
                <TypingIndicator />
              )}
            </div>

            <ContextPills
              projectName={projectName}
              activeProvider={activeProvider}
              scope={scope}
              onToggleScope={toggleScope}
              disabled={streaming}
            />
            <div className="relative">
              {paletteMatches.length > 0 && (
                <SlashPalette
                  matches={paletteMatches}
                  selectedIndex={paletteIndex}
                  onHover={setPaletteIndex}
                  onPick={(cmd) => {
                    setDraft('')
                    textareaRef.current?.focus()
                    void send(cmd.prompt)
                  }}
                />
              )}
              <form
                className="flex items-end gap-2 border-t border-zinc-800/70 bg-zinc-950/80 px-3 py-2.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (paletteMatches.length > 0) {
                    const cmd = paletteMatches[paletteIndex]
                    setDraft('')
                    void send(cmd.prompt)
                    return
                  }
                  void send(draft)
                }}
              >
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (paletteMatches.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setPaletteIndex((i) => (i + 1) % paletteMatches.length)
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setPaletteIndex((i) => (i - 1 + paletteMatches.length) % paletteMatches.length)
                        return
                      }
                      if (e.key === 'Tab') {
                        e.preventDefault()
                        const cmd = paletteMatches[paletteIndex]
                        setDraft(`${cmd.command} `)
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setDraft('')
                        return
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (paletteMatches.length > 0) {
                        const cmd = paletteMatches[paletteIndex]
                        setDraft('')
                        void send(cmd.prompt)
                      } else {
                        void send(draft)
                      }
                    }
                  }}
                  placeholder="Ask Aero, or / for commands…"
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

/**
 * Header popover for switching Aero's active LLM provider. Configured
 * providers are clickable; unconfigured entries render disabled with the
 * env-var hint so the user knows how to turn them on. The selection lives
 * in AeroBar state + localStorage so it survives refreshes and per-project
 * context switches; clearing the override falls back to the server's
 * auto-detected default.
 */
function ProviderPicker({
  providers,
  active,
  override,
  onPick,
  disabled,
}: {
  providers: AgentProviderOption[]
  active: AgentProviderOption | null
  override: AgentProviderId | null
  onPick: (id: AgentProviderId | null) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (providers.length === 0) return null

  const label = active?.label.replace(/\s+\(.+\)$/, '') ?? 'No provider'
  const model = active?.defaultModel

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-200 disabled:opacity-50"
        aria-label="Switch agent model"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active ? `${active.label} · ${active.defaultModel}` : 'Pick a provider'}
      >
        <span className="font-medium text-zinc-200">{label}</span>
        {model && <span className="hidden font-mono text-[10px] text-zinc-500 sm:inline">{model}</span>}
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl"
        >
          <div className="border-b border-zinc-800/60 px-3 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
            Aero provider
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {providers.map((p) => {
              const isActive = active?.id === p.id
              const isOverride = override === p.id
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    disabled={!p.configured}
                    onClick={() => {
                      if (!p.configured) return
                      onPick(isOverride ? null : p.id)
                      setOpen(false)
                    }}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition enabled:hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {isActive ? <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" /> : null}
                    </span>
                    <span className="flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium text-zinc-100">{p.label}</span>
                        {isOverride && (
                          <span className="rounded-full border border-emerald-800/60 bg-emerald-950/60 px-1.5 text-[9px] uppercase tracking-wider text-emerald-300">
                            Pinned
                          </span>
                        )}
                        {!p.configured && (
                          <span className="rounded-full border border-zinc-800 px-1.5 text-[9px] uppercase tracking-wider text-zinc-500">
                            Key missing
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block font-mono text-[10px] text-zinc-500">
                        {p.defaultModel}
                      </span>
                      {p.keySource === 'env' && (
                        <span className="mt-0.5 block text-[10px] text-zinc-600">via env var</span>
                      )}
                      {!p.configured && (
                        <span className="mt-0.5 block text-[10px] text-zinc-600">
                          Add key in config.yaml or export{' '}
                          <code className="font-mono text-zinc-400">{envVarHint(p.id)}</code>
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {override && (
            <button
              type="button"
              onClick={() => {
                onPick(null)
                setOpen(false)
              }}
              className="w-full border-t border-zinc-800/60 px-3 py-2 text-left text-[11px] text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-100"
            >
              Reset to auto-detected default
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Row of context chips sitting between the transcript and the composer.
 * Gives the user a single glance at who Aero is acting as (project), which
 * model is answering (provider), and what surface area it can touch (scope).
 * Scope is the only interactive chip — toggling between `read-only` and
 * `all` changes what tools Aero is allowed to call on the next turn.
 */
function ContextPills({
  projectName,
  activeProvider,
  scope,
  onToggleScope,
  disabled,
}: {
  projectName: string
  activeProvider: AgentProviderOption | null
  scope: AeroToolScope
  onToggleScope: () => void
  disabled?: boolean
}) {
  const providerLabel = activeProvider?.label.replace(/\s+\(.+\)$/, '') ?? null
  const writeMode = scope === 'all'
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-800/70 bg-zinc-950/80 px-3 pt-2">
      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/70 px-2 py-0.5 text-[10px] text-zinc-400">
        <span className="text-zinc-600">project</span>
        <span className="font-medium text-zinc-200">{projectName}</span>
      </span>
      {providerLabel && (
        <span className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/70 px-2 py-0.5 text-[10px] text-zinc-400">
          <span className="text-zinc-600">model</span>
          <span className="font-medium text-zinc-200">{providerLabel}</span>
        </span>
      )}
      <button
        type="button"
        onClick={onToggleScope}
        disabled={disabled}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition disabled:opacity-50 ${
          writeMode
            ? 'border-amber-800/60 bg-amber-950/40 text-amber-300 hover:border-amber-700 hover:text-amber-200'
            : 'border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
        }`}
        title={
          writeMode
            ? 'Aero can invoke write tools (run sweep, dismiss insight, etc). Click to restrict.'
            : 'Aero is restricted to read-only tools. Click to allow writes.'
        }
      >
        <span className={writeMode ? 'text-amber-500' : 'text-zinc-600'}>scope</span>
        <span className="font-medium">{writeMode ? 'all tools' : 'read-only'}</span>
      </button>
    </div>
  )
}

/**
 * Command palette that hangs above the composer when the user types `/`.
 * Keyboard-driven: arrow keys move, Enter picks (handled in the textarea
 * keydown handler so submit semantics stay co-located). Hovering with the
 * mouse previews a different selection but doesn't commit — Enter or click
 * are the only commit paths.
 */
function SlashPalette({
  matches,
  selectedIndex,
  onHover,
  onPick,
}: {
  matches: Array<{ command: string; label: string; hint: string; prompt: string }>
  selectedIndex: number
  onHover: (index: number) => void
  onPick: (cmd: { command: string; label: string; hint: string; prompt: string }) => void
}) {
  return (
    <div className="absolute inset-x-3 bottom-full mb-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/98 shadow-2xl">
      <div className="border-b border-zinc-800/60 px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        Commands
      </div>
      <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
        {matches.map((cmd, i) => {
          const active = i === selectedIndex
          return (
            <li key={cmd.command}>
              <button
                type="button"
                role="option"
                aria-selected={active}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(cmd)}
                className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs transition ${
                  active ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900/60'
                }`}
              >
                <span className="font-mono text-[11px] text-emerald-400">{cmd.command}</span>
                <span className="font-medium">{cmd.label}</span>
                <span className="ml-auto text-[10px] text-zinc-500">{cmd.hint}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="border-t border-zinc-800/60 px-3 py-1.5 text-[10px] text-zinc-600">
        <span className="mr-3">↑↓ to select</span>
        <span className="mr-3">Enter to run</span>
        <span>Tab to autocomplete</span>
      </div>
    </div>
  )
}

function envVarHint(id: AgentProviderId): string {
  switch (id) {
    case 'claude':
      return 'ANTHROPIC_API_KEY'
    case 'openai':
      return 'OPENAI_API_KEY'
    case 'gemini':
      return 'GOOGLE_API_KEY'
    case 'zai':
      return 'ZAI_API_KEY'
  }
}

function messageKey(message: AeroMessage, fallbackIndex: number): string {
  const ts = message.timestamp ?? 0
  return `${message.role}:${ts}:${fallbackIndex}`
}

/**
 * Walk the transcript once, grouping each assistant turn with its following
 * toolResult messages so we can render an inline tool trail beside the
 * assistant bubble. User messages flush as standalone rows. System wake-ups
 * are hidden — they're an internal follow-up plumbing detail.
 *
 * `projectName` + `providerOverride` + `scope` let user bubbles render a
 * "copy as CLI" affordance reproducing the turn via `canonry agent ask` —
 * including the current tool-scope so a pasted command cannot quietly
 * escalate from read-only to write-capable.
 */
function renderTranscript(
  messages: AeroMessage[],
  projectName: string,
  providerOverride: AgentProviderId | null,
  scope: AeroToolScope,
): ReactNode[] {
  const nodes: ReactNode[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const key = messageKey(msg, i)

    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (text.startsWith('[system]')) continue
      nodes.push(
        <UserMessageRow
          key={key}
          text={text}
          projectName={projectName}
          providerOverride={providerOverride}
          scope={scope}
        />,
      )
      continue
    }

    if (msg.role === 'assistant') {
      // Pair toolCall blocks in this message with the toolResult messages
      // that immediately follow. Advance `i` past any results we consume so
      // the outer loop doesn't revisit them.
      const results = new Map<string, AeroToolResultMessage>()
      let cursor = i + 1
      while (cursor < messages.length && messages[cursor].role === 'toolResult') {
        const r = messages[cursor] as AeroToolResultMessage
        results.set(r.toolCallId, r)
        cursor++
      }
      const trails = extractTrails(msg, results, msg.timestamp ?? 0)
      const text = extractAssistantText(msg)
      nodes.push(
        <Fragment key={key}>
          {trails.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {trails.map((trail) => (
                <ToolTrailRow key={trail.id} trail={trail} />
              ))}
            </div>
          )}
          {text.trim() && (
            <div className="mt-3">
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-emerald-400">Aero</div>
              <AeroMarkdown content={text} />
            </div>
          )}
        </Fragment>,
      )
      i = cursor - 1
      continue
    }

    // Standalone toolResult messages (no preceding assistant in this window)
    // are dropped silently — pi's envelope always pairs them.
  }
  return nodes
}

/**
 * User-side message bubble with a hover-revealed "Copy as CLI" action. The
 * emitted command is a one-shot `canonry agent ask` equivalent of the turn —
 * useful for snapshotting a prompt to paste into a terminal or share. The
 * pinned provider is included so the CLI reproduces the same routing the
 * dashboard is using; if nothing is pinned we leave it to auto-detect.
 */
function UserMessageRow({
  text,
  projectName,
  providerOverride,
  scope,
}: {
  text: string
  projectName: string
  providerOverride: AgentProviderId | null
  scope: AeroToolScope
}) {
  const [copied, setCopied] = useState(false)

  const cliCommand = useMemo(
    () => buildAgentAskCommand(projectName, text, providerOverride, scope),
    [projectName, text, providerOverride, scope],
  )

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cliCommand)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write blocked (usually because the tab isn't focused, or a
      // browser permissions policy). Swallow — UI stays responsive and the
      // user can always retry.
    }
  }

  return (
    <div className="group relative mt-3 rounded-md bg-zinc-900/60 px-3 py-2 text-zinc-200">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">You</div>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded border border-zinc-800/70 bg-zinc-950/60 px-1.5 py-0.5 text-[10px] text-zinc-400 opacity-0 transition hover:border-zinc-700 hover:text-zinc-100 group-hover:opacity-100 focus:opacity-100"
          aria-label="Copy as CLI command"
          title={cliCommand}
        >
          {copied ? (
            <>
              <Check className="h-2.5 w-2.5 text-emerald-400" aria-hidden="true" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-2.5 w-2.5" aria-hidden="true" />
              Copy as CLI
            </>
          )}
        </button>
      </div>
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  )
}

/**
 * Build the shell-safe `canonry agent ask` command that reproduces a turn.
 * Single-quoted for predictable shell behavior — any embedded single quotes
 * are escaped via the standard `'\''` POSIX trick.
 *
 * Emits `--scope read-only` when the UI ran in safe mode so a pasted command
 * cannot quietly upgrade to write-capable. The CLI default (`all`) matches
 * the server default, so we omit the flag in that case to keep pastes terse.
 */
function buildAgentAskCommand(
  projectName: string,
  prompt: string,
  providerOverride: AgentProviderId | null,
  scope: AeroToolScope,
): string {
  const parts = ['canonry', 'agent', 'ask', shellQuote(projectName), shellQuote(prompt)]
  if (providerOverride) parts.push('--provider', providerOverride)
  if (scope === 'read-only') parts.push('--scope', 'read-only')
  return parts.join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function extractTrails(
  assistant: AeroAssistantMessage,
  results: Map<string, AeroToolResultMessage>,
  fallbackStartedAt: number,
): ToolTrail[] {
  const trails: ToolTrail[] = []
  for (const block of assistant.content) {
    if (block.type !== 'toolCall') continue
    const toolCall = block as { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
    const result = results.get(toolCall.id)
    trails.push({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.arguments,
      startedAt: fallbackStartedAt,
      endedAt: result?.timestamp,
      isError: result?.isError,
      result: result?.content,
    })
  }
  return trails
}

/**
 * Collapsible card for a single tool invocation. Shows name + duration +
 * status glyph in the header; expanding reveals the args payload and a
 * truncated result preview. Args use zinc; errors pick up a rose accent so
 * failed tool calls don't masquerade as successful.
 */
function ToolTrailRow({ trail }: { trail: ToolTrail }) {
  const [expanded, setExpanded] = useState(false)
  const running = trail.endedAt === undefined
  const failed = !running && trail.isError === true
  const durationMs = trail.endedAt != null ? trail.endedAt - trail.startedAt : null
  const durationLabel =
    durationMs == null || durationMs < 0 ? null : durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`

  const borderClass = failed
    ? 'border-rose-800/50'
    : running
      ? 'border-emerald-800/50'
      : 'border-zinc-800/70'
  const bgClass = failed ? 'bg-rose-950/20' : running ? 'bg-emerald-950/20' : 'bg-zinc-900/40'

  return (
    <div className={`rounded-md border ${borderClass} ${bgClass} font-mono`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={expanded}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin text-emerald-400" aria-hidden="true" />
          ) : failed ? (
            <AlertTriangle className="h-3 w-3 text-rose-400" aria-hidden="true" />
          ) : (
            <Wrench className="h-3 w-3 text-zinc-500" aria-hidden="true" />
          )}
        </span>
        <span className="text-[11px] font-semibold text-zinc-100">{trail.name}</span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-zinc-500">
          {running ? (
            <span className="text-emerald-400">running…</span>
          ) : (
            <>
              <span>{failed ? 'failed' : 'ok'}</span>
              {durationLabel && <span>{durationLabel}</span>}
            </>
          )}
          <ChevronRight
            className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-zinc-800/60 px-2.5 py-2 text-[11px] text-zinc-400">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-zinc-600">Args</div>
          <pre className="mb-2 overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-zinc-300">
            {formatJsonPreview(trail.args)}
          </pre>
          {!running && trail.result !== undefined && (
            <>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-zinc-600">
                {failed ? 'Error' : 'Result'}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-zinc-300">
                {formatJsonPreview(trail.result)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function formatJsonPreview(value: unknown): string {
  try {
    const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    // Cap previews so a single tool call can't blow out the transcript.
    if (json.length > 2000) return `${json.slice(0, 2000)}\n… (${json.length - 2000} more chars)`
    return json
  } catch {
    return String(value)
  }
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
