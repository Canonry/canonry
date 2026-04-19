import { HelpCircle } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'

interface HintProps {
  children: ReactNode
  label?: string
  placement?: 'top' | 'bottom'
  className?: string
}

export function Hint({ children, label = 'More info', placement = 'top', className }: HintProps) {
  const id = useId()
  const [open, setOpen] = useState(false)

  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-zinc-500 hover:text-zinc-200 focus:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
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
          className={`absolute z-50 w-64 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-normal leading-relaxed text-zinc-200 shadow-lg ${
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
          } left-1/2 -translate-x-1/2 whitespace-normal`}
        >
          {children}
        </span>
      )}
    </span>
  )
}
