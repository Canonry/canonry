import { useState, useRef, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'

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
 * `tone="caution"` with a short `label` is a caveat: a warning icon and a few
 * words beside a figure, with the sentence in the bubble. `text` must start
 * with `label`, so the visible words are part of the accessible name.
 */
export function InfoTooltip({ text, placement = 'top', tone = 'info', label }: {
  text: string
  placement?: 'top' | 'bottom'
  tone?: 'info' | 'caution'
  /** Visible words beside the icon, three or four at most. */
  label?: string
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
        className={`info-tooltip-trigger${label ? ' info-tooltip-trigger-labeled' : ''}${tone === 'caution' ? ' info-tooltip-trigger-caution' : ''}`}
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
        {tone === 'caution'
          ? <AlertTriangle className="info-tooltip-icon" aria-hidden="true" />
          : (
            <svg className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 7v4M8 5.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
        {label ? <span aria-hidden="true">{label}</span> : null}
      </button>
      {pos !== null && createPortal(
        <span
          ref={bubbleRef}
          aria-hidden="true"
          className="material-tooltip px-3 py-2 text-copy-13 text-secondary"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: placement === 'bottom' ? 'translateX(-50%) translateY(8px)' : 'translateX(-50%) translateY(calc(-100% - 8px))',
            zIndex: 9999,
            pointerEvents: 'none',
            width: placement === 'bottom' ? 'min(14rem, calc(100vw - 1rem))' : '14rem',
          }}
        >
          {text}
        </span>,
        triggerRef.current?.closest('.app-shell-embed') ?? document.body,
      )}
    </span>
  )
}
