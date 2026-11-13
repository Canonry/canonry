import { useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'
import { useTooltipPosition } from '../../hooks/use-tooltip-position.js'

/**
 * Small "?" button that shows `children` in a tooltip on hover or focus.
 */
export function Hint({
  children,
  label = 'More info',
  placement = 'top',
  className,
}: {
  children: ReactNode
  label?: string
  placement?: 'top' | 'bottom'
  className?: string
}) {
  const id = useId()
  const { open, triggerRef, bubbleRef, style, show, hide, hideAfterPointerLeaves } = useTooltipPosition(placement, '16rem')
  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted hover:text-strong focus:text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-500"
        onMouseEnter={show}
        onMouseLeave={hideAfterPointerLeaves}
        onFocus={show}
        onBlur={hide}
        onKeyDown={event => { if (event.key === 'Escape') hide() }}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && createPortal(
        <span
          ref={bubbleRef}
          id={id}
          role="tooltip"
          className="material-tooltip px-3 py-2 text-copy-13 text-secondary whitespace-normal"
          style={style}
          onMouseEnter={show}
          onMouseLeave={hideAfterPointerLeaves}
        >
          {children}
        </span>,
        triggerRef.current?.closest('.app-shell-embed') ?? document.body,
      )}
    </span>
  )
}
