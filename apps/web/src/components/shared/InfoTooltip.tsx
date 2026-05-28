import { useState, useRef, useCallback } from 'react'
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
 */
export function InfoTooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<TooltipPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const show = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({
      top: rect.top,
      left: rect.left + rect.width / 2,
    })
  }, [])

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
        className="info-tooltip-trigger"
        aria-label={text}
        aria-expanded={pos !== null}
        onFocus={show}
        onBlur={hide}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide()
        }}
      >
        <svg className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7v4M8 5.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {pos !== null && createPortal(
        <span
          aria-hidden="true"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: 'translateX(-50%) translateY(calc(-100% - 8px))',
            zIndex: 9999,
            pointerEvents: 'none',
            width: '14rem',
            padding: '0.5rem 0.75rem',
            fontSize: '11px',
            fontWeight: 400,
            textTransform: 'none',
            letterSpacing: 'normal',
            lineHeight: '1rem',
            color: '#d4d4d8',
            backgroundColor: '#18181b',
            border: '1px solid rgba(63, 63, 70, 0.6)',
            borderRadius: '0.5rem',
            boxShadow: '0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)',
          }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}
