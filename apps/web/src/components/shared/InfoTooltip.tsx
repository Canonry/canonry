import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

interface TooltipPos {
  top: number
  left: number
  /** A bubble that opens below found no room there, so it sits above its trigger. */
  above?: boolean
  /** The trigger is scrolled out of the viewport: the bubble is not drawn until it is back. */
  offscreen?: boolean
}

/**
 * The bubble behind `InfoTooltip`, for any trigger that is a real <button>.
 * Spread `trigger` on the button and `wrapper` on the element whose hover
 * opens it, and render `bubble` anywhere: it portals to the body. Hover,
 * focus, click (touch) and Escape toggle it. The bubble is decorative
 * (`aria-hidden`), so the caller puts `text` in the button's accessible name
 * or description.
 *
 * Escape on the focused trigger closes the open bubble and nothing else: a
 * sheet or dialog around it stays up, with no handler on that sheet. The
 * bubble is fixed where it opened, so a scroll that moves its trigger closes
 * it; under keyboard focus it moves with the trigger instead. A bubble that
 * opens below and has no room there sits above.
 *
 * `align: 'start'` hangs the bubble from the trigger's left edge, for a trigger
 * that is a label rather than an icon. `hoverDelay` (ms) is for triggers packed
 * in a grid, where a pointer on its way across should open nothing; focus and
 * tap never wait.
 */
export function useTooltipBubble(text: string, { placement, align = 'center', hoverDelay = 0 }: {
  placement: 'top' | 'bottom'
  align?: 'center' | 'start'
  hoverDelay?: number
}) {
  const [pos, setPos] = useState<TooltipPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const wasOpenBeforePointer = useRef(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const open = pos !== null

  const show = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const halfWidth = Math.min(224, window.innerWidth - 16) / 2
    const center = align === 'start' ? rect.left + halfWidth : rect.left + rect.width / 2
    setPos({
      top: placement === 'bottom' ? rect.bottom : rect.top,
      left: placement === 'bottom' ? Math.max(halfWidth + 8, Math.min(center, window.innerWidth - halfWidth - 8)) : center,
      offscreen: rect.bottom < 0 || rect.top > window.innerHeight,
    })
  }, [placement, align])

  useLayoutEffect(() => {
    if (placement !== 'bottom' || !pos || pos.above || !bubbleRef.current || !triggerRef.current) return
    const bubble = bubbleRef.current.getBoundingClientRect()
    const overflow = bubble.bottom - window.innerHeight + 8
    if (overflow <= 0) return
    // Above the trigger, not slid up over it: the bubble must never hide what it explains.
    const triggerTop = triggerRef.current.getBoundingClientRect().top
    const top = Math.max(0, pos.top - overflow)
    if (triggerTop - bubble.height >= 16) setPos({ ...pos, top: triggerTop, above: true })
    else if (top !== pos.top) setPos({ ...pos, top })
  }, [placement, pos])

  const hide = useCallback(() => {
    clearTimeout(hoverTimer.current)
    setPos(null)
  }, [])

  const hover = useCallback(() => {
    // React can report one entry twice, when the pointer comes from outside its tree. Only one timer may be left to cancel.
    clearTimeout(hoverTimer.current)
    if (hoverDelay > 0) hoverTimer.current = setTimeout(show, hoverDelay)
    else show()
  }, [hoverDelay, show])

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const toggle = useCallback(() => {
    if (pos === null) show()
    else hide()
  }, [pos, show, hide])

  useEffect(() => {
    const trigger = triggerRef.current
    const view = trigger?.ownerDocument.defaultView
    if (!open || !trigger || !view) return
    // A dialog hears Escape on the document in the capture phase, ahead of React, and closes
    // unless the event is already default-prevented. Only the window is reached before that.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.target !== trigger) return
      event.preventDefault()
      hide()
    }
    // Left where it opened, the bubble would end up over another row and read as that row's.
    // The browser also scrolls a trigger into view after it takes keyboard focus, which is after the bubble opened.
    const onScroll = (event: Event) => {
      if (event.target instanceof view.Node && !event.target.contains(trigger)) return
      if (trigger.matches(':focus-visible')) show()
      else hide()
    }
    view.addEventListener('keydown', onKeyDown, true)
    view.addEventListener('scroll', onScroll, true)
    return () => {
      view.removeEventListener('keydown', onKeyDown, true)
      view.removeEventListener('scroll', onScroll, true)
    }
  }, [open, show, hide])

  const below = placement === 'bottom' && !pos?.above
  return {
    wrapper: { onMouseEnter: hover, onMouseLeave: hide },
    trigger: {
      ref: triggerRef,
      'aria-expanded': open,
      onFocus: show,
      onBlur: hide,
      onPointerDown: () => { wasOpenBeforePointer.current = pos !== null && triggerRef.current?.ownerDocument.activeElement === triggerRef.current },
      onClick: (event: { detail: number }) => {
        // Pointer focus can open the bubble before click fires. Preserve the
        // state from before that focus, so the first touch tap stays open.
        if (event.detail === 0) toggle()
        else if (wasOpenBeforePointer.current) hide()
        else show()
      },
      onKeyDown: (e: { key: string }) => {
        if (e.key === 'Escape') hide()
      },
    },
    bubble: pos !== null && !pos.offscreen && createPortal(
      <span
        ref={bubbleRef}
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: pos.top,
          left: pos.left,
          transform: below ? 'translateX(-50%) translateY(8px)' : 'translateX(-50%) translateY(calc(-100% - 8px))',
          zIndex: 9999,
          pointerEvents: 'none',
          width: placement === 'bottom' ? 'min(14rem, calc(100vw - 1rem))' : '14rem',
          padding: '0.5rem 0.75rem',
          fontSize: placement === 'bottom' ? '13px' : '11px',
          fontWeight: 400,
          textTransform: 'none',
          letterSpacing: 'normal',
          lineHeight: placement === 'bottom' ? '18px' : '1rem',
          color: 'var(--color-neutral-text)',
          backgroundColor: 'var(--color-bg-elevated)',
          border: '1px solid color-mix(in oklab, var(--color-border-strong) 60%, transparent)',
          borderRadius: '0.5rem',
          boxShadow: '0 10px 15px -3px var(--color-shadow-tooltip), 0 4px 6px -4px var(--color-shadow-tooltip)',
        }}
      >
        {text}
      </span>,
      document.body,
    ),
  }
}

/**
 * Inline help affordance. The trigger is a real <button> so it is reachable by
 * keyboard and exposes the explanatory copy to assistive tech via its
 * accessible name (`aria-label`) — the visual bubble is decorative
 * (`aria-hidden`). Hover, focus, click (touch), and Escape all toggle it.
 *
 * `variant="caution"` is the same control behind a triangle in the caution
 * tone: a note about the figure beside it, rather than help for a label. It
 * opens below unless told otherwise, the placement that keeps the bubble
 * inside a narrow viewport, because it sits beside figures anywhere in a row.
 */
export function InfoTooltip({ text, variant = 'info', placement = variant === 'caution' ? 'bottom' : 'top' }: {
  text: string
  variant?: 'info' | 'caution'
  placement?: 'top' | 'bottom'
}) {
  const bubble = useTooltipBubble(text, { placement })

  return (
    <span className="info-tooltip-wrapper" {...bubble.wrapper}>
      <button
        type="button"
        className={variant === 'caution' ? 'info-tooltip-trigger info-tooltip-trigger-caution' : 'info-tooltip-trigger'}
        aria-label={text}
        {...bubble.trigger}
      >
        {variant === 'caution' ? <svg className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2 14.5 13.5h-13L8 2ZM8 6.5v3M8 11.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg> : <svg className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7v4M8 5.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>}
      </button>
      {bubble.bubble}
    </span>
  )
}
