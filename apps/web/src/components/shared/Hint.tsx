import { useId, useState, type ReactNode } from 'react'
import { HelpCircle } from 'lucide-react'

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
  const [open, setOpen] = useState(false)
  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted hover:text-strong focus:text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-500"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`absolute z-50 w-64 rounded border border-strong bg-bg-elevated px-3 py-2 text-xs font-normal leading-relaxed text-strong shadow-lg ${
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
          } left-1/2 -translate-x-1/2 whitespace-normal`}
        >
          {children}
        </span>
      )}
    </span>
  )
}
