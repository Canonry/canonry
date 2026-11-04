import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '../ui/button.js'

export interface ActionMenuItem {
  key: string
  label: string
  /** One short line under the label saying what the choice does. */
  description?: string
  disabled?: boolean
  onSelect: () => void
}

/**
 * A button that opens a short list of related actions, such as the two ways to
 * resubmit every sitemap. Same behavior as the project "More" menu: a
 * `role="menu"` that closes on outside pointerdown, Escape (focus returns to
 * the button), focus leaving, or a choice; arrow keys move between items.
 */
export function ActionMenu({ label, items, disabled = false, menuLabel }: {
  label: ReactNode
  items: readonly ActionMenuItem[]
  disabled?: boolean
  /** Accessible name of the opened list. */
  menuLabel: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative inline-flex" ref={ref}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          className="project-subnav-menu min-w-[16rem]"
          onKeyDown={(event) => {
            const menuItems = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')]
            const current = menuItems.indexOf(document.activeElement as HTMLElement)
            const next = event.key === 'ArrowDown' ? (current + 1) % menuItems.length
              : event.key === 'ArrowUp' ? (current - 1 + menuItems.length) % menuItems.length
                : null
            if (next === null) return
            event.preventDefault()
            menuItems[next]?.focus()
          }}
          onBlur={(event) => {
            if (!ref.current?.contains(event.relatedTarget as Node | null)) setOpen(false)
          }}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              className="project-subnav-menu-item flex flex-col items-start gap-0.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              <span>{item.label}</span>
              {item.description && <span className="text-label-13 text-secondary">{item.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
