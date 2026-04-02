import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface TooltipPos {
  top: number
  left: number
}

export function InfoTooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<TooltipPos | null>(null)
  const iconRef = useRef<SVGSVGElement>(null)

  const show = useCallback(() => {
    if (!iconRef.current) return
    const rect = iconRef.current.getBoundingClientRect()
    setPos({
      top: rect.top,
      left: rect.left + rect.width / 2,
    })
  }, [])

  const hide = useCallback(() => setPos(null), [])

  return (
    <span className="info-tooltip-wrapper" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <svg ref={iconRef} className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 7v4M8 5.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {pos !== null && createPortal(
        <span
          role="tooltip"
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
