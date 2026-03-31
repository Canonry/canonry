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
      top: rect.top + window.scrollY,
      left: rect.left + rect.width / 2 + window.scrollX,
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
          className="info-tooltip-bubble info-tooltip-bubble--fixed"
          style={{ top: pos.top, left: pos.left }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}
