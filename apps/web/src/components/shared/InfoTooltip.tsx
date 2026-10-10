import { useState, useRef, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

interface TooltipPos {
  top: number
  left: number
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
  const [pos, setPos] = useState<TooltipPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const wasOpenBeforePointer = useRef(false)

  const show = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const center = rect.left + rect.width / 2
    const halfWidth = Math.min(224, window.innerWidth - 16) / 2
    setPos({
      top: placement === 'bottom' ? rect.bottom : rect.top,
      left: placement === 'bottom' ? Math.max(halfWidth + 8, Math.min(center, window.innerWidth - halfWidth - 8)) : center,
    })
  }, [placement])

  useLayoutEffect(() => {
    if (placement !== 'bottom' || !pos || !bubbleRef.current) return
    const overflow = bubbleRef.current.getBoundingClientRect().bottom - window.innerHeight + 8
    if (overflow <= 0) return
    const top = Math.max(0, pos.top - overflow)
    if (top !== pos.top) setPos({ ...pos, top })
  }, [placement, pos])

  const hide = useCallback(() => setPos(null), [])

  const toggle = useCallback(() => {
    if (pos === null) show()
    else hide()
  }, [pos, show, hide])

  return (
    <span className="info-tooltip-wrapper" onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={triggerRef}
        type="button"
        className={variant === 'caution' ? 'info-tooltip-trigger info-tooltip-trigger-caution' : 'info-tooltip-trigger'}
        aria-label={text}
        aria-expanded={pos !== null}
        onFocus={show}
        onBlur={hide}
        onPointerDown={() => { wasOpenBeforePointer.current = pos !== null && triggerRef.current?.ownerDocument.activeElement === triggerRef.current }}
        onClick={event => {
          // Pointer focus can open the bubble before click fires. Preserve the
          // state from before that focus, so the first touch tap stays open.
          if (event.detail === 0) toggle()
          else if (wasOpenBeforePointer.current) hide()
          else show()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide()
        }}
      >
        {variant === 'caution' ? <svg className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2 14.5 13.5h-13L8 2ZM8 6.5v3M8 11.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg> : <svg className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7v4M8 5.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>}
      </button>
      {pos !== null && createPortal(
        <span
          ref={bubbleRef}
          aria-hidden="true"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: placement === 'bottom' ? 'translateX(-50%) translateY(8px)' : 'translateX(-50%) translateY(calc(-100% - 8px))',
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
      )}
    </span>
  )
}
