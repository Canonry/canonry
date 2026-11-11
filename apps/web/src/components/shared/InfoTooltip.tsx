import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { useTooltipPosition } from '../../hooks/use-tooltip-position.js'

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
  const { open, triggerRef, bubbleRef, style, show, hide, hideAfterPointerLeaves } = useTooltipPosition(placement, '14rem')
  const wasOpenBeforePointer = useRef(false)

  return (
    <span className="info-tooltip-wrapper" onMouseEnter={show} onMouseLeave={hideAfterPointerLeaves}>
      <button
        ref={triggerRef}
        type="button"
        className={`info-tooltip-trigger${label ? ' info-tooltip-trigger-labeled' : ''}${tone === 'caution' ? ' info-tooltip-trigger-caution' : ''}`}
        aria-label={text}
        aria-expanded={open}
        onFocus={show}
        onBlur={hide}
        onPointerDown={() => { wasOpenBeforePointer.current = open && triggerRef.current?.ownerDocument.activeElement === triggerRef.current }}
        onClick={event => {
          // Pointer focus can open the bubble before click fires. Preserve the
          // state from before that focus, so the first touch tap stays open.
          if (event.detail === 0) { if (open) hide(); else show() }
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
      {open && createPortal(
        <span
          ref={bubbleRef}
          aria-hidden="true"
          className="material-tooltip px-3 py-2 text-copy-13 text-secondary"
          style={style}
          onMouseEnter={show}
          onMouseLeave={hideAfterPointerLeaves}
        >
          {text}
        </span>,
        triggerRef.current?.closest('.app-shell-embed') ?? document.body,
      )}
    </span>
  )
}
