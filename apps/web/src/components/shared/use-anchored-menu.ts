import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Every item in a menu, in document order. */
export function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])
}

export interface AnchoredMenuOptions<P> {
  /** Where the menu goes, from its trigger's rect. May change every render. */
  place: (rect: DOMRect) => P
  /** The item focused when the menu opens. Default: the checked item, else the first. */
  initialFocus?: (items: HTMLElement[]) => HTMLElement | undefined
  /** Extra state to reset whenever the menu closes. */
  onClose?: () => void
}

/**
 * A menu rendered into document.body with fixed positioning, anchored to a
 * trigger button. Panels that clip their own overflow (the Aero bar) need
 * this, or an in-panel popover loses its rows.
 *
 * Owns the behavior every such menu shares: placement (and re-placement on
 * resize), focus on open, closing on an outside pointer or Escape (captured,
 * so Escape does not also close the panel behind the menu), focus returning
 * to the trigger, and arrow, Home and End keys between items.
 */
export function useAnchoredMenu<P>(options: AnchoredMenuOptions<P>) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<P | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Read through a ref so a caller can pass fresh closures every render
  // without re-placing the menu or re-binding its listeners.
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    setPosition(null)
    optionsRef.current.onClose?.()
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPosition(optionsRef.current.place(rect))
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  const placed = position !== null
  useEffect(() => {
    if (!open || !placed) return
    const items = menuItems(menuRef.current)
    const chosen = optionsRef.current.initialFocus?.(items)
      ?? items.find(item => item.getAttribute('aria-checked') === 'true')
    ;(chosen ?? items[0])?.focus()
  }, [open, placed])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      close(true)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', place)
    }
  }, [open, close, place])

  /** Move between items with the arrow keys, Home and End. True when it handled the key. */
  const moveFocus = useCallback((event: ReactKeyboardEvent<HTMLElement>): boolean => {
    const target = event.target as HTMLElement
    if (!target.matches('[role^="menuitem"]')) return false
    const items = menuItems(menuRef.current)
    const index = items.indexOf(target)
    const next = event.key === 'ArrowDown' ? items[(index + 1) % items.length]
      : event.key === 'ArrowUp' ? items[(index - 1 + items.length) % items.length]
        : event.key === 'Home' ? items[0]
          : event.key === 'End' ? items[items.length - 1]
            : undefined
    if (!next) return false
    event.preventDefault()
    next.focus()
    return true
  }, [])

  return { open, setOpen, position, triggerRef, menuRef, close, moveFocus }
}
