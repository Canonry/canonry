/**
 * Sign in with ChatGPT in the dashboard: the button, and a viewer's ChatGPT
 * plan in the Aero bar.
 *
 * The Aero pieces only appear for a signed-in viewer on an install with plan
 * usage on (`chatgpt.planUsage`). Everyone else sees the Aero bar exactly as
 * before. The server decides who pays for an answer; these components only
 * say which it is and offer the one fix when a plan cannot answer.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Check, ChevronDown, Unplug } from 'lucide-react'
import {
  getApiV1AuthChatgptModelsOptions,
  getApiV1AuthChatgptModelsQueryKey,
  getApiV1AuthChatgptStatusOptions,
  getApiV1AuthChatgptStatusQueryKey,
} from '@canonry/canonry-api-client/react-query'
import { CHATGPT_SIGN_IN_ERROR_MESSAGES, ChatGptPlanStatuses, type ChatGptSignInError } from '@canonry/canonry-contracts'

import { chatGptStartUrl, chooseChatGptModel, disconnectChatGpt, heyClient } from '../../api.js'
import { consumeChatGptReturn, currentReturnPath } from '../../lib/chatgpt-return.js'
import { cn } from '../../lib/utils.js'
import { buttonVariants } from '../ui/button.js'

/**
 * OpenAI's "Continue with ChatGPT" action. The primary button is white on the
 * dark theme and black on the light one, which are OpenAI's two approved
 * formats; `data-oai-siwc-button` marks it as their guidelines ask.
 */
export function ChatGptButton({ href, size = 'lg', className }: { href: string; size?: 'sm' | 'lg'; className?: string }) {
  return (
    <a href={href} data-oai-siwc-button className={cn(buttonVariants({ size }), className)}>
      Continue with ChatGPT
    </a>
  )
}

export interface ChatGptPlanState {
  usageUrl: string
  email: string | null
  connected: boolean
  /** The grant stopped working (revoked in ChatGPT, or refused on refresh). */
  reconnect: boolean
  /** The install requires a plan for viewer Aero and this person has none that works. */
  needsConnect: boolean
  /** Plan usage is optional here and this person has not connected one. */
  offerConnect: boolean
  connectUrl: string
  /** Why the last connect did not complete, from OpenAI's redirect back. */
  returnError: ChatGptSignInError | null
  refresh: () => void
}

/**
 * The signed-in viewer's ChatGPT plan, or null when plan usage does not apply
 * (switched off, not a viewer, or not signed in), in which case the Aero bar
 * behaves exactly as it always has.
 */
export function useChatGptPlan(enabled: boolean): ChatGptPlanState | null {
  const queryClient = useQueryClient()
  const [returnError] = useState(() => (enabled ? consumeChatGptReturn().error : null))
  const status = useQuery({ ...getApiV1AuthChatgptStatusOptions({ client: heyClient }), enabled, staleTime: 30_000 })
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getApiV1AuthChatgptStatusQueryKey({ client: heyClient }) })
  }, [queryClient])

  const data = status.data
  const account = data?.account
  if (!enabled || !data?.planUsageEnabled || !account) return null
  const connected = account.plan.status === ChatGptPlanStatuses.connected
  return {
    usageUrl: data.usageUrl,
    email: account.email,
    connected,
    reconnect: account.plan.status === ChatGptPlanStatuses.reconnectRequired,
    needsConnect: data.planRequired && !connected,
    offerConnect: !data.planRequired && !connected,
    connectUrl: chatGptStartUrl('connect', currentReturnPath()),
    returnError,
    refresh,
  }
}

/** Shown in place of the conversation when this viewer must connect a plan first. */
export function ChatGptConnectPrompt({ plan }: { plan: ChatGptPlanState }) {
  return (
    <div className="flex flex-col items-start gap-4 px-5 py-6">
      <div className="space-y-1.5">
        <h3 className="text-heading-16 text-heading">
          {plan.reconnect ? 'Connect ChatGPT again' : 'Aero answers with your own ChatGPT plan'}
        </h3>
        <p className="text-copy-14 text-secondary">
          {plan.reconnect
            ? 'Your ChatGPT connection stopped working. Connect again to keep using Aero.'
            : 'Connect ChatGPT to ask about this project. Plan use needs an eligible plan, such as Plus or Pro.'}
        </p>
        {plan.returnError ? (
          <p role="alert" className="text-copy-14 text-negative-400">{CHATGPT_SIGN_IN_ERROR_MESSAGES[plan.returnError]}</p>
        ) : null}
      </div>
      <ChatGptButton href={plan.connectUrl} />
    </div>
  )
}

function UsageLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1 rounded-md text-label-13 text-secondary underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
    >
      {label}
      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** The line under the composer: whose plan answers, with which model, and where usage lives. */
export function ChatGptPlanLine({ plan, disabled }: { plan: ChatGptPlanState; disabled?: boolean }) {
  if (plan.offerConnect) {
    return (
      <div className="flex items-center justify-between gap-3 bg-bg/80 px-4 pb-2.5">
        <a href={plan.connectUrl} className="rounded-md text-label-13 text-secondary underline-offset-4 hover:text-primary hover:underline">
          Use your ChatGPT plan
        </a>
      </div>
    )
  }
  if (!plan.connected) return null
  return (
    <div className="flex items-center justify-between gap-3 bg-bg/80 px-4 pb-2.5">
      <PlanMenu plan={plan} disabled={disabled} />
      <UsageLink href={plan.usageUrl} label="Manage usage" />
    </div>
  )
}

type MenuPosition = { bottom: number; left: number; maxHeight: number }

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])
}

/**
 * Model choice and disconnect, as a menu above the plan line. It renders into
 * document.body with fixed positioning because the Aero panel clips its own
 * overflow (the provider picker does the same).
 */
function PlanMenu({ plan, disabled }: { plan: ChatGptPlanState; disabled?: boolean }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  const modelHeadingId = useId()
  const models = useQuery({ ...getApiV1AuthChatgptModelsOptions({ client: heyClient }), staleTime: 5 * 60_000 })

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    setPosition(null)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const margin = 8
    setPosition({ bottom: window.innerHeight - rect.top + 4, left: Math.max(margin, rect.left), maxHeight: rect.top - margin - 4 })
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  const placed = position !== null
  useEffect(() => {
    if (!open || !placed) return
    const items = menuItems(menuRef.current)
    ;(items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
  }, [open, placed])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    // Capture phase, so Escape closes the menu without also closing Aero.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      close(true)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', place)
    }
  }, [open, close, place])

  const list = models.data?.models ?? []
  const selected = models.data?.selected ?? null
  const selectedName = list.find(model => model.id === selected)?.name ?? selected

  const refreshAfterChange = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getApiV1AuthChatgptModelsQueryKey({ client: heyClient }) }),
      queryClient.invalidateQueries({ queryKey: getApiV1AuthChatgptStatusQueryKey({ client: heyClient }) }),
    ])
  }

  const choose = async (modelId: string) => {
    close(true)
    if (modelId === selected) return
    setBusy(true)
    setProblem(null)
    try {
      await chooseChatGptModel(modelId)
      await refreshAfterChange()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The model could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    close(false)
    setBusy(true)
    setProblem(null)
    try {
      await disconnectChatGpt()
      await refreshAfterChange()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'ChatGPT could not be disconnected.')
    } finally {
      setBusy(false)
    }
  }

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault()
      close(true)
      return
    }
    const target = event.target as HTMLElement
    if (!target.matches('[role^="menuitem"]')) return
    const items = menuItems(menuRef.current)
    const index = items.indexOf(target)
    const next = event.key === 'ArrowDown' ? items[(index + 1) % items.length]
      : event.key === 'ArrowUp' ? items[(index - 1 + items.length) % items.length]
        : event.key === 'Home' ? items[0]
          : event.key === 'End' ? items[items.length - 1]
            : undefined
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  const itemClass = 'flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-label-14 text-heading transition outline-none hover:bg-bg-elevated focus-visible:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mono-400 disabled:opacity-60'

  return (
    <div className="flex min-w-0 flex-col">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
        }}
        disabled={disabled || busy}
        className="flex min-w-0 items-center gap-1 rounded-md text-label-13 text-secondary transition hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 disabled:opacity-60"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <span className="truncate">Answers use your ChatGPT plan</span>
        {selectedName ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate text-heading">{selectedName}</span>
          </>
        ) : null}
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>
      {problem ? <p role="alert" className="mt-1 text-copy-13 text-negative-400">{problem}</p> : null}
      {open && position && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="ChatGPT plan"
          onKeyDown={onMenuKeyDown}
          style={{ position: 'fixed', bottom: position.bottom, left: position.left, maxHeight: position.maxHeight }}
          className="z-50 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto material-menu py-1"
        >
          <div role="group" aria-labelledby={modelHeadingId}>
            <div id={modelHeadingId} className="px-3 pb-1 pt-2 text-label-12 text-secondary">
              {plan.email ? `ChatGPT · ${plan.email}` : 'ChatGPT'}
            </div>
            {models.isPending ? (
              <p className="px-3 py-2 text-copy-13 text-secondary">Loading your plan's models…</p>
            ) : models.isError ? (
              <p className="px-3 py-2 text-copy-13 text-secondary">Your plan's models could not be loaded.</p>
            ) : list.map(model => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={model.id === selected}
                onClick={() => { void choose(model.id) }}
                className={itemClass}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {model.id === selected ? <Check className="h-3.5 w-3.5 text-positive-400" aria-hidden="true" /> : null}
                </span>
                {model.name}
              </button>
            ))}
          </div>
          <div role="separator" className="my-1 border-t border-default" />
          <button type="button" role="menuitem" onClick={() => { void disconnect() }} className={cn(itemClass, 'text-negative-400')}>
            <Unplug className="h-4 w-4 shrink-0" aria-hidden="true" />
            Disconnect ChatGPT
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

export type ChatGptTurnErrorKind = 'connect' | 'reconnect' | 'usage-limit' | 'not-eligible' | 'unavailable' | 'failed'

const TURN_ERROR_KINDS: Readonly<Record<string, ChatGptTurnErrorKind>> = {
  CHATGPT_CONNECT_REQUIRED: 'connect',
  CHATGPT_RECONNECT_REQUIRED: 'reconnect',
  CHATGPT_USAGE_LIMIT: 'usage-limit',
  CHATGPT_PLAN_NOT_ELIGIBLE: 'not-eligible',
  CHATGPT_UNAVAILABLE: 'unavailable',
  CHATGPT_FAILED: 'failed',
}

/**
 * A plan failure from an Aero turn (`CHATGPT_<CODE>: sentence`), or null for
 * any other error. The sentence is what the person reads.
 */
export function parseChatGptTurnError(message: string | null | undefined): { kind: ChatGptTurnErrorKind; text: string } | null {
  const match = /^(CHATGPT_[A-Z_]+): ([\s\S]+)$/.exec(message ?? '')
  const kind = match ? TURN_ERROR_KINDS[match[1]!] : undefined
  if (!match || !kind) return null
  // The server spells out the usage URL for API and CLI callers; the bar
  // offers it as the "Check usage" action instead.
  const text = kind === 'usage-limit' ? match[2]!.replace(/\s*Check your usage at \S+$/, '') : match[2]!
  return { kind, text }
}

/** The one fix for a plan failure, beside its message in the Aero error row. */
export function ChatGptTurnErrorAction({ kind, plan }: { kind: ChatGptTurnErrorKind; plan: ChatGptPlanState | null }) {
  if (!plan) return null
  if (kind === 'usage-limit') {
    return (
      <a
        href={plan.usageUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'pointer-events-auto')}
      >
        Check usage
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    )
  }
  if (kind === 'connect' || kind === 'reconnect') return <ChatGptButton href={plan.connectUrl} size="sm" />
  return null
}
